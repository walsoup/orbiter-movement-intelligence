# Space Apps submission — copy-paste sheet

Fill the bracketed fields, paste the rest. Keep the live demo link first:
judges should reach a working product in one click.

## Project name
Orbiter — Movement Intelligence

## Team
Maghreb Orbiters — [member names, locations, one-line roles]

## Summary (short)
Astronauts exercise ~2 hours a day to fight muscle and bone loss, but crews
have no simple way to see whether their movement quality is drifting over a
mission. Orbiter uses one ordinary camera and on-device AI to count reps and
measure range of motion, left/right symmetry, tempo and movement energy —
then compares each session with the astronaut's own previous sessions, so
change is spotted early. No wearables, no sensors, no video ever leaves the
device.

## The problem
[Name the Space Apps challenge you are entering and quote its wording here.]
Exercise countermeasures only work if they are performed well, consistently,
for months. Today that quality is largely self-reported. Wearable systems add
mass, maintenance and another failure point — a real cost on a spacecraft.

## Our solution
A static web app (no server). MediaPipe Pose Landmarker finds 33 body
landmarks per frame, entirely in the browser. Orbiter turns those landmarks
into joint angles, counts repetitions with an auto-calibrating state machine
(no per-exercise tuning), and derives symmetry, range of motion, tempo,
movement energy and smoothness. Each session ends with a report — and, from
the second session on, a comparison against the user's previous session.

## How to judge it in two minutes
1. Open the live link. Click **Run the demonstration** — no camera or
   connection needed. Watch reps count and the strip chart draw for ~40 s;
   a scored report appears.
2. Run it again: the report now shows deltas vs the previous session.
3. If you have a webcam, do six slow squats ~2 m from the camera and compare.
4. Optional: open DevTools → Network during a webcam session and confirm no
   video leaves the machine. Run `npm test` — 5 tests cover angle geometry,
   rep counting (including jitter rejection), letterboxing and the demo pipeline.

Live demo: [URL after deploying — GitHub Pages etc.]
Repository: [URL]
Demo video (2 min, optional but recommended): [URL — record the flow above]

## NASA / open data used
- Method validated against astronaut exercise context: [cite the specific
  NASA challenge brief / dataset / footage you used].
- Optional sample footage: NASA astronaut exercise video from images.nasa.gov
  (placed locally at assets/video/astro-motion.mp4; not redistributed here).
- Open-source: MediaPipe Pose Landmarker (Google), running on-device.

## What is real, and what is simulated
The pose estimation, angle maths, rep counting, metrics, reporting and
session comparison are real and work on webcam/uploaded video today.
The one-click demonstration is a *simulated* pose, labelled as such on
screen; it exists so the full pipeline can be judged without a camera.
It is not presented as footage, and the metrics code path is identical.

## Limitations and next steps
Not a clinical measurement: it tracks change under a consistent setup.
A 2D camera cannot measure load or true 3D angles. Next: 3D world landmarks
(already produced by the model), exercise-form classification, on-device
trend alerts over multi-week baselines, and fully vendored offline model files.
