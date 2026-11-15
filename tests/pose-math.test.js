import { test } from "node:test";
import assert from "node:assert/strict";
import {
  angleDeg, RepCounter, AdvancedRepCounter, Ema, asymmetryDeg, symmetryPercent, containRect, landmarkToStage,
  computeCenterOfMass, detectKneeValgus,
} from "../assets/js/pose-math.js";
import { demoLandmarks } from "../assets/js/demo-pose.js";
import { jointAngles } from "../assets/js/pose-math.js";

test("angleDeg: straight line is 180, right angle is 90", () => {
  assert.ok(Math.abs(angleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, 100, 100) - 180) < 0.01);
  assert.ok(Math.abs(angleDeg({ x: 0, y: 0 }, { x: 0, y: 0 + 0 }, { x: 0, y: 1 }, 100, 100) - 90) < 0.01 ||
            Math.abs(angleDeg({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }, 100, 100) - 90) < 0.01);
});

test("RepCounter counts full cycles only, and requires real range of motion", () => {
  const still = new RepCounter();
  for (let t = 0; t < 10; t += 0.1) still.update(170 + Math.sin(t) * 2, t);
  assert.equal(still.count, 0, "jitter under the ROM gate must not count");

  const reps = new RepCounter();
  let completed = 0;
  for (let t = 0; t <= 20; t += 0.05) {
    const angle = 135 + 40 * Math.sin((t / 4) * Math.PI * 2); // 95..175 deg, 4 s cycle
    if (reps.update(angle, t)) completed++;
  }
  assert.equal(completed, reps.count);
  assert.ok(reps.count >= 4 && reps.count <= 5, `expected ~5 reps in 20 s, got ${reps.count}`);
  assert.ok(reps.lastTempo > 3 && reps.lastTempo < 5, `tempo should be ~4 s, got ${reps.lastTempo}`);
});

test("Ema converges and asymmetry/symmetry are bounded", () => {
  const e = new Ema(0.5);
  e.update(0); e.update(100); e.update(100);
  assert.ok(e.value > 70);
  assert.equal(asymmetryDeg({ lKnee: 100, rKnee: 110, lElbow: 90, rElbow: 90 }), 5);
  assert.equal(symmetryPercent(0), 100);
  assert.equal(symmetryPercent(80), 0);
});

test("containRect letterboxes a 4:3 video inside a 16:9 stage", () => {
  const r = containRect(640, 480, 1600, 900);
  assert.equal(r.h, 900);
  assert.equal(r.w, 1200);
  assert.equal(r.x, 200);
  assert.deepEqual(landmarkToStage({ x: 0.5, y: 0.5 }, r), { x: 800, y: 450 });
  const exact = containRect(1280, 720, 1280, 720);
  assert.deepEqual(exact, { x: 0, y: 0, w: 1280, h: 720 });
});

test("synthetic demo pose produces countable knee and elbow motion", () => {
  const knee = new RepCounter(), elbow = new RepCounter();
  const kneeEma = new Ema(0.35), elbowEma = new Ema(0.35);
  for (let t = 0; t <= 30; t += 1 / 30) {
    const ang = jointAngles(demoLandmarks(t), 1280, 720);
    knee.update(kneeEma.update((ang.lKnee + ang.rKnee) / 2), t);
    elbow.update(elbowEma.update((ang.lElbow + ang.rElbow) / 2), t);
  }
  assert.ok(knee.count >= 4, `demo should yield >=4 squat reps in 30 s, got ${knee.count}`);
  assert.ok(elbow.count >= 3, `demo should yield >=3 arm reps in 30 s, got ${elbow.count}`);
});

test("expanded jointAngles computes hips, trunk tilt and Center of Mass", () => {
  const lm = demoLandmarks(5);
  const ang = jointAngles(lm, 1280, 720);
  assert.ok(typeof ang.lHip === "number" && ang.lHip > 0);
  assert.ok(typeof ang.rHip === "number" && ang.rHip > 0);
  assert.ok(typeof ang.trunkTilt === "number" && ang.trunkTilt >= 0 && ang.trunkTilt <= 90);
  assert.ok(typeof ang.lShoulder === "number");

  const com = computeCenterOfMass(lm);
  assert.ok(com.x > 0.4 && com.x < 0.6, `CoM x should be centered near 0.5, got ${com.x}`);
  assert.ok(com.y > 0.3 && com.y < 0.8, `CoM y should be in body midsection, got ${com.y}`);

  const valgus = detectKneeValgus(lm);
  assert.ok(typeof valgus.valgusWarning === "boolean");
});

test("AdvancedRepCounter records detailed phase durations and flags", () => {
  const reps = new AdvancedRepCounter({ kind: "squat" });
  for (let t = 0; t <= 12; t += 0.05) {
    const angle = 135 + 40 * Math.sin((t / 4) * Math.PI * 2);
    reps.update(angle, t, { trunkTilt: 22, asymmetryDeg: 4 });
  }
  assert.ok(reps.reps.length >= 2, "should have recorded completed reps");
  const rep1 = reps.reps[0];
  assert.equal(rep1.kind, "squat");
  assert.ok(rep1.eccentricDuration > 0);
  assert.ok(rep1.concentricDuration > 0);
  assert.ok(rep1.minAngle < 110);
  assert.ok(rep1.maxAngle > 160);
  assert.ok(Array.isArray(rep1.flags));
});
