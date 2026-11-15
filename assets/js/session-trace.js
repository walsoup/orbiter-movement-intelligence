// Turns a stream of pose landmarks into one session telemetry object.
// The synthesis engine and the on-screen report both read this object,
// so a number that shows up in the report is a number that was measured.

import {
  jointAngles, coreVisible, asymmetryDeg, sideBias,
  AdvancedRepCounter, Ema, RunningStats, computeCenterOfMass, detectKneeValgus,
  stanceWidthRatio, swayMetrics, torsoLengthPx, KEY_JOINTS,
} from "./pose-math.js";

const ANGLE_KEYS = [
  "lKnee", "rKnee", "lHip", "rHip", "lElbow", "rElbow",
  "lShoulder", "rShoulder", "lAnkle", "rAnkle",
  "trunkTilt", "trunkLateral", "neckTilt", "pelvicObliquity", "shoulderObliquity",
];

const PAIRS = [
  ["knee", "lKnee", "rKnee"],
  ["hip", "lHip", "rHip"],
  ["elbow", "lElbow", "rElbow"],
  ["shoulder", "lShoulder", "rShoulder"],
  ["ankle", "lAnkle", "rAnkle"],
];

/** Hip line, degrees off horizontal. Positive = image-right hip lower. */
export function pelvicObliquityDeg(lm, W, H) {
  return lineOffHorizontal(lm[23], lm[24], W, H);
}

/** Shoulder line, degrees off horizontal. */
export function shoulderObliquityDeg(lm, W, H) {
  return lineOffHorizontal(lm[11], lm[12], W, H);
}

function lineOffHorizontal(a, b, W, H) {
  if (!a || !b) return 0;
  const dx = (b.x - a.x) * W;
  const dy = (b.y - a.y) * H;
  if (!dx && !dy) return 0;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
}

/**
 * Center of mass relative to the midpoint of the ankles, in shoulder-widths.
 * Positive = toward image right. About 0 means the weight is stacked over the feet.
 */
export function balanceOffset(lm, W, H) {
  const com = computeCenterOfMass(lm);
  const ax = (lm[27].x + lm[28].x) / 2;
  const sho = Math.max(1e-4, Math.hypot((lm[12].x - lm[11].x) * W, (lm[12].y - lm[11].y) * H));
  return ((com.x - ax) * W) / sho;
}

const PHASE_WORD = {
  eccentric: "Lowering",
  concentric: "Driving up",
  inflection: "At the bottom",
  extended: "Standing tall",
};

/** One sentence a person can read while the set is still going. */
export function describeLive(snap) {
  if (!snap) return "No one in frame.";
  if (!snap.ok) return "Only part of the body is visible. Step back so the hips and knees are in frame.";
  const knee = (snap.ang.lKnee + snap.ang.rKnee) / 2;
  let depth = "legs nearly straight";
  if (knee <= 95) depth = "a deep bend";
  else if (knee <= 115) depth = "about parallel";
  else if (knee <= 145) depth = "a partial bend";
  const phase = PHASE_WORD[snap.phase] || "Moving";
  const knees = snap.valgus.worst > 0.06 ? "knees drifting inward" : "knees tracking over the feet";
  const side = Math.abs(snap.offset) > 0.18 ? "weight shifted to one side" : "weight over the feet";
  const hips = Math.abs(snap.ang.pelvicObliquity) > 6
    ? `hips tilted ${Math.abs(Math.round(snap.ang.pelvicObliquity))}°`
    : "hips level";
  return `${phase}. Knees ${Math.round(knee)}° (${depth}). Chest ${Math.round(snap.ang.trunkTilt)}° off upright. ${knees}. ${hips}. ${side}.`;
}

/**
 * Accumulates one exercise session. Feed every frame; read toTelemetry() at the end.
 * Rep counters are the phase-aware ones, so each rep keeps its own down/up times.
 */
export class SessionTrace {
  constructor() {
    this.frames = 0;
    this.detected = 0;
    this.tracked = 0;
    this.durSum = 0;
    this.prevT = null;
    this.squat = new AdvancedRepCounter({ kind: "squat" });
    this.arm = new AdvancedRepCounter({ kind: "arm" });
    this.kneeEma = new Ema(0.35);
    this.elbowEma = new Ema(0.35);
    this.stats = Object.fromEntries(ANGLE_KEYS.map((k) => [k, new RunningStats()]));
    this.bias = Object.fromEntries(PAIRS.map(([name]) => [name, new RunningStats()]));
    this.asym = new RunningStats();
    this.comPoints = [];
    this.lastComSample = -Infinity;
    this.valgusWorst = new RunningStats();
    this.valgusFrames = 0;
    this.stance = new RunningStats();
    this.balance = new RunningStats();
    this.energySamples = [];
    this.smoothAcc = new RunningStats();
    this.prevLm = null;
    this.prevVel = null;
    this.lastSampleT = null;
    this.hist = [];
    this.repTimes = [];
    this.phase = "extended";
  }

  /**
   * @returns {object|null} the frame, or null when no person was detected
   */
  observe(lm, t, W, H) {
    this.frames += 1;
    if (!lm) return null;
    this.detected += 1;
    if (this.prevT !== null) this.durSum += Math.min(0.5, Math.max(0, t - this.prevT));
    this.prevT = t;

    const ok = coreVisible(lm);
    const ang = jointAngles(lm, W, H);
    ang.pelvicObliquity = pelvicObliquityDeg(lm, W, H);
    ang.shoulderObliquity = shoulderObliquityDeg(lm, W, H);
    const com = computeCenterOfMass(lm);
    const valgus = detectKneeValgus(lm, W, H);
    const stance = stanceWidthRatio(lm);
    const offset = balanceOffset(lm, W, H);

    let kneeRep = null;
    let elbowRep = null;
    let energy = 0;

    // Unknown stays unknown: a partial body does not update ranges or reps.
    if (ok) {
      this.tracked += 1;
      for (const k of ANGLE_KEYS) this.stats[k].push(ang[k]);
      const bias = sideBias(ang);
      for (const [name] of PAIRS) {
        if (typeof bias[name] === "number") this.bias[name].push(bias[name]);
      }
      this.asym.push(asymmetryDeg(ang));
      this.valgusWorst.push(valgus.worst);
      if (valgus.valgusWarning) this.valgusFrames += 1;
      this.stance.push(stance);
      this.balance.push(offset);
      if (t - this.lastComSample >= 0.1) {
        this.comPoints.push({ x: com.x, y: com.y });
        if (this.comPoints.length > 4000) this.comPoints.shift();
        this.lastComSample = t;
      }

      const knee = this.kneeEma.update((ang.lKnee + ang.rKnee) / 2);
      const elbow = this.elbowEma.update((ang.lElbow + ang.rElbow) / 2);
      const extras = {
        trunkTilt: ang.trunkTilt,
        asymmetryDeg: asymmetryDeg(ang),
        valgusWarning: valgus.valgusWarning,
        valgusWorst: valgus.worst,
        balanceOffset: offset,
        pelvicObliquity: ang.pelvicObliquity,
      };
      kneeRep = this.squat.update(knee, t, extras);
      elbowRep = this.arm.update(elbow, t, extras);
      if (kneeRep) this.repTimes.push({ t, kind: "knee" });
      if (elbowRep) this.repTimes.push({ t, kind: "elbow" });
      const leader = this.squat.count >= this.arm.count ? this.squat : this.arm;
      this.phase = leader.currentPhase;
      energy = this._energy(lm, t, W, H);
    }

    this.hist.push({
      t,
      lKnee: ang.lKnee, rKnee: ang.rKnee,
      lHip: ang.lHip, rHip: ang.rHip,
      lElbow: ang.lElbow, rElbow: ang.rElbow,
      lShoulder: ang.lShoulder, rShoulder: ang.rShoulder,
      lAnkle: ang.lAnkle, rAnkle: ang.rAnkle,
      trunkTilt: ang.trunkTilt,
      neckTilt: ang.neckTilt,
      pelvicObliquity: ang.pelvicObliquity,
      balancePlot: offset * 100,
    });
    while (this.hist.length && this.hist[0].t < t - 30) this.hist.shift();

    return { ok, ang, com, valgus, stance, offset, energy, kneeRep, elbowRep, phase: this.phase };
  }

  _energy(lm, t, W, H) {
    if (!this.prevLm) {
      this.prevLm = lm.map((p) => ({ x: p.x, y: p.y }));
      this.lastSampleT = t;
      return 0;
    }
    const dt = Math.max(1 / 120, t - (this.lastSampleT ?? t));
    const torso = torsoLengthPx(lm, W, H);
    let vSum = 0;
    let n = 0;
    const vel = [];
    for (const i of KEY_JOINTS) {
      const prev = this.prevLm[i];
      if (!lm[i] || !prev) { vel.push(0); continue; }
      const v = Math.min(4, (Math.hypot(lm[i].x - prev.x, lm[i].y - prev.y) * H / torso) / dt);
      vel.push(v);
      vSum += v;
      n += 1;
    }
    const energy = n ? vSum / n : 0;
    this.energySamples.push({ t, e: energy });
    if (this.prevVel && this.prevVel.length === vel.length) {
      let aSum = 0;
      for (let i = 0; i < vel.length; i++) aSum += Math.abs(vel[i] - this.prevVel[i]);
      this.smoothAcc.push((aSum / vel.length) / dt);
    }
    this.prevVel = vel;
    this.prevLm = lm.map((p) => (p ? { x: p.x, y: p.y } : null));
    this.lastSampleT = t;
    return energy;
  }

  /** Telemetry object consumed by synthesizeSession. */
  toTelemetry() {
    const angles = {};
    for (const [k, s] of Object.entries(this.stats)) angles[k] = s.snapshot();

    const perJoint = {};
    const signedBias = {};
    for (const [name, l, r] of PAIRS) {
      if (this.stats[l].n && this.stats[r].n) {
        perJoint[name] = Math.round(Math.abs(this.stats[l].mean - this.stats[r].mean) * 10) / 10;
      }
      if (this.bias[name].n) signedBias[name] = Math.round(this.bias[name].mean * 10) / 10;
    }

    const energies = this.energySamples;
    const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const midT = energies.length ? (energies[0].t + energies[energies.length - 1].t) / 2 : 0;
    const first = energies.filter((s) => s.t <= midT).map((s) => s.e);
    const second = energies.filter((s) => s.t > midT).map((s) => s.e);
    const e1 = meanOf(first);
    const e2 = meanOf(second);
    const fatigueDropPct = e1 > 0.05 ? Math.max(0, Math.round(((e1 - e2) / e1) * 100)) : 0;
    const activePct = energies.length
      ? Math.round((100 * energies.filter((s) => s.e > 0.35).length) / energies.length)
      : 0;
    const smooth = this.smoothAcc.n
      ? Math.max(0, Math.min(100, Math.round(100 - this.smoothAcc.mean * 8)))
      : 0;
    const sway = swayMetrics(this.comPoints);
    const peakAbs = (stat) => (stat?.n ? Math.max(Math.abs(stat.min), Math.abs(stat.max)) : 0);

    return {
      version: 2,
      quality: this.frames ? this.detected / this.frames : 0,
      trackedRatio: this.frames ? this.tracked / this.frames : 0,
      durationSeconds: this.durSum,
      angles,
      symmetry: {
        overall: this.asym.n ? Math.round(this.asym.mean * 10) / 10 : 0,
        perJoint,
        signedBias,
      },
      reps: {
        squat: { count: this.squat.count, records: this.squat.reps, reps: this.squat.reps },
        arm: { count: this.arm.count, records: this.arm.reps, reps: this.arm.reps },
      },
      posture: {
        trunkTiltMax: angles.trunkTilt?.max ?? 0,
        trunkTiltMean: angles.trunkTilt?.mean ?? 0,
        neckTiltMean: angles.neckTilt?.mean ?? 0,
        pelvicObliquityPeak: Math.round(peakAbs(this.stats.pelvicObliquity) * 10) / 10,
        shoulderObliquityPeak: Math.round(peakAbs(this.stats.shoulderObliquity) * 10) / 10,
        stanceMean: this.stance.n ? Math.round(this.stance.mean * 100) / 100 : 0,
        balanceRange: this.balance.n ? Math.round((this.balance.max - this.balance.min) * 1000) / 1000 : 0,
      },
      valgus: {
        meanWorst: this.valgusWorst.n ? Math.round(Math.max(0, this.valgusWorst.mean) * 1000) / 1000 : 0,
        peak: this.valgusWorst.n ? Math.round(Math.max(0, this.valgusWorst.max) * 1000) / 1000 : 0,
        pct: this.tracked ? Math.round((this.valgusFrames / this.tracked) * 1000) / 10 : 0,
      },
      // Numbers, not objects: the live page and the report print these directly.
      energy: Math.round(meanOf(energies.map((s) => s.e)) * 1000) / 1000,
      energyDetail: { activePct, fatigueDropPct },
      smoothness: smooth,
      rom: Object.fromEntries(Object.entries(angles).map(([k, s]) => [k, Math.round(s.rom)])),
      asymmetryDeg: this.asym.n ? this.asym.mean : 0,
      kinematics: {
        trunkLean: { mean: angles.trunkTilt?.mean ?? 0, peak: angles.trunkTilt?.max ?? 0 },
        valgusEvents: this.valgusFrames,
        comSway: {
          stdDevX: sway.rmsX,
          rangeX: sway.rangeX,
          rmsX: sway.rmsX,
          samples: sway.samples,
          pathLength: sway.pathLength,
        },
      },
    };
  }
}
