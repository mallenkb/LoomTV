import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: '.vite/renderer/main_window',
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    watch: {
      ignored: ['**/dist/**', '**/out/**', '**/.vite/**'],
    },
  },
  define: {
    'global': 'globalThis',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
