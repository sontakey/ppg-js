// Browser checks for the real report's artwork. Native sharing is mocked here:
// these checks cover payloads and recovery, not a physical iPhone share sheet.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function openReportMenu(page) {
  if (!await page.locator('#debug-sheet').isVisible()) await page.locator('#btn-debug-menu').click();
  await page.locator('#debug-sheet').waitFor({ state: 'visible' });
}

export async function closeReportMenu(page) {
  if (await page.locator('#debug-sheet').isVisible()) await page.locator('#btn-debug-close').click();
}

async function checkReportActions(page) {
  const actions = page.locator('#screen-summary .summary-actions');
  assert.deepEqual(await actions.locator('button').allTextContents(), ['Share artwork', 'Measure again'], 'report dock contains only Share artwork and Measure again');
  assert.equal(await page.getByRole('button', { name: 'Share artwork', exact: true, includeHidden: true }).count(), 1, 'report contains one Share artwork action');
  assert.equal(await page.locator('.portrait-actions').count(), 0, 'artwork has no duplicate inline action row');
  assert.equal(await actions.locator('#btn-share-artwork.btn-primary').count(), 1, 'Share artwork is the primary report action');
  assert.equal(await actions.getByRole('button', { name: 'Save report', exact: true }).count(), 0, 'Save report is absent from the floating dock');
}

export async function checkEmptyArtworkActions(page) {
  await checkReportActions(page);
  assert.equal(await page.locator('#btn-share-artwork').isDisabled(), true, 'an empty report cannot share nonexistent artwork');
  await openReportMenu(page);
  try {
    assert.equal(await page.locator('#debug-sheet #btn-save-artwork').isDisabled(), true, 'an empty report cannot save nonexistent artwork');
  } finally { await closeReportMenu(page); }
}

export async function checkReportDockViewport(page) {
  const result = await page.evaluate(async () => {
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalFocus = document.activeElement;
    const originalScroll = { x: scrollX, y: scrollY };
    const editable = document.createElement('input');
    editable.type = 'text';
    editable.setAttribute('aria-label', 'Keyboard layout regression probe');
    editable.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const snapshot = () => ({
      reserve: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-reserve')),
      inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-viewport-inset')),
      dockBottom: parseFloat(getComputedStyle(document.querySelector('.summary-actions')).bottom),
    });
    const keyboardGap = 350;
    try {
      document.activeElement?.blur();
      window.dispatchEvent(new Event('resize'));
      await settle();
      const baseline = snapshot();
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: { height: innerHeight - keyboardGap, offsetTop: 0, scale: 1 },
      });
      window.dispatchEvent(new Event('resize'));
      await settle();
      const unfocused = snapshot();
      document.querySelector('.portrait-options input').focus({ preventScroll: true });
      await settle();
      const checkbox = snapshot();
      document.body.append(editable);
      editable.focus({ preventScroll: true });
      await settle();
      const editing = snapshot();
      editable.blur();
      await settle();
      const blurred = snapshot();
      return { baseline, unfocused, checkbox, editing, blurred, keyboardGap };
    } finally {
      editable.remove();
      if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
      else delete window.visualViewport;
      if (originalFocus instanceof HTMLElement) originalFocus.focus({ preventScroll: true });
      window.dispatchEvent(new Event('resize'));
      await settle();
      window.scrollTo(originalScroll.x, originalScroll.y);
    }
  });
  assert.equal(result.baseline.inset, 0, 'report starts without keyboard compensation');
  assert.deepEqual(result.unfocused, result.baseline, 'browser viewport shrink without text focus adds no report whitespace');
  assert.deepEqual(result.checkbox, result.baseline, 'metrics checkbox cannot activate keyboard compensation');
  assert.equal(result.editing.inset, result.keyboardGap, 'a focused text field keeps the dock above its keyboard');
  assert.equal(result.editing.reserve, result.baseline.reserve + result.keyboardGap, 'genuine keyboard focus retains room to scroll the final editable content above the dock');
  assert.deepEqual(result.blurred, result.baseline, 'focusout clears keyboard compensation even before the visual viewport recovers');
  return result;
}

export async function checkArtwork(page, output = process.env.PPG_ARTWORK_ARTIFACTS) {
  await page.waitForFunction(() => window.PulsePortrait?.getState()?.ready);
  await checkReportActions(page);
  assert.equal(await page.locator('#btn-share-artwork').isEnabled(), true, 'floating Share artwork becomes available when its PNG is ready');
  const preparation = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;width:500px';
    document.body.append(host);
    const fonts = document.fonts;
    const originalLoad = Object.getOwnPropertyDescriptor(fonts, 'load');
    const shareButton = document.createElement('button');
    const saveButton = document.createElement('button');
    let releaseFonts;
    const fontGate = new Promise(resolve => { releaseFonts = resolve; });
    try {
      Object.defineProperty(fonts, 'load', { configurable: true, value: () => fontGate });
      const mounting = PulsePortrait.mount(host, {
        segments: manuscript.segments,
        start: manuscript.segments[0].points[0].t,
        durationSec: elapsedMeasuringMs / 1000,
        startedAt: new Date(portraitStartedAt || Date.now()),
        pigmentAt,
        shareButton, saveButton,
        paintRows: (canvas, rowIndices) => paintManuscriptRaster(canvas, false, true, null, true, { rowIndices }),
      });
      const checkbox = host.querySelector('.portrait-options input');
      const disabledWhilePreparing = checkbox.disabled && shareButton.disabled && saveButton.disabled;
      releaseFonts([]);
      const state = await mounting;
      const enabledWhenReady = !checkbox.disabled && !shareButton.disabled && !saveButton.disabled && PulsePortrait.getState(host).ready;
      checkbox.click();
      const disabledWhileRegenerating = shareButton.disabled && saveButton.disabled;
      await state.ready;
      const enabledAfterRegenerating = !shareButton.disabled && !saveButton.disabled && PulsePortrait.getState(host).ready;
      PulsePortrait.clear(host);
      const disabledAfterClear = shareButton.disabled && saveButton.disabled;
      return { disabledWhilePreparing, enabledWhenReady, disabledWhileRegenerating, enabledAfterRegenerating, disabledAfterClear };
    } finally {
      releaseFonts([]);
      if (originalLoad) Object.defineProperty(fonts, 'load', originalLoad); else delete fonts.load;
      PulsePortrait.clear(host);
      host.remove();
    }
  });
  assert.equal(preparation.disabledWhilePreparing, true, 'metrics toggle and external artwork actions are unavailable until artwork resources exist');
  assert.equal(preparation.enabledWhenReady, true, 'metrics toggle and external artwork actions become available after preparation');
  assert.equal(preparation.disabledWhileRegenerating, true, 'external artwork actions wait for regenerated PNG pixels');
  assert.equal(preparation.enabledAfterRegenerating, true, 'external artwork actions become available after regeneration');
  assert.equal(preparation.disabledAfterClear, true, 'clearing a portrait disables its external artwork controls');
  const canvas = page.locator('.portrait-preview canvas');
  const checkbox = page.locator('.portrait-options input');
  const originalViewport = page.viewportSize();
  const captured = await page.evaluate(() => {
    const state = PulsePortrait.getState(portraitHost);
    const start = manuscript.segments[0].points[0].t;
    const occupied = new Set();
    const coverage = new Map();
    for (const segment of manuscript.segments) {
      for (let i = 1; i < segment.points.length; i++) {
        const a = segment.points[i - 1], b = segment.points[i];
        if (b.t - a.t > .15) continue;
        const rowA = Math.floor((a.t - start) / 5), rowB = Math.floor((b.t - start) / 5);
        if (rowA === rowB) {
          occupied.add(rowA);
          coverage.set(rowA, (coverage.get(rowA) || 0) + b.t - a.t);
        }
      }
    }
    const palette = state.selectedRows.map(row => {
      const colors = Array.from({ length: 21 }, (_, i) => pigmentAt(start + row * 5 + i / 4, .9));
      let maxDistance = 0;
      for (const a of colors) for (const b of colors) maxDistance = Math.max(maxDistance, Math.hypot(...a.map((value, i) => value - b[i])));
      const boundary = start + (row + 1) * 5;
      const before = pigmentAt(boundary - .00001, .9), after = pigmentAt(boundary + .00001, .9);
      return { maxDistance, boundaryDelta: Math.max(...before.map((value, i) => Math.abs(value - after[i]))) };
    });
    // A future accepted segment must not recolor any completed waveform row.
    // Restore the real captured array even if the rasterizer throws.
    const oldRow = document.createElement('canvas'); oldRow.width = 600; oldRow.height = 180;
    const draw = () => {
      paintManuscriptRaster(oldRow, false, true, null, true, { rowIndices: [state.selectedRows[0]] });
      return oldRow.toDataURL();
    };
    const historyBefore = draw();
    const template = manuscript.segments[0];
    const shift = manuscript.segments.at(-1).points.at(-1).t + 10 - template.points[0].t;
    manuscript.segments.push({ ...template, points: template.points.map(point => ({ ...point, t: point.t + shift })) });
    let historyAfter;
    try { historyAfter = draw(); } finally { manuscript.segments.pop(); }
    return {
      state, expectedDuration: elapsedMeasuringMs / 1000, occupied: [...occupied], coverage: [...coverage], palette,
      frozenHistory: historyBefore === historyAfter,
      image: document.querySelector('.portrait-preview canvas').toDataURL(),
      accessibleDescription: document.querySelector('.portrait-preview canvas').getAttribute('aria-label'),
    };
  });
  assert.equal(captured.state.width, 1080, 'share artwork width');
  assert.equal(captured.state.height, 1350, 'share artwork height');
  assert.equal(captured.state.durationSec, captured.expectedDuration, 'portrait uses actual active capture duration, including early finishes');
  assert.equal(captured.state.includeMetrics, false, 'numeric metrics are excluded from shared artwork by default');
  assert.equal(await checkbox.isChecked(), false, 'metrics inclusion starts unchecked');
  assert.match(captured.accessibleDescription, /Selected moments/, 'selected rows are labeled as an excerpt');
  assert.ok(captured.state.selectedRows.length > 0 && captured.state.selectedRows.length <= 4, 'portrait has up to four captured rows');
  assert.ok(captured.state.selectedRows.every(row => captured.occupied.includes(row)), 'selected rows contain accepted, drawable waveform edges');
  assert.equal(new Set(captured.state.selectedRows).size, captured.state.selectedRows.length, 'selected waveform rows are not duplicated');
  assert.deepEqual([...captured.state.selectedRows].sort((a, b) => a - b), captured.state.selectedRows, 'selected rows retain temporal order');
  const coverage = new Map(captured.coverage);
  const firstRow = Math.min(...captured.occupied), rowSpan = Math.max(...captured.occupied) - firstRow + 1;
  const bandFor = row => Math.floor((row - firstRow) / rowSpan * captured.state.selectedRows.length);
  for (const row of captured.state.selectedRows) {
    const bandHasFullerRow = captured.occupied.some(candidate => bandFor(candidate) === bandFor(row) && coverage.get(candidate) >= 3.5);
    if (bandHasFullerRow) assert.ok(coverage.get(row) >= 3.5, 'portrait prefers well-observed real rows when available in that time band');
  }
  assert.ok(captured.state.pigmentWeights.every(pigment => pigment.weight > 0), 'background pigments come from captured stroke contribution');
  assert.ok(Math.abs(captured.state.pigmentWeights.reduce((sum, pigment) => sum + pigment.ratio, 0) - 1) < 1e-9, 'accepted pigment contributions are normalized');
  assert.ok(captured.palette.every(row => row.maxDistance > 65), 'every selected pulse row contains significantly different cool pigments within the stroke');
  assert.ok(captured.palette.every(row => row.boundaryDelta < 2), 'pigment remains continuous across manuscript line boundaries');
  assert.equal(captured.frozenHistory, true, 'future captured strokes never recolor completed waveform history');

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.locator('.pulse-portrait').evaluate(section => {
      const canvasWidth = section.querySelector('canvas').getBoundingClientRect().width;
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        canvasSupportText: canvasWidth / 1080 * 60,
        labels: [...section.querySelectorAll('p,figcaption,label,button')].map(element => ({ font: parseFloat(getComputedStyle(element).fontSize), height: element.getBoundingClientRect().height })),
        actionHeights: [...document.querySelectorAll('#screen-summary .summary-actions button')].map(button => button.getBoundingClientRect().height),
      };
    });
    assert.equal(layout.overflow, false, `portrait fits ${width}px viewport`);
    assert.ok(layout.canvasSupportText >= 14, `artwork labels remain at least 14px at ${width}px viewport`);
    assert.ok(layout.labels.every(label => label.font >= 14), `portrait supporting labels remain at least 14px at ${width}px viewport`);
    assert.ok(layout.actionHeights.length === 2 && layout.actionHeights.every(height => height >= 44), 'floating report actions retain touch target height');
  }
  await checkReportDockViewport(page);
  await page.setViewportSize(originalViewport);

  await openReportMenu(page);
  assert.equal(await page.locator('#debug-sheet').getByRole('button', { name: 'Save report', exact: true }).count(), 1, 'scientific report export is available in the menu');
  assert.equal(await page.locator('#debug-sheet #btn-save-artwork').isEnabled(), true, 'ready artwork can be saved from the menu');
  const [saved] = await Promise.all([page.waitForEvent('download'), page.locator('#debug-sheet').getByRole('button', { name: 'Save artwork', exact: true }).click()]);
  await closeReportMenu(page);
  assert.equal(await saved.failure(), null, 'artwork download succeeds');
  assert.equal(saved.suggestedFilename(), 'pulse-painting.png', 'artwork filename');
  const png = readFileSync(await saved.path());
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'artwork is a PNG');
  assert.equal(png.readUInt32BE(16), 1080, 'downloaded portrait width');
  assert.equal(png.readUInt32BE(20), 1350, 'downloaded portrait height');
  if (output) { mkdirSync(output, {recursive:true}); writeFileSync(`${output}/portrait.png`, png); }
  assert.equal(hash(png), hash(Buffer.from(captured.image.split(',')[1], 'base64')), 'export uses the exact preview pixels');

  await checkbox.check();
  await page.waitForFunction(() => PulsePortrait.getState().ready && PulsePortrait.getState().includeMetrics);
  assert.notEqual(await canvas.evaluate(node => node.toDataURL()), captured.image, 'explicit metric opt-in changes the shared portrait');
  await checkbox.uncheck();
  await page.waitForFunction(() => PulsePortrait.getState().ready && !PulsePortrait.getState().includeMetrics);
  assert.equal(await canvas.evaluate(node => node.toDataURL()), captured.image, 'regenerating the default portrait preserves its exact seeded composition');

  await page.evaluate(() => {
    window.__portraitShareOriginal = Object.fromEntries(['canShare', 'share'].map(name => [name, Object.getOwnPropertyDescriptor(navigator, name)]));
    window.__portraitShareCalls = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => !!data.files?.length });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
      const file = data.files[0];
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      window.__portraitShareCalls.push({
        keys: Object.keys(data).sort(), title: data.title, name: file.name, type: file.type, size: file.size,
        digest: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
      });
      await new Promise(resolve => { window.__portraitShareResolve = resolve; });
    } });
  });
  try {
    await page.getByRole('button', { name: 'Share artwork', exact: true }).click();
    await page.waitForFunction(() => window.__portraitShareCalls.length === 1);
    const [shared] = await page.evaluate(() => window.__portraitShareCalls);
    assert.deepEqual(shared.keys, ['files', 'title'], 'native sharing contains only the requested artwork and title');
    assert.equal(shared.name, 'pulse-painting.png');
    assert.equal(shared.title, 'Pulse Painting', 'native share uses the current product name');
    assert.equal(shared.type, 'image/png');
    assert.equal(shared.size, png.length);
    assert.equal(shared.digest, hash(png), 'native sharing uses the same cached PNG as Save artwork');
    assert.equal(await page.locator('#btn-share-artwork').isDisabled(), true, 'floating Share artwork is disabled while the native share operation is pending');
    await page.evaluate(() => window.__portraitShareResolve());
    await page.waitForFunction(() => document.querySelector('.portrait-status').textContent === 'Artwork shared.');
    await page.waitForFunction(() => !document.querySelector('#btn-share-artwork').disabled);

    await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) }));
    await page.getByRole('button', { name: 'Share artwork', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#btn-share-artwork').disabled && document.querySelector('.portrait-status').textContent === '');
    assert.equal(await page.locator('.portrait-status').textContent(), '', 'cancelling the native share sheet is quiet');

    await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
    const [fallback] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share artwork', exact: true }).click()]);
    assert.equal(await fallback.failure(), null, 'unsupported native file sharing falls back to a downloadable artwork');
    assert.equal(hash(readFileSync(await fallback.path())), hash(png), 'fallback download preserves the artwork');
  } finally {
    await page.evaluate(() => {
      window.__portraitShareResolve?.();
      for (const name of ['canShare', 'share']) {
        const descriptor = window.__portraitShareOriginal[name];
        if (descriptor) Object.defineProperty(navigator, name, descriptor); else delete navigator[name];
      }
      delete window.__portraitShareOriginal; delete window.__portraitShareCalls; delete window.__portraitShareResolve;
    });
  }
  assert.equal(await page.locator('#debug-sheet #btn-save-report').count(), 1, 'scientific report export stays separate in the menu');
  assert.equal(await page.getByRole('button', { name: 'Measure again', exact: true }).count(), 1, 'report retains a separate new-measurement action');
  await page.evaluate(() => {
    window.__artworkOriginalPrint = Object.getOwnPropertyDescriptor(window, 'print');
    Object.defineProperty(window, 'print', { configurable: true, value: () => {
      window.__artworkPrint = {
        menuHidden: document.getElementById('debug-sheet').hidden,
        detailsOpen: [...document.querySelectorAll('.report-disclosure,.time-details,.ans-methods')].every(details => details.open),
      };
      window.dispatchEvent(new Event('afterprint'));
    } });
  });
  try {
    await openReportMenu(page);
    await page.locator('#debug-sheet').getByRole('button', { name: 'Save report', exact: true }).click();
    await page.waitForFunction(() => window.__artworkPrint);
    assert.deepEqual(await page.evaluate(() => window.__artworkPrint), { menuHidden: true, detailsOpen: true }, 'Save report closes the options menu before printing the complete report');
  } finally {
    await page.evaluate(() => {
      if (window.__artworkOriginalPrint) Object.defineProperty(window, 'print', window.__artworkOriginalPrint);
      else delete window.print;
      delete window.__artworkOriginalPrint; delete window.__artworkPrint;
    });
    await closeReportMenu(page);
  }
  return { width: 1080, height: 1350, selectedRows: captured.state.selectedRows, durationSec: captured.state.durationSec, bytes: png.length, nativeShareScope: 'mocked browser API only' };
}
