// examples/app/app.js — dogfoods ppg-js's public API as a third-party dev would.
// PPGMonitor and the hrv module are exposed by ../demo/dist/ppg.global.js (IIFE build)
// as window.PPG.PPGMonitor and window.PPG.hrv.

const screens = {
  ready: document.getElementById('screen-ready'),
  placement: document.getElementById('screen-placement'),
  measuring: document.getElementById('screen-measuring'),
  summary: document.getElementById('screen-summary'),
};

let sessionStarting = false;
let sessionGeneration = 0;
const pendingMonitorStarts = new Set();

function showScreen(name) {
  if (name === 'ready') sessionStarting = false;
  for (const key in screens) screens[key].hidden = key !== name;
  document.getElementById('app').dataset.activeScreen = name;
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
let reportRedrawFrame = 0;
let redrawReportCharts = () => {};
window.addEventListener('beforeprint', () => redrawReportCharts());
window.addEventListener('afterprint', () => redrawReportCharts());
if (document.fonts) document.fonts.ready.then(() => redrawReportCharts());

function renderReport(acceptedBeats, rmssdFloorMs, liveRespiration) {
  const el = document.getElementById('report-content');
  reportChartObserver?.disconnect();
  cancelAnimationFrame(reportRedrawFrame);
  reportRedrawFrame = 0;
  el.innerHTML = '';

  const beats = acceptedBeats.map(b => (typeof b === 'number' ? { ibiMs: b } : b));
  const acceptedIbiMs = beats.map(b => b.ibiMs);
  if (!beats.length) {
    el.innerHTML = `
      <h2 class="screen-title report-title">HRV Spot Check report</h2>
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
    <h2 class="screen-title report-title">HRV Spot Check report</h2>
    <div class="meta-row"><span>${new Date().toLocaleString()}</span><span>Duration <b>${(durationSec / 60).toFixed(1)} min</b></span></div>
    <div class="meta-row"><span>Good signal <b>${goodPct == null ? '—' : goodPct + '%'}</b></span><span>Beats used <b>${result.meta.nBeats}</b></span><span>Corrected <b>${result.meta.pctCorrected.toFixed(1)}%</b></span></div>
  `;
  el.appendChild(header);

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
    const widths = new WeakMap();
    reportChartObserver = new ResizeObserver(entries => {
      let changed = false;
      for (const { target, contentRect } of entries) {
        if (widths.get(target) !== contentRect.width) {
          widths.set(target, contentRect.width);
          changed = true;
        }
      }
      // Canvas setup changes its height. Redraw only for width changes and
      // outside the observer delivery to avoid a resize loop in WebKit.
      if (changed && !reportRedrawFrame) reportRedrawFrame = requestAnimationFrame(() => {
        reportRedrawFrame = 0;
        redrawReportCharts();
      });
    });
    el.querySelectorAll('.report-canvas-wrap').forEach(wrap => reportChartObserver.observe(wrap));
  }
  tdCard.insertAdjacentHTML('beforeend','<p class="report-note">The timing-noise floor is an estimate, not a confidence interval.</p>');
}

function startSession() {
  // Strict phone gate at the point of camera access too - not just the
  // Ready-screen UI disable, so this can never be invoked (e.g. via the
  // console or a future button) on desktop and grab getUserMedia there.
  if (!isPhone || sessionStarting) return;
  sessionStarting = true;
  const generation = ++sessionGeneration;
  showScreen('placement');
  resetWaveBuffer();
  elapsedMeasuringMs = 0; lastMeasuringFrame = null;
  measuringStartedAt = null;
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
      if (metrics.fingerState === 'MEASURING') {
        if (measuringStartedAt == null) measuringStartedAt = Date.now();
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
      waveBuf.push(value);
      waveBuf.shift();
      placementWaveBuf.push(value);
      placementWaveBuf.shift();
      if (!screens.measuring.hidden) drawWave();
      if (!screens.placement.hidden) drawPlacementWave();
    },
    onError: (err) => {
      if (generation !== sessionGeneration) return;
      if (sessionTimerId) { clearInterval(sessionTimerId); sessionTimerId = null; }
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
    document.getElementById('camera-preview').replaceChildren(currentMonitor.video);
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
  const button = document.getElementById('btn-start');
  button.disabled = true; button.textContent = 'Open on your phone';
  document.getElementById('desktop-note').hidden = false;
}
document.getElementById('btn-start').addEventListener('click', startSession);
document.getElementById('btn-cancel-placement').addEventListener('click', () => {
  sessionGeneration++;
  lastMeasuringFrame = null;
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
  const closed=[...document.querySelectorAll('.ans-methods')].filter(d=>!d.open);
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
