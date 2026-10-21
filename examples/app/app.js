// Resolve from this script, including hosted URLs without a trailing slash.
const paintBundleURL = new URL('./paint-gpu.js', document.currentScript?.src || location.href);
let paintGPU = null, paintPageActive = true, paintWarmGeneration = 0;
function warmPaintGPU() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const generation = ++paintWarmGeneration;
  import(paintBundleURL.href).then(module => module.createPaintGPU()).then(gpu => { if (paintPageActive && generation === paintWarmGeneration) paintGPU = gpu; else gpu.dispose(); }).catch(() => {});
}
if ('requestIdleCallback' in window) requestIdleCallback(warmPaintGPU, { timeout: 1600 });
else setTimeout(warmPaintGPU, 300);
addEventListener('pagehide', () => { paintPageActive = false; paintWarmGeneration++; paintGPU?.dispose(); paintGPU = null; paintManuscript(document.getElementById('manuscript')); });
addEventListener('paintgpulost', () => paintManuscript(document.getElementById('manuscript')));
addEventListener('pageshow', event => { if (event.persisted) { paintPageActive = true; warmPaintGPU(); } });

// Pulse on Paper stores only accepted, measured waveform segments in memory.
// A window is painted after its quality decision, never speculatively.
const manuscript = { pending: [], segments: [], lastWindow: -1, paused: false, frame: 0, raster: null, viewFirstRow: 0, scroll: null };
// A continuous pigment journey follows capture time, never the row index or
// an HRV value. OKLab keeps the cool mixtures luminous between pigment anchors.
const pigmentAnchors = [[40,85,255],[118,84,184],[40,85,255],[28,138,142]].map(rgb => {
  const [r,g,b] = rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b);
  const m = Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b);
  const s = Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];
});
function pigmentAt(t, quality = 1) {
  const phase = t / 1.65 + .28*Math.sin(t*.73) + .13*Math.sin(t*1.91);
  const step = Math.floor(phase), fraction = phase-step, mix = fraction*fraction*(3-2*fraction);
  const a = pigmentAnchors[((step%4)+4)%4], b = pigmentAnchors[(((step+1)%4)+4)%4];
  const lab = a.map((v,i) => v+(b[i]-v)*mix);
  lab[0] -= .055*Math.max(0,Math.min(1,quality));
  lab[1] *= 1.28; lab[2] *= 1.28;
  const [L,A,B] = lab;
  const l = (L+.3963377774*A+.2158037573*B)**3;
  const m = (L-.1055613458*A-.0638541728*B)**3;
  const s = (L-.0894841775*A-1.291485548*B)**3;
  return [4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s].map(v => Math.round(255*Math.max(0,Math.min(1,v <= .0031308 ? 12.92*v : 1.055*v**(1/2.4)-.055))));
}
function animateManuscript() {
  cancelAnimationFrame(manuscript.frame);
  let previous = performance.now();
  const draw = now => {
    if (manuscript.paused || document.getElementById('screen-measuring').hidden) return;
    if (document.hidden) { previous = now; manuscript.frame = requestAnimationFrame(draw); return; }
    const segment = manuscript.segments.at(-1);
    if (!segment) return;
    const delta = now - previous;
    const activeDelta = delta > 250 ? 0 : Math.max(0, delta);
    segment.reveal = Math.min(1, segment.reveal + activeDelta / 4400);
    if (manuscript.scroll) manuscript.scroll.elapsed += activeDelta;
    previous = now;
    paintManuscript(document.getElementById('manuscript'));
    if (segment.reveal < 1 || manuscript.scroll) manuscript.frame = requestAnimationFrame(draw);
  };
  manuscript.frame = requestAnimationFrame(draw);
}
function resetManuscript() {
  cancelAnimationFrame(manuscript.frame);
  manuscript.pending = []; manuscript.segments = []; manuscript.lastWindow = -1; manuscript.paused = false;
  manuscript.viewFirstRow = 0; manuscript.scroll = null;
  document.getElementById('btn-pause').textContent = 'Pause artwork';
  document.getElementById('pause-note').textContent = '3-minute recording · Not a medical device';
  document.getElementById('manuscript-empty').hidden = false;
  paintManuscript(document.getElementById('manuscript'));
}
function acceptPaintWindow(metrics) {
  if (!Number.isFinite(metrics.t) || metrics.t <= manuscript.lastWindow) return;
  // Readouts use overlapping one-second analyses. Keep whole five-second
  // paint segments so the manuscript never repeats overlapping waveforms,
  // and retain pending samples until their own paint decision arrives.
  const paintInterval = monitor?.engine?.opts?.windowSec || 5;
  if (manuscript.lastWindow >= 0 && metrics.t - manuscript.lastWindow < paintInterval - 1e-6) return;
  manuscript.lastWindow = metrics.t;
  const window = monitor?.engine?.lastWindow;
  const start = window?.windowStartSec;
  if (!Number.isFinite(start)) return;
  const samples = manuscript.pending.filter(p => p.t <= metrics.t && p.t > start);
  manuscript.pending = manuscript.pending.filter(p => p.t > metrics.t);
  if (manuscript.paused || !metrics.quality?.good || !Number.isFinite(metrics.sqi?.score) || samples.length < 3) return;
  // The live display callback is red-channel AC. Use the actual selected-channel
  // analysis window so waveform geometry and SQI describe the same measurement.
  if (!window || window.t !== metrics.t || !window.filtered?.length || !(window.gridHz > 0)) return;
  const firstGrid = Math.round(start * window.gridHz) / window.gridHz;
  const points = [];
  let sampleIndex = 0;
  for (let i = 0; i < window.filtered.length; i++) {
    const t = firstGrid + i / window.gridHz;
    if (t < samples[0].t || t > samples.at(-1).t) continue;
    while (sampleIndex + 1 < samples.length && samples[sampleIndex + 1].t <= t) sampleIndex++;
    const next = samples[sampleIndex + 1];
    // Retain gaps and artwork pauses rather than joining across absent samples.
    if (next && next.t - samples[sampleIndex].t > .15) continue;
    const v = window.filtered[i];
    if (Number.isFinite(v)) points.push({ t, v });
  }
  if (points.length < 3) return;
  const values = points.map(p => p.v), lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 1e-8) return;
  manuscript.segments.forEach(segment => { segment.reveal = 1; });
  manuscript.segments.push({ reveal: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0, channel: window.selectedChannel, score: Math.max(0, Math.min(1, metrics.sqi.score)), points: points.map(p => ({t:p.t, v:(p.v-lo)/(hi-lo)})) });
  document.getElementById('manuscript-empty').hidden = true;
  paintManuscript(document.getElementById('manuscript'));
  animateManuscript();
}
function paintManuscript(canvas, compact = false, all = false) {
  // Report/export are one-shot draws. Live layers retain at most one extra row
  // for scrolling, so animation never rebuilds thousands of pigment marks
  // while the same main thread is collecting camera samples.
  if (compact || all) { paintManuscriptRaster(canvas, compact, all); return; }
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const latest = manuscript.segments.at(-1);
  if (!latest) { ctx.clearRect(0, 0, W, H); manuscript.raster = null; manuscript.viewFirstRow = 0; manuscript.scroll = null; paintGPU?.clear(); return; }
  const start = manuscript.segments[0].points[0].t;
  const end = latest.points.at(-1).t;
  const targetFirstRow = Math.max(0, Math.floor((end - start) / 5) + 1 - 4);
  let raster = manuscript.raster;
  if (!raster || raster.latest !== latest || raster.count !== manuscript.segments.length || raster.width !== W || raster.height !== H) {
    const firstRow = Math.max(0, targetFirstRow - 1), rows = targetFirstRow ? 5 : 4;
    const from = Math.max(firstRow, Math.min(manuscript.viewFirstRow, targetFirstRow));
    manuscript.scroll = from < targetFirstRow && !matchMedia('(prefers-reduced-motion: reduce)').matches
      ? { from, to: targetFirstRow, elapsed: 0 } : null;
    manuscript.viewFirstRow = manuscript.scroll ? from : targetFirstRow;
    const base = raster?.base || document.createElement('canvas');
    const ink = raster?.ink || document.createElement('canvas');
    for (const layer of [base, ink]) { layer.width = W; layer.height = H * rows / 4; }
    paintManuscriptRaster(base, false, false, 'base', true, { firstRow, rows });
    ink.getContext('2d').drawImage(base, 0, 0);
    paintManuscriptRaster(ink, false, false, 'latest', false, { firstRow, rows });
    raster = manuscript.raster = { base, ink, latest, firstRow, rows, count: manuscript.segments.length, width: W, height: H };
  }
  if (manuscript.scroll) {
    const scroll = manuscript.scroll, t = Math.min(1, scroll.elapsed / 900);
    const eased = t * t * (3 - 2 * t);
    manuscript.viewFirstRow = scroll.from + (scroll.to - scroll.from) * eased;
    if (t >= 1) manuscript.scroll = null;
  }
  const offsetRows = manuscript.viewFirstRow - raster.firstRow;
  const rowH = H / 4, offsetY = offsetRows * rowH, margin = W * .025;
  const drawLayer = layer => ctx.drawImage(layer, 0, offsetY, W, H, 0, 0, W, H);
  const visible = Math.ceil(latest.points.length * (latest.reveal ?? 1));
  if (visible < 2) { if (paintGPU?.manuscript(raster, -1, 0, offsetRows)) return; ctx.clearRect(0, 0, W, H); drawLayer(raster.base); return; }
  if (visible >= latest.points.length) { if (paintGPU?.manuscript(raster, raster.rows, 1, offsetRows)) return; ctx.clearRect(0, 0, W, H); drawLayer(raster.ink); return; }
  const through = latest.points[visible - 1];
  const row = Math.floor((through.t - start) / 5) - raster.firstRow;
  if (row < 0) { if (paintGPU?.manuscript(raster, -1, 0, offsetRows)) return; ctx.clearRect(0, 0, W, H); drawLayer(raster.base); return; }
  const x = margin + ((through.t - start) % 5) / 5 * (W - 2 * margin);
  if (paintGPU?.manuscript(raster, row, x / W, offsetRows)) return;
  ctx.clearRect(0, 0, W, H); drawLayer(raster.base);
  // Time advances left to right within each manuscript row. Clipping the
  // immutable layer retains all timestamp gaps and the original pigment depth.
  ctx.save(); ctx.beginPath();
  if (row > 0) ctx.rect(0, -offsetY, W, row * rowH);
  ctx.rect(0, row * rowH - offsetY, x, rowH);
  ctx.clip(); ctx.clearRect(0, 0, W, H); drawLayer(raster.ink); ctx.restore();
}
function paintManuscriptRaster(canvas, compact = false, all = false, layer = null, clear = true, layout = null) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (clear) ctx.clearRect(0,0,W,H);
  if (!manuscript.segments.length) return;
  const start = manuscript.segments[0].points[0].t;
  const end = manuscript.segments.at(-1).points.at(-1).t;
  const rowSeconds = 5, totalRows = Math.floor((end-start)/rowSeconds)+1;
  const selectedRows = layout?.rowIndices;
  const rows = selectedRows?.length ?? layout?.rows ?? (all ? totalRows : compact ? 2 : 4);
  const firstRow = layout?.firstRow ?? (all ? 0 : Math.max(0,totalRows-rows));
  const rowH = H/rows, margin = W*.025;
  const rand = n => { const x = Math.sin(n*127.1+311.7)*43758.5453; return x-Math.floor(x); };
  for (const segment of manuscript.segments) {
    if (layer === 'base' && segment === manuscript.segments.at(-1)) continue;
    if (layer === 'latest' && segment !== manuscript.segments.at(-1)) continue;
    const q = segment.score;
    const visible = all || compact || layer ? segment.points.length : Math.ceil(segment.points.length * (segment.reveal ?? 1));
    const paths = [];
    let path = [], lastRow = -1;
    for (let i=0; i<visible; i++) {
      const p=segment.points[i], row=Math.floor((p.t-start)/rowSeconds);
      const displayRow = selectedRows ? selectedRows.indexOf(row) : row-firstRow;
      if (displayRow<0 || displayRow>=rows) continue;
      if (row !== lastRow || (i && p.t-segment.points[i-1].t>.15)) {
        if(path.length) paths.push(path);
        path=[]; lastRow=row;
      }
      const color = pigmentAt(p.t,q);
      path.push({x:margin+((p.t-start)%rowSeconds)/rowSeconds*(W-2*margin),
        y:displayRow*rowH+rowH*(.79-p.v*.57), t:p.t, color, depositColor:color.map(v=>Math.round(v*.84)).join(','),
        wet:.30+.70*(.5+.5*Math.sin(p.t*8.1+Math.sin(p.t*1.7)))**2, seed:Math.floor(p.t*1000)});
    }
    if(path.length) paths.push(path);
    const width=Math.min(29,rowH*.16);
    for(const points of paths) {
      if(points.length<2) continue;
      const gradient = ctx.createLinearGradient(points[0].x,0,points.at(-1).x,0);
      const coreGradient = ctx.createLinearGradient(points[0].x,0,points.at(-1).x,0);
      // Bounded stops are prepared only with a new immutable raster. Animation
      // reveals cached color through the existing GPU/Canvas2D compositor.
      const stride = Math.max(1,Math.floor(points.length/24));
      points.forEach((p,i) => {
        if(i%stride!==0 && i!==points.length-1) return;
        const stop=(p.x-points[0].x)/(points.at(-1).x-points[0].x);
        gradient.addColorStop(stop,`rgb(${p.color.join(',')})`);
        coreGradient.addColorStop(stop,`rgb(${p.color.map(v=>Math.round(v*.78)).join(',')})`);
      });
      // Irregular pigment ribbons follow the measured centerline exactly. Their
      // edges vary at paper-grain scale, without moving or inventing pulse peaks.
      // Filled washes avoid the parallel, round-capped bands of a marker stroke.
      const ribbon = (upper, lower, alpha, salt) => {
        ctx.beginPath();
        points.forEach((p,i) => {
          const tooth = .56 + rand(p.seed + salt) * .72;
          const y = p.y - width * upper * tooth;
          if(i) ctx.lineTo(p.x,y); else ctx.moveTo(p.x,y);
        });
        for(let i=points.length-1;i>=0;i--) {
          const p=points[i], tooth=.60+rand(p.seed+salt+29)*.8;
          ctx.lineTo(p.x,p.y+width*lower*tooth*p.wet);
        }
        ctx.closePath();ctx.fillStyle=gradient;ctx.globalAlpha=alpha*(.72+q*.28);ctx.fill();ctx.globalAlpha=1;
      };
      const widthScale = .78 + q*.22;
      ribbon(.44*widthScale,1.62,.09,17);
      ribbon(.37*widthScale,1.22,.16,31);
      ribbon(.31*widthScale,.84,.24,47);
      ribbon(.25*widthScale,.45,.30,63);
      ribbon(.17*widthScale,.20,.34,79);
      // Small translucent deposits overlap into a broken, saturated wet edge.
      // Using the local tangent distributes pigment across the brush width.
      for(let i=1;i<points.length;i++) {
        const p=points[i], prev=points[i-1];
        const dx=p.x-prev.x,dy=p.y-prev.y, length=Math.hypot(dx,dy)||1;
        for(let j=0;j<4;j++) {
          const seed=p.seed+j*41;
          const along=rand(seed+131), across=(rand(seed+137)-.44)*width*.65;
          const x=prev.x+dx*along-dy/length*across;
          const y=prev.y+dy*along+dx/length*across;
          const r=1.1+rand(seed+149)*width*.14;
          ctx.fillStyle=`rgba(${p.depositColor},${(.13+rand(seed+151)*.25)*p.wet})`;
          ctx.beginPath();ctx.ellipse(x,y,r,r*(.4+rand(seed+163)*.5),Math.atan2(dy,dx),0,Math.PI*2);ctx.fill();
        }
      }
      // Deterministic pigment flakes, cauliflower edges and tiny paper breaks.
      // Texture and depth remain fixed to capture quality, never to segment age.
      for(const p of points) {
        for(let k=0;k<4+Math.floor(p.wet*5);k++) {
          const r=rand(p.seed+k*13), side=rand(p.seed+k*23+7);
          const x=p.x+(r-.5)*11, y=p.y+(side-.22)*width*2.1*p.wet;
          const radius=.8+rand(p.seed+k+81)*5.2*p.wet;
          ctx.fillStyle=`rgba(${p.color.join(',')},${side>.55 ? .06+r*.13 : .07+r*.19})`;
          ctx.beginPath();
          for(let v=0;v<5;v++) {
            const angle=v*Math.PI*2/5;
            const px=x+Math.cos(angle)*radius,py=y+Math.sin(angle)*radius*.7;
            if(v)ctx.lineTo(px,py);else ctx.moveTo(px,py);
          }
          ctx.closePath();ctx.fill();
        }
        if(rand(p.seed+93)>.86) {
          ctx.fillStyle=`rgba(253,251,247,${.35+rand(p.seed+111)*.35})`;
          ctx.beginPath();ctx.ellipse(p.x,p.y+width*(.4+rand(p.seed+112)*.7)*p.wet,1+rand(p.seed+113)*3.2,1+rand(p.seed+114)*2.4,0,0,Math.PI*2);ctx.fill();
        }
      }
      // A narrow wet core stays legible over the feathered deposits. Its
      // centerline is the measured path, shared by live, report and exports.
      ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      ctx.strokeStyle=coreGradient;ctx.lineWidth=width*.14;ctx.lineJoin='round';ctx.globalAlpha=.80+q*.20;ctx.stroke();ctx.globalAlpha=1;
    }
  }
}
function saveManuscript() {
  if (!manuscript.segments.length) { alert('No accepted waveform was captured to save.'); return; }
  const first=manuscript.segments[0].points[0].t, last=manuscript.segments.at(-1).points.at(-1).t;
  const rows = Math.floor((last-first)/5)+1;
  // Keep the full recorded time axis, while bounding memory on mobile browsers.
  // Very long interruptions must not allocate an unbounded canvas.
  const scale = Math.min(1, 8192 / (rows * 160));
  const canvas=document.createElement('canvas');canvas.width=Math.max(320,Math.round(1200*scale));canvas.height=Math.min(8192,rows*160);
  paintManuscript(canvas,false,true);
  const ctx=canvas.getContext('2d');ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fdfbf7';ctx.fillRect(0,0,canvas.width,canvas.height);
  try {
    canvas.toBlob(blob=>{if(!blob){alert('The manuscript could not be saved. Try saving the report instead.');return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='pulse-on-paper.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  } catch { alert('The manuscript could not be saved. Try saving the report instead.'); }
}

// examples/app/app.js — dogfoods ppg-js's public API as a third-party dev would.
// PPGMonitor and the hrv module are exposed by ../demo/dist/ppg.global.js (IIFE build)
// as window.PPG.PPGMonitor and window.PPG.hrv.

const screens = {
  ready: document.getElementById('screen-ready'),
  placement: document.getElementById('screen-placement'),
  measuring: document.getElementById('screen-measuring'),
  summary: document.getElementById('screen-summary'),
};

let entryTransition = null;
let sessionStarting = false;
let sessionGeneration = 0;
const pendingMonitorStarts = new Set();

function clearEntryTransition() {
  if (!entryTransition) return;
  cancelAnimationFrame(entryTransition.frame);
  entryTransition = null;
  paintGPU?.endEntry();
  document.getElementById('entry-pigment').hidden = true;
  document.getElementById('btn-start').removeAttribute('aria-busy');
}

// A layered pigment front, born at the pressed button. Camera permission is
// requested in the original click; this only stages the visual reveal.
function beginEntryTransition() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('entry-pigment');
  const rect = document.getElementById('btn-start').getBoundingClientRect();
  const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, w-x), Math.max(y, h-y)) * 1.35;
  // The prepared GPU performs the pigment field and diffusion per fragment.
  // A late bundle or unsupported device uses a cheap wash, never a CPU pixel loop
  // in the camera permission gesture.
  let gpu = paintGPU?.beginEntry(w,h,x,y,Math.max(0,(rect.width-rect.height)/2));
  const transition = { frame: 0, screen: 'placement', began: performance.now() };
  entryTransition = transition;
  canvas.hidden = false;
  document.getElementById('btn-start').setAttribute('aria-busy', 'true');
  function paint(now) {
    if (entryTransition !== transition) return;
    if (document.hidden) { transition.frame = requestAnimationFrame(paint); return; }
    const elapsed = now - transition.began;
    const spread = Math.min(1, elapsed / 900);
    const eased = 1 - Math.pow(1-spread, 2.2);
    const alpha = elapsed > 960 ? Math.max(0, 1-(elapsed-960)/560) : 1;
    const reach = rect.height / 2 + radius * eased;
    const feather = 16 + 20 * eased;
    if (gpu) {
      gpu = paintGPU?.entry(reach, feather, alpha);
      // Keep the transparent fallback surface present until the transition ends;
      // its hidden state is the public lifecycle marker for both renderers.
    }
    if (!gpu) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = alpha;
      canvas.hidden = false;
      ctx.fillStyle = '#477beb';
      ctx.beginPath();ctx.ellipse(x,y,reach+rect.width/3,reach,0,0,Math.PI*2);ctx.fill();
    }
    if (elapsed >= 900 && !transition.revealed) {
      transition.revealed = true;
      showScreen(transition.screen);
    }
    if (elapsed >= 1520) { clearEntryTransition(); return; }
    transition.frame = requestAnimationFrame(paint);
  }
  transition.frame = requestAnimationFrame(paint);
}

function showScreen(name) {
  if (name === 'ready') { clearEntryTransition(); sessionStarting = false; }
  if (entryTransition && !entryTransition.revealed && name !== 'ready') {
    entryTransition.screen = name;
    return;
  }
  for (const key in screens) screens[key].hidden = key !== name;
  document.getElementById('app').dataset.activeScreen = name;
  syncScreenChrome(name);
}

function syncScreenChrome(name) {
  // Keep one real camera video: moving it between visible hosts preserves the
  // capture source and avoids another stream or a colorized preview surrogate.
  const target = document.getElementById(name === 'measuring' ? 'capture-camera-preview' : 'camera-preview');
  if ((name === 'placement' || name === 'measuring') && monitor?.video && monitor.video.parentElement !== target) {
    target.replaceChildren(monitor.video);
    monitor.video.setAttribute('aria-hidden', 'true');
    const playback = monitor.video.play();
    if (playback?.catch) playback.catch(() => {});
  }
  const tools = name === 'measuring' ? document.getElementById('capture-detail-tools')
    : name === 'placement' ? document.getElementById('placement-actions')
    : document.querySelector('.project-attribution');
  tools.append(document.getElementById('btn-debug-menu'));
  const report = name === 'summary';
  document.getElementById('report-menu-actions').hidden = !report;
  document.getElementById('btn-debug-menu').setAttribute('aria-label', report ? 'Report options' : 'More options');
  document.getElementById('debug-sheet').setAttribute('aria-label', report ? 'Report options' : 'More options');
}

let monitor = null;
// Exposed for headless QA only (test/manual/headless-camera-resume.mjs) -
// harmless in production, never read by app logic itself.
Object.defineProperty(window, 'monitor', { get: () => monitor });
const SETTLE_SEC = 6; // default; replaced by the engine's own value once a monitor exists (see settleSec())
const SESSION_SEC = 180; // fixed 3-minute measuring protocol
const waveBuf = new Array(180).fill(0); // ~3s at ~60Hz, matches the demo's live strip
const placementWaveBuf = new Array(180).fill(0); // raw trace shown on the Placement screen too
let measuringStartedAt = null; // Date.now() ms when MEASURING was first reached this session
let portraitStartedAt = null;
let sessionTimerId = null;
let lastMetrics = null; // last per-window metrics object (for the report's floor/respiration)

function settleSec() {
  return monitor && monitor.engine && monitor.engine.fingerState ? monitor.engine.fingerState.settleSec : SETTLE_SEC;
}

function resetWaveBuffer() {
  waveBuf.fill(0);
  placementWaveBuf.fill(0);
}

function drawWaveOn(canvasId, buf) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  const n = buf.length;
  // Values are detrended AC (a few counts out of ~190, i.e. ~0.01), so
  // autoscale to the visible buffer's own range with a small floor.
  let lo = Infinity, hi = -Infinity;
  for (const v of buf) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(hi - lo, 1e-4);
  const pad = canvas.height * 0.1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * canvas.width;
    const y = canvas.height - pad - ((buf[i] - lo) / span) * (canvas.height - 2 * pad);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(20,88,255,.09)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = '#1458ff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawWave() {
  drawWaveOn('wave-canvas', waveBuf);
}

function drawPlacementWave() {
  drawWaveOn('placement-wave-canvas', placementWaveBuf);
}

function drawTachogram() {
  const canvas = document.getElementById('tacho-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!monitor) return;
  const points = monitor.getTachogram().slice(-60);
  if (!points.length) return;
  const ibis = points.map(p => p.ibiMs);
  const min = Math.min(...ibis), max = Math.max(...ibis) || min + 1;
  points.forEach((p, i) => {
    const x = (i / (points.length - 1 || 1)) * canvas.width;
    const y = canvas.height - ((p.ibiMs - min) / (max - min || 1)) * canvas.height;
    ctx.fillStyle = p.valid ? '#2855ff' : '#6b7280';
    ctx.beginPath();
    ctx.arc(x, y, p.valid ? 2.5 : 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

const STATE_TEXT = { NO_FINGER: 'Waiting for finger', SETTLING: 'Finger detected', MEASURING: 'Measuring' };
const REASON_TEXT = {
  finger_placed: 'settling',
  settled: 'signal steady',
  finger_lifted: 'finger lifted',
  large_drift: 'light changed, resettling',
  camera_resumed: 'camera restarted',
};

function updatePlacementScreen(metrics) {
  const remaining = metrics.settleRemainingSec || 0;
  const coachEl = document.getElementById('coach-line');
  const ring = document.getElementById('settle-ring');
  const circumference = 2 * Math.PI * 96;
  if (measuringStartedAt != null) {
    // Bounced out of MEASURING mid-protocol (lift/drift) - the 3-minute
    // countdown is paused (see tickSessionCountdown), not reset; coach the
    // user to resume rather than showing the normal placement copy.
    coachEl.textContent = 'Let’s find your pulse again.';
    ring.style.strokeDashoffset = String(circumference);
  } else if (metrics.fingerState === 'SETTLING') {
    coachEl.textContent = `Signal found. Hold still for ${Math.max(0, Math.ceil(remaining))}s.`;
    const frac = 1 - Math.min(1, remaining / settleSec());
    ring.style.strokeDashoffset = String(circumference * (1 - frac));
  } else {
    coachEl.textContent = metrics.guidanceMessage || 'Cover the rear camera and flash gently.';
    ring.style.strokeDashoffset = String(circumference);
  }
  document.getElementById('torch-note').hidden = monitor ? monitor.torchSupported !== false : true;

  // Muted state+reason line - so the user (and a support/debug read of the
  // screen) can see WHY a SETTLING bounce happened instead of just seeing
  // the ring silently reset (see job 3).
  const stateEl = document.getElementById('state-line');
  const reason = monitor && monitor.engine && monitor.engine.fingerState ? monitor.engine.fingerState.lastReason : null;
  stateEl.textContent = measuringStartedAt != null ? 'Your recording waits while the signal returns.'
    : STATE_TEXT[metrics.fingerState] ? `${STATE_TEXT[metrics.fingerState]}${REASON_TEXT[reason] ? ' · ' + REASON_TEXT[reason] : ''}` : '';
  drawPlacementWave();
}

function updateMeasuringScreen(metrics) {
  const good = metrics.quality && metrics.quality.good;
  document.getElementById('hr-value').textContent = good && Number.isFinite(metrics.heartRate) ? Math.round(metrics.heartRate) : '--';
  document.getElementById('rmssd-value').textContent = good && Number.isFinite(metrics.rmssd) ? Math.round(metrics.rmssd) : '--';
  document.getElementById('sdnn-value').textContent = good && Number.isFinite(metrics.sdnn) ? Math.round(metrics.sdnn) : '--';
  const floorEl = document.getElementById('rmssd-floor');
  if (floorEl) floorEl.textContent = good && metrics.rmssdFloorMs ? `Estimated timing-noise floor: ${Math.round(metrics.rmssdFloorMs)} ms` : '';
  const respEl = document.getElementById('resp-value');
  if (respEl) {
    const r = metrics.respiration;
    if (r && r.rateBpm != null) {
      // Below 0.5 the rate rests on one modulation source or a recent hold.
      respEl.textContent = `${r.confidence < 0.5 ? '≈' : ''}${r.rateBpm.toFixed(0)} br/min`;
    } else {
      respEl.textContent = '--';
    }
  }

  const pill = document.getElementById('quality-pill');
  pill.classList.toggle('good', !!good);
  pill.classList.toggle('bad', !good);
  document.getElementById('quality-text').textContent = good
    ? 'Good signal'
    : (metrics.quality ? metrics.quality.reason : metrics.guidanceMessage) || 'Settling';

  document.getElementById('painting-state').textContent = manuscript.paused ? 'Artwork paused' : good ? 'Painting' : 'Waiting for clear signal';
  drawTachogram();
}

// Fixed 3-minute protocol: starts counting down the moment MEASURING is
// first reached, pauses (holds the last value) while the state drops back
// out of MEASURING (lift/drift), and auto-stops at 0:00. Only fresh camera
// frames earn time; the 1s display interval never advances the protocol.
function fmtCountdown(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let elapsedMeasuringMs = 0;
let lastMeasuringFrame = null;
const MAX_MEASURING_FRAME_GAP_MS = 250;
function advanceSessionClock(time, isProcessing) {
  const now = performance.now();
  if (!isProcessing || measuringStartedAt == null || document.visibilityState !== 'visible' || !Number.isFinite(time)) {
    lastMeasuringFrame = null;
    return;
  }
  if (lastMeasuringFrame) {
    const sampleDelta = (time - lastMeasuringFrame.time) * 1000;
    const deliveryDelta = now - lastMeasuringFrame.deliveredAt;
    if (sampleDelta <= 0) return; // Duplicate/out-of-order frames cannot move the anchor backwards.
    // A muted camera can retain MEASURING. Neither that stale state nor a
    // queued callback after a suspension earns the missing interval.
    if (sampleDelta > 0 && sampleDelta <= MAX_MEASURING_FRAME_GAP_MS && deliveryDelta >= 0 && deliveryDelta <= MAX_MEASURING_FRAME_GAP_MS) {
      elapsedMeasuringMs += sampleDelta;
    }
  }
  lastMeasuringFrame = { time, deliveredAt: now };
}
document.addEventListener('visibilitychange', () => { lastMeasuringFrame = null; });
function tickSessionCountdown() {
  const el = document.getElementById('session-countdown');
  if (measuringStartedAt == null) {
    el.textContent = fmtCountdown(SESSION_SEC);
    return;
  }
  const elapsedSec = elapsedMeasuringMs / 1000;
  const remaining = SESSION_SEC - elapsedSec;
  el.textContent = fmtCountdown(remaining);
  if (remaining <= 0) {
    stopSession();
  }
}

function renderSummary() {
  // Only beats from windows that passed the quality gate, with their real
  // timestamps so gaps between accepted beats are handled correctly.
  const beats = monitor.getTachogram({ goodOnly: true, hrvOnly: true }).filter(p => p.valid).map(p => ({ t: p.t, ibiMs: p.ibiMs }));
  renderReport(beats, lastMetrics ? lastMetrics.rmssdFloorMs : undefined, lastMetrics ? lastMetrics.respiration : null);
}

// ------------------------------------------------------------ HRV report --

function fmt(v, digits) {
  if (v == null || Number.isNaN(v) || v === 'n/a') return '--';
  return typeof v === 'number' ? v.toFixed(digits == null ? 0 : digits) : String(v);
}

function ansInterpretation(pnsIndex, snsIndex) {
  const label = (z, posWord, negWord) => {
    if (Math.abs(z) < 0.5) return 'near the population average';
    return z > 0 ? `above average (${posWord})` : `below average (${negWord})`;
  };
  return `Parasympathetic (PNS) activity is ${label(pnsIndex, 'more rest-and-digest tone', 'less rest-and-digest tone')}; ` +
    `sympathetic (SNS) activity is ${label(snsIndex, 'more arousal/stress tone', 'less arousal/stress tone')}.`;
}

function drawBipolarBar(canvasParent, value, cls) {
  const RANGE = 3; // domain shown; tick marks below are only -2..+2 per spec
  const clamped = Math.max(-RANGE, Math.min(RANGE, value || 0));
  const pctOf = (v) => ((v + RANGE) / (2 * RANGE)) * 100;
  const zeroPct = pctOf(0);
  const valuePct = pctOf(clamped);

  const bar = document.createElement('div');
  bar.className = 'bipolar-bar';

  const fill = document.createElement('div');
  fill.className = `fill ${cls}`;
  const left = Math.min(valuePct, zeroPct);
  const width = Math.abs(valuePct - zeroPct);
  fill.style.left = left + '%';
  fill.style.width = width + '%';
  bar.appendChild(fill);

  const zero = document.createElement('div');
  zero.className = 'zero-line';
  bar.appendChild(zero);

  const valueLabel = document.createElement('div');
  valueLabel.className = `bar-value-label ${cls}`;
  valueLabel.textContent = fmt(value, 2);
  valueLabel.style.left = valuePct + '%';
  valueLabel.style.transform = clamped <= -2 ? 'translate(0, -100%)' : clamped >= 2 ? 'translate(-100%, -100%)' : 'translate(-50%, -100%)';
  if (Math.abs(value) > RANGE) valueLabel.textContent += ' (off scale)';
  bar.appendChild(valueLabel);

  canvasParent.appendChild(bar);

  const ticks = document.createElement('div');
  ticks.className = 'bipolar-ticks';
  for (let t = -2; t <= 2; t++) {
    const tick = document.createElement('span');
    tick.style.left = pctOf(t) + '%';
    tick.textContent = (t > 0 ? '+' : '') + t;
    ticks.appendChild(tick);
  }
  canvasParent.appendChild(ticks);

  // The label is absolutely positioned, so it needs a positioned parent of
  // its own; otherwise it anchors to the page and floats over other cards
  // while the report scrolls.
  const meanRow = document.createElement('div');
  meanRow.className = 'bipolar-mean';
  const meanLabel = document.createElement('div');
  meanLabel.className = 'zero-mean-label';
  meanLabel.textContent = 'population mean';
  meanLabel.style.left = zeroPct + '%';
  meanRow.appendChild(meanLabel);
  canvasParent.appendChild(meanRow);
}

// Shared canvas setup: backs the canvas at devicePixelRatio and returns a
// context pre-scaled to CSS pixels, plus the CSS-pixel width/height to draw
// with. Call once per draw before any drawing commands.
function setupHiDPICanvas(canvas) {
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const cssH = canvas.id === 'poincare-canvas' ? cssW + 48 : 248;
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, W: cssW, H: cssH };
}

const AXIS_FONT = '15px "DM Sans", sans-serif';
const AXIS_COLOR = '#52627c';
const GRID_COLOR = '#dce3ee';

// Measure quantities before laying out the plot. Units live above/below the
// axes, never in the tick gutters; endpoint labels stay inside the canvas.
function chartFrame(ctx, W, H, labels, yTitle, xTitle, square = false) {
  ctx.font = AXIS_FONT;
  const left = Math.ceil(Math.max(...labels.map(v => ctx.measureText(v).width))) + 20;
  const top = 42, right = 22, bottom = 60;
  const width = W - left - right;
  const height = square ? Math.min(width, H - top - bottom) : H - top - bottom;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = AXIS_COLOR; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(yTitle, 12, 12);
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(xTitle, left + width / 2, H - 10);
  return { padL: left, padR: right, padT: top, padB: H - top - height, plotW: width, plotH: height };
}
function chartTick(ctx, text, x, y, W) {
  const half = ctx.measureText(text).width / 2;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(text, Math.max(half + 8, Math.min(W - half - 8, x)), y);
}
// Presentation-only domains: round outward to readable, evenly spaced ticks.
// The source samples and every reported scientific metric stay unchanged.
function chartDomain(low, high, count, minimumStep = 0) {
  const raw = Math.max((high - low) / count, minimumStep, Number.MIN_VALUE);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 3, 5, 10, 20];
  for (const multiple of steps) {
    const step = multiple * magnitude;
    if (step < raw * (1 - 1e-12)) continue;
    const min = Math.floor(low / step + 1e-10) * step;
    const max = min + count * step;
    if (max >= high - step * 1e-10) return { min, max, step };
  }
}
function powerLabel(value, axisMax, step) {
  if (value === 0) return '0';
  // Choose a single notation for the whole axis, including its smaller ticks.
  if (axisMax >= 1e6 || axisMax < 0.01) return value.toExponential(1);
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function drawPSD(canvas, fd) {
  const { ctx, W, H } = setupHiDPICanvas(canvas);
  if (!fd.ok) return;
  const maxF = 0.5;
  const idx = fd.freqs.map((f, i) => i).filter(i => fd.freqs[i] <= maxF);
  const peak = Math.max(...idx.map(i => fd.psd[i]), 1e-6) * 1.1;
  const { max: maxP, step: powerStep } = chartDomain(0, peak, 4);
  const yLabels = Array.from({ length: 5 }, (_, t) => powerLabel(powerStep * t, maxP, powerStep));
  const { padL, padR, padT, plotW, plotH } = chartFrame(ctx, W, H, yLabels, 'Power density (ms²/Hz)', 'Frequency (Hz)');
  const xOf = (f) => padL + (f / maxF) * plotW;
  const yOf = (p) => padT + plotH - (p / maxP) * plotH;

  // shaded bands (behind curve)
  const bandColor = (f) => f < 0.04 ? 'rgba(82,102,130,0.10)' : f < 0.15 ? 'rgba(40,85,255,0.08)' : f <= 0.4 ? 'rgba(19,117,140,0.09)' : 'transparent';
  const bandEdges = [0.0033, 0.04, 0.15, 0.4];
  for (let i = 0; i < bandEdges.length - 1; i++) {
    const f0 = bandEdges[i], f1 = bandEdges[i + 1];
    ctx.fillStyle = bandColor((f0 + f1) / 2);
    ctx.fillRect(xOf(f0), padT, xOf(f1) - xOf(f0), plotH);
  }

  // y gridlines + labels (3-4 ticks)
  ctx.font = AXIS_FONT;
  ctx.fillStyle = AXIS_COLOR;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const p = (maxP / yTicks) * t;
    const y = yOf(p);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(yLabels[t], padL - 10, y);
  }
  for (let t = 0; t <= 5; t++) {
    const f = t / 10;
    chartTick(ctx, f.toFixed(1), xOf(f), padT + plotH + 10, W);
  }

  // filled smooth area under the PSD curve
  ctx.beginPath();
  idx.forEach((i, k) => {
    const x = xOf(fd.freqs[i]), y = yOf(fd.psd[i]);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo(xOf(fd.freqs[idx[idx.length - 1]]), padT + plotH);
  ctx.lineTo(xOf(fd.freqs[idx[0]]), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(40,85,255,0.06)';
  ctx.fill();
  ctx.beginPath();
  idx.forEach((i, k) => {
    const x = xOf(fd.freqs[i]), y = yOf(fd.psd[i]);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#2855ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Band names and ranges remain in the wrapping HTML legend below.

}

function drawPoincare(canvas, nl, flagged) {
  const { ctx, W, H } = setupHiDPICanvas(canvas);
  const pts = nl.poincarePoints;
  if (!pts || !pts.length) return;
  // A point (rr[i], rr[i+1]) is an outlier if either beat was flagged as an
  // artifact; autoscale to the accepted (non-outlier) points only so a rare
  // spike can't squash the cluster, matching the tachogram/PSD treatment.
  const isOutlier = (i) => !!(flagged && (flagged[i] || flagged[i + 1]));
  const accepted = pts.filter((_, i) => !isOutlier(i));
  const scaleSrc = accepted.length ? accepted.flat() : pts.flat();
  const dataMin = Math.min(...scaleSrc), dataMax = Math.max(...scaleSrc);
  const span = Math.max(dataMax - dataMin, 5);
  const midpoint = (dataMin + dataMax) / 2;
  const ticks = W < 360 ? 3 : 4;
  const { min, max } = chartDomain(midpoint - span * 0.58, midpoint + span * 0.58, ticks, 1);
  const labels = Array.from({ length: ticks + 1 }, (_, t) => (min + (max - min) * t / ticks).toFixed(0));
  const { padL, padT, plotW, plotH } = chartFrame(ctx, W, H, labels, 'Next RR interval (ms)', 'RR interval (ms)', true);
  const clip = (v) => Math.max(min, Math.min(max, v));
  const toXY = (rrN, rrN1) => [
    padL + ((clip(rrN) - min) / (max - min)) * plotW,
    padT + plotH - ((clip(rrN1) - min) / (max - min)) * plotH,
  ];

  // gridlines + shared tick scale on both axes (same units, same range)
  ctx.font = AXIS_FONT;
  ctx.strokeStyle = GRID_COLOR;
  ctx.fillStyle = AXIS_COLOR;
  ctx.lineWidth = 1;

  for (let t = 0; t <= ticks; t++) {
    const v = min + ((max - min) / ticks) * t;
    const [x] = toXY(v, min);
    const [, y] = toXY(min, v);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    chartTick(ctx, v.toFixed(0), x, padT + plotH + 10, W);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(0), padL - 5, y);
  }
  // identity line y = x
  ctx.strokeStyle = 'rgba(167,173,186,0.4)';
  ctx.setLineDash([4, 4]);
  const [x0, y0] = toXY(min, min), [x1, y1] = toXY(max, max);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.setLineDash([]);

  // accepted points
  ctx.fillStyle = 'rgba(40,85,255,0.55)';
  accepted.forEach(([a, b]) => {
    const [x, y] = toXY(a, b);
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  });

  // outliers: hollow orange, clipped to axis range
  let offScale = 0;
  ctx.strokeStyle = '#b46a26';
  ctx.lineWidth = 1.2;
  pts.forEach(([a, b], i) => {
    if (!isOutlier(i)) return;
    if (a < min || a > max || b < min || b > max) offScale++;
    const [x, y] = toXY(a, b);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.stroke();
  });

  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
  // SD1/SD2 ellipse centered at (mean,mean), rotated 45deg
  const meanV = scaleSrc.reduce((s, v) => s + v, 0) / scaleSrc.length;
  const [cx, cy] = toXY(meanV, meanV);
  const scale = plotW / (max - min);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4);
  ctx.strokeStyle = '#13758c';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, nl.sd2 * scale, nl.sd1 * scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
  const legend = canvas.parentElement.querySelector('.poincare-legend');
  if (legend) legend.innerHTML = '<span class="accepted">Accepted pairs</span><span class="ellipse">SD1/SD2 ellipse</span><span class="artifact">Flagged pairs</span>' + (offScale ? `<span class="off-scale">${offScale} flagged pair${offScale === 1 ? '' : 's'} at the plot boundary (off scale)</span>` : '');

}

function drawReportTachogram(canvas, beats, flagged, correctedMs) {
  const { ctx, W, H } = setupHiDPICanvas(canvas);
  const ibiMs = beats.map(b => typeof b === 'number' ? b : b.ibiMs);
  if (!ibiMs.length) return;
  const dataMin = Math.min(...ibiMs), dataMax = Math.max(...ibiMs) || Math.min(...ibiMs) + 1;
  const span = Math.max(dataMax - dataMin, 5);
  const midpoint = (dataMin + dataMax) / 2;
  const { min, max } = chartDomain(midpoint - span * 0.6, midpoint + span * 0.6, 3, 1);
  const timestamped = beats.every(b => Number.isFinite(b.t));
  const origin = timestamped ? beats[0].t - ibiMs[0] / 1000 : 0;
  let cumulative = 0;
  const times = beats.map((b, i) => {
    cumulative += ibiMs[i] / 1000;
    return timestamped ? b.t - origin : cumulative;
  });
  const totalSec = times[times.length - 1];

  const labels = Array.from({ length: 4 }, (_, t) => (min + (max - min) * t / 3).toFixed(0));
  const { padL, padR, padT, plotW, plotH } = chartFrame(ctx, W, H, labels, 'RR interval (ms)', 'Elapsed time (min:sec)');
  const xOf = (t) => padL + (t / (totalSec || 1)) * plotW;
  const yOf = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  ctx.font = AXIS_FONT;
  ctx.strokeStyle = GRID_COLOR;
  ctx.fillStyle = AXIS_COLOR;
  ctx.lineWidth = 1;

  // y ticks (RR ms), 4 ticks
  for (let t = 0; t <= 3; t++) {
    const v = min + ((max - min) / 3) * t;
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(0), padL - 5, y);
  }
  const nTicks = W < 360 ? 3 : 5;
  for (let t = 0; t <= nTicks; t++) {
    const positionSec = (totalSec / nTicks) * t;
    const sec = Math.round(positionSec);
    const mm = Math.floor(sec / 60), ss = sec % 60;
    chartTick(ctx, `${mm}:${String(ss).padStart(2, '0')}`, xOf(positionSec), padT + plotH + 10, W);
  }

  // corrected-vs-raw dashed segment where a beat was corrected
  if (correctedMs && correctedMs.length === ibiMs.length) {
    ctx.strokeStyle = 'rgba(167,173,186,0.8)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ibiMs.forEach((v, i) => {
      if (!flagged || !flagged[i]) return;
      const x = xOf(times[i]);
      ctx.beginPath();
      ctx.moveTo(x, yOf(v));
      ctx.lineTo(x, yOf(correctedMs[i]));
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // raw RR line
  ctx.strokeStyle = '#2855ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ibiMs.forEach((v, i) => {
    const x = xOf(times[i]), y = yOf(v);
    // A beat's IBI describes the interval immediately before it, not all
    // elapsed time since the previous accepted window. Leave missing time
    // blank instead of connecting across rejected/lost signal.
    const gap = i > 0 && timestamped && times[i] - times[i - 1] > ibiMs[i] / 1000 + 0.1;
    if (i === 0 || gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // artifacts as hollow orange dots
  ctx.strokeStyle = '#b46a26';
  ctx.lineWidth = 1.2;
  ibiMs.forEach((v, i) => {
    if (!flagged || !flagged[i]) return;
    const x = xOf(times[i]), y = yOf(v);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// Builds the full scrollable report from accepted beats ({t, ibiMs} or plain ms).
// Exposed via renderSummary() in the real flow and window.__demoReport() for QA.
let reportChartObserver;
let portraitHost = null;
let redrawReportCharts = () => {};
window.addEventListener('beforeprint', () => redrawReportCharts());
window.addEventListener('afterprint', () => redrawReportCharts());
if (document.fonts) document.fonts.ready.then(() => redrawReportCharts());

function renderReport(acceptedBeats, rmssdFloorMs, liveRespiration) {
  const el = document.getElementById('report-content');
  if (portraitHost) window.PulsePortrait?.clear(portraitHost);
  portraitHost = null;
  document.getElementById('btn-share-artwork').disabled = true;
  document.getElementById('btn-save-artwork').disabled = true;
  document.getElementById('btn-save-manuscript').disabled = !manuscript.segments.length;
  el.innerHTML = '';

  const beats = acceptedBeats.map(b => (typeof b === 'number' ? { ibiMs: b } : b));
  const acceptedIbiMs = beats.map(b => b.ibiMs);
  if (!beats.length) {
    el.innerHTML = `
      <h1 class="report-title">Your pulse report<span class="blue-period">.</span></h1>
      <p class="insufficient">No good-quality windows were captured this session — try again with steadier finger placement.</p>
    `;
    return;
  }

  const fusionRespBpm = liveRespiration && liveRespiration.rateBpm != null && liveRespiration.confidence >= 0.5 ? liveRespiration.rateBpm : undefined;
  const result = PPG.hrv.analyzeHRV(beats, { rmssdFloorMs, respirationRateBpm: fusionRespBpm });
  const td = result.timeDomain, fd = result.frequencyDomain, nl = result.nonlinear, ans = result.ans, si = result.stressIndex;
  const durationSec = result.meta.durationSec;
  const goodFraction = monitor && monitor.getSessionSummary ? monitor.getSessionSummary().goodFraction : null;
  const goodPct = Number.isFinite(goodFraction) ? Math.round(goodFraction * 100) : null;

  const header = document.createElement('div');
  header.className = 'report-card report-header';
  header.innerHTML = `
    <h1 class="report-title">Your pulse report<span class="blue-period">.</span></h1>
    <p class="report-date">${new Date().toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})} · ${(durationSec/60).toFixed(1)} min analyzed</p>
    <canvas id="report-manuscript" width="1000" height="260" aria-label="A detail of your captured pulse manuscript"></canvas>
    <p class="report-subtitle">Camera-derived pulse variability</p>
    <div class="report-heroes"><div><span>Mean pulse</span><strong>${td.ok?fmt(td.meanHR,0):'--'} <small>bpm</small></strong></div><div><span>RMSSD</span><strong>${td.ok?fmt(td.rmssd,1):'--'} <small>ms</small></strong></div><div><span>SDNN</span><strong>${td.ok?fmt(td.sdnn,1):'--'} <small>ms</small></strong></div></div>
    <div class="recording-quality"><h3>Recording quality</h3><strong>${goodPct == null ? '—' : goodPct+'%'}</strong><p>Good-signal windows</p><progress max="100" value="${goodPct == null ? 0 : goodPct}" aria-label="Good-signal windows">${goodPct}%</progress><div class="quality-facts"><span><b>${result.meta.nBeats}</b> beats used</span><span><b>${result.meta.pctCorrected.toFixed(1)}%</b> corrected</span></div></div>
  `;
  el.appendChild(header);
  paintManuscript(document.getElementById('report-manuscript'),true);
  document.getElementById('report-manuscript').hidden = !manuscript.segments.length;
  if (manuscript.segments.length && window.PulsePortrait) {
    portraitHost = document.createElement('div');
    // Keep the artwork near the beginning while retaining the full scientific
    // report and its measured values immediately below it.
    header.querySelector('.report-date').after(portraitHost);
    document.getElementById('report-manuscript').hidden = true;
    void window.PulsePortrait.mount(portraitHost, {
      shareButton: document.getElementById('btn-share-artwork'),
      saveButton: document.getElementById('btn-save-artwork'),
      segments: manuscript.segments,
      start: manuscript.segments[0].points[0].t,
      end: manuscript.segments.at(-1).points.at(-1).t,
      durationSec: elapsedMeasuringMs / 1000,
      startedAt: new Date(portraitStartedAt || Date.now()),
      metrics: { hr: td.ok ? td.meanHR : null, rmssd: td.ok ? td.rmssd : null, sdnn: td.ok ? td.sdnn : null },
      pigmentAt,
      paintRows: (canvas, rowIndices) => paintManuscriptRaster(canvas, false, true, null, true, { rowIndices }),
    });
  }

  // ANS balance card
  const ansCard = document.createElement('div');
  ansCard.className = 'report-card';
  ansCard.innerHTML = '<h3 style="margin-top:0">ANS balance <span class="experimental">Research estimate</span></h3><p class="report-note">Relative to a population reference.</p>';
  if (ans.ok) {
    const pnsWrap = document.createElement('div');
    pnsWrap.className = 'ans-bar-wrap';
    pnsWrap.innerHTML = '<div class="bar-label"><span>PNS index</span><span></span></div>';
    drawBipolarBar(pnsWrap, ans.pnsIndex, 'pns');
    const snsWrap = document.createElement('div');
    snsWrap.className = 'ans-bar-wrap';
    snsWrap.innerHTML = '<div class="bar-label"><span>SNS index</span><span></span></div>';
    drawBipolarBar(snsWrap, ans.snsIndex, 'sns');
    ansCard.appendChild(pnsWrap);
    ansCard.appendChild(snsWrap);
    const line = document.createElement('p');
    line.className = 'ans-line';
    line.innerHTML = 'Preliminary research estimates, not a diagnosis.<details class="ans-methods"><summary>Interpretation &amp; reference</summary><p>' + ansInterpretation(ans.pnsIndex, ans.snsIndex) + '</p><p>z-scores of mean RR and RMSSD (PNS), and mean HR and square-root stress index (SNS), against published short-term adult references.</p></details>';
    ansCard.appendChild(line);
  } else {
    ansCard.innerHTML += `<p class="insufficient">${ans.reason}</p>`;
  }
  el.appendChild(ansCard);

  // Time domain
  const tdCard = document.createElement('div');
  tdCard.className = 'report-card';
  tdCard.innerHTML = '<h3 style="margin-top:0">Time domain</h3>';
  if (td.ok) {
    tdCard.innerHTML += `
      <table class="hrv-table">
        <tr><td>Mean RR</td><td>${fmt(td.meanRR, 0)} ms</td></tr>
        <tr><td>Mean HR</td><td>${fmt(td.meanHR, 0)} bpm</td></tr>
        <tr><td>Min / Max HR (5-beat avg)</td><td>${fmt(td.minHR, 0)} / ${fmt(td.maxHR, 0)} bpm</td></tr>
        <tr><td>SDNN</td><td>${fmt(td.sdnn, 1)} ms</td></tr>
        <tr><td>RMSSD</td><td>${fmt(td.rmssd, 1)} ms${Number.isFinite(rmssdFloorMs) ? ` <span class="floor">(${fmt(rmssdFloorMs, 0)} ms estimated timing-noise floor)</span>` : ''}</td></tr>
        <tr><td>lnRMSSD</td><td>${fmt(td.lnRmssd, 2)}</td></tr>
        <tr><td>RMSSD, last 60 s</td><td>${fmt(result.ultraShort.rmssd, 1)} ms (${result.ultraShort.n} beats)</td></tr>
        <tr><td>NN50 / pNN50</td><td>${fmt(td.nn50, 0)} / ${fmt(td.pnn50, 1)}%</td></tr>
        <tr><td>HRV triangular index</td><td>${fmt(td.triangularIndex, 1)}</td></tr>
        <tr><td>TINN / RR range</td><td>${fmt(td.tinn, 0)} / ${fmt(td.rrRange, 0)} ms</td></tr>
        <tr><td>Stress index (Baevsky / √)</td><td>${fmt(si.baevsky, 0)} / ${fmt(si.sqrt, 1)}</td></tr>
      </table>`;
  } else {
    tdCard.innerHTML += `<p class="insufficient">${td.reason}</p>`;
  }
  el.appendChild(tdCard);

  // Frequency domain
  const fdCard = document.createElement('div');
  fdCard.className = 'report-card';
  fdCard.innerHTML = '<h3 style="margin-top:0">Frequency domain</h3>';
  if (fd.ok) {
    fdCard.innerHTML += `
      <div class="report-canvas-wrap">
        <canvas id="psd-canvas" width="440" height="248" role="img" aria-label="Power spectral density of RR intervals by frequency"></canvas>
        <div class="psd-legend"><span class="vlf">VLF 0.0033-0.04 Hz</span><span class="lf">LF 0.04-0.15 Hz</span><span class="hf">HF 0.15-0.4 Hz</span></div>
      </div>
      <table class="hrv-table">
        <tr><td>Total power</td><td>${fmt(fd.totalPower, 0)} ms&sup2;${fd.ultraShort ? ' <span class="floor">(under 2 min: LF/HF are indicative only)</span>' : ''}</td></tr>
        <tr><td>VLF power</td><td>${fd.vlf ? fmt(fd.vlf.power, 0) + ' ms&sup2;' : 'n/a (needs 5 min)'}</td></tr>
        <tr><td>LF power (peak)</td><td>${fmt(fd.lf.power, 0)} ms&sup2; (${fmt(fd.lf.peakFrequency, 3)} Hz)</td></tr>
        <tr><td>HF power (peak)</td><td>${fmt(fd.hf.power, 0)} ms&sup2; (${fmt(fd.hf.peakFrequency, 3)} Hz)</td></tr>
        <tr><td>LF/HF ratio</td><td>${fmt(fd.lfhf, 2)}</td></tr>
        <tr><td>LF n.u. / HF n.u.</td><td>${fmt(fd.lfnu, 1)} / ${fmt(fd.hfnu, 1)}</td></tr>
        <tr><td>Respiration rate (HF peak)</td><td>${fmt(fd.respirationRateBpm, 1)} breaths/min</td></tr>
        <tr><td>Respiration rate (pulse-train fusion)</td><td>${liveRespiration && liveRespiration.rateBpm != null ? `${fmt(liveRespiration.rateBpm, 1)} breaths/min (confidence ${fmt(liveRespiration.confidence, 2)})` : '--'}</td></tr>
        <tr><td>Coherence (0.04-0.26 Hz peak share)</td><td>${fmt(fd.coherence, 2)}</td></tr>
      </table>
      ${fd.respirationInLf ? `<p class="report-note">Breathing was slower than 9 breaths/min (${fmt(fusionRespBpm, 1)}/min), so respiratory sinus arrhythmia falls in the LF band. Read LF, LF n.u. and LF/HF as breathing-driven, not sympathetic; the HF-peak respiration rate is not the breathing rate here.</p>` : ''}`;
  } else {
    fdCard.innerHTML += `<p class="insufficient">${fd.reason}</p>`;
  }
  el.appendChild(fdCard);
  if (fd.ok) drawPSD(document.getElementById('psd-canvas'), fd);

  // Nonlinear
  const nlCard = document.createElement('div');
  nlCard.className = 'report-card';
  nlCard.innerHTML = '<h3 style="margin-top:0">Nonlinear</h3>';
  if (nl.ok) {
    nlCard.innerHTML += `
      <div class="report-canvas-wrap">
        <canvas id="poincare-canvas" width="300" height="308" role="img" aria-label="Poincaré plot of consecutive RR interval pairs"></canvas>
        <div class="poincare-legend"><span>SD1/SD2 ellipse</span></div>
      </div>
      <table class="hrv-table">
        <tr><td>SD1</td><td>${fmt(nl.sd1, 1)} ms</td></tr>
        <tr><td>SD2</td><td>${fmt(nl.sd2, 1)} ms</td></tr>
        <tr><td>SD1/SD2 ratio</td><td>${fmt(nl.sd1sd2Ratio, 2)}</td></tr>
        <tr><td>Sample entropy (m=2, r=0.2&middot;SDNN)</td><td>${fmt(nl.sampleEntropy, 2)}</td></tr>
        <tr><td>DFA &alpha;1 (4-16 beats)</td><td>${fmt(nl.dfaAlpha1, 2)}</td></tr>
      </table>
      ${nl.note ? `<p class="insufficient">${nl.note}</p>` : ''}`;
  } else {
    nlCard.innerHTML += `<p class="insufficient">${nl.note || 'Not enough beats.'}</p>`;
  }
  el.appendChild(nlCard);
  if (nl.ok) drawPoincare(document.getElementById('poincare-canvas'), nl, result.meta.flagged);

  // Tachogram
  const tachoCard = document.createElement('div');
  tachoCard.className = 'report-card';
  tachoCard.innerHTML = `
    <h3 style="margin-top:0">RR tachogram (whole session)</h3>
    <div class="report-canvas-wrap"><canvas id="report-tacho-canvas" width="440" height="248" role="img" aria-label="RR intervals across the recording with flagged beats"></canvas></div>
    <p class="report-note">Orange dots mark beats flagged as artifacts (&gt;20% deviation from local median) and corrected for frequency analysis.</p>
  `;
  el.appendChild(tachoCard);
  drawReportTachogram(document.getElementById('report-tacho-canvas'), beats, result.meta.flagged, PPG.hrv.correctArtifacts(acceptedIbiMs).corrected);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'report-footer';
  footer.innerHTML = `
    <p><strong>Method notes:</strong> beats come only from windows that passed the signal-quality gate; the
    measurement floor next to RMSSD is the variability the pipeline's own beat-timing noise would produce on a
    perfectly regular pulse. A camera measures pulse-rate variability, which tracks heart-rate variability at rest.
    Time/frequency/nonlinear metrics per Task Force of ESC/NASPE (1996, Circulation 93:1043-65); TINN is the
    least-squares triangle fit; PSD via Welch's method (Hann, 50% overlap) on the RR series resampled at 4 Hz with
    real beat times; VLF only for recordings of 5 min or more. Stress index per Baevsky (AMo / 2&middot;Mo&middot;MxDMn) with
    the square root Kubios reports. PNS/SNS indices are z-scores against Nunan, Sandercock &amp; Brodie (2010, PACE
    33:1407-17) short-term adult references and the Kubios 7-12 &radic;SI normal range: a
    <strong>population reference, not a diagnosis</strong>. Not a medical device.</p>
  `;
  el.appendChild(footer);
  el.insertBefore(tdCard, ansCard);
  if (td.ok) {
    const fullTable=tdCard.querySelector('table');
    const detail=document.createElement('details');detail.className='time-details';
    const summary=document.createElement('summary');summary.textContent='All time-domain measurements';
    detail.append(summary,fullTable);
    tdCard.append(detail);
    const compact=document.createElement('table');compact.className='hrv-table';
    compact.innerHTML=`<tr><td>Mean RR</td><td>${fmt(td.meanRR,0)} ms</td></tr><tr><td>Pulse range<br><small>(5-beat average)</small></td><td>${fmt(td.minHR,0)} – ${fmt(td.maxHR,0)} bpm</td></tr><tr><td>Estimated timing-noise floor</td><td>${Number.isFinite(rmssdFloorMs)?fmt(rmssdFloorMs,0)+' ms':'Unavailable'}</td></tr>`;
    tdCard.insertBefore(compact,detail);
  }
  for (const [card, label] of [[fdCard,'Frequency analysis'],[nlCard,'Nonlinear analysis'],[tachoCard,'Beat timing & methods']]) {
    const details=document.createElement('details');details.className='report-disclosure';
    const summary=document.createElement('summary');summary.textContent=label;
    card.before(details);details.append(summary,card);
    if(card===tachoCard) details.append(footer);
    details.addEventListener('toggle',()=>{ if(!details.open)return;
      if(card===fdCard && fd.ok) drawPSD(document.getElementById('psd-canvas'),fd);
      if(card===nlCard && nl.ok) drawPoincare(document.getElementById('poincare-canvas'),nl,result.meta.flagged);
      if(card===tachoCard) drawReportTachogram(document.getElementById('report-tacho-canvas'),beats,result.meta.flagged,PPG.hrv.correctArtifacts(acceptedIbiMs).corrected);
    });
  }
  redrawReportCharts = () => {
    const psd = document.getElementById('psd-canvas');
    const poincare = document.getElementById('poincare-canvas');
    const tacho = document.getElementById('report-tacho-canvas');
    if (psd?.clientWidth && fd.ok) drawPSD(psd, fd);
    if (poincare?.clientWidth && nl.ok) drawPoincare(poincare, nl, result.meta.flagged);
    if (tacho?.clientWidth) drawReportTachogram(tacho, beats, result.meta.flagged, PPG.hrv.correctArtifacts(acceptedIbiMs).corrected);
  };
  reportChartObserver?.disconnect();
  if (typeof ResizeObserver !== 'undefined') {
    reportChartObserver = new ResizeObserver(() => redrawReportCharts());
    el.querySelectorAll('.report-canvas-wrap').forEach(wrap => reportChartObserver.observe(wrap));
  }
  tdCard.insertAdjacentHTML('beforeend','<p class="report-note">The timing-noise floor is an estimate, not a confidence interval.</p>');
}

function startSession() {
  // Strict phone gate at the point of camera access too - not just the
  // Ready-screen UI disable, so this can never be invoked (e.g. via the
  // console or a future button) on desktop and grab getUserMedia there.
  if (!isPhone || sessionStarting) return;
  if (portraitHost) { window.PulsePortrait?.clear(portraitHost); portraitHost = null; }
  sessionStarting = true;
  const generation = ++sessionGeneration;
  beginEntryTransition();
  showScreen('placement');
  resetWaveBuffer();
  resetManuscript();
  document.querySelector('.live-details').open = false;
  elapsedMeasuringMs = 0; lastMeasuringFrame = null;
  measuringStartedAt = null;
  portraitStartedAt = null;
  document.getElementById('session-countdown').textContent = fmtCountdown(SESSION_SEC);
  if (sessionTimerId) clearInterval(sessionTimerId);
  sessionTimerId = setInterval(tickSessionCountdown, 1000);

  lastMetrics = null;
  if (monitor) { monitor.destroy(); monitor = null; }
  monitor = new PPGMonitor(null, {
    ui: { enabled: false },
    // Recompute accepted HR and rolling 60-second HRV once a second; the
    // five-second signal window, quality gate and filter edge guard stay intact.
    signal: { hopSec: 1 },
    debug: { persistLastSession: true }, // powers the debug menu's "share last log"
    wakeLock: true, // keep the screen on for the 3-minute protocol
    motion: true, // accelerometer motion gate (asks permission on iOS)
    onReady: ({ torchSupported }) => {
      if (generation !== sessionGeneration) return;
      document.getElementById('torch-note').hidden = torchSupported !== false;
    },
    onQualityUpdate: (metrics) => {
      if (generation !== sessionGeneration) return;
      lastMetrics = metrics;
      acceptPaintWindow(metrics);
      if (metrics.fingerState === 'MEASURING') {
        if (measuringStartedAt == null) { measuringStartedAt = Date.now(); portraitStartedAt ??= measuringStartedAt; }
        if (screens.measuring.hidden) showScreen('measuring');
        updateMeasuringScreen(metrics);
      } else {
        if (screens.placement.hidden && screens.measuring.hidden === false) {
          // dropped back out of MEASURING (lift/drift) — show placement coaching again
          showScreen('placement');
        }
        updatePlacementScreen(metrics);
      }
    },
    onSignalUpdate: ({ time, value, isProcessing }) => {
      if (generation !== sessionGeneration) return;
      advanceSessionClock(time, isProcessing);
      if (isProcessing && !manuscript.paused && Number.isFinite(value)) manuscript.pending.push({ t:time, v:value });
      if (manuscript.pending.length > 1800) manuscript.pending.shift();
      waveBuf.push(value);
      waveBuf.shift();
      placementWaveBuf.push(value);
      placementWaveBuf.shift();
      if (!screens.measuring.hidden && document.querySelector('.live-details').open) drawWave();
      if (!screens.placement.hidden) drawPlacementWave();
    },
    onError: (err) => {
      if (generation !== sessionGeneration) return;
      if (sessionTimerId) { clearInterval(sessionTimerId); sessionTimerId = null; }
      clearEntryTransition();
      // PPGError carries a stable code and user-facing guidance.
      alert(err && err.guidance ? err.guidance : 'Camera error: ' + (err && err.message ? err.message : err));
      showScreen('ready');
    },
  });

  const currentMonitor = monitor;
  pendingMonitorStarts.add(currentMonitor);
  currentMonitor.start().then(() => {
    pendingMonitorStarts.delete(currentMonitor);
    if (generation !== sessionGeneration) { currentMonitor.destroy(); return; }
    syncScreenChrome(screens.measuring.hidden ? 'placement' : 'measuring');
  }).catch((err) => {
    pendingMonitorStarts.delete(currentMonitor);
    if (generation !== sessionGeneration) { currentMonitor.destroy(); return; }
    if (sessionTimerId) { clearInterval(sessionTimerId); sessionTimerId = null; }
    console.error('start() failed', err);
    showScreen('ready');
  });
}

function stopSession() {
  lastMeasuringFrame = null;
  if (sessionTimerId) { clearInterval(sessionTimerId); sessionTimerId = null; }
  measuringStartedAt = null;
  if (monitor) {
    monitor.stop();
  }
  renderSummary();
  showScreen('summary');
}

// ponytail: UA sniff; swap for a camera/torch capability probe once desktop rPPG lands.
const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
if (!isPhone) {
  const b = document.getElementById('btn-start');
  b.disabled = true; b.hidden = true;
  document.getElementById('phone-qr').src = new URL('./assets/phone-qr.svg', paintBundleURL).href;
  document.getElementById('screen-ready').classList.add('desktop-ready');
  document.getElementById('desktop-phone-panel').hidden = false;
}
syncScreenChrome('ready');
document.querySelector('.live-details').addEventListener('toggle', event => {
  if (event.currentTarget.open) { drawWave(); drawTachogram(); }
});
document.getElementById('btn-start').addEventListener('click', startSession);
document.getElementById('btn-cancel-placement').addEventListener('click', () => {
  sessionGeneration++;
  lastMeasuringFrame = null;
  clearEntryTransition();
  if (sessionTimerId) { clearInterval(sessionTimerId); sessionTimerId=null; }
  if (monitor) {
    monitor.stop();
    // Pending getUserMedia still needs its video element to adopt a late stream.
    // Dispose it in the completion handlers, where all tracks can be released.
    if (!pendingMonitorStarts.has(monitor)) monitor.destroy();
    monitor = null;
  }
  showScreen('ready');
});
document.getElementById('btn-pause').addEventListener('click', () => {
  manuscript.paused = !manuscript.paused; manuscript.pending=[];
  if (manuscript.paused) cancelAnimationFrame(manuscript.frame); else animateManuscript();
  document.getElementById('btn-pause').textContent=manuscript.paused?'Resume artwork':'Pause artwork';
  document.getElementById('pause-note').textContent=manuscript.paused?'Artwork paused. Your 3-minute measurement continues.':'3-minute recording · Not a medical device';
  if(lastMetrics) updateMeasuringScreen(lastMetrics);
});
document.getElementById('btn-save-artwork').addEventListener('click', () => closeDebugSheet());
document.getElementById('btn-save-manuscript').addEventListener('click', () => {
  closeDebugSheet();
  saveManuscript();
});
document.getElementById('btn-stop').addEventListener('click', stopSession);
document.getElementById('btn-again').addEventListener('click', () => {
  if (monitor) { monitor.destroy(); monitor = null; }
  showScreen('ready');
});
document.getElementById('btn-save-log').addEventListener('click', () => {
  closeDebugSheet();
  if (monitor) monitor.downloadDebugLog('hrv-spot-check');
});
document.getElementById('btn-save-report').addEventListener('click', () => {
  closeDebugSheet();
  const closed=[...document.querySelectorAll('.report-disclosure, .time-details, .ans-methods')].filter(d=>!d.open);
  closed.forEach(d=>d.open=true);
  window.addEventListener('afterprint',()=>closed.forEach(d=>d.open=false),{once:true});
  setTimeout(()=>window.print(),100);
});

// ---------------------------------------------------------- Debug menu --
// Hidden '...' menu on every screen (job 6): share/download the LAST
// session's log (persisted to localStorage by PPGMonitor on stop/cancel/
// pagehide - works even with no active monitor, e.g. after Cancel or on
// the report screen), a short copyable summary, and a live-stats overlay.
const LAST_LOG_KEY = 'ppg_last_session_log';

function getLastSessionLog() {
  try {
    const raw = localStorage.getItem(LAST_LOG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function debugLogSummary(log) {
  if (!log) return 'No session log available yet.';
  const meta = log.meta || {};
  const states = {};
  for (const e of log.events || []) {
    if (e.type === 'state_transition') states[e.state] = (states[e.state] || 0) + 1;
  }
  const goodWindows = (log.windows || []).filter(w => w.good).length;
  const lastReason = [...(log.windows || [])].reverse().find(w => w.reason)?.reason || 'n/a';
  const frameMode = meta.frameCallbackMode || 'unknown';
  return [
    `Device: ${meta.userAgent || 'unknown'}`,
    `Camera: ${meta.chosenLabel || 'unknown'} (${meta.chosenBy || 'n/a'})`,
    `Frame mode: ${frameMode}`,
    `Torch supported: ${meta.torchSupported}`,
    `State transitions: ${Object.entries(states).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `Good windows: ${goodWindows}/${(log.windows || []).length}`,
    `Last reason: ${lastReason}`,
    `Truncated: ${!!log.truncated}`
  ].join('\n');
}

let menuReturnFocus = null;
function menuControls() {
  return [...document.getElementById('debug-sheet').querySelectorAll('button:not(:disabled), input:not(:disabled)')]
    .filter(control => control.getClientRects().length);
}
function openDebugSheet() {
  menuReturnFocus = document.getElementById('btn-debug-menu');
  document.getElementById('debug-sheet-backdrop').hidden = false;
  document.getElementById('debug-sheet').hidden = false;
  document.getElementById('btn-debug-menu').setAttribute('aria-expanded', 'true');
  menuControls()[0]?.focus({ preventScroll: true });
}
function closeDebugSheet() {
  document.getElementById('debug-sheet-backdrop').hidden = true;
  document.getElementById('debug-sheet').hidden = true;
  document.getElementById('btn-debug-menu').setAttribute('aria-expanded', 'false');
  menuReturnFocus?.focus({ preventScroll: true });
  menuReturnFocus = null;
}
document.getElementById('btn-debug-menu').addEventListener('click', openDebugSheet);
document.getElementById('debug-sheet-backdrop').addEventListener('click', closeDebugSheet);
document.getElementById('btn-debug-close').addEventListener('click', closeDebugSheet);
document.getElementById('debug-sheet').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeDebugSheet(); return; }
  if (event.key !== 'Tab') return;
  const controls = menuControls(), first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

document.getElementById('btn-debug-share').addEventListener('click', async () => {
  const log = getLastSessionLog();
  if (!log) { alert('No session log available yet.'); return; }
  const json = JSON.stringify(log, null, 2);
  const filename = `hrv-spot-check-${new Date().toISOString()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  if (navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (err) {
        // user cancelled or share failed - fall through to download
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('btn-debug-copy').addEventListener('click', async () => {
  const summary = debugLogSummary(getLastSessionLog());
  try {
    await navigator.clipboard.writeText(summary);
    alert('Summary copied.');
  } catch (err) {
    alert(summary);
  }
});

let liveStatsTimer = null;
document.getElementById('chk-live-stats').addEventListener('change', (e) => {
  const el = document.getElementById('debug-live-stats');
  if (e.target.checked) {
    el.hidden = false;
    liveStatsTimer = setInterval(() => {
      if (!monitor || !monitor.getMetrics) { el.textContent = 'no active session'; return; }
      const m = monitor.getMetrics();
      el.textContent = [
        `state: ${m.fingerState}`,
        `acdc: ${((m.acDcRatio || 0) * 100).toFixed(2)}%`,
        `dcR/dcG: ${(m.selectedChannel === 'green' ? 'G' : 'R')}`,
        `fps: ${(m.sampleRate || 0).toFixed(1)}`,
        `torch: ${monitor.torchState || 'n/a'}`,
        `artifactRatio: ${((m.artifactRatio || 0) * 100).toFixed(1)}%`,
        `clipped: ${((m.clippedFraction || 0) * 100).toFixed(1)}%  motion: ${(m.motion || 0).toFixed(2)}`,
        `templateSqi: ${Number.isFinite(m.templateSqi) ? m.templateSqi.toFixed(2) : '--'}  floor: ${(m.rmssdFloorMs || 0).toFixed(0)}ms`,
        `resp: ${m.respiration && m.respiration.rateBpm != null ? m.respiration.rateBpm.toFixed(1) + ' br/min' : '--'}`,
        `dropped frames: ${monitor.getDebugLog().droppedFrames}`
      ].join('\n');
    }, 500);
  } else {
    el.hidden = true;
    if (liveStatsTimer) { clearInterval(liveStatsTimer); liveStatsTimer = null; }
  }
});


// QA-only hook: force a screen into a representative state without a real
// camera session, so headless visual QA can screenshot all 4 screens.
// Not part of the public library API — demo-app testing aid only.
window.__demoState = function (name) {
  if (name === 'ready') { showScreen('ready'); return; }
  if (name === 'placement') {
    showScreen('placement');
    updatePlacementScreen({ fingerState: 'SETTLING', guidanceMessage: 'Good signal — hold steady', settleRemainingSec: 4 });
    return;
  }
  if (name === 'measuring') {
    showScreen('measuring');
    resetWaveBuffer();
  resetManuscript();
  elapsedMeasuringMs = 0; lastMeasuringFrame = null;
    for (let i = 0; i < waveBuf.length; i++) waveBuf[i] = 0.5 + 0.3 * Math.sin(i / 6);
    drawWave();
    monitor = monitor || { getTachogram: () => Array.from({ length: 40 }, (_, i) => ({ ibiMs: 800 + 40 * Math.sin(i / 3), valid: i % 7 !== 0, good: true })) };
    drawTachogram();
    updateMeasuringScreen({ heartRate: 72, rmssd: 45, sdnn: 52, qualityScore: 88, rmssdFloorMs: 9, respiration: { rateBpm: 13.5, confidence: 0.8 }, quality: { good: true, reason: null } });
    return;
  }
  if (name === 'summary') {
    monitor = {
      getSessionSummary: () => ({ goodFraction: 0.83 }),
      getTachogram: () => Array.from({ length: 40 }, (_, i) => ({ t: i * 0.82, ibiMs: 800 + 40 * Math.sin(i / 3), valid: i % 7 !== 0, good: true })),
    };
    renderSummary();
    showScreen('summary');
  }
};

// QA-only hook: render the full HRV report from an explicit list of accepted
// IBIs (ms), so headless QA (playwright) can screenshot the real report
// against the real 200s fixture without a camera session. Not public API.
window.__demoReport = function (acceptedIbiMs) {
  monitor = monitor || { getSessionSummary: () => ({ goodFraction: 1 }) };
  renderReport(acceptedIbiMs, 10, null);
  showScreen('summary');
};
