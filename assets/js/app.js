import { isAlternating, alternatingTelemetry, alternatingSynthesis, GAIT_LIMIT } from "./movement-mode.js";
import {
  BONES, KEY_JOINTS, containRect, landmarkToStage, computeCenterOfMass,
} from "./pose-math.js";
import { demoLandmarks, DEMO_DURATION_SECONDS } from "./demo-pose.js";
import { SessionTrace, describeLive } from "./session-trace.js";
import { synthesizeSession } from "./synthesis.js";
import { runAIDeepAnalysis, askAIFlightSurgeon, AI_PROVIDERS } from "./ai-coach.js";

const CDN = {
  js: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
  wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  model: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
};
// Mirror of the same pinned npm package. Tried only if the primary CDN fails.
const CDN_MIRROR = {
  js: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
  wasm: "https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm",
  model: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
};
const ENGINE_FETCH_TIMEOUT_MS = 30000; // engine code + WASM runtime (small files)
const ENGINE_MODEL_TIMEOUT_MS = 90000; // pose model (~30 MB) + delegate start
const SAMPLE_CLIP = "assets/video/astro-motion.mp4";
const CHART_WINDOW = 30; // seconds

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), og = overlay.getContext("2d");
const chart = $("chart"), cg = chart.getContext("2d");
const statusEl = $("engine-status-text"), trackEl = $("track-state"), hud = $("hud");
const emptyEl = $("stage-empty");

let pose = null, engineState = "loading"; // loading | ready | failed
let camStream = null, objectUrl = null, rafId = 0, mode = null; // demo | webcam | file | sample
let S = null, lastDetectTs = -1, lastProcessedVideoTime = -1;
let currentChartMode = "all"; // "all" | "lower" | "upper"

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  $("engine-status").dataset.kind = kind;
}

const PHASE_WORD = {
  eccentric: "Lowering",
  concentric: "Driving up",
  inflection: "At the bottom",
  extended: "Standing",
};

function resetSession() {
  const trace = new SessionTrace();
  S = {
    trace,
    movementType: $("movement-type").value,
    startedAt: performance.now(),
    trails: { lw: [], rw: [], la: [], ra: [] },
    kneeReps: trace.squat,
    elbowReps: trace.arm,
    latestAngles: null,
    latestCom: null,
    get frames() { return trace.frames; },
    get detected() { return trace.detected; },
    get durSum() { return trace.durSum; },
    get hist() { return trace.hist; },
    get repTimes() { return trace.repTimes; },
  };
  for (const id of ["r-squat", "r-arm"]) $(id).textContent = "0";
  $("m-energy").textContent = "—"; $("m-sym").textContent = "—"; $("m-tempo").textContent = "—";
  $("m-clock").textContent = "0:00"; $("m-trunk").textContent = "—"; $("m-phase").textContent = "—";
  $("g-energy").style.width = "0%"; $("g-sym").style.width = "0%";
  hud.textContent = "";
  const reading = $("live-reading");
  if (reading) reading.textContent = "Start a session. This line will say what the body is doing.";
}

/* ---------------- pose engine ---------------- */

function withEngineTimeout(promise, ms, stage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out ${stage}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadEngineAttempt(cdn, label) {
  setStatus(`Loading pose engine (${label}): downloading engine code…`, "loading");
  const mod = await withEngineTimeout(import(cdn.js), ENGINE_FETCH_TIMEOUT_MS, "downloading engine code");
  setStatus(`Loading pose engine (${label}): starting runtime…`, "loading");
  const fileset = await withEngineTimeout(
    mod.FilesetResolver.forVisionTasks(cdn.wasm), ENGINE_FETCH_TIMEOUT_MS, "starting WASM runtime");
  setStatus(`Loading pose engine (${label}): downloading pose model (~30 MB, first run)…`, "loading");
  const make = (delegate) => mod.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CDN.model, delegate }, runningMode: "VIDEO", numPoses: 1,
  });
  try {
    return await withEngineTimeout(make("GPU"), ENGINE_MODEL_TIMEOUT_MS, "starting GPU delegate");
  } catch (gpuErr) {
    console.warn(`[orbiter] GPU delegate failed (${gpuErr.message}); falling back to CPU.`);
    setStatus(`Loading pose engine (${label}): GPU unavailable, starting on CPU…`, "loading");
    return await withEngineTimeout(make("CPU"), ENGINE_MODEL_TIMEOUT_MS, "starting CPU delegate");
  }
}

async function loadEngine() {
  engineState = "loading";
  pose = null;
  setStatus("Loading pose engine from CDN… (the demonstration below works without it)", "loading");
  $("b-retry-engine").hidden = true;
  const t0 = performance.now();
  const failures = [];
  for (const [label, cdn] of [["primary", CDN], ["mirror", CDN_MIRROR]]) {
    try {
      pose = await loadEngineAttempt(cdn, label);
      engineState = "ready";
      const secs = Math.round((performance.now() - t0) / 1000);
      setStatus(`Pose engine ready in ${secs}s${label === "mirror" ? " (via mirror CDN)" : ""}. Video is processed on this device only — nothing is uploaded.`, "ok");
      return;
    } catch (err) {
      failures.push(`${label}: ${err.message || err}`);
      console.warn(`[orbiter] pose engine ${label} CDN failed:`, err);
    }
  }
  engineState = "failed";
  pose = null;
  setStatus(`Pose engine could not load (${failures.join(" · ")}). Check your connection, then retry — the synthetic demonstration works offline.`, "error");
  $("b-retry-engine").hidden = false;
}

function requireEngine() {
  if (pose) return true;
  setStatus(engineState === "loading"
    ? "Pose engine is still loading. Wait for “ready”, or run the synthetic demonstration now."
    : "Pose engine is not loaded. Run the synthetic demonstration, or retry the engine when online.", "error");
  return false;
}

/* ---------------- drawing ---------------- */

function fitCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = overlay.clientWidth, h = overlay.clientHeight;
  if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
    overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  }
  return dpr;
}

function drawSkeleton(lm, rect, ok) {
  const at = (i) => landmarkToStage(lm[i], rect);
  og.save();
  og.lineWidth = Math.max(2, rect.w / 420); og.lineCap = "round"; og.lineJoin = "round";
  og.strokeStyle = ok ? "#0b3d91" : "#b54708";
  og.beginPath();
  for (const [a, b] of BONES) { const A = at(a), B = at(b); og.moveTo(A.x, A.y); og.lineTo(B.x, B.y); }
  og.stroke();

  og.fillStyle = "#ffffff"; og.strokeStyle = "#14202e"; og.lineWidth = 1.2;
  for (const i of KEY_JOINTS) { const P = at(i); og.beginPath(); og.arc(P.x, P.y, Math.max(3, rect.w / 320), 0, 7); og.fill(); og.stroke(); }

  // Draw Center of Mass (CoM) Target Indicator
  const com = computeCenterOfMass(lm);
  const cp = landmarkToStage(com, rect);
  og.beginPath();
  og.arc(cp.x, cp.y, Math.max(7, rect.w / 140), 0, Math.PI * 2);
  og.strokeStyle = "#c81e1e"; og.lineWidth = 1.8; og.stroke();
  og.beginPath();
  og.arc(cp.x, cp.y, 2.5, 0, Math.PI * 2);
  og.fillStyle = "#c81e1e"; og.fill();
  og.beginPath();
  og.moveTo(cp.x - 11, cp.y); og.lineTo(cp.x + 11, cp.y);
  og.moveTo(cp.x, cp.y - 11); og.lineTo(cp.x, cp.y + 11);
  og.strokeStyle = "rgba(200, 30, 30, 0.75)"; og.lineWidth = 1.2; og.stroke();

  og.fillStyle = "#c81e1e"; og.font = "bold 10px 'IBM Plex Mono', monospace";
  og.fillText("⊕CoM", cp.x + 10, cp.y - 4);
  og.restore();

  // Motion trails for wrists and ankles
  const pts = { lw: lm[15], rw: lm[16], la: lm[27], ra: lm[28] };
  for (const k in pts) {
    const tr = S.trails[k]; const P = at(pts[k] === lm[15] ? 15 : pts[k] === lm[16] ? 16 : pts[k] === lm[27] ? 27 : 28);
    tr.push(P); if (tr.length > 14) tr.shift();
    if (tr.length < 2) continue;
    og.beginPath(); tr.forEach((pt, i) => (i ? og.lineTo(pt.x, pt.y) : og.moveTo(pt.x, pt.y)));
    og.strokeStyle = "rgba(11,61,145,.35)"; og.lineWidth = 1.5; og.stroke();
  }
}

function drawDemoBackdrop(rect) {
  og.save();
  og.fillStyle = "#e8ecef"; og.fillRect(rect.x, rect.y, rect.w, rect.h);
  og.strokeStyle = "#d3d9de"; og.lineWidth = 1;
  for (let x = rect.x; x <= rect.x + rect.w; x += rect.w / 16) { og.beginPath(); og.moveTo(x, rect.y); og.lineTo(x, rect.y + rect.h); og.stroke(); }
  for (let y = rect.y; y <= rect.y + rect.h; y += rect.h / 9) { og.beginPath(); og.moveTo(rect.x, y); og.lineTo(rect.x + rect.w, y); og.stroke(); }
  og.fillStyle = "#5b6b7c"; og.font = "600 12px 'IBM Plex Mono', monospace";
  og.fillText("SYNTHETIC DEMONSTRATION — SIMULATED LANDMARKS, NOT CAMERA FOOTAGE", rect.x + 14, rect.y + 22);
  og.restore();
}

function drawChart(t) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(chart.clientWidth * dpr), H = Math.round(chart.clientHeight * dpr);
  if (chart.width !== W || chart.height !== H) { chart.width = W; chart.height = H; }
  cg.clearRect(0, 0, W, H);
  cg.strokeStyle = "#d9dde2"; cg.fillStyle = "#68707c"; cg.lineWidth = 1;
  cg.font = `${10 * dpr}px 'IBM Plex Mono', monospace`;
  for (let d = 30; d <= 180; d += 30) {
    const y = H - (d / 200) * H;
    cg.beginPath(); cg.moveTo(0, y); cg.lineTo(W, y); cg.stroke();
    cg.fillText(`${d}°`, 4 * dpr, y - 3 * dpr);
  }
  if (!S) return;

  // Multi-stream chart series
  let series = [];
  if (currentChartMode === "lower") {
    series = [
      ["lKnee", "#0b3d91"], ["rKnee", "#2f7fd0"],
      ["lHip", "#067647"], ["rHip", "#12b76a"],
      ["trunkTilt", "#b54708"],
    ];
  } else if (currentChartMode === "upper") {
    series = [
      ["lElbow", "#b54708"], ["rElbow", "#d92d20"],
      ["lShoulder", "#7c3aed"], ["rShoulder", "#9333ea"],
    ];
  } else {
    // "all" default
    series = [
      ["lKnee", "#0b3d91"], ["rKnee", "#2f7fd0"],
      ["trunkTilt", "#b54708"], ["lElbow", "#d92d20"],
    ];
  }

  for (const [key, col] of series) {
    cg.beginPath(); cg.strokeStyle = col; cg.lineWidth = 1.6 * dpr;
    let started = false;
    for (const pt of S.hist) {
      if (pt[key] === undefined) continue;
      const x = ((pt.t - (t - CHART_WINDOW)) / CHART_WINDOW) * W, y = H - (pt[key] / 200) * H;
      started ? cg.lineTo(x, y) : cg.moveTo(x, y); started = true;
    }
    cg.stroke();
  }
  cg.strokeStyle = "rgba(20,32,46,.35)";
  for (const r of S.repTimes) {
    if (r.t < t - CHART_WINDOW) continue;
    const x = ((r.t - (t - CHART_WINDOW)) / CHART_WINDOW) * W;
    cg.beginPath(); cg.moveTo(x, 0); cg.lineTo(x, H); cg.stroke();
  }
}

function updateChartLegend() {
  const legend = $("chart-legend");
  if (!legend) return;
  if (currentChartMode === "lower") {
    legend.innerHTML = `
      <span><i style="background:#0b3d91"></i>Left knee</span>
      <span><i style="background:#2f7fd0"></i>Right knee</span>
      <span><i style="background:#067647"></i>Left hip</span>
      <span><i style="background:#12b76a"></i>Right hip</span>
      <span><i style="background:#b54708"></i>Trunk tilt</span>`;
  } else if (currentChartMode === "upper") {
    legend.innerHTML = `
      <span><i style="background:#b54708"></i>Left elbow</span>
      <span><i style="background:#d92d20"></i>Right elbow</span>
      <span><i style="background:#7c3aed"></i>Left shoulder</span>
      <span><i style="background:#9333ea"></i>Right shoulder</span>`;
  } else {
    legend.innerHTML = `
      <span><i style="background:#0b3d91"></i>Left knee</span>
      <span><i style="background:#2f7fd0"></i>Right knee</span>
      <span><i style="background:#b54708"></i>Trunk tilt (spine)</span>
      <span><i style="background:#d92d20"></i>Arms / Elbow</span>`;
  }
}

if ($("chart-mode-select")) {
  $("chart-mode-select").onchange = (e) => {
    currentChartMode = e.target.value;
    updateChartLegend();
    if (S) drawChart((performance.now() - S.startedAt) / 1000);
  };
}

/* ---------------- analysis pipeline ---------------- */

function processLandmarks(lm, t, srcW, srcH, rect) {
  fitCanvas();
  og.clearRect(0, 0, overlay.width, overlay.height);
  const snap = S.trace.observe(lm, t, srcW, srcH);
  const reading = $("live-reading");
  if (!snap) {
    trackEl.textContent = "No person in frame"; trackEl.dataset.state = "lost";
    if (reading) reading.textContent = describeLive(null);
    drawChart(t);
    return;
  }
  const ok = snap.ok;
  trackEl.textContent = ok ? "Tracking" : "Partial — step back so hips and knees are visible";
  trackEl.dataset.state = ok ? "ok" : "partial";
  S.latestAngles = snap.ang;
  S.latestCom = snap.com;

  $("m-sym").style.fontSize = isAlternating(S) ? "20px" : "";
  $("m-phase").style.fontSize = isAlternating(S) ? "20px" : "";
  const ang = snap.ang;
  const sentence = isAlternating(S) ? "Running / alternating mode. Descriptive tracking only; no gait or readiness assessment." : describeLive(snap);
  if (reading) reading.textContent = sentence;

  if (mode === "demo") drawDemoBackdrop(rect);
  drawSkeleton(lm, rect, ok);
  hud.textContent =
    `Knees  L ${Math.round(ang.lKnee)}°   R ${Math.round(ang.rKnee)}°     Hips L ${Math.round(ang.lHip)}°   R ${Math.round(ang.rHip)}°\n` +
    `Ankles L ${Math.round(ang.lAnkle)}°   R ${Math.round(ang.rAnkle)}°     Elbows L ${Math.round(ang.lElbow)}°   R ${Math.round(ang.rElbow)}°\n` +
    `Chest ${Math.round(ang.trunkTilt)}° off upright    Hips ${Math.abs(Math.round(ang.pelvicObliquity))}° off level    Feet ${snap.stance.toFixed(1)}× hip width\n` +
    sentence;

  $("r-squat").textContent = isAlternating(S) ? "N/A" : S.kneeReps.count;
  $("r-arm").textContent = isAlternating(S) ? "N/A" : S.elbowReps.count;
  $("m-energy").textContent = snap.energy ? snap.energy.toFixed(2) : "—";
  $("g-energy").style.width = `${Math.min(100, (snap.energy / 2.2) * 100)}%`;
  const sym = Math.max(0, Math.min(100, 100 - (S.trace.asym.n ? S.trace.asym.mean : 0) * 2));
  $("m-sym").textContent = isAlternating(S) ? "Not assessed" : S.trace.asym.n ? `${Math.round(sym)}%` : "—";
  $("g-sym").style.width = `${isAlternating(S) ? 0 : sym}%`;
  $("m-trunk").textContent = `${Math.round(ang.trunkTilt)}°`;
  $("m-phase").textContent = isAlternating(S) ? "Alternating" : PHASE_WORD[snap.phase] || "Moving";
  const tempo = S.kneeReps.lastTempo ?? S.elbowReps.lastTempo;
  $("m-tempo").textContent = isAlternating(S) ? "N/A" : tempo ? `${tempo.toFixed(1)} s / rep` : "—";
  $("m-clock").textContent = `${Math.floor(S.durSum / 60)}:${String(Math.floor(S.durSum % 60)).padStart(2, "0")}`;
  drawChart(t);
}

/* ---------------- session lifecycle ---------------- */

function stopStream() {
  cancelAnimationFrame(rafId); rafId = 0; mode = null;
  if (camStream) { camStream.getTracks().forEach((tr) => tr.stop()); camStream = null; }
  video.pause(); video.srcObject = null;
  video.removeAttribute("src"); video.onloadeddata = null; video.onended = null; video.onerror = null;
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  video.load();
  lastProcessedVideoTime = -1;
}

function begin(nextMode) {
  stopStream();
  mode = nextMode;
  resetSession();
  emptyEl.hidden = true;
  video.hidden = nextMode === "demo";
  $("b-stop").hidden = false;
  $("source-note").textContent = nextMode === "demo"
    ? "Synthetic demonstration running. Simulated landmarks feed the same analysis as the camera."
    : "";
  rafId = requestAnimationFrame(loop);
}

function loop(now) {
  if (!mode || !S) return;
  rafId = requestAnimationFrame(loop);
  const t = (now - S.startedAt) / 1000;
  const stageW = overlay.clientWidth, stageH = overlay.clientHeight;

  if (mode === "demo") {
    const rect = containRect(1280, 720, stageW, stageH);
    processLandmarks(demoLandmarks(t), t, 1280, 720, rect);
    if (t >= DEMO_DURATION_SECONDS) endSession();
    return;
  }
  if (!pose || video.readyState < 2 || !video.videoWidth) return;
  const ts = Math.max(performance.now(), lastDetectTs + 1);
  if (video.currentTime === lastProcessedVideoTime && mode !== "webcam") return;
  lastProcessedVideoTime = video.currentTime; lastDetectTs = ts;
  const rect = containRect(video.videoWidth, video.videoHeight, stageW, stageH);
  pose.detectForVideo(video, ts, (res) => {
    if (mode && S) processLandmarks(res.landmarks?.[0] ?? null, (performance.now() - S.startedAt) / 1000, video.videoWidth, video.videoHeight, rect);
  });
}

/* ---------------- sources ---------------- */

$("b-demo").onclick = () => begin("demo");

$("b-cam").onclick = async () => {
  if (!requireEngine()) return;
  stopStream();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
  } catch {
    setStatus("Camera was blocked. Allow camera access in the browser, then try again — or run the synthetic demonstration.", "error");
    return;
  }
  begin("webcam");
  video.srcObject = camStream;
  video.onloadeddata = () => video.play().catch(() => {});
};

$("b-upload").onclick = () => { if (requireEngine()) $("file").click(); };
$("file").onchange = () => {
  const f = $("file").files[0];
  if (!f) return;
  begin("file");
  objectUrl = URL.createObjectURL(f);
  video.src = objectUrl;
  video.onerror = () => setStatus("That file could not be played as video. Try an MP4 or WebM clip.", "error");
  video.onloadeddata = () => video.play().catch(() => {});
  video.onended = () => endSession();
  $("file").value = "";
};

$("b-sample").onclick = () => {
  if (!requireEngine()) return;
  $("movement-type").value = "alternating"; // This NASA sample shows treadmill running.
  begin("sample");
  video.src = SAMPLE_CLIP; video.loop = true;
  video.onerror = () => {
    setStatus(`Sample clip not found at ${SAMPLE_CLIP}. See README (“Adding the ISS sample clip”), or use Upload / Webcam.`, "error");
    stopStream(); emptyEl.hidden = false; $("b-stop").hidden = true;
  };
  video.onloadeddata = () => video.play().catch(() => {});
};

$("b-stop").onclick = () => endSession();
$("b-retry-engine").onclick = () => loadEngine();

async function probeSampleClip() {
  try {
    const r = await fetch(SAMPLE_CLIP, { method: "HEAD" });
    if (!r.ok) throw new Error(String(r.status));
    $("sample-hint").textContent = "NASA treadmill running, 19.5 seconds. Running mode is selected automatically. Source and attribution: README.";
  } catch {
    $("b-sample").disabled = true;
    $("sample-hint").textContent = "Not included in this copy — add assets/video/astro-motion.mp4 to enable it (see README). The demonstration, webcam and upload work without it.";
  }
}

/* ---------------- report & synthesis ---------------- */

function sessionStats() {
  if (!S?.trace || S.detected < 5) return null;
  const tel = S.trace.toTelemetry();
  tel.source = mode ?? "unknown";
  return isAlternating(S) ? alternatingTelemetry(tel) : tel;
}

let lastReport = null;
let currentSynthesis = null;
let aiChatHistory = [];

function endSession() {
  const m = sessionStats();
  const wasMode = mode;
  stopStream();
  $("b-stop").hidden = true; emptyEl.hidden = false;
  trackEl.textContent = "Idle"; trackEl.dataset.state = "";

  const note = $("rep-note");
  const heroEl = $("report-hero");
  const execEl = $("report-executive");
  const pillarsEl = $("report-pillars");
  const cuesEl = $("report-cues");
  const repsEl = $("report-reps");
  const microEl = $("report-microgravity");
  const body = $("rep-body");

  // Reset tab to regular analysis
  selectTab("regular");
  $("ai-output").hidden = true;
  $("ai-loading").hidden = true;
  $("ai-chat-history").innerHTML = "";
  aiChatHistory = [];

  if (!m) {
    lastReport = null; currentSynthesis = null;
    note.textContent = "Not enough tracking data to score this session. The whole body needs to be in frame, about 2 m from the camera, in steady light.";
    heroEl.innerHTML = ""; execEl.innerHTML = ""; pillarsEl.innerHTML = "";
    cuesEl.innerHTML = ""; repsEl.innerHTML = ""; microEl.innerHTML = ""; body.innerHTML = "";
  } else if (m.quality < 0.5 || m.durationSeconds < 15) {
    lastReport = null; currentSynthesis = null;
    note.textContent = `Not scored: tracking quality ${Math.round(m.quality * 100)}% over ${Math.round(m.durationSeconds)} s. A scored session needs at least 50% tracking and 15 s.`;
    heroEl.innerHTML = ""; execEl.innerHTML = ""; pillarsEl.innerHTML = "";
    cuesEl.innerHTML = ""; repsEl.innerHTML = ""; microEl.innerHTML = ""; body.innerHTML = "";
  } else if (isAlternating(m)) {
    const synthesis = alternatingSynthesis();
    currentSynthesis = synthesis;
    lastReport = { date: new Date().toISOString(), stats: m, synthesis, aiAnalysis: null, source: wasMode };
    localStorage.setItem("orbiter.lastSession", JSON.stringify(lastReport));
    note.textContent = `Person detected ${Math.round(m.quality * 100)}% · Usable full-body tracking ${Math.round(m.trackedRatio * 100)}% · ${Math.round(m.durationSeconds)} s · Running / alternating movement`;
    heroEl.innerHTML = '<div class="exec-card"><h3>Not scored - alternating movement</h3><p>Bilateral symmetry: not assessed. No readiness grade.</p></div>';
    execEl.textContent = GAIT_LIMIT;
    pillarsEl.innerHTML = ""; cuesEl.innerHTML = ""; repsEl.innerHTML = ""; microEl.innerHTML = "";
    body.innerHTML = `<div class="row"><span>Observed knee angle range, left / right</span><b>${m.rom.lKnee}° / ${m.rom.rKnee}°</b></div><p>Image-space ranges only. Camera angle, occlusion and rotation affect these measurements. They are not gait-quality targets.</p>`;
  } else {
    // Run Algorithmic Synthesis (Mode 1)
    const synthesis = synthesizeSession(m);
    currentSynthesis = synthesis;

    const prev = JSON.parse(localStorage.getItem("orbiter.lastSession") || "null");
    const payload = {
      date: new Date().toISOString(),
      stats: m,
      synthesis,
      aiAnalysis: null,
      source: wasMode,
    };
    localStorage.setItem("orbiter.lastSession", JSON.stringify(payload));
    lastReport = payload;

    note.textContent = `Tracking quality ${Math.round(m.quality * 100)}% · ${Math.round(m.durationSeconds)} s · source: ${wasMode}. Browser pose tracking; optional cloud AI review.`;

    // 1. Render Score Hero
    heroEl.innerHTML = `
      <div class="hero-card">
        <div class="score-badge-circle">
          <span class="num">${synthesis.overallScore}</span>
          <span class="denom">/ 100</span>
        </div>
        <div class="hero-meta">
          <span class="tier-tag">${synthesis.grade} · ${synthesis.tierLabel}</span>
          <h3>${synthesis.headline}</h3>
        </div>
      </div>`;

    // 2. Render Plain-English Executive Summary
    execEl.innerHTML = `
      <div class="exec-card">
        <strong>📋 Executive Clinical Summary:</strong><br>
        ${synthesis.executiveSummary}
      </div>`;

    // 3. Render 4 Core Pillars
    pillarsEl.innerHTML = `
      <div class="pillars-grid">
        ${synthesis.pillars.map((p) => `
          <div class="pillar-card">
            <div class="pillar-head">
              <span class="pillar-title">${p.name}</span>
              <span class="pillar-score">${p.score}/100</span>
            </div>
            <div class="pillar-meter"><i style="width:${p.score}%"></i></div>
            <p class="pillar-desc">${p.summary}</p>
          </div>
        `).join("")}
      </div>`;

    // 4. Render Actionable Coaching Cues
    cuesEl.innerHTML = `
      <div class="cues-section">
        <h3 class="section-title">🎯 Actionable Coaching Prescriptions</h3>
        <div class="cues-list">
          ${synthesis.actionableCues.map((c) => `
            <div class="cue-card">
              <span class="cue-icon">${c.icon}</span>
              <div class="cue-content">
                <strong>${c.title}</strong>
                <p>${c.cue}</p>
              </div>
            </div>
          `).join("")}
        </div>
      </div>`;

    // 5. Render Rep-by-Rep Breakdown Table
    if (synthesis.repTable.length > 0) {
      repsEl.innerHTML = `
        <div class="cues-section">
          <h3 class="section-title">📊 Repetition Kinematics Breakdown</h3>
          <div class="rep-table-wrap">
            <table class="rep-table">
              <thead>
                <tr>
                  <th>Rep #</th>
                  <th>Tempo (Down / Up)</th>
                  <th>Peak Flexion</th>
                  <th>Trunk Lean</th>
                  <th>Bilateral Delta</th>
                  <th>Status Flags</th>
                </tr>
              </thead>
              <tbody>
                ${synthesis.repTable.map((r) => `
                  <tr>
                    <td class="mono"><strong>#${r.repNum}</strong> (${r.kind})</td>
                    <td class="mono">${r.tempoStr}</td>
                    <td class="mono">${r.depthStr}</td>
                    <td class="mono">${r.trunkLean}</td>
                    <td class="mono">${r.asymmetryStr}</td>
                    <td>${r.tags.map((t) => `<span class="tag-pill ${t.type}">${t.label}</span>`).join(" ")}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>`;
    } else {
      repsEl.innerHTML = "";
    }

    // 6. Render Microgravity / ARED Context
    microEl.innerHTML = `
      <div class="cues-section">
        <h3 class="section-title">🛰️ ISS Countermeasure Assessment (ARED / T2 / CEVIS)</h3>
        <div class="micro-grid">
          <div class="micro-card">
            <div class="label">Bone Stimulus Rating</div>
            <div class="val">${synthesis.microgravityContext.boneStimulusRating}</div>
          </div>
          <div class="micro-card">
            <div class="label">Neuromuscular Fatigue</div>
            <div class="val">${synthesis.microgravityContext.neuromuscularFatigue}</div>
          </div>
          <div class="micro-card">
            <div class="label">ARED Load Suitability</div>
            <div class="val">${synthesis.microgravityContext.aredSuitability}</div>
          </div>
          <div class="micro-card">
            <div class="label">Axial Loading Index</div>
            <div class="val">${synthesis.microgravityContext.axialLoadingIndex}</div>
          </div>
        </div>
      </div>`;

    // 7. Baseline Delta Details (Comparison vs last session)
    const delta = (cur, old, invert = false) => {
      if (old === undefined || old === null || !old) return "";
      const pct = Math.round(((cur - old) / Math.abs(old)) * 100);
      const good = invert ? pct < 0 : pct > 0;
      return ` <span class="delta ${good ? "good" : "warn"}">${pct >= 0 ? "+" : ""}${pct}% vs your last session</span>`;
    };
    const prevStats = isAlternating(prev?.stats) ? null : prev?.stats || prev;
    body.innerHTML = `
      <div class="row"><span>Squat reps (knee cycle)</span><b>${m.reps.squat.count}${delta(m.reps.squat.count, prevStats?.reps?.knee ?? prevStats?.reps?.squat?.count)}</b></div>
      <div class="row"><span>Arm reps (elbow cycle)</span><b>${m.reps.arm.count}${delta(m.reps.arm.count, prevStats?.reps?.elbow ?? prevStats?.reps?.arm?.count)}</b></div>
      <div class="row"><span>Range of motion — knees, left / right</span><b>${m.rom.lKnee}° / ${m.rom.rKnee}°</b></div>
      <div class="row"><span>Range of motion — hips, left / right</span><b>${m.rom.lHip}° / ${m.rom.rHip}°</b></div>
      <div class="row"><span>Range of motion — elbows, left / right</span><b>${m.rom.lElbow}° / ${m.rom.rElbow}°</b></div>
      <div class="row"><span>Trunk inclination (mean / peak)</span><b>${Math.round(m.kinematics.trunkLean.mean)}° / ${Math.round(m.kinematics.trunkLean.peak)}°</b></div>
      <div class="row"><span>Movement energy (torso-normalised speed)</span><b>${m.energy.toFixed(2)}${delta(m.energy, prevStats?.energy)}</b></div>
      <div class="row"><span>Movement smoothness</span><b>${Math.round(m.smoothness)} / 100${delta(Math.round(m.smoothness), prevStats && Math.round(prevStats.smoothness))}</b></div>
      <div class="row"><span>Bilateral asymmetry</span><b>${m.asymmetryDeg.toFixed(1)}° average${delta(m.asymmetryDeg, prevStats && (prevStats.asymmetryDeg), true)}</b></div>`;
  }

  $("b-export").disabled = !lastReport;
  $("report").showModal();
}

/* ---------------- Tabs & AI Deep Analysis ---------------- */

function selectTab(tab) {
  if (tab === "regular") {
    $("tab-btn-regular").classList.add("active");
    $("tab-btn-regular").setAttribute("aria-selected", "true");
    $("tab-btn-ai").classList.remove("active");
    $("tab-btn-ai").setAttribute("aria-selected", "false");
    $("tab-regular").hidden = false;
    $("tab-ai").hidden = true;
  } else {
    $("tab-btn-ai").classList.add("active");
    $("tab-btn-ai").setAttribute("aria-selected", "true");
    $("tab-btn-regular").classList.remove("active");
    $("tab-btn-regular").setAttribute("aria-selected", "false");
    $("tab-ai").hidden = false;
    $("tab-regular").hidden = true;
  }
}

$("tab-btn-regular").onclick = () => selectTab("regular");
$("tab-btn-ai").onclick = () => selectTab("ai");

// AI Provider Configuration Setup
const savedProvider = localStorage.getItem("orbiter.aiProvider") || "hosted";
// Remove legacy persisted keys. Credentials now live in this tab only.
localStorage.removeItem("orbiter.aiKey");
const savedKey = "";
const savedEndpoint = localStorage.getItem("orbiter.aiEndpoint") || "";

$("ai-provider-select").value = savedProvider;
$("ai-api-key").value = savedKey;
$("ai-endpoint-url").value = savedEndpoint;

function updateProviderVisibility() {
  const p = $("ai-provider-select").value;
  $("ai-key-container").hidden = p === "offline" || p === "hosted";
  $("ai-endpoint-container").hidden = p !== "custom";
}
$("ai-provider-select").onchange = (e) => {
  localStorage.setItem("orbiter.aiProvider", e.target.value);
  updateProviderVisibility();
};
updateProviderVisibility();

// No key persistence: closing or reloading this page clears the key field.
$("ai-endpoint-url").oninput = (e) => localStorage.setItem("orbiter.aiEndpoint", e.target.value);

// Simple markdown to HTML formatter for AI output
function renderMarkdown(md) {
  return md
    .replaceAll(/&/g, "&amp;").replaceAll(/</g, "&lt;").replaceAll(/>/g, "&gt;")
    .replaceAll(/^### (.*$)/gim, "<h3>$1</h3>")
    .replaceAll(/^#### (.*$)/gim, "<h4>$1</h4>")
    .replaceAll(/^---$/gim, "<hr>")
    .replaceAll(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replaceAll(/`([^`]+)`/gim, "<code>$1</code>")
    .replaceAll(/^\* (.*$)/gim, "<li>$1</li>")
    .replaceAll(/^[0-9]+\. (.*$)/gim, "<li>$1</li>")
    .replaceAll(/(<li>.*<\/li>)/gim, "<ul>$1</ul>")
    .replaceAll(/\n{2,}/gim, "<br><br>");
}

// Run Deeper AI Analysis Button
$("b-run-ai").onclick = async () => {
  if (!lastReport || !currentSynthesis) return;

  const provider = $("ai-provider-select").value;
  const apiKey = $("ai-api-key").value.trim();
  const customEndpoint = $("ai-endpoint-url").value.trim();
  const customNotes = $("ai-notes-input").value.trim();

  $("ai-loading").hidden = false;
  $("ai-output").hidden = true;
  $("b-run-ai").disabled = true;

  try {
    const res = await runAIDeepAnalysis({
      session: lastReport.stats,
      synthesis: currentSynthesis,
      provider,
      apiKey,
      customEndpoint,
      customNotes,
    });

    $("ai-provider-badge").textContent = res.providerUsed;
    $("ai-timestamp").textContent = new Date().toLocaleTimeString();
    $("ai-markdown-content").innerHTML = renderMarkdown(res.markdown);
    $("ai-output").hidden = false;

    // Cache to session export
    lastReport.aiAnalysis = res;
    localStorage.setItem("orbiter.lastSession", JSON.stringify(lastReport));
  } catch (err) {
    alert("AI Analysis encountered an error: " + err.message);
  } finally {
    $("ai-loading").hidden = true;
    $("b-run-ai").disabled = false;
  }
};

// Interactive Ask Flight Surgeon Follow-Up
$("b-ask-ai").onclick = async () => {
  const q = $("ai-chat-question").value.trim();
  if (!q || !lastReport) return;

  const chatContainer = $("ai-chat-history");
  chatContainer.innerHTML += `<div class="chat-msg user"><strong>Astronaut:</strong> ${q}</div>`;
  $("ai-chat-question").value = "";
  chatContainer.scrollTop = chatContainer.scrollHeight;

  const provider = $("ai-provider-select").value;
  const apiKey = $("ai-api-key").value.trim();
  const customEndpoint = $("ai-endpoint-url").value.trim();

  const loadingId = "chat-loading-" + Date.now();
  chatContainer.innerHTML += `<div class="chat-msg assistant" id="${loadingId}">Flight Surgeon typing…</div>`;
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const answer = await askAIFlightSurgeon({
      question: q,
      chatHistory: aiChatHistory,
      session: lastReport.stats,
      synthesis: currentSynthesis,
      provider,
      apiKey,
      customEndpoint,
    });

    const el = document.getElementById(loadingId);
    if (el) el.innerHTML = `<strong>Flight Surgeon:</strong> ${renderMarkdown(answer)}`;
    aiChatHistory.push({ role: "user", text: q });
    aiChatHistory.push({ role: "assistant", text: answer });
    chatContainer.scrollTop = chatContainer.scrollHeight;
  } catch (err) {
    const el = document.getElementById(loadingId);
    if (el) el.innerHTML = `<span style="color:var(--red);">Error getting response: ${err.message}</span>`;
  }
};

$("ai-chat-question").onkeydown = (e) => {
  if (e.key === "Enter") $("b-ask-ai").click();
};

/* ---------------- export & close ---------------- */

$("b-export").onclick = () => {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `orbiter-session-${lastReport.date.slice(0, 19).replaceAll(":", "-")}.json`;
  a.click(); URL.revokeObjectURL(a.href);
};
$("b-close-report").onclick = () => $("report").close();

// Headless self-check: /?autotest=1 starts the demo and reports frames in the title.
if (new URLSearchParams(location.search).has("autotest")) {
  $("b-demo").click();
  const started = Date.now();
  const iv = setInterval(() => {
    if ((S && S.frames > 120) || Date.now() - started > 30000) {
      clearInterval(iv);
      document.title = `AUTOTEST frames=${S ? S.frames : 0} detected=${S ? S.detected : 0} kneeReps=${S ? S.kneeReps.count : 0} elbowReps=${S ? S.elbowReps.count : 0}`;
    }
  }, 500);
}

window.__orbiter = () => (S ? {
  frames: S.frames,
  detected: S.detected,
  kneeReps: S.kneeReps.count,
  elbowReps: S.elbowReps.count,
  trunkLean: S.latestAngles?.trunkTilt,
  com: S.latestCom,
  mode
} : null);

drawChart(0);
loadEngine();
probeSampleClip();
