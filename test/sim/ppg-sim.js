// Synthetic PPG {t,r,g,b} sample-stream generator, for tests that need
// controllable, known-ground-truth signals rather than a fixed recording.
// Mirrors the real camera-PPG characteristics established from real iPhone
// logs (see fingerState.js/peaks.js doc comments): DC ~190-200/255, AC
// ~1-2% of DC, red high / green+blue low while a finger covers the lens.
//
// Importable as a library (test/sim.test.js); not a CLI.

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {Object} opts
 * @param {number} opts.durationSec
 * @param {number|(t:number)=>number} [opts.hr=70] - bpm, constant or a function of session-seconds (for ramps)
 * @param {number} [opts.fps=30] - nominal frame rate
 * @param {number} [opts.fpsJitter=0.1] - fractional jitter per frame (0 = perfectly periodic)
 * @param {number} [opts.dc=195] - baseline red DC (counts, 0-255)
 * @param {number} [opts.dcDriftPerSec=0] - slow linear drift of DC (counts/sec)
 * @param {number} [opts.acAmplitude=3] - red AC amplitude (counts)
 * @param {number} [opts.noiseSd=0.5] - white noise sd (counts)
 * @param {number} [opts.rsaBpm=0] - respiratory sinus arrhythmia: breathing rate (breaths/min) that
 *   modulates instantaneous HR
 * @param {number} [opts.rsaAmplitudeBpm=0] - +-bpm swing from RSA
 * @param {{startSec:number, durationSec:number, stepCounts:number}[]} [opts.motionBursts=[]] -
 *   large sudden DC baseline steps (motion artifact), held for durationSec then reverting
 * @param {{startSec:number, durationSec:number}[]} [opts.fingerLifts=[]] - gaps where the
 *   finger is off the lens (red/green/blue all drop to ambient-light levels)
 * @param {boolean} [opts.everyNthMissed=0] - if >0, drop (halve amplitude of) every Nth beat,
 *   simulating a peak the detector would miss
 * @param {number} [opts.seed=1]
 * @returns {{samples: Array<{t:number,r:number,g:number,b:number}>, groundTruth: {beatTimesSec:number[], ibisMs:number[], rmssdMs:number}}}
 */
export function generatePpgSamples(opts = {}) {
  const {
    durationSec, fps = 30, fpsJitter = 0.1, dc = 195, dcDriftPerSec = 0,
    acAmplitude = 3, noiseSd = 0.5, rsaBpm = 0, rsaAmplitudeBpm = 0,
    motionBursts = [], fingerLifts = [], everyNthMissed = 0, seed = 1
  } = opts;
  const hrFn = typeof opts.hr === 'function' ? opts.hr : () => (opts.hr ?? 70);

  const rng = mulberry32(seed);
  const samples = [];

  // Instantaneous phase integration so hr(t)/RSA modulation is exact even
  // when hr varies - phase advances by hrHz(t)*dt each step.
  let phase = 0;
  let beatCount = 0;
  let lastBeatPhase = 0;
  const beatTimesSec = [];

  let t = 0;
  let prevT = 0;
  while (t < durationSec) {
    const nominalDt = 1 / fps;
    const jitterFactor = 1 + (rng() - 0.5) * fpsJitter;
    const dt = nominalDt * jitterFactor;
    prevT = t;
    t += dt;
    if (t >= durationSec) break;

    const instHrBpm = hrFn(t) + (rsaAmplitudeBpm ? rsaAmplitudeBpm * Math.sin(2 * Math.PI * (rsaBpm / 60) * t) : 0);
    const hrHz = Math.max(0.1, instHrBpm) / 60;
    const phaseBefore = phase;
    phase += hrHz * dt;

    // Detect a beat crossing (phase wraps past an integer) for ground truth.
    // Ground truth must be the exact crossing TIME, not the sample time t
    // the crossing was observed at - recording t here quantizes truth to
    // the frame grid (+-1 frame, i.e. +-16ms@60fps/+-33ms@30fps), which is
    // exactly the kind of frame-quantization jitter this generator exists
    // to be clean of. Linearly interpolate within [prevT, t] for the
    // fractional time phase actually crossed the integer boundary.
    if (Math.floor(phase) > Math.floor(phaseBefore)) {
      const crossingPhase = Math.floor(phase);
      const frac = (crossingPhase - phaseBefore) / (phase - phaseBefore);
      beatTimesSec.push(prevT + frac * dt);
      beatCount++;
    }
    lastBeatPhase = phase;

    const fingerLifted = fingerLifts.some(g => t >= g.startSec && t < g.startSec + g.durationSec);

    let dcNow = dc + dcDriftPerSec * t;
    for (const burst of motionBursts) {
      if (t >= burst.startSec && t < burst.startSec + burst.durationSec) {
        dcNow += burst.stepCounts;
      }
    }

    let acNow = acAmplitude;
    const nthIdx = beatCount; // beat index at/after this sample
    if (everyNthMissed > 0 && nthIdx > 0 && nthIdx % everyNthMissed === 0) {
      acNow *= 0.15; // amplitude drops below the peak detector's threshold
    }

    const fundamental = Math.sin(2 * Math.PI * phase);
    const harmonic2 = 0.1 * Math.sin(2 * Math.PI * 2 * phase + 0.6);
    const noise = (rng() - 0.5) * 2 * noiseSd;

    let r, g, b;
    if (fingerLifted) {
      // Ambient/ no-finger reading: low red, moderate-ish green/blue (fails
      // isFingerPresent's redMean>120 && greenMean<60 && blueMean<60 gate).
      r = 60 + noise; g = 90 + noise; b = 90 + noise;
    } else {
      r = dcNow - acNow * (fundamental + harmonic2) + noise;
      g = 30 + noise * 0.3;
      b = 30 + noise * 0.3;
    }

    // 8-bit quantization + clamp, matching a real camera sensor readout.
    r = Math.max(0, Math.min(255, Math.round(r)));
    g = Math.max(0, Math.min(255, Math.round(g)));
    b = Math.max(0, Math.min(255, Math.round(b)));

    samples.push({ t: t * 1000, r, g, b });
  }

  const ibisMs = [];
  for (let i = 1; i < beatTimesSec.length; i++) {
    ibisMs.push((beatTimesSec[i] - beatTimesSec[i - 1]) * 1000);
  }
  let rmssdMs = 0;
  if (ibisMs.length >= 2) {
    let sumSq = 0;
    for (let i = 1; i < ibisMs.length; i++) {
      const diff = ibisMs[i] - ibisMs[i - 1];
      sumSq += diff * diff;
    }
    rmssdMs = Math.sqrt(sumSq / (ibisMs.length - 1));
  }

  return { samples, groundTruth: { beatTimesSec, ibisMs, rmssdMs } };
}
