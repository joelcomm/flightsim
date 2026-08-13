import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained docs/index.html, three.js inlined. Same reasoning as the project
// this engine came from: it makes deployment "copy one file", and the artifact opens
// from file:// with no server at all.
//
// The build stamp is compiled in and shown in the HUD. Browsers hang on to a page like
// this harder than you expect, and without a stamp there is no way to tell a stale tab
// from a fresh one by looking at it.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD_STAMP) },
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100000000,   // inline everything
    chunkSizeWarningLimit: 4000,
  },
  plugins: [viteSingleFile()],
});
