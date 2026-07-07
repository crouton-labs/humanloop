import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Builds the browser-surface SPA into ../dist/web (sibling to the tsc output
// at ../dist/**), which src/browser/server.ts serves as static assets. Kept
// as its own Vite project (not under humanloop's `src/`, which is tsc's
// rootDir) so the two build outputs never collide in the same dist subtree.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
