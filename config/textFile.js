/**
 * Reads an uploaded .txt (script / fake-name list) into clean, non-empty lines.
 *
 * Why not just buffer.toString("utf-8"): files saved from Windows Notepad as
 * "Unicode" are UTF-16 (every character is followed by a NUL byte). Read as
 * UTF-8 they contain NUL characters, which PostgreSQL refuses to store
 * ("invalid byte sequence"), so the whole upload failed with a generic error.
 * Also strips the UTF-8 BOM that would otherwise stick to the first sentence.
 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  let text = buf.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function readLines(buf) {
  return decodeText(buf)
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

module.exports = { decodeText, readLines };
