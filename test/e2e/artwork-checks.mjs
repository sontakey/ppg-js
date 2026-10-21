// Browser checks for the real report's artwork. Native sharing is mocked here:
// these checks cover payloads and recovery, not a physical iPhone share sheet.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function checkArtwork(page, output = process.env.PPG_ARTWORK_ARTIFACTS) {
  await page.waitForFunction(() => window.PulsePortrait?.getState()?.ready);
  const preparation = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;width:500px';
    document.body.append(host);
    const fonts = document.fonts;
    const originalLoad = Object.getOwnPropertyDescriptor(fonts, 'load');
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
        paintRows: (canvas, rowIndices) => paintManuscriptRaster(canvas, false, true, null, true, { rowIndices }),
      });
      const checkbox = host.querySelector('.portrait-options input');
      const disabledWhilePreparing = checkbox.disabled;
      releaseFonts([]);
      await mounting;
      return { disabledWhilePreparing, enabledWhenReady: !checkbox.disabled && PulsePortrait.getState(host).ready };
    } finally {
      releaseFonts([]);
      if (originalLoad) Object.defineProperty(fonts, 'load', originalLoad); else delete fonts.load;
      PulsePortrait.clear(host);
      host.remove();
    }
  });
  assert.equal(preparation.disabledWhilePreparing, true, 'metrics toggle is unavailable until artwork resources exist');
  assert.equal(preparation.enabledWhenReady, true, 'metrics toggle becomes available after artwork preparation');
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
        actionHeights: [...section.querySelectorAll('button')].map(button => button.getBoundingClientRect().height),
      };
    });
    assert.equal(layout.overflow, false, `portrait fits ${width}px viewport`);
    assert.ok(layout.canvasSupportText >= 14, `artwork labels remain at least 14px at ${width}px viewport`);
    assert.ok(layout.labels.every(label => label.font >= 14), `portrait supporting labels remain at least 14px at ${width}px viewport`);
    assert.ok(layout.actionHeights.every(height => height >= 44), 'portrait actions retain touch target height');
  }
  await page.setViewportSize(originalViewport);

  const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save artwork', exact: true }).click()]);
  assert.equal(await saved.failure(), null, 'artwork download succeeds');
  assert.equal(saved.suggestedFilename(), 'pulse-on-paper.png', 'artwork filename');
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
    } });
  });
  try {
    await page.getByRole('button', { name: 'Share artwork', exact: true }).click();
    await page.waitForFunction(() => window.__portraitShareCalls.length === 1);
    const [shared] = await page.evaluate(() => window.__portraitShareCalls);
    assert.deepEqual(shared.keys, ['files', 'title'], 'native sharing contains only the requested artwork and title');
    assert.equal(shared.name, 'pulse-on-paper.png');
    assert.equal(shared.type, 'image/png');
    assert.equal(shared.size, png.length);
    assert.equal(shared.digest, hash(png), 'native sharing uses the same cached PNG as Save artwork');
    await page.waitForFunction(() => document.querySelector('.portrait-status').textContent === 'Artwork shared.');

    await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) }));
    await page.getByRole('button', { name: 'Share artwork', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.portrait-share').disabled && document.querySelector('.portrait-status').textContent === '');
    assert.equal(await page.locator('.portrait-status').textContent(), '', 'cancelling the native share sheet is quiet');

    await page.evaluate(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }));
    const [fallback] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Share artwork', exact: true }).click()]);
    assert.equal(await fallback.failure(), null, 'unsupported native file sharing falls back to a downloadable artwork');
    assert.equal(hash(readFileSync(await fallback.path())), hash(png), 'fallback download preserves the artwork');
  } finally {
    await page.evaluate(() => {
      for (const name of ['canShare', 'share']) {
        const descriptor = window.__portraitShareOriginal[name];
        if (descriptor) Object.defineProperty(navigator, name, descriptor); else delete navigator[name];
      }
      delete window.__portraitShareOriginal; delete window.__portraitShareCalls;
    });
  }
  assert.equal(await page.getByRole('button', { name: 'Save report', exact: true }).count(), 1, 'scientific report export stays separate');
  assert.equal(await page.getByRole('button', { name: 'Measure again', exact: true }).count(), 1, 'report retains a separate new-measurement action');
  return { width: 1080, height: 1350, selectedRows: captured.state.selectedRows, durationSec: captured.state.durationSec, bytes: png.length, nativeShareScope: 'mocked browser API only' };
}
