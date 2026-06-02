// Vue entry — bootstraps Pinia, Vant base styles, and mounts <App>.
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// Vant CSS — components themselves are auto-imported by
// unplugin-vue-components + @vant/auto-import-resolver (see vite.config.js).
import 'vant/lib/index.css';

import './styles/mobile.css';

const app = createApp(App);

// Global error handler. Without it, a Vue render error during boot
// would unmount the tree and leave the user staring at a blank page
// with no console hint of why. Logging at least surfaces the cause
// in remote-debugging sessions, and we swallow the error so the rest
// of the app keeps painting.
app.config.errorHandler = (err, instance, info) => {
  console.error('[Vue]', info, err);
};

// Last-resort window-level handler for non-Vue async errors that
// would otherwise pop a browser dialog or get silently swallowed.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    console.error('[window:error]', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason);
  });
}

app.use(createPinia());
app.mount('#app');
