import { defineConfig } from 'vite-plus';

export default defineConfig(({ mode }) => ({
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
        entryFileNames: 'main.js',
      },
    },
  },
}));
