import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';

export default [
  // ES module build (with CSS extraction)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/ppg-monitor.esm.js',
      format: 'esm',
      sourcemap: true
    },
    plugins: [
      postcss({
        extract: 'ppg-monitor.css',
        minimize: true
      }),
      resolve(),
      commonjs()
    ]
  },

  // UMD build (with CSS bundled)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/ppg-monitor.js',
      format: 'umd',
      name: 'PPGMonitor',
      sourcemap: true
    },
    plugins: [
      postcss({
        inject: true,
        minimize: false
      }),
      resolve(),
      commonjs()
    ]
  },

  // Minified UMD build (with CSS bundled and minified)
  {
    input: 'src/index.js',
    output: {
      file: 'dist/ppg-monitor.min.js',
      format: 'umd',
      name: 'PPGMonitor',
      sourcemap: true
    },
    plugins: [
      postcss({
        inject: true,
        minimize: true
      }),
      resolve(),
      commonjs(),
      terser()
    ]
  }
];
