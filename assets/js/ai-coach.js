import { isAlternating, alternatingTelemetry, GAIT_LIMIT } from "./movement-mode.js";
// Mode 2: AI deep analysis. Providers: the built-in offline expert engine
// (zero-config, instant, no network) plus cloud LLMs over OpenAI-compatible
// chat-completions endpoints (OpenAI, Gemini's OpenAI-compatible endpoint,
// or any custom base URL such as a local Ollama server).
//
// Privacy: only numeric telemetry (angles, reps, scores) is ever sent —
// never video, never landmarks, never anything that reconstructs the person.
// A cloud call only happens after the user picks a cloud provider and presses
// Run AI analysis. Hosted Vultr uses a server-only key; own-key providers use
// a tab-only user-entered key.

export const AI_PROVIDERS = {
  EXPERT_OFFLINE: "offline",
  HOSTED: "hosted",
  GEMINI: "gemini",
  VULTR: "vultr",
  OPENAI: "openai",
  CUSTOM: "custom",
};

export const AI_TIMEOUT_MS = 45000;

const OFFLINE_PROVIDER_LABEL = "Orbiter In-Flight Expert Engine (Offline/Local)";

const CLOUD_PRESETS = {
  vultr: {
    label: "Vultr DeepSeek",
    endpoint: "https://api.vultrinference.com/v1/chat/completions",
    defaultModel: "deepseek-v4.1-flash-1017",
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  gemini: {
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.0-flash",
    needsKey: true,
  },
};

const SYSTEM_PROMPT = `You are a flight-surgeon-grade exercise coach reviewing ONE astronaut workout session.
You receive numeric movement telemetry plus a deterministic algorithmic summary.
The athlete trains in microgravity against exercise countermeasures (ARED resistive
device, T2 treadmill, CEVIS cycle); bone and muscle loss make movement quality
safety-critical.

Rules:
- This is experimental 2D video telemetry, not a medical assessment. Never diagnose, certify mission readiness, infer bone loading or prescribe resistance/load.
- Treat extreme angles and partial tracking as possible camera/visibility errors. State uncertainty before interpreting them.
- Be concrete: cite the actual numbers you were given (scores, degrees, seconds).
- Prioritise safety-critical form faults (knee valgus, spinal loading, asymmetry) over praise.
- Give at most 5 corrective cues, ordered by importance, each one sentence with HOW to fix it.
- Suggest next-session targets with numbers (reps, ROM degrees, tempo seconds).
- Keep it under 350 words. Markdown with short headings and bullets. No preamble about being an AI.`;

/** Slim Agent-1-shape session stats for LLM context: aggregates only. */
function slimSession(session) {
  if (isAlternating(session)) return alternatingTelemetry(session);
  const s = session ?? {};
  const slim = {
    durationSeconds: Math.round(s.durationSeconds ?? 0),
    trackingQuality: s.quality ?? null,
    source: s.source ?? "unknown",
    rom: s.rom ?? {},
    energy: s.energy ?? null,
    smoothness: s.smoothness ?? null,
    asymmetryDeg: s.asymmetryDeg ?? null,
    trunkLean: s.kinematics?.trunkLean ?? null,
    valgusEvents: s.kinematics?.valgusEvents ?? null,
    comSwayX: s.kinematics?.comSway?.stdDevX ?? null,
    swayRangeX: s.kinematics?.comSway?.rangeX ?? null,
    stanceMean: s.posture?.stanceMean ?? null,
    pelvicObliquityPeak: s.posture?.pelvicObliquityPeak ?? null,
    neckTiltMean: s.posture?.neckTiltMean ?? null,
    balanceRange: s.posture?.balanceRange ?? null,
    reps: {},
  };
  for (const [kind, tracker] of Object.entries(s.reps ?? {})) {
    slim.reps[kind] = {
      count: tracker.count ?? 0,
      sample: (tracker.reps ?? []).slice(0, 3).map((r) => ({
        ecc: r.eccentricDuration, con: r.concentricDuration, rom: r.rom, flags: r.flags,
      })),
    };
  }
  return slim;
}

function slimSynthesis(synthesis) {
  const s = synthesis ?? {};
  return {
    overallScore: s.overallScore ?? null,
    grade: s.grade ?? null,
    tierLabel: s.tierLabel ?? null,
    headline: s.headline ?? null,
    executiveSummary: s.executiveSummary ?? null,
    pillars: (s.pillars ?? []).map((p) => ({ id: p.id, score: p.score, summary: p.summary })),
    cues: (s.actionableCues ?? []).map((c) => `${c.title}: ${c.cue}`),
    metrics: s.metrics ?? null,
    microgravityContext: s.microgravityContext ?? null,
  };
}

function coachUserPrompt(session, synthesis, customNotes) {
  if (isAlternating(session)) return `Review this running / alternating-movement recording descriptively. ${GAIT_LIMIT} Do not invent scores, asymmetry, form faults, targets or exercise prescriptions. Explain what tracking can and cannot show. Data: ${JSON.stringify(alternatingTelemetry(session))}. User note: ${customNotes || "none"}`;
  const payload = { algorithmicSummary: slimSynthesis(synthesis), telemetry: slimSession(session) };
  let prompt = `Session data (JSON):\n${JSON.stringify(payload, null, 1)}\n\n` +
    `Write the deep-dive review now: 1) verdict in one sentence, 2) what the numbers prove, ` +
    `3) up to 5 corrective cues with fixes, 4) next-session numeric targets.`;
  if (customNotes?.trim()) prompt += `\n\nAstronaut's note: "${customNotes.trim()}" — address it in a "Response to Astronaut Note" section.`;
  return prompt;
}

async function callChatCompletions({ endpoint, apiKey, model, messages, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("No fetch implementation available in this environment.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? AI_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 1600, ...(endpoint.includes("api.vultrinference.com") ? { reasoning_effort: "minimal" } : {}) }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error(`Request timed out after ${Math.round((timeoutMs ?? AI_TIMEOUT_MS) / 1000)} s.`);
    throw new Error(`Network error: ${e?.message ?? e}`);
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The model returned an empty reply.");
  return { text, model: data?.model ?? model };
}

async function hostedReview({session, synthesis, customNotes, question, fetchImpl}) {
  const res = await (fetchImpl ?? globalThis.fetch)("/api/review", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({telemetry: slimSession(session), summary: isAlternating(session) ? undefined : slimSynthesis(synthesis), note: customNotes, question}),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Hosted AI unavailable. Select the built-in offline coach or your own key.");
  if (!data.text) throw new Error("Hosted AI returned an empty reply.");
  return {markdown: data.text, providerUsed: `Hosted Vultr DeepSeek (${data.model})`};
}

/**
 * Offline expert engine: a deterministic deep-dive written from the
 * algorithmic synthesis, so Mode 2 works with no key and no network.
 */
export function expertDeepDive({ session, synthesis, customNotes }) {
  const s = synthesis ?? {};
  const m = s.metrics ?? {};
  const mg = s.microgravityContext ?? {};
  const lines = [];
  lines.push(`# Flight Surgeon Deep-Dive Review`);
  lines.push(`\n**${s.headline ?? "Session reviewed."}** — overall **${s.overallScore ?? "–"}/100 (${s.grade ?? "–"})**.`);
  if (s.executiveSummary) lines.push(`\n${s.executiveSummary}`);
  lines.push(`\n## Biomechanical & Microgravity Adaptation Assessment`);
  for (const p of s.pillars ?? []) {
    lines.push(`- **${p.name}**: ${p.score}/100 — ${p.summary}`);
  }
  lines.push(`- **Bone stimulus**: ${mg.boneStimulusRating ?? "unknown"}`);
  lines.push(`- **Neuromuscular fatigue**: ${mg.neuromuscularFatigue ?? "unknown"}`);
  lines.push(`- **ARED suitability**: ${mg.aredSuitability ?? "unknown"}`);
  const reps = [...(session?.reps?.squat?.reps ?? []), ...(session?.reps?.arm?.reps ?? [])];
  lines.push(`\n## Repetition Dynamics`);
  if (!reps.length) {
    lines.push(`- No full repetitions were recorded; base the next session on slow, deliberate practice reps.`);
  } else {
    const totals = reps.map((r) => r.totalDuration ?? (r.eccentricDuration ?? 0) + (r.concentricDuration ?? 0)).filter((t) => t > 0);
    const avg = totals.length ? (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1) : "–";
    const dirty = reps.filter((r) => !(r.flags ?? []).includes("CLEAN_REP")).length;
    lines.push(`- ${reps.length} reps at ~${avg} s each; ${reps.length - dirty} clean, ${dirty} flagged.`);
    const flagCounts = {};
    for (const r of reps) for (const f of r.flags ?? []) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    const top = Object.entries(flagCounts).filter(([f]) => f !== "CLEAN_REP").sort((a, b) => b[1] - a[1])[0];
    if (top) lines.push(`- Most common fault: **${top[0]}** on ${top[1]} rep(s) — this is the pattern to break first.`);
  }
  lines.push(`\n## Actionable Coaching Prescriptions`);
  const cues = s.actionableCues ?? [];
  if (!cues.length) lines.push(`- Hold current form and add ~10% volume next session.`);
  for (const c of cues.slice(0, 5)) lines.push(`- **${c.title}** — ${c.cue}`);
  lines.push(`\n## Mission Prognosis`);
  const score = s.overallScore ?? 0;
  lines.push(score >= 85
    ? `- Mission-ready movement. Keep the setup identical and progress load or volume gradually.`
    : score >= 70
      ? `- Fundamentally sound with fixable faults. One focused cue per session will move this to mission-ready within days.`
      : `- Below mission standard — prioritise the first two prescriptions above before adding any load or volume.`);
  if (m.trunkLeanPeak > 30) lines.push(`- Trunk peak ${m.trunkLeanPeak}° is the safety limiter: brace hard before every heavy set.`);
  if (customNotes?.trim()) {
    lines.push(`\n## Response to Astronaut Note`);
    lines.push(`> "${customNotes.trim()}"`);
    lines.push(`\nNoted against this session's data (score ${s.overallScore ?? "–"}, ` +
      `${m.totalSquats ?? 0} squats, symmetry gap ${m.asymDeg ?? "–"}°): ` +
      `keep watching it next session, and if it persists across two comparable sessions, raise it with the crew surgeon.`);
  }
  lines.push(`\n*Written on-device by the ${OFFLINE_PROVIDER_LABEL} (template analysis, no language model involved). Pick a cloud provider above for an LLM review.*`);
  return lines.join("\n");
}

/**
 * Run the deep analysis over a finished session.
 * provider: "offline" (default) | "gemini" | "openai" | "custom".
 * @returns {Promise<{markdown: string, providerUsed: string}>}
 */
export async function runAIDeepAnalysis({
  session, synthesis, provider, apiKey, customEndpoint, model, customNotes, fetchImpl, timeoutMs,
} = {}) {
  const p = (provider ?? AI_PROVIDERS.EXPERT_OFFLINE);
  if (p === AI_PROVIDERS.HOSTED) return hostedReview({session, synthesis, customNotes, fetchImpl});
  if (p === AI_PROVIDERS.EXPERT_OFFLINE && isAlternating(session)) return { markdown: GAIT_LIMIT, providerUsed: OFFLINE_PROVIDER_LABEL };
  if (p === AI_PROVIDERS.EXPERT_OFFLINE) {
    return { markdown: expertDeepDive({ session, synthesis, customNotes }), providerUsed: OFFLINE_PROVIDER_LABEL };
  }
  if (p === AI_PROVIDERS.OPENAI || p === AI_PROVIDERS.GEMINI || p === AI_PROVIDERS.VULTR) {
    const preset = CLOUD_PRESETS[p];
    const key = (apiKey ?? "").trim();
    if (!key) throw new Error(`Missing API key for ${preset.label}. Paste one, or switch back to the offline expert engine.`);
    const useModel = (model ?? "").trim() || preset.defaultModel;
    const { text, model: used } = await callChatCompletions({
      endpoint: preset.endpoint, apiKey: key, model: useModel,
      messages: [
        { role: "system", content: isAlternating(session) ? `You explain experimental video telemetry. ${GAIT_LIMIT} Do not diagnose or prescribe exercise. Treat camera rotation and partial views as uncertainty.` : SYSTEM_PROMPT },
        { role: "user", content: coachUserPrompt(session, synthesis, customNotes) },
      ],
      fetchImpl, timeoutMs,
    });
    return { markdown: text, providerUsed: `${preset.label} (${used})` };
  }
  if (p === AI_PROVIDERS.CUSTOM) {
    const endpoint = (customEndpoint ?? "").trim();
    if (!endpoint) throw new Error("Missing custom endpoint URL (e.g. http://localhost:11434/v1/chat/completions).");
    const useModel = (model ?? "").trim() || "default";
    const { text, model: used } = await callChatCompletions({
      endpoint, apiKey: (apiKey ?? "").trim(), model: useModel,
      messages: [
        { role: "system", content: isAlternating(session) ? `You explain experimental video telemetry. ${GAIT_LIMIT} Do not diagnose or prescribe exercise. Treat camera rotation and partial views as uncertainty.` : SYSTEM_PROMPT },
        { role: "user", content: coachUserPrompt(session, synthesis, customNotes) },
      ],
      fetchImpl, timeoutMs,
    });
    return { markdown: text, providerUsed: `Custom endpoint (${used})` };
  }
  throw new Error(`Unknown AI provider "${p}". Pick vultr, offline, gemini, openai or custom.`);
}

/** Offline keyword-routed answer for the "Ask the Flight Surgeon" chat. */
export function expertAnswer({ question, session, synthesis }) {
  const q = (question ?? "").toLowerCase();
  const m = synthesis?.metrics ?? {};
  const mg = synthesis?.microgravityContext ?? {};
  const valgus = session?.kinematics?.valgusEvents ?? 0;
  const has = (...words) => words.some((w) => q.includes(w));
  if (has("knee", "valgus", "cave", "caving")) {
    return valgus > 0
      ? `Yes — the tracker flagged ${valgus} frame(s) where a knee drifted inward of the hip–ankle line. Fix: screw both feet into the floor and shove the knees out over the toes before you start down; keep them there all the way up. (Knee ROM ~${m.avgKneeRom ?? "–"}°, symmetry gap ${m.asymDeg ?? "–"}°.)`
      : `Good news: no knee-valgus frames this session (0 flagged). Knees tracked over the toes. Keep cueing "knees out" as load rises — fatigue brings the cave back first. (Knee ROM ~${m.avgKneeRom ?? "–"}°.)`;
  }
  if (has("back", "spine", "spinal", "lumbar", "fatigue", "sore", "pain")) {
    return `Your trunk peaked at ${m.trunkLeanPeak ?? "–"}° with a mean of ${m.trunkLeanMean ?? "–"}° — ` +
      ((m.trunkLeanPeak ?? 0) > 25
        ? `beyond the ~25° comfort zone, so the spinal erectors carried load the legs should own. That is the likely fatigue source. Brace like a plank before each rep and stop the set when you feel the back take over.`
        : `inside a safe range, so the fatigue is more likely general work than a form fault. If one side of the back tires first, check the symmetry gap (${m.asymDeg ?? "–"}°).`);
  }
  if (has("trunk", "posture", "lean", "leaning", "chest", "upright")) {
    return `Trunk control scored well: mean lean ${m.trunkLeanMean ?? "–"}°, peak ${m.trunkLeanPeak ?? "–"}°. ` +
      ((m.trunkLeanPeak ?? 0) > 25
        ? `The peak is the concern — brace harder at the sticking point and keep the chest proud.`
        : `Keep the brace you have; it is holding the spine neutral through the sticking point.`);
  }
  if (has("symmetr", "even", "uneven", "side", "left", "right", "balance")) {
    return `Bilateral gap averaged ${m.asymDeg ?? "–"}° (symmetry ${(m.symPct ?? "–")}%). ` +
      ((m.asymDeg ?? 0) > 10
        ? `That is wide enough to matter: slow the next set 20% and feel both feet press equally.`
        : `That is within a healthy band for dynamic exercise — keep alternating your lead side on unilateral work.`);
  }
  if (has("tempo", "pace", "pacing", "speed", "fast", "slow", "rhythm", "eccentric", "lowering")) {
    const cues = (synthesis?.actionableCues ?? []).map((c) => c.title).join("; ");
    return `Pacing verdict: ${(synthesis?.pillars ?? []).find((p) => p.id === "tempo")?.summary ?? "see the tempo pillar"}. ` +
      `Rule of thumb: lower for a 2-count, drive up without bouncing. ${cues ? `Active cues: ${cues}.` : ""}`;
  }
  if (has("squat", "depth", "deep", "bottom", "parallel")) {
    return `Squat depth averaged ~${m.avgKneeRom ?? "–"}° knee ROM over ${m.totalSquats ?? 0} reps. ` +
      ((m.avgKneeRom ?? 0) >= 70
        ? `That is solid depth — own the bottom with a half-second pause rather than chasing deeper.`
        : `That is shallow for bone stimulus: sink until the hips clearly drop, even if it costs you a rep or two per set.`);
  }
  if (has("shoulder", "arm", "elbow", "press", "raise")) {
    return `Arms logged ${m.totalArms ?? 0} reps this session with a symmetry gap of ${m.asymDeg ?? "–"}° overall. ` +
      `For raises and presses, lead with the weaker side and let it set the rep count.`;
  }
  if (has("ared", "load", "weight", "resistance", "t2", "cevis", "countermeasure")) {
    return `Countermeasure read: bone stimulus "${mg.boneStimulusRating ?? "unknown"}", ARED suitability "${mg.aredSuitability ?? "unknown"}". ` +
      `Add load only while depth and trunk control hold — the numbers above are the gate.`;
  }
  return `This session scored ${synthesis?.overallScore ?? "–"}/100 (${synthesis?.grade ?? "–"}): ` +
    `${m.totalSquats ?? 0} squats, ${m.totalArms ?? 0} arm reps, symmetry gap ${m.asymDeg ?? "–"}°. ` +
    `Ask me about knees, back, trunk, symmetry, tempo, squat depth, arms, or ARED loading and I will answer from your numbers.`;
}

/**
 * Follow-up Q&A against a finished session. Offline by default (also used
 * when provider is omitted); cloud providers continue the chat via the API.
 * @returns {Promise<string>} markdown answer
 */
export async function askAIFlightSurgeon({
  question, chatHistory, session, synthesis, provider, apiKey, customEndpoint, model, fetchImpl, timeoutMs,
} = {}) {
  const q = (question ?? "").trim();
  if (!q) throw new Error("Type a question first.");
  const p = provider ?? AI_PROVIDERS.EXPERT_OFFLINE;
  if (p === AI_PROVIDERS.HOSTED) return (await hostedReview({session, synthesis, question:q, fetchImpl})).markdown;
  if (p === AI_PROVIDERS.EXPERT_OFFLINE && isAlternating(session)) return GAIT_LIMIT;
  if (p === AI_PROVIDERS.EXPERT_OFFLINE) return expertAnswer({ question: q, session, synthesis });

  const context = isAlternating(session) ? coachUserPrompt(session, synthesis, "") :
    `Same astronaut workout session. Key facts: score ${synthesis?.overallScore ?? "–"}/100, ` +
    `${synthesis?.metrics?.totalSquats ?? 0} squats, ${synthesis?.metrics?.totalArms ?? 0} arm reps, ` +
    `symmetry gap ${synthesis?.metrics?.asymDeg ?? "–"}°, trunk peak ${synthesis?.metrics?.trunkLeanPeak ?? "–"}°. ` +
    `Answer in under 150 words, citing session numbers where relevant.`;
  const messages = [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` }];
  for (const turn of chatHistory ?? []) {
    if (turn.role === "user") messages.push({ role: "user", content: turn.text ?? turn.content ?? "" });
    else if (turn.role === "assistant") messages.push({ role: "assistant", content: turn.text ?? turn.content ?? "" });
  }
  messages.push({ role: "user", content: q });

  if (p === AI_PROVIDERS.OPENAI || p === AI_PROVIDERS.GEMINI || p === AI_PROVIDERS.VULTR) {
    const preset = CLOUD_PRESETS[p];
    const key = (apiKey ?? "").trim();
    if (!key) throw new Error(`Missing API key for ${preset.label}.`);
    const { text } = await callChatCompletions({
      endpoint: preset.endpoint, apiKey: key, model: (model ?? "").trim() || preset.defaultModel,
      messages, fetchImpl, timeoutMs,
    });
    return text;
  }
  if (p === AI_PROVIDERS.CUSTOM) {
    const endpoint = (customEndpoint ?? "").trim();
    if (!endpoint) throw new Error("Missing custom endpoint URL.");
    const { text } = await callChatCompletions({
      endpoint, apiKey: (apiKey ?? "").trim(), model: (model ?? "").trim() || "default",
      messages, fetchImpl, timeoutMs,
    });
    return text;
  }
  throw new Error(`Unknown AI provider "${p}". Pick vultr, offline, gemini, openai or custom.`);
}
