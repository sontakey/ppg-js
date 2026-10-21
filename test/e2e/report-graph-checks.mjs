import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const graphIds = ['psd-canvas', 'poincare-canvas', 'report-tacho-canvas'];

// Record real browser glyph bounds, including alignment and transformed axes.
// DOM overflow alone cannot detect text cut off inside a canvas bitmap.
export async function instrumentReportGraphText(page) {
  await page.addInitScript(() => {
    window.__graphText = {};
    const tracked = id => ['psd-canvas', 'poincare-canvas', 'report-tacho-canvas'].includes(id);
    const proto = CanvasRenderingContext2D.prototype;
    const clear = proto.clearRect, fill = proto.fillText;
    proto.clearRect = function (...args) {
      if (tracked(this.canvas.id)) window.__graphText[this.canvas.id] = [];
      return clear.apply(this, args);
    };
    proto.fillText = function (text, x, y, ...args) {
      if (tracked(this.canvas.id)) {
        const m = this.measureText(text), t = this.getTransform();
        const corners = [
          [x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent],
          [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent],
          [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent],
          [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent],
        ].map(([px, py]) => ({ x: t.a * px + t.c * py + t.e, y: t.b * px + t.d * py + t.f }));
        (window.__graphText[this.canvas.id] ||= []).push({
          text: String(text), font: this.font,
          left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)),
          top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)),
        });
      }
      return fill.call(this, text, x, y, ...args);
    };
  });
}

async function assertGraphLabels(page, label) {
  // Wait for resize/font callbacks and the next paint, rather than forcing a draw.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const report = await page.evaluate(ids => ids.map(id => {
    const canvas = document.getElementById(id);
    return { id, width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight, dpr: devicePixelRatio, labels: window.__graphText[id] || [] };
  }), graphIds);
  for (const graph of report) {
    assert.ok(graph.labels.length >= 4, `${label}: ${graph.id} actually rendered labels`);
    assert.ok(Math.abs(graph.width - graph.cssWidth * graph.dpr) <= 2,
      `${label}: ${graph.id} redrew at its current display width`);
    assert.ok(graph.cssHeight >= 160 && graph.cssHeight < 700,
      `${label}: ${graph.id} has a stable readable height (${graph.cssHeight})`);
    const numericLabels = graph.labels.map(x => x.text).filter(x => /^-?[\d,.]+(?:e[+-]?\d+)?$/.test(x));
    for (const text of new Set(numericLabels)) {
      assert.ok(numericLabels.filter(x => x === text).length <= 2,
        `${label}: ${graph.id} rounded distinct ticks to the same number ${text}`);
    }
    for (let i = 0; i < graph.labels.length; i++) {
      const a = graph.labels[i];
      assert.ok(a.left >= -1 && a.top >= -1 && a.right <= graph.width + 1 && a.bottom <= graph.height + 1,
        `${label}: clipped ${graph.id} label ${JSON.stringify(a)}`);
      assert.doesNotMatch(a.text, /^-0(?:\.0+)?$|^\d+:60$|NaN|Infinity/, `${label}: malformed number`);
      for (let j = i + 1; j < graph.labels.length; j++) {
        const b = graph.labels[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        assert.ok(overlapX <= 1 || overlapY <= 1,
          `${label}: overlapping ${graph.id} labels ${JSON.stringify(a.text)} / ${JSON.stringify(b.text)}`);
      }
    }
  }
  if (label !== 'print style') {
    const requestedWidth = page.viewportSize().width;
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(viewport.width, requestedWidth, `${label}: mobile layout does not auto-zoom to hide overflow`);
    assert.ok(viewport.scrollWidth <= requestedWidth, `${label}: page fits the requested viewport`);
  }
  return { label, graphs: report.map(({ labels, ...graph }) => ({ ...graph, labels: labels.map(x => x.text) })) };
}

export async function checkReportGraphs(page) {
  const results = [];
  const out = process.env.PPG_GRAPH_ARTIFACTS;
  if (out) mkdirSync(out, { recursive: true });
  // Exercise both enlarging and shrinking after charts are already open.
  for (const width of [320, 390, 768, 1440, 320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    results.push(await assertGraphLabels(page, `screen ${width}px`));
    if (out && [320, 390, 1440].includes(width)) {
      for (const id of graphIds) {
        await page.locator(`#${id}`).locator('..').screenshot({ path: path.join(out, `${id}-${width}.png`) });
      }
    }
  }
  // Reopening a disclosure must not repeatedly multiply the canvas bitmap size.
  const before = await page.locator('#poincare-canvas').evaluate(c => [c.width, c.height]);
  for (let i = 0; i < 3; i++) {
    await page.getByText('Nonlinear analysis', { exact: true }).click();
    await page.getByText('Nonlinear analysis', { exact: true }).click();
    await assertGraphLabels(page, `reopen ${i}`);
  }
  assert.deepEqual(await page.locator('#poincare-canvas').evaluate(c => [c.width, c.height]), before);
  const screenScale = await page.evaluate(() => visualViewport.scale);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  results.push(await assertGraphLabels(page, 'print style'));
  if (out) await page.pdf({ path: path.join(out, 'report-graphs.pdf'), printBackground: true });
  // Physical print dimensions must stay the same at phone and desktop widths.
  const printWidth = await page.locator('#psd-canvas').evaluate(c => c.clientWidth);
  await page.setViewportSize({ width: 816, height: 1056 });
  results.push(await assertGraphLabels(page, 'print style'));
  assert.equal(await page.locator('#psd-canvas').evaluate(c => c.clientWidth), printWidth, 'print does not stretch a phone-sized canvas');
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 390, height: 844 });
  // Unlike a native print dialog, Chromium's mobile media emulation retains
  // auto-zoom from the wider physical print page. Restore the test viewport;
  // otherwise pointer coordinates still target the synthetic print zoom.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: screenScale });
  await cdp.detach();
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  results.push(await assertGraphLabels(page, 'screen after print'));

  // Numeric edge cases are renderer-only checks, never presented as session data.
  await page.evaluate(() => {
    drawPSD(document.getElementById('psd-canvas'), {
      ok: true, freqs: Array.from({ length: 101 }, (_, i) => i / 200),
      psd: Array.from({ length: 101 }, (_, i) => 8e7 * Math.exp(-i / 20)),
    });
    drawReportTachogram(document.getElementById('report-tacho-canvas'), Array(100).fill(599.5), [], []);
    drawPoincare(document.getElementById('poincare-canvas'), {
      poincarePoints: [[1000, 1000], [1000, 1000]], sd1: 0, sd2: 0,
    }, []);
  });
  results.push(await assertGraphLabels(page, 'large power / constant RR / minute rollover'));
  const ans = await page.evaluate(() => {
    const host = document.createElement('div');
    document.querySelector('#report-content').append(host);
    for (const value of [-12.34, -3, 0, 3, 12.34]) {
      const row = document.createElement('div'); row.className = 'ans-bar-wrap';
      host.append(row); drawBipolarBar(row, value, 'pns');
    }
    const fits = [...host.querySelectorAll('.bar-value-label')].map(label => {
      const box = label.getBoundingClientRect(), parent = label.closest('.ans-bar-wrap').getBoundingClientRect();
      return { text: label.textContent, fits: box.left >= parent.left - 1 && box.right <= parent.right + 1 };
    });
    host.remove(); return fits;
  });
  assert.ok(ans.every(x => x.fits), `ANS values fit even at scale limits: ${JSON.stringify(ans)}`);
  if (out) writeFileSync(path.join(out, 'graph-checks.json'), JSON.stringify(results, null, 2));
}
