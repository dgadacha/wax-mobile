// Vue entry — bootstraps Pinia, Vant base styles, and mounts <App>.
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// Vant CSS — components themselves are auto-imported by
// unplugin-vue-components + @vant/auto-import-resolver (see vite.config.js).
import 'vant/lib/index.css';

import './styles/mobile.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
