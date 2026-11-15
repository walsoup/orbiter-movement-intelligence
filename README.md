# Orbiter — movement analysis for astronaut exercise sessions

**Maghreb Orbiters · NASA Space Apps Challenge 2026**

Orbiter watches an astronaut exercise session through one ordinary camera and
measures how the movement changes over time: repetitions, joint range of
motion, left/right symmetry, rep tempo and movement energy. On a long mission,
that trend — measured the same way every week — is an early signal that
exercise countermeasures are, or are not, holding up.

It needs **no wearables or extra sensors**. Browser pose tracking is paired with optional cloud AI review through Vultr DeepSeek, Gemini, OpenAI or a custom endpoint. Cloud review requires internet access and sends summary telemetry, never video. Pose
estimation (Google MediaPipe Pose Landmarker, 33 body landmarks) runs entirely
in the browser on the user's device. No video is uploaded, stored or sent
anywhere — verify it yourself: open the demo, then check the Network tab in
your browser's developer tools while a webcam session runs.

> **This is a static web app, and that is deliberate.** There is no server to
> deploy, secure, pay for or keep awake during judging. The deliverable is
> this repository: open it, serve it, and it runs. Everything below takes
> under two minutes.

---

## Try it in 60 seconds (no camera, no downloads)

```bash
npm run serve        # or: python3 -m http.server 8000
# open http://localhost:8000
```

1. Click **Run the demonstration**. A simulated exercise session (clearly
   labelled synthetic — it is not footage) feeds the real analysis pipeline:
   watch squat and arm reps count, the strip chart draw joint angles, and
   symmetry/energy update live.
2. After ~40 s a session report appears. Download it as JSON if you like.
3. Run it again — the second report compares against your previous session,
   which is the actual point of the tool: *change over time*, not a one-off score.

Then, if you have a camera: **Use webcam**, stand ~2 m back with your whole
body in frame, and do slow squats or arm raises. Or **Upload a video** of any
recorded exercise clip.

Opening `index.html` directly from disk mostly works too, but a local server
is the supported path (browsers restrict some features on `file://` pages).

## Run the tests

```bash
npm test
```

Sixteen automated tests cover the parts that must not be wrong: joint-angle
geometry, the repetition counter (including the rule that small jitter must
never count as a rep), letterbox mapping for non-16:9 video, and an
end-to-end check that the synthetic demonstration produces countable reps
through the real pipeline.

There is also a headless self-check for the full page: serve the project and
open `http://localhost:8000/?autotest=1` — it starts the demonstration and
writes frame/rep counts into the page title.

## How it works

```
webcam / uploaded video / ISS clip ──► MediaPipe Pose Landmarker (in browser)
synthetic demonstration ─────────────► 33 landmarks per frame
                                              │
                                   joint angles (aspect-corrected)
                                   rep state machines (auto-calibrating)
                                   symmetry · energy · smoothness · tempo
                                              │
                              live metrics · strip chart · session report
```

| File | What it does |
|---|---|
| `index.html` | Page structure, dual-mode report modal, interactive chat, and live metrics. |
| `assets/css/styles.css` | All styling. No framework. Accessible, high-contrast, responsive. |
| `assets/js/app.js` | Pose loading, live rendering, CoM tracking, strip chart streams, dual-mode report, JSON export. |
| `assets/js/pose-math.js` | Kinematics core: joint angles (knees, hips, elbows, shoulders, ankles, spine tilt), Dempster Center of Mass, knee valgus detection, phase-aware RepCounter. |
| `assets/js/synthesis.js` | Mode 1 Engine: Algorithmic biomechanical synthesis, executive summaries, 4 pillars, rep breakdown table, and microgravity risk rating. |
| `assets/js/ai-coach.js` | Mode 2 Engine: Deep AI Flight Surgeon review via Vultr DeepSeek, Gemini, OpenAI, custom endpoints, or a built-in deterministic offline report engine, plus interactive Q&A. |
| `assets/js/demo-pose.js` | Generates 33-landmark synthetic astronaut exercise poses with realistic kinematics and fatigue drift. |
| `tests/*.test.js` | Node test suites covering kinematics, synthesis, AI coach (including Vultr routing and errors), and end-to-end simulation (`npm test`). |
| `messageboard.md` | Active collaborative coordination board for parallel agents and team contributors. |
| `SUBMISSION.md` | Copy ready to paste into the Space Apps submission form. |

### Method, in brief

- **Expanded Kinematics & Posture:** Computes angles across all primary joints
  (knees, hips, elbows, shoulders, ankles) corrected for video aspect ratio.
  Trunk inclination from vertical measures forward torso lean (crucial for
  protecting elongated spinal discs in microgravity), while lateral tilt checks
  for uneven pelvic loading.
- **Center of Mass (CoM) & Stability:** Calculates whole-body Center of Mass
  using Dempster segment mass coefficients and visualizes live balance drift on
  the skeleton overlay.
- **Phase-Aware Repetitions:** Auto-calibrating state machine identifies
  eccentric descent duration, bottom inflection/pause, concentric ascent
  duration, tempo ratio (e.g. 2:1), peak velocities, and flags compensatory
  breakdowns per rep.
- **Dual-Mode Synthesis:**
  - **Mode 1 (Regular Analysis):** An algorithmic synthesizer translates raw
    angles into a 0–100 Readiness Score, a plain-English executive summary,
    four distinct pillar scores (ROM, Symmetry, Tempo, Spinal Stability), a
    clean rep-by-rep breakdown table, prioritized coaching cues, and an ISS
    ARED countermeasure bone-stimulus assessment.
  - **Mode 2 (Deeper AI Analysis):** Sends the structured telemetry payload to
    Vultr DeepSeek, Google Gemini, OpenAI, a custom local LLM, or Orbiter's built-in offline
    expert engine. Generates a comprehensive clinical flight surgeon review and
    powers an interactive "Ask the Flight Surgeon" chat where crew members can
    ask follow-up questions about their form.
- **Movement energy & smoothness:** Torso-normalised speed and acceleration
  jerk metrics to quantify fatigue-induced tremors.
- **Scoring gate:** Sessions under 15 s, or tracked less than 50% of the
  time, are reported but explicitly *not scored* — a bad measurement should
  say so, not quietly produce a number.

### Honest limits

- This spots *change against your own previous sessions* under the same
  setup. It is not a clinical or diagnostic measurement, and does not claim to be.
- One 2D camera cannot measure load, force or true 3D joint angles.
- Accuracy depends on the whole body being visible in steady light.

## Adding the ISS sample clip

The **ISS sample clip** button expects a file at
`assets/video/astro-motion.mp4`. It is not committed to this repository
(footage licensing and file size), so the button disables itself with an
explanation when the file is absent. To enable it, drop any suitable public
exercise clip at that path — e.g. NASA astronaut exercise footage from
[NASA's image and video library](https://images.nasa.gov) — and reload.

## Deploying

Any static host works (GitHub Pages, Netlify, Vercel, an S3 bucket):

- Publish the repository root as-is. No build step.
- The pose engine (JS, WASM, model) loads from public CDNs on first use, so
  the hosted page needs internet access once; after that, sessions run
  locally. The synthetic demonstration needs no network at all.
  For a fully offline venue, download the three MediaPipe files, place them
  under `assets/vendor/`, and point `CDN` in `assets/js/app.js` at them.

## Privacy

- Video frames are processed in-page by the MediaPipe WASM model. The video
  is never uploaded. Regular analysis stays on this computer.
- Deeper analysis can optionally send the measured numbers (not the video) to
  Vultr DeepSeek, Gemini, OpenAI, or an address you type. Notes and follow-up questions are also sent when you use cloud review. The built-in coach makes no network call.
- The only stored data is your last session's summary numbers, in your own
  browser's `localStorage`, used for the "vs last session" comparison.
  Clear it any time from the browser's site settings.

## Team

Maghreb Orbiters — built for the NASA Space Apps Challenge 2026.
*(Add team member names, roles and contact links here before submitting.)*

## Vultr DeepSeek review

Select Vultr DeepSeek in the report, enter your own Vultr Inference API key, then run the review. The key stays in this tab only; it is not committed, embedded, exported or saved in browser storage. The app sends summary telemetry to `https://api.vultrinference.com/v1/chat/completions` using `deepseek-v4.1-flash-1017`. Calls use your inference credits. No shared API key is supplied. Cloud AI is experimental interpretation, not medical advice.
