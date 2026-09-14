import { defineConfig } from 'tsup';

const define = { __PPG_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0') };

export default defineConfig([
  {
    entry: { index: 'src/index.ts', dsp: 'src/dsp/index.ts', hrv: 'src/hrv/index.ts', sources: 'src/sources/index.ts', engine: 'src/engine.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    outDir: 'dist',
    treeshake: true,
    define
  },
  {
    // Browser global build: window.PPG (default export flattened onto the namespace).
    entry: { index: 'src/index.ts' },
    format: ['iife'],
    globalName: 'PPG',
    sourcemap: true,
    minify: true,
    outDir: 'dist',
    outExtension: () => ({ js: '.global.js' }),
    treeshake: true,
    define
  }
]);
