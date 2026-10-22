import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { devices } from 'playwright';

export async function checkCaptureEntry(browser, url) {
  const out = process.env.PPG_GRAPH_ARTIFACTS;
  if (out) mkdirSync(out, { recursive: true });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({
      ...devices['iPhone 13'], reducedMotion,
      ...(out && reducedMotion === 'no-preference' ? { recordVideo: { dir: out, size: { width: 390, height: 844 } } } : {}),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      window.__entryTest = { starts: 0, stops: 0, destroys: 0, mode: 'ready', gesture: false, tracks: [] };
      window.PPGMonitor = class extends PPG.PPGMonitor {
        constructor(host, options) { super(host, { ...options, wakeLock: false, motion: false, debug: { persistLastSession: false } }); }
        async start() {
          const state = window.__entryTest;
          state.starts++;
          state.gesture = navigator.userActivation.isActive;
          return super.start();
        }
        // Mock only the camera acquisition boundary. Keep the real monitor's
        // start/stop/destroy lifecycle, including its video-element dependency.
        async _openCamera() {
          const state = window.__entryTest;
          if (state.mode === 'pending') await new Promise(resolve => state.resolve = resolve);
          if (state.mode === 'reject') throw new Error('Test camera denied');
          const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({}) };
          state.tracks.push(track);
          if (!this.video) throw new Error('video element missing before stream adoption');
          return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] },
            capabilities: {}, applied: {}, constraintErrors: {}, torchSupported: true, torchState: 'on' };
        }
        _installWatchers() {}
        _scheduleNextFrame() {}
        stop() { window.__entryTest.stops++; super.stop(); }
        destroy() { window.__entryTest.destroys++; super.destroy(); }
      };
    });
    if (out) await page.screenshot({ path: path.join(out, `ready-${reducedMotion}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.evaluate(() => document.getElementById('btn-start').click());
    assert.equal(await page.evaluate(() => window.__entryTest.starts), 1, 'rapid duplicate start is ignored');
    assert.equal(await page.evaluate(() => window.__entryTest.gesture), true, 'camera starts inside the user gesture');
    assert.equal(await page.locator('#screen-placement').isVisible(), true, 'placement state is immediately available');
    await page.locator('#btn-cancel-placement').click();
    assert.equal(await page.locator('#screen-ready').isVisible(), true);

    await page.evaluate(() => window.__entryTest.mode = 'pending');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('#btn-cancel-placement').click();
    const stopped = await page.evaluate(() => window.__entryTest.stops);
    await page.evaluate(() => window.__entryTest.resolve());
    await page.waitForFunction(previous => window.__entryTest.stops > previous, stopped);
    assert.equal(await page.locator('#screen-ready').isVisible(), true, 'late camera grant stays canceled');
    assert.equal(await page.evaluate(() => window.__entryTest.tracks.every(track => track.stopped)), true, 'late-granted camera tracks are released');

    await page.evaluate(() => window.__entryTest.mode = 'reject');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.waitForFunction(() => !sessionStarting && sessionTimerId === null);
    assert.equal(await page.locator('#screen-ready').isVisible(), true, 'denial returns to ready');
    assert.deepEqual(errors, [], 'entry flow has no runtime errors');
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(out, 'capture-entry.webm'));
  }
}
