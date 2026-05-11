import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };

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
    '__APP_VERSION__': JSON.stringify(packageJson.version || 'dev'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
