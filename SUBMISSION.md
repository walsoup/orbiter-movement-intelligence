# Orbiter Movement Intelligence

## Team
Maghreb Orbiters

## Challenge
Create Health Monitoring Software for Astronauts on Space Missions

## Short summary
Long missions demand consistent exercise. Orbiter turns ordinary exercise video into visible movement telemetry: joint angles, repetitions, left/right symmetry, tempo and estimated center of mass. Browser pose tracking builds a session report, and an AI coach reviews the measured summary and explains its limits. Video stays in the browser. Our vision is to help spot movement changes early, before the crew feels them.

## Project description
NASA identifies reduced cardiorespiratory and musculoskeletal fitness, and spaceflight-induced bone changes, among the risks of human spaceflight. Orbiter explores one small part of this problem: making exercise movement easier to inspect using a camera crews could already have.

The prototype accepts a webcam or uploaded exercise video. Google MediaPipe Pose Landmarker estimates 33 body landmarks in the browser. JavaScript turns them into joint-angle traces, repetition counts, symmetry, tempo, estimated center of mass and movement-energy metrics. A session report summarizes the results and can compare them with the previous session stored in that browser.

For deeper interpretation, the user selects Vultr DeepSeek and supplies their own API key for the current tab. The app sends summary telemetry, report text and any notes or follow-up questions to Vultr's chat-completions API using deepseek-v4.1-flash-1017. It does not send video frames or raw pose landmarks. The key is not bundled with the app or saved in browser storage. Cloud review uses the user's inference credits and needs internet access.

The submission video shows real NASA astronaut footage being processed by the app, followed by an actual successful Vultr DeepSeek response. This is separate from the app's clearly labelled synthetic demonstration, which lets judges explore the metrics pipeline without a webcam.

## What we built
- A static HTML/CSS/JavaScript app with no application backend or build step.
- Browser pose tracking, joint-angle charts, repetition counting and session reports.
- Previous-session comparison and JSON report export.
- Optional Vultr DeepSeek review and follow-up questions, plus other existing provider choices.
- Sixteen passing automated tests, including Vultr request construction, missing-key handling, error propagation and follow-up routing. A real browser request also returned HTTP 200 from the selected model.

## How to try it
Repository: https://github.com/walsoup/orbiter-movement-intelligence

A hosted demo URL has not been published yet. To run locally, clone the repository, run `npm run serve`, and open http://localhost:8000.

1. Click "Run the demonstration" for a labelled synthetic session, or upload a suitable exercise clip.
2. For video tracking, wait for "Pose engine ready". Keep the whole body visible and the camera fixed.
3. Stop after at least 15 seconds to inspect the session report and joint-angle charts.
4. Open the deeper-analysis tab, select Vultr DeepSeek, enter your own Vultr Inference API key and run the review. Calls use your credits; no shared key is provided.
5. Run another session under the same setup to inspect the previous-session comparison. Run `npm test` to check the automated tests.

The repository does not currently include the optional ISS sample clip. Judges can use their own video upload or the synthetic demonstration.

## What is experimental
Orbiter is a prototype, not a medical device, diagnosis or mission-readiness assessment. Its scores and thresholds are heuristics, not clinically validated measures. A 2D camera cannot measure resistance, bone loading or true 3D joint angles. Camera rotation, partial visibility and microgravity orientation can produce extreme angles and unreliable repetition counts. The NASA-footage demonstration exposes these limits rather than proving accuracy. Cloud AI can also give incorrect interpretations and needs human review.

The next step is validation against annotated exercise footage and expert review, followed by better confidence gates, camera-orientation handling and longer individual baselines. The goal is useful movement-change information, not automated medical decisions.

## NASA and open resources
- Challenge brief: https://www.spaceappschallenge.org/2026/challenges/health-monitoring-software/
- NASA Human Research Program, Risks of Human Spaceflight: https://www.nasa.gov/hrp/risks/
- NASA footage used in the demo, "How Do Astronauts Exercise in Space?": https://images.nasa.gov/details/jsc2025m000002_How_Do_Astronauts_Exercise_in_Space_250106-MP4
- Google MediaPipe Pose Landmarker: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker
- Vultr model/API documentation: https://api.vultrinference.com/docs/models/deepseek-v4.1-flash-1017

## AI use
Built with AI assistance. AI assistance was used during development and demo narration. The app's optional cloud-review feature uses DeepSeek through Vultr. Its built-in offline report engine is deterministic code, not a cloud model.
