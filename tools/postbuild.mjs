// postbuild: copy the browser bundle into the demo tree. Cache-busting of
// the demo's <script> tags happens at deploy time (tools/stamp-examples.mjs,
// run by `npm run build:site`) so a plain `npm run build` never rewrites
// tracked HTML.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('examples/demo/dist', { recursive: true });
copyFileSync('dist/index.global.js', 'examples/demo/dist/ppg.global.js');
console.log('postbuild: bundle copied to examples/demo/dist/ppg.global.js');
