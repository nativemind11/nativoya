/**
 * Feedback matching by NAME and by SENTENCE (added on top of the older "recording number" modes).
 *
 * The buyer's sheet often names things differently from us:
 *   - the person:   "Marie Louise_8_f_children.zip"  (our fake name is just "Marie Louise")
 *   - the sentence: file "BH252_UK_F088_fast_011.wav" + text "hi kima (hi: Tone 4)"
 *                   (in our script that is line "0011<TAB>hi kima (hi: Tone 4)<TAB>Fast")
 * Nothing here guesses with AI: a name must start with one of the task's real fake names, and a sentence must
 * agree with the person's own script (file number, speed word and text are all checked against each other).
 * Anything that does not agree is reported as a problem row — never silently sent back.
 */

const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const FA_DIGITS = { "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
const toAscii = (s) => String(s).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || FA_DIGITS[d]);

/** lower-case, no diacritics, أإآ->ا ى->ي ة->ه, single spaces */
const normText = (s) => String(s == null ? "" : s).normalize("NFKC").replace(/[ً-ٰٟـ]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim().toLowerCase();

/** "Marie_Louise-8" and "marie louise 8" are the same thing: separators become spaces. */
const normName = (s) => normText(toAscii(s)).replace(/[_\-.,;:()\[\]{}"'`]+/g, " ").replace(/\s+/g, " ").trim();

/** a sentence from a script / a sheet: case, spacing and edge punctuation do not matter */
const normSentence = (s) => normText(s).replace(/^[\s"'“”‘’.,;:!?،؛؟]+|[\s"'“”‘’.,;:!?،؛؟]+$/g, "").trim();

// ------------------------------------------------------------------ names
const GENDER_WORDS = { f: "female", female: "female", girl: "female", woman: "female", women: "female", m: "male", male: "male", boy: "male", man: "male", men: "male" };
const BRACKET_WORDS = { child: "child", children: "child", kid: "child", kids: "child", adult: "adult", adults: "adult", elderly: "elderly", elder: "elderly", old: "elderly", senior: "elderly" };

/** reads the extras a buyer adds after the name: gender / age bracket / age (any order, any spelling) */
function parseNameExtras(tokens) {
  const out = {};
  for (const t of tokens) {
    if (GENDER_WORDS[t] && !out.gender) out.gender = GENDER_WORDS[t];
    else if (BRACKET_WORDS[t] && !out.bracket) out.bracket = BRACKET_WORDS[t];
    else if (/^\d{1,3}$/.test(t) && out.age === undefined) out.age = t;
  }
  return out;
}
const isExtraToken = (t) => !!(GENDER_WORDS[t] || BRACKET_WORDS[t] || /^\d{1,3}$/.test(t) || t === "zip");

const stripZip = (raw) => String(raw == null ? "" : raw).trim().split(/[\\/]/).pop().replace(/\.zip$/i, "");
const nameTokens = (raw) => normName(stripZip(raw)).split(" ").filter(Boolean);
/** "mary 11 f child" -> name part ["mary"] + extras {age:"11", gender:"female", bracket:"child"} (name part = everything before the first gender/age/group word) */
function splitName(tokens) {
  let cut = tokens.findIndex(isExtraToken);
  if (cut <= 0) cut = tokens.length;
  return { name: tokens.slice(0, cut), extras: parseNameExtras(tokens.slice(cut)) };
}

/**
 * Index over a task's sessions so a sheet name can be resolved to a person.
 * `find(raw)` -> { list, extras, nameGuess, how }   (list is empty when nothing matches)
 *
 * Order of trust (the first step that finds someone wins):
 *   1. the whole fake name is the label, or its beginning ("Marie Louise_8_f_children" -> "Marie Louise";
 *      the longest fake name wins, so it is not mixed up with "Marie")        how = exact | prefix
 *   2. the FIRST name alone, when only one person in the task has it ("mary" -> "mary-11-f-child.zip")   how = first
 *   3. several people share the first name -> the SECOND name decides                                    how = second
 *   4. still several -> the caller narrows them by gender / age / group (pickByExtras)                   how = extras
 * ".zip" and separators never matter, on the sheet side or on the fake-name side.
 */
function buildNameIndex(sessionRows) {
  const byName = new Map(), byFirst = new Map();
  for (const r of sessionRows) {
    const tokens = nameTokens(r.fake_name);
    if (!tokens.length) continue;
    const part = splitName(tokens).name;
    const e = { r, part };
    const k = tokens.join(" ");
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
    if (!byFirst.has(part[0])) byFirst.set(part[0], []);
    byFirst.get(part[0]).push(e);
  }
  const all = [...byFirst.values()].flat();

  function find(raw, opts) {
    const tokens = nameTokens(raw);
    if (!tokens.length) return { list: [], extras: {}, nameGuess: "", how: null };
    const label = splitName(tokens);
    const nameGuess = label.name.join(" ");
    for (let n = tokens.length; n >= 1; n--) {                                   // 1) whole fake name
      const hit = byName.get(tokens.slice(0, n).join(" "));
      if (hit) return { list: hit, extras: parseNameExtras(tokens.slice(n)), nameGuess, how: n === tokens.length ? "exact" : "prefix" };
    }
    if (opts && opts.strict) return { list: [], extras: label.extras, nameGuess, how: null };
    let c = byFirst.get(label.name[0]) || [];                                    // 2) first name
    if (!c.length) return { list: [], extras: label.extras, nameGuess, how: null };
    let how = "first";
    if (c.length > 1 && label.name[1]) {                                         // 3) second name
      const c2 = c.filter((e) => e.part[1] === label.name[1]);
      if (c2.length) { c = c2; how = "second"; }
    }
    return { list: c.map((e) => e.r), extras: label.extras, nameGuess, how: c.length > 1 ? "extras" : how };
  }

  /** the closest participants for a label (same first name first, then typos / missing letters) — for the dropdown's "closest" group */
  function suggest(raw, limit = 5, keep = () => true) {
    const label = splitName(nameTokens(raw));
    const g = label.name.join(" ");
    if (!g) return [];
    const scored = [];
    for (const e of all) {
      if (!keep(e.r)) continue;
      const k = e.part.join(" ");
      const d = distance(g, k);
      const sameFirst = e.part[0] === label.name[0];
      const sub = k.includes(g) || g.includes(k);
      const lim = Math.max(2, Math.round(Math.max(g.length, k.length) * 0.4));
      if (sameFirst || sub || d <= lim) scored.push({ r: e.r, score: (sameFirst ? 0 : 10) + (sub ? 0 : d) });
    }
    scored.sort((x, y) => x.score - y.score || String(x.r.fake_name).localeCompare(String(y.r.fake_name)));
    return scored.slice(0, limit).map((x) => x.r);
  }
  return { find, suggest, size: all.length };
}

/** what the sheet label says about the person versus what the person registered: [] when nothing disagrees */
function nameConflicts(extras, s) {
  const out = [];
  if (extras.gender && s.gender && extras.gender !== s.gender) out.push("gender");
  if (extras.bracket && s.age_bracket && extras.bracket !== s.age_bracket) out.push("bracket");
  if (extras.age !== undefined && s.age != null && String(extras.age) !== String(s.age)) out.push("age");
  return out;
}

function distance(a, b) {          // Levenshtein, small strings only
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 6) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** narrows several holders of one name using the gender / bracket / age the sheet label carries; null = still ambiguous */
function pickByExtras(list, extras) {
  if (list.length === 1) return list[0];
  let cur = list;
  const steps = [
    (s) => !extras.gender || s.gender === extras.gender,
    (s) => !extras.bracket || s.age_bracket === extras.bracket,
    (s) => extras.age === undefined || String(s.age == null ? "na" : s.age) === String(extras.age),
  ];
  for (const f of steps) {
    const next = cur.filter(f);
    if (next.length === 1) return next[0];
    if (next.length) cur = next;
  }
  return null;
}

// ---------------------------------------------------------------- scripts
const SPEEDS = new Set(["slow", "normal", "fast"]);

/**
 * One script line as stored in recording_samples.sentence_name. The buyer's scripts look like
 * "0011<TAB>hi kima (hi: Tone 4)<TAB>Fast" (id, text, speed); a plain "hi kima" line is just text.
 */
function parseScriptLine(name) {
  const s = String(name == null ? "" : name).trim();
  const parts = s.split("\t").map((x) => x.trim());
  if (parts.length >= 2 && /^\d{1,6}$/.test(parts[0])) {
    const last = parts[parts.length - 1].toLowerCase();
    const hasSpeed = parts.length >= 3 && /^[a-z]{2,12}$/.test(last);
    return { id: Number(parts[0]), text: parts.slice(1, hasSpeed ? -1 : undefined).join(" "), speed: hasSpeed ? last : null };
  }
  const m = s.match(/^(\d{3,6})\s+(.+?)\s+(fast|normal|slow)$/i);       // tabs turned into spaces by some editor
  if (m) return { id: Number(m[1]), text: m[2], speed: m[3].toLowerCase() };
  return { id: null, text: s, speed: null };
}

/** rows: [{order_index, sentence_name}] of ONE script -> lookup tables */
function buildScriptIndex(rows) {
  const sorted = [...rows].sort((a, b) => a.order_index - b.order_index);
  const lines = sorted.map((r) => {
    const p = parseScriptLine(r.sentence_name);
    return { idx: r.order_index, id: p.id, text: p.text, norm: normSentence(p.text), speed: p.speed };
  });
  const ids = lines.map((l) => l.id);
  const byId = lines.length && ids.every((x) => x != null) && new Set(ids).size === ids.length ? new Map(lines.map((l) => [l.id, l])) : null;
  const byPos = new Map(lines.map((l, i) => [i + 1, l]));        // "file number n" = n-th line, when the script has no ids
  const byText = new Map();
  for (const l of lines) { if (!byText.has(l.norm)) byText.set(l.norm, []); byText.get(l.norm).push(l); }
  return { lines, byId, byPos, byText, speeds: new Set(lines.map((l) => l.speed).filter(Boolean)) };
}

/** "BH252_UK_F088_fast_011.wav" -> { n: 11, speed: "fast" }  (the speed word counts only if the script uses speed words) */
function parseFileName(raw, script) {
  const base = String(raw == null ? "" : raw).trim().split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const m = base.match(/(\d+)\s*$/);
  if (!m) return { n: null, speed: null };
  const head = base.slice(0, m.index).replace(/[_\-\s]+$/, "");
  const word = head.split(/[_\-\s]+/).pop().toLowerCase();
  const speed = word && script && script.speeds.has(word) ? word : (SPEEDS.has(word) ? word : null);
  return { n: Number(m[1]), speed };
}

const hasFileShape = (v) => /\.(wav|mp3|flac|ogg|m4a|aac|webm)\s*$/i.test(String(v == null ? "" : v)) || /[_\-]\d{2,}\.\w{2,4}\s*$/.test(String(v == null ? "" : v));

/**
 * Finds the one script line a sheet row is about.
 *   file number + text : the number must point at a line with the same text (and speed) -> "file+text" (certain)
 *   file number only   : "file" (speed word checked when both sides have one)
 *   text only          : must be unique in that person's script -> "text"; a repeated sentence is NOT guessed
 *   number disagrees with the text: the text wins when it is unique -> "text" + note "file_mismatch" (a warning)
 * @returns {{line, how, note?}|{error: string}}
 */
function matchSentence(script, fileRaw, textRaw) {
  const f = fileRaw ? parseFileName(fileRaw, script) : { n: null, speed: null };
  const tn = textRaw ? normSentence(textRaw) : "";
  if (!tn && f.n == null) return { error: "no_sentence" };

  const byFile = f.n != null ? (script.byId ? script.byId.get(f.n) : script.byPos.get(f.n)) || null : null;
  const speedOk = (l) => !(f.speed && l.speed && f.speed !== l.speed);
  if (byFile && speedOk(byFile) && (!tn || byFile.norm === tn)) return { line: byFile, how: tn ? "file+text" : "file" };

  if (tn) {
    let c = script.byText.get(tn) || [];
    if (f.speed) { const s = c.filter((l) => !l.speed || l.speed === f.speed); if (s.length) c = s; }
    if (c.length === 1) return { line: c[0], how: "text", note: byFile ? "file_mismatch" : null };
    if (c.length > 1) return { error: "sentence_ambiguous" };
    return { error: "sentence_not_found" };
  }
  return { error: byFile ? "sentence_mismatch" : "file_not_found" };
}

/** the description cell often repeats the sentence before a "|" ("hi kima|baddata+wrong tune") — keep just the reason */
function cleanReason(desc, textRaw, line) {
  const s = String(desc == null ? "" : desc).trim();
  const i = s.indexOf("|");
  if (i <= 0) return s;
  const head = normSentence(s.slice(0, i));
  if (head && (head === normSentence(textRaw) || (line && head === line.norm))) return s.slice(i + 1).trim();
  return s;
}

// ------------------------------------------------------ column detection
/**
 * Looks at WHAT is in each column, not at its title (titles change between buyers and between batches):
 *   file column    : most cells look like an audio file name
 *   sentence column: most cells equal a sentence of the task's scripts
 *   name column    : most cells start with one of the task's fake names
 * Titles only break ties (e.g. "original text" over "reference text").
 * @returns {null | {labelCol, labelType, numbersMode, fileCol, textCol, descCol, scores}}
 */
function detectColumns({ grid, headerRow, headers, nameIndex, sentenceSet }) {
  const data = grid.slice(headerRow, headerRow + 400);
  const width = Math.max(headers.length, ...data.map((r) => r.length), 0);
  const H = (i) => String((headers && headers[i]) || "");
  const stats = [];
  for (let c = 0; c < width; c++) {
    const cells = data.map((r) => String(r[c] == null ? "" : r[c]).trim()).filter(Boolean);
    if (cells.length < 2) { stats.push({ c, n: 0 }); continue; }
    let file = 0, text = 0, name = 0, bar = 0;
    const distinct = new Set(cells.map((v) => normName(v))).size;
    for (const v of cells) {
      if (hasFileShape(v)) file++;
      if (sentenceSet && sentenceSet.has(normSentence(v))) text++;
      if (nameIndex && nameIndex.find(v, { strict: true }).list.length) name++;
      if (v.includes("|")) bar++;
    }
    const n = cells.length;
    stats.push({ c, n, file: file / n, text: text / n, name: name / n, bar: bar / n, rep: 1 - distinct / n });
  }
  const pref = (c, re) => (re.test(H(c)) ? 1 : 0);
  const best = (key, min, bonus) => {
    const cand = stats.filter((s) => s.n && s[key] >= min).sort((a, b) => (b[key] - a[key]) || (bonus(b.c) - bonus(a.c)) || (a.c - b.c));
    // a tie on score is settled by the header; otherwise the higher score wins
    return cand.length ? cand[0] : null;
  };
  let name = best("name", 0.3, (c) => pref(c, /submission|speaker|talent|name|اسم/i) - pref(c, /file|ملف/i));
  const file = best("file", 0.5, (c) => pref(c, /file|ملف|audio|wav|recording/i));
  const textBonus = (c) => (/original|source|script|اصل|أصل/i.test(H(c)) ? 3 : /sentence|text|جمل|نص/i.test(H(c)) ? 2 : /reference/i.test(H(c)) ? 1 : /annotat/i.test(H(c)) ? -1 : 0);
  const text = best("text", 0.5, textBonus);
  if (!file && !text) return null;
  // The people column does not have to match anybody in the task (a test task may hold just a few talents, or the buyer
  // spells names its own way — that is exactly what the name-matching panel is for). Then it is recognised by its look:
  // not a file, not a sentence, and the same value repeated on many rows (one row per recording) — or by its title.
  let nameBy = "task";
  if (!name) {
    const taken = new Set([file && file.c, text && text.c]);
    const cand = stats.filter((x) => x.n && !taken.has(x.c) && x.bar < 0.5 && x.file < 0.5 && x.text < 0.5)
      .map((x) => ({ x, hdr: /submission|speaker|talent|participant|name|اسم|متسجل/i.test(H(x.c)) && !/file|ملف/i.test(H(x.c)) ? 1 : 0 }))
      .filter((y) => y.hdr || y.x.rep >= 0.5)
      .sort((a, b) => b.hdr - a.hdr || b.x.rep - a.x.rep || a.x.c - b.x.c);
    if (!cand.length) return null;
    name = cand[0].x; nameBy = "shape";
  }
  const used = new Set([name.c, file && file.c, text && text.c]);
  const reason = stats.filter((s) => s.n && !used.has(s.c) && s.bar >= 0.5).sort((a, b) => b.bar - a.bar)[0]
    || stats.find((s) => s.n && !used.has(s.c) && /issue|problem|comment|note|feedback|reason|remark|ملاحظ|مشكلة|سبب|فيدباك/i.test(H(s.c))) || null;
  // the column that carries the reason may be the annotated sentence itself ("text|baddata+...") -> it is not a "sentence" column
  return {
    labelCol: name.c, labelType: "smart", numbersMode: "match",
    fileCol: file ? file.c : -1, textCol: text ? text.c : -1, descCol: reason ? reason.c : -1,
    nameBy, scores: { name: name.name || 0, file: file ? file.file : 0, text: text ? text.text : 0 },
  };
}

module.exports = {
  normText, normName, normSentence, parseNameExtras, buildNameIndex, pickByExtras, nameConflicts,
  parseScriptLine, buildScriptIndex, parseFileName, matchSentence, cleanReason, detectColumns, hasFileShape,
};
