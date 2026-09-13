// End-to-end: real Chromium + real getUserMedia + a fake camera fed from a
// recorded fixture. Builds a flat-colour Y4M whose per-frame RGB follows
// test/fixtures/iphone-200s.json, points Chromium's fake video capture at
// it, loads the browser bundle, and checks that the live monitor reaches
// MEASURING and reports the recording's heart rate.
//
//   npm run build && npm run test:e2e
//
// Uses the `playwright` package's Chromium by default; set PPG_CHROMIUM to
// a chromium binary to override (e.g. /opt/pw-browsers/chromium).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'test/fixtures/iphone-200s.json'), 'utf8'));

// ---- Build the Y4M: the recording resampled onto an exact 30 fps grid ----
// The raw recording has irregular frame gaps; playing its frames back at a
// fixed rate would compress time and inflate the heart rate, so interpolate
// each channel onto a uniform grid using the recorded timestamps. Start 20 s
// in, past the placement bounces at the beginning of the session.
const W = 320, H = 240, FPS = 30, SECONDS = 90, START_SEC = 20;
const raw = fixture.samples;
const t0 = raw[0].t + START_SEC * 1000;
const samples = [];
let j = 0;
for (let k = 0; k < FPS * SECONDS; k++) {
  const t = t0 + (k * 1000) / FPS;
  while (j < raw.length - 2 && raw[j + 1].t < t) j++;
  const a = raw[j], b = raw[j + 1];
  if (!b || t > b.t) break;
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  samples.push({ r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f });
}
const outDir = path.join(root, 'test/e2e/.tmp');
mkdirSync(outDir, { recursive: true });
const y4mPath = path.join(outDir, 'fixture.y4m');
{
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const frameHeader = Buffer.from('FRAME\n');
  const ySize = W * H, cSize = (W / 2) * (H / 2);
  const chunks = [header];
  for (const s of samples) {
    const r = s.r, g = s.g, b = s.b;
    const y = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    const u = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
    const v = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    chunks.push(frameHeader, Buffer.alloc(ySize, y), Buffer.alloc(cSize, u), Buffer.alloc(cSize, v));
  }
  writeFileSync(y4mPath, Buffer.concat(chunks));
}

// ---- Static server for the repo root ----
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.map': 'application/json' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(root, url);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const executablePath = process.env.PPG_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') && !process.env.CI ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  executablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4mPath}`, '--no-sandbox']
});
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/test/e2e/page.html`);
  const started = await page.evaluate(() => window.__start());
  console.log('started:', JSON.stringify(started));

  try {
    await page.waitForFunction(() => window.__windows.some(w => w.fingerState === 'MEASURING' && w.quality && w.quality.good) || window.__windows.length >= 14, null, { timeout: 90000 });
  } catch (err) {
    const dbg = await page.evaluate(() => ({ windows: window.__windows.map(w => ({ t: w.t, state: w.fingerState, good: w.quality && w.quality.good, reason: w.quality && w.quality.reason, hr: w.heartRate, acdc: w.acDcRatio, redDc: w.redDc, greenDc: w.greenDc })), samples: window.__monitor.getDebugLog().samples.slice(0, 5), n: window.__monitor.getDebugLog().samples.length, errors: window.__errors }));
    console.error('timeout waiting for a good window; diagnostics:', JSON.stringify(dbg, null, 1));
    throw err;
  }
  const windows = await page.evaluate(() => window.__windows);
  const errors = await page.evaluate(() => window.__errors);
  const log = await page.evaluate(() => window.__monitor.getDebugLog());
  await page.evaluate(() => window.__monitor.stop());

  const good = windows.filter(w => w.quality && w.quality.good);
  const ts = log.samples.map(s => s.t);
  const monotonic = ts.every((t, i) => i === 0 || t > ts[i - 1]);
  const fps = log.samples.length > 1 ? (log.samples.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000) : 0;
  console.log(`windows=${windows.length} good=${good.length} states=${[...new Set(windows.map(w => w.fingerState))].join(',')} fps=${fps.toFixed(1)} dropped=${log.droppedFrames} errors=${errors.length} pageErrors=${pageErrors.length}`);
  console.log('HR (good windows):', good.map(w => w.heartRate).join(','));

  const check = (cond, msg) => { if (!cond) { failed = true; console.error('FAIL:', msg); } else console.log('ok:', msg); };
  check(started.mode === 'requestVideoFrameCallback', 'frame loop uses requestVideoFrameCallback');
  check(monotonic, 'recorded timestamps are strictly increasing');
  check(fps > 20 && fps < 40, `measured camera rate ~30 fps (got ${fps.toFixed(1)})`);
  check(errors.length === 0 && pageErrors.length === 0, 'no errors');
  check(good.length >= 1, 'at least one good MEASURING window');
  check(good.every(w => w.heartRate >= 60 && w.heartRate <= 85), 'heart rate in the recording\'s 60-85 bpm range');
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
console.log('PASS: fake-camera e2e');
