import { defineConfig } from 'vite-plus';
import fs from 'node:fs';

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'loomtv-main-entry',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'main.js',
        source: fs.readFileSync(new URL('./src/mainEntry.cjs', import.meta.url), 'utf8'),
      });
    },
  }],
  // Electron Forge supplies these globals while running its development
  // server. A standalone production build must load the bundled renderer,
  // never an unrelated site that happens to own the development port.
  define: mode === 'production'
    ? {
        MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
        MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      }
    : {},
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    emptyOutDir: false,
    outDir: '.vite/build',
    rollupOptions: {
      external: [
        'electron',
        'electron-squirrel-startup',
        'better-sqlite3',
        'electron-updater',
        'koffi',
      ],
      output: {
        format: 'cjs',
        entryFileNames: 'main-bundle.js',
      },
    },
  },
}));
