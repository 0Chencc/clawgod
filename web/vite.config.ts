import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Build a single-file index.html (CSS + JS all inlined) and write it directly
// back to the repo root so GitHub Pages keeps serving the same path it
// always has. Dev mode is independent (vite serves from this dir).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: '../',
    emptyOutDir: false,
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
