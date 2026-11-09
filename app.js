(() => {
  const D = window.DEMO, DSP = window.DSP;
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const speed = Math.min(4, Math.max(0.25, Number(params.get("speed")) || 1));
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>';

  const state = { task: "genre", model: "further", clip: null, running: false, runId: 0 };
  const el = {
    form: $("#demo-form"), taskGrid: $("#task-grid"), modelList: $("#model-list"), run: $("#run-button"),
    dropzone: $("#dropzone"), fileInput: $("#file-input"), fileCard: $("#file-card"), error: $("#audio-error"),
    note: $("#audio-note"), player: $("#player"), play: $("#play-button"), seek: $("#seek"), playhead: $("#playhead"),
    wave: $("#wave-canvas"), stage: $("#stage"), steps: $("#steps"), status: $("#run-status"),
    output: $("#output"), announcer: $("#announcer"),
  };

  // ---------- helpers ----------
  const ms = (x) => x / speed;
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const fmtSize = (b) => `${(b / 1048576).toFixed(1)} MB`;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

  function sleep(t, id) {
    return new Promise((resolve, reject) => setTimeout(() => (id === state.runId ? resolve() : reject(new Error("cancelled"))), t));
  }

  function animate(node, keyframes, options) {
    if (reducedMotion.matches) {
      // Gentler variant: keep the opacity change, drop movement, keep it short.
      const fades = keyframes.map((k) => ("opacity" in k ? { opacity: k.opacity } : {}));
      const hasOpacity = fades.some((k) => "opacity" in k);
      const frames = hasOpacity ? fades : [keyframes[keyframes.length - 1]];
      return node.animate(frames, { ...options, duration: Math.min(200, options.duration), delay: 0, fill: "forwards" });
    }
    return node.animate(keyframes, { fill: "forwards", ...options });
  }

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  }

  // Bars of min/max peaks; columns before `split` (0..1) use colourA, the rest colourB.
  function drawWave(canvas, buffer, { channel = -1, seconds = buffer.duration, colourA = "#6E1D1D", colourB = colourA, split = 1, bar = 3, gap = 1 } = {}) {
    const { ctx, w, h, dpr } = fitCanvas(canvas);
    const step = (bar + gap) * dpr, cols = Math.floor(w / step);
    const pk = DSP.peaks(buffer, cols, channel, seconds);
    let max = 0.001;
    for (let i = 0; i < pk.length; i++) max = Math.max(max, Math.abs(pk[i]));
    for (let i = 0; i < cols; i++) {
      const lo = pk[2 * i] / max, hi = pk[2 * i + 1] / max;
      const top = h / 2 - Math.max(hi, 0.02) * (h / 2 - 2), bottom = h / 2 - Math.min(lo, -0.02) * (h / 2 - 2);
      ctx.fillStyle = i / cols < split ? colourA : colourB;
      ctx.beginPath();
      ctx.roundRect(i * step, top, bar * dpr, bottom - top, (bar * dpr) / 2);
      ctx.fill();
    }
  }

  function announce(text) { el.announcer.textContent = text; }

  function setStatus(html) { el.status.innerHTML = html; }

  // ---------- choices ----------
  function buildChoices() {
    for (const [key, t] of Object.entries(D.tasks)) {
      const input = Object.assign(document.createElement("input"), { type: "radio", name: "task", value: key, id: `task-${key}`, className: "sr-input", checked: key === state.task });
      const label = document.createElement("label");
      label.className = "task-card";
      label.htmlFor = input.id;
      label.innerHTML = '<span class="task-name"></span><span class="task-detail"></span><span class="task-check" aria-hidden="true">' + CHECK_SVG + "</span>";
      label.querySelector(".task-name").textContent = t.name;
      label.querySelector(".task-detail").textContent = `${t.dataset}, ${t.size}`;
      el.taskGrid.append(input, label);
    }
    for (const [key, m] of Object.entries(D.models)) {
      const label = document.createElement("label");
      label.className = "model-option";
      label.innerHTML = '<input type="radio" name="model"><span><span class="model-name"></span><span class="model-detail"></span></span>';
      const input = label.querySelector("input");
      Object.assign(input, { value: key, id: `model-${key}`, checked: key === state.model });
      label.htmlFor = input.id;
      label.querySelector(".model-name").textContent = m.name;
      label.querySelector(".model-detail").textContent = m.detail;
      el.modelList.append(label);
    }
    el.form.addEventListener("change", (e) => {
      if (e.target.name === "task") state.task = e.target.value;
      else if (e.target.name === "model") state.model = e.target.value;
      else return;
      if (!state.running) resetRun();
    });
  }

  function buildSteps() {
    el.steps.innerHTML = "";
    D.steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.dataset.state = "waiting";
      li.innerHTML = `<span class="step-dot"><span>${i + 1}</span>${CHECK_SVG}</span><span><span class="step-name"></span><span class="step-time"></span></span>`;
      li.querySelector(".step-name").textContent = s.name;
      li.querySelector(".step-time").textContent = s.measured;
      el.steps.append(li);
    });
  }

  // ---------- file input ----------
  function sniffFormat(bytes) {
    const txt = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
    if (txt(0, 4) === "RIFF" && txt(8, 4) === "WAVE") {
      for (let o = 12; o + 8 < bytes.length;) {
        const size = bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24);
        if (txt(o, 4) === "fmt ") {
          return { kind: "WAV", channels: bytes[o + 10] | (bytes[o + 11] << 8),
                   rate: (bytes[o + 12] | (bytes[o + 13] << 8) | (bytes[o + 14] << 16) | (bytes[o + 15] << 24)) >>> 0 };
        }
        o += 8 + size + (size & 1);
      }
      return { kind: "WAV" };
    }
    let o = 0;
    if (txt(0, 3) === "ID3") o = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    for (; o + 4 < bytes.length; o++) {
      if (bytes[o] === 0xff && (bytes[o + 1] & 0xe0) === 0xe0) {
        const version = (bytes[o + 1] >> 3) & 3, rateIdx = (bytes[o + 2] >> 2) & 3;
        const table = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[version];
        if (!table || rateIdx === 3) continue;
        return { kind: "MP3", rate: table[rateIdx], channels: ((bytes[o + 3] >> 6) & 3) === 3 ? 1 : 2 };
      }
    }
    return { kind: "MP3" };
  }

  function showError(text) {
    el.error.textContent = text;
  }

  async function acceptFile(file) {
    if (!file || state.running) return;
    el.error.textContent = ""; el.note.textContent = "";
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["wav", "mp3"].includes(ext)) return showError("Unsupported file format. Please use WAV or MP3.");
    if (file.size > D.maxBytes) return showError("File too large (maximum 10 MB).");
    let buffer, format;
    try {
      const bytes = await file.arrayBuffer();
      format = sniffFormat(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1 << 16)));
      buffer = await DSP.decode(bytes);
    } catch {
      return showError("The file could not be read.");
    }
    const mono = await DSP.toMono16k(buffer, D.windowSeconds);
    const mel = DSP.logMel(mono);
    if (state.clip) URL.revokeObjectURL(state.clip.url);
    state.clip = {
      name: file.name, ext: format.kind || ext.toUpperCase(), bytes: file.size, duration: buffer.duration, buffer,
      channels: format.channels || buffer.numberOfChannels, rate: format.rate || buffer.sampleRate,
      mel, melImage: DSP.melImage(mel), url: URL.createObjectURL(file),
    };
    showFileCard();
    if (buffer.duration > 6.05) el.note.textContent = "Only the first 6 s will be analyzed.";
    resetRun();
  }

  function showFileCard() {
    const c = state.clip;
    el.dropzone.hidden = true;
    el.fileCard.hidden = false;
    $("#file-name").textContent = c.name;
    $("#file-meta").textContent = `${c.ext}, ${fmtSize(c.bytes)}, ${fmtTime(c.duration)}, ${(c.rate / 1000).toFixed(1)} kHz ${c.channels > 1 ? "stereo" : "mono"}`;
    const credit = D.credits[c.name];
    $("#credit").hidden = !credit;
    $("#credit").textContent = credit || "";
    el.player.src = c.url;
    $("#time-total").textContent = fmtTime(c.duration);
    $("#time-now").textContent = "0:00";
    el.seek.value = 0;
    el.play.dataset.playing = "false";
    el.play.setAttribute("aria-label", "Play");
    requestAnimationFrame(() => { drawFileWave(); movePlayhead(0); });
  }

  function drawFileWave() {
    if (!state.clip) return;
    drawWave(el.wave, state.clip.buffer, { colourA: "#6E1D1D", colourB: "#CDBFBA", split: D.windowSeconds / state.clip.duration });
  }

  function movePlayhead(t) {
    const c = state.clip;
    if (!c) return;
    const x = (t / c.duration) * el.wave.clientWidth;
    el.playhead.style.transform = `translateX(${x - 1}px)`;
    el.seek.value = Math.round((t / c.duration) * 1000);
    el.seek.setAttribute("aria-valuetext", `${fmtTime(t)} of ${fmtTime(c.duration)}`);
    $("#time-now").textContent = fmtTime(t);
  }

  function bindPlayer() {
    let raf = 0;
    const tick = () => { movePlayhead(el.player.currentTime); raf = requestAnimationFrame(tick); };
    el.play.addEventListener("click", () => (el.player.paused ? el.player.play() : el.player.pause()));
    el.player.addEventListener("play", () => {
      el.play.dataset.playing = "true"; el.play.setAttribute("aria-label", "Pause"); raf = requestAnimationFrame(tick);
    });
    el.player.addEventListener("pause", () => {
      el.play.dataset.playing = "false"; el.play.setAttribute("aria-label", "Play"); cancelAnimationFrame(raf);
      movePlayhead(el.player.currentTime);
    });
    el.player.addEventListener("ended", () => movePlayhead(0));
    el.seek.addEventListener("input", () => {
      if (!state.clip) return;
      el.player.currentTime = (el.seek.value / 1000) * state.clip.duration;
      movePlayhead(el.player.currentTime);
    });
  }

  function bindDrop() {
    for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());
    el.dropzone.addEventListener("dragenter", () => el.dropzone.classList.add("is-over"));
    el.dropzone.addEventListener("dragover", () => el.dropzone.classList.add("is-over"));
    el.dropzone.addEventListener("dragleave", (e) => { if (!el.dropzone.contains(e.relatedTarget)) el.dropzone.classList.remove("is-over"); });
    el.dropzone.addEventListener("drop", (e) => { el.dropzone.classList.remove("is-over"); acceptFile(e.dataTransfer.files[0]); });
    el.fileInput.addEventListener("change", () => { acceptFile(el.fileInput.files[0]); el.fileInput.value = ""; });
    $("#replace-file").addEventListener("click", () => el.fileInput.click());
  }

  // ---------- pipeline scenes ----------
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const scenes = {
    async check(dur, id) {
      const c = state.clip;
      $("#token-name").textContent = c.name;
      $("#token-meta").textContent = `${c.ext}, ${fmtSize(c.bytes)}`;
      const checks = [`${c.ext} file`, `${fmtSize(c.bytes)}, under 10 MB`, "Decodes without errors"];
      const list = $("#checks");
      list.innerHTML = "";
      for (const text of checks) {
        const li = document.createElement("li");
        li.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></svg><span></span>';
        li.querySelector("span").textContent = text;
        list.append(li);
      }
      el.stage.dataset.scene = "check";
      [...list.children].forEach((li, i) =>
        animate(li, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
                { duration: 260, delay: ms(180 + i * 200), easing: EASE_OUT }));
      await sleep(dur, id);
    },

    async decode(dur, id) {
      const c = state.clip, stereo = c.buffer.numberOfChannels > 1 && c.channels > 1;
      $("#rate-from").textContent = `${(c.rate / 1000).toFixed(1)} kHz ${stereo ? "stereo" : "mono"}`;
      const left = $(".lane-left"), right = $(".lane-right"), mono = $(".lane-mono");
      left.querySelector(".lane-label").textContent = stereo ? "Left" : "Mono";
      right.hidden = !stereo;
      for (const lane of [left, right, mono]) lane.getAnimations().forEach((a) => a.cancel());
      el.stage.dataset.scene = "decode";
      drawWave($("#lane-left"), c.buffer, { channel: 0, colourA: "#B08A82" });
      if (stereo) drawWave($("#lane-right"), c.buffer, { channel: 1, colourA: "#B08A82" });
      drawWave($("#lane-mono"), c.buffer, { colourA: "#6E1D1D" });
      const t0 = ms(520), move = ms(700);
      animate(left, [{ transform: "none", opacity: 1 }, { transform: "translateY(54px)", opacity: 0 }], { duration: move, delay: t0, easing: EASE_IN_OUT });
      if (stereo) animate(right, [{ transform: "none", opacity: 1 }, { transform: "translateY(-54px)", opacity: 0 }], { duration: move, delay: t0, easing: EASE_IN_OUT });
      animate(mono, [{ opacity: 0 }, { opacity: 1 }], { duration: ms(420), delay: t0 + move * 0.55, easing: EASE_OUT });
      await sleep(dur, id);
    },

    async window(dur, id) {
      const c = state.clip, frac = Math.min(1, D.windowSeconds / c.duration);
      const full = $("#window-full"), detail = $("#window-detail"), box = $("#window-box");
      for (const n of [full, detail, box]) n.getAnimations().forEach((a) => a.cancel());
      $("#window-caption").textContent = c.duration > D.windowSeconds
        ? `Keeps the first 6.08 s of ${fmtTime(c.duration)}`
        : `Pads the ${c.duration.toFixed(1)}-s clip to one 6.08-s window`;
      el.stage.dataset.scene = "window";
      drawWave(full, c.buffer, { colourA: "#6E1D1D", colourB: "#CDBFBA", split: frac, bar: 2, gap: 1 });
      drawWave(detail, c.buffer, { seconds: Math.min(c.duration, D.windowSeconds), colourA: "#6E1D1D", bar: 3, gap: 1 });
      const narrow = `inset(0 ${(1 - frac) * 100}% 0 0 round 6px)`;
      animate(box, [{ clipPath: "inset(0 100% 0 0 round 6px)" }, { clipPath: narrow }], { duration: ms(380), delay: ms(250), easing: EASE_OUT });
      const t1 = ms(900), grow = ms(760);
      animate(box, [{ clipPath: narrow, opacity: 1 }, { clipPath: "inset(0 0 0 0 round 6px)", opacity: 1 }, { clipPath: "inset(0 0 0 0 round 6px)", opacity: 0 }],
              { duration: grow * 1.35, delay: t1, easing: EASE_IN_OUT, composite: "replace" });
      animate(full, [{ opacity: 1 }, { opacity: 0 }], { duration: grow * 0.6, delay: t1 + grow * 0.2, easing: EASE_OUT });
      animate(detail, [{ opacity: 0 }, { opacity: 1 }], { duration: grow * 0.7, delay: t1 + grow * 0.35, easing: EASE_OUT });
      await sleep(dur, id);
    },

    async logmel(dur, id) {
      const c = state.clip, canvas = $("#mel-canvas"), scan = $("#scan-line"), frame = $("#mel-frame"), grid = $("#patch-grid");
      for (const n of [canvas, scan, frame, grid]) n.getAnimations().forEach((a) => a.cancel());
      $("#mel-caption").textContent = "608 frames of 10 ms";
      el.stage.dataset.scene = "mel";
      const { ctx, w, h } = fitCanvas(canvas);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(c.melImage, 0, 0, w, h);
      const draw = dur * 0.78;
      animate(canvas, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: draw, delay: ms(120), easing: "linear" });
      animate(scan, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${canvas.clientWidth - 2}px)`, opacity: 1 }],
              { duration: draw, delay: ms(120), easing: "linear" });
      await sleep(draw + ms(140), id);
      animate(scan, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE_OUT });
      await sleep(Math.max(0, dur - draw - ms(140)), id);
    },

    async encoder(dur, id) {
      const grid = $("#patch-grid"), frame = $("#mel-frame");
      if (!grid.children.length) for (let i = 0; i < 190; i++) grid.append(document.createElement("span"));
      $("#mel-caption").textContent = "Cut into 190 patches of 16 × 16";
      animate(grid, [{ opacity: 0 }, { opacity: 1 }], { duration: ms(300), easing: EASE_OUT });
      const cells = [...grid.children], sweep = dur * 0.42, perCol = sweep / 38;
      cells.forEach((cell, i) => {
        const col = i % 38;
        animate(cell, [{ backgroundColor: "rgb(255 255 255 / 0)" }, { backgroundColor: "rgb(255 255 255 / 0.55)" }, { backgroundColor: "rgb(255 255 255 / 0.12)" }],
                { duration: ms(420), delay: ms(350) + col * perCol, easing: "ease" });
      });
      await sleep(ms(350) + sweep + ms(250), id);
      drawEmbedding();
      $("#embed-caption").textContent = "One clip embedding of 3,840 values";
      $("#probe-row").getAnimations().forEach((a) => a.cancel());
      $("#probe-row").style.opacity = "0";
      animate(frame, [{ transform: "none", opacity: 1 }, { transform: "scaleY(0.2)", opacity: 0 }], { duration: ms(480), easing: EASE_IN_OUT });
      await sleep(ms(300), id);
      el.stage.dataset.scene = "embed";
      animate($("#embed-canvas"), [{ opacity: 0, transform: "scaleY(2.2)" }, { opacity: 1, transform: "none" }], { duration: ms(520), easing: EASE_OUT });
      await sleep(Math.max(0, dur - ms(350) - sweep - ms(550)), id);
    },

    async probe(dur, id) {
      const t = D.tasks[state.task];
      $("#probe-sub").textContent = `${t.name}, ${t.probeLabel}`;
      $("#embed-caption").textContent = `Scores for all ${t.classes} classes`;
      drawProbeScores();
      const row = $("#probe-row"), canvas = $("#probe-canvas");
      row.style.opacity = "";
      animate(row, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: ms(360), easing: EASE_OUT });
      animate(canvas, [{ clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: ms(520), delay: ms(260), easing: EASE_OUT });
      await sleep(dur, id);
    },
  };

  function drawEmbedding() {
    const c = state.clip, canvas = $("#embed-canvas");
    const { ctx, w, h } = fitCanvas(canvas);
    // Five frequency positions x 768 dimensions; the strip is seeded by the clip's own spectrogram.
    let seed = 0;
    for (let i = 0; i < c.mel.length; i += 97) seed = (seed * 31 + Math.round(c.mel[i] * 100)) | 0;
    const rand = mulberry32(seed), n = 3840, img = document.createElement("canvas");
    img.width = n; img.height = 1;
    const ictx = img.getContext("2d"), data = ictx.createImageData(n, 1);
    for (let i = 0; i < n; i++) {
      const band = Math.floor(i / 768), g = (rand() + rand() + rand() - 1.5) / 1.5;
      const [r, gg, b] = DSP.colour(0.5 + 0.42 * g - band * 0.03);
      data.data.set([r, gg, b, 255], i * 4);
    }
    ictx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);
  }

  function drawProbeScores() {
    const t = D.tasks[state.task], top = t.scores[state.model], canvas = $("#probe-canvas");
    const { ctx, w, h, dpr } = fitCanvas(canvas);
    const rand = mulberry32(t.classes * 7 + state.model.length);
    const values = Array.from({ length: t.classes }, () => rand() * 0.05);
    const topIdx = top.map((_, i) => Math.floor((i * 0.37 + 0.11) * t.classes) % t.classes);
    top.forEach(([, v], i) => { values[topIdx[i]] = v; });
    const max = Math.max(...values), gap = Math.max(1, Math.round(dpr)), bw = (w - gap * (t.classes - 1)) / t.classes;
    values.forEach((v, i) => {
      const bh = Math.max(2 * dpr, (v / max) * (h - 4 * dpr));
      ctx.fillStyle = i === topIdx[0] ? "#6E1D1D" : "#B08A82";
      ctx.beginPath();
      ctx.roundRect(i * (bw + gap), h - bh, Math.max(1, bw), bh, [Math.min(4 * dpr, bw / 2), Math.min(4 * dpr, bw / 2), 0, 0]);
      ctx.fill();
    });
  }

  // ---------- output ----------
  function barRow(label, value, isTop, extraCells = []) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = label;
    tr.append(th);
    for (const text of extraCells) {
      const td = document.createElement("td");
      td.className = "cell-text";
      td.textContent = text;
      tr.append(td);
    }
    const td = document.createElement("td");
    td.innerHTML = '<div class="bar-line"><div class="bar-track"><div class="bar"></div></div><span class="bar-value"></span></div>';
    const bar = td.querySelector(".bar");
    bar.style.width = `${Math.max(0.5, value * 100)}%`;
    bar.classList.toggle("is-top", isTop);
    td.querySelector(".bar-value").textContent = pct(value);
    tr.append(td);
    return tr;
  }

  function table(caption, headers) {
    const t = document.createElement("table");
    t.className = "bars";
    t.innerHTML = '<caption class="visually-hidden"></caption><thead class="visually-hidden"><tr></tr></thead><tbody></tbody>';
    t.querySelector("caption").textContent = caption;
    for (const h of headers) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = h;
      t.querySelector("thead tr").append(th);
    }
    return t;
  }

  function renderOutput() {
    const t = D.tasks[state.task], m = D.models[state.model], c = state.clip, scores = t.scores[state.model];
    const body = $("#output-body");
    body.innerHTML = "";
    $("#output-title").textContent = state.task === "tagging" ? "Tags above the 0.5 threshold" : t.title;

    if (state.task === "tagging") {
      const chips = document.createElement("ul");
      chips.className = "chips";
      for (const [tag, v] of scores) if (v >= t.threshold) chips.append(Object.assign(document.createElement("li"), { textContent: tag }));
      const sub = Object.assign(document.createElement("p"), { className: "output-sub", textContent: `${t.title}; the dashed line marks the 0.5 threshold` });
      const tbl = table(t.title, ["Tag", "Probability"]);
      scores.forEach(([tag, v]) => {
        const row = barRow(tag, v, v >= t.threshold);
        row.querySelector(".bar-track").append(Object.assign(document.createElement("div"), { className: "threshold" }));
        tbl.tBodies[0].append(row);
      });
      body.append(chips, sub, tbl);
    } else if (state.task === "pitch") {
      const tbl = table(t.title, ["Note", "MIDI number", "Frequency", "Probability"]);
      scores.forEach(([midi, v], i) => tbl.tBodies[0].append(barRow(noteName(midi), v, i === 0, [`MIDI ${midi}`, `${midiHz(midi).toFixed(1)} Hz`])));
      body.append(tbl);
    } else {
      const tbl = table(t.title, [t.name, "Probability"]);
      scores.forEach(([label, v], i) => tbl.tBodies[0].append(barRow(label, v, i === 0)));
      body.append(tbl);
    }
    if (t.note) body.append(Object.assign(document.createElement("p"), { className: "output-note", textContent: t.note }));

    const meta = $("#output-meta");
    meta.innerHTML = "";
    const rows = [
      ["Input", c.name],
      ["Analyzed", c.duration > D.windowSeconds ? `First 6.0 s of ${fmtTime(c.duration)}` : `${c.duration.toFixed(1)} s, padded to 6.08 s`],
      ["Model", m.name],
      ["Device", D.device],
      ["Inference time", m.inference],
      ["Upload", "Deleted after the prediction"],
    ];
    for (const [k, v] of rows) meta.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));

    el.output.hidden = false;
    animate(el.output, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE_OUT });
    body.querySelectorAll(".bar").forEach((bar, i) =>
      animate(bar, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: ms(620), delay: ms(120 + i * 60), easing: EASE_OUT }));

    const first = scores[0];
    const headline = state.task === "pitch" ? `${noteName(first[0])}, ${pct(first[1])}` : `${first[0]}, ${pct(first[1])}`;
    announce(`Prediction ready. ${t.title}: ${headline}.`);
  }

  // ---------- run / reset ----------
  function setStep(i, s) { el.steps.children[i].dataset.state = s; }

  function lock(on) {
    el.form.querySelectorAll('input[type="radio"]').forEach((r) => { r.disabled = on; });
    el.run.setAttribute("aria-busy", String(on));
    el.run.textContent = on ? "Running…" : "Run prediction";
  }

  function resetRun() {
    state.runId++;
    state.running = false;
    document.getAnimations().forEach((a) => { if (el.stage.contains(a.effect?.target) || el.output.contains(a.effect?.target)) a.cancel(); });
    el.stage.dataset.scene = "idle";
    [...el.steps.children].forEach((li) => { li.dataset.state = "waiting"; });
    el.output.hidden = true;
    lock(false);
    const model = D.models[state.model].name;
    setStatus(state.clip ? `Ready to run with the <strong>${model[0].toLowerCase() + model.slice(1)}</strong>` : "Waiting for a clip");
  }

  async function run(e) {
    e.preventDefault();
    if (state.running) return;
    if (!state.clip) {
      showError("Add a WAV or MP3 clip first.");
      el.fileInput.focus();
      return;
    }
    el.player.pause();
    resetRun();
    const id = state.runId;
    state.running = true;
    lock(true);
    try {
      for (let i = 0; i < D.steps.length; i++) {
        const s = D.steps[i];
        setStep(i, "active");
        setStatus(`Step ${i + 1} of ${D.steps.length}: <strong>${s.name}</strong><small>Slowed down so each step can be followed</small>`);
        await scenes[s.id](ms(s.shown), id);
        setStep(i, "done");
      }
    } catch {
      return; // reset while running
    }
    state.running = false;
    lock(false);
    setStatus(`Done in <strong>${D.models[state.model].inference}</strong> on the GPU`);
    renderOutput();
  }

  function fullReset() {
    el.player.pause();
    el.player.removeAttribute("src");
    if (state.clip) URL.revokeObjectURL(state.clip.url);
    state.clip = null;
    el.fileCard.hidden = true;
    el.dropzone.hidden = false;
    el.error.textContent = "";
    el.note.textContent = "";
    resetRun();
  }

  // ---------- init ----------
  buildChoices();
  buildSteps();
  bindDrop();
  bindPlayer();
  el.form.addEventListener("submit", run);
  document.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) fullReset();
  });
  window.addEventListener("resize", () => { drawFileWave(); if (state.clip) movePlayhead(el.player.currentTime); });
  resetRun();
})();
