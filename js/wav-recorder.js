/**
 * Nativoya Studio — browser recorder.
 *
 * Captures RAW PCM through an AudioWorklet (ScriptProcessor as a fallback for
 * old Safari) instead of MediaRecorder. MediaRecorder can only produce
 * compressed webm/opus at a rate the browser picks, so it can never honour
 * "48 kHz / 24-bit WAV". Here the raw float samples are converted to exactly
 * the task's sample rate / channels / bit depth by js/wav-engine.js.
 *
 * Browser audio "enhancements" (echo cancellation, noise suppression, auto
 * gain) are switched OFF — they alter the signal, which a dataset buyer
 * treats as contamination.
 *
 * Requires js/wav-engine.js to be loaded first.
 */
(function () {
  "use strict";

  const BLOCK = 1024; // frames per message from the audio thread

  const WORKLET_SRC = `
    class CaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.rec = false;
        this.fill = 0;
        this.bufs = null;
        this.port.onmessage = (e) => { this.rec = e.data === "start"; };
      }
      process(inputs) {
        const input = inputs[0];
        if (!input || !input.length) return true;
        const nch = input.length;
        if (!this.bufs || this.bufs.length !== nch) {
          this.bufs = Array.from({ length: nch }, () => new Float32Array(${BLOCK}));
          this.fill = 0;
        }
        const frames = input[0].length;
        for (let c = 0; c < nch; c++) this.bufs[c].set(input[c], this.fill);
        this.fill += frames;
        if (this.fill >= ${BLOCK}) {
          const ch0 = this.bufs[0];
          let peak = 0, sum = 0;
          for (let i = 0; i < ${BLOCK}; i++) { const v = ch0[i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sum += v * v; }
          const msg = { rms: Math.sqrt(sum / ${BLOCK}), peak };
          if (this.rec) {
            msg.data = this.bufs.map((b) => b.slice(0));
            this.port.postMessage(msg, msg.data.map((b) => b.buffer));
          } else {
            this.port.postMessage(msg);
          }
          this.fill = 0;
        }
        return true;
      }
    }
    registerProcessor("capture-processor", CaptureProcessor);
  `;

  class StudioRecorder {
    /**
     * @param {{sampleRate:number, bitDepth:number, format:string, channels:string}} settings
     */
    constructor(settings) {
      const s = settings || {};
      this.settings = {
        sampleRate: Number(s.sampleRate) || 16000,
        bitDepth: Number(s.bitDepth) || 16,
        format: String(s.format || "wav").toLowerCase(),
        channels: s.channels === "stereo" ? "stereo" : "mono",
      };
      this.ctx = null;
      this.stream = null;
      this.analyser = null;
      this.recording = false;
      this.chunks = [];
      this.frames = 0;
      this.deviceRate = 0;
      this.onLevel = null;       // (rms, peak) every ~21-64 ms
      this.onDeviceLost = null;  // mic unplugged / permission revoked
      this.onAutoStop = null;    // length cap reached
      this._level = null;        // temporary measurement listener
      this._node = null;
      this.maxSeconds = Math.min(
        60,
        Math.floor((3.8 * 1024 * 1024) / WavEngine.bytesPerSecond(this.settings)) // stays under the 4.5MB request limit
      );
    }

    static isSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
        (window.AudioContext || window.webkitAudioContext));
    }

    /** Opens the mic (and keeps it open, so the first word is never clipped). */
    async open(deviceId) {
      await this.close();
      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: this.settings.channels === "stereo" ? 2 : 1 },
        sampleRate: { ideal: this.settings.sampleRate },
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });

      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx(); // device-native rate; conversion happens in JS afterwards
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.deviceRate = this.ctx.sampleRate;

      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);

      const sink = this.ctx.createGain();
      sink.gain.value = 0; // keeps the graph "pulled" on Safari without audible output
      sink.connect(this.ctx.destination);

      const handle = (m) => {
        if (this._level) this._level(m.rms, m.peak);
        if (this.onLevel) this.onLevel(m.rms, m.peak);
        if (this.recording && m.data) {
          this.chunks.push(m.data);
          this.frames += m.data[0].length;
          if (this.frames / this.deviceRate >= this.maxSeconds && this.onAutoStop) {
            const cb = this.onAutoStop; // fire once
            this.onAutoStop = null;
            cb();
          }
        }
      };

      let usedWorklet = false;
      if (this.ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
        try {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
          await this.ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          const node = new AudioWorkletNode(this.ctx, "capture-processor", {
            numberOfInputs: 1, numberOfOutputs: 1,
            channelCount: 2, channelCountMode: "max", channelInterpretation: "speakers",
          });
          node.port.onmessage = (e) => handle(e.data);
          source.connect(node);
          node.connect(sink);
          this._node = node;
          usedWorklet = true;
        } catch (err) {
          console.warn("AudioWorklet unavailable, falling back to ScriptProcessor:", err);
        }
      }
      if (!usedWorklet) {
        const node = this.ctx.createScriptProcessor(4096, 2, 1);
        node.onaudioprocess = (e) => {
          const nch = e.inputBuffer.numberOfChannels;
          const len = e.inputBuffer.length;
          const copy = [];
          let peak = 0, sum = 0;
          for (let c = 0; c < nch; c++) copy.push(new Float32Array(e.inputBuffer.getChannelData(c)));
          for (let i = 0; i < len; i++) { const v = copy[0][i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sum += v * v; }
          handle({ rms: Math.sqrt(sum / len), peak, data: this.recording ? copy : undefined });
        };
        source.connect(node);
        node.connect(sink);
        this._node = node;
      }

      const track = this.stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener("ended", () => { if (this.onDeviceLost) this.onDeviceLost(); });
        this.trackSettings = track.getSettings ? track.getSettings() : {};
        this.deviceLabel = track.label || "";
      }
      return { deviceRate: this.deviceRate, deviceLabel: this.deviceLabel, trackSettings: this.trackSettings };
    }

    isOpen() { return !!(this.ctx && this.stream); }

    /** Lists microphones (labels only appear after permission was granted). */
    static async listMics() {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    }

    /** Measures the mic for `ms` without storing audio. Resolves with level stats. */
    measure(ms) {
      return new Promise((resolve) => {
        const rmsList = [];
        let peak = 0;
        this._level = (rms, p) => { rmsList.push(rms); if (p > peak) peak = p; };
        setTimeout(() => {
          this._level = null;
          let sum = 0;
          for (const r of rmsList) sum += r * r;
          const rms = rmsList.length ? Math.sqrt(sum / rmsList.length) : 0;
          resolve({ rmsDb: WavEngine.dbfs(rms), peakDb: WavEngine.dbfs(peak), blocks: rmsList.length });
        }, ms);
      });
    }

    start() {
      this.chunks = [];
      this.frames = 0;
      this.recording = true;
      if (this._node && this._node.port) this._node.port.postMessage("start");
    }

    /**
     * Stops and builds the final file at the task's exact settings.
     * @returns {Promise<{blob:Blob, ext:string, durationSec:number, stats:object, verdict:Array, info:object}>}
     */
    async stop() {
      this.recording = false;
      if (this._node && this._node.port) this._node.port.postMessage("stop");
      // let the last in-flight blocks arrive
      await new Promise((r) => setTimeout(r, 120));

      const nch = this.chunks.length ? this.chunks[0].length : 1;
      const raw = Array.from({ length: nch }, () => new Float32Array(this.frames));
      let off = 0;
      for (const block of this.chunks) {
        for (let c = 0; c < nch; c++) raw[c].set(block[c], off);
        off += block[0].length;
      }
      this.chunks = [];

      const wantCh = this.settings.channels === "stereo" ? 2 : 1;
      const mixed = WavEngine.mixChannels(raw, wantCh);
      const rate = this.settings.sampleRate;
      const out = mixed.channels.map((ch) => WavEngine.resample(ch, this.deviceRate, rate));

      // quality is judged on what will actually be delivered
      const monoForStats = out.length === 1 ? out[0] : WavEngine.mixChannels(out, 1).channels[0];
      const stats = WavEngine.analyze(monoForStats, rate);
      const verdict = WavEngine.verdict(stats);

      let blob, ext;
      if (this.settings.format === "mp3") {
        const parts = WavEngine.encodeMp3(out, rate, 128); // throws MP3_ENCODER_MISSING if lamejs didn't load
        blob = new Blob(parts, { type: "audio/mpeg" });
        ext = "mp3";
      } else {
        blob = new Blob([WavEngine.encodeWav(out, rate, this.settings.bitDepth)], { type: "audio/wav" });
        ext = "wav";
      }

      return {
        blob, ext, stats, verdict,
        durationSec: stats.durationSec,
        info: {
          deviceRate: this.deviceRate,
          targetRate: rate,
          deviceBelowTarget: this.deviceRate < rate,
          upmixed: mixed.upmixed,
          sourceChannels: nch,
        },
      };
    }

    async close() {
      this.recording = false;
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (this.ctx && this.ctx.state !== "closed") await this.ctx.close(); } catch (_) {}
      this.stream = null; this.ctx = null; this.analyser = null; this._node = null;
    }
  }

  window.StudioRecorder = StudioRecorder;
})();
