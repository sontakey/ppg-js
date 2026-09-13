// Run from repo root: node --import tsx docs/audit/scripts/<name>.mjs
// Evidence script for docs/audit/AUDIT-2026-09.md. Read-only; touches nothing in src/.
import { bandpassCoeffs, filtfiltBandpass } from '../../../src/core/filter.ts';
import { computeFFT, calculateSNRFromPSD } from '../../../src/core/fft.ts';
import { SignalProcessor } from '../../../src/core/SignalProcessor.ts';
import { DebugRecorder } from '../../../src/core/recorder.ts';
import { coachingMessage } from '../../../src/core/coaching.ts';
import { detrend } from '../../../src/core/detrend.ts';

// 1. Filter magnitude response (single pass and filtfilt = squared)
function mag(c, f, fs){ const w=2*Math.PI*f/fs; const z1=[Math.cos(-w),Math.sin(-w)]; const z2=[Math.cos(-2*w),Math.sin(-2*w)];
  const num=[c.b0+c.b1*z1[0]+c.b2*z2[0], c.b1*z1[1]+c.b2*z2[1]]; const den=[1+c.a1*z1[0]+c.a2*z2[0], c.a1*z1[1]+c.a2*z2[1]];
  return Math.hypot(...num)/Math.hypot(...den); }
for (const fs of [30,60]) {
  const c = bandpassCoeffs(fs,0.75,4.0);
  const f0=Math.sqrt(0.75*4); const q=f0/(4-0.75);
  console.log(`\n[filter fs=${fs}] f0=${f0.toFixed(2)}Hz Q=${q.toFixed(2)}  |H|^2 (filtfilt) in dB:`);
  for (const f of [0.1,0.2,0.3,0.5,0.75,1.0,1.17,1.73,2.5,4.0,6.0,8.0]) console.log(`   f=${f}Hz -> ${(20*Math.log10(mag(c,f,fs)**2)).toFixed(1)} dB`);
}

// 2. FFT HR quantization: pure 70bpm sine, 300 samples, at 30 and 60 fps
for (const fs of [24,30,60]) {
  const sp = new SignalProcessor({ windowLength:300, sampleRate:fs, fftSize:256 });
  const out=[];
  for (const bpm of [60,64,68,72,76,80]) {
    const raw = new Float32Array(300); for (let i=0;i<300;i++) raw[i]=0.5+0.01*Math.sin(2*Math.PI*(bpm/60)*i/fs);
    const det = detrend(raw);
    const fft = computeFFT(det,256,fs); const snr = calculateSNRFromPSD(fft.psd, fft.freqResolution, 0.75, 4.0);
    out.push(`${bpm}->${(snr.peakFrequency*60).toFixed(1)}`);
  }
  console.log(`[fft fs=${fs}] binWidth=${(fs/256*60).toFixed(1)}bpm, windowSec=${(300/fs).toFixed(1)}, samplesUsed=256/300; true->fftHR: ${out.join(' ')}`);
}

// 3. Recorder restart leak
{
  const r = new DebugRecorder();
  r.start({}); r.pushSample({t:1000,r:1,g:1,b:1}); r.pushSample({t:1033,r:1,g:1,b:1});
  r.start({}); r.pushSample({t:500,r:2,g:2,b:2});
  const j = r.toJSON();
  console.log(`\n[recorder restart] samples after second start(): ${j.samples.length} (expected 1 if start() clears) ts=${j.samples.map(s=>s.t).join(',')} events=${j.events.length}`);
}

// 4. coaching precedence
console.log(`\n[coaching] torchSupported=false + MEASURING good signal => "${coachingMessage({state:'MEASURING',torchSupported:false,redMean:200,greenMean:30,blueMean:30,acDcRatio:0.02})}"`);

// 5. detrend allocation & type
{ const d = detrend(new Float32Array([1,2,3])); console.log(`[detrend] returns ${d.constructor.name}`); }
