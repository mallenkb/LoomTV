import { defineConfig } from 'vite-plus';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: '.vite/build',
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      // Match Forge 8's preload output in development and packaged builds.
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
