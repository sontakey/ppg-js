// Full wall-clock capture regression in desktop WebKit with iPhone emulation.
// npm run build && npm run test:safari-session
// Optional: PPG_SAFARI_URL=https://host/ppg-js-demo PPG_SAFARI_ARTIFACTS=path
// Only the checked-in public recording is used. No physical-phone/camera claim.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, devices } from 'playwright';
import { instrumentReportGraphText } from './report-graph-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(root, process.env.PPG_SAFARI_ARTIFACTS || '.dream-loop/safari-session-check');
const timeoutSeconds = Number(process.env.PPG_SAFARI_TIMEOUT_SECONDS) || 260;
assert.ok(timeoutSeconds >= 180 && timeoutSeconds <= 600, 'session timeout must be180–600seconds');
mkdirSync(out, { recursive: true });
const original = JSON.parse(readFileSync(path.join(root, 'test/fixtures/iphone-200s.json'), 'utf8'));
const originalEnd = original.samples.at(-1).t;
const tail = original.samples.filter(sample => sample.t >= originalEnd - 60000);
const gap = original.samples.at(-1).t - original.samples.at(-2).t;
const extension = tail.map(sample => ({ ...sample, t: originalEnd + gap + sample.t - tail[0].t }));
const log = { ...original, samples: [...original.samples, ...extension] };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const evidence = { url: process.env.PPG_SAFARI_URL || `http://127.0.0.1:${server.address().port}/examples/app/index.html`, fixture: 'test/fixtures/iphone-200s.json',
  scope: 'Playwright WebKit with iPhone13 emulation; camera I/O mocked; no physical Safari or real camera claim.',
  replay: { rate: '1x wall clock from session start', originalSamples: original.samples.length,
    originalSeconds: (originalEnd - original.samples[0].t) / 1000,
    extension: 'Recorded final60s repeated once with monotonically shifted timestamps, only if automatic measurement needs more than the original recording.',
    missingFrames: 'Expired samples are dropped across stalls and hidden periods; resumed acquisition supplies the newest current sample, never a catch-up backlog.',
    totalAvailableSeconds: (log.samples.at(-1).t - log.samples[0].t) / 1000 }, checkpoints: [], interruptions: [], errors: [], consoleErrors: [], firstPartyRequestFailures: [] };
let browser, page, checkpointCapture;
try {
  browser = await webkit.launch();
  evidence.browser = browser.version();
  const context = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'no-preference' });
  page = await context.newPage();
  await instrumentReportGraphText(page);
  const firstParty = url => { try { return new URL(url).origin === new URL(evidence.url).origin; } catch { return false; } };
  page.on('pageerror', error => evidence.errors.push(String(error)));
  page.on('requestfailed', request => { if (firstParty(request.url())) evidence.firstPartyRequestFailures.push({ url: request.url(), failure: request.failure() }); });
  page.on('console', message => {
    if (message.type() === 'error' && (!message.location().url || firstParty(message.location().url))) evidence.consoleErrors.push(message.text());
    if (message.text().startsWith('SESSION_CHECKPOINT ')) {
      const checkpoint = JSON.parse(message.text().slice('SESSION_CHECKPOINT '.length));
      evidence.checkpoints.push(checkpoint);
      writeFileSync(`${out}/progress.json`, JSON.stringify(evidence, null, 2) + '\n');
      console.log('SESSION_CHECKPOINT', JSON.stringify(checkpoint));
      if (!checkpointCapture && checkpoint.wallSeconds >= 60) {
        checkpointCapture = (async () => {
          const started = Date.now();
          await page.screenshot({ path: `${out}/capture-390.png`, fullPage: true });
          evidence.midSessionCapture = { wallSeconds: checkpoint.wallSeconds, durationMs: Date.now() - started,
            timingScope: 'One screenshot at the60s checkpoint; its readback overhead remains included in the reported overall and stall-excluded cadence.' };
        })().catch(error => { evidence.evidenceCaptureError = String(error); });
      }
    }
    if (message.text().startsWith('SESSION_INTERRUPT ')) {
      const interruption = JSON.parse(message.text().slice('SESSION_INTERRUPT '.length));
      evidence.interruptions.push(interruption);
      writeFileSync(`${out}/progress.json`, JSON.stringify(evidence, null, 2) + '\n');
      console.log('SESSION_INTERRUPT', JSON.stringify(interruption));
    }
  });
  await page.goto(evidence.url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__paintGpuStats?.ready && paintGPU, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__paintGpuStats.backend), 'webgpu', 'actual WebKit WebGPU backend initializes');
  await page.screenshot({ path: `${out}/ready.png`, fullPage: true });
  await page.evaluate(({ log, originalLength }) => {
    window.__sessionMetrics = { intervals: [], uninterruptedIntervals: [], paintIntervals: [], interruptions: [], checkpointAt: 60,
      stopCalls: 0, originalLength, extensionUsed: false, droppedSamples: 0,
      scrolling: { samples: 0, min: null, max: null, fractionalPositions: 0, fractionalForwardSteps: 0,
        backwardSteps: 0, maxRows: 0, cropViolations: 0, maxContinuousPanStep: 0, examples: [] } };
    window.PPGMonitor = class extends PPG.PPGMonitor {
      constructor(host, options) {
        super(host, options);
        this.engine = new PPG.PpgEngine({ ...log.meta?.engineConfig?.engine, ...options.signal });
        this.video = document.createElement('video');
        this.torchSupported = true; this.torchState = 'on';
        this.currentMetrics = { fingerState: 'NO_FINGER' }; this.i = 0; this.fedSamples = 0; this.stopped = false;
      }
      async start() {
        this.options.onReady({ torchSupported: true });
        this.started = performance.now();
        const metrics = window.__sessionMetrics;
        let previous = 0, previousPaint = 0, previousPaintFrames = 0;
        let previousViewRow = null, previousPanTarget = null;
        let framePauseDone = false, stalled = false, hidden = false;
        let activeFeedPause = null, activeHidden = null, pendingResume = null, restoreVisibility = null;
        const pump = now => {
          if (this.stopped) { metrics.wallElapsedSec = (now - this.started) / 1000; return; }
          const frameGap = previous ? now - previous : 0;
          const returningFromStall = pendingResume?.kind === 'main-thread-stall';
          if (previous) {
            metrics.intervals.push(frameGap);
            if (!returningFromStall) metrics.uninterruptedIntervals.push(frameGap);
          }
          previous = now;
          const seconds = (now - this.started) / 1000;
          let newestOnly = frameGap > 250;
          if (activeFeedPause && now >= activeFeedPause.resumeAt) {
            activeFeedPause.heldMs = elapsedMeasuringMs - activeFeedPause.beforeMs;
            activeFeedPause.durationMs = now - activeFeedPause.startedAt;
            pendingResume = activeFeedPause; activeFeedPause = null; newestOnly = true;
          }
          if (activeHidden && now >= activeHidden.resumeAt) {
            activeHidden.heldMs = elapsedMeasuringMs - activeHidden.beforeMs;
            activeHidden.durationMs = now - activeHidden.startedAt;
            restoreVisibility(); document.dispatchEvent(new Event('visibilitychange'));
            pendingResume = activeHidden; activeHidden = null; newestOnly = true;
          }
          if (!activeHidden && !activeFeedPause) {
            this.feedUntil(seconds, newestOnly);
            if (pendingResume) {
              pendingResume.firstResumeCreditMs = elapsedMeasuringMs - pendingResume.beforeMs;
              pendingResume.resumedAt = now;
              pendingResume.resumeMs = elapsedMeasuringMs;
              metrics.interruptions.push(pendingResume);
              console.log('SESSION_INTERRUPT ' + JSON.stringify(pendingResume));
              pendingResume = null;
            }
          }
          metrics.extensionUsed ||= this.i > originalLength;
          const surface = window.__paintGpuStats.surfaces.manuscript;
          // Scalar reads only: track the real eased pan without DOM layout or
          // GPU readback on animation frames. At most12 examples are retained.
          const viewRow = manuscript.viewFirstRow, raster = manuscript.raster, panTarget = manuscript.scroll?.to ?? null;
          if (raster && Number.isFinite(viewRow)) {
            const scrolling = metrics.scrolling;
            scrolling.samples++;
            scrolling.min = scrolling.min === null ? viewRow : Math.min(scrolling.min, viewRow);
            scrolling.max = scrolling.max === null ? viewRow : Math.max(scrolling.max, viewRow);
            scrolling.maxRows = Math.max(scrolling.maxRows, raster.rows);
            if (viewRow < raster.firstRow - 1e-6 || viewRow + 4 > raster.firstRow + raster.rows + 1e-6) scrolling.cropViolations++;
            const fractional = Math.abs(viewRow - Math.round(viewRow)) > 1e-5;
            if (fractional) {
              scrolling.fractionalPositions++;
              if (scrolling.examples.length < 12) scrolling.examples.push(viewRow);
            }
            if (previousViewRow !== null) {
              const step = viewRow - previousViewRow;
              if (step < -1e-6) scrolling.backwardSteps++;
              if (step > 1e-6 && fractional) scrolling.fractionalForwardSteps++;
              if (panTarget !== null && panTarget === previousPanTarget && frameGap <= 100 && !activeHidden && !returningFromStall)
                scrolling.maxContinuousPanStep = Math.max(scrolling.maxContinuousPanStep, step);
            }
            previousViewRow = viewRow; previousPanTarget = panTarget;
          }
          if (surface.frames > previousPaintFrames) {
            if (previousPaint && now - previousPaint < 100 && !activeHidden && !returningFromStall) metrics.paintIntervals.push(now - previousPaint);
            previousPaint = now; previousPaintFrames = surface.frames;
          }
          for (const interruption of metrics.interruptions) {
            if (interruption.recoveryCreditMs === undefined && now - interruption.resumedAt >= 1200) {
              interruption.recoveryWallMs = now - interruption.resumedAt;
              interruption.recoveryCreditMs = elapsedMeasuringMs - interruption.resumeMs;
              interruption.recoveryPaintFrames = surface.frames - interruption.beforePaintFrames;
            }
            if (interruption.recoveredAtSeconds === undefined && manuscript.segments.length > interruption.beforeSegments
              && surface.frames > interruption.beforePaintFrames) interruption.recoveredAtSeconds = seconds;
          }
          if (!framePauseDone && elapsedMeasuringMs >= 45000 && this.currentMetrics.fingerState === 'MEASURING') {
            framePauseDone = true;
            // Camera frames stop while timers and animation frames keep running.
            // The last cached physiological state deliberately remains MEASURING.
            activeFeedPause = { kind: 'camera-frame-pause', startedAt: now, resumeAt: now + 4000, wallSeconds: seconds,
              beforeMs: elapsedMeasuringMs, beforeSegments: manuscript.segments.length, beforePaintFrames: surface.frames };
          } else if (!stalled && elapsedMeasuringMs >= 80000 && this.currentMetrics.fingerState === 'MEASURING') {
            stalled = true;
            const interruption = { kind: 'main-thread-stall', startedAt: performance.now(), wallSeconds: seconds,
              beforeMs: elapsedMeasuringMs, beforeSegments: manuscript.segments.length, beforePaintFrames: surface.frames };
            // Actual main-thread work, not clock advancement or timer mocking.
            while (performance.now() - interruption.startedAt < 2500) { /* deliberate regression stimulus */ }
            interruption.durationMs = performance.now() - interruption.startedAt;
            pendingResume = interruption;
          } else if (!hidden && !pendingResume && elapsedMeasuringMs >= 110000 && this.currentMetrics.fingerState === 'MEASURING') {
            hidden = true;
            const descriptors = ['hidden', 'visibilityState'].map(key => [key, Object.getOwnPropertyDescriptor(document, key)]);
            restoreVisibility = () => { for (const [key, descriptor] of descriptors) {
              if (descriptor) Object.defineProperty(document, key, descriptor); else delete document[key];
            } };
            activeHidden = { kind: 'simulated-visibility', startedAt: now, resumeAt: now + 4000, wallSeconds: seconds,
              beforeMs: elapsedMeasuringMs, beforeSegments: manuscript.segments.length, beforePaintFrames: surface.frames };
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
          }
          if (seconds >= metrics.checkpointAt) {
            console.log('SESSION_CHECKPOINT ' + JSON.stringify({ wallSeconds: seconds, measuringSeconds: elapsedMeasuringMs / 1000,
              countdown: document.getElementById('session-countdown').textContent, engineState: this.currentMetrics.fingerState,
              samples: this.fedSamples, consumedSamples: this.i, droppedSamples: metrics.droppedSamples, acceptedSegments: manuscript.segments.length, backend: window.__paintGpuStats.backend,
              gpuFrames: surface.frames, hidden: document.hidden, viewFirstRow: manuscript.viewFirstRow,
              cachedRows: manuscript.raster?.rows ?? 0, scrollFractionalSteps: metrics.scrolling.fractionalForwardSteps }));
            metrics.checkpointAt += 60;
          }
          this.replayFrame = requestAnimationFrame(pump);
        };
        this.replayFrame = requestAnimationFrame(pump);
      }
      stop() { this.stopped = true; window.__sessionMetrics.stopCalls++; window.__sessionMetrics.wallElapsedSec = (performance.now() - this.started) / 1000; }
      destroy() {}
      getMetrics() { return this.currentMetrics; }
      getSessionSummary() { return this.engine.getSessionSummary(); }
      getTachogram(options = {}) { return this.engine.getTachogram(options); }
      getDebugLog() { return log; }
      feedUntil(seconds, newestOnly = false) {
        const t0 = log.samples[0].t;
        if (newestOnly) {
          // A blocked/hidden camera does not deliver a backlog of frames.
          while (this.i + 1 < log.samples.length && (log.samples[this.i + 1].t - t0) / 1000 <= seconds) {
            this.i++; window.__sessionMetrics.droppedSamples++;
          }
        }
        for (; this.i < log.samples.length; this.i++) {
          const sample = log.samples[this.i], t = (sample.t - t0) / 1000;
          if (t > seconds) break;
          this.fedSamples++;
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
  }, { log, originalLength: original.samples.length });
  console.log('SESSION_START', new Date().toISOString());
  await page.locator('#btn-start').click();
  await page.waitForFunction(() => !document.getElementById('screen-summary').hidden, null, { timeout: timeoutSeconds * 1000 });
  evidence.session = await page.evaluate(() => {
    const beats = monitor.getTachogram({ goodOnly: true, hrvOnly: true }).filter(point => point.valid);
    const report = PPG.hrv.analyzeHRV(beats);
    return { ...window.__sessionMetrics, samples: monitor.fedSamples, consumedSamples: monitor.i, acceptedSegments: manuscript.segments.length,
      measuringSeconds: elapsedMeasuringMs / 1000, countdown: document.getElementById('session-countdown').textContent,
      expected: { hr: report.timeDomain.meanHR.toFixed(0), rmssd: report.timeDomain.rmssd.toFixed(1), sdnn: report.timeDomain.sdnn.toFixed(1), beats: report.meta.nBeats },
      gpu: window.__paintGpuStats, fonts: { dmSans: document.fonts.check('16px "DM Sans"'), waterBrush: document.fonts.check('72px "Water Brush"') } };
  });
  assert.ok(evidence.session.measuringSeconds >= 180, 'automatic countdown completed180s of MEASURING');
  assert.ok(evidence.session.measuringSeconds <= 181.1, 'display tick stops within one normal interval of180active seconds');
  assert.ok(evidence.session.wallElapsedSec >= 180 && evidence.session.wallElapsedSec <= timeoutSeconds, 'real wall-clock protocol completed within bound');
  assert.deepEqual(evidence.session.interruptions.map(interruption => interruption.kind), ['camera-frame-pause', 'main-thread-stall', 'simulated-visibility']);
  for (const interruption of evidence.session.interruptions) {
    assert.ok(Math.abs(interruption.firstResumeCreditMs) <= 1, `${interruption.kind}: no interruption or stale-frame catch-up credit`);
    if (interruption.kind !== 'main-thread-stall') assert.equal(interruption.heldMs, 0, `${interruption.kind}: absent camera frames never advance countdown`);
    assert.ok(interruption.recoveryCreditMs >= 0 && interruption.recoveryCreditMs <= interruption.recoveryWallMs + 50,
      `${interruption.kind}: resumed measurement advances no faster than fresh-frame wall time`);
    assert.ok(Number.isFinite(interruption.recoveredAtSeconds), `${interruption.kind}: accepted waveform and GPU painting recover`);
  }
  assert.ok(evidence.session.droppedSamples > 0, 'interruption stimuli actually removed camera frames');
  const scrolling = evidence.session.scrolling;
  assert.ok(scrolling.samples > 100 && scrolling.max > scrolling.min + 1, 'new manuscript rows actually advance the view');
  assert.ok(scrolling.fractionalPositions > 20 && scrolling.fractionalForwardSteps > 20, 'row movement contains real intermediate eased positions');
  assert.equal(scrolling.backwardSteps, 0, 'automatic follow never reverses');
  assert.ok(scrolling.maxRows >= 4 && scrolling.maxRows <= 5, 'cached manuscript layers never exceed5rows');
  assert.equal(scrolling.cropViolations, 0, 'pan stays inside the cached raster');
  assert.ok(scrolling.maxContinuousPanStep < .25, 'healthy animation frames advance smoothly within the same pan');
  assert.equal(evidence.session.stopCalls, 1, 'automatic completion stopped exactly once');
  assert.equal(evidence.session.countdown, '0:00');
  assert.equal(evidence.session.gpu.backend, 'webgpu');
  assert.equal(evidence.session.gpu.ready, true);
  assert.ok(evidence.session.gpu.surfaces.manuscript.frames > 0 && evidence.session.acceptedSegments > 0, 'actual accepted waveform was painted');
  assert.ok(evidence.session.fonts.dmSans && evidence.session.fonts.waterBrush);
  const values = await page.locator('.report-heroes strong').allTextContents();
  for (const [index, key] of ['hr', 'rmssd', 'sdnn'].entries()) assert.ok(values[index].includes(evidence.session.expected[key]), `report ${key} agrees with actual engine`);
  assert.match(await page.locator('.quality-facts').innerText(), new RegExp(String(evidence.session.expected.beats)));
  await page.setViewportSize({ width: 320, height: 900 });
  assert.deepEqual(await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]), [320, 320], 'WebKit320px has no mobile autozoom/overflow');
  await page.screenshot({ path: `${out}/report-320.png`, fullPage: true });
  for (const label of ['Frequency analysis', 'Nonlinear analysis', 'Beat timing & methods']) await page.getByText(label, { exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  evidence.graphs = await page.evaluate(() => ['psd-canvas', 'poincare-canvas', 'report-tacho-canvas'].map(id => {
    const canvas = document.getElementById(id);
    return { id, width: canvas.width, height: canvas.height, labels: window.__graphText[id] || [] };
  }));
  for (const graph of evidence.graphs) {
    assert.ok(graph.labels.length >= 4, `${graph.id} rendered actual labels`);
    for (const label of graph.labels) {
      assert.ok(label.left >= -1 && label.top >= -1 && label.right <= graph.width + 1 && label.bottom <= graph.height + 1, `${graph.id} label fits: ${label.text}`);
      assert.doesNotMatch(label.text, /^-0(?:\.0+)?$|^\d+:60$|NaN|Infinity/);
    }
    for (let i = 0; i < graph.labels.length; i++) for (let j = i + 1; j < graph.labels.length; j++) {
      const a = graph.labels[i], b = graph.labels[j];
      assert.ok(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1
        || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1, `${graph.id} labels do not overlap: ${a.text}/${b.text}`);
    }
    await page.locator(`#${graph.id}`).locator('..').screenshot({ path: `${out}/${graph.id}-320.png` });
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-save-manuscript').click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(`${out}/manuscript.png`);
  const png = readFileSync(`${out}/manuscript.png`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  evidence.export = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
  assert.ok(evidence.export.width <= 1200 && evidence.export.height <= 8192);
  const printBefore = await page.evaluate(() => {
    document.querySelector('.time-details').open = true;
    const nodes = [...document.querySelectorAll('.report-disclosure,.time-details,.ans-methods')];
    window.print = () => { window.__printOpened = nodes.map(node => node.open); window.dispatchEvent(new Event('afterprint')); window.__printRestored = nodes.map(node => node.open); };
    return nodes.map(node => node.open);
  });
  await page.locator('#btn-save-report').click();
  await page.waitForFunction(() => window.__printRestored !== undefined);
  evidence.print = await page.evaluate(() => ({ opened: window.__printOpened, restored: window.__printRestored }));
  assert.ok(evidence.print.opened.every(Boolean), 'print action opens every disclosure');
  assert.deepEqual(evidence.print.restored, printBefore, 'afterprint restores original disclosure states');
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.consoleErrors, [], 'no first-party or GPU console errors');
  assert.deepEqual(evidence.firstPartyRequestFailures, [], 'no failed first-party requests');
  await checkpointCapture;
  assert.ok(evidence.midSessionCapture && !evidence.evidenceCaptureError, '60s measuring screenshot was captured');
  const cadence = samples => { const ordered = [...samples].sort((a,b) => a-b); return { frames: samples.length, fps: 1000*samples.length/samples.reduce((sum,n)=>sum+n,0), p50Ms: ordered[Math.floor(ordered.length*.5)], p95Ms: ordered[Math.floor(ordered.length*.95)], maxMs: ordered.at(-1), over33Ms: samples.filter(n=>n>33.34).length }; };
  evidence.cadence = { allFramesIncludingDeliberateStall: cadence(evidence.session.intervals),
    excludingDeliberateMainThreadStall: cadence(evidence.session.uninterruptedIntervals), activePainting: cadence(evidence.session.paintIntervals) };
  delete evidence.session.intervals; delete evidence.session.uninterruptedIntervals; delete evidence.session.paintIntervals;
  evidence.passed = true; evidence.completedAt = new Date().toISOString();
  writeFileSync(`${out}/result.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log('SESSION_PASS', JSON.stringify({ measuringSeconds:evidence.session.measuringSeconds,wallElapsedSec:evidence.session.wallElapsedSec,extensionUsed:evidence.session.extensionUsed,expected:evidence.session.expected,cadence:evidence.cadence,export:evidence.export }));
} catch (error) {
  if (page && !page.isClosed()) {
    try { evidence.failureState = await page.evaluate(() => ({ session: window.__sessionMetrics, measuringSeconds: typeof elapsedMeasuringMs === 'number' ? elapsedMeasuringMs / 1000 : null, gpu: window.__paintGpuStats })); } catch { /* original error retained */ }
  }
  evidence.failure = String(error); writeFileSync(`${out}/failure.json`, JSON.stringify(evidence, null, 2) + '\n'); throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
