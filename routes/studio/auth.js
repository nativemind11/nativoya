const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../../db/pool");
const { requireStudioAuth, TABLES } = require("../../config/studioAuth");
const mailer = require("../../config/mailer");
const Profile = require("../../config/studioProfile");
const { passwordResetEmail, STUDIO_BRAND } = require("../../config/emailTemplates");

const router = express.Router();

function signStudioToken(id, studioRole) {
  return jwt.sign({ id, studioRole }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

// POST /api/studio/auth/talent/signup — anyone recording for a task needs one of these first.
// v8: the account carries the talent's REAL data, asked once here and never again on a task:
//   name (English letters — it can end up in file names), gender (male | female), age (a number).
// The age bracket (child / adult / elderly) is worked out from the age on the server.
// No leader_code here (that's chosen per-session on the task they're recording for).
router.post("/talent/signup", async (req, res) => {
  const { email, password, gender } = req.body;
  if (!req.body.name || !email || !password) {
    return res.status(400).json({ error: "الاسم والإيميل وكلمة المرور مطلوبين" });
  }
  const name = Profile.cleanEnglishName(req.body.name);
  if (!name) return res.status(400).json({ error: "الاسم لازم يتكتب بالإنجليزي (حروف ومسافات بس، من غير أرقام ولا رموز)" });
  if (!["male", "female"].includes(gender)) return res.status(400).json({ error: "اختار النوع: ذكر أو أنثى" });
  const age = Profile.parseAge(req.body.age);
  if (age == null) return res.status(400).json({ error: `اكتب السن بالأرقام (من ${Profile.MIN_AGE} لـ ${Profile.MAX_AGE})` });
  if (password.length < 6) {
    return res.status(400).json({ error: "كلمة المرور لازم تكون 6 أحرف على الأقل" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO studio_talents (name, email, password_hash, gender, age, age_bracket)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, gender, age, age_bracket, created_at`,
      [name, String(email).trim(), passwordHash, gender, age, Profile.bracketFor(age)]
    );
    const talent = result.rows[0];
    const token = signStudioToken(talent.id, "talent");
    res.status(201).json({ token, studioRole: "talent", user: talent });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "فيه حساب بالإيميل ده في الاستوديو بالفعل" });
    }
    // 42703 = the v8 columns are not there yet: say so clearly instead of a vague failure
    if (err.code === "42703") {
      console.error("[signup] migration_studio_v8.sql was not run:", err.message);
      return res.status(503).json({ error: "السيرفر لسه بيتحدّث. حاول بعد شوية." });
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
    if (account.is_active === false) return res.status(403).json({ error: "الحساب ده متوقف. كلّم الهيد ليدر." });
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
