// Clip Organizer - frontend

const state = {
  config: null,         // { configured, clips_dir, output_dir, suggestions }
  games: [],
  currentGame: null,
  currentClip: null,
  tab: "source",
  items: [],
  search: "",
  sort: "date-desc",
  trim: { start: 0, end: 0, duration: 0, loop: true, dragging: null },
  pollHandle: null,
};

// Stable color seed for game avatars
const GAME_COLORS = [
  ["#6ea8fe", "#b48cff"],
  ["#5eead4", "#3b82f6"],
  ["#fbbf24", "#f97316"],
  ["#f87171", "#ec4899"],
  ["#4ade80", "#22d3ee"],
  ["#a78bfa", "#f472b6"],
  ["#fb923c", "#facc15"],
];
function gameColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GAME_COLORS[h % GAME_COLORS.length];
}
function gameInitials(name) {
  const parts = name.replace(/[_-]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ----- utils -----
const $ = (sel) => document.querySelector(sel);
const params = (obj) => new URLSearchParams(obj).toString();

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}
function fmtTimeShort(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (str.includes(":")) {
    const [m, s] = str.split(":");
    return parseFloat(m) * 60 + parseFloat(s);
  }
  return parseFloat(str);
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = (now - d) / 86400000;
  if (diffDays < 1) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ----- API -----
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let detail = `${path}: ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch {}
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ----- Setup screen -----
async function loadConfig() {
  state.config = await api("/api/config");
  return state.config;
}
function showSetup(isFirstRun) {
  const modal = $("#setup-modal");
  modal.classList.remove("hidden");
  const sug = state.config?.suggestions || {};
  $("#setup-clips").value = state.config?.clips_dir || sug.clips_dir || "";
  $("#setup-output").value = state.config?.output_dir || sug.output_dir || "";
  $("#setup-error").classList.add("hidden");
  $("#setup-cancel").style.display = isFirstRun ? "none" : "";
  $("#setup-title").textContent = isFirstRun ? "Welcome to Clip Organizer" : "Settings";
  $("#setup-subtitle").textContent = isFirstRun
    ? "Tell us where to find your clips and where to save trimmed ones."
    : "Change the folders Clip Organizer reads from and writes to.";
}
function hideSetup() {
  $("#setup-modal").classList.add("hidden");
}
async function saveSetup() {
  const clips = $("#setup-clips").value.trim();
  const out = $("#setup-output").value.trim();
  if (!clips || !out) {
    showSetupError("Both folders are required.");
    return;
  }
  const btn = $("#setup-save");
  btn.disabled = true;
  try {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips_dir: clips, output_dir: out }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to save");
    }
    hideSetup();
    await loadConfig();
    await loadGames();
  } catch (e) {
    showSetupError(e.message);
  } finally {
    btn.disabled = false;
  }
}
function showSetupError(msg) {
  const e = $("#setup-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

// ----- Games -----
async function loadGames() {
  try {
    state.games = await api("/api/games");
  } catch (e) {
    if (e.status === 412) { showSetup(true); return; }
    throw e;
  }
  renderGames();
  if (state.games.length && !state.games.find((g) => g.name === state.currentGame)) {
    selectGame(state.games[0].name);
  } else if (state.currentGame) {
    await loadItems();
  } else if (!state.games.length) {
    $("#title").textContent = "No clips found";
    $("#subtitle").textContent = "The captures folder doesn't have any game subfolders with video files.";
    $("#grid").innerHTML = `<div class="empty">Make sure your clips are organized into per-game subfolders inside the captures folder.<div class="hint">Open Settings to change the folder.</div></div>`;
  }
}
function renderGames() {
  const list = $("#game-list");
  list.innerHTML = "";
  if (!state.games.length) {
    list.innerHTML = '<div class="empty" style="padding:20px;font-size:12px">No games found</div>';
    return;
  }
  for (const g of state.games) {
    const el = document.createElement("div");
    el.className = "game-item" + (g.name === state.currentGame ? " active" : "");
    const [c1, c2] = gameColor(g.name);
    el.innerHTML = `
      <div class="avatar" style="background:linear-gradient(135deg, ${c1}, ${c2})">${gameInitials(g.name)}</div>
      <div class="name">${escapeHtml(g.name)}</div>
      <div class="count">${g.count}</div>`;
    el.addEventListener("click", () => selectGame(g.name));
    list.appendChild(el);
  }
}
async function selectGame(name) {
  state.currentGame = name;
  renderGames();
  await loadItems();
}

// ----- Clips / outputs -----
async function loadItems() {
  if (!state.currentGame) return;
  $("#title").textContent = state.currentGame;
  $("#subtitle").textContent = "Loading…";
  const grid = $("#grid");
  grid.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const url = state.tab === "source"
      ? "/api/clips?" + params({ game: state.currentGame })
      : "/api/outputs?" + params({ game: state.currentGame });
    state.items = await api(url);
  } catch (e) {
    state.items = [];
    if (e.status === 412) { showSetup(true); return; }
    grid.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderGrid();
}

function applyFilterSort(items) {
  let xs = items;
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    xs = xs.filter((c) => c.filename.toLowerCase().includes(q));
  }
  const cmp = {
    "date-desc": (a, b) => b.mtime - a.mtime,
    "date-asc":  (a, b) => a.mtime - b.mtime,
    "size-desc": (a, b) => b.size - a.size,
    "size-asc":  (a, b) => a.size - b.size,
    "name-asc":  (a, b) => a.filename.localeCompare(b.filename),
  }[state.sort] || ((a, b) => b.mtime - a.mtime);
  return xs.slice().sort(cmp);
}

function renderGrid() {
  const grid = $("#grid");
  const items = applyFilterSort(state.items);
  const total = state.items.length;
  const shown = items.length;

  let sub = state.tab === "source"
    ? `${total} ${total === 1 ? "capture" : "captures"}`
    : `${total} trimmed ${total === 1 ? "clip" : "clips"}`;
  if (shown !== total) sub = `${shown} of ${sub}`;
  $("#subtitle").textContent = sub;

  if (!items.length) {
    if (state.search) {
      grid.innerHTML = `<div class="empty">No clips match "<strong>${escapeHtml(state.search)}</strong>".<div class="hint">Try a shorter search term.</div></div>`;
    } else if (state.tab === "outputs") {
      grid.innerHTML = `<div class="empty">No trimmed clips for ${escapeHtml(state.currentGame)} yet.<div class="hint">Open a capture and trim it to populate this view.</div></div>`;
    } else {
      grid.innerHTML = '<div class="empty">No clips in this folder.</div>';
    }
    return;
  }

  grid.innerHTML = "";
  for (const c of items) {
    const card = document.createElement("div");
    card.className = "card";
    const isOutput = state.tab === "outputs";
    const thumbUrl = isOutput
      ? `/api/thumb-output?${params({ game: state.currentGame, file: c.filename })}`
      : `/api/thumb?${params({ game: state.currentGame, file: c.filename })}`;
    const dateStr = c.parsed_date
      ? fmtDate(c.parsed_date)
      : fmtDate(new Date(c.mtime * 1000).toISOString());
    const badge = isOutput
      ? '<div class="badge green">Trimmed</div>'
      : '';
    const hover = isOutput
      ? `<div class="hover-action"><svg class="icon icon-sm"><use href="#i-play-outline"/></svg>Play</div>`
      : `<div class="hover-action"><svg class="icon icon-sm"><use href="#i-scissors"/></svg>Trim</div>`;
    card.innerHTML = `
      <div class="card-thumb" style="background-image:url('${thumbUrl}')">
        ${badge}
        ${hover}
      </div>
      <div class="card-meta">
        <div class="card-name" title="${escapeHtml(c.filename)}">${escapeHtml(c.filename)}</div>
        <div class="card-sub">
          <span>${dateStr}</span>
          <span>${fmtSize(c.size)}</span>
        </div>
      </div>`;
    card.addEventListener("click", () => {
      if (isOutput) openOutput(c.filename);
      else openTrim(c);
    });
    grid.appendChild(card);
  }
}

function openOutput(filename) {
  const url = `/api/output-file?${params({ game: state.currentGame, file: filename })}`;
  window.open(url, "_blank");
}

// ----- Trim modal -----
async function openTrim(clip) {
  state.currentClip = clip;
  const modal = $("#trim-modal");
  modal.classList.remove("hidden");
  $("#trim-title").textContent = clip.filename;
  $("#trim-result").classList.add("hidden");
  $("#trim-status").textContent = "";
  $("#progress-bar").classList.add("hidden");
  $("#progress-bar").firstElementChild.style.width = "0%";
  $("#trim-btn").disabled = false;
  $("#trim-btn").innerHTML = `<svg class="icon"><use href="#i-scissors"/></svg><span>Trim &amp; Save</span>`;

  const video = $("#trim-video");
  // preload="auto" gives smooth scrubbing (browser buffers ahead via Range requests).
  video.preload = "auto";
  video.src = `/api/video?${params({ game: state.currentGame, file: clip.filename })}`;

  // Whichever source returns a valid duration first wins. tryInit is idempotent.
  let durationSet = false;
  const tryInit = (d) => {
    if (durationSet || !d || !isFinite(d) || d <= 0) return;
    durationSet = true;
    initTimeline(d);
  };

  // If metadata is already loaded (cached video), use it immediately.
  if (video.readyState >= 1 && video.duration > 0) {
    tryInit(video.duration);
  } else {
    video.addEventListener(
      "loadedmetadata",
      () => tryInit(video.duration),
      { once: true }
    );
  }

  // Also fetch via API — usually faster than waiting for the video to parse.
  try {
    const meta = await api(
      "/api/clip-meta?" + params({ game: state.currentGame, file: clip.filename })
    );
    tryInit(meta.duration);
  } catch (e) {
    // The loadedmetadata listener above is our fallback.
  }
}

function closeTrim() {
  $("#trim-modal").classList.add("hidden");
  const v = $("#trim-video");
  v.pause();
  v.removeAttribute("src");
  v.load();
  if (state.pollHandle) {
    clearTimeout(state.pollHandle);
    state.pollHandle = null;
  }
}

function initTimeline(duration) {
  state.trim.duration = duration;
  state.trim.start = 0;
  state.trim.end = duration;
  updateTimelineUI();
  updateBitrateEstimate();
}

function updateTimelineUI() {
  const { start, end, duration } = state.trim;
  const startPct = duration > 0 ? (start / duration) * 100 : 0;
  const endPct = duration > 0 ? (end / duration) * 100 : 100;
  $("#handle-start").style.left = `${startPct}%`;
  $("#handle-end").style.left = `${endPct}%`;
  const r = $("#timeline-range");
  r.style.left = `${startPct}%`;
  r.style.width = `${endPct - startPct}%`;
  if (document.activeElement !== $("#start-input")) $("#start-input").value = fmtTime(start);
  if (document.activeElement !== $("#end-input")) $("#end-input").value = fmtTime(end);
  $("#trim-duration").textContent = fmtTimeShort(end - start);
}

function updatePlayhead() {
  const v = $("#trim-video");
  const ph = $("#timeline-playhead");
  const { duration } = state.trim;
  if (!duration) return;
  const pct = (v.currentTime / duration) * 100;
  ph.style.left = `${pct}%`;
}

function updateBitrateEstimate() {
  const dur = state.trim.end - state.trim.start;
  const targetMB = parseFloat($("#target-size").value);
  const audioKbps = parseInt($("#audio-kbps").value, 10);
  const pill = $("#bitrate-estimate");
  if (dur <= 0) {
    pill.innerHTML = `<span class="dot"></span><span>—</span>`;
    return;
  }
  const totalKbps = (targetMB * 1024 * 1024 * 8 * 0.95) / dur / 1000;
  const videoKbps = Math.max(150, totalKbps - audioKbps);
  let res;
  if (videoKbps >= 4500) res = "source";
  else if (videoKbps >= 2200) res = "720p";
  else if (videoKbps >= 900) res = "540p";
  else if (videoKbps >= 400) res = "360p";
  else res = "240p";
  pill.classList.remove("warn", "bad");
  if (videoKbps < 400) pill.classList.add("bad");
  else if (videoKbps < 900) pill.classList.add("warn");
  pill.innerHTML = `<span class="dot"></span><span>${res} · ~${Math.round(videoKbps)} kbps</span>`;
}

function trackPctFromEvent(e) {
  const track = $("#timeline-track");
  const rect = track.getBoundingClientRect();
  const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - rect.left;
  return Math.max(0, Math.min(1, x / rect.width));
}

function setupTimelineDrag() {
  const track = $("#timeline-track");
  const hStart = $("#handle-start");
  const hEnd = $("#handle-end");
  const video = $("#trim-video");

  function seekVideo(t) {
    const dur = state.trim.duration || video.duration || 0;
    if (dur <= 0) return; // not loaded yet
    const clamped = Math.max(0, Math.min(dur, t));
    // fastSeek goes to the nearest keyframe without waiting for full decode —
    // makes scrubbing feel instant. Falls back to currentTime in older browsers.
    if (typeof video.fastSeek === "function") {
      video.fastSeek(clamped);
    } else {
      video.currentTime = clamped;
    }
    // Move the playhead UI immediately, don't wait for the seeked event.
    const ph = $("#timeline-playhead");
    if (ph) ph.style.left = `${(clamped / dur) * 100}%`;
  }

  function onPointerMove(e) {
    if (!state.trim.dragging) return;
    const pct = trackPctFromEvent(e);
    const t = pct * state.trim.duration;
    if (state.trim.dragging === "start") {
      state.trim.start = Math.max(0, Math.min(t, state.trim.end - 0.1));
      seekVideo(state.trim.start);
      updateTimelineUI();
      updateBitrateEstimate();
    } else if (state.trim.dragging === "end") {
      state.trim.end = Math.min(state.trim.duration, Math.max(t, state.trim.start + 0.1));
      seekVideo(state.trim.end);
      updateTimelineUI();
      updateBitrateEstimate();
    } else if (state.trim.dragging === "playhead") {
      seekVideo(t);
    }
  }
  function onPointerUp() {
    state.trim.dragging = null;
    track.classList.remove("scrubbing");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }
  function startDrag(which, initialT) {
    state.trim.dragging = which;
    track.classList.add("scrubbing");
    if (!video.paused) video.pause();
    if (which === "start") seekVideo(state.trim.start);
    else if (which === "end") seekVideo(state.trim.end);
    else if (which === "playhead" && initialT != null) seekVideo(initialT);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  hStart.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    startDrag("start");
  });
  hEnd.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    startDrag("end");
  });
  track.addEventListener("pointerdown", (e) => {
    if (e.target === hStart || e.target === hEnd) return;
    e.preventDefault();
    const pct = trackPctFromEvent(e);
    const t = pct * state.trim.duration;
    startDrag("playhead", t);
  });

  for (const [h, key] of [[hStart, "start"], [hEnd, "end"]]) {
    h.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 0.1;
      if (e.key === "ArrowLeft") state.trim[key] = Math.max(0, state.trim[key] - step);
      else if (e.key === "ArrowRight") state.trim[key] = Math.min(state.trim.duration, state.trim[key] + step);
      else return;
      if (state.trim.start > state.trim.end - 0.1) {
        if (key === "start") state.trim.start = state.trim.end - 0.1;
        else state.trim.end = state.trim.start + 0.1;
      }
      updateTimelineUI();
      updateBitrateEstimate();
      e.preventDefault();
    });
  }

  $("#start-input").addEventListener("change", (e) => {
    const v = parseTime(e.target.value);
    if (isFinite(v)) {
      state.trim.start = Math.max(0, Math.min(state.trim.end - 0.1, v));
      updateTimelineUI(); updateBitrateEstimate();
    }
  });
  $("#end-input").addEventListener("change", (e) => {
    const v = parseTime(e.target.value);
    if (isFinite(v)) {
      state.trim.end = Math.min(state.trim.duration, Math.max(state.trim.start + 0.1, v));
      updateTimelineUI(); updateBitrateEstimate();
    }
  });

  $("#set-start").addEventListener("click", () => {
    state.trim.start = Math.min($("#trim-video").currentTime, state.trim.end - 0.1);
    updateTimelineUI(); updateBitrateEstimate();
  });
  $("#set-end").addEventListener("click", () => {
    state.trim.end = Math.max($("#trim-video").currentTime, state.trim.start + 0.1);
    updateTimelineUI(); updateBitrateEstimate();
  });

  $("#target-size").addEventListener("change", updateBitrateEstimate);
  $("#audio-kbps").addEventListener("change", updateBitrateEstimate);
  $("#loop-toggle").addEventListener("change", (e) => { state.trim.loop = e.target.checked; });
}

function setupVideoEvents() {
  const v = $("#trim-video");
  v.addEventListener("timeupdate", () => {
    updatePlayhead();
    if (state.trim.loop && v.currentTime >= state.trim.end) {
      v.currentTime = state.trim.start;
    }
  });
  v.addEventListener("seeking", updatePlayhead);
  v.addEventListener("seeked", updatePlayhead);
}

async function submitTrim() {
  const btn = $("#trim-btn");
  btn.disabled = true;
  btn.innerHTML = `<svg class="icon"><use href="#i-clock"/></svg><span>Trimming…</span>`;
  $("#trim-status").innerHTML = `<span class="phase">Starting</span>`;
  $("#trim-result").classList.add("hidden");
  const bar = $("#progress-bar");
  bar.classList.remove("hidden");
  bar.firstElementChild.style.width = "0%";
  try {
    const res = await fetch("/api/trim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game: state.currentGame,
        file: state.currentClip.filename,
        start: state.trim.start,
        end: state.trim.end,
        target_mb: parseFloat($("#target-size").value),
        audio_kbps: parseInt($("#audio-kbps").value, 10),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { job_id } = await res.json();
    pollJob(job_id);
  } catch (e) {
    showResult({ status: "failed", error: e.message });
    btn.disabled = false;
    btn.innerHTML = `<svg class="icon"><use href="#i-scissors"/></svg><span>Trim &amp; Save</span>`;
    bar.classList.add("hidden");
  }
}

function pollJob(jobId) {
  let lastProgress = -1;
  async function tick() {
    try {
      const j = await api(`/api/job/${jobId}`);
      if (j.progress !== lastProgress) {
        const pct = Math.round((j.progress || 0) * 100);
        const phaseLabel = j.phase === "pass1" ? "Analyzing" : j.phase === "pass2" ? "Encoding" : "Preparing";
        const extra = j.video_kbps ? `· ${j.video_kbps} kbps ${j.scale || ""}` : "";
        $("#trim-status").innerHTML = `<span class="phase">${phaseLabel}</span> ${pct}% ${extra}`;
        $("#progress-bar").firstElementChild.style.width = `${pct}%`;
        lastProgress = j.progress;
      }
      if (j.status === "done" || j.status === "failed") {
        showResult(j);
        $("#trim-btn").disabled = false;
        $("#trim-btn").innerHTML = `<svg class="icon"><use href="#i-scissors"/></svg><span>Trim &amp; Save</span>`;
        $("#progress-bar").classList.add("hidden");
        $("#trim-status").textContent = "";
        if (j.status === "done" && state.tab === "outputs") loadItems();
        return;
      }
    } catch (e) {
      console.warn("poll error", e);
    }
    state.pollHandle = setTimeout(tick, 400);
  }
  tick();
}

function showResult(j) {
  const r = $("#trim-result");
  r.classList.remove("hidden", "error");
  if (j.status === "failed") {
    r.classList.add("error");
    r.innerHTML = `
      <div class="result-head">
        <svg class="icon icon-lg"><use href="#i-alert"/></svg>
        <div class="title">Trim failed</div>
      </div>
      <div class="result-info">${escapeHtml(j.error || "Unknown error")}</div>`;
    return;
  }
  const sizeMB = (j.output_size / 1024 / 1024).toFixed(2);
  const overFree = j.output_size > 10 * 1024 * 1024 && parseFloat($("#target-size").value) < 10;
  r.innerHTML = `
    <div class="result-head">
      <svg class="icon icon-lg"><use href="#i-check"/></svg>
      <div class="title">Saved${overFree ? " (over target — try a shorter range)" : ""}</div>
    </div>
    <div class="result-info">${escapeHtml(j.out_name)} · ${sizeMB} MB</div>
    <div class="result-actions">
      <button class="mini" id="play-result">
        <svg class="icon icon-sm"><use href="#i-play-outline"/></svg>
        <span>Play</span>
      </button>
      <button class="mini" id="open-result-folder">
        <svg class="icon icon-sm"><use href="#i-folder"/></svg>
        <span>Open folder</span>
      </button>
      <button class="mini" id="copy-path" data-path="${escapeHtml(j.output_path || "")}">
        <svg class="icon icon-sm"><use href="#i-copy"/></svg>
        <span>Copy path</span>
      </button>
    </div>`;
  $("#open-result-folder").addEventListener("click", () =>
    fetch(`/api/reveal?${params({ game: state.currentGame })}`, { method: "POST" })
  );
  $("#play-result").addEventListener("click", () =>
    window.open(
      `/api/output-file?${params({ game: state.currentGame, file: j.out_name })}`,
      "_blank"
    )
  );
  $("#copy-path").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const path = btn.getAttribute("data-path");
    if (!path) return;
    navigator.clipboard?.writeText(path);
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg class="icon icon-sm"><use href="#i-check"/></svg><span>Copied</span>`;
    setTimeout(() => { btn.innerHTML = orig; }, 1300);
  });
}

// ----- init -----
document.addEventListener("DOMContentLoaded", async () => {
  setupTimelineDrag();
  setupVideoEvents();

  try {
    await loadConfig();
  } catch (e) {
    showSetup(true);
    return;
  }

  if (!state.config.configured) {
    showSetup(true);
  } else {
    await loadGames();
  }

  // Tab switching
  document.querySelectorAll(".segment .tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".segment .tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.tab = b.dataset.tab;
      loadItems();
    })
  );

  // Modal close
  document.querySelectorAll("[data-close]").forEach((e) =>
    e.addEventListener("click", closeTrim)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#trim-modal").classList.contains("hidden")) closeTrim();
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
      e.preventDefault();
      $("#search-input").focus();
    }
  });

  $("#trim-btn").addEventListener("click", submitTrim);

  $("#open-output-folder").addEventListener("click", () => {
    if (state.currentGame)
      fetch(`/api/reveal?${params({ game: state.currentGame })}`, { method: "POST" });
  });

  $("#open-settings").addEventListener("click", () => {
    loadConfig().finally(() => showSetup(false));
  });
  $("#setup-cancel").addEventListener("click", hideSetup);
  $("#setup-save").addEventListener("click", saveSetup);

  // Search
  let searchTimer;
  $("#search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      renderGrid();
    }, 80);
  });

  // Sort
  $("#sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderGrid();
  });

  // Refresh
  $("#refresh-btn").addEventListener("click", async () => {
    const btn = $("#refresh-btn");
    btn.style.transform = "rotate(360deg)";
    btn.style.transition = "transform 500ms ease";
    await loadGames();
    if (state.currentGame) await loadItems();
    setTimeout(() => {
      btn.style.transform = "";
      btn.style.transition = "";
    }, 500);
  });
});
