// Bundles the web UI into web/dist and copies the runtime assets that cannot be bundled.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('web/dist', { recursive: true, force: true }); // no stale chunks from previous builds

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  splitting: true, // heavy, rarely-used features (Mermaid, pdf.js, docx, code languages) become lazy chunks
  format: 'esm',
  minify: true,
  target: 'chrome120',
  outdir: 'web/dist',
  legalComments: 'external',
  loader: { '.md': 'text' }, // bundled notes, e.g. the welcome note
  logLevel: 'warning',
});

cpSync('node_modules/katex/dist/katex.min.css', 'web/dist/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'web/dist/katex/fonts', { recursive: true });
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'web/dist/pdf.worker.min.mjs');
cpSync('node_modules/@fontsource/work-sans/files/work-sans-latin-400-normal.woff2', 'web/dist/fonts/work-sans-latin-400-normal.woff2');
for (const subset of ['latin', 'latin-ext']) {
  cpSync(`node_modules/@fontsource-variable/inter/files/inter-${subset}-wght-normal.woff2`, `web/dist/fonts/inter-${subset}-wght-normal.woff2`);
}
