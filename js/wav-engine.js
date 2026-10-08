/**
 * Nativoya Studio — audio engine.
 *
 * Pure functions only (no DOM, no Web Audio), so the exact same file is used
 * by the browser recorder and by the Node test-suite. Everything that decides
 * the *quality* of what a talent submits lives here:
 *
 *   - resample()   windowed-sinc resampler (anti-aliased) to the task's rate
 *   - mixChannels() mono/stereo conversion
 *   - encodeWav()  real PCM WAV, 16 or 24 bit — never a renamed webm
 *   - encodeMp3()  real MP3 via lamejs (only if the page loaded it)
 *   - analyze()    peak / RMS / clipping / silence / noise-floor measurements
 *   - verdict()    turns measurements into error/warning codes for the UI
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WavEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- small helpers ----------
  const dbfs = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

  function sinc(x) {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
  }

  function blackman(u) {
    // u in [-1, 1]
    if (u <= -1 || u >= 1) return 0;
    return 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
  }

  // ---------- resampling ----------
  const TABLE_RES = 512;        // kernel samples per input-sample step
  const ZERO_CROSSINGS = 16;    // quality knob: taps per side = ZC / cutoff

  /**
   * High-quality windowed-sinc resampler. The low-pass cutoff sits just under
   * the *lower* of the two Nyquist frequencies, so downsampling is properly
   * anti-aliased (a 12 kHz tone sampled at 48 kHz does NOT fold back into the
   * 16 kHz output as a false 4 kHz tone).
   */
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = toRate / fromRate;
    const cutoff = Math.min(1, ratio) * 0.97;
    const half = Math.ceil(ZERO_CROSSINGS / cutoff);
    const tableLen = half * TABLE_RES + 2;
    const table = new Float32Array(tableLen);
    for (let k = 0; k < tableLen; k++) {
      const x = k / TABLE_RES;
      table[k] = cutoff * sinc(cutoff * x) * blackman(x / half);
    }
    const kernel = (x) => {
      const ax = Math.abs(x);
      if (ax >= half) return 0;
      const pos = ax * TABLE_RES;
      const i = Math.floor(pos);
      const f = pos - i;
      return table[i] * (1 - f) + table[i + 1] * f;
    };

    const n = input.length;
    const outLen = Math.max(1, Math.round(n * ratio));
    const out = new Float32Array(outLen);
    for (let j = 0; j < outLen; j++) {
      const t = j / ratio;
      const base = Math.floor(t);
      let acc = 0;
      let wsum = 0;
      for (let i = base - half + 1; i <= base + half; i++) {
        const w = kernel(i - t);
        wsum += w;
        if (i >= 0 && i < n) acc += input[i] * w;
      }
      out[j] = wsum !== 0 ? acc / wsum : 0;
    }
    return out;
  }

  // ---------- channel handling ----------
  /**
   * @param {Float32Array[]} chans   source channels (length >= 1)
   * @param {number} target          1 or 2
   * @returns {{channels: Float32Array[], upmixed: boolean}}
   */
  function mixChannels(chans, target) {
    const src = chans.length;
    if (target === 1) {
      if (src === 1) return { channels: [chans[0]], upmixed: false };
      const len = chans[0].length;
      const mono = new Float32Array(len);
      for (let c = 0; c < src; c++) {
        const ch = chans[c];
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      for (let i = 0; i < len; i++) mono[i] /= src;
      return { channels: [mono], upmixed: false };
    }
    // stereo target
    if (src >= 2) return { channels: [chans[0], chans[1]], upmixed: false };
    return { channels: [chans[0], chans[0]], upmixed: true };
  }

  // ---------- WAV encoding ----------
  function encodeWav(channels, sampleRate, bitDepth) {
    if (bitDepth !== 16 && bitDepth !== 24) throw new Error("bitDepth must be 16 or 24");
    const nch = channels.length;
    const n = channels[0].length;
    const bytes = bitDepth / 8;
    const dataSize = n * nch * bytes;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                       // PCM
    view.setUint16(22, nch, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * nch * bytes, true);
    view.setUint16(32, nch * bytes, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let s = channels[c][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        if (bitDepth === 16) {
          view.setInt16(off, Math.round(s < 0 ? s * 32768 : s * 32767), true);
          off += 2;
        } else {
          const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
          view.setUint8(off, v & 0xff);
          view.setUint8(off + 1, (v >> 8) & 0xff);
          view.setUint8(off + 2, (v >> 16) & 0xff);
          off += 3;
        }
      }
    }
    return buffer;
  }

  // ---------- MP3 encoding (needs lamejs on the page) ----------
  function encodeMp3(channels, sampleRate, kbps) {
    const lib = (typeof lamejs !== "undefined") ? lamejs : (typeof self !== "undefined" ? self.lamejs : undefined);
    if (!lib || !lib.Mp3Encoder) throw new Error("MP3_ENCODER_MISSING");
    const nch = channels.length;
    const enc = new lib.Mp3Encoder(nch, sampleRate, kbps || 128);
    const toInt16 = (f) => {
      const out = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
      }
      return out;
    };
    const left = toInt16(channels[0]);
    const right = nch > 1 ? toInt16(channels[1]) : null;
    const parts = [];
    const BLOCK = 1152;
    for (let i = 0; i < left.length; i += BLOCK) {
      const l = left.subarray(i, i + BLOCK);
      const buf = nch > 1 ? enc.encodeBuffer(l, right.subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
      if (buf.length) parts.push(new Int8Array(buf));
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Int8Array(tail));
    return parts;
  }

  // ---------- analysis ----------
  const WINDOW_MS = 20;

  function windowRms(mono, sampleRate) {
    const win = Math.max(1, Math.round(sampleRate * WINDOW_MS / 1000));
    const count = Math.floor(mono.length / win);
    const out = new Float32Array(count);
    for (let w = 0; w < count; w++) {
      let sum = 0;
      const start = w * win;
      for (let i = 0; i < win; i++) { const v = mono[start + i]; sum += v * v; }
      out[w] = Math.sqrt(sum / win);
    }
    return out;
  }

  /**
   * @param {Float32Array} mono   float samples in [-1, 1]
   * @returns {object} measurements (all levels in dBFS)
   */
  function analyze(mono, sampleRate) {
    const n = mono.length;
    let peak = 0, sumSq = 0, clipCount = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(mono[i]);
      if (a > peak) peak = a;
      if (a >= 0.99) clipCount++;
      sumSq += a * a;
    }
    const rms = n ? Math.sqrt(sumSq / n) : 0;
    const wr = windowRms(mono, sampleRate);

    const SPEECH_THRESHOLD = Math.pow(10, -45 / 20);
    let first = -1, last = -1;
    for (let i = 0; i < wr.length; i++) {
      if (wr[i] >= SPEECH_THRESHOLD) { if (first === -1) first = i; last = i; }
    }
    const durationSec = n / sampleRate;
    const activeSec = first === -1 ? 0 : ((last - first + 1) * WINDOW_MS) / 1000;
    const leadingSilenceMs = first === -1 ? durationSec * 1000 : first * WINDOW_MS;
    const trailingSilenceMs = first === -1 ? durationSec * 1000 : (wr.length - 1 - last) * WINDOW_MS;

    let noiseFloorDb = -180;
    let loudDb = -180;
    if (wr.length) {
      const sorted = Array.from(wr).sort((a, b) => a - b);
      noiseFloorDb = dbfs(sorted[Math.floor(sorted.length * 0.1)]);
      loudDb = dbfs(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]);
    }
    // Contrast between the loud parts and the quietest parts. If it is tiny
    // there simply was no pause in the take, so the "quiet" part is really
    // speech and says nothing about the room's noise.
    const snrDb = loudDb - noiseFloorDb;

    return {
      durationSec,
      peak, peakDb: dbfs(peak),
      rms, rmsDb: dbfs(rms),
      clipCount, clipRatio: n ? clipCount / n : 0,
      activeSec, leadingSilenceMs, trailingSilenceMs,
      noiseFloorDb, loudDb, snrDb,
    };
  }

  /**
   * Converts measurements into UI codes. level "error" = the take must be
   * redone; level "warn" = allowed, but the talent is told about it.
   */
  function verdict(stats) {
    const out = [];
    if (stats.peakDb < -50) out.push({ level: "error", code: "silent" });
    else if (stats.activeSec < 0.3) out.push({ level: "error", code: "too_short" });
    if (stats.clipRatio > 0.005) out.push({ level: "error", code: "clipping" });
    else if (stats.clipRatio > 0.0005) out.push({ level: "warn", code: "clipping_light" });
    if (stats.peakDb >= -50 && stats.peakDb < -20) out.push({ level: "warn", code: "too_quiet" });
    if (stats.noiseFloorDb > -45 && stats.snrDb >= 8 && stats.peakDb >= -50) out.push({ level: "warn", code: "noisy" });
    if (stats.leadingSilenceMs > 2000) out.push({ level: "warn", code: "long_lead" });
    if (stats.trailingSilenceMs > 2500) out.push({ level: "warn", code: "long_tail" });
    return out;
  }

  /** Classifies an ambient-noise measurement (dBFS RMS of "silence"). */
  function classifyNoise(noiseRmsDb) {
    if (noiseRmsDb < -55) return "excellent";
    if (noiseRmsDb < -45) return "good";
    if (noiseRmsDb < -35) return "noisy";
    return "very_noisy";
  }

  /** Bytes per second of the final file — used to cap recording length. */
  function bytesPerSecond(settings) {
    const ch = settings.channels === "stereo" ? 2 : 1;
    if (settings.format === "mp3") return (128 * 1000) / 8;
    return settings.sampleRate * ch * (settings.bitDepth / 8);
  }

  return {
    dbfs, resample, mixChannels, encodeWav, encodeMp3,
    analyze, verdict, classifyNoise, bytesPerSecond,
  };
});
