/**
 * A forgiving .xlsx reader — the fallback for files ExcelJS refuses.
 *
 * Why it exists: some tools (the Open XML SDK, online exporters, several QA / buyer tools) write a perfectly valid
 * workbook but put a namespace prefix on every tag ("<x:worksheet>", "<x:c>"), use absolute paths in the
 * relationships and leave out the docProps files. Excel and Python open these without a problem; ExcelJS does not,
 * and the head leader only saw "the file is not a valid Excel file".
 *
 * This reader only extracts TEXT (sheet names + a grid of cell strings) — exactly what the feedback page needs —
 * and never looks at styles, formulas or macros. It is used ONLY when ExcelJS fails, so every file that opened
 * before opens the same way now.
 */

const MAX_XML_BYTES = 60 * 1024 * 1024;     // a sheet bigger than this is refused (zip-bomb guard)

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** attributes of one tag: { name: value } (prefixes kept: "r:id") */
function attrsOf(str) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = decodeEntities(m[2]);
  return out;
}
const localName = (k) => k.split(":").pop();

/** "A" -> 0, "B" -> 1, "AA" -> 26 */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** relationship Target (relative to xl/ or absolute) -> zip entry name */
function resolveTarget(target) {
  let t = String(target || "").replace(/\\/g, "/");
  if (t.startsWith("/")) t = t.slice(1);
  else t = "xl/" + t;
  const parts = [];
  for (const p of t.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
  return parts.join("/");
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = (m[1] || "").replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, "");   // phonetic hints are not text
    let text = "";
    const tre = /<(?:[\w.-]+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t>)/g;
    let t;
    while ((t = tre.exec(body))) text += decodeEntities(t[1] || "");
    out.push(text);
  }
  return out;
}

/** one worksheet's XML -> array of rows (arrays of strings) */
function parseSheet(xml, shared, maxCol, maxRow) {
  const grid = [];
  const rowRe = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g;
  let rm, seqRow = 0;
  while ((rm = rowRe.exec(xml))) {
    seqRow++;
    const rAttr = attrsOf(rm[1]);
    const rowNo = Number(rAttr.r) || seqRow;
    seqRow = rowNo;
    if (rowNo > maxRow) break;
    const cells = [];
    const cellRe = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;
    let cm, seqCol = -1;
    while ((cm = cellRe.exec(rm[2] || ""))) {
      const a = attrsOf(cm[1]);
      let col = seqCol + 1;
      const ref = /^([A-Za-z]+)\d*$/.exec(a.r || "");
      if (ref) col = colIndex(ref[1]);
      seqCol = col;
      if (col >= maxCol) continue;
      const inner = cm[2] || "";
      let text = "";
      if (a.t === "inlineStr") {
        const tre = /<(?:[\w.-]+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t>)/g;
        let t;
        while ((t = tre.exec(inner))) text += decodeEntities(t[1] || "");
      } else {
        const v = /<(?:[\w.-]+:)?v\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?v>)/.exec(inner);
        const raw = v ? decodeEntities(v[1] || "") : "";
        text = a.t === "s" ? (shared[Number(raw)] == null ? "" : shared[Number(raw)]) : raw;
        if (a.t === "b") text = raw === "1" ? "TRUE" : "FALSE";
      }
      cells[col] = String(text).trim().slice(0, 2000);
    }
    while (grid.length < rowNo - 1) grid.push([]);
    grid[rowNo - 1] = cells;
  }
  const width = Math.min(maxCol, grid.reduce((n, r) => Math.max(n, r.length), 0));
  const out = grid.map((r) => { const a = []; for (let c = 0; c < width; c++) a.push(r[c] == null ? "" : r[c]); return a; });
  while (out.length && out[out.length - 1].every((x) => !x)) out.pop();
  return out;
}

/**
 * @param readText async (entryName) => string | null   (the XML text of one part of the zip)
 * @returns [{ name, grid }]  — same shape parseSpreadsheet() builds from ExcelJS
 */
async function xlsxToSheets(readText, { maxCol = 60, maxRow = 6020 } = {}) {
  const wbXml = await readText("xl/workbook.xml");
  if (!wbXml) throw new Error("no workbook.xml");
  const relsXml = (await readText("xl/_rels/workbook.xml.rels")) || "";
  const rels = new Map();
  for (const m of relsXml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    if (a.Id) rels.set(a.Id, a.Target);
  }
  const shared = parseSharedStrings(await readText("xl/sharedStrings.xml"));

  const sheets = [];
  const sheetRe = /<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/g;
  let n = 0, m;
  while ((m = sheetRe.exec(wbXml))) {
    n++;
    const a = attrsOf(m[1]);
    const idKey = Object.keys(a).find((k) => k.includes(":") && localName(k) === "id");
    const target = (idKey && rels.get(a[idKey])) || `worksheets/sheet${n}.xml`;
    const xml = await readText(resolveTarget(target));
    if (xml == null) continue;
    if (xml.length > MAX_XML_BYTES) throw new Error("sheet too large");
    sheets.push({ name: a.name || `Sheet${n}`, grid: parseSheet(xml, shared, maxCol, maxRow) });
  }
  return sheets;
}

/** Reads a whole .xlsx buffer. jszip ships with exceljs (a dependency of it), so nothing new is installed. */
async function readXlsxTolerant(buffer, limits) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  return xlsxToSheets(async (name) => {
    const f = zip.file(name);
    return f ? (await f.async("string")).replace(/^\uFEFF/, "") : null;
  }, limits);
}

module.exports = { readXlsxTolerant, xlsxToSheets, parseSheet, parseSharedStrings, resolveTarget, colIndex };
