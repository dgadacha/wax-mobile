import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { VantResolver } from '@vant/auto-import-resolver';
import { fileURLToPath, URL } from 'node:url';

// Mobile build (Capacitor) loads from file:// in the WebView, so base must be
// relative. For web dev (npm run dev) the relative base also works.
//
// API base URL strategy:
//   - dev: VITE_API_BASE_URL is empty → relative URLs hit the dev proxy below
//   - prod Capacitor: VITE_API_BASE_URL=https://wax-api.example → absolute URLs
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devProxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [
      vue(),
      Components({ resolvers: [VantResolver()] }),
    ],
    base: './',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      host: true,
      proxy: {
        '/api': { target: devProxyTarget, changeOrigin: true },
        '/audio': devProxyTarget,
        '/preview-files': devProxyTarget,
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2020',
    },
  };
});
