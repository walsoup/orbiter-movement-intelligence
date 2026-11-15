import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeSession } from "../assets/js/synthesis.js";
import { runAIDeepAnalysis, askAIFlightSurgeon, AI_PROVIDERS } from "../assets/js/ai-coach.js";

test("synthesizeSession produces rich plain-English summary, 4 pillars, rep table and microgravity ratings", () => {
  const mockTelemetry = {
    durationSeconds: 38.5,
    quality: 0.96,
    reps: {
      squat: {
        count: 6,
        reps: [
          {
            index: 1, kind: "squat", totalDuration: 4.2, eccentricDuration: 2.6, concentricDuration: 1.6,
            minAngle: 79, maxAngle: 172, rom: 93, peakConcentricVel: 120, peakEccentricVel: 90,
            trunkTiltAtDepth: 18, asymmetryAtDepth: 5, flags: ["CLEAN_REP"]
          },
          {
            index: 2, kind: "squat", totalDuration: 4.0, eccentricDuration: 2.5, concentricDuration: 1.5,
            minAngle: 82, maxAngle: 171, rom: 89, peakConcentricVel: 115, peakEccentricVel: 88,
            trunkTiltAtDepth: 20, asymmetryAtDepth: 6, flags: ["CLEAN_REP"]
          },
          {
            index: 3, kind: "squat", totalDuration: 4.1, eccentricDuration: 2.4, concentricDuration: 1.7,
            minAngle: 80, maxAngle: 170, rom: 90, peakConcentricVel: 110, peakEccentricVel: 85,
            trunkTiltAtDepth: 24, asymmetryAtDepth: 8, flags: ["ASYMMETRIC_DRIVE"]
          },
        ],
      },
      arm: { count: 0, reps: [] },
    },
    rom: { lKnee: 88, rKnee: 92, lElbow: 15, rElbow: 15 },
    asymmetryDeg: 6.5,
    trunkTilt: 20,
    kinematics: {
      trunkLean: { mean: 20, peak: 26 },
      valgusEvents: 0,
    },
    smoothness: 88,
  };

  const synthesis = synthesizeSession(mockTelemetry);

  assert.ok(synthesis.overallScore >= 70 && synthesis.overallScore <= 100);
  assert.ok(["A+", "A", "B", "C", "D"].includes(synthesis.grade));
  assert.ok(synthesis.headline.length > 10);
  assert.ok(synthesis.executiveSummary.length > 50);
  assert.equal(synthesis.pillars.length, 4);

  // Check 4 pillars
  const pillarIds = synthesis.pillars.map((p) => p.id);
  assert.deepEqual(pillarIds, ["rom", "symmetry", "tempo", "stability"]);

  // Check rep table
  assert.equal(synthesis.repTable.length, 3);
  assert.equal(synthesis.repTable[0].repNum, 1);
  assert.ok(synthesis.repTable[0].tempoStr.includes("down"));

  // Check actionable cues
  assert.ok(synthesis.actionableCues.length >= 2);
  assert.ok(synthesis.actionableCues[0].title);
  assert.ok(synthesis.actionableCues[0].cue);

  // Check microgravity context
  assert.ok(synthesis.microgravityContext.boneStimulusRating);
  assert.ok(synthesis.microgravityContext.neuromuscularFatigue);
});

test("runAIDeepAnalysis generates flight surgeon review in offline mode", async () => {
  const mockTelemetry = { durationSeconds: 30, quality: 0.95 };
  const mockSynthesis = {
    overallScore: 86,
    grade: "A",
    tierLabel: "Optimal · Mission Ready",
    metrics: { totalSquats: 6, totalArms: 0, symPct: 88, asymDeg: 5.2, avgKneeRom: 84, trunkLeanMean: 17, trunkLeanPeak: 25, smoothness: 86 },
    microgravityContext: { neuromuscularFatigue: "12% velocity loss" },
  };

  const result = await runAIDeepAnalysis({
    session: mockTelemetry,
    synthesis: mockSynthesis,
    provider: AI_PROVIDERS.EXPERT_OFFLINE,
  });

  assert.ok(result.markdown.includes("Flight Surgeon"));
  assert.ok(result.markdown.includes("Biomechanical & Microgravity Adaptation Assessment"));
  assert.ok(result.markdown.includes("Actionable Coaching Prescriptions"));
  assert.equal(result.providerUsed, "Orbiter In-Flight Expert Engine (Offline/Local)");
});

test("askAIFlightSurgeon answers astronaut questions contextually", async () => {
  const mockTelemetry = { durationSeconds: 30, quality: 0.95 };
  const mockSynthesis = {
    overallScore: 84,
    metrics: { totalSquats: 6, totalArms: 0, symPct: 84, asymDeg: 7, avgKneeRom: 82, trunkLeanMean: 19, trunkLeanPeak: 28 },
  };

  const responseBack = await askAIFlightSurgeon({
    question: "Why did my back feel fatigued?",
    session: mockTelemetry,
    synthesis: mockSynthesis,
    provider: AI_PROVIDERS.EXPERT_OFFLINE,
  });

  assert.ok(responseBack.includes("spine") || responseBack.includes("trunk") || responseBack.includes("back"));

  const responseKnee = await askAIFlightSurgeon({
    question: "Did my knees cave in?",
    session: mockTelemetry,
    synthesis: mockSynthesis,
    provider: AI_PROVIDERS.EXPERT_OFFLINE,
  });

  assert.ok(responseKnee.includes("knee") || responseKnee.includes("toes"));
});
