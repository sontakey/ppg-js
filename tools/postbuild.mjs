// postbuild: copy the IIFE bundle into the demo tree and cache-bust the
// script tags so a deploy is never served a stale bundle from the phone's cache.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('examples/demo/dist', { recursive: true });
copyFileSync('dist/index.global.js', 'examples/demo/dist/ppg.global.js');
const v = `${process.env.npm_package_version || '0'}-${Date.now().toString(36)}`;
for (const f of ['examples/app/index.html', 'examples/demo/index.html']) {
  const s = readFileSync(f, 'utf8').replace(/ppg\.global\.js(\?v=[^"']*)?/g, `ppg.global.js?v=${v}`);
  writeFileSync(f, s);
}
console.log('postbuild: bundle copied, cache-bust', v);
