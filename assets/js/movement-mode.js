// Explicit user choice, not automatic exercise recognition or gait validation.
export const isAlternating = (session) => session?.movementType === 'alternating';
export const GAIT_LIMIT = 'Running / alternating movement: bilateral symmetry, squat/arm counts and readiness scores are not assessed. Normal alternating gait is not a form fault. Phase-matched gait analysis is not implemented.';
export function alternatingTelemetry(raw) {
  return {
    movementType: 'alternating', assessmentStatus: 'descriptive-only', limitation: GAIT_LIMIT,
    durationSeconds: raw.durationSeconds, quality: raw.quality, trackedRatio: raw.trackedRatio,
    source: raw.source, rom: raw.rom, energy: raw.energy,
  };
}
export function alternatingSynthesis() {
  return { assessmentStatus: 'descriptive-only', headline: 'Descriptive movement telemetry only', executiveSummary: GAIT_LIMIT, pillars: [], actionableCues: [] };
}
