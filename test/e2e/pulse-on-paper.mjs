// App-level regression checks: camera I/O is mocked, the streaming engine and
// application callbacks are real. No physiological-accuracy claim is implied.
// npm run build && npm run test:app
// Optional local recording: PPG_SESSION_LOG=/absolute/path.json npm run test:app
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { instrumentReportGraphText, checkReportGraphs } from './report-graph-checks.mjs';
import { checkCaptureEntry } from './capture-entry-checks.mjs';
import { checkArtwork } from './artwork-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const log = JSON.parse(readFileSync(process.env.PPG_SESSION_LOG || path.join(root, 'test/fixtures/iphone-200s.json'), 'utf8'));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/examples/app/index.html`;
async function assertViewportFits(page, label) {
  const requestedWidth = page.viewportSize().width;
  const actual = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(actual.width, requestedWidth, `${label}: mobile viewport has not auto-zoomed to hide overflow`);
  assert.ok(actual.scrollWidth <= requestedWidth, `${label}: content fits the requested width`);
}
let browser;
try {
  browser = await chromium.launch(process.env.PPG_CHROMIUM ? { executablePath: process.env.PPG_CHROMIUM } : process.platform === 'darwin' ? { channel: 'chrome' } : {});
  const context = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
  const page = await context.newPage();
  await instrumentReportGraphText(page);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(log => {
    window.PPGMonitor = class extends PPG.PPGMonitor {
      constructor(_host, options) {
        super(_host, options);
        this.engine = new PPG.PpgEngine({ ...log.meta?.engineConfig?.engine, ...options.signal });
        this.video = document.createElement('video');
        this.torchSupported = true;
        this.torchState = 'on';
        this.currentMetrics = { fingerState: 'NO_FINGER' };
        this.i = 0;
        this.metricUpdates = [];
        const update = this.options.onQualityUpdate;
        this.options.onQualityUpdate = metrics => {
          update(metrics);
          if (metrics.fingerState === 'MEASURING') this.metricUpdates.push({
            t: metrics.t, good: metrics.quality.good, segments: manuscript.segments.length,
            values: ['hr-value', 'rmssd-value', 'sdnn-value'].map(id => document.getElementById(id).textContent),
            expected: [metrics.heartRate, metrics.rmssd, metrics.sdnn].map(value => metrics.quality.good && Number.isFinite(value) ? String(Math.round(value)) : '--'),
          });
        };
      }
      async start() { this.options.onReady({ torchSupported: true }); }
      stop() {}
      destroy() {}
      getMetrics() { return this.currentMetrics; }
      getSessionSummary() { return this.engine.getSessionSummary(); }
      getTachogram(options = {}) { return this.engine.getTachogram(options); }
      getDebugLog() { return log; }
      downloadDebugLog() {}
      feedUntil(seconds) {
        const t0 = log.samples[0].t;
        for (; this.i < log.samples.length; this.i++) {
          const sample = log.samples[this.i];
          const t = (sample.t - t0) / 1000;
          if (t > seconds) break;
          const result = this.engine.push({ ...sample, t });
          if (result.stateChanged) {
            this.currentMetrics.fingerState = result.state;
            this.options.onState?.({ state: result.state, reason: result.stateReason, time: t });
          }
          if (result.window) {
            // Use the real monitor callback adapter: public metrics deliberately
            // omit internal windowStartSec/filtered fields that paint reads
            // from the matching engine window.
            this._onWindow(result.window, sample.t, sample.rMean, sample.gMean, sample.bMean, sample.clippedFraction);
          }
          this.options.onSignalUpdate({ time: t, value: result.waveform, isProcessing: result.state === 'MEASURING' });
        }
      }
    };
  }, log);
  assert.doesNotMatch(await page.locator('body').innerText(), /experiment|watercolor/i, 'capture copy leaves the visual treatment unstated');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await assertViewportFits(page, `ready ${width}px`);
  }
  await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
  await page.evaluate(() => monitor.feedUntil(70));
  assert.equal(await page.evaluate(() => 'windowStartSec' in monitor.getMetrics()), false, 'replay uses the real public callback payload');
  assert.ok(await page.evaluate(() => manuscript.segments.length > 0), 'accepted real signal paints');
  const cadence = await page.evaluate(() => ({ updates: monitor.metricUpdates, hop: monitor.engine.opts.hopSec, window: monitor.engine.opts.windowSec }));
  assert.equal(cadence.hop, 1, 'capture requests genuine computed updates once a second');
  assert.equal(cadence.window, 5, 'signal analysis retains five-second windows');
  assert.ok(cadence.updates.every(update => update.values.join() === update.expected.join()), 'readouts display the actual quality-gated metrics, without interpolation');
  const byPaint = new Map();
  for (const update of cadence.updates.filter(update => update.good)) {
    const group = byPaint.get(update.segments) || []; group.push(update); byPaint.set(update.segments, group);
  }
  assert.ok([...byPaint.values()].some(group => group.length >= 4 && new Set(group.map(update => update.values.join())).size > 1), 'computed metrics visibly update several times within one painted segment');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await assertViewportFits(page, `capture ${width}px`);
  }
  // Follow the next manuscript row without a jump or a growing live bitmap.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const scrollStart = await page.evaluate(() => {
    monitor.feedUntil(75);
    return { ...manuscript.scroll, row: manuscript.viewFirstRow, cacheRows: manuscript.raster.rows };
  });
  assert.ok(scrollStart.to > scrollStart.from, 'next row starts a downward manuscript follow');
  await page.waitForFunction(() => manuscript.scroll && manuscript.viewFirstRow > manuscript.scroll.from && manuscript.viewFirstRow < manuscript.scroll.to);
  await page.waitForFunction(() => !manuscript.scroll);
  assert.equal(await page.evaluate(() => manuscript.viewFirstRow), scrollStart.to, 'scroll settles at the next row');
  assert.ok(scrollStart.cacheRows <= 5, 'live cache holds at most four visible rows plus one scrolling row');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const captureCount = await page.evaluate(() => manuscript.segments.length);
  const beforePauseUpdates = await page.evaluate(() => monitor.metricUpdates.length);
  await page.getByRole('button', { name: 'Pause artwork', exact: true }).click();
  await page.evaluate(() => monitor.feedUntil(80));
  assert.equal(await page.evaluate(() => manuscript.segments.length), captureCount, 'paused artwork does not grow');
  const pausedUpdates = await page.evaluate(start => monitor.metricUpdates.slice(start), beforePauseUpdates);
  assert.ok(pausedUpdates.length >= 4 && pausedUpdates.some(update => update.good), 'quality-gated metrics continue once a second while artwork is paused');
  assert.ok(pausedUpdates.every(update => update.values.join() === update.expected.join()), 'paused-art readouts still match computed metrics');
  assert.ok(new Set(pausedUpdates.filter(update => update.good).map(update => update.values.join())).size > 1, 'real estimates visibly change while artwork is paused');
  assert.match(await page.locator('#pause-note').innerText(), /measurement continues/);
  await page.getByRole('button', { name: 'Resume artwork', exact: true }).click();
  // Keep this export/manual-finish check below automatic completion; the
  // dedicated WebKit session test exercises the full 180 active seconds.
  await page.evaluate(() => monitor.feedUntil(180));
  const expected = await page.evaluate(() => {
    const beats = monitor.getTachogram({ goodOnly: true, hrvOnly: true }).filter(p => p.valid);
    const report = PPG.hrv.analyzeHRV(beats);
    return { hr: report.timeDomain.meanHR.toFixed(0), rmssd: report.timeDomain.rmssd.toFixed(1), sdnn: report.timeDomain.sdnn.toFixed(1), beats: report.meta.nBeats };
  });
  await page.getByRole('button', { name: 'Finish painting', exact: true }).click();
  const heroValues = await page.locator('.report-heroes strong').allTextContents();
  assert.doesNotMatch(await page.locator('#report-content').innerText(), /experiment/i, 'report uses research-estimate wording');
  assert.ok(heroValues[0].includes(expected.hr));
  assert.ok(heroValues[1].includes(expected.rmssd));
  assert.ok(heroValues[2].includes(expected.sdnn));
  assert.match(await page.locator('.quality-facts').innerText(), new RegExp(String(expected.beats)));
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await assertViewportFits(page, `report ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await checkArtwork(page);
  for (const label of ['Frequency analysis', 'Nonlinear analysis', 'Beat timing & methods']) {
    await page.getByText(label, { exact: true }).click();
  }
  const charts = await page.locator('.report-canvas-wrap canvas').evaluateAll(nodes => nodes.map(c => ({ width: c.width, height: c.height, visible: c.getBoundingClientRect().width > 0 })));
  assert.ok(charts.every(c => c.width > 0 && c.height > 0 && c.visible), 'expanded charts have actual dimensions');
  await checkReportGraphs(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save manuscript', exact: true }).click(),
  ]);
  assert.equal(await download.failure(), null, 'manuscript exports');
  const png = readFileSync(await download.path());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.readUInt32BE(16) <= 1200 && png.readUInt32BE(20) <= 8192, 'bounded PNG dimensions');
  await page.evaluate(() => { window.print = () => { window.__printedOpen = [...document.querySelectorAll('.report-disclosure,.time-details,.ans-methods')].every(d => d.open); window.dispatchEvent(new Event('afterprint')); }; });
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.waitForFunction(() => window.__printedOpen !== undefined);
  assert.equal(await page.evaluate(() => window.__printedOpen), true, 'print opens all report detail');

  const attribution = await page.evaluate(() => {
    resetManuscript();
    const w = { t: 2, windowStartSec: 0, gridHz: 10, selectedChannel: 'green', filtered: Float64Array.from({ length: 21 }, (_, i) => i), quality: { good: true }, sqi: { score: .9 } };
    monitor = { engine: { lastWindow: w } };
    // Red callback values are intentionally descending. Selected green is rising.
    manuscript.pending = Array.from({ length: 20 }, (_, i) => ({ t: (i + 1) / 10, v: -i }));
    acceptPaintWindow(w);
    const first = manuscript.segments[0];
    const match = first.channel === 'green' && first.points[0].v === 0 && first.points.at(-1).v === 1 && first.score === .9;
    const unchanged = JSON.stringify(first);
    w.t = 4; w.windowStartSec = 2; w.quality.good = false;
    manuscript.pending = Array.from({ length: 20 }, (_, i) => ({ t: 2 + (i + 1) / 10, v: i }));
    acceptPaintWindow(w);
    const rejected = manuscript.segments.length === 1 && JSON.stringify(first) === unchanged;
    document.getElementById('pause-note').textContent = 'Artwork paused. Your 3-minute measurement continues.';
    resetManuscript();
    return { match, rejected, resetNote: document.getElementById('pause-note').textContent, liveRegion: document.getElementById('painting-state').parentElement.getAttribute('role') };
  });
  assert.equal(attribution.match, true, 'geometry and pigment quality use the selected analysis channel');
  assert.equal(attribution.rejected, true, 'bad windows add no paint and never recolor captured segments');
  assert.doesNotMatch(attribution.resetNote, /paused/i);
  assert.equal(attribution.liveRegion, 'status');

  const timing = await page.evaluate(() => {
    measuringStartedAt = 1; elapsedMeasuringMs = 0; lastMeasuringFrame = null;
    for (let i = 0; i <= 50; i++) advanceSessionClock(i / 50, true);
    tickSessionCountdown();
    advanceSessionClock(1.02, false);
    for (let i = 0; i < 40; i++) tickSessionCountdown();
    const held = elapsedMeasuringMs;
    for (let i = 0; i <= 50; i++) advanceSessionClock(41 + i / 50, true);
    tickSessionCountdown();
    const resumed = elapsedMeasuringMs;
    return { held: Math.round(held), resumed: Math.round(resumed) };
  });
  assert.deepEqual(timing, { held: 1000, resumed: 2000 }, 'finger-loss time is excluded from countdown');
  await page.evaluate(() => { monitor = { getSessionSummary: () => ({ goodFraction: 0 }) }; renderReport([], undefined, null); showScreen('summary'); });
  assert.match(await page.locator('#report-content').innerText(), /No good-quality windows/);
  assert.deepEqual(errors, [], 'no runtime errors');
  await checkCaptureEntry(browser, url);
  console.log('PASS: Pulse on Paper capture, quality attribution, pause, report, exports, responsive layouts and unavailable-data handling');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
