import { defineConfig, type Plugin } from 'vite-plus';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string };
const srcPath = fileURLToPath(new URL('./src', import.meta.url));
const reactPath = (entry: string) => fileURLToPath(new URL(`../../node_modules/react-dom/node_modules/react/${entry}`, import.meta.url));
const reactDomPath = (entry: string) => fileURLToPath(new URL(`../../node_modules/react-dom/${entry}`, import.meta.url));

const devRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver: ws://*:*",
  "font-src 'self' file: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

const prodRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* http://[::1]:* https: plexserver:",
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
    // hls.js is lazy-loaded as a self-contained playback runtime (~510 kB
    // minified); keep the budget tight enough to catch growth elsewhere.
    chunkSizeWarningLimit: 525,
    emptyOutDir: false,
    outDir: '.vite/renderer/main_window',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/hls.js/')) return 'media-runtime';
          if (id.includes('/motion/')) return 'motion';
          if (id.includes('/lucide-react/')) return 'icons';
          if (/\/react(?:-dom|-router|-router-dom)?\//.test(id)) return 'react-runtime';
          return 'vendor';
        },
      },
    },
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    host: '0.0.0.0',
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
    alias: [
      { find: '@', replacement: srcPath },
      { find: /^react$/, replacement: reactPath('index.js') },
      { find: /^react\/jsx-runtime$/, replacement: reactPath('jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: reactPath('jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: reactDomPath('index.js') },
      { find: /^react-dom\/client$/, replacement: reactDomPath('client.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
});
