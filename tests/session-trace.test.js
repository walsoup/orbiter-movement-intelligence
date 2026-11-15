import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionTrace, describeLive } from "../assets/js/session-trace.js";
import { demoLandmarks } from "../assets/js/demo-pose.js";
import { synthesizeSession } from "../assets/js/synthesis.js";

test("SessionTrace records a full-body session the report can say in words", () => {
  const trace = new SessionTrace();
  let last = null;
  for (let t = 0; t <= 30; t += 1 / 30) last = trace.observe(demoLandmarks(t), t, 1280, 720);

  assert.ok(trace.squat.count >= 4, `expected squat reps, got ${trace.squat.count}`);
  assert.ok(trace.arm.count >= 3, `expected arm reps, got ${trace.arm.count}`);
  assert.ok(last.ang.lAnkle > 0);
  assert.equal(typeof last.ang.pelvicObliquity, "number");

  const tel = trace.toTelemetry();
  assert.equal(typeof tel.energy, "number");
  assert.equal(typeof tel.smoothness, "number");
  assert.ok(tel.rom.lKnee > 40);
  assert.ok(tel.rom.lHip > 10);
  assert.ok(tel.rom.lAnkle > 0);
  assert.ok(tel.posture.stanceMean > 0.8);
  assert.ok(tel.kinematics.comSway.samples > 10);
  assert.equal(typeof tel.kinematics.comSway.stdDevX, "number");
  assert.ok(tel.reps.squat.reps.length >= 4);
  assert.ok(tel.reps.squat.reps[0].eccentricDuration >= 0);

  const report = synthesizeSession(tel);
  assert.ok(report.overallScore >= 60 && report.overallScore <= 100);
  assert.match(report.executiveSummary, /squat/i);
  assert.match(report.executiveSummary, /knee/i);
  assert.match(report.executiveSummary, /seconds/i);
  assert.equal(report.pillars.length, 4);
  assert.ok(report.actionableCues.length >= 2);
  assert.equal(typeof report.metrics.deepestKnee, "number");

  const line = describeLive(last);
  assert.match(line, /Knees/);
  assert.match(line, /°/);
});
