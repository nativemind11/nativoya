/**
 * Waveform Visualizer - renders audio waveforms in real-time
 * Inspired by mSpeech and professional audio editors
 */

class WaveformVisualizer {
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext("2d");
    this.analyser = null;
    this.dataArray = null;
    this.animationId = null;

    // Configuration
    this.fftSize = options.fftSize || 2048;
    this.barWidth = options.barWidth || 3;
    this.barGap = options.barGap || 1;
    this.barColor = options.barColor || "#6B4FBB"; // Nativoya purple
    this.barColorActive = options.barColorActive || "#00D4FF"; // Cyan for active
    this.backgroundColor = options.backgroundColor || "#F5F5F5";
    this.isRecording = false;

    this.setupCanvas();
  }

  setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;

    this.clear();
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    if (analyser) {
      analyser.fftSize = this.fftSize;
      this.dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  startVisualizing() {
    this.isRecording = true;
    this.animate();
  }

  stopVisualizing() {
    this.isRecording = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());

    if (!this.analyser) {
      this.clear();
      return;
    }

    this.analyser.getByteFrequencyData(this.dataArray);

    this.ctx.fillStyle = this.backgroundColor;
    this.ctx.fillRect(0, 0, this.width, this.height);

    this.drawBars();
  }

  drawBars() {
    const bufferLength = this.dataArray.length;
    const barCount = Math.floor(this.width / (this.barWidth + this.barGap));
    const step = Math.floor(bufferLength / barCount);

    for (let i = 0; i < barCount; i++) {
      const index = i * step;
      const value = this.dataArray[index] / 255;

      const barHeight = value * this.height;
      const x = i * (this.barWidth + this.barGap);
      const y = this.height - barHeight;

      // Draw bar with gradient effect
      const gradient = this.ctx.createLinearGradient(x, y, x, this.height);
      gradient.addColorStop(0, this.isRecording ? this.barColorActive : this.barColor);
      gradient.addColorStop(1, this.isRecording ? this.barColor : this.barColor);

      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(x, y, this.barWidth, barHeight);
    }
  }

  clear() {
    this.ctx.fillStyle = this.backgroundColor;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  // Draw static waveform from audio data
  drawStaticWaveform(audioBuffer) {
    if (!audioBuffer) return;

    this.clear();

    const rawData = audioBuffer;
    const samples = rawData.length;
    const blockSize = Math.floor(samples / this.width);
    const filteredData = [];

    for (let i = 0; i < this.width; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(rawData[i * blockSize + j]);
      }
      filteredData.push(sum / blockSize);
    }

    // Draw the waveform
    this.ctx.lineWidth = 2;
    this.ctx.strokeStyle = this.barColor;
    this.ctx.beginPath();

    const maxValue = Math.max(...filteredData);
    const scaleY = this.height / 2 / (maxValue || 1);

    this.ctx.moveTo(0, this.height / 2);

    for (let i = 0; i < filteredData.length; i++) {
      const x = i;
      const y = this.height / 2 - filteredData[i] * scaleY;
      this.ctx.lineTo(x, y);
    }

    this.ctx.stroke();
  }

  resize() {
    this.setupCanvas();
  }
}

// Export for use in HTML
if (typeof module !== "undefined" && module.exports) {
  module.exports = WaveformVisualizer;
}
