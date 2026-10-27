// v10 — an optional password on a task.
//
// The head leader sets it when publishing (or later, from the task's edit page). It is stored ONLY as a bcrypt hash.
// A talent proves he knows it once (POST /talent/tasks/:id/unlock) and gets a short-lived signed "unlock" token that is
//   - bound to that task and that talent (a token cannot be passed to somebody else or used on another task), and
//   - bound to the password that was valid when it was issued (changing the password cancels every old token).
// Starting a session (and listing the names / codes of a protected task) needs that token.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const MIN_LEN = 4;
const MAX_LEN = 64;
const TOKEN_TTL = "12h";
const MAX_FAILS = 5;                 // wrong tries ...
const LOCK_MS = 10 * 60 * 1000;      // ... then this talent waits 10 minutes for that task

const isProtected = (task) => !!(task && task.access_password_hash);

/** Checks a password the head leader typed. Returns the clean password, or throws { statusCode: 400, message }. */
function validatePassword(raw) {
  const pw = String(raw == null ? "" : raw).trim();
  if (pw.length < MIN_LEN) throw httpError(400, `كلمة سر المهمة لازم تكون ${MIN_LEN} حروف أو أرقام على الأقل`);
  if (pw.length > MAX_LEN) throw httpError(400, `كلمة سر المهمة طويلة (الحد الأقصى ${MAX_LEN})`);
  return pw;
}
function httpError(statusCode, message, code) { const e = new Error(message); e.statusCode = statusCode; if (code) e.code = code; return e; }

const hashPassword = (pw) => bcrypt.hash(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compare(String(pw == null ? "" : pw).trim(), hash);

// which password the token belongs to — not the hash itself, just a short fingerprint of it
const fingerprint = (hash) => crypto.createHash("sha256").update(String(hash)).digest("hex").slice(0, 16);

function signUnlock(task, talentId) {
  return jwt.sign({ purpose: "task_unlock", taskId: task.id, talentId, fp: fingerprint(task.access_password_hash) },
    process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}
/** true = this talent may open this task (an open task is always true). */
function checkUnlock(token, task, talentId) {
  if (!isProtected(task)) return true;
  if (!token || typeof token !== "string") return false;
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    return p.purpose === "task_unlock" && p.taskId === task.id && p.talentId === talentId && p.fp === fingerprint(task.access_password_hash);
  } catch (_) { return false; }
}

// Wrong-password limiter (per talent + task). In memory: each server instance counts on its own, which is enough to
// stop a person guessing by hand; bcrypt's cost slows down anything automated.
const fails = new Map();
function lockedFor(talentId, taskId, now = Date.now()) {
  const f = fails.get(`${talentId}:${taskId}`);
  if (!f || !f.until) return 0;
  if (f.until <= now) { fails.delete(`${talentId}:${taskId}`); return 0; }
  return f.until - now;
}
function noteFail(talentId, taskId, now = Date.now()) {
  const k = `${talentId}:${taskId}`;
  const f = fails.get(k) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) { f.until = now + LOCK_MS; f.n = 0; }
  fails.set(k, f);
  if (fails.size > 5000) fails.clear();      // never grow without bound
}
const noteOk = (talentId, taskId) => fails.delete(`${talentId}:${taskId}`);
const resetLimiter = () => fails.clear();

/** A task row as it may leave the server: the hash is removed and replaced by a plain yes / no. */
function expose(row) {
  if (!row || typeof row !== "object") return row;
  const { access_password_hash, ...rest } = row;
  return { ...rest, password_protected: access_password_hash !== undefined ? !!access_password_hash : !!rest.password_protected };
}

module.exports = {
  MIN_LEN, MAX_LEN, isProtected, validatePassword, hashPassword, verifyPassword,
  signUnlock, checkUnlock, lockedFor, noteFail, noteOk, resetLimiter, expose, httpError,
};
