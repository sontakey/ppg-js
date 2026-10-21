// Freeze the seeded authoring SVG to a cached 750px WebP background. The SVG
// filter never reaches production; Chromium is a development dependency only.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, '.dream-loop/phone-wash-source.svg'), 'utf8');
const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
try {
  const page = await browser.newPage();
  const encoded = await page.evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 750; canvas.height = 850;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', .84).split(',')[1];
  }, source);
  const target = path.join(root, 'examples/app/assets/phone-wash.webp');
  const bytes = Buffer.from(encoded, 'base64');
  writeFileSync(target, bytes);
  console.log(`Wrote ${target} (${bytes.length} bytes)`);
} finally {
  await browser.close();
}
