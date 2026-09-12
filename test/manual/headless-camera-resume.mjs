// Headless Playwright check: app loads, Start, drop the camera via
// visibilitychange + track.stop() (simulating iOS backgrounding), assert a
// camera_resumed event lands in the debug log and there are 0 console
// errors. Not part of npm test (needs a real Chromium + fake camera
// flags) - run manually per test/camera-resume.test.js job 3.
import { chromium } from '/Users/anton/Projects/pulse-atlas/node_modules/playwright/index.mjs';

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto('http://localhost:8099/examples/app/index.html');
await page.waitForSelector('#btn-start');
await page.click('#btn-start');

// Wait for the monitor to actually acquire the stream.
await page.waitForFunction(() => window.monitor && window.monitor.stream, { timeout: 10000 });

// Simulate iOS backgrounding: end the live track, then fire visibilitychange.
await page.evaluate(() => {
  window.monitor.stream.getVideoTracks()[0].stop();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

await page.waitForFunction(() => {
  const log = window.monitor && window.monitor.getDebugLog && window.monitor.getDebugLog();
  return log && log.events.some((e) => e.type === 'camera_resumed');
}, { timeout: 10000 });

const log = await page.evaluate(() => window.monitor.getDebugLog());
const resumed = log.events.find((e) => e.type === 'camera_resumed');
console.log('camera_resumed event:', JSON.stringify(resumed));
console.log('console errors:', consoleErrors.length, consoleErrors);

await browser.close();

if (!resumed || resumed.ok !== true) { console.error('FAIL: camera_resumed missing or ok!==true'); process.exit(1); }
if (consoleErrors.length !== 0) { console.error('FAIL: console errors present'); process.exit(1); }
console.log('PASS: headless camera-resume check');
