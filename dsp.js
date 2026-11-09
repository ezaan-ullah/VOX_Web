/*
 * Real audio processing in the browser: everything the demo draws comes from the uploaded file.
 * Front-end settings follow the report (Table 5.2): 16 kHz mono, 400-sample Hann window (25 ms),
 * hop 160 (10 ms), 80 mel bands from 50 Hz to 8 kHz, one 6.08-s window of 608 frames.
 */
window.DSP = (() => {
  const SR = 16000, HOP = 160, WIN = 400, NFFT = 512, MELS = 80, FRAMES = 608;

  async function decode(arrayBuffer) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return ctx.decodeAudioData(arrayBuffer);
  }

  // Mono at 16 kHz for the analysed window only; the destination's single channel downmixes (L + R) / 2.
  async function toMono16k(buffer, seconds) {
    const length = Math.ceil(SR * seconds);
    const ctx = new OfflineAudioContext(1, length, SR);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    const out = await ctx.startRendering();
    return out.getChannelData(0);
  }

  // Min/max per column for drawing; channel = -1 mixes all channels.
  function peaks(buffer, columns, channel = -1, seconds = buffer.duration) {
    const chans = channel < 0
      ? Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
      : [buffer.getChannelData(channel)];
    const total = Math.min(buffer.length, Math.round(seconds * buffer.sampleRate));
    const step = total / columns;
    const out = new Float32Array(columns * 2);
    for (let i = 0; i < columns; i++) {
      let lo = 1, hi = -1;
      const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
      for (let s = a; s < b; s += 4) {
        let v = 0;
        for (const ch of chans) v += ch[s];
        v /= chans.length;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[2 * i] = lo; out[2 * i + 1] = hi;
    }
    return out;
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
          const tr = ar * cr - ai * ci, ti = ar * ci + ai * cr;
          re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
          re[i + k] += tr; im[i + k] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
  }

  function melBank() {
    const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
    const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
    const lo = hz2mel(50), hi = hz2mel(8000);
    const pts = Array.from({ length: MELS + 2 }, (_, i) => mel2hz(lo + (hi - lo) * i / (MELS + 1)));
    const bins = NFFT / 2 + 1;
    return Array.from({ length: MELS }, (_, m) => {
      const row = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        const f = k * SR / NFFT;
        const up = (f - pts[m]) / (pts[m + 1] - pts[m]), down = (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1]);
        row[k] = Math.max(0, Math.min(up, down));
      }
      return row;
    });
  }

  // Returns a Float32Array of MELS x FRAMES (row = mel band, low to high), clips shorter than 6.08 s are zero-padded.
  function logMel(mono) {
    const bank = melBank(), hann = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN));
    const out = new Float32Array(MELS * FRAMES), re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    const power = new Float32Array(NFFT / 2 + 1);
    for (let t = 0; t < FRAMES; t++) {
      re.fill(0); im.fill(0);
      const start = t * HOP - WIN / 2;
      for (let i = 0; i < WIN; i++) {
        const s = start + i;
        re[i] = s >= 0 && s < mono.length ? mono[s] * hann[i] : 0;
      }
      fft(re, im);
      for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      for (let m = 0; m < MELS; m++) {
        let acc = 0;
        const row = bank[m];
        for (let k = 0; k < power.length; k++) acc += row[k] * power[k];
        out[m * FRAMES + t] = Math.log(acc + 1e-6);
      }
    }
    return out;
  }

  const STOPS = ["#FFFFFF", "#EBD9D2", "#C9A39B", "#9A5A50", "#6E1D1D", "#2A1F1D"].map((h) =>
    [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

  function colour(v) {
    const x = Math.min(0.9999, Math.max(0, v)) * (STOPS.length - 1), i = Math.floor(x), f = x - i;
    return STOPS[i].map((c, j) => Math.round(c + (STOPS[i + 1][j] - c) * f));
  }

  function percentile(arr, p) {
    const s = Float32Array.from(arr).sort();
    return s[Math.floor((s.length - 1) * p)];
  }

  // Paints the spectrogram into an offscreen canvas of FRAMES x MELS pixels (low bands at the bottom).
  function melImage(mel) {
    const lo = percentile(mel, 0.03), hi = percentile(mel, 0.997);
    const c = document.createElement("canvas");
    c.width = FRAMES; c.height = MELS;
    const img = c.getContext("2d").createImageData(FRAMES, MELS);
    for (let m = 0; m < MELS; m++) {
      for (let t = 0; t < FRAMES; t++) {
        const [r, g, b] = colour((mel[m * FRAMES + t] - lo) / (hi - lo));
        const p = ((MELS - 1 - m) * FRAMES + t) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
      }
    }
    c.getContext("2d").putImageData(img, 0, 0);
    return c;
  }

  return { SR, MELS, FRAMES, decode, toMono16k, peaks, logMel, melImage, colour };
})();
