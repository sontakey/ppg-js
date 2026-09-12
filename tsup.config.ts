import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs', 'iife'],
    globalName: 'PPG',
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    outDir: 'dist',
    // fft.js is no longer a dependency (own radix-2 FFT); no other runtime deps.
    treeshake: true
  },
  {
    entry: { index: 'src/hrv/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    minify: true,
    outDir: 'dist/hrv',
    treeshake: true
  }
]);
