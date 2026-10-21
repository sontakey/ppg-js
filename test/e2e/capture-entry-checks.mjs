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
    await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
    await page.evaluate(() => document.getElementById('btn-start').click());
    assert.equal(await page.evaluate(() => window.__entryTest.starts), 1, 'rapid duplicate start is ignored');
    assert.equal(await page.evaluate(() => window.__entryTest.gesture), true, 'camera starts inside the user gesture');
    assert.equal(await page.locator('#screen-placement').isVisible(), true, 'placement state is live immediately beneath the nonblocking visual wash');
    if (reducedMotion === 'no-preference') {
      assert.equal(await page.evaluate(() => entryTransition !== null), true, 'pigment transition starts');
      assert.equal(await page.locator('#btn-start').getAttribute('aria-busy'), 'true', 'entry action announces the transition');
      await page.waitForFunction(() => entryTransition && performance.now() - entryTransition.began >= 350);
      if (out) await page.screenshot({ path: path.join(out, 'entry-spreading.png') });
      await page.waitForFunction(() => entryTransition === null);
    } else {
      assert.equal(await page.evaluate(() => entryTransition), null, 'reduced motion skips the page expansion');
    }
    assert.equal(await page.locator('#screen-placement').isVisible(), true);
    assert.equal(await page.locator('#btn-start').getAttribute('aria-busy'), null);
    await page.locator('#btn-cancel-placement').click();
    assert.equal(await page.locator('#screen-ready').isVisible(), true);

    await page.evaluate(() => window.__entryTest.mode = 'pending');
    await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
    await page.waitForFunction(() => entryTransition === null);
    await page.locator('#btn-cancel-placement').click();
    const stopped = await page.evaluate(() => window.__entryTest.stops);
    await page.evaluate(() => window.__entryTest.resolve());
    await page.waitForFunction(previous => window.__entryTest.stops > previous, stopped);
    assert.equal(await page.locator('#screen-ready').isVisible(), true, 'late camera grant stays canceled');
    assert.equal(await page.evaluate(() => window.__entryTest.tracks.every(track => track.stopped)), true, 'late-granted camera tracks are released');

    await page.evaluate(() => window.__entryTest.mode = 'reject');
    await page.getByRole('button', { name: 'Begin pulse capture', exact: true }).click();
    await page.waitForFunction(() => !sessionStarting && sessionTimerId === null);
    assert.equal(await page.locator('#screen-ready').isVisible(), true, 'denial returns to ready');
    assert.equal(await page.evaluate(() => entryTransition), null, 'denial clears the pigment transition');
    assert.equal(await page.locator('#btn-start').getAttribute('aria-busy'), null, 'denial clears the busy state');
    // Screen state, interruptions and accessible controls stay independent of
    // the optional paint. These exercise the production transitions, not mocks.
    if (reducedMotion === 'no-preference') {
      await page.evaluate(() => { beginEntryTransition(); showScreen('placement'); showScreen('measuring'); });
      assert.equal(await page.locator('#screen-measuring').isVisible(), true, 'capture state is never postponed by an entry wash');
      await page.evaluate(() => showScreen('placement'));
      assert.equal(await page.evaluate(() => entryTransition), null, 'finger recovery immediately removes any obscuring wash');
      await page.evaluate(() => showScreen('measuring'));
      assert.equal(await page.evaluate(() => entryTransition?.kind), 'capture', 'accepted signal uses a lighter brush pass');
      await page.waitForFunction(() => entryTransition === null);
      await page.evaluate(() => {reportArtworkReady=new Promise(resolve=>window.__finishPrepareResolve=resolve);showScreen('summary');});
      assert.equal(await page.evaluate(() => entryTransition?.preparing), true, 'finish holds a static veil while artwork is being prepared');
      assert.equal(await page.evaluate(() => entryTransition?.kind), 'finish', 'report arrives through a finishing wash');
      assert.equal(await page.locator('#screen-summary').isVisible(), true, 'report is live before its visual wash ends');
      await page.locator('#btn-again').click();
      assert.equal(await page.locator('#screen-ready').isVisible(), true, 'measure again works while the finishing wash is active');
      assert.equal(await page.evaluate(() => entryTransition?.kind), 'return', 'a new gesture replaces the old transition');
      await page.evaluate(() => window.__finishPrepareResolve());
      assert.equal(await page.evaluate(() => entryTransition?.kind), 'return', 'late portrait preparation cannot restart a canceled finish transition');
      await page.evaluate(() => beginEntryTransition({kind:'finish',prepare:new Promise(()=>{})}));
      assert.equal(await page.evaluate(() => entryTransition?.preparing), true, 'motion preference test starts during static preparation');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => entryTransition === null);
      assert.equal(await page.locator('#entry-pigment').isHidden(), true, 'changing motion preference clears the active overlay');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
      await page.evaluate(() => beginEntryTransition());
      assert.equal(await page.evaluate(() => entryTransition !== null), true, 'motion preference restoration permits a fresh transition');
      await page.setViewportSize({ width: 400, height: 844 });
      await page.waitForFunction(() => entryTransition === null);
      assert.equal(await page.evaluate(() => __pulseBrushStats.history.at(-1).reason), 'resize', 'rotation or viewport resize cancels stale canvas dimensions');
      await page.evaluate(() => {
        beginEntryTransition();
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(await page.evaluate(() => entryTransition), null, 'hidden documents cancel visual work immediately');
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      assert.equal(await page.locator('#screen-ready').isVisible(), true, 'visibility recovery preserves the authoritative screen');
      await page.evaluate(() => {
        beginEntryTransition({kind:'finish',prepare:new Promise(()=>{})});
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      assert.equal(await page.evaluate(() => entryTransition), null, 'pagehide cancels animation before disposing GPU surfaces');
      assert.equal(await page.locator('#entry-pigment').isHidden(), true, 'pagehide leaves no stale visual overlay');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      assert.equal(await page.evaluate(() => paintPageActive), true, 'back-forward cache restoration permits later paint warmup');
      await page.evaluate(() => beginEntryTransition({kind:'finish',prepare:new Promise(()=>{})}));
      await page.waitForFunction(() => entryTransition && !entryTransition.preparing);
      assert.equal(await page.evaluate(() => entryTransition.preparationTimedOut), true, 'a stalled preparation promise releases the static veil at its bound');
      await page.waitForFunction(() => entryTransition === null);
      assert.ok(await page.evaluate(() => __pulseBrushStats.history.at(-1).preparationMs >= 250), 'preparation time is reported separately and remains in total elapsed time');
      const diagnostics=await page.evaluate(() => __pulseBrushStats);
      assert.ok(diagnostics.history.every(item => item.elapsedMs >= 0), 'transition timing records real lifecycle outcomes');
      assert.equal(diagnostics.active, false, 'no animation remains scheduled after interruption');
    }
    assert.deepEqual(errors, [], 'entry flow has no runtime errors');
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(out, 'capture-entry.webm'));
  }
}
