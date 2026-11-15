// Synthetic demonstration pose.
//
// Generates a full 33-landmark MediaPipe-shaped pose performing slow squats
// with arm raises. It feeds the exact same analysis pipeline as the camera,
// so judges can verify rep counting, symmetry, energy and the strip chart
// with no camera, no video file and no network connection.
// It is labelled as synthetic everywhere it appears — it is not footage.

function limb(from, length, angleFromVerticalDeg) {
  const r = (angleFromVerticalDeg * Math.PI) / 180;
  return { x: from.x + length * Math.sin(r), y: from.y + length * Math.cos(r) };
}

const p = (x, y) => ({ x, y, z: 0, visibility: 0.99 });

/**
 * @param {number} t seconds since demo start
 * @returns {Array<{x:number,y:number,z:number,visibility:number}>} 33 landmarks
 */
export function demoLandmarks(t) {
  // One squat cycle every 5 s, one arm-raise cycle every 5 s (offset so both are visible).
  const squat = (Math.sin((t / 5) * Math.PI * 2 - Math.PI / 2) + 1) / 2; // 0 standing, 1 deep
  const raise = (Math.sin((t / 5) * Math.PI * 2 + Math.PI / 2) + 1) / 2; // arms 0 down, 1 up

  const drop = squat * 0.085;               // hips sink
  const hipY = 0.52 + drop;
  const shoulderY = 0.27 + drop * 0.85;
  // Gentle lateral sway (10 s period) so balance metrics read a realistic
  // nonzero value; the head stays steadier than the hips, like a real person.
  const cx = 0.5 + 0.008 * Math.sin((t / 10) * Math.PI * 2);
  const headCx = 0.5 + 0.003 * Math.sin((t / 10) * Math.PI * 2);

  // Natural forward trunk inclination during squat descent, with subtle late-session fatigue shift
  const forwardLean = squat * 0.022;
  const fatigueShift = t > 25 ? ((t - 25) / 15) * 0.005 : 0; // slight right-leg bias as fatigue sets in

  const hipL = p(cx - 0.075, hipY), hipR = p(cx + 0.075, hipY);
  const shoL = p(cx - 0.105 + forwardLean + fatigueShift, shoulderY), shoR = p(cx + 0.105 + forwardLean + fatigueShift, shoulderY);

  // Legs, frontal view: feet stay planted, hips sink, knees track outward.
  const ankL = p(cx - 0.095, 0.94), ankR = p(cx + 0.095, 0.94);
  const kneeOut = squat * 0.085;
  const kneeL = p(hipL.x - kneeOut + fatigueShift * 0.5, (hipY + 0.94) / 2);
  const kneeR = p(hipR.x + kneeOut + fatigueShift * 0.5, (hipY + 0.94) / 2);

  // Arms: hang down, then raise sideways/up. Elbow bends slightly at the top.
  const armTiltL = -14 - raise * 128;                  // negative = outward/up (left)
  const armTiltR = 14 + raise * 128;
  const elbL = limb(shoL, 0.17, armTiltL);
  const elbR = limb(shoR, 0.17, armTiltR);
  const foreBend = raise * 38;
  const wriL = limb(elbL, 0.16, armTiltL - foreBend);
  const wriR = limb(elbR, 0.16, armTiltR + foreBend);

  const lm = Array.from({ length: 33 }, () => p(cx + forwardLean, shoulderY - 0.12));
  // Face points clustered at the head so the full skeleton reads correctly.
  const head = p(cx + forwardLean + fatigueShift, shoulderY - 0.085);
  for (let i = 0; i <= 10; i++) lm[i] = p(head.x + ((i % 5) - 2) * 0.008, head.y - Math.floor(i / 5) * 0.012);
  lm[11] = shoL; lm[12] = shoR;
  lm[13] = elbL; lm[14] = elbR;
  lm[15] = wriL; lm[16] = wriR;
  lm[17] = p(wriL.x - 0.015, wriL.y); lm[18] = p(wriR.x + 0.015, wriR.y);
  lm[19] = p(wriL.x - 0.03, wriL.y + 0.01); lm[20] = p(wriR.x + 0.03, wriR.y + 0.01);
  lm[21] = p(wriL.x + 0.012, wriL.y); lm[22] = p(wriR.x - 0.012, wriR.y);
  lm[23] = hipL; lm[24] = hipR;
  lm[25] = kneeL; lm[26] = kneeR;
  lm[27] = ankL; lm[28] = ankR;
  lm[29] = p(ankL.x - 0.012, ankL.y + 0.018); lm[30] = p(ankR.x + 0.012, ankR.y + 0.018);
  lm[31] = p(ankL.x - 0.035, ankL.y + 0.02); lm[32] = p(ankR.x + 0.035, ankR.y + 0.02);
  return lm;
}

export const DEMO_DURATION_SECONDS = 40;
