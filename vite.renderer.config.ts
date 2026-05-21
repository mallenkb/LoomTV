import { defineConfig, type Plugin } from 'vite-plus';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };

const devRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http: https: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* http://[::1]:* http://*:* https: plexserver: ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
  "font-src 'self' file: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

const prodRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http: https: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* http://[::1]:* http://*:* https: plexserver:",
  "font-src 'self' file: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

function rendererCspPlugin(): Plugin {
  return {
    name: 'loomtv-renderer-csp',
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? devRendererCsp : prodRendererCsp;
      return html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/,
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  base: './',
  plugins: [rendererCspPlugin(), react()],
  build: {
    emptyOutDir: false,
    outDir: '.vite/renderer/main_window',
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    port: 5174,
    strictPort: false,
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
