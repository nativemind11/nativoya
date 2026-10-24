/**
 * Fallback .xlsx reader — used ONLY when ExcelJS throws on a file.
 *
 * ExcelJS is strict about some structures that other tools (the company's export tool,
 * Google Sheets, WPS, LibreOffice...) write freely (odd drawings, tables, styles, ...), and it
 * rejects the whole workbook even though the cells themselves are perfectly readable.
 * This reads just the cell values straight from the XML inside the .xlsx (a zip):
 * shared strings + each worksheet's rows. No styles, no formulas, no drawings — the feedback
 * flow only needs text and numbers.
 */
const JSZip = require("jszip");

const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ""; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (_) { return ""; } })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** All visible text of a <si> / <is> element (rich-text runs joined, phonetic hints skipped). */
function textOf(xml) {
  const clean = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(clean))) out += m[1];
  return decode(out);
}

const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s);
  return m ? decode(m[1]) : null;
};

function colIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readText(zip, path) {
  const f = zip.file(path) || zip.file(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))[0];
  return f ? f.async("string") : null;
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : "");
  return out;
}

function parseSheet(xml, shared, maxRows, maxCols) {
  const grid = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm, seqRow = 0;
  while ((rm = rowRe.exec(xml))) {
    seqRow++;
    const rNo = Number(attr(rm[1], "r")) || seqRow;
    seqRow = rNo;
    if (rNo > maxRows) break;
    const arr = [];
    const body = rm[2] || "";
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, seqCol = -1;
    while ((cm = cellRe.exec(body))) {
      let ci = colIndex(attr(cm[1], "r"));
      if (ci < 0) ci = seqCol + 1;
      seqCol = ci;
      if (ci >= maxCols) continue;
      const t = attr(cm[1], "t");
      const inner = cm[2] || "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let val = "";
      if (t === "s") val = v ? (shared[Number(v[1])] ?? "") : "";
      else if (t === "inlineStr") { const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner); val = is ? textOf(is[1]) : ""; }
      else if (t === "b") val = v ? (v[1].trim() === "1" ? "TRUE" : "FALSE") : "";
      else val = v ? decode(v[1]) : "";
      arr[ci] = String(val).trim().slice(0, 2000);
    }
    while (grid.length < rNo - 1) grid.push([]);
    grid[rNo - 1] = arr;
  }
  let width = 0;
  for (const r of grid) width = Math.max(width, r.length);
  const full = grid.map((r) => Array.from({ length: width }, (_, i) => r[i] || ""));
  while (full.length && full[full.length - 1].every((x) => !x)) full.pop();
  return full;
}

/** Returns [{ name, grid }] like parseSpreadsheet, or throws if the zip/XML is unusable. */
async function parseXlsxFallback(buffer, { maxRows, maxCols }) {
  const zip = await JSZip.loadAsync(buffer);
  const shared = parseSharedStrings(await readText(zip, "xl/sharedStrings.xml"));

  // sheet name -> file, in workbook order (falls back to every xl/worksheets/*.xml)
  const targets = [];
  const wb = await readText(zip, "xl/workbook.xml");
  const rels = await readText(zip, "xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const relMap = new Map();
    const relRe = /<Relationship\b([^>]*?)\/?>/g;
    let m;
    while ((m = relRe.exec(rels))) {
      const id = attr(m[1], "Id"), tg = attr(m[1], "Target");
      if (id && tg) relMap.set(id, tg.startsWith("/") ? tg.slice(1) : `xl/${tg.replace(/^\.\//, "")}`);
    }
    const shRe = /<sheet\b([^>]*?)\/?>/g;
    while ((m = shRe.exec(wb))) {
      const rid = attr(m[1], "r:id") || attr(m[1], "id");
      const path = relMap.get(rid);
      if (path && /worksheets\//i.test(path)) targets.push({ name: attr(m[1], "name") || `Sheet${targets.length + 1}`, path });
    }
  }
  if (!targets.length) {
    zip.file(/^xl\/worksheets\/[^/]+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .forEach((f, i) => targets.push({ name: `Sheet${i + 1}`, path: f.name }));
  }
  if (!targets.length) throw new Error("no worksheets found in the file");

  const sheets = [];
  for (const t of targets) {
    const xml = await readText(zip, t.path);
    if (!xml) continue;
    const grid = parseSheet(xml, shared, maxRows, maxCols);
    if (grid.length) sheets.push({ name: t.name, grid });
  }
  return sheets;
}

module.exports = { parseXlsxFallback };
