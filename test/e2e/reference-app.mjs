// App-level regression checks: camera I/O is mocked, the streaming engine and
// application callbacks are real. No physiological-accuracy claim is implied.
// npm run build && npm run test:app
// Optional local recording: PPG_SESSION_LOG=/absolute/path.json npm run test:app
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { instrumentReportGraphText, checkReportGraphs } from './report-graph-checks.mjs';
import { checkCaptureEntry } from './capture-entry-checks.mjs';

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
            t: metrics.t, good: metrics.quality.good,
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
            // Use the real monitor callback adapter and its public metric payload.
            this._onWindow(result.window, sample.t, sample.rMean, sample.gMean, sample.bMean, sample.clippedFraction);
          }
          this.options.onSignalUpdate({ time: t, value: result.waveform, isProcessing: result.state === 'MEASURING' });
        }
      }
    };
  }, log);

  const out = path.resolve(root, process.env.PPG_REFERENCE_ARTIFACTS || '.dream-loop/reference-demo');
  mkdirSync(out, { recursive: true });
  const screenshot = async name => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 85, scale: 'css' });
  };
  assert.doesNotMatch(await page.locator('body').innerText(), /experiment|watercolor|Pulse Painting/i);
  assert.equal(await page.title(), 'HRV Spot Check');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await assertViewportFits(page, `ready ${width}px`);
  }
  await screenshot('reference-ready');
  await page.locator('#btn-start').click();
  await page.evaluate(() => monitor.feedUntil(70));
  const cadence = await page.evaluate(() => ({ updates: monitor.metricUpdates, hop: monitor.engine.opts.hopSec, window: monitor.engine.opts.windowSec }));
  assert.equal(cadence.hop, 1);
  assert.equal(cadence.window, 5);
  assert.ok(cadence.updates.every(u => u.values.join() === u.expected.join()), 'readouts match quality-gated engine values');
  assert.ok(cadence.updates.filter(u => u.good).length > 20, 'accepted computed readouts update every second');
  assert.ok(new Set(cadence.updates.filter(u => u.good).map(u => u.values.join())).size > 4);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await assertViewportFits(page, `capture ${width}px`);
  }
  await screenshot('reference-capture');
  await page.evaluate(() => monitor.feedUntil(180));
  const expected = await page.evaluate(() => {
    const beats = monitor.getTachogram({ goodOnly: true, hrvOnly: true }).filter(p => p.valid);
    const result = PPG.hrv.analyzeHRV(beats);
    return { hr: result.timeDomain.meanHR.toFixed(0), rmssd: result.timeDomain.rmssd.toFixed(1), sdnn: result.timeDomain.sdnn.toFixed(1), beats: result.meta.nBeats };
  });
  await page.locator('#btn-stop').click();
  assert.equal(await page.locator('#screen-summary').isVisible(), true);
  const table = page.locator('.report-card').filter({ has: page.getByRole('heading', { name: 'Time domain', exact: true }) });
  for (const [label, value] of [['Mean HR', expected.hr], ['RMSSD', expected.rmssd], ['SDNN', expected.sdnn]]) {
    const row = table.locator('tr').filter({ has: page.locator('td').getByText(label, { exact: true }) });
    assert.ok((await row.innerText()).includes(value), `report ${label} matches accepted data`);
  }
  await screenshot('reference-report');
  await checkReportGraphs(page);
  await page.evaluate(() => {
    window.print = () => { window.__printCalled = true; window.dispatchEvent(new Event('afterprint')); };
  });
  await page.locator('#btn-save-report').click();
  await page.waitForFunction(() => window.__printCalled);
  await page.evaluate(() => window.__demoReport([]));
  assert.match(await page.locator('#report-content').innerText(), /No good-quality windows/);
  assert.equal(await page.locator('.hrv-table').count(), 0, 'empty capture creates no fabricated metrics');
  await page.evaluate(() => updateMeasuringScreen({ quality: { good: false, reason: 'Noisy signal' }, heartRate: 99, rmssd: 50, sdnn: 60 }));
  assert.deepEqual(await page.locator('#hr-value, #rmssd-value, #sdnn-value').allTextContents(), ['--','--','--']);
  await checkCaptureEntry(browser, url);
  assert.deepEqual(errors, [], 'no runtime errors');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, expected, scope: 'Chromium browser replay; camera I/O mocked; no physical-phone claim', fixture: 'test/fixtures/iphone-200s.json', screenshotReplaySeconds: { capture: 70, report: 180 }, completedAt: new Date().toISOString() }, null, 2));
  console.log('PASS: reference capture, live metrics, report, graph labels, print, unavailable data and camera lifecycle');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
