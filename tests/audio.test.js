const test = require("node:test");
const assert = require("node:assert");
const E = require("../js/wav-engine.js");
const { validateClip, parseWav } = require("../config/audioValidate.js");

const sine = (freq, rate, sec, amp = 0.5) => {
  const out = new Float32Array(Math.round(rate * sec));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};
const rmsOf = (a, from = 0, to = a.length) => {
  let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};
const wavBuf = (chans, rate, depth) => Buffer.from(E.encodeWav(chans, rate, depth));
const SETTINGS = { sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" };

test("encodeWav writes a header the server parser reads back exactly", () => {
  for (const depth of [16, 24]) {
    for (const [rate, nch] of [[16000, 1], [44100, 2], [48000, 1]]) {
      const ch = Array.from({ length: nch }, () => sine(440, rate, 1));
      const info = parseWav(wavBuf(ch, rate, depth));
      assert.strictEqual(info.sampleRate, rate);
      assert.strictEqual(info.bitDepth, depth);
      assert.strictEqual(info.channels, nch);
      assert.ok(Math.abs(info.duration - 1) < 1e-6);
    }
  }
});

test("resample 48k -> 16k keeps a 1 kHz tone at the right level and length", () => {
  const out = E.resample(sine(1000, 48000, 1), 48000, 16000);
  assert.strictEqual(out.length, 16000);
  const r = rmsOf(out, 800, out.length - 800); // skip edge transients
  assert.ok(Math.abs(r - 0.5 / Math.SQRT2) < 0.01, `rms was ${r}`);
});

test("resample is anti-aliased: 12 kHz at 48k must NOT fold into 16k output", () => {
  const out = E.resample(sine(12000, 48000, 1), 48000, 16000);
  const r = rmsOf(out, 800, out.length - 800);
  assert.ok(r < 0.01, `aliased energy too high: ${r}`);
});

test("resample up 44.1k -> 48k preserves tone level", () => {
  const out = E.resample(sine(2000, 44100, 1), 44100, 48000);
  assert.ok(Math.abs(out.length - 48000) <= 1);
  const r = rmsOf(out, 800, out.length - 800);
  assert.ok(Math.abs(r - 0.5 / Math.SQRT2) < 0.01, `rms was ${r}`);
});

test("mixChannels: stereo->mono averages, mono->stereo flags upmix", () => {
  const l = new Float32Array([1, 0]), r = new Float32Array([0, 1]);
  const m = E.mixChannels([l, r], 1);
  assert.deepStrictEqual(Array.from(m.channels[0]), [0.5, 0.5]);
  assert.strictEqual(E.mixChannels([l], 2).upmixed, true);
  assert.strictEqual(E.mixChannels([l, r], 2).upmixed, false);
});

test("analyze + verdict: silence, clipping, quiet, good", () => {
  const rate = 16000;
  const silent = E.analyze(new Float32Array(rate), rate);
  assert.ok(E.verdict(silent).some((v) => v.code === "silent"));

  const clipped = sine(300, rate, 1, 1.5).map((v) => Math.max(-1, Math.min(1, v)));
  assert.ok(E.verdict(E.analyze(clipped, rate)).some((v) => v.code === "clipping" && v.level === "error"));

  const quiet = E.analyze(sine(300, rate, 1, 0.03), rate);
  assert.ok(E.verdict(quiet).some((v) => v.code === "too_quiet"));

  const good = E.analyze(sine(300, rate, 1, 0.5), rate);
  assert.deepStrictEqual(E.verdict(good), []);
});

test("verdict: noisy room is flagged only when there are real pauses", () => {
  const rate = 16000;
  // loud-ish background hiss (-38 dBFS) with a 1s "speech" burst in the middle
  const noisy = new Float32Array(rate * 3);
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 0; i < noisy.length; i++) noisy[i] = rnd() * 0.025;
  noisy.set(sine(300, rate, 1, 0.5), rate);
  assert.ok(E.verdict(E.analyze(noisy, rate)).some((v) => v.code === "noisy"));
  // a continuous take with no pause must not be called noisy
  assert.ok(!E.verdict(E.analyze(sine(300, rate, 2, 0.5), rate)).some((v) => v.code === "noisy"));
});

test("analyze measures leading silence", () => {
  const rate = 16000;
  const buf = new Float32Array(rate * 2);
  buf.set(sine(300, rate, 1, 0.5), rate); // 1s silence then 1s tone
  const s = E.analyze(buf, rate);
  assert.ok(s.leadingSilenceMs >= 900 && s.leadingSilenceMs <= 1100, `lead ${s.leadingSilenceMs}`);
});

test("classifyNoise thresholds", () => {
  assert.strictEqual(E.classifyNoise(-60), "excellent");
  assert.strictEqual(E.classifyNoise(-50), "good");
  assert.strictEqual(E.classifyNoise(-40), "noisy");
  assert.strictEqual(E.classifyNoise(-20), "very_noisy");
});

test("validateClip accepts a correct clip", () => {
  const r = validateClip(wavBuf([sine(300, 16000, 1)], 16000, 16), SETTINGS);
  assert.strictEqual(r.ok, true);
  assert.ok(Math.abs(r.info.duration - 1) < 1e-6);
});

test("validateClip rejects wrong rate / depth / channels / garbage / silence / short", () => {
  const code = (buf, s = SETTINGS) => validateClip(buf, s).code;
  assert.strictEqual(code(wavBuf([sine(300, 48000, 1)], 48000, 16)), "wrong_sample_rate");
  assert.strictEqual(code(wavBuf([sine(300, 16000, 1)], 16000, 24)), "wrong_bit_depth");
  assert.strictEqual(code(wavBuf([sine(300, 16000, 1), sine(300, 16000, 1)], 16000, 16)), "wrong_channels");
  assert.strictEqual(code(Buffer.from("this is a webm file renamed to wav".repeat(5))), "bad_format");
  assert.strictEqual(code(wavBuf([new Float32Array(16000)], 16000, 16)), "silent");
  assert.strictEqual(code(wavBuf([sine(300, 16000, 0.1)], 16000, 16)), "too_short");
});

test("validateClip checks 24-bit stereo tasks end to end", () => {
  const s = { sampleRate: 48000, bitDepth: 24, format: "wav", channels: "stereo" };
  const buf = wavBuf([sine(300, 48000, 1), sine(500, 48000, 1)], 48000, 24);
  assert.strictEqual(validateClip(buf, s).ok, true);
});

test("validateClip parses an MP3 frame header (44.1k joint stereo, 128k)", () => {
  // 0xFFFB = MPEG1 Layer III, no CRC; 0x90 = 128kbps @ 44.1kHz; 0x00 = stereo
  const frameLen = Math.floor((144 * 128000) / 44100); // 417
  const frame = Buffer.alloc(frameLen);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  const buf = Buffer.concat(Array.from({ length: 40 }, () => frame)); // ~1.04s
  const ok = validateClip(buf, { sampleRate: 44100, bitDepth: 16, format: "mp3", channels: "stereo" });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  const bad = validateClip(buf, { sampleRate: 16000, bitDepth: 16, format: "mp3", channels: "stereo" });
  assert.strictEqual(bad.code, "wrong_sample_rate");
});

test("bytesPerSecond sizes the length cap correctly", () => {
  assert.strictEqual(E.bytesPerSecond({ sampleRate: 16000, bitDepth: 16, channels: "mono", format: "wav" }), 32000);
  assert.strictEqual(E.bytesPerSecond({ sampleRate: 48000, bitDepth: 24, channels: "stereo", format: "wav" }), 288000);
});
