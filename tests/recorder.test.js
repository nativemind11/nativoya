// Runs the real js/wav-recorder.js inside a sandbox with the browser APIs
// stubbed, and drives its stop() pipeline with synthetic microphone blocks:
// raw blocks -> channel mix -> resample -> analyze -> encode -> server check.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const E = require("../js/wav-engine.js");
const { validateClip } = require("../config/audioValidate.js");

function loadRecorder() {
  const win = {};
  const sandbox = {
    window: win, navigator: {}, WavEngine: E, Blob, setTimeout, console,
    URL, AudioWorkletNode: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/wav-recorder.js"), "utf8"), sandbox);
  return win.StudioRecorder;
}

function blocks(freq, rate, seconds, nch, amp = 0.5) {
  const total = Math.round(rate * seconds);
  const out = [];
  for (let start = 0; start + 1024 <= total; start += 1024) {
    const chans = Array.from({ length: nch }, () => new Float32Array(1024));
    for (let i = 0; i < 1024; i++) {
      const v = amp * Math.sin((2 * Math.PI * freq * (start + i)) / rate);
      for (let c = 0; c < nch; c++) chans[c][i] = v;
    }
    out.push(chans);
  }
  return out;
}

async function record(settings, deviceRate, nch, data) {
  const R = loadRecorder();
  const r = new R(settings);
  r.deviceRate = deviceRate;
  r.chunks = data;
  r.frames = data.length * 1024;
  r.recording = true;
  const res = await r.stop();
  return { res, buf: Buffer.from(await res.blob.arrayBuffer()) };
}

test("48k stereo mic -> 16k/16-bit mono task: exact file, passes server validation", async () => {
  const s = { sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" };
  const { res, buf } = await record(s, 48000, 2, blocks(440, 48000, 1.5, 2));
  assert.strictEqual(res.ext, "wav");
  const check = validateClip(buf, s);
  assert.strictEqual(check.ok, true, JSON.stringify(check));
  assert.ok(Math.abs(check.info.duration - 1.5) < 0.05, `duration ${check.info.duration}`);
  assert.ok(Math.abs(res.stats.peak - 0.5) < 0.02, `peak ${res.stats.peak}`);
  assert.deepStrictEqual(res.verdict, []);
  assert.strictEqual(res.info.deviceBelowTarget, false);
});

test("44.1k mono mic -> 48k/24-bit stereo task: upmix flagged, header exact", async () => {
  const s = { sampleRate: 48000, bitDepth: 24, format: "wav", channels: "stereo" };
  const { res, buf } = await record(s, 44100, 1, blocks(300, 44100, 1.2, 1));
  assert.strictEqual(res.info.upmixed, true);
  assert.strictEqual(validateClip(buf, s).ok, true);
});

test("device slower than the task rate is reported", async () => {
  const s = { sampleRate: 48000, bitDepth: 16, format: "wav", channels: "mono" };
  const { res } = await record(s, 16000, 1, blocks(300, 16000, 1, 1));
  assert.strictEqual(res.info.deviceBelowTarget, true);
});

test("a silent take is flagged as an error by the recorder AND refused by the server", async () => {
  const s = { sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" };
  const { res, buf } = await record(s, 48000, 1, blocks(300, 48000, 1, 1, 0));
  assert.ok(res.verdict.some((v) => v.code === "silent" && v.level === "error"));
  assert.strictEqual(validateClip(buf, s).code, "silent");
});

test("length cap keeps a take under the 4.5MB request limit", () => {
  const R = loadRecorder();
  const hi = new R({ sampleRate: 48000, bitDepth: 24, format: "wav", channels: "stereo" });
  const lo = new R({ sampleRate: 16000, bitDepth: 16, format: "wav", channels: "mono" });
  assert.ok(hi.maxSeconds * 288000 < 4.5 * 1024 * 1024);
  assert.ok(lo.maxSeconds <= 60);
});

test("mp3 task without the encoder fails loudly instead of returning a fake mp3", async () => {
  const s = { sampleRate: 16000, bitDepth: 16, format: "mp3", channels: "mono" };
  await assert.rejects(() => record(s, 16000, 1, blocks(300, 16000, 1, 1)), /MP3_ENCODER_MISSING/);
});
