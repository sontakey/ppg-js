// Reproducible browser benchmark for the optional paint compositor.
// npm run build && node test/e2e/paint-performance.mjs
// PPG_PERF_URL=http://127.0.0.1:8088/ppg-js-demo tests the host's script URLs.
// Camera I/O is mocked; the streaming engine and monitor callbacks are real.
// Mobile viewport / CPU throttling is not evidence from physical phone hardware.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const log = JSON.parse(readFileSync(process.env.PPG_SESSION_LOG || path.join(root, 'test/fixtures/iphone-200s.json'), 'utf8'));
const duration = Math.max(5, Number(process.env.PPG_PERF_SECONDS) || 20);
// The checked-in recording's first accepted window ends at 36.337 seconds.
const preloadSeconds = 40;
const output = path.resolve(root, process.env.PPG_PERF_ARTIFACTS || '.dream-loop/gpu-performance');
mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = process.env.PPG_PERF_URL || `http://127.0.0.1:${server.address().port}/examples/app/index.html`;
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))].toFixed(2));
};
function timing(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    fps: total ? Number((1000 * values.length / total).toFixed(2)) : null,
    p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: percentile(values, 1),
    over25Ms: values.filter(value => value > 25).length,
    over33Ms: values.filter(value => value > 33.34).length,
  };
}
async function installReplay(page) {
  await page.evaluate(log => {
    window.PPGMonitor = class extends PPG.PPGMonitor {
      constructor(host, options) {
        super(host, options);
        this.engine = new PPG.PpgEngine({ ...log.meta?.engineConfig?.engine, ...options.signal });
        this.video = document.createElement('video');
        this.torchSupported = true; this.torchState = 'on';
        this.currentMetrics = { fingerState: 'NO_FINGER' }; this.i = 0;
      }
      async start() { this.options.onReady({ torchSupported: true }); }
      stop() {} destroy() {}
      getMetrics() { return this.currentMetrics; }
      getSessionSummary() { return this.engine.getSessionSummary(); }
      getTachogram(options = {}) { return this.engine.getTachogram(options); }
      getDebugLog() { return log; }
      feedUntil(seconds) {
        const t0 = log.samples[0].t;
        for (; this.i < log.samples.length; this.i++) {
          const sample = log.samples[this.i], t = (sample.t - t0) / 1000;
          if (t > seconds) break;
          const result = this.engine.push({ ...sample, t });
          if (result.stateChanged) {
            this.currentMetrics.fingerState = result.state;
            this.options.onState?.({ state: result.state, reason: result.stateReason, time: t });
          }
          if (result.window) this._onWindow(result.window, sample.t, sample.rMean, sample.gMean, sample.bMean, sample.clippedFraction);
          this.options.onSignalUpdate({ time: t, value: result.waveform, isProcessing: result.state === 'MEASURING' });
        }
      }
    };
    // Capture intervals from the first actual entry draw until the app ends it.
    document.getElementById('btn-start').addEventListener('click', () => {
      window.__entryPerf = new Promise(resolve => {
        const intervals = [], cpu = [], startedFrames = window.__paintGpuStats.surfaces.entry.frames;
        const started = performance.now(); let previous = 0, previousFrames = startedFrames;
        function frame(now) {
          const entry = window.__paintGpuStats.surfaces.entry;
          if (entry.frames > previousFrames) {
            if (previous) intervals.push(now - previous);
            previous = now; previousFrames = entry.frames; cpu.push(entry.frameMs);
          }
          if (now - started > 200 && document.getElementById('entry-pigment').hidden) {
            resolve({ intervals, cpu, frames: entry.frames - startedFrames, elapsedMs: now - started, surface: { ...entry } });
          } else if (now - started > 6000) {
            resolve({ timedOut: true, intervals, cpu, frames: entry.frames - startedFrames });
          } else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
    }, { capture: true });
  }, log);
}
let browser;
const results = { generatedAt: new Date().toISOString(), scope: 'Desktop Chrome with mobile viewport and real streaming replay; camera I/O mocked; no physical-phone or GPU execution-time claim.', threeVersion: JSON.parse(readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8')).version, viewport: { width: 390, height: 844, deviceScaleFactor: 3 }, preloadSeconds, durationSeconds: duration, cases: [] };
try {
  browser = await chromium.launch(process.env.PPG_CHROMIUM ? { executablePath: process.env.PPG_CHROMIUM } : process.platform === 'darwin' ? { channel: 'chrome' } : {});
  results.browser = await browser.version();
  try {
    const system = await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');
    results.hardware = { devices: system.gpu.devices, featureStatus: system.gpu.featureStatus, modelName: system.modelName, modelVersion: system.modelVersion };
  } catch (error) { results.hardware = { unavailable: String(error) }; }
  const cases = [
    { backend: 'webgpu', cpuRate: 1 }, { backend: 'webgl2', cpuRate: 1 },
    { backend: 'webgpu', cpuRate: 4 }, { backend: 'webgl2', cpuRate: 4 },
  ].filter(test => !process.env.PPG_PERF_CASE || `${test.backend}-${test.cpuRate}x` === process.env.PPG_PERF_CASE);
  assert.ok(cases.length, 'PPG_PERF_CASE must match webgpu-1x, webgl2-1x, webgpu-4x or webgl2-4x');
  for (const test of cases) {
    const name = `${test.backend}-${test.cpuRate}x`;
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, reducedMotion: 'no-preference' });
    const page = await context.newPage(), errors = [], consoleErrors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const url = new URL(baseURL);
    if (test.backend === 'webgl2') url.searchParams.set('paintBackend', 'webgl2');
    await page.goto(url.href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => window.__paintGpuStats?.ready && typeof paintGPU !== 'undefined' && paintGPU, null, { timeout: 60000 });
    const actualBackend = await page.evaluate(() => window.__paintGpuStats.backend);
    assert.equal(actualBackend, test.backend, `${name}: requested backend is actually active`);
    if (test.backend === 'webgpu' && !results.adapter) results.adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, device: adapter?.info.device, description: adapter?.info.description, isFallbackAdapter: adapter?.info.isFallbackAdapter };
    });
    await installReplay(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: test.cpuRate });
    await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
    const entry = await page.evaluate(() => window.__entryPerf);
    assert.ok(!entry.timedOut && entry.frames > 10, `${name}: entry animation rendered and completed`);
    await page.evaluate(seconds => monitor.feedUntil(seconds), preloadSeconds);
    assert.ok(await page.evaluate(() => manuscript.segments.length > 0), `${name}: accepted replay waveform is present`);
    const replay = await page.evaluate(({ seconds, preload }) => new Promise(resolve => {
      const intervals = [], activeIntervals = [], renderCPU = [], engineCPU = [];
      const started = performance.now(), initialFrames = window.__paintGpuStats.surfaces.manuscript.frames;
      const initialSegments = manuscript.segments.length, initialSamples = monitor.i;
      let previous = 0, previousDraw = 0, previousFrames = initialFrames;
      function frame(now) {
        if (previous) intervals.push(now - previous);
        previous = now;
        const began = performance.now(); monitor.feedUntil(preload + (now - started) / 1000); engineCPU.push(performance.now() - began);
        const surface = window.__paintGpuStats.surfaces.manuscript;
        if (surface.frames > previousFrames) {
          // >100ms is an intentional idle period between validated windows.
          if (previousDraw && now - previousDraw < 100) activeIntervals.push(now - previousDraw);
          previousDraw = now; previousFrames = surface.frames; renderCPU.push(surface.frameMs);
        }
        if (now - started >= seconds * 1000) resolve({ intervals, activeIntervals, renderCPU, engineCPU, frames: surface.frames - initialFrames, elapsedMs: now - started, initialSegments, finalSegments: manuscript.segments.length, samplesFed: monitor.i - initialSamples, surface: { ...surface }, stats: JSON.parse(JSON.stringify(window.__paintGpuStats)) });
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }), { seconds: duration, preload: preloadSeconds });
    assert.ok(replay.frames > duration * 10, `${name}: GPU renders actual live reveal`);
    assert.ok(replay.finalSegments > replay.initialSegments && replay.samplesFed > duration * 20, `${name}: real engine keeps accepting waveform during measurement`);
    assert.equal(replay.stats.ready, true, `${name}: GPU remains available`);
    for (const [surfaceName, surface] of Object.entries(replay.stats.surfaces)) {
      assert.equal(surface.backend, test.backend, `${name}/${surfaceName}: backend remains active`);
      assert.ok(surface.pixels <= replay.stats.pixelBudget + 2000, `${name}/${surfaceName}: drawing buffer stays bounded (rounding tolerance)`);
    }
    assert.deepEqual(errors, [], `${name}: no runtime errors`);
    assert.deepEqual(consoleErrors, [], `${name}: no browser console errors`);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.screenshot({ path: path.join(output, `${name}-manuscript.png`) });
    const result = {
      ...test, actualBackend,
      entry: { cadence: timing(entry.intervals), frames: entry.frames, elapsedMs: Math.round(entry.elapsedMs), submissionCPU: { p50Ms: percentile(entry.cpu, .5), p95Ms: percentile(entry.cpu, .95), maxMs: percentile(entry.cpu, 1) }, surface: entry.surface },
      replay: { raf: timing(replay.intervals), activePaintCadence: timing(replay.activeIntervals), frames: replay.frames, elapsedMs: Math.round(replay.elapsedMs), initialSegments: replay.initialSegments, finalSegments: replay.finalSegments, samplesFed: replay.samplesFed, submissionCPU: { p50Ms: percentile(replay.renderCPU, .5), p95Ms: percentile(replay.renderCPU, .95), maxMs: percentile(replay.renderCPU, 1) }, engineBatchCPU: { p50Ms: percentile(replay.engineCPU, .5), p95Ms: percentile(replay.engineCPU, .95), maxMs: percentile(replay.engineCPU, 1) }, surface: replay.surface },
      errors, consoleErrors,
    };
    results.cases.push(result);
    writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ name, entry: result.entry.cadence, replay: result.replay.raf, paint: result.replay.activePaintCadence, submissionP95Ms: result.replay.submissionCPU.p95Ms, pixels: result.replay.surface.pixels }));
    await context.close();
  }
  // A separate visual run avoids screenshot readback affecting timing samples.
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.waitForFunction(() => window.__paintGpuStats?.ready && typeof paintGPU !== 'undefined' && paintGPU, null, { timeout: 60000 });
  await installReplay(page);
  await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, 'entry-spreading.png') });
  await context.close();
  console.log(`PASS: real replay rendered on requested GPU backends; results in ${path.relative(root, output)}/results.json. Frame rates are measurements, not a universal CI guarantee.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
