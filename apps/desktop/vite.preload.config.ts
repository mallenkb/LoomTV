import { defineConfig } from 'vite-plus';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: '.vite/build',
    lib: {
      entry: 'src/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
