// Run from repo root: node --import tsx docs/audit/scripts/<name>.mjs
// Evidence script for docs/audit/AUDIT-2026-09.md. Read-only; touches nothing in src/.
// Drive the REAL live PPGMonitor frame loop (same stub approach as test/live-parity.test.js)
// over synthetic zero-HRV and known-RSA signals at several frame rates, with and without
// dropped frames, and compare accepted-IBI RMSSD against ground truth.
import { PPGMonitor } from '../../../src/core/PPGMonitor.ts';
import { generatePpgSamples } from '../../../test/sim/ppg-sim.js';
import { runReplay } from '../../../tools/replay.js';
const ROI_W=64, ROI_H=48;
function live(samples){
  let nowMs=samples[0].t; const realNow=Date.now; Date.now=()=>nowMs;
  let rgb={r:0,g:0,b:0}; const img={data:new Uint8ClampedArray(ROI_W*ROI_H*4)};
  const fill=()=>{for(let i=0;i<ROI_W*ROI_H;i++){img.data[i*4]=rgb.r;img.data[i*4+1]=rgb.g;img.data[i*4+2]=rgb.b;img.data[i*4+3]=255;}};
  const m=new PPGMonitor(null,{});
  m.roiCtx={drawImage(){fill();},getImageData:()=>img}; m.roiSourceRect={sx:0,sy:0,sw:1,sh:1};
  m.video={requestVideoFrameCallback:()=>0,cancelVideoFrameCallback(){},currentTime:0};
  m.recorder.start({}); m.initTime=new Date(samples[0].t); m.nFrame=101;
  const wins=[];
  try{ for(const s of samples){nowMs=s.t;rgb=s;m.computeFrame(s.t); if(m.nFrame%300===1) wins.push({...m.currentMetrics, t:(nowMs-samples[0].t)/1000});} } finally{Date.now=realNow;}
  return {m, wins};
}
function rmssdOf(a){ if(a.length<2) return 0; let s=0; for(let i=1;i<a.length;i++) s+=(a[i]-a[i-1])**2; return Math.sqrt(s/(a.length-1)); }
function dropFrames(samples, frac, seed=7){ let x=seed; const rnd=()=>{x=(x*1103515245+12345)&0x7fffffff;return x/0x7fffffff;}; return samples.filter(()=>rnd()>=frac); }
const cases=[];
for (const fps of [24,30,60]) for (const drop of [0,0.1]) for (const rsa of [0,5]) cases.push({fps,drop,rsa});
console.log('fps  drop  trueRMSSD | LIVE: acceptedIBIs rmssd(acc) medIBIerr goodWin measFps | REPLAY: acceptedIBIs rmssd(acc)');
for (const c of cases){
  const {samples, groundTruth}=generatePpgSamples({durationSec:120,hr:70,fps:c.fps,fpsJitter:0.1,seed:3,rsaBpm:c.rsa?6:0,rsaAmplitudeBpm:c.rsa});
  const s = c.drop? dropFrames(samples,c.drop):samples;
  const {m,wins}=live(s);
  const acc=m.getTachogram().filter(d=>d.valid).map(d=>d.ibiMs);
  const truthMean=groundTruth.ibisMs.reduce((a,b)=>a+b,0)/groundTruth.ibisMs.length;
  const accMed=[...acc].sort((a,b)=>a-b)[acc.length>>1]||0;
  const good=wins.filter(w=>w.quality&&w.quality.good).length;
  const fpsMeas=wins.length?wins[wins.length-1].sampleRate:0;
  const rp=runReplay({meta:{trackSettings:{frameRate:c.fps}},samples:s.map(x=>({...x})),events:[]});
  const racc=rp.ibiDetails.filter(d=>d.valid).map(d=>d.ibiMs);
  console.log(`${String(c.fps).padStart(3)}  ${String(c.drop).padStart(4)}  ${groundTruth.rmssdMs.toFixed(1).padStart(9)} | ${String(acc.length).padStart(12)} ${rmssdOf(acc).toFixed(1).padStart(10)} ${(accMed-truthMean).toFixed(1).padStart(9)} ${String(good).padStart(7)}/${wins.length} ${fpsMeas.toFixed(1).padStart(7)} | ${String(racc.length).padStart(12)} ${rmssdOf(racc).toFixed(1).padStart(10)}`);
}
