(() => {
  const DSP = window.DSP;
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const speed = Math.min(4, Math.max(0.25, Number(params.get("speed")) || 1));
  const recordMode = params.has("record");           // ?record enables the R key reset used for video takes
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>';
  const MAX_BYTES = 10 * 1024 * 1024, WINDOW_SECONDS = 6.08;

  // How long each step stays on screen (ms, before ?speed=). The times printed beside the steps are measured by the server.
  const STEPS = [
    { id: "check",   name: "Check the file",      shown: 900 },
    { id: "decode",  name: "Decode and resample", shown: 1500 },
    { id: "window",  name: "Keep first 6.08 s",   shown: 1300 },
    { id: "logmel",  name: "Log-mel spectrogram", shown: 1900 },
    { id: "encoder", name: "Frozen M2D encoder",  shown: 2300 },
    { id: "probe",   name: "Linear probe",        shown: 1300 },
  ];

  const api = { tasks: [], models: [], samples: [] };
  const state = { task: null, model: null, clip: null, running: false, runId: 0, response: null };
  const el = {
    form: $("#demo-form"), taskGrid: $("#task-grid"), modelList: $("#model-list"), run: $("#run-button"),
    compare: $("#compare"), dropzone: $("#dropzone"), fileInput: $("#file-input"), fileCard: $("#file-card"),
    error: $("#audio-error"), note: $("#audio-note"), player: $("#player"), play: $("#play-button"), seek: $("#seek"),
    playhead: $("#playhead"), wave: $("#wave-canvas"), stage: $("#stage"), steps: $("#steps"), status: $("#run-status"),
    output: $("#output"), announcer: $("#announcer"), banner: $("#server-banner"),
  };

  // ---------- helpers ----------
  const ms = (x) => x / speed;
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const fmtSize = (b) => `${(b / 1048576).toFixed(1)} MB`;
  const fmtMs = (v) => (v == null ? "" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
  const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
  const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  function sleep(t, id) {
    return new Promise((resolve, reject) => setTimeout(() => (id === state.runId ? resolve() : reject(new Error("cancelled"))), t));
  }

  function animate(node, keyframes, options) {
    if (reducedMotion.matches) {
      const fades = keyframes.map((k) => ("opacity" in k ? { opacity: k.opacity } : {}));
      const frames = fades.some((k) => "opacity" in k) ? fades : [keyframes[keyframes.length - 1]];
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

  const announce = (text) => { el.announcer.textContent = text; };
  const setStatus = (html) => { el.status.innerHTML = html; };
  const showError = (text) => { el.error.textContent = text; };
  const model = (code) => api.models.find((m) => m.code === code);
  const task = (code) => api.tasks.find((t) => t.code === code);

  // ---------- views (Results / Demo / About) ----------
  function showView() {
    const view = ["results", "demo", "about"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "demo";
    for (const v of ["results", "demo", "about"]) $(`#view-${v}`).hidden = v !== view;
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (view === "results") loadResults();
  }

  // ---------- Results tab ----------
  async function loadResults() {
    let data;
    try {
      data = await getJSON(`/api/results?group=${encodeURIComponent($("#group-filter").value)}`);
    } catch {
      $("#results-empty").textContent = "The results could not be loaded from the server.";
      $("#results-empty").hidden = false; $("#results-body").hidden = true;
      return;
    }
    const has = data.models.length > 0;
    $("#results-empty").textContent = "No results have been imported yet. They appear here once the evaluation runs are imported with the developer script.";
    $("#results-empty").hidden = has; $("#results-body").hidden = !has;
    if (!has) return;

    const bars = $("#score-bars");
    bars.innerHTML = "";
    const scored = data.models.filter((m) => m.music_score != null);
    if (!scored.length) bars.append(make("p", { className: "section-sub", textContent: "No model has all four music tasks yet." }));
    const top = Math.max(...scored.map((m) => m.music_score), 1);
    for (const m of scored) {
      const row = make("div", { className: `score-row group-${m.group}` });
      row.append(make("span", { className: "score-name", textContent: m.name }));
      const track = make("div", { className: "bar-track" });
      const bar = make("div", { className: "bar" });
      bar.style.width = `${(m.music_score / top) * 100}%`;
      track.append(bar);
      row.append(track, make("span", { className: "bar-value", textContent: m.music_score.toFixed(1) }));
      bars.append(row);
    }

    const table = $("#results-table");
    table.innerHTML = "";
    const head = make("tr");
    head.append(make("th", { scope: "col", textContent: "Model" }));
    for (const t of data.tasks) head.append(make("th", { scope: "col", textContent: `${t.dataset}${t.code === "pitch" ? " pitch" : t.code === "instrument" ? " instr." : ""} (${t.metric})` }));
    const thead = make("thead");
    thead.append(head);
    const body = make("tbody");
    table.append(thead, body);
    for (const m of data.models) {
      const tr = make("tr", { className: `group-${m.group}` });
      tr.append(make("th", { scope: "row", textContent: m.name }));
      for (const t of data.tasks) {
        const r = m.results[t.code];
        tr.append(make("td", { textContent: r ? `${r.mean.toFixed(1)}${r.std != null ? ` ± ${r.std.toFixed(1)}` : ""}` : "–" }));
      }
      body.append(tr);
    }
    const sep = data.tasks.filter((t) => !t.in_music_score).map((t) => `${t.name}: ${t.note}`);
    $("#results-notes").textContent = sep.join(" ");
  }

  // ---------- choices ----------
  function buildChoices() {
    el.taskGrid.innerHTML = "";
    for (const t of api.tasks) {
      const input = make("input", { type: "radio", name: "task", value: t.code, id: `task-${t.code}`, className: "sr-input", checked: t.code === state.task });
      const label = make("label", { className: "task-card", htmlFor: input.id });
      label.innerHTML = '<span class="task-name"></span><span class="task-detail"></span><span class="task-badge"></span><span class="task-check" aria-hidden="true">' + CHECK_SVG + "</span>";
      label.querySelector(".task-name").textContent = t.name;
      label.querySelector(".task-detail").textContent = `${t.dataset}, ${t.size}`;
      el.taskGrid.append(input, label);
    }
    el.modelList.innerHTML = "";
    for (const m of api.models) {
      const label = make("label", { className: "model-option" });
      label.innerHTML = '<input type="radio" name="model"><span><span class="model-name"></span><span class="model-detail"></span></span>';
      const input = label.querySelector("input");
      Object.assign(input, { value: m.code, id: `model-${m.code}`, checked: m.code === state.model });
      label.htmlFor = input.id;
      label.querySelector(".model-name").textContent = m.name;
      label.querySelector(".model-detail").textContent = m.loaded ? m.detail : `${m.detail} · ${m.reason}`;
      el.modelList.append(label);
    }
    updateBadges();
  }

  function updateBadges() {
    for (const t of api.tasks) {
      const badge = $(`label[for="task-${t.code}"] .task-badge`);
      const ready = t.ready[state.model];
      badge.textContent = ready && !ready.ready && model(state.model)?.loaded ? "No classifier yet" : "";
    }
  }

  function buildSamples() {
    const list = $("#sample-list");
    list.innerHTML = "";
    for (const s of api.samples) {
      const b = make("button", { type: "button", className: "sample-button", textContent: s.title });
      b.addEventListener("click", () => loadSample(s));
      list.append(b);
    }
    $("#samples").hidden = api.samples.length === 0;
  }

  async function loadSample(s) {
    try {
      const blob = await (await fetch(s.url)).blob();
      await acceptFile(new File([blob], s.filename, { type: blob.type || "audio/mpeg" }), s);
    } catch {
      showError("The sample clip could not be loaded.");
    }
  }

  function buildSteps() {
    el.steps.innerHTML = "";
    STEPS.forEach((s, i) => {
      const li = make("li");
      li.dataset.state = "waiting";
      li.innerHTML = `<span class="step-dot"><span>${i + 1}</span>${CHECK_SVG}</span><span><span class="step-name"></span><span class="step-time"></span></span>`;
      li.querySelector(".step-name").textContent = s.name;
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

  // Checks and previews the file in the browser; the server repeats every check before running the model.
  async function acceptFile(file, sample = null) {
    if (!file || state.running) return;
    el.error.textContent = ""; el.note.textContent = "";
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["wav", "mp3"].includes(ext)) return showError("Unsupported file format. Please use WAV or MP3.");
    if (file.size > MAX_BYTES) return showError("File too large (maximum 10 MB).");
    let buffer, format, mel;
    try {
      const bytes = await file.arrayBuffer();
      format = sniffFormat(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1 << 16)));
      buffer = await DSP.decode(bytes);
      mel = DSP.logMel(await DSP.toMono16k(buffer, WINDOW_SECONDS));
    } catch {
      return showError("The file could not be read.");
    }
    if (state.clip) URL.revokeObjectURL(state.clip.url);
    state.clip = {
      file, sample, name: file.name, ext: format.kind || ext.toUpperCase(), bytes: file.size, duration: buffer.duration, buffer,
      channels: format.channels || buffer.numberOfChannels, rate: format.rate || buffer.sampleRate,
      mel, melImage: DSP.melImage(mel), url: URL.createObjectURL(file),
    };
    showFileCard();
    if (buffer.duration > WINDOW_SECONDS) el.note.textContent = "Only the first 6 s will be analyzed.";
    resetRun();
  }

  function showFileCard() {
    const c = state.clip;
    el.dropzone.hidden = true;
    el.fileCard.hidden = false;
    $("#file-name").textContent = c.name;
    $("#file-meta").textContent = `${c.ext}, ${fmtSize(c.bytes)}, ${fmtTime(c.duration)}, ${(c.rate / 1000).toFixed(1)} kHz ${c.channels > 1 ? "stereo" : "mono"}`;
    const credit = c.sample?.attribution;
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
    drawWave(el.wave, state.clip.buffer, { colourA: "#6E1D1D", colourB: "#CDBFBA", split: WINDOW_SECONDS / state.clip.duration });
  }

  function movePlayhead(t) {
    const c = state.clip;
    if (!c) return;
    el.playhead.style.transform = `translateX(${(t / c.duration) * el.wave.clientWidth - 1}px)`;
    el.seek.value = Math.round((t / c.duration) * 1000);
    el.seek.setAttribute("aria-valuetext", `${fmtTime(t)} of ${fmtTime(c.duration)}`);
    $("#time-now").textContent = fmtTime(t);
  }

  function bindPlayer() {
    let raf = 0;
    const tick = () => { movePlayhead(el.player.currentTime); raf = requestAnimationFrame(tick); };
    el.play.addEventListener("click", () => (el.player.paused ? el.player.play() : el.player.pause()));
    el.player.addEventListener("play", () => { el.play.dataset.playing = "true"; el.play.setAttribute("aria-label", "Pause"); raf = requestAnimationFrame(tick); });
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
  const primary = () => state.response?.results?.[0];

  const scenes = {
    async check(dur, id) {
      const c = state.clip;
      $("#token-name").textContent = c.name;
      $("#token-meta").textContent = `${c.ext}, ${fmtSize(c.bytes)}`;
      const list = $("#checks");
      list.innerHTML = "";
      for (const text of [`${c.ext} file`, `${fmtSize(c.bytes)}, under 10 MB`, "Decodes without errors"]) {
        const li = make("li");
        li.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></svg><span></span>';
        li.querySelector("span").textContent = text;
        list.append(li);
      }
      el.stage.dataset.scene = "check";
      [...list.children].forEach((li, i) =>
        animate(li, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: ms(180 + i * 200), easing: EASE_OUT }));
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
      const c = state.clip, frac = Math.min(1, WINDOW_SECONDS / c.duration);
      const full = $("#window-full"), detail = $("#window-detail"), box = $("#window-box");
      for (const n of [full, detail, box]) n.getAnimations().forEach((a) => a.cancel());
      $("#window-caption").textContent = c.duration > WINDOW_SECONDS
        ? `Keeps the first 6.08 s of ${fmtTime(c.duration)}`
        : `Pads the ${c.duration.toFixed(1)}-s clip to one 6.08-s window`;
      el.stage.dataset.scene = "window";
      drawWave(full, c.buffer, { colourA: "#6E1D1D", colourB: "#CDBFBA", split: frac, bar: 2, gap: 1 });
      drawWave(detail, c.buffer, { seconds: Math.min(c.duration, WINDOW_SECONDS), colourA: "#6E1D1D", bar: 3, gap: 1 });
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
      animate(scan, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${canvas.clientWidth - 2}px)`, opacity: 1 }], { duration: draw, delay: ms(120), easing: "linear" });
      await sleep(draw + ms(140), id);
      animate(scan, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE_OUT });
      await sleep(Math.max(0, dur - draw - ms(140)), id);
    },

    async encoder(dur, id) {
      const grid = $("#patch-grid"), frame = $("#mel-frame");
      if (!grid.children.length) for (let i = 0; i < 190; i++) grid.append(make("span"));
      $("#mel-caption").textContent = "Cut into 190 patches of 16 × 16";
      animate(grid, [{ opacity: 0 }, { opacity: 1 }], { duration: ms(300), easing: EASE_OUT });
      const cells = [...grid.children], sweep = dur * 0.42, perCol = sweep / 38;
      cells.forEach((cell, i) => {
        animate(cell, [{ backgroundColor: "rgb(255 255 255 / 0)" }, { backgroundColor: "rgb(255 255 255 / 0.55)" }, { backgroundColor: "rgb(255 255 255 / 0.12)" }],
                { duration: ms(420), delay: ms(350) + (i % 38) * perCol, easing: "ease" });
      });
      await sleep(ms(350) + sweep + ms(250), id);
      await waitForResponse(id);                          // the embedding below is the model's real output
      if (!primary()?.embedding) return;
      drawEmbedding(primary().embedding);
      $("#embed-caption").textContent = "The model’s clip embedding: 3,840 values";
      $("#probe-row").getAnimations().forEach((a) => a.cancel());
      $("#probe-row").style.opacity = "0";
      animate(frame, [{ transform: "none", opacity: 1 }, { transform: "scaleY(0.2)", opacity: 0 }], { duration: ms(480), easing: EASE_IN_OUT });
      await sleep(ms(300), id);
      el.stage.dataset.scene = "embed";
      animate($("#embed-canvas"), [{ opacity: 0, transform: "scaleY(2.2)" }, { opacity: 1, transform: "none" }], { duration: ms(520), easing: EASE_OUT });
      await sleep(Math.max(0, dur - ms(350) - sweep - ms(550)), id);
    },

    async probe(dur, id) {
      const r = primary(), t = task(state.task);
      if (!r || r.status !== "ok") {
        $("#embed-caption").textContent = r?.status === "no_probe" ? "No trained classifier for this task yet" : "";
        await sleep(ms(600), id);
        return;
      }
      $("#probe-sub").textContent = `${t.name}, ${r.scores.length} ${t.multi_label ? "tag" : "class"} scores`;
      $("#embed-caption").textContent = `Scores for all ${r.scores.length} ${t.multi_label ? "tags" : "classes"}`;
      drawProbeScores(r.scores);
      const row = $("#probe-row"), canvas = $("#probe-canvas");
      row.style.opacity = "";
      animate(row, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: ms(360), easing: EASE_OUT });
      animate(canvas, [{ clipPath: "inset(100% 0 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: ms(520), delay: ms(260), easing: EASE_OUT });
      await sleep(dur, id);
    },
  };

  async function waitForResponse(id) {
    if (state.response || state.responseError) return;
    setStatus("Waiting for the model<small>The server is running the encoder</small>");
    await state.pending;
    if (id !== state.runId) throw new Error("cancelled");
  }

  function drawEmbedding(b64) {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const { ctx, w, h } = fitCanvas($("#embed-canvas"));
    const img = make("canvas", { width: bytes.length, height: 1 });
    const ictx = img.getContext("2d"), data = ictx.createImageData(bytes.length, 1);
    bytes.forEach((v, i) => data.data.set([...DSP.colour(0.08 + 0.84 * (v / 255)), 255], i * 4));
    ictx.putImageData(data, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);
  }

  function drawProbeScores(values) {
    const { ctx, w, h, dpr } = fitCanvas($("#probe-canvas"));
    const max = Math.max(...values, 1e-6), best = values.indexOf(Math.max(...values));
    const gap = Math.max(1, Math.round(dpr)), bw = (w - gap * (values.length - 1)) / values.length;
    values.forEach((v, i) => {
      const bh = Math.max(2 * dpr, (v / max) * (h - 4 * dpr));
      ctx.fillStyle = i === best ? "#6E1D1D" : "#B08A82";
      ctx.beginPath();
      ctx.roundRect(i * (bw + gap), h - bh, Math.max(1, bw), bh, [Math.min(4 * dpr, bw / 2), Math.min(4 * dpr, bw / 2), 0, 0]);
      ctx.fill();
    });
  }

  // ---------- output ----------
  function barRow(label, value, isTop, extraCells = [], highlight = false) {
    const tr = make("tr");
    const th = make("th", { scope: "row", textContent: label });
    if (highlight) { th.classList.add("only-one"); th.title = "Predicted by only one model"; }
    tr.append(th);
    for (const text of extraCells) tr.append(make("td", { className: "cell-text", textContent: text }));
    const td = make("td");
    td.innerHTML = '<div class="bar-line"><div class="bar-track"><div class="bar"></div></div><span class="bar-value"></span></div>';
    const bar = td.querySelector(".bar");
    bar.style.width = `${Math.max(0.5, value * 100)}%`;
    bar.classList.toggle("is-top", isTop);
    td.querySelector(".bar-value").textContent = pct(value);
    tr.append(td);
    return tr;
  }

  function bars(caption, headers) {
    const t = make("table", { className: "bars" });
    t.innerHTML = '<caption class="visually-hidden"></caption><thead class="visually-hidden"><tr></tr></thead><tbody></tbody>';
    t.querySelector("caption").textContent = caption;
    for (const h of headers) t.querySelector("thead tr").append(make("th", { scope: "col", textContent: h }));
    return t;
  }

  const predicted = (r, t) => (r.status !== "ok" ? [] : t.multi_label ? r.above_threshold : [r.top[0].label]);
  const pitchCells = (label) => (/^\d+$/.test(label) ? [noteName(+label), `MIDI ${label}`, `${midiHz(+label).toFixed(1)} Hz`] : [label]);

  function resultBlock(r, t, others) {
    const box = make("div", { className: "result-block" });
    if (others) box.append(make("h3", { textContent: r.display_name }));
    if (r.status !== "ok") {
      box.append(make("p", { className: "notice", textContent: r.message }));
      return box;
    }
    const otherSet = new Set(others ? predicted(others, t) : []);
    const only = (label) => others && others.status === "ok" && predicted(r, t).includes(label) && !otherSet.has(label);
    if (t.multi_label) {
      box.append(make("p", { className: "output-sub", textContent: `Tags above the ${r.threshold} threshold` }));
      const chips = make("ul", { className: "chips" });
      for (const tag of r.above_threshold) chips.append(make("li", { textContent: tag, className: only(tag) ? "only-one" : "" }));
      if (!r.above_threshold.length) chips.append(make("li", { className: "chip-empty", textContent: "None above the threshold" }));
      box.append(chips, make("p", { className: "output-sub", textContent: "Highest tag scores; the dashed line marks the threshold" }));
      const tbl = bars("Highest tag scores", ["Tag", "Probability"]);
      r.top.forEach(({ label, probability }) => {
        const row = barRow(label, probability, probability >= r.threshold, [], only(label));
        const line = make("div", { className: "threshold" });
        line.style.left = `${r.threshold * 100}%`;
        row.querySelector(".bar-track").append(line);
        tbl.tBodies[0].append(row);
      });
      box.append(tbl);
    } else if (t.code === "pitch") {
      const tbl = bars("Top pitches", ["Note", "MIDI number", "Frequency", "Probability"]);
      r.top.forEach(({ label, probability }, i) => {
        const [first, ...rest] = pitchCells(label);
        tbl.tBodies[0].append(barRow(first, probability, i === 0, rest, only(label)));
      });
      box.append(tbl);
    } else {
      const tbl = bars(`Top ${t.name.toLowerCase()} predictions`, [t.name, "Probability"]);
      r.top.forEach(({ label, probability }, i) => tbl.tBodies[0].append(barRow(label, probability, i === 0, [], only(label))));
      box.append(tbl);
    }
    return box;
  }

  function renderOutput() {
    const resp = state.response, t = task(state.task), [a, b] = resp.results;
    const main = $("#output-main");
    main.innerHTML = "";
    const titles = { genre: "Top genres", tagging: "Tagging", instrument: "Top instrument families", pitch: "Top pitches" };
    main.append(make("h3", { className: "output-title", textContent: `${titles[t.code] || t.name} (${t.dataset} labels)` }));
    if (b) {
      const grid = make("div", { className: "compare-grid" });
      grid.append(resultBlock(a, t, b), resultBlock(b, t, a));
      main.append(grid);
      if (a.status === "ok" && b.status === "ok") main.append(make("p", { className: "output-note", textContent: "Labels predicted by only one model are shown in bold." }));
    } else {
      main.append(resultBlock(a, t, null));
    }
    if (t.note && a.status === "ok") main.append(make("p", { className: "output-note", textContent: t.note }));

    const meta = $("#output-meta");
    meta.innerHTML = "";
    const inp = resp.input;
    const rows = [
      ["Input", inp.name],
      ["Analyzed", inp.padded ? `${inp.analyzed_s.toFixed(1)} s, padded to 6.08 s` : `First 6.08 s of ${fmtTime(inp.duration_s)}`],
      ["Model", resp.results.map((r) => r.display_name).join(" vs ")],
      ["Device", a.device],
      ["Inference time", resp.results.filter((r) => r.inference_ms != null).map((r) => fmtMs(r.inference_ms)).join(" / ") || "–"],
      ["Upload", resp.upload],
    ];
    if (resp.queue_position > 0) rows.splice(4, 0, ["Waited behind", `${resp.queue_position} request${resp.queue_position > 1 ? "s" : ""}`]);
    for (const [k, v] of rows) meta.append(make("dt", { textContent: k }), make("dd", { textContent: v }));

    el.output.hidden = false;
    animate(el.output, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE_OUT });
    main.querySelectorAll(".bar").forEach((bar, i) =>
      animate(bar, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: ms(620), delay: ms(120 + i * 60), easing: EASE_OUT }));
    announce(a.status === "ok" ? `Prediction ready. ${a.top[0].label}, ${pct(a.top[0].probability)}.` : a.message);
  }

  // ---------- run / reset ----------
  const setStep = (i, s) => { el.steps.children[i].dataset.state = s; };

  function stepTime(id) {
    const r = primary(), inp = state.response?.input;
    if (!r) return "";
    const t = r.timings || {};
    return { decode: fmtMs(inp?.decode_ms), logmel: fmtMs(t.logmel_ms), encoder: fmtMs(t.encoder_ms), probe: fmtMs(t.probe_ms) }[id] || "";
  }

  function lock(on) {
    el.form.querySelectorAll("input").forEach((r) => { if (r.type !== "file") r.disabled = on || (r.name === "model" && !model(r.value)?.loaded); });
    el.run.setAttribute("aria-busy", String(on));
    el.run.textContent = on ? "Running…" : "Run prediction";
  }

  function resetRun() {
    state.runId++;
    state.running = false;
    state.response = null; state.responseError = null; state.pending = null;
    document.getAnimations().forEach((a) => { if (el.stage.contains(a.effect?.target) || el.output.contains(a.effect?.target)) a.cancel(); });
    el.stage.dataset.scene = "idle";
    [...el.steps.children].forEach((li) => { li.dataset.state = "waiting"; li.querySelector(".step-time").textContent = ""; });
    el.output.hidden = true;
    lock(false);
    const m = model(state.model);
    setStatus(!api.models.length ? "Connecting to the server…" : state.clip ? `Ready to run with the <strong>${lowerFirst(m.name)}</strong>` : "Waiting for a clip");
  }

  function request() {
    const fd = new FormData();
    fd.append("task", state.task);
    fd.append("model", state.model);
    fd.append("compare", el.compare.checked ? "true" : "false");
    if (state.clip.sample) fd.append("sample", state.clip.sample.code);
    else fd.append("file", state.clip.file, state.clip.name);
    return fetch("/api/predict", { method: "POST", body: fd }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body.detail === "string" ? body.detail : "The server could not process this clip.");
      return body;
    });
  }

  async function run(e) {
    e.preventDefault();
    if (state.running) return;
    if (!state.clip) { showError("Add a WAV or MP3 clip first."); el.fileInput.focus(); return; }
    if (!model(state.model)?.loaded) { showError("This model is not available on the server yet."); return; }
    el.player.pause();
    resetRun();
    el.error.textContent = "";
    const id = state.runId;
    state.running = true;
    lock(true);
    state.pending = request().then((r) => { if (id === state.runId) state.response = r; },
                                    (err) => { if (id === state.runId) state.responseError = err; });
    try {
      for (let i = 0; i < STEPS.length; i++) {
        const s = STEPS[i];
        setStep(i, "active");
        setStatus(`Step ${i + 1} of ${STEPS.length}: <strong>${s.name}</strong><small>Slowed down so each step can be followed</small>`);
        await scenes[s.id](ms(s.shown), id);
        if (state.responseError) throw state.responseError;
        el.steps.children[i].querySelector(".step-time").textContent = stepTime(s.id);
        setStep(i, "done");
      }
    } catch (err) {
      if (err.message === "cancelled") return;
      resetRun();
      showError(err.message || "The server could not process this clip.");
      return;
    }
    state.running = false;
    lock(false);
    const r = primary();
    setStatus(r.inference_ms != null ? `Done in <strong>${fmtMs(r.inference_ms)}</strong> on the ${r.device.startsWith("GPU") ? "GPU" : "CPU"}` : "Done");
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
  async function init() {
    buildSteps();
    bindDrop();
    bindPlayer();
    el.form.addEventListener("submit", run);
    el.form.addEventListener("change", (e) => {
      if (e.target.name === "task") state.task = e.target.value;
      else if (e.target.name === "model") { state.model = e.target.value; updateBadges(); }
      else if (e.target.id !== "compare") return;
      if (!state.running) resetRun();
    });
    $("#group-filter").addEventListener("change", loadResults);
    window.addEventListener("hashchange", showView);
    if (recordMode) document.addEventListener("keydown", (e) => { if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) fullReset(); });
    window.addEventListener("resize", () => { drawFileWave(); if (state.clip) movePlayhead(el.player.currentTime); });
    resetRun();
    showView();
    try {
      [api.tasks, api.models, api.samples] = await Promise.all([getJSON("/api/tasks"), getJSON("/api/models"), getJSON("/api/samples")]);
    } catch {
      el.banner.textContent = "The dashboard server is not reachable. Start it with start.bat (Windows) or ./start.sh, then reload this page.";
      el.banner.hidden = false;
      el.run.disabled = true;
      setStatus("Server not reachable");
      return;
    }
    state.task = api.tasks[0]?.code;
    state.model = (api.models.find((m) => m.loaded) || api.models[0])?.code;
    buildChoices();
    buildSamples();
    resetRun();
  }

  init();
})();
