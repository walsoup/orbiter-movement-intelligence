// Pure pose mathematics. No DOM, no MediaPipe — unit-testable in Node and the browser.
//
// v2 expands the v1 core (4 joint angles) to a full-body kinematic set:
// 10 limb joint angles, trunk + neck posture, center of mass, knee-valgus
// tracking, phase-aware rep records and running statistics. All v1 exports
// keep their names and behaviour so existing callers and tests still pass.

export const LANDMARK = {
  nose: 0,
  leftEyeInner: 1, leftEye: 2, leftEyeOuter: 3,
  rightEyeInner: 4, rightEye: 5, rightEyeOuter: 6,
  leftEar: 7, rightEar: 8, mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
};

export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32], [15, 19], [16, 20],
];

export const KEY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const UPPER_JOINTS = [11, 12, 13, 14, 15, 16];
export const LOWER_JOINTS = [23, 24, 25, 26, 27, 28];
const CORE = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

/** Limb joint definitions: metric name -> [proximal, vertex, distal] landmark ids. */
export const JOINT_TRIPLES = {
  lKnee: [23, 25, 27], rKnee: [24, 26, 28],
  lHip: [11, 23, 25], rHip: [12, 24, 26],
  lElbow: [11, 13, 15], rElbow: [12, 14, 16],
  lShoulder: [23, 11, 13], rShoulder: [24, 12, 14],
  lAnkle: [25, 27, 31], rAnkle: [26, 28, 32],
};

/** Left/right metric pairs used for symmetry. Order is stable for reports. */
export const SYMMETRY_PAIRS = [
  ["knee", "lKnee", "rKnee"],
  ["hip", "lHip", "rHip"],
  ["elbow", "lElbow", "rElbow"],
  ["shoulder", "lShoulder", "rShoulder"],
  ["ankle", "lAnkle", "rAnkle"],
];

/** Angle at `b` formed by a-b-c, in degrees. Coordinates are aspect-corrected by W/H. */
export function angleDeg(a, b, c, W = 1, H = 1) {
  const ax = (a.x - b.x) * W, ay = (a.y - b.y) * H;
  const cx = (c.x - b.x) * W, cy = (c.y - b.y) * H;
  const denom = Math.hypot(ax, ay) * Math.hypot(cx, cy);
  if (!denom) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * cx + ay * cy) / denom));
  return (Math.acos(cos) * 180) / Math.PI;
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Trunk / neck posture from landmarks (aspect-corrected by W/H).
 * - trunkTilt: spine (mid-hip -> mid-shoulder) inclination from vertical, degrees.
 *   0 is upright. In a side view this reads forward lean; in a front view,
 *   lateral lean. Always >= 0.
 * - trunkLateral: signed lateral lean, degrees. Positive = shoulders displaced
 *   toward the image right of the hips (subject's left when facing the camera).
 * - neckTilt: mid-shoulder -> nose inclination from vertical, degrees (>= 0).
 *   Large values in a side view suggest forward head posture.
 */
export function trunkMetrics(lm, W = 1, H = 1) {
  const hip = mid(lm[23], lm[24]);
  const sho = mid(lm[11], lm[12]);
  const dx = (sho.x - hip.x) * W, dy = (sho.y - hip.y) * H;
  const trunkLateral = dy === 0 && dx === 0 ? 0 : (Math.atan2(dx, -dy) * 180) / Math.PI;
  const trunkTilt = Math.abs(trunkLateral);
  const nose = lm[0] ?? sho;
  const ndx = (nose.x - sho.x) * W, ndy = (nose.y - sho.y) * H;
  const neckTilt = ndx === 0 && ndy === 0 ? 0 : Math.abs((Math.atan2(ndx, -ndy) * 180) / Math.PI);
  return { trunkTilt, trunkLateral, neckTilt };
}

/** Full-body joint angles plus trunk/neck posture, in degrees. */
export function jointAngles(lm, W, H) {
  const out = {};
  for (const [name, [a, b, c]] of Object.entries(JOINT_TRIPLES)) {
    out[name] = angleDeg(lm[a], lm[b], lm[c], W, H);
  }
  return { ...out, ...trunkMetrics(lm, W, H) };
}

export function coreVisible(lm, threshold = 0.4) {
  return CORE.every((i) => (lm[i]?.visibility ?? 1) > threshold);
}

/**
 * Mean absolute left/right difference, in degrees, across every joint pair
 * present in the input. With the v1 four-key shape this is exactly the v1
 * value; with the v2 full-body shape it also folds in hips, shoulders and
 * ankles.
 */
export function asymmetryDeg(ang) {
  const diffs = [];
  for (const [, l, r] of SYMMETRY_PAIRS) {
    if (typeof ang[l] === "number" && typeof ang[r] === "number") diffs.push(Math.abs(ang[l] - ang[r]));
  }
  if (!diffs.length) return 0;
  return diffs.reduce((s, d) => s + d, 0) / diffs.length;
}

/** Per-pair absolute differences for the pairs present in the input. */
export function symmetryPerJoint(ang) {
  const out = {};
  for (const [name, l, r] of SYMMETRY_PAIRS) {
    if (typeof ang[l] === "number" && typeof ang[r] === "number") out[name] = Math.abs(ang[l] - ang[r]);
  }
  return out;
}

/**
 * Signed per-pair bias (left minus right), in degrees. Persistent non-zero
 * means one side consistently works through a different range — the "which
 * side?" behind the absolute symmetry numbers.
 */
export function sideBias(ang) {
  const out = {};
  for (const [name, l, r] of SYMMETRY_PAIRS) {
    if (typeof ang[l] === "number" && typeof ang[r] === "number") out[name] = ang[l] - ang[r];
  }
  return out;
}

export function symmetryPercent(asymDeg) {
  return Math.max(0, Math.min(100, 100 - asymDeg * 2));
}

/**
 * Auto-calibrating repetition counter.
 * Gates sit at 25% / 75% of the range observed so far, so no hand-tuned
 * angle thresholds are needed per exercise or camera setup.
 */
export class RepCounter {
  constructor({ minRom = 15, minCycleSeconds = 0.7, kind = "squat" } = {}) {
    this.minRom = minRom;
    this.minCycleSeconds = minCycleSeconds;
    this.kind = kind;
    this.count = 0;
    this.state = "extended";
    this.lo = Infinity;
    this.hi = -Infinity;
    this.lastFlip = -Infinity;
    this.lastRepAt = null;
    this.lastTempo = null;
    this.reps = [];
  }

  /** Feed one smoothed angle sample. Returns true when a rep completes. */
  update(angle, tSeconds) {
    if (angle < this.lo) this.lo = angle;
    if (angle > this.hi) this.hi = angle;
    const rom = this.hi - this.lo;
    if (rom < this.minRom) return false;

    const flexGate = this.lo + 0.25 * rom;
    const extendGate = this.hi - 0.25 * rom;

    if (this.state === "extended" && angle < flexGate && tSeconds - this.lastFlip >= this.minCycleSeconds) {
      this.state = "flexed";
      this.lastFlip = tSeconds;
    } else if (this.state === "flexed" && angle > extendGate && tSeconds - this.lastFlip >= this.minCycleSeconds) {
      this.state = "extended";
      this.lastFlip = tSeconds;
      this.count += 1;
      if (this.lastRepAt !== null) this.lastTempo = tSeconds - this.lastRepAt;
      this.lastRepAt = tSeconds;
      return true;
    }
    return false;
  }

  get rom() {
    return this.hi > this.lo ? this.hi - this.lo : 0;
  }
}

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Phase-aware repetition tracker. Same auto-calibrating gates as RepCounter,
 * plus a per-rep kinematic record: eccentric / concentric phase durations,
 * tempo ratio, rep ROM, peak phase velocities, and an optional caller-supplied
 * snapshot (symmetry, trunk lean, ...) taken at the bottom of the rep.
 *
 * currentPhase is one of "extended" | "eccentric" | "inflection" | "concentric".
 */
export class AdvancedRepCounter {
  constructor({ minRom = 15, minCycleSeconds = 0.7, maxReps = 500, kind = "squat" } = {}) {
    this.minRom = minRom;
    this.minCycleSeconds = minCycleSeconds;
    this.maxReps = maxReps;
    this.kind = kind;
    this.count = 0;
    this.state = "extended";
    this.lo = Infinity;
    this.hi = -Infinity;
    this.lastFlip = -Infinity;
    this.lastRepAt = null;
    this.lastTempo = null;
    this.reps = [];
    this._prevA = null;
    this._prevT = null;
    this._vel = 0;
    this._maxA = -Infinity;
    this._repStart = null;
    this._aboveExtendT = null;
    this._inflectionTime = null;
    this._minA = Infinity;
    this._peakEcc = 0;
    this._peakCon = 0;
    this._extras = null;
    this._phase = "extended";
  }

  get rom() {
    return this.hi > this.lo ? this.hi - this.lo : 0;
  }

  get currentPhase() {
    return this._phase;
  }

  _setPhase(angle, extendGate) {
    if (this.state === "extended") {
      this._phase = angle > extendGate ? "extended" : "eccentric";
    } else {
      this._phase = this._vel > 0 ? "concentric" : "inflection";
    }
  }

  /**
   * Feed one smoothed angle sample. Returns the completed rep record, or null.
   * @param {number} angle smoothed joint angle, degrees
   * @param {number} tSeconds session clock, seconds
   * @param {object|null} extras plain-JSON snapshot stored at the rep's bottom
   */
  update(angle, tSeconds, extras = null) {
    if (this._prevA !== null && tSeconds > this._prevT) {
      this._vel = (angle - this._prevA) / Math.max(1e-3, tSeconds - this._prevT);
    } else {
      this._vel = 0;
    }
    this._prevA = angle;
    this._prevT = tSeconds;

    if (angle < this.lo) this.lo = angle;
    if (angle > this.hi) this.hi = angle;
    const rom = this.hi - this.lo;
    if (rom < this.minRom) {
      this._phase = "extended";
      return null;
    }

    const flexGate = this.lo + 0.25 * rom;
    const extendGate = this.hi - 0.25 * rom;
    if (angle > extendGate) this._aboveExtendT = tSeconds;

    if (this.state === "extended") {
      if (angle > this._maxA) this._maxA = angle;
      if (angle < extendGate) this._peakEcc = Math.max(this._peakEcc, -this._vel, 0);
      if (angle < flexGate && tSeconds - this.lastFlip >= this.minCycleSeconds) {
        this.state = "flexed";
        this.lastFlip = tSeconds;
        this._inflectionTime = tSeconds;
        this._minA = angle;
        this._extras = extras ? { ...extras } : null;
        this._repStart = this._aboveExtendT ?? tSeconds;
        this._peakCon = 0;
      }
      this._setPhase(angle, extendGate);
      return null;
    }

    // state === "flexed"
    if (angle < this._minA) {
      this._minA = angle;
      this._inflectionTime = tSeconds;
      if (extras) this._extras = { ...extras };
    }
    if (this._vel > 0) this._peakCon = Math.max(this._peakCon, this._vel);
    if (angle > extendGate && tSeconds - this.lastFlip >= this.minCycleSeconds) {
      this.state = "extended";
      this.lastFlip = tSeconds;
      this.count += 1;
      const ecc = Math.max(0, this._inflectionTime - this._repStart);
      const con = Math.max(0, tSeconds - this._inflectionTime);
      const flags = [];
      if (this._extras?.trunkTilt > 30) flags.push("TRUNK_LEAN");
      if (this._extras?.valgusWarning) flags.push("KNEE_VALGUS");
      if (this._extras?.asymmetryDeg > 10) flags.push("ASYMMETRIC_DRIVE");
      if (ecc < 0.75) flags.push("RAPID_DESCENT");
      // Knee angle above ~120° is still well short of parallel. 90–115° is a real squat.
  if (this.kind === "squat" && this._minA > 120) flags.push("SHALLOW_DEPTH");
      if (!flags.length) flags.push("CLEAN_REP");

      const rep = {
        index: this.count,
        kind: this.kind,
        startTime: r3(this._repStart),
        inflectionTime: r3(this._inflectionTime),
        endTime: r3(tSeconds),
        totalDuration: r3(tSeconds - this._repStart),
        eccentricDuration: r3(ecc),
        concentricDuration: r3(con),
        tempoRatio: con > 0 ? r3(ecc / con) : null,
        minAngle: r1(this._minA),
        maxAngle: r1(this._maxA),
        rom: r1(this._maxA - this._minA),
        peakEccentricVelocity: r1(this._peakEcc),
        peakConcentricVelocity: r1(this._peakCon),
        trunkTiltAtDepth: r1(this._extras?.trunkTilt ?? 0),
        asymmetryAtDepth: r1(this._extras?.asymmetryDeg ?? 0),
        extras: this._extras,
        flags,
      };
      if (this.lastRepAt !== null) this.lastTempo = tSeconds - this.lastRepAt;
      this.lastRepAt = tSeconds;
      this.reps.push(rep);
      if (this.reps.length > this.maxReps) this.reps.shift();
      this._maxA = angle;
      this._peakEcc = 0;
      this._setPhase(angle, extendGate);
      return rep;
    }
    this._setPhase(angle, extendGate);
    return null;
  }
}

/** Exponential moving average for one scalar stream. */
export class Ema {
  constructor(alpha = 0.35) { this.alpha = alpha; this.value = null; }
  update(x) {
    this.value = this.value === null ? x : this.value + this.alpha * (x - this.value);
    return this.value;
  }
}

/** Welford running statistics: O(1) mean / variance / min / max. */
export class RunningStats {
  constructor() {
    this.n = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  push(x) {
    if (!Number.isFinite(x)) return;
    this.n += 1;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (x - this.mean);
  }

  get variance() {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }

  get std() {
    return Math.sqrt(this.variance);
  }

  snapshot() {
    if (!this.n) return { n: 0, mean: 0, std: 0, min: 0, max: 0, rom: 0 };
    return {
      n: this.n,
      mean: r3(this.mean),
      std: r3(this.std),
      min: r1(this.min),
      max: r1(this.max),
      rom: r1(this.max - this.min),
    };
  }
}

/** Aspect-corrected torso length (mid-shoulder to mid-hip), clamped > 0. */
export function torsoLengthPx(lm, W, H) {
  const s = mid(lm[11], lm[12]);
  const h = mid(lm[23], lm[24]);
  return Math.max(1, Math.hypot((s.x - h.x) * W, (s.y - h.y) * H));
}

/**
 * Whole-body center of mass in normalised landmark coordinates, from
 * segment-midpoint weighting with Dempster mass fractions (head 8.1%,
 * trunk 49.7%, upper arms 2.8% each, forearms+hands 2.2% each, thighs 10%
 * each, shanks 4.65% each, feet 1.45% each; sums to 1.0).
 */
export function computeCenterOfMass(lm) {
  const segs = [
    [lm[0], 0.081],
    [mid(mid(lm[11], lm[12]), mid(lm[23], lm[24])), 0.497],
    [mid(lm[11], lm[13]), 0.028], [mid(lm[12], lm[14]), 0.028],
    [mid(lm[13], lm[15]), 0.022], [mid(lm[14], lm[16]), 0.022],
    [mid(lm[23], lm[25]), 0.1], [mid(lm[24], lm[26]), 0.1],
    [mid(lm[25], lm[27]), 0.0465], [mid(lm[26], lm[28]), 0.0465],
    [mid(lm[27], lm[31]), 0.0145], [mid(lm[28], lm[32]), 0.0145],
  ];
  let x = 0, y = 0;
  for (const [p, w] of segs) { x += p.x * w; y += p.y * w; }
  return { x, y };
}

/**
 * Knee valgus/varus estimate per side, meaningful for front-facing sessions.
 * Returns the knee's inward displacement from the hip-ankle line as a ratio
 * of leg length. Positive = inward (valgus direction), negative = outward.
 */
export function detectKneeValgus(lm, W = 1, H = 1) {
  // Positive = the knee sits closer to the body midline than the hip–ankle line
  // (caving in). Negative = the knee is outside that line. This does not depend
  // on which image side is "left", so a mirrored camera and the synthetic demo
  // agree on what "inward" means.
  const midline = ((lm[23].x + lm[24].x) / 2) * W;
  const side = (hip, knee, ankle) => {
    const hx = hip.x * W, hy = hip.y * H;
    const kx = knee.x * W, ky = knee.y * H;
    const ax = ankle.x * W, ay = ankle.y * H;
    const abx = ax - hx, aby = ay - hy;
    const len2 = abx * abx + aby * aby;
    const leg = Math.sqrt(len2);
    if (!leg) return 0;
    const t = ((kx - hx) * abx + (ky - hy) * aby) / len2;
    const lineX = hx + t * abx;
    return (Math.abs(lineX - midline) - Math.abs(kx - midline)) / leg;
  };
  const left = side(lm[23], lm[25], lm[27]);
  const right = side(lm[24], lm[26], lm[28]);
  const worst = r3(Math.max(left, right));
  return { left: r3(left), right: r3(right), worst, valgusWarning: worst > 0.06 };
}

/**
 * Stance width as a scale-free ratio: ankle spread over hip width.
 * ~1 is feet under hips; squats typically read 1.5–2.5.
 */
export function stanceWidthRatio(lm) {
  const hips = Math.abs(lm[23].x - lm[24].x);
  if (hips < 1e-6) return 0;
  return Math.abs(lm[27].x - lm[28].x) / hips;
}

/**
 * Sway metrics over a center-of-mass (or any x/y) trail in normalised units.
 * Lateral (x) sway is the stability signal; vertical (y) motion is expected
 * in squats and hinges, so the axes are reported separately.
 */
export function swayMetrics(points) {
  const n = points.length;
  if (n < 2) return { samples: n, rmsX: 0, rmsY: 0, rms: 0, rangeX: 0, rangeY: 0, pathLength: 0 };
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sx = 0, sy = 0, path = 0;
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    sx += (p.x - mx) ** 2; sy += (p.y - my) ** 2;
    if (p.x < loX) loX = p.x;
    if (p.x > hiX) hiX = p.x;
    if (p.y < loY) loY = p.y;
    if (p.y > hiY) hiY = p.y;
    if (i) path += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
  }
  const rmsX = Math.sqrt(sx / n), rmsY = Math.sqrt(sy / n);
  return {
    samples: n,
    rmsX: r1(rmsX * 1000) / 1000,
    rmsY: r1(rmsY * 1000) / 1000,
    rms: r1(Math.hypot(rmsX, rmsY) * 1000) / 1000,
    rangeX: r1((hiX - loX) * 1000) / 1000,
    rangeY: r1((hiY - loY) * 1000) / 1000,
    pathLength: r3(path),
  };
}

/** Rectangle occupied by a video shown with `object-fit: contain` inside a box. */
export function containRect(srcW, srcH, boxW, boxH) {
  if (!srcW || !srcH || !boxW || !boxH) return { x: 0, y: 0, w: boxW || 0, h: boxH || 0 };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale, h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Map a normalised landmark (0..1) into stage pixel coordinates, honouring letterboxing. */
export function landmarkToStage(point, rect) {
  return { x: rect.x + point.x * rect.w, y: rect.y + point.y * rect.h };
}
