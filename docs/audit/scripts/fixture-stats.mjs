// Run from repo root: node --import tsx docs/audit/scripts/<name>.mjs
// Evidence script for docs/audit/AUDIT-2026-09.md. Read-only; touches nothing in src/.
import { readFileSync } from 'node:fs';
for (const f of ['iphone-52s','iphone-200s','iphone-cros-66s','iphone-cros-160s-mute']) {
  const log = JSON.parse(readFileSync(`${new URL('../../../test/fixtures/', import.meta.url).pathname}${f}.json`,'utf8'));
  const s = log.samples; const m = log.meta || {};
  const dts=[]; for (let i=1;i<s.length;i++) dts.push(s[i].t-s[i-1].t);
  const sorted=[...dts].sort((a,b)=>a-b);
  const med = sorted[sorted.length>>1];
  const gaps = dts.filter(d=>d>med*1.6).length;
  const frac = s.filter(x=>x.r!==Math.round(x.r)).length/s.length;
  const rs=s.map(x=>x.r), gs=s.map(x=>x.g), bs=s.map(x=>x.b);
  const q=(a,p)=>{const z=[...a].sort((x,y)=>x-y);return z[Math.floor(p*(z.length-1))];};
  const sat = s.filter(x=>x.r>=254).length/s.length;
  console.log(`\n== ${f}: n=${s.length} dur=${((s[s.length-1].t-s[0].t)/1000).toFixed(1)}s medianDt=${med.toFixed(1)}ms (${(1000/med).toFixed(1)}fps) minDt=${sorted[0].toFixed(1)} p99Dt=${q(dts,0.99).toFixed(1)} gaps(>1.6x)=${gaps} fractionalR=${(frac*100).toFixed(0)}% satR=${(sat*100).toFixed(1)}%`);
  console.log(`   r p5/50/95=${q(rs,.05).toFixed(0)}/${q(rs,.5).toFixed(0)}/${q(rs,.95).toFixed(0)} g=${q(gs,.05).toFixed(0)}/${q(gs,.5).toFixed(0)}/${q(gs,.95).toFixed(0)} b=${q(bs,.05).toFixed(0)}/${q(bs,.5).toFixed(0)}/${q(bs,.95).toFixed(0)}`);
  console.log(`   meta: ua=${(m.userAgent||'').slice(0,90)} mode=${m.frameCallbackMode} torchSupported=${m.torchSupported} caps.torch=${m.trackCapabilities&&m.trackCapabilities.torch} exposureMode=${JSON.stringify(m.trackCapabilities&&m.trackCapabilities.exposureMode)} wb=${JSON.stringify(m.trackCapabilities&&m.trackCapabilities.whiteBalanceMode)} zoom=${JSON.stringify(m.trackCapabilities&&m.trackCapabilities.zoom)} settings.fps=${m.trackSettings&&m.trackSettings.frameRate} ${m.trackSettings&&m.trackSettings.width}x${m.trackSettings&&m.trackSettings.height} torchSet=${m.trackSettings&&m.trackSettings.torch} label=${m.chosenLabel} constraintsApplied=${m.constraintsApplied} err=${m.constraintsError} anomalies=${JSON.stringify(log.timestampAnomalies)}`);
  const ev = (log.events||[]).reduce((a,e)=>{a[e.type]=(a[e.type]||0)+1;return a;},{});
  console.log('   events:', JSON.stringify(ev));
}
