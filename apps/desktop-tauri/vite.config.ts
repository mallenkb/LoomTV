import { defineConfig, mergeConfig, type Plugin } from 'vite-plus';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import electronRenderer from '../desktop/vite.renderer.config';

function rejectNativeImports(): Plugin {
  return {
    name: 'loomtv-tauri-native-import-boundary',
    enforce: 'pre',
    resolveId(id) {
      if (/^(electron(?:\/|$)|node:|koffi$|better-sqlite3$|loom-media-server-headless)/.test(id)) {
        throw new Error(`Native dependency cannot enter the Tauri UI: ${id}`);
      }
    },
  };
}

export default mergeConfig(electronRenderer, defineConfig({
  plugins: [rejectNativeImports(), {
    name: 'loomtv-dev-identity',
    configureServer(server) {
      server.middlewares.use('/__loomtv_dev_identity', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ root: realpathSync(fileURLToPath(new URL('.', import.meta.url))) }));
      });
    },
  }],
  define: { __TAURI_PLATFORM__: JSON.stringify(process.platform) },
  css: { postcss: fileURLToPath(new URL('.', import.meta.url)) },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  server: { host: '127.0.0.1', port: 5197, strictPort: true, watch: { ignored: ['**/target/**', '**/resources/**'] } },
}));
