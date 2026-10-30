/**
 * The talent's real data (v8): gender, age and the age bracket computed from the age, all written in English
 * (male / female, digits 0-9, child / adult / elderly) because they end up inside file names.
 *
 *   child   : 5 to 13
 *   adult   : 14 to 59
 *   elderly : 60 to 80
 * Change the four numbers below if the company uses other limits. The sign-up page in the frontend repeats them
 * (talent-login.html: function parseAge and the age-group preview).
 */
const ADULT_FROM = 14;
const ELDERLY_FROM = 60;
const MIN_AGE = 5;
const MAX_AGE = 80;

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** "٢٧" / "27" / " 27 " -> "27" (Arabic-Indic and Persian digits become 0-9). */
function toAsciiDigits(v) {
  return String(v == null ? "" : v).replace(/[٠-٩۰-۹]/g, (c) => {
    const a = AR_DIGITS.indexOf(c);
    return String(a >= 0 ? a : FA_DIGITS.indexOf(c));
  }).trim();
}

function bracketFor(age) {
  if (age >= ELDERLY_FROM) return "elderly";
  if (age >= ADULT_FROM) return "adult";
  return "child";
}

/** Whole number between MIN_AGE and MAX_AGE, or null. */
function parseAge(v) {
  const s = toAsciiDigits(v);
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_AGE && n <= MAX_AGE ? n : null;
}

/**
 * The name goes into file names, so it is English letters only (spaces and hyphens inside are fine).
 * Returns the cleaned name ("Ahmed  Ali " -> "Ahmed Ali") or null when it is not acceptable.
 */
function cleanEnglishName(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return /^[A-Za-z](?:[A-Za-z]| (?=[A-Za-z])|-(?=[A-Za-z])){1,59}$/.test(s) ? s : null;
}

/** { gender, age, ageBracket } from an account row, or null when the account has no real data yet (old accounts). */
function profileOf(talent) {
  if (!talent || !["male", "female"].includes(talent.gender)) return null;
  const age = Number(talent.age);
  if (!Number.isInteger(age) || age < 1) return null;
  const ageBracket = ["child", "adult", "elderly"].includes(talent.age_bracket) ? talent.age_bracket : bracketFor(age);
  return { gender: talent.gender, age, ageBracket };
}

module.exports = { ADULT_FROM, ELDERLY_FROM, MIN_AGE, MAX_AGE, toAsciiDigits, bracketFor, parseAge, cleanEnglishName, profileOf };
