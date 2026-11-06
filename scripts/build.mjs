import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
await build({
  entryPoints: ['src/glyph-metrics.js'],
  bundle: true,
  format: 'iife',
  globalName: 'ADHDGlyphMetrics',
  target: 'firefox115',
  outfile: 'addon/glyph-metrics.js',
  minify: true,
});
console.log('Built addon/glyph-metrics.js');
