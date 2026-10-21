// Desktop phone handoff: actual SVG pixels, stationary scan geometry, clean
// quiet zone, responsive layout and one-shot / reduced-motion decoration.
// Run: node test/e2e/qr-checks.mjs
// Optional: PPG_QR_URL=https://chatppg.com/ppg-js-demo PPG_QR_OUTPUT=/tmp/qr-live
// Decoding uses development-only Python OpenCV and numpy, never shipped code.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.env.PPG_QR_OUTPUT || path.join(root, '.dream-loop/painted-qr'));
mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = process.env.PPG_QR_URL || `http://127.0.0.1:${server.address().port}/examples/app/index.html`;
const manifest = { url, expectedURL: 'https://chatppg.com/ppg-js-demo', captures: [], cards: [], layouts: [], errors: [] };
let browser;
try {
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await type.launch(name === 'chromium' && process.platform === 'darwin' ? { channel: 'chrome' } : {});
    for (const width of [320, 634, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
      page.on('pageerror', error => manifest.errors.push(`${name}/${width}: ${error.message}`));
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      const qr = page.locator('#phone-qr');
      await qr.waitFor({ state: 'visible' });
      await qr.evaluate(image => image.decode());
      const before = await qr.boundingBox();
      await page.waitForTimeout(350);
      assert.deepEqual(await qr.boundingBox(), before, `${name}/${width}: QR stays stationary during paint entrance`);
      await page.waitForTimeout(1250);
      assert.deepEqual(await qr.boundingBox(), before, `${name}/${width}: QR stays stationary when paint settles`);
      const layout = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        imageAnimation: getComputedStyle(document.getElementById('phone-qr')).animationName,
        washAnimation: getComputedStyle(document.querySelector('.phone-qr-paper'), '::before').animationName,
        washIterations: getComputedStyle(document.querySelector('.phone-qr-paper'), '::before').animationIterationCount,
        brushTitles: [...document.querySelectorAll('#screen-ready h1,#screen-ready h2')].filter(el => getComputedStyle(el).fontFamily.includes('Water Brush')).length,
      }));
      assert.equal(layout.width, width);
      assert.ok(layout.scrollWidth <= width, `${name}/${width}: no horizontal overflow`);
      assert.equal(layout.imageAnimation, 'none');
      assert.equal(layout.washAnimation, 'qr-wash-in');
      assert.equal(layout.washIterations, '1');
      assert.equal(layout.brushTitles, 1);
      const capture = { name: `${name}-${width}`, file: path.join(output, `${name}-${width}-qr.png`) };
      await qr.screenshot({ path: capture.file });
      manifest.captures.push(capture);
      const card = { name: `${name}-${width}`, file: path.join(output, `${name}-${width}-card.png`) };
      await page.locator('.phone-panel-code').screenshot({ path: card.file });
      manifest.cards.push(card);
      manifest.layouts.push({ browser: name, ...layout });
      await page.screenshot({ path: path.join(output, `${name}-${width}-page.png`), fullPage: true });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await page.locator('.phone-qr-paper').evaluate(el => ['::before', '::after'].map(pseudo => getComputedStyle(el, pseudo).animationName));
      assert.deepEqual(reduced, ['none', 'none']);
      await page.close();
    }
    await browser.close(); browser = undefined;
  }
  assert.deepEqual(manifest.errors, []);
  const manifestPath = path.join(output, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const decoded = spawnSync(process.env.PPG_PYTHON || 'python3', [path.join(root, 'test/e2e/decode-phone-qr.py'), manifestPath], { encoding: 'utf8' });
  process.stdout.write(decoded.stdout);
  process.stderr.write(decoded.stderr);
  assert.equal(decoded.status, 0, 'All rendered and stressed QR variants decode to the exact production URL');
  console.log(`Painted QR browser checks passed: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
