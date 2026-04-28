import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Build a single-file index.html (CSS + JS all inlined) to web/dist/, then
// copy it back up to the repo root so GitHub Pages keeps serving the same
// path it always has. Source 文件 stays inside web/ — Vite never overwrites it.
//
// closeBundle is the cleanest hook for this: runs once after the bundle is
// fully written, only during `vite build` (not dev). `apply: 'build'`
// keeps the plugin out of the dev pipeline entirely.
export default defineConfig({
  plugins: [
    viteSingleFile(),
    {
      name: 'deploy-to-repo-root',
      apply: 'build',
      closeBundle() {
        const root = process.cwd();
        const src = resolve(root, 'dist/index.html');
        const dst = resolve(root, '../index.html');
        copyFileSync(src, dst);
        // eslint-disable-next-line no-console
        console.log(`[deploy] ${src.replace(root + '/', '')} → ${dst.replace(root + '/', '')}`);
      },
    },
  ],
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
