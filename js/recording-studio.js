/**
 * Nativoya Recording Studio
 * Main logic for voice recording with professional controls
 * Inspired by mSpeech with web audio API
 */

class RecordingStudio {
  constructor(options = {}) {
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.analyser = null;
    this.waveform = null;

    // Recording state
    this.isRecording = false;
    this.isPaused = false;
    this.recordings = []; // Array of {filename, blob, duration, base64}
    this.currentRecording = null;
    this.sessionId = null;
    this.claimId = null;
    this.taskId = null;

    // Recording settings
    this.settings = {
      sampleRate: 44100,
      channels: 1,
      audioFormat: "wav",
      bitDepth: 16,
    };

    // UI References
    this.elements = {
      recordBtn: document.getElementById("recordBtn"),
      pauseBtn: document.getElementById("pauseBtn"),
      stopBtn: document.getElementById("stopBtn"),
      playbackBtn: document.getElementById("playbackBtn"),
      deleteBtn: document.getElementById("deleteBtn"),
      noiseTestBtn: document.getElementById("noiseTestBtn"),
      submitBtn: document.getElementById("submitBtn"),

      timerDisplay: document.getElementById("timerDisplay"),
      recordingsList: document.getElementById("recordingsList"),
      volumeLevel: document.getElementById("volumeLevel"),
      scriptDisplay: document.getElementById("scriptDisplay"),
      waveformCanvas: document.getElementById("waveformCanvas"),

      settingsPanel: document.getElementById("settingsPanel"),
      sampleRateSelect: document.getElementById("sampleRateSelect"),
      audioFormatSelect: document.getElementById("audioFormatSelect"),
    };

    this.initializeEventListeners();
  }

  async initialize(params) {
    const { sessionId, claimId, taskId, recordingSettings, scriptUrl } = params;

    this.sessionId = sessionId;
    this.claimId = claimId;
    this.taskId = taskId;

    // Load recording settings from task
    if (recordingSettings) {
      this.settings = { ...this.settings, ...recordingSettings };
    }

    // Update UI with settings
    this.updateSettingsUI();

    // Load and display script
    if (scriptUrl) {
      await this.loadScript(scriptUrl);
    }

    // Initialize audio context
    await this.initializeAudioContext();

    // Load existing session if any
    await this.loadExistingRecordings();
  }

  async initializeAudioContext() {
    if (this.audioContext) return;

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: this.settings.sampleRate,
    });
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    // Initialize waveform visualizer
    if (this.elements.waveformCanvas) {
      this.waveform = new WaveformVisualizer(this.elements.waveformCanvas, {
        fftSize: 2048,
        barColor: "#6B4FBB",
        barColorActive: "#E74C8C",
        backgroundColor: "#F5F5F5",
      });
      this.waveform.setAnalyser(this.analyser);
    }

    // Request microphone access
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: this.settings.sampleRate,
        },
      });

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      source.connect(this.analyser);

      this.setupMediaRecorder();
    } catch (err) {
      console.error("Microphone access denied:", err);
      alert("عذراً، لا يمكن الوصول إلى الميكروفون. يرجى السماح بالوصول.");
    }
  }

  setupMediaRecorder() {
    const mimeType = this.getMimeType();

    this.mediaRecorder = new MediaRecorder(this.mediaStream, {
      mimeType: mimeType,
      audioBitsPerSecond: this.getBitrate(),
    });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.currentRecording.blob = event.data;
        this.processRecording();
      }
    };

    this.mediaRecorder.onstart = () => {
      this.isRecording = true;
      this.waveform?.startVisualizing();
      this.startTimer();
      this.updateButtonStates();
    };

    this.mediaRecorder.onpause = () => {
      this.isPaused = true;
      this.waveform?.stopVisualizing();
      this.updateButtonStates();
    };

    this.mediaRecorder.onresume = () => {
      this.isPaused = false;
      this.waveform?.startVisualizing();
      this.updateButtonStates();
    };

    this.mediaRecorder.onstop = () => {
      this.isRecording = false;
      this.waveform?.stopVisualizing();
      this.stopTimer();
      this.updateButtonStates();
    };
  }

  async processRecording() {
    if (!this.currentRecording) return;

    // Convert blob to base64
    const reader = new FileReader();
    reader.onload = async () => {
      this.currentRecording.base64 = reader.result.split(",")[1];
      this.currentRecording.duration = this.timerSeconds;

      // Upload to server
      await this.uploadRecording(this.currentRecording);

      // Add to recordings list
      this.recordings.push(this.currentRecording);
      this.updateRecordingsList();

      // Reset for next recording
      this.currentRecording = null;
    };
    reader.readAsDataURL(this.currentRecording.blob);
  }

  async uploadRecording(recording) {
    const formData = new FormData();
    formData.append("sessionId", this.sessionId);
    formData.append("audio", recording.blob);
    formData.append("filename", recording.filename);
    formData.append("duration", recording.duration);

    try {
      const response = await fetch("/api/recording/upload-chunk", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      const result = await response.json();
      console.log("Recording uploaded:", result);
    } catch (err) {
      console.error("Upload error:", err);
      alert("خطأ في رفع التسجيل. يرجى المحاولة مرة أخرى.");
    }
  }

  async loadExistingRecordings() {
    try {
      const response = await fetch(`/api/recording/session/${this.sessionId}`);
      if (response.ok) {
        const session = await response.json();
        this.recordings = session.files || [];
        this.updateRecordingsList();
      }
    } catch (err) {
      console.error("Failed to load existing recordings:", err);
    }
  }

  async loadScript(scriptUrl) {
    try {
      const response = await fetch(scriptUrl);
      const text = await response.text();
      if (this.elements.scriptDisplay) {
        this.elements.scriptDisplay.innerHTML = `<p>${text.replace(/\n/g, "<br>")}</p>`;
      }
    } catch (err) {
      console.error("Failed to load script:", err);
    }
  }

  // === Recording Controls ===

  startRecording() {
    if (!this.mediaRecorder) return;

    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const filename = `Recording_${this.recordings.length + 1}_${timestamp}.${this.settings.audioFormat}`;

    this.currentRecording = {
      filename,
      blob: null,
      duration: 0,
      base64: null,
    };

    this.timerSeconds = 0;
    this.mediaRecorder.start();
  }

  pauseRecording() {
    if (this.mediaRecorder && this.isRecording && !this.isPaused) {
      this.mediaRecorder.pause();
    }
  }

  resumeRecording() {
    if (this.mediaRecorder && this.isRecording && this.isPaused) {
      this.mediaRecorder.resume();
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }

  async playbackRecording(index) {
    if (index >= this.recordings.length) return;

    const recording = this.recordings[index];
    const audioBlob = new Blob([Uint8Array.from(atob(recording.base64), (c) => c.charCodeAt(0))], {
      type: `audio/${this.settings.audioFormat}`,
    });

    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.play();

    // Update waveform during playback
    const audioContext = new AudioContext();
    const source = audioContext.createMediaElementAudioSource(audio);
    const analyser = audioContext.createAnalyser();
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    this.waveform?.setAnalyser(analyser);
    this.waveform?.startVisualizing();

    audio.onended = () => {
      this.waveform?.stopVisualizing();
    };
  }

  async deleteRecording(index) {
    if (index >= this.recordings.length) return;

    const recording = this.recordings[index];
    try {
      const response = await fetch("/api/recording/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          filename: recording.filename,
        }),
      });

      if (response.ok) {
        this.recordings.splice(index, 1);
        this.updateRecordingsList();
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }

  async runNoiseTest() {
    if (!this.mediaStream) return;

    const testDuration = 3000; // 3 seconds
    alert("سيتم اختبار الضوضاء المحيطة لمدة 3 ثوان. يرجى الصمت...");

    this.mediaRecorder.start();
    this.waveform?.startVisualizing();

    setTimeout(() => {
      this.mediaRecorder.stop();
      this.waveform?.stopVisualizing();

      // Analyze noise level
      const frequencies = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(frequencies);
      const average = frequencies.reduce((a, b) => a + b) / frequencies.length;

      let noiseLevel = "منخفضة";
      if (average > 100) noiseLevel = "متوسطة";
      if (average > 150) noiseLevel = "مرتفعة";

      alert(`مستوى الضوضاء: ${noiseLevel}\nالمتوسط: ${Math.round(average)}`);
    }, testDuration);
  }

  async submitRecordings() {
    if (this.recordings.length === 0) {
      alert("لم تقم برفع أي تسجيلات. يرجى تسجيل أقل تسجيل واحد.");
      return;
    }

    try {
      const response = await fetch("/api/recording/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          claimId: this.claimId,
        }),
      });

      if (!response.ok) {
        throw new Error("Finalize failed");
      }

      const result = await response.json();
      alert("تم رفع التسجيلات بنجاح! جاري إرسالها للمراجعة.");
      window.location.href = "/pages/tasks.html";
    } catch (err) {
      console.error("Submit error:", err);
      alert("خطأ في إرسال التسجيلات. يرجى المحاولة مرة أخرى.");
    }
  }

  // === UI Updates ===

  updateRecordingsList() {
    if (!this.elements.recordingsList) return;

    this.elements.recordingsList.innerHTML = `
      <div class="recordings-header">
        <h3>التسجيلات (${this.recordings.length})</h3>
      </div>
      ${this.recordings
        .map(
          (rec, idx) => `
        <div class="recording-item">
          <div class="recording-info">
            <span class="recording-name">${rec.filename}</span>
            <span class="recording-duration">${this.formatDuration(rec.duration)}</span>
          </div>
          <div class="recording-actions">
            <button class="btn-icon" onclick="recordingStudio.playbackRecording(${idx})" title="تشغيل">
              ▶️
            </button>
            <button class="btn-icon" onclick="recordingStudio.deleteRecording(${idx})" title="حذف">
              🗑️
            </button>
          </div>
        </div>
      `
        )
        .join("")}
    `;
  }

  updateButtonStates() {
    if (!this.elements.recordBtn) return;

    const isRecording = this.isRecording;
    const isPaused = this.isPaused;

    this.elements.recordBtn.disabled = isRecording;
    this.elements.recordBtn.classList.toggle("disabled", isRecording);

    this.elements.pauseBtn.disabled = !isRecording || isPaused;
    this.elements.pauseBtn.classList.toggle("disabled", !isRecording || isPaused);

    this.elements.stopBtn.disabled = !isRecording;
    this.elements.stopBtn.classList.toggle("disabled", !isRecording);
  }

  updateSettingsUI() {
    if (this.elements.sampleRateSelect) {
      this.elements.sampleRateSelect.value = this.settings.sampleRate;
    }
    if (this.elements.audioFormatSelect) {
      this.elements.audioFormatSelect.value = this.settings.audioFormat;
    }
  }

  // === Timer & Duration ===

  timerInterval = null;
  timerSeconds = 0;

  startTimer() {
    this.timerSeconds = 0;
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      this.updateTimerDisplay();
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    this.updateTimerDisplay();
  }

  updateTimerDisplay() {
    if (!this.elements.timerDisplay) return;
    const minutes = Math.floor(this.timerSeconds / 60);
    const seconds = this.timerSeconds % 60;
    this.elements.timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  formatDuration(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  }

  // === Audio Settings ===

  getMimeType() {
    const format = this.settings.audioFormat.toLowerCase();
    const types = {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      webm: "audio/webm",
    };
    return types[format] || "audio/wav";
  }

  getBitrate() {
    return this.settings.bitDepth === 16 ? 128000 : 256000;
  }

  // === Event Listeners ===

  initializeEventListeners() {
    if (this.elements.recordBtn) {
      this.elements.recordBtn.addEventListener("click", () => this.startRecording());
    }
    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.addEventListener("click", () => {
        if (this.isPaused) {
          this.resumeRecording();
        } else {
          this.pauseRecording();
        }
      });
    }
    if (this.elements.stopBtn) {
      this.elements.stopBtn.addEventListener("click", () => this.stopRecording());
    }
    if (this.elements.noiseTestBtn) {
      this.elements.noiseTestBtn.addEventListener("click", () => this.runNoiseTest());
    }
    if (this.elements.submitBtn) {
      this.elements.submitBtn.addEventListener("click", () => this.submitRecordings());
    }

    // Resize waveform on window resize
    window.addEventListener("resize", () => {
      this.waveform?.resize();
    });
  }
}

// Global instance
let recordingStudio = null;

// Export for use
if (typeof module !== "undefined" && module.exports) {
  module.exports = RecordingStudio;
}
