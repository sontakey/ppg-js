// Optional visual enhancement failures must leave capture and its measured
// Canvas2D manuscript usable. This uses real engine replay, not a mock renderer.
// npm run build && node test/e2e/paint-fallback-checks.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function installReplay(page, log) {
  await page.evaluate(log => {
    window.PPGMonitor = class extends PPG.PPGMonitor {
      constructor(host, options) {
        super(host, options);
        this.engine = new PPG.PpgEngine(log.meta?.engineConfig?.engine || {});
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
  }, log);
}

async function inspectFallback(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('manuscript');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let bluePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 32 && pixels[i + 2] > pixels[i] + 20 && pixels[i + 2] > pixels[i + 1] + 10) bluePixels++;
    }
    return { bluePixels, sourceVisible: getComputedStyle(canvas).visibility === 'visible' && !canvas.hidden,
      measuring: !document.getElementById('screen-measuring').hidden, segments: manuscript.segments.length,
      samples: monitor.i, gpuReady: window.__paintGpuStats?.ready || false };
  });
}

async function startReplay(page, log) {
  await installReplay(page, log);
  await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
  await page.waitForFunction(() => entryTransition === null);
  await page.evaluate(() => monitor.feedUntil(70));
  assert.ok(await page.evaluate(() => manuscript.segments.length > 0), 'real replay supplies accepted waveform');
}

export async function checkPaintFallbacks(browser, baseURL, log, output = process.env.PPG_FALLBACK_ARTIFACTS) {
  if (output) mkdirSync(output, { recursive: true });
  const results = [];
  for (const name of ['module-blocked', 'webgl2-context-lost']) {
    const context = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'no-preference' });
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      let blockedModule;
      if (name === 'module-blocked') {
        await page.route('**/paint-gpu.js*', route => route.abort('failed'));
        blockedModule = page.waitForEvent('requestfailed', {
          predicate: request => new URL(request.url()).pathname.endsWith('/paint-gpu.js'), timeout: 15000,
        });
      }
      const url = new URL(baseURL);
      if (name === 'webgl2-context-lost') url.searchParams.set('paintBackend', 'webgl2');
      await Promise.all([page.goto(url.href), blockedModule]);
      if (!blockedModule) {
        await page.waitForFunction(() => window.__paintGpuStats?.ready && paintGPU, null, { timeout: 60000 });
        assert.equal(await page.evaluate(() => window.__paintGpuStats.backend), 'webgl2', 'test uses the actual WebGL2 renderer');
      }
      await startReplay(page, log);
      if (name === 'webgl2-context-lost') {
        await page.waitForFunction(() => document.getElementById('manuscript').style.visibility === 'hidden');
        const beforeLoss = await page.evaluate(() => JSON.stringify(manuscript.segments.map(({ reveal, ...data }) => data)));
        const hasLossExtension = await page.evaluate(() => {
          const source = document.getElementById('manuscript');
          const canvas = [...source.parentElement.querySelectorAll('canvas')].find(candidate => candidate !== source);
          const gl = canvas?.getContext('webgl2');
          const extension = gl?.getExtension('WEBGL_lose_context');
          if (!extension) return false;
          window.__lostPaintCanvas = canvas;
          extension.loseContext();
          return true;
        });
        assert.equal(hasLossExtension, true, 'live GPU canvas exposes real context-loss extension');
        await page.waitForFunction(() => window.__paintGpuStats.backend === 'unavailable' && !window.__paintGpuStats.ready
          && document.getElementById('manuscript').style.visibility !== 'hidden');
        assert.equal(await page.evaluate(() => window.__lostPaintCanvas.getContext('webgl2').isContextLost()), true, 'real GPU context was lost');
        assert.equal(await page.evaluate(() => window.__lostPaintCanvas.hidden), true, 'lost GPU surface is hidden');
        assert.equal(await page.evaluate(() => JSON.stringify(manuscript.segments.map(({ reveal, ...data }) => data))), beforeLoss, 'context loss preserves measured waveform and quality');
      }
      const fallback = await inspectFallback(page);
      assert.equal(fallback.sourceVisible, true, `${name}: Canvas2D source is visible`);
      assert.equal(fallback.measuring, true, `${name}: capture stays active`);
      assert.equal(fallback.gpuReady, false, `${name}: fallback actually runs without GPU`);
      assert.ok(fallback.bluePixels > 100, `${name}: visible Canvas2D has painted blue pixels, not an empty fallback`);
      await page.evaluate(() => monitor.feedUntil(100));
      const continued = await inspectFallback(page);
      assert.ok(continued.samples > fallback.samples && continued.segments > fallback.segments, `${name}: engine and accepted artwork continue after failure`);
      assert.ok(continued.sourceVisible && continued.bluePixels > 100, `${name}: continuing capture keeps the fallback visible and painted`);
      assert.deepEqual(errors, [], `${name}: no uncaught application errors`);
      if (output) await page.screenshot({ path: path.join(output, `${name}.png`) });
      results.push({ name, fallback, continued });
    } finally { await context.close(); }
  }
  if (output) writeFileSync(path.join(output, 'fallback-checks.json'), JSON.stringify(results, null, 2) + '\n');
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = JSON.parse(readFileSync(process.env.PPG_SESSION_LOG || path.join(root, 'test/fixtures/iphone-200s.json'), 'utf8'));
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const server = createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch(process.env.PPG_CHROMIUM ? { executablePath: process.env.PPG_CHROMIUM } : process.platform === 'darwin' ? { channel: 'chrome' } : {});
    const results = await checkPaintFallbacks(browser, `http://127.0.0.1:${server.address().port}/examples/app/index.html`, log);
    console.log(JSON.stringify(results));
    console.log('PASS: blocked GPU module and real WebGL2 context loss preserve visible measured painting and continued capture');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
