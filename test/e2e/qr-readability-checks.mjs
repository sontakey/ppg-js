// Sample the real pigment background beneath each character's DOM bounds.
// The text is hidden only after geometry and computed colors are recorded;
// screenshot pixels therefore measure the backdrop rather than antialiasing.
// Also verifies that a fresh phone context never downloads the desktop wash.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const url = process.env.PPG_QR_URL || 'http://127.0.0.1:8088/ppg-js-demo';
const output = path.resolve(process.env.PPG_QR_OUTPUT || '.dream-loop/painted-qr-readability');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
const manifest = { url, captures: [], phone: null };
try {
  for (const width of [320, 634, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#phone-qr').evaluate(image => image.decode());
    // Finish the same static background decode before sampling it.
    await page.evaluate(async () => {
      const css = getComputedStyle(document.querySelector('.phone-panel'), '::before').backgroundImage;
      const image = new Image(); image.src = css.slice(5, -2); await image.decode();
    });
    const text = await page.evaluate(() => {
      const selectors = ['.phone-panel-kicker', '#phone-panel-title', '.phone-panel-copy > p:not(.phone-panel-kicker)',
        '.phone-panel-code figcaption', '.phone-panel-link', '.phone-panel-disclaimer'];
      return selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(el => {
        const style = getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize);
        const required = fontSize >= 24 || (fontSize >= 18.66 && parseFloat(style.fontWeight) >= 700) ? 3 : 4.5;
        const rects = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (let i = 0; i < node.textContent.length; i++) {
            if (!node.textContent[i].trim()) continue;
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
            for (const r of range.getClientRects()) rects.push({ x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height });
          }
        }
        const entry = { selector, text: el.textContent.trim(), color: style.color, fontSize, required, rects };
        el.style.setProperty('color', 'transparent', 'important');
        el.style.setProperty('text-shadow', 'none', 'important');
        el.style.setProperty('text-decoration-color', 'transparent', 'important');
        return entry;
      }));
    });
    const screenshot = path.join(output, `background-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    manifest.captures.push({ width, screenshot, text });
    await page.close();
  }
  const phone = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
  const page = await phone.newPage();
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(750);
  const state = await page.evaluate(() => ({
    phonePanelHidden: document.getElementById('desktop-phone-panel').hidden,
    startVisible: !document.getElementById('btn-start').hidden,
  }));
  manifest.phone = { ...state, washRequests: requests.filter(request => /phone-wash\./.test(request)), qrRequests: requests.filter(request => /phone-qr\.svg/.test(request)) };
  assert.equal(state.phonePanelHidden, true);
  assert.equal(state.startVisible, true);
  assert.deepEqual(manifest.phone.washRequests, [], 'Phone does not fetch the desktop-only wash');
  await phone.close();
  const manifestPath = path.join(output, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const sampled = spawnSync(process.env.PPG_PYTHON || 'python3', ['test/e2e/sample-qr-contrast.py', manifestPath], { encoding: 'utf8' });
  process.stdout.write(sampled.stdout); process.stderr.write(sampled.stderr);
  assert.equal(sampled.status, 0, 'Painted QR text meets WCAG AA contrast over its actual background');
  console.log(`QR readability and phone network checks passed: ${output}`);
} finally {
  await browser.close();
}
