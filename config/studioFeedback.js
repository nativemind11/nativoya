/**
 * Phase 7 — targeted feedback from the buyer's spreadsheet.
 *
 * No AI: it reads a table, finds the person each row is about, and sends ONLY
 * the named recordings back for rework (same mechanism QA rejection uses:
 * the recording's qa_status becomes 'rejected', the session becomes
 * 'rejected', and a 12-hour rework_deadline starts).
 *
 * Pipeline:   parseSpreadsheet -> extractRows -> resolveRows (preview)
 *                                              -> applyFeedback (same resolve, then write)
 * Apply always re-resolves from the file itself: nothing the browser says
 * about a row is trusted.
 */
const crypto = require("crypto");
const { Readable } = require("stream");
const ExcelJS = require("exceljs");

const REWORK_HOURS = 12;
const MAX_ROWS = 5000;
const MAX_COLS = 60;
const PREVIEW_ROWS = 12;

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

// ------------------------------------------------------------- text helpers
const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const FA_DIGITS = { "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
const toAscii = (s) => String(s).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || FA_DIGITS[d]);
const normKey = (s) => String(s || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** lower-case, no diacritics, أإآ->ا ى->ي ة->ه — so "مرفوضة" and "مرفوضه" are the same word */
const normText = (s) => String(s == null ? "" : s).normalize("NFKC").replace(/[\u064B-\u065F\u0670\u0640]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim().toLowerCase();
// values in a "status" column that usually mean "send it back" (the head leader confirms the list)
const REJECT_RE = /^(rejected?|reject|fail(ed)?|bad|no|not ok|not approved|disapproved|redo|re-?take|re-?record|wrong|invalid|issue|problem|مرفوض|مرفوضه|رفض|غلط|خطا|مشكله|اعاده|يعاد|فشل|لا|✗|✘|❌|x)$/;
const ALL_RE = /^(all|everything|\*|الكل|كله|كل التسجيلات)$/;

// fake_name-gender-age_bracket-age.zip  (fake names may themselves contain "-")
const ZIP_RE = /^(.+)-(male|female)-(child|adult|elderly)-(\d+|na)$/i;

/**
 * @param {string} raw   the cell
 * @param {'zip'|'fake'} type  what the head leader said the column contains
 */
function parseLabel(raw, type) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { error: "empty" };
  s = s.split(/[\\/]/).pop().trim();                       // a path like "folder/x.zip" -> "x.zip"
  const hadZip = /\.zip$/i.test(s);
  const noExt = s.replace(/\.zip$/i, "").trim();
  const m = noExt.match(ZIP_RE);
  if (type === "zip") return m ? { fakeName: m[1].trim() } : { error: "not_zip" };
  if (m && hadZip) return { fakeName: m[1].trim() };       // forgiving: a full zip name in a "fake name" column
  return noExt ? { fakeName: noExt } : { error: "empty" };
}

/** gender / age bracket / age written in a full zip name, or null for a plain alias. */
function parseZipAttrs(raw) {
  const s = String(raw == null ? "" : raw).trim().split(/[\\/]/).pop().replace(/\.zip$/i, "").trim();
  const m = s.match(ZIP_RE);
  return m ? { gender: m[2].toLowerCase(), bracket: m[3].toLowerCase(), age: m[4].toLowerCase() } : null;
}

/**
 * Turns "3", "3, 5, 7", "3-5", "٣ و ٥", "1-3,7", "all" into [1-based numbers].
 */
function parseNumbers(raw, max) {
  let s = toAscii(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return { error: "empty" };
  if (/^(all|everything|\*|الكل|كله|كل التسجيلات)$/.test(s)) {
    return { numbers: Array.from({ length: max }, (_, i) => i + 1) };
  }
  s = s.replace(/(\d+)\.0+(?!\d)/g, "$1");                  // numeric cells that came through as "3.0"
  const set = new Set();
  const bad = [];
  const re = /(\d+)\s*(?:[-–—~]|to|إلى|الى)\s*(\d+)|(\d+)/g;
  let m;
  let found = false;
  while ((m = re.exec(s))) {
    found = true;
    if (m[3] !== undefined) {
      const n = Number(m[3]);
      if (n < 1 || n > max) bad.push(n); else set.add(n);
    } else {
      let a = Number(m[1]), b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > max) { bad.push(`${a}-${b}`); continue; }
      for (let n = a; n <= b; n++) set.add(n);
    }
  }
  if (!found) return { error: "no_numbers" };
  if (bad.length) return { error: "out_of_range", bad, max };
  return { numbers: [...set].sort((x, y) => x - y) };
}

// ------------------------------------------------------------- spreadsheets
function cellText(cell) {
  try {
    const t = cell.text;
    return String(t == null ? "" : t).trim().slice(0, 2000);
  } catch (_) {
    return String(cell.value == null ? "" : cell.value).trim().slice(0, 2000);
  }
}

const colLetter = (i) => { let n = i + 1, s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

/** Reads .xlsx or .csv into plain arrays (never trusts types or formulas). */
async function parseSpreadsheet(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(filename || "")) await wb.csv.read(Readable.from(buffer));
    else await wb.xlsx.load(buffer);
  } catch (_) {
    throw httpError(400, "الملف مش Excel (.xlsx) أو CSV صالح. لو الملف .xls قديم، افتحه واحفظه كـ .xlsx.");
  }
  const sheets = wb.worksheets.map((ws) => {
    const maxCol = Math.min(ws.columnCount || 0, MAX_COLS);
    const maxRow = Math.min(ws.rowCount || 0, MAX_ROWS + 20);
    const grid = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const arr = [];
      for (let c = 1; c <= maxCol; c++) arr.push(cellText(row.getCell(c)));
      grid.push(arr);
    }
    while (grid.length && grid[grid.length - 1].every((x) => !x)) grid.pop();
    return { name: ws.name, grid };
  }).filter((s) => s.grid.length);
  if (!sheets.length) throw httpError(400, "الملف فاضي.");
  return sheets;
}

/** First row with at least 2 filled cells (or the first non-empty one) = the header. */
function guessHeaderRow(grid) {
  const idx = grid.findIndex((r) => r.filter(Boolean).length >= 2);
  if (idx >= 0) return idx + 1;
  const any = grid.findIndex((r) => r.some(Boolean));
  return any >= 0 ? any + 1 : 1;
}

/** Suggests which columns mean what, from the header words (user can override). */
function guessColumns(headers) {
  const find = (re, skip = []) => headers.findIndex((h, i) => !skip.includes(i) && re.test(String(h)));
  let labelCol = find(/zip|file|ملف/i);
  let labelType = labelCol >= 0 ? "zip" : "fake";
  if (labelCol < 0) labelCol = find(/fake|alias|stage|speaker|talent|مستعار|name|اسم/i);
  const skip = labelCol >= 0 ? [labelCol] : [];
  // a header that says "name"/"zip"/"file" is a label, not a recording number ("Recording name" is NOT the number)
  const NAMEISH = /name|اسم|zip|file|ملف/i;
  const numbersCol = find(/recording|sample|clip|utterance|sentence|audio|number|index|num\b|رقم|ارقام|أرقام|تسجيل|جملة|#/i, [...skip, ...headers.map((h, i) => (NAMEISH.test(String(h)) ? i : -1)).filter((i) => i >= 0)]);
  const descCol = find(/issue|problem|comment|note|feedback|reason|description|error|wrong|defect|fault|remark|detail|observation|ملاحظ|ملحوظ|مشكلة|عيب|وصف|سبب|تعليق|فيدباك/i, [...skip, numbersCol]);
  return { labelCol, labelType, numbersCol, descCol };
}

// header that says outright "recording number" (NOT the running "#", which is a row counter)
const EXPLICIT_NUM = /(recording|sample|clip|sentence|utterance|rec)\s*(#|no\b\.?|num\b|number|index|id\b)|رقم\s*(ال)?(تسجيل|جمله|جملة)|^\s*(ارقام|أرقام)\s*(ال)?تسجيل/i;
const STATUS_HEADER = /status|state|result|decision|verdict|outcome|حاله|حالة|نتيجه|نتيجة|قرار/i;

/** distinct values of a column when there are only a few (a status column: "Approved" / "Rejected") */
function columnValues(grid, headerRow, col) {
  const counts = new Map();
  for (const r of grid.slice(headerRow)) {
    const v = String(r[col] == null ? "" : r[col]).trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
    if (counts.size > 12) return null;
  }
  return counts.size ? [...counts.entries()].map(([v, n]) => ({ v: v.slice(0, 60), n })) : null;
}

/**
 * Suggestions beyond the 4 basic guesses:
 *  - numbersMode "row_order": no column carries the real recording number, but each ZIP/name
 *    repeats on several rows (one row per recording) -> recording n = the n-th row of that ZIP.
 *  - statusCol + rejectValues: a status column, and which of its values mean "send back".
 */
function suggestMapping(grid, headerRow, headers, guess) {
  const H = headers.map((h) => String(h == null ? "" : h));
  const explicit = H.findIndex((h, i) => i !== guess.labelCol && EXPLICIT_NUM.test(h));
  let numbersMode = "column";
  let numbersCol = guess.numbersCol;
  if (explicit >= 0) numbersCol = explicit;
  else if (guess.labelCol >= 0) {
    const seen = new Map();
    for (const r of grid.slice(headerRow)) { const k = normKey(r[guess.labelCol]); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
    if ([...seen.values()].some((n) => n >= 2)) numbersMode = "row_order";
  }
  const taken = [guess.labelCol, numbersMode === "column" ? numbersCol : -1, guess.descCol];
  const statusCol = H.findIndex((h, i) => !taken.includes(i) && STATUS_HEADER.test(h));
  let rejectValues = [];
  if (statusCol >= 0) {
    const vals = columnValues(grid, headerRow, statusCol);
    rejectValues = vals ? vals.map((x) => x.v).filter((v) => REJECT_RE.test(normText(v))) : [];
  }
  return { numbersMode, numbersCol, statusCol, rejectValues };
}

function sheetSummary(sheet) {
  const headerRow = guessHeaderRow(sheet.grid);
  const headers = sheet.grid[headerRow - 1] || [];
  const guess = guessColumns(headers);
  return {
    name: sheet.name,
    rowCount: sheet.grid.length,
    colCount: headers.length,
    headerRow,
    columns: headers.map((h, i) => ({ index: i, letter: colLetter(i), header: h, values: columnValues(sheet.grid, headerRow, i) })),
    preview: sheet.grid.slice(0, PREVIEW_ROWS),
    guess,
    suggest: suggestMapping(sheet.grid, headerRow, headers, guess),
  };
}

/**
 * Pulls the mapped columns out of a sheet.
 *   numbersMode "column"    : the recording numbers are written in numbersCol ("3", "3, 5", "2-4", "all").
 *   numbersMode "row_order" : one row per recording, in order — recording n is the n-th row of that
 *                             ZIP / name. (A "Recording name" like hi_fast_01 is NOT used: such names
 *                             restart from 1 inside every group.)
 *   statusCol + rejectValues: only rows whose status is one of rejectValues go back. The others are
 *                             ignored — but still counted for the row order.
 * @returns {{rows: string[][], startRow: number, rowNos: number[], ignored: number, ignoredBy: object,
 *            rowCounts: object, numbersMode: string}}  rows = [label, numbers, description]
 */
function extractRows(sheet, { headerRow, labelCol, numbersCol, descCol, numbersMode = "column", statusCol = -1, rejectValues = [] }) {
  const width = Math.max(0, ...sheet.grid.map((r) => r.length));
  const okCol = (c) => Number.isInteger(c) && c >= 0 && c < width;
  const byOrder = numbersMode === "row_order";
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > sheet.grid.length) throw httpError(400, "رقم صف العناوين غير صحيح");
  if (!okCol(labelCol)) throw httpError(400, "اختار عمود الاسم / ملف الـ ZIP");
  if (!byOrder && !okCol(numbersCol)) throw httpError(400, "اختار عمود أرقام التسجيلات");
  if (descCol != null && descCol >= 0 && !okCol(descCol)) throw httpError(400, "عمود وصف المشكلة غير صحيح");
  const useStatus = Number.isInteger(statusCol) && statusCol >= 0;
  if (useStatus && !okCol(statusCol)) throw httpError(400, "عمود الحالة غير صحيح");
  const wanted = new Set((rejectValues || []).map(normText).filter(Boolean));
  if (useStatus && !wanted.size) throw httpError(400, "حدّد إيه القيم اللي معناها \"مرفوض\" في عمود الحالة.");
  const data = sheet.grid.slice(headerRow);
  if (data.length > MAX_ROWS) throw httpError(413, `الملف فيه أكتر من ${MAX_ROWS} صف. قسّمه لأكتر من ملف.`);

  const counter = new Map(), rowCounts = {};
  const rows = [], rowNos = [], ignoredBy = {};
  let ignored = 0;
  data.forEach((r, i) => {
    const label = r[labelCol] || "";
    let numbers = byOrder ? "" : (r[numbersCol] || "");
    if (byOrder && label) {
      const k = normKey(label);
      const n = (counter.get(k) || 0) + 1;
      counter.set(k, n); numbers = String(n);
      (rowCounts[k] = rowCounts[k] || { label: String(label), count: 0 }).count = n;
    }
    if (useStatus) {
      const raw = String(r[statusCol] == null ? "" : r[statusCol]).trim();
      if (!wanted.has(normText(raw))) {
        if (label || raw) { ignored++; const key = raw || "(فاضي)"; ignoredBy[key] = (ignoredBy[key] || 0) + 1; }
        return;
      }
    }
    rows.push([label, numbers, descCol != null && descCol >= 0 ? (r[descCol] || "") : ""]);
    rowNos.push(headerRow + 1 + i);
  });
  return { startRow: headerRow + 1, rows, rowNos, ignored, ignoredBy, rowCounts, numbersMode: byOrder ? "row_order" : "column" };
}

// ------------------------------------------------------------------ resolve
const MESSAGES = {
  no_label: "مفيش اسم أو ملف في الصف ده.",
  not_zip: "الاسم مش بصيغة ملف ZIP (fake_name-gender-age_bracket-age.zip).",
  no_session: "مفيش متسجّل بالاسم ده في المهمة دي.",
  bad_numbers: "مفيش أرقام تسجيلات واضحة في الصف ده.",
  out_of_range: (r) => `الأرقام (${r.bad.join("، ")}) برا النطاق — المهمة فيها تسجيلات من 1 لـ ${r.max}.`,
  in_progress: "المتسجّل لسه ماسلّمش التاسك ده.",
  submitted: "التاسك ده عند QA دلوقتي. استنى لما يتراجع.",
  collecting: "التاسك ده بيتجمّع للتسليم دلوقتي — جرّب بعد ما يخلص.",
  sample_missing: "التسجيل المطلوب مش موجود عند المتسجّل.",
  changed: "حالة التاسك اتغيّرت أثناء التطبيق، اتخطّى.",
  expired: "المتسجّل ده خلصت مهلة إعادته واتسحب منه الاسم — مينفعش يتعاد.",
  ambiguous: "الاسم ده اتسحب من متسجّل واتعطى لحد تاني، ومش عارفين تقصد أنهي واحد. استخدم اسم ملف الـ ZIP كامل.",
};
const OK_STATUS = new Set(["approved", "rejected"]);

/**
 * Resolves every row against the task's real sessions.
 * @param rows [[label, numbers, description], ...]
 */
async function resolveRows({ db, taskId, labelType, rows, startRow = 2, rowNos = null, meta = null }) {
  const task = (await db.query(`SELECT id, title, rework_hours FROM recording_tasks WHERE id = $1`, [taskId])).rows[0];
  if (!task) throw httpError(404, "المهمة مش موجودة");
  const sampleCount = (await db.query(`SELECT COUNT(*)::int AS c FROM recording_samples WHERE task_id = $1`, [taskId])).rows[0].c;

  const sess = await db.query(
    `SELECT rs.id, rs.fake_name, rs.status, rs.gender, rs.age_bracket, rs.age, rs.leader_id, l.leader_code, l.name AS leader_name,
            tal.name AS real_name, tal.email, b.status AS batch_status,
            ARRAY(SELECT s.order_index FROM recording_session_samples ss
                  JOIN recording_samples s ON s.id = ss.sample_id WHERE ss.session_id = rs.id) AS have
     FROM recording_sessions rs
     JOIN studio_leaders l ON l.id = rs.leader_id
     LEFT JOIN studio_talents tal ON tal.id = rs.talent_id
     LEFT JOIN studio_delivery_batches b ON b.id = rs.delivery_batch_id
     WHERE rs.task_id = $1`, [taskId]);
  // An alias can have several holders once a withdrawn (expired) session's name
  // was given to someone else. Never guess which one the buyer meant.
  const byName = new Map();
  for (const r of sess.rows) {
    const k = normKey(r.fake_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const pickSession = (list, attrs) => {
    if (list.length === 1) return { session: list[0] };
    if (attrs) {
      const hit = list.filter((c) => c.gender === attrs.gender && c.age_bracket === attrs.bracket && String(c.age == null ? "na" : c.age) === attrs.age);
      if (hit.length === 1) return { session: hit[0] };
    }
    return { ambiguous: true };
  };

  const results = rows.map((cells, i) => {
    const [labelRaw, numbersRaw, descRaw] = cells;
    const base = { row: rowNos ? rowNos[i] : startRow + i, label: labelRaw, description: String(descRaw || "").trim(), numbers: [], ok: false };
    if (!labelRaw && !numbersRaw && !base.description) return { ...base, skipped: true };

    if (!labelRaw) return { ...base, code: "no_label", message: MESSAGES.no_label };
    const lab = parseLabel(labelRaw, labelType);
    if (lab.error === "not_zip") return { ...base, code: "not_zip", message: MESSAGES.not_zip };
    if (lab.error) return { ...base, code: "no_label", message: MESSAGES.no_label };
    base.fakeName = lab.fakeName;

    const candidates = byName.get(normKey(lab.fakeName));
    if (!candidates) return { ...base, code: "no_session", message: MESSAGES.no_session };
    const picked = pickSession(candidates, parseZipAttrs(labelRaw));
    if (picked.ambiguous) return { ...base, code: "ambiguous", message: MESSAGES.ambiguous };
    const session = picked.session;

    const num = parseNumbers(numbersRaw, sampleCount);
    if (num.error === "out_of_range") return { ...base, code: "out_of_range", message: MESSAGES.out_of_range(num) };
    if (num.error) return { ...base, code: "bad_numbers", message: MESSAGES.bad_numbers };
    base.numbers = num.numbers;
    base.viaAll = ALL_RE.test(normText(numbersRaw));

    base.session = {
      id: session.id, fakeName: session.fake_name, realName: session.real_name, email: session.email,
      leaderCode: session.leader_code, leaderName: session.leader_name, status: session.status,
    };
    if (!OK_STATUS.has(session.status)) return { ...base, code: session.status, message: MESSAGES[session.status] || MESSAGES.changed };
    if (session.batch_status === "collecting") return { ...base, code: "collecting", message: MESSAGES.collecting };
    const have = new Set(session.have);
    if (num.numbers.some((n) => !have.has(n - 1))) return { ...base, code: "sample_missing", message: MESSAGES.sample_missing };

    return { ...base, ok: true, leaderId: session.leader_id };
  });

  const visible = results.filter((r) => !r.skipped);
  const warnings = buildWarnings(visible, sampleCount, meta);
  return {
    task, sampleCount, results: visible,
    summary: {
      total: visible.length,
      ok: visible.filter((r) => r.ok).length,
      errors: visible.filter((r) => !r.ok).length,
      sessions: new Set(visible.filter((r) => r.ok).map((r) => r.session.id)).size,
      ignored: (meta && meta.ignored) || 0,
      ignoredBy: (meta && meta.ignoredBy) || {},
      numbersMode: (meta && meta.numbersMode) || "column",
    },
    warnings,
  };
}

/**
 * Things that look like a wrong column mapping. They never block the preview, but the head
 * leader has to confirm them before "apply" (the wrong mapping sends people back for rework
 * and starts a 12-hour clock — which is hard to take back).
 */
function buildWarnings(results, sampleCount, meta) {
  const out = [];
  const bySession = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    if (!bySession.has(r.session.id)) bySession.set(r.session.id, { fake: r.session.fakeName, rows: [] });
    bySession.get(r.session.id).rows.push(r);
  }
  for (const { fake, rows } of bySession.values()) {
    // the same number named by several rows that say the very same thing (usually: the column holds
    // a number that restarts inside each group, e.g. hi_fast_01 ... hallo_fast_01)
    const seen = new Map();
    for (const r of rows) for (const n of r.numbers) {
      const key = `${n}|${normText(r.description)}`;
      if (!seen.has(key)) seen.set(key, { n, rows: [] });
      seen.get(key).rows.push(r.row);
    }
    const dups = [...seen.values()].filter((x) => x.rows.length > 1);
    if (dups.length) {
      const nums = [...new Set(dups.map((d) => d.n))].sort((a, b) => a - b);
      out.push({
        code: "duplicate_numbers", fakeName: fake, numbers: nums.slice(0, 12), rows: dups[0].rows.slice(0, 6),
        message: `الأرقام (${nums.slice(0, 8).join(", ")}${nums.length > 8 ? "…" : ""}) اتذكرت أكتر من مرة للمتسجّل "${fake}" (مثلاً في الصفوف ${dups[0].rows.slice(0, 4).join(", ")}). غالبًا العمود ده فيه رقم بيبدأ من 1 جوه كل مجموعة، مش رقم التسجيل — جرّب "ترتيب الصف".`,
      });
    }
    // every single recording of one person sent back (and not through an explicit "all")
    const union = new Set(rows.flatMap((r) => r.numbers));
    if (sampleCount >= 2 && union.size >= sampleCount && rows.some((r) => !r.viaAll)) {
      out.push({
        code: "all_flagged", fakeName: fake, count: union.size,
        message: `كل تسجيلات "${fake}" (${union.size} من ${sampleCount}) هترجع للإعادة. اتأكد إنك مستبعد التسجيلات المقبولة (عمود الحالة).`,
      });
    }
  }
  // row-order numbering is only right if the sheet still lists every recording of each ZIP, in order
  if (meta && meta.numbersMode === "row_order" && meta.rowCounts) {
    for (const { label, count } of Object.values(meta.rowCounts)) {
      if (count !== sampleCount) {
        out.push({
          code: "row_count_mismatch", fakeName: label, count,
          message: `الملف فيه ${count} صف لـ "${label}" بينما المهمة فيها ${sampleCount} تسجيل — ممكن الشيت اتفلتر أو اتغيّر ترتيبه فالأرقام تبقى غلط. لو فيه عمود برقم التسجيل استخدمه بدل "ترتيب الصف".`,
        });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------- apply
const DEFAULT_REASON = "فيدباك من الشركة — التسجيل ده محتاج إعادة.";

async function applyFeedback({ db, taskId, labelType, rows, startRow, rowNos = null, meta = null, confirmWarnings = false, headLeaderId }) {
  try {
    const t = await db.query(`SELECT finalized_at FROM recording_tasks WHERE id = $1`, [taskId]);
    if (t.rows[0] && t.rows[0].finalized_at) throw httpError(409, "المهمة دي اتقفلت نهائيًا واتفضّت ملفاتها — مينفعش يتضاف عليها فيدباك.");
  } catch (e) {
    if (e && e.statusCode === 409) throw e;
    if (!e || e.code !== "42703") throw e;      // 42703 = column missing: migration_studio_finalize.sql not run yet -> no guard
  }
  const resolved = await resolveRows({ db, taskId, labelType, rows, startRow, rowNos, meta });
  if (resolved.warnings.length && !confirmWarnings) {
    throw httpError(409, "فيه تحذيرات في المعاينة. راجعها وأكّد إنك فاهمها قبل ما تطبّق.");
  }
  const hours = Number(resolved.task.rework_hours) || REWORK_HOURS;   // each task sets its own redo time (12 or 24)
  const okRows = resolved.results.filter((r) => r.ok);
  if (!okRows.length) throw httpError(400, "مفيش أي صف صالح للتطبيق.");

  const bySession = new Map();
  for (const r of okRows) {
    if (!bySession.has(r.session.id)) bySession.set(r.session.id, []);
    bySession.get(r.session.id).push(r);
  }

  const uploadId = crypto.randomUUID();
  const client = await db.connect();
  const skipped = resolved.results.filter((r) => !r.ok).map((r) => ({ row: r.row, label: r.label, message: r.message }));
  let samplesMarked = 0, itemsCreated = 0, sessionsDone = 0;
  try {
    await client.query("BEGIN");
    // lock the sessions so QA / the talent / a Collect can't change them under us
    const locked = await client.query(
      `SELECT rs.id, rs.status, rs.delivery_batch_id, rs.fake_name, b.status AS batch_status
       FROM recording_sessions rs LEFT JOIN studio_delivery_batches b ON b.id = rs.delivery_batch_id
       WHERE rs.id = ANY($1::uuid[]) FOR UPDATE OF rs`, [[...bySession.keys()]]);
    const lockedById = new Map(locked.rows.map((r) => [r.id, r]));

    for (const [sessionId, group] of bySession) {
      const cur = lockedById.get(sessionId);
      if (!cur || !OK_STATUS.has(cur.status) || cur.batch_status === "collecting") {
        group.forEach((g) => skipped.push({ row: g.row, label: g.label, message: MESSAGES.changed }));
        continue;
      }
      // number -> description(s) from every row that mentions it
      const reasons = new Map();
      for (const g of group) {
        for (const n of g.numbers) {
          const list = reasons.get(n) || [];
          if (g.description && !list.includes(g.description)) list.push(g.description);
          reasons.set(n, list);
        }
      }
      for (const [n, list] of reasons) {
        const r = await client.query(
          `UPDATE recording_session_samples ss SET qa_status = 'rejected', qa_reason = $3
           FROM recording_samples s
           WHERE ss.sample_id = s.id AND ss.session_id = $1 AND s.order_index = $2`,
          [sessionId, n - 1, list.join(" | ") || DEFAULT_REASON]
        );
        samplesMarked += r.rowCount;
      }

      const summary = [...reasons.entries()]
        .map(([n, list]) => `تسجيل ${n}${list.length ? ": " + list.join(" | ") : ""}`)
        .join(" — ");
      await client.query(
        `UPDATE recording_sessions
         SET status = 'rejected', rejection_reason = $2,
             rework_deadline = now() + ($3::int * interval '1 hour'), rework_enforced = true,
             delivery_batch_id = NULL, updated_at = now()
         WHERE id = $1`,
        [sessionId, `فيدباك من الشركة — ${summary}`.slice(0, 1500), hours]
      );

      for (const g of group) {
        await client.query(
          `INSERT INTO studio_feedback_items
             (task_id, session_id, leader_id, fake_name, recording_numbers, issue_description, status,
              rework_deadline, created_by, upload_id, source_row, previous_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + ($7::int * interval '1 hour'), $8, $9, $10, $11)`,
          [taskId, sessionId, g.leaderId, g.session.fakeName, g.numbers, g.description || null, hours,
           headLeaderId, uploadId, g.row, cur.delivery_batch_id]
        );
        itemsCreated++;
      }
      sessionsDone++;
    }
    if (!sessionsDone) { await client.query("ROLLBACK"); throw httpError(409, "حالة التاسكات اتغيّرت — اعمل معاينة تاني."); }
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
  return { uploadId, sessions: sessionsDone, samples: samplesMarked, items: itemsCreated, skipped, reworkHours: hours };
}

// ------------------------------------------------------------- state changes
/** The talent opened the rework screen. */
async function markAcknowledged(db, sessionId) {
  await db.query(`UPDATE studio_feedback_items SET status = 'acknowledged' WHERE session_id = $1 AND status = 'pending'`, [sessionId]);
}
/** The talent re-submitted the session. */
async function markReworked(db, sessionId) {
  await db.query(
    `UPDATE studio_feedback_items SET status = 'reworked', reworked_at = now()
     WHERE session_id = $1 AND status IN ('pending', 'acknowledged')`, [sessionId]);
}

// ------------------------------------------------------------------ listings
const ITEM_SELECT = `
  SELECT f.id, f.task_id, t.title AS task_title, f.fake_name, f.recording_numbers, f.issue_description,
         f.status, f.rework_deadline, f.created_at, f.reworked_at, f.upload_id, f.source_row,
         (f.status NOT IN ('reworked', 'expired') AND f.rework_deadline IS NOT NULL AND f.rework_deadline < now()) AS overdue,
         l.leader_code, l.name AS leader_name, tal.name AS real_name, tal.email,
         rs.session_token, rs.status AS session_status
  FROM studio_feedback_items f
  JOIN recording_tasks t ON t.id = f.task_id
  JOIN studio_leaders l ON l.id = f.leader_id
  LEFT JOIN recording_sessions rs ON rs.id = f.session_id
  LEFT JOIN studio_talents tal ON tal.id = rs.talent_id`;

async function listForHeadLeader(db, { taskId } = {}) {
  const r = await db.query(
    `${ITEM_SELECT} WHERE ($1::uuid IS NULL OR f.task_id = $1::uuid) ORDER BY f.created_at DESC, f.source_row ASC LIMIT 500`,
    [taskId || null]);
  return r.rows.map(({ session_token, ...rest }) => rest);   // the head leader never needs the talent's private link
}

/** Talent: own items (with the link to the rework screen). Leader: items of their team (with real names). */
async function listMine(db, role, userId) {
  const where = role === "talent" ? "rs.talent_id = $1" : "f.leader_id = $1";
  const r = await db.query(`${ITEM_SELECT} WHERE ${where} ORDER BY f.created_at DESC LIMIT 200`, [userId]);
  return r.rows.map((row) => {
    if (role === "talent") { const { real_name, email, leader_name, ...rest } = row; return rest; }
    const { session_token, ...rest } = row;
    return rest;
  });
}

module.exports = {
  buildWarnings, suggestMapping, columnValues, normText,
  parseLabel, parseZipAttrs, parseNumbers, parseSpreadsheet, sheetSummary, extractRows, guessColumns, guessHeaderRow,
  resolveRows, applyFeedback, markAcknowledged, markReworked, listForHeadLeader, listMine,
  REWORK_HOURS, MAX_ROWS,
};
