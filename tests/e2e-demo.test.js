import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jointAngles, RepCounter, AdvancedRepCounter, Ema, asymmetryDeg, symmetryPercent,
  computeCenterOfMass, detectKneeValgus
} from "../assets/js/pose-math.js";
import { demoLandmarks, DEMO_DURATION_SECONDS } from "../assets/js/demo-pose.js";
import { synthesizeSession } from "../assets/js/synthesis.js";
import { runAIDeepAnalysis, askAIFlightSurgeon } from "../assets/js/ai-coach.js";

test("End-to-End Simulation: synthetic demonstration produces full telemetry, synthesis, and AI analysis", async () => {
  const kneeReps = new AdvancedRepCounter({ minRom: 15, minCycleSeconds: 0.7, kind: "squat" });
  const elbowReps = new AdvancedRepCounter({ minRom: 15, minCycleSeconds: 0.7, kind: "arm" });
  const kneeEma = new Ema(0.35);
  const elbowEma = new Ema(0.35);

  const rom = {
    lKnee: [Infinity, -Infinity], rKnee: [Infinity, -Infinity],
    lElbow: [Infinity, -Infinity], rElbow: [Infinity, -Infinity],
    lHip: [Infinity, -Infinity], rHip: [Infinity, -Infinity],
    trunkTilt: [Infinity, -Infinity],
  };

  let asymSum = 0, asymN = 0;
  let trunkLeanSum = 0, trunkLeanPeak = 0, trunkLeanN = 0;
  let valgusCount = 0;
  const comHistory = [];

  const fps = 30;
  const totalFrames = DEMO_DURATION_SECONDS * fps;

  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    const lm = demoLandmarks(t);
    const ang = jointAngles(lm, 1280, 720);

    for (const k in ang) {
      if (rom[k]) {
        if (ang[k] < rom[k][0]) rom[k][0] = ang[k];
        if (ang[k] > rom[k][1]) rom[k][1] = ang[k];
      }
    }

    const com = computeCenterOfMass(lm);
    comHistory.push({ t, x: com.x, y: com.y });

    const valgus = detectKneeValgus(lm);
    if (valgus.valgusWarning) valgusCount++;

    trunkLeanSum += ang.trunkTilt;
    trunkLeanN++;
    if (ang.trunkTilt > trunkLeanPeak) trunkLeanPeak = ang.trunkTilt;

    const frameCtx = {
      trunkTilt: ang.trunkTilt,
      valgusWarning: valgus.valgusWarning,
      asymmetryDeg: asymmetryDeg(ang),
    };

    kneeReps.update(kneeEma.update((ang.lKnee + ang.rKnee) / 2), t, frameCtx);
    elbowReps.update(elbowEma.update((ang.lElbow + ang.rElbow) / 2), t, frameCtx);

    asymSum += asymmetryDeg(ang);
    asymN++;
  }

  assert.ok(kneeReps.count >= 4, `expected >=4 squat reps, got ${kneeReps.count}`);
  assert.ok(elbowReps.count >= 3, `expected >=3 arm reps, got ${elbowReps.count}`);
  assert.ok(kneeReps.reps.length >= 4, `expected detailed rep records for squats`);

  // Package session stats
  const calculatedRom = {};
  for (const k in rom) calculatedRom[k] = Math.round(Math.max(0, rom[k][1] - rom[k][0]));

  const stats = {
    quality: 1.0,
    durationSeconds: DEMO_DURATION_SECONDS,
    rom: calculatedRom,
    energy: 1.1,
    smoothness: 92,
    asymmetryDeg: asymN ? asymSum / asymN : 0,
    reps: {
      squat: { count: kneeReps.count, reps: kneeReps.reps },
      arm: { count: elbowReps.count, reps: elbowReps.reps },
    },
    kinematics: {
      trunkLean: { mean: trunkLeanSum / trunkLeanN, peak: trunkLeanPeak },
      valgusEvents: valgusCount,
      comSway: { stdDevX: 0.015, samples: comHistory.length },
    },
    source: "demo",
  };

  // Run Mode 1: Algorithmic Synthesis
  const synthesis = synthesizeSession(stats);
  assert.ok(synthesis.overallScore > 75);
  assert.ok(synthesis.executiveSummary.length > 50);
  assert.equal(synthesis.pillars.length, 4);
  assert.ok(synthesis.actionableCues.length >= 2);
  assert.ok(synthesis.repTable.length >= 4);

  // Run Mode 2: Deeper AI Analysis
  const aiResult = await runAIDeepAnalysis({
    session: stats,
    synthesis,
    provider: "offline",
    customNotes: "Checking symmetry on ascent",
  });

  assert.ok(aiResult.markdown.includes("Flight Surgeon"));
  assert.ok(aiResult.markdown.includes("Response to Astronaut Note"));

  // Run interactive Q&A
  const qaAnswer = await askAIFlightSurgeon({
    question: "How was my trunk posture during squats?",
    session: stats,
    synthesis,
  });

  assert.ok(qaAnswer.includes("trunk") || qaAnswer.includes("spine"));
});
