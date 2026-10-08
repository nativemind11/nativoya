/**
 * Server-side proof that an uploaded clip is what the task asked for.
 *
 * The browser records to the task's settings, but the browser is not trusted:
 * a stale cached page, an old app version or a hand-made request could send
 * anything. Every clip is parsed here and rejected unless its real header
 * matches recording_settings (sample rate, bit depth, channels, format).
 * Rejections carry a machine-readable `code` so the UI can translate them.
 */

const MIN_DURATION_SEC = 0.3;
const MAX_DURATION_SEC = 120;

// ---------- WAV ----------
function parseWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let fmt = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitDepth: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, buf.length - body);
      break;
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) return null;

  const bytesPerFrame = fmt.channels * (fmt.bitDepth / 8);
  if (!bytesPerFrame) return null;
  const frames = Math.floor(dataBytes / bytesPerFrame);
  return {
    container: "wav",
    pcm: fmt.audioFormat === 1,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitDepth: fmt.bitDepth,
    duration: frames / fmt.sampleRate,
    dataOffset,
    dataBytes,
  };
}

/** Peak absolute sample as a 0..1 fraction (PCM 16/24 only). */
function wavPeak(buf, info) {
  const step = info.bitDepth / 8;
  const max = info.bitDepth === 16 ? 32768 : 8388608;
  let peak = 0;
  const end = info.dataOffset + info.dataBytes - (step - 1);
  for (let i = info.dataOffset; i < end; i += step) {
    const v = info.bitDepth === 16 ? buf.readInt16LE(i) : buf.readIntLE(i, 3);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak / max;
}

// ---------- MP3 ----------
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function parseMp3(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  let sampleRate = 0, channels = 0, frames = 0, samples = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; }
    const version = (buf[pos + 1] >> 3) & 3;    // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[pos + 1] >> 1) & 3;      // 1 = Layer III
    const brIdx = (buf[pos + 2] >> 4) & 15;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    const padding = (buf[pos + 2] >> 1) & 1;
    if (layer !== 1 || version === 1 || srIdx === 3 || brIdx === 0 || brIdx === 15) { pos++; continue; }
    const rate = MP3_RATES[version][srIdx];
    const kbps = (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[brIdx];
    const frameLen = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + padding;
    if (!frames) { sampleRate = rate; channels = ((buf[pos + 3] >> 6) & 3) === 3 ? 1 : 2; }
    frames++;
    samples += version === 3 ? 1152 : 576;
    pos += frameLen;
  }
  if (!frames) return null;
  return { container: "mp3", channels, sampleRate, bitDepth: null, duration: samples / sampleRate };
}

// ---------- the actual check ----------
function fail(code, error) { return { ok: false, code, error }; }

/**
 * @param {Buffer} buf
 * @param {{sampleRate:number, bitDepth:number, format:string, channels:string}} settings
 */
function validateClip(buf, settings) {
  const format = String(settings.format || "wav").toLowerCase();
  const wantChannels = settings.channels === "stereo" ? 2 : 1;
  const wantRate = Number(settings.sampleRate);
  const wantDepth = Number(settings.bitDepth);

  const info = format === "mp3" ? parseMp3(buf) : parseWav(buf);
  if (!info) {
    return fail("bad_format", `الملف ده مش ${format.toUpperCase()} صالح. حدّث الصفحة وسجّل تاني.`);
  }
  if (format === "wav") {
    if (!info.pcm) return fail("bad_format", "الملف مش WAV بصيغة PCM. حدّث الصفحة وسجّل تاني.");
    if (info.sampleRate !== wantRate) {
      return fail("wrong_sample_rate", `التسجيل بـ ${info.sampleRate}Hz والمطلوب ${wantRate}Hz.`);
    }
    if (info.bitDepth !== wantDepth) {
      return fail("wrong_bit_depth", `التسجيل ${info.bitDepth}-bit والمطلوب ${wantDepth}-bit.`);
    }
  } else if (info.sampleRate !== wantRate) {
    return fail("wrong_sample_rate", `التسجيل بـ ${info.sampleRate}Hz والمطلوب ${wantRate}Hz.`);
  }
  if (info.channels !== wantChannels) {
    return fail("wrong_channels", `التسجيل ${info.channels === 1 ? "Mono" : "Stereo"} والمطلوب ${wantChannels === 1 ? "Mono" : "Stereo"}.`);
  }
  if (info.duration < MIN_DURATION_SEC) return fail("too_short", "التسجيل قصير جدًا.");
  if (info.duration > MAX_DURATION_SEC) return fail("too_long", "التسجيل طويل جدًا.");

  if (format === "wav" && (info.bitDepth === 16 || info.bitDepth === 24)) {
    if (wavPeak(buf, info) < 0.003) return fail("silent", "التسجيل صامت — مفيش صوت اتسجل. اتأكد من الميكروفون.");
  }
  return { ok: true, info };
}

module.exports = { validateClip, parseWav, parseMp3, wavPeak, MIN_DURATION_SEC, MAX_DURATION_SEC };
