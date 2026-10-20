// Serving a small audio file the way browsers expect it. Phones (iOS Safari, Android Chrome) will not play an
// <audio> source unless the server answers byte-range requests (206 Partial Content) with a Content-Length and
// "Accept-Ranges: bytes" — otherwise the player stays on 0:00 / 0:00.

const AUDIO_TYPES = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac" };

/** Uses what Drive says, but never "octet-stream"/video: falls back to the file extension. */
function audioContentType(mime, name) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("audio/")) return m === "audio/x-wav" ? "audio/wav" : m;
  const ext = String(name || "").toLowerCase().split(".").pop();
  return AUDIO_TYPES[ext] || "audio/mpeg";
}

/** Parses a "Range" header against a file of `size` bytes -> {start, end} | "invalid" | null (no range). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start, end;
  if (m[1] === "") {                       // suffix: the last N bytes
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** Sends `buf` (200, or 206 for a Range request). */
function sendAudio(req, res, buf, contentType) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  const range = parseRange(req.headers.range, buf.length);
  if (range === "invalid") {
    res.statusCode = 416; res.setHeader("Content-Range", `bytes */${buf.length}`); return res.end();
  }
  if (!range) { res.statusCode = 200; res.setHeader("Content-Length", buf.length); return res.end(buf); }
  res.statusCode = 206;
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${buf.length}`);
  res.setHeader("Content-Length", range.end - range.start + 1);
  return res.end(buf.subarray(range.start, range.end + 1));
}

module.exports = { audioContentType, parseRange, sendAudio };
