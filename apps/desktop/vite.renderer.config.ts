import { defineConfig, type Plugin } from 'vite-plus';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { z } from 'zod';

const packageJsonPayload: unknown = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const packageJson = z.object({ version: z.string().optional() }).parse(packageJsonPayload);
const srcPath = fileURLToPath(new URL('./src', import.meta.url));
const reactPath = (entry: string) => fileURLToPath(new URL(`../../node_modules/react-dom/node_modules/react/${entry}`, import.meta.url));
const reactDomPath = (entry: string) => fileURLToPath(new URL(`../../node_modules/react-dom/${entry}`, import.meta.url));
const requestedRendererPort = Number.parseInt(process.env.LOOMTV_RENDERER_PORT || '', 10);
const rendererPort = Number.isInteger(requestedRendererPort) && requestedRendererPort > 0 && requestedRendererPort <= 65_535
  ? requestedRendererPort
  : 5187;

const devRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver: ws://*:*",
  "font-src 'self' file: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://www.vidking.net",
].join('; ');

const prodRendererCsp = [
  "default-src 'self' file: data: blob:",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver:",
  "media-src 'self' file: blob: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver:",
  "connect-src 'self' file: http://127.0.0.1:* http://localhost:* https: loomtv: plexserver:",
  "font-src 'self' file: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://www.vidking.net",
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
    // Use the same explicit loopback family for both the listener and the URL
    // Forge injects into Electron. On macOS, `localhost` can resolve to ::1
    // while Vite is listening on IPv4, allowing an unrelated IPv6 dev server
    // on the same port to appear inside LoomTV.
    host: '127.0.0.1',
    port: rendererPort,
    // Forge injects this exact address into the Electron main process. Never
    // move to another port silently, because another app may own the original
    // address and would then appear inside LoomTV.
    strictPort: true,
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
