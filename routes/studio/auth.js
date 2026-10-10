const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../../db/pool");
const { requireStudioAuth, TABLES } = require("../../config/studioAuth");
const mailer = require("../../config/mailer");
const { passwordResetEmail, STUDIO_BRAND } = require("../../config/emailTemplates");

const router = express.Router();

function signStudioToken(id, studioRole) {
  return jwt.sign({ id, studioRole }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

// Generates the next leader code (L001, L002, L003...). Locks the table for
// the duration of the transaction so two people signing up at the exact
// same moment can never end up with the same code.
async function nextLeaderCode(client) {
  await client.query("LOCK TABLE studio_leaders IN SHARE ROW EXCLUSIVE MODE");
  const result = await client.query(
    `SELECT leader_code FROM studio_leaders ORDER BY created_at DESC LIMIT 1`
  );
  const last = result.rows[0]?.leader_code;
  const lastNum = last ? parseInt(last.replace(/\D/g, ""), 10) || 0 : 0;
  return `L${String(lastNum + 1).padStart(3, "0")}`;
}

// POST /api/studio/auth/leader/signup — the only self-service signup in the
// studio; head_leader and QA accounts are created directly (see
// db/migration_studio.sql and the head_leader's "add QA reviewer" action).
router.post("/leader/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "الاسم والإيميل وكلمة المرور مطلوبين" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const leaderCode = await nextLeaderCode(client);
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `INSERT INTO studio_leaders (name, email, password_hash, leader_code)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, leader_code, created_at`,
      [name, email, passwordHash, leaderCode]
    );
    await client.query("COMMIT");

    const leader = result.rows[0];
    const token = signStudioToken(leader.id, "leader");
    res.status(201).json({ token, studioRole: "leader", user: leader });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") { // unique_violation on email
      return res.status(409).json({ error: "فيه حساب بالإيميل ده في الاستوديو بالفعل" });
    }
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء الحساب، حاول تاني" });
  } finally {
    client.release();
  }
});

// POST /api/studio/auth/talent/signup — anyone recording for a task needs
// one of these first. No leader_code here (that's chosen per-session on the
// task they're recording for, same account can work with several leaders).
router.post("/talent/signup", async (req, res) => {
  const { name, email, password, whatsapp } = req.body;
  if (!name || !email || !password || !whatsapp) {
    return res.status(400).json({ error: "الاسم والإيميل وكلمة المرور ورقم الواتس مطلوبين" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO studio_talents (name, email, password_hash, whatsapp)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, whatsapp, created_at`,
      [name, email, passwordHash, whatsapp]
    );
    const talent = result.rows[0];
    const token = signStudioToken(talent.id, "talent");
    res.status(201).json({ token, studioRole: "talent", user: talent });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "فيه حساب بالإيميل ده في الاستوديو بالفعل" });
    }
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء الحساب، حاول تاني" });
  }
});

// POST /api/studio/auth/login  body: { email, password, studioRole }
// studioRole must be one of 'head_leader' | 'leader' | 'qa' — the login page
// has 3 tabs, one per account type, so the client always knows which to send.
router.post("/login", async (req, res) => {
  const { email, password, studioRole } = req.body;
  const table = TABLES[studioRole];
  if (!table) return res.status(400).json({ error: "نوع الحساب غير معروف" });
  if (!email || !password) return res.status(400).json({ error: "الإيميل وكلمة المرور مطلوبين" });

  try {
    const result = await pool.query(`SELECT * FROM ${table} WHERE email = $1`, [email]);
    const account = result.rows[0];
    if (!account || !(await bcrypt.compare(password, account.password_hash))) {
      return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط" });
    }
    delete account.password_hash;
    const token = signStudioToken(account.id, studioRole);
    res.json({ token, studioRole, user: account });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تسجيل الدخول، حاول تاني" });
  }
});

// POST /api/studio/auth/forgot-password  body: { email, studioRole }
// Works the same for all 4 account types — studioRole picks which table.
// Always the same generic response so this can't be used to probe which
// emails have accounts.
router.post("/forgot-password", async (req, res) => {
  const { email, studioRole } = req.body;
  const table = TABLES[studioRole];
  const genericOk = { message: "لو الإيميل ده مسجل عندنا، هيوصله رابط استرجاع كلمة المرور خلال دقايق." };
  if (!table) return res.status(400).json({ error: "نوع الحساب غير معروف" });
  if (!email) return res.status(400).json({ error: "الإيميل مطلوب" });

  try {
    const result = await pool.query(`SELECT id, name, email FROM ${table} WHERE email = $1`, [email]);
    if (!result.rows.length) return res.json(genericOk);
    const account = result.rows[0];

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      `UPDATE ${table} SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3`,
      [tokenHash, expiresAt, account.id]
    );

    // Studio lives on its own domain now (root path, no /studio/ prefix).
    const studioUrl = (process.env.STUDIO_URL || "https://gigversestudio.click").replace(/\/+$/, "");
    const resetUrl = `${studioUrl}/reset-password.html?token=${rawToken}&role=${studioRole}`;

    await mailer.sendMail({
      to: account.email,
      subject: "استرجاع كلمة المرور — Studio",
      fromName: "Studio",
      html: passwordResetEmail({ firstName: account.name, resetUrl, brand: STUDIO_BRAND }),
    });

    res.json(genericOk);
  } catch (err) {
    console.error(err);
    if (err.code === "EMAIL_NOT_CONFIGURED") {
      return res.status(503).json({ error: "خدمة إرسال الإيميلات لسه مش متصلة بالسيرفر." });
    }
    res.status(500).json({ error: "تعذر إرسال رابط الاسترجاع، حاول تاني بعد شوية." });
  }
});

// POST /api/studio/auth/reset-password  body: { token, newPassword, studioRole }
router.post("/reset-password", async (req, res) => {
  const { token, newPassword, studioRole } = req.body;
  const table = TABLES[studioRole];
  if (!table) return res.status(400).json({ error: "نوع الحساب غير معروف" });
  if (!token || !newPassword) return res.status(400).json({ error: "البيانات ناقصة" });
  if (newPassword.length < 6) return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await pool.query(
      `SELECT id FROM ${table} WHERE reset_token_hash = $1 AND reset_token_expires_at > now()`,
      [tokenHash]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: "رابط الاسترجاع ده غير صحيح أو منتهي الصلاحية. اطلب رابط جديد." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE ${table} SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2`,
      [passwordHash, result.rows[0].id]
    );

    res.json({ message: "تم تغيير كلمة المرور بنجاح. تقدر تدخل بيها دلوقتي." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تغيير كلمة المرور، حاول تاني بعد شوية." });
  }
});

// GET /api/studio/auth/me — re-fetches the live account row, same pattern
// as the main site's /api/auth/me (never trust stale localStorage data).
router.get("/me", requireStudioAuth, async (req, res) => {
  res.json({ user: req.studioUser, studioRole: req.studioRole });
});

module.exports = router;
