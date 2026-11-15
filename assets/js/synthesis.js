// Mode 1: deterministic algorithmic synthesis. No DOM, no network — pure
// functions that turn session telemetry into a plain-language report: an
// overall score, 4 pillar breakdowns, a letter grade, a rep-by-rep table,
// coaching cues and a microgravity countermeasure assessment.
//
// Input telemetry shape (built by app.js sessionStats(), also used by tests):
//   { quality, durationSeconds, rom: {lKnee, rKnee, ...} (numbers, degrees),
//     energy, smoothness (0-100), asymmetryDeg,
//     reps: { squat: {count, reps: [...]}, arm: {count, reps: [...]} },
//     kinematics: { trunkLean: {mean, peak}, valgusEvents, comSway: {stdDevX} } }
//
// Rep records carry: index, kind, totalDuration, eccentricDuration,
// concentricDuration, tempoRatio, minAngle, maxAngle, rom,
// peakEccentricVelocity / peakEccentricVel, peakConcentricVelocity /
// peakConcentricVel, trunkTiltAtDepth, asymmetryAtDepth, flags[].
// Both peak-velocity namings are accepted; missing fields degrade gracefully.
//
// All thresholds are v1 heuristics, documented next to the rule that uses
// them. They are calibrated on the synthetic demo (knee ROM ~77°, asymmetry
// ~4°, 8 squats / 7 arm reps per 40 s) plus general exercise guidance, and
// should be revisited once real astronaut sessions exist.

export const SYNTHESIS_VERSION = 2;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

export function gradeFor(score) {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}

const TIER_LABELS = {
  "A+": "Peak · Mission-Ready",
  A: "Optimal · Mission-Ready",
  B: "Solid · Developing Toward Mission-Ready",
  C: "Fair · Needs Focused Work",
  D: "At Risk · Intervention Recommended",
};

const meanPair = (rom, l, r) => {
  const xs = [rom[l], rom[r]].filter((v) => typeof v === "number");
  return xs.length ? mean(xs) : 0;
};

const peakVel = (rep, phase) => {
  const long = phase === "con" ? rep.peakConcentricVelocity : rep.peakEccentricVelocity;
  const short = phase === "con" ? rep.peakConcentricVel : rep.peakEccentricVel;
  return typeof long === "number" ? long : typeof short === "number" ? short : 0;
};

const FLAG_PILLS = {
  CLEAN_REP: { type: "good", label: "Clean" },
  ASYMMETRIC_DRIVE: { type: "warn", label: "Asymmetric" },
  KNEE_VALGUS: { type: "bad", label: "Valgus" },
  TRUNK_LEAN: { type: "warn", label: "Trunk lean" },
  RAPID_DESCENT: { type: "warn", label: "Fast drop" },
  SHALLOW_DEPTH: { type: "warn", label: "Shallow" },
};

/**
 * @param {object} d session telemetry (see header)
 * @returns {object} synthesis report (JSON-safe)
 */
export function synthesizeSession(d) {
  const rom = d.rom ?? {};
  const reps = d.reps ?? {};
  const kinematics = d.kinematics ?? {};
  const trunkLean = kinematics.trunkLean ?? {};
  const squat = reps.squat ?? { count: 0, reps: [] };
  const arm = reps.arm ?? { count: 0, reps: [] };
  const squatReps = squat.reps ?? [];
  const armReps = arm.reps ?? [];
  const allReps = [...squatReps, ...armReps];
  const asym = d.asymmetryDeg ?? 0;

  const avgKneeRom = meanPair(rom, "lKnee", "rKnee");
  const avgHipRom = meanPair(rom, "lHip", "rHip");
  const avgShoulderRom = meanPair(rom, "lShoulder", "rShoulder");
  const avgElbowRom = meanPair(rom, "lElbow", "rElbow");

  // ---- Pillar 1: ROM. Primary mover = the kind with more reps; full marks
  // at reference ranges (knee 85°, hip 60°, shoulder 110°, elbow 70°).
  const squatFirst = (squat.count ?? 0) >= (arm.count ?? 0);
  let romScore, romSummary;
  if (squatFirst && (squat.count ?? 0) > 0) {
    const kneePart = clamp(avgKneeRom / 85, 0, 1) * 100;
    const hipPart = clamp(avgHipRom / 60, 0, 1) * 100;
    romScore = Math.round(avgHipRom > 0 ? kneePart * 0.7 + hipPart * 0.3 : kneePart);
    romSummary = `The knees traveled ${Math.round(avgKneeRom)}° from straight to bent${avgHipRom > 0 ? `, and the hips ${Math.round(avgHipRom)}°` : ""}, over ${squat.count} squat${squat.count === 1 ? "" : "s"}.`;
  } else if ((arm.count ?? 0) > 0) {
    romScore = Math.round(mean([
      clamp(avgShoulderRom / 110, 0, 1) * 100,
      clamp(avgElbowRom / 70, 0, 1) * 100,
    ]));
    romSummary = `The shoulders traveled ${Math.round(avgShoulderRom)}° and the elbows ${Math.round(avgElbowRom)}°, over ${arm.count} arm raise${arm.count === 1 ? "" : "s"}.`;
  } else {
    romScore = 15;
    romSummary = "No full repetition was counted, so there is no range of motion to describe.";
  }
  const avgAnkleRom = meanPair(rom, "lAnkle", "rAnkle");
  if (avgAnkleRom >= 8) romSummary += ` The ankles moved ${Math.round(avgAnkleRom)}° as well.`;
  if (typeof rom.neckTilt === "number" && rom.neckTilt >= 8) romSummary += ` The head moved through ${Math.round(rom.neckTilt)}°.`;

  // ---- Pillar 2: symmetry. Each degree of mean L/R gap costs 3 points.
  const symScore = Math.round(clamp(100 - asym * 3, 0, 100));
  const symSummary = asym < 6
    ? `Left and right stayed close, about ${r1(asym)}° apart.`
    : asym < 12
      ? `Left and right were a little uneven, about ${r1(asym)}° apart.`
      : `One side was working noticeably harder, about ${r1(asym)}° apart.`;

  // ---- Pillar 3: tempo. 60% pacing consistency, 40% lowering control.
  // Reps with zero eccentric time are first-rep calibration artifacts and are
  // excluded from the control stat but kept in the table.
  const valid = allReps.filter((r) => (r.totalDuration ?? 0) > 0.5);
  let tempoScore, tempoSummary;
  if (valid.length >= 2) {
    // Consistency is per exercise kind: squats and arm raises have different
    // natural paces, so mixing them would punish multi-exercise sessions.
    const byKind = {};
    for (const r of valid) (byKind[r.kind ?? "squat"] ??= []).push(r.totalDuration);
    const groupCVs = Object.values(byKind).filter((t) => t.length >= 2)
      .map((t) => std(t) / Math.max(0.01, mean(t)));
    const totals = valid.map((r) => r.totalDuration);
    const cv = groupCVs.length ? mean(groupCVs)
      : std(totals) / Math.max(0.01, mean(totals));
    const consistency = clamp(100 - cv * 300, 0, 100);
    const controlled = valid.filter((r) => (r.eccentricDuration ?? 0) > 0);
    const crashFrac = controlled.length
      ? controlled.filter((r) => r.eccentricDuration < 0.5).length / controlled.length : 0;
    const ratios = controlled.map((r) => {
      if (typeof r.tempoRatio === "number" && Number.isFinite(r.tempoRatio)) return r.tempoRatio;
      const c = r.concentricDuration ?? 0;
      return c > 0 ? (r.eccentricDuration ?? 0) / c : null;
    }).filter((x) => x !== null);
    // Balanced = lowering lasts 30%–400% of the lift; faster is a crash risk.
    const balanceFrac = ratios.length ? ratios.filter((x) => x >= 0.3 && x <= 4).length / ratios.length : 1;
    const control = clamp(100 - crashFrac * 80 - (1 - balanceFrac) * 50, 0, 100);
    tempoScore = Math.round(0.6 * consistency + 0.4 * control);
    tempoSummary = `A typical rep took ${r1(mean(totals))} seconds, and the timing varied by about ${Math.round(cv * 100)}%${crashFrac > 0.25 ? ". Several lowerings were rushed." : "."}`;
  } else {
    tempoScore = 60;
    tempoSummary = "Too few full repetitions to judge pacing — neutral score.";
  }

  // ---- Pillar 4: stability. Trunk control + lateral sway, minus valgus.
  const leanMean = trunkLean.mean ?? 0, leanPeak = trunkLean.peak ?? 0;
  const trunkScore = clamp(100 - Math.max(0, leanPeak - 20) * 2 - Math.max(0, leanMean - 15) * 1.5, 0, 100);
  const swayX = kinematics.comSway?.stdDevX;
  const swayRange = kinematics.comSway?.rangeX;
  const swayScore = typeof swayX === "number" ? clamp(100 - swayX * 1600, 0, 100) : 80;
  const valgusEvents = kinematics.valgusEvents ?? 0;
  const stabilityScore = Math.round(clamp(mean([trunkScore, swayScore]) - Math.min(25, valgusEvents * 2), 0, 100));
  const swayPct = typeof swayRange === "number" ? Math.round(swayRange * 100)
    : typeof swayX === "number" ? Math.round(swayX * 200) : null;
  const swayPhrase = swayPct === null
    ? "Side-to-side balance was not measured."
    : swayPct <= 3
      ? `Balance stayed steady, shifting about ${swayPct}% of the picture width.`
      : `Balance drifted about ${swayPct}% of the picture width.`;
  const frontView = (squat.count ?? 0) > 0 && avgKneeRom > 40 && leanPeak < 12;
  const chestPhrase = frontView
    ? `The chest stayed within ${Math.round(leanPeak)}° of upright. A camera in front cannot see a forward fold — stand sideways when back position matters.`
    : `The chest tipped as much as ${Math.round(leanPeak)}° off upright.`;
  const kneePhrase = valgusEvents > 0
    ? `The knees drifted inward on ${valgusEvents} frame${valgusEvents === 1 ? "" : "s"}.`
    : "The knees stayed over the feet.";
  const stabilitySummary = `${swayPhrase} ${chestPhrase} ${kneePhrase}`;

  const pillars = [
    { id: "rom", name: "Range of Motion", score: romScore, summary: romSummary },
    { id: "symmetry", name: "Bilateral Symmetry", score: symScore, summary: symSummary },
    { id: "tempo", name: "Cadence & Tempo", score: tempoScore, summary: tempoSummary },
    { id: "stability", name: "Postural Stability", score: stabilityScore, summary: stabilitySummary },
  ];

  const overallScore = Math.round(
    romScore * 0.3 + symScore * 0.25 + tempoScore * 0.2 + stabilityScore * 0.25
  );
  const grade = gradeFor(overallScore);

  // ---- Rep table: squat + arm combined in time order, global numbering.
  const ordered = [...allReps].sort((a, b) => (a.endTime ?? a.index ?? 0) - (b.endTime ?? b.index ?? 0));
  const repTable = ordered.map((r, i) => ({
    repNum: i + 1,
    kind: r.kind ?? "squat",
    tempoStr: `${(r.eccentricDuration ?? 0).toFixed(1)}s down / ${(r.concentricDuration ?? 0).toFixed(1)}s up`,
    depthStr: typeof r.minAngle === "number" ? `${Math.round(r.minAngle)}°` : "–",
    trunkLean: typeof r.trunkTiltAtDepth === "number" ? `${Math.round(r.trunkTiltAtDepth)}°` : "–",
    asymmetryStr: typeof r.asymmetryAtDepth === "number" ? `±${r1(r.asymmetryAtDepth)}°` : "–",
    tags: (r.flags ?? []).map((f) => FLAG_PILLS[f] ?? { type: "info", label: String(f) }),
  }));

  // ---- Actionable cues, ordered by severity, always at least two.
  const flagCounts = {};
  for (const r of allReps) for (const f of r.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const actionableCues = [];
  const cue = (title, text) => actionableCues.push({ icon: "▸", title, cue: text });
  if ((flagCounts.KNEE_VALGUS ?? 0) > 0 || valgusEvents > 0) {
    cue("Knees out over toes",
      `The knees drifted inward on ${flagCounts.KNEE_VALGUS ?? valgusEvents} rep${(flagCounts.KNEE_VALGUS ?? valgusEvents) === 1 ? "" : "s"}. Push the knees out over the toes on the way down and on the way up.`);
  }
  if (leanPeak > 25) {
    cue("Brace the trunk",
      `The chest tipped ${Math.round(leanPeak)}° off upright, so the back was helping the legs. Take a breath, brace, and keep the chest up at the bottom.`);
  }
  if ((flagCounts.ASYMMETRIC_DRIVE ?? 0) > 0 || asym > 10) {
    cue("Drive both sides evenly",
      `Left and right were ${r1(asym)}° apart. Slow the next set down and press both feet the same amount.`);
  }
  if ((flagCounts.SHALLOW_DEPTH ?? 0) > allReps.length / 2 || (squatFirst && avgKneeRom > 0 && avgKneeRom < 55)) {
    cue("Own a deeper bottom position",
      `The knees only traveled ${Math.round(avgKneeRom)}°. Sit a little deeper and pause for half a second at the bottom. A short bend does less for the thighs.`);
  }
  if ((flagCounts.RAPID_DESCENT ?? 0) > allReps.length / 2) {
    cue("Slow the lowering to 2 seconds",
      "Most reps drop too fast to control. Count 'one-one-thousand, two-one-thousand' on every descent; the muscle you save is your own.");
  }
  if (valid.length >= 2 && tempoScore >= 70 && actionableCues.length < 2) {
    const best = [...pillars].sort((a, b) => b.score - a.score)[0];
    cue("Keep this",
      `${best.summary} Hold that, and add about one rep next time.`);
  }
  if (actionableCues.length < 2) {
    cue("Add one clean rep per set",
      `Volume is ${(squat.count ?? 0) + (arm.count ?? 0)} total reps. Keep every rep as clean as your best one and extend each set by a single rep next time.`);
  }
  while (actionableCues.length < 2) cue("Keep the setup identical", "Same camera, same distance, same light — only then do session-to-session trends mean anything.");
  const finalCues = actionableCues.slice(0, 5);

  // ---- Microgravity / countermeasure context.
  const totalSquats = squat.count ?? 0, totalArms = arm.count ?? 0;
  let boneStimulusRating;
  if (totalSquats > 0 && avgKneeRom >= 70 && totalSquats >= 5) {
    boneStimulusRating = `${totalSquats} squats, with the knees traveling about ${Math.round(avgKneeRom)}°. That is a full bend. On a long flight, depth like this is the work that loads the hips and thighs — if the resistance itself is real.`;
  } else if (totalSquats > 0 && avgKneeRom >= 40) {
    boneStimulusRating = `${totalSquats} squats, with the knees traveling about ${Math.round(avgKneeRom)}°. That is a partial squat. A deeper bend does more.`;
  } else if (totalSquats > 0) {
    boneStimulusRating = `The squats were short (knees traveled about ${Math.round(avgKneeRom)}°). That is not much of a load for the hips and thighs.`;
  } else {
    boneStimulusRating = "No squat was counted, so this session did not load the legs.";
  }
  let neuromuscularFatigue;
  if (squatReps.length >= 3) {
    const vels = squatReps.map((r) => peakVel(r, "con")).filter((v) => v > 0);
    if (vels.length >= 3) {
      const third = Math.max(1, Math.floor(vels.length / 3));
      const first = mean(vels.slice(0, third)), last = mean(vels.slice(-third));
      const loss = first > 0 ? Math.round(((first - last) / first) * 100) : 0;
      neuromuscularFatigue = loss > 15
        ? `The last squats were about ${loss}% slower than the first. That is fatigue showing up.`
        : `Speed held up. The last squats were within ${Math.abs(loss)}% of the first.`;
    } else {
      neuromuscularFatigue = "Insufficient velocity data";
    }
  } else {
    neuromuscularFatigue = "Insufficient data (<3 squat reps)";
  }
  const aredSuitability = leanPeak > 30
    ? "The chest folded past 30°. Fix that before adding load."
    : totalSquats > 0 && avgKneeRom >= 60 && leanPeak <= 25
      ? "Depth and chest position are steady enough to keep the same load."
      : "Get a deeper, steadier squat before adding load.";
  const axialRaw = clamp(0.5 * (avgKneeRom / 90) + 0.3 * Math.min(1, totalSquats / 8) + 0.2 * (leanPeak <= 25 ? 1 : 0.4), 0, 1);
  const axialLoadingIndex = axialRaw >= 0.66
    ? "High — the bends and the number of squats are enough to count as a real leg session."
    : axialRaw >= 0.33
      ? "Moderate — a real session, with room to go deeper or add a few reps."
      : "Low — not much leg work was measured.";

  // ---- Headline + executive summary.
  const topIssue = finalCues[0];
  const bestPillar = [...pillars].sort((a, b) => b.score - a.score)[0];
  const headline = topIssue && overallScore < 85
    ? `${bestPillar.name} leads at ${bestPillar.score} · Fix: ${topIssue.title}`
    : `${bestPillar.name} leads at ${bestPillar.score} · Clean across all pillars`;
  const kneeAngles = squatReps.map((r) => r.minAngle).filter((n) => typeof n === "number");
  const deepestKnee = kneeAngles.length ? Math.round(Math.min(...kneeAngles)) : null;
  const downs = squatReps.map((r) => r.eccentricDuration).filter((n) => n > 0);
  const ups = squatReps.map((r) => r.concentricDuration).filter((n) => n > 0);
  const splitWord = downs.length && ups.length
    ? `Each squat took about ${r1(mean(downs))} seconds to lower and ${r1(mean(ups))} seconds to stand back up.`
    : "";
  const depthWord = deepestKnee === null ? ""
    : deepestKnee <= 95 ? `The deepest squat bent the knees to ${deepestKnee}°, which is past parallel.`
    : deepestKnee <= 115 ? `The deepest squat bent the knees to ${deepestKnee}°, about parallel.`
    : `The deepest squat only bent the knees to ${deepestKnee}°, still above parallel.`;
  const posture = d.posture ?? {};
  const stanceWord = posture.stanceMean
    ? `The feet were about ${r1(posture.stanceMean)} times as wide as the hips.`
    : "";
  const hipWord = typeof posture.pelvicObliquityPeak === "number"
    ? (posture.pelvicObliquityPeak > 5
      ? `One hip sat up to ${Math.round(posture.pelvicObliquityPeak)}° higher than the other.`
      : "The hips stayed level.")
    : "";
  const counted = [
    totalSquats ? `${totalSquats} squat${totalSquats === 1 ? "" : "s"}` : "",
    totalArms ? `${totalArms} arm raise${totalArms === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  const opening = counted
    ? `In ${Math.round(d.durationSeconds ?? 0)} seconds the camera counted ${counted}.`
    : `In ${Math.round(d.durationSeconds ?? 0)} seconds the camera did not count a full repetition.`;
  const executiveSummary = [
    opening,
    depthWord,
    splitWord,
    stanceWord,
    hipWord,
    romSummary,
    symSummary,
    tempoSummary,
    stabilitySummary,
    overallScore < 85
      ? `Do this next: ${topIssue.title}. ${topIssue.cue}`
      : "Nothing measured here needs a fix. Keep the camera in the same place next time so the comparison means something.",
  ].filter(Boolean).join(" ");

  return {
    version: SYNTHESIS_VERSION,
    overallScore,
    grade,
    tierLabel: TIER_LABELS[grade],
    headline,
    executiveSummary,
    pillars,
    repTable,
    actionableCues: finalCues,
    microgravityContext: {
      boneStimulusRating,
      neuromuscularFatigue,
      aredSuitability,
      axialLoadingIndex,
    },
    metrics: {
      totalSquats,
      totalArms,
      symPct: Math.round(clamp(100 - asym * 2, 0, 100)),
      asymDeg: r1(asym),
      avgKneeRom: Math.round(avgKneeRom),
      deepestKnee,
      trunkLeanMean: r1(leanMean),
      trunkLeanPeak: r1(leanPeak),
      stanceMean: posture.stanceMean || null,
      smoothness: Math.round(typeof d.smoothness === "number" ? d.smoothness : 0),
    },
  };
}
