import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { VantResolver } from '@vant/auto-import-resolver';
import { VitePWA } from 'vite-plugin-pwa';
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
      // PWA: generates manifest.webmanifest + service worker, so users can
      // "Add to Home Screen" on Safari iOS / Chrome Android and get an app
      // shell that boots offline. Doesn't change Capacitor behaviour —
      // Capacitor uses its own webview and ignores the SW.
      VitePWA({
        registerType: 'autoUpdate',
        // injectRegister:'auto' wires the SW registration via a tiny inline
        // script; no manual main.js change required.
        injectRegister: 'auto',
        // Inject the manifest + SW in dev so "Add to home screen" works
        // when we test against `npm run dev` too — not just after build.
        devOptions: { enabled: true },
        manifest: {
          name: 'Wax',
          short_name: 'Wax',
          description: 'YouTube → MP3 mobile player',
          theme_color: '#0d0f14',
          background_color: '#0d0f14',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          scope: './',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        workbox: {
          // Cache the app shell (HTML/CSS/JS/icons). Backend calls
          // (/api/*, /audio/*) are NEVER cached — they're per-profile,
          // per-request, and audio streams expire.
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          // Vant's bundled CSS is ~250kB; raise the per-asset cap so the
          // app shell precaches in one go.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          // Relative path so it works on GitHub Pages subpath hosting
          // (e.g. https://dgadacha.github.io/wax-mobile/) AND on root
          // domains. Absolute '/index.html' would resolve to the wrong
          // path on subpath deployments.
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/\/api\//, /\/audio\//, /\/preview-files\//],
          // /audio/* uses range requests for seeking; the matching
          // runtimeCaching rule below requires this Workbox flag to
          // route Range responses through the cache properly.
          // (`runtimeCaching[].options.rangeRequests` enables the
          // plugin per-rule.)
          runtimeCaching: [
            {
              // Image covers from /api/cover/ — stale-while-revalidate
              // so the offline-cached copy shows instantly while a fresh
              // fetch updates the cache in the background.
              urlPattern: /\/api\/cover\//,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'wax-covers',
                expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              // Downloaded MP3s from /audio/*.mp3. CacheFirst so once a
              // track is downloaded + played once, it plays offline
              // forever (no network round-trip). RangeRequests plugin
              // is critical: <audio> elements use HTTP Range to seek
              // and stream — without it, range requests bypass the
              // cache and seeking on offline tracks fails.
              urlPattern: /\/audio\/[^/]+\.mp3$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'wax-audio',
                rangeRequests: true,
                cacheableResponse: { statuses: [0, 200, 206] },
                expiration: {
                  maxEntries: 500,
                  // 1 year — the SW is the user's local download manager;
                  // tracks evict only when the user hits 500+ or the
                  // browser reclaims storage under pressure.
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                  purgeOnQuotaError: true,
                },
                matchOptions: { ignoreSearch: true },
              },
            },
          ],
        },
      }),
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
