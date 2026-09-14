// Deploy-time cache-bust: append ?v=<version>-<build> to every local
// script/stylesheet reference in the example pages, so the CDN can serve
// them immutable while a new deploy is still picked up immediately.
import { readFileSync, writeFileSync } from 'node:fs';
const v = `${process.env.npm_package_version || '0'}-${Date.now().toString(36)}`;
const pages = ['examples/app/index.html', 'examples/demo/index.html', 'examples/basic/index.html', 'examples/headless/index.html'];
for (const f of pages) {
  let s;
  try { s = readFileSync(f, 'utf8'); } catch { continue; }
  const out = s.replace(/((?:src|href)=["'])((?!https?:|\/\/)[^"']+?\.(?:js|css))(\?v=[^"']*)?(["'])/g, `$1$2?v=${v}$4`);
  writeFileSync(f, out);
}
console.log('stamp-examples: cache-bust', v);
