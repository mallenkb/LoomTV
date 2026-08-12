import { defineConfig } from 'vite-plus';

export default defineConfig({
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
});
