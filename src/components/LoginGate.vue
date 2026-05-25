<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Loader, WifiOff } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
// Mirror navigator.onLine reactively. When the user lands here with
// no token AND no network, /api/auth/login can't possibly succeed —
// show an "offline" placeholder instead of a form that's guaranteed
// to fail. The boot path in auth.verify() keeps an existing token
// optimistically when offline, so this case only matters on a fresh
// install or after an explicit logout.
const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
function onOnline() { isOnline.value = true; }
function onOffline() { isOnline.value = false; }
onMounted(() => {
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
});
onUnmounted(() => {
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
});

const visible = computed(() => !auth.loggedIn);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(email.value.trim(), password.value);
  } catch (e) {
    error.value = e.message || 'Identifiants incorrects';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <transition name="gate-fade">
    <div v-if="visible" class="login-gate">
      <div class="login-inner">

        <!-- Loading spinner while token is being verified -->
        <template v-if="auth.checking">
          <Loader class="spin" :size="32" color="rgba(255,255,255,0.4)" :stroke-width="1.5" />
        </template>

        <!-- Offline + no token: form can't possibly succeed. Tell the
             user explicitly instead of letting them mash it. -->
        <template v-else-if="!isOnline">
          <div class="login-logo">
            <WifiOff :size="48" color="rgba(255,255,255,0.6)" :stroke-width="1.5" />
          </div>
          <h1 class="login-title">Pas de connexion</h1>
          <p class="login-offline-hint">
            La connexion réseau est requise pour la première ouverture.
            Reconnecte-toi et l'app reprendra automatiquement.
          </p>
        </template>

        <template v-else>
          <div class="login-logo">
            <img src="/logo.png" alt="Wax" class="logo-img" />
          </div>

          <h1 class="login-title">Connexion</h1>

          <form class="login-form" @submit.prevent="submit">
            <input
              v-model="email"
              type="email"
              class="login-input"
              placeholder="Adresse e-mail"
              autocomplete="email"
              :disabled="loading"
            />
            <input
              v-model="password"
              type="password"
              class="login-input"
              placeholder="Mot de passe"
              autocomplete="current-password"
              :disabled="loading"
            />

            <p v-if="error" class="login-error">{{ error }}</p>

            <button
              type="submit"
              class="login-btn"
              :disabled="loading || !email.trim() || !password"
            >
              <Loader v-if="loading" class="spin" :size="16" :stroke-width="2" />
              <span v-else>Connexion</span>
            </button>
          </form>
        </template>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.login-gate {
  position: fixed;
  inset: 0;
  background: linear-gradient(180deg, #0a0c11 0%, #15181f 100%);
  color: #f3f4f6;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top, 0px) + 24px) 20px calc(var(--safe-bottom, 0px) + 24px);
}

.login-inner {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
}

.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-img {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  object-fit: contain;
}

.login-title {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  color: #f3f4f6;
  margin: 0;
  letter-spacing: -0.3px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

.login-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f3f4f6;
  padding: 14px 16px;
  border-radius: 10px;
  font-size: 15px;
  outline: none;
  transition: border-color 0.15s ease;
  box-sizing: border-box;
}
.login-input::placeholder { color: rgba(255, 255, 255, 0.3); }
.login-input:focus { border-color: var(--accent, #7c5cff); }
.login-input:disabled { opacity: 0.5; }

.login-error {
  font-size: 13px;
  color: #f87171;
  margin: 0;
  text-align: center;
}

.login-offline-hint {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.4;
  text-align: center;
  margin: 0;
}

.login-btn {
  width: 100%;
  background: var(--accent, #7c5cff);
  color: #fff;
  border: 0;
  border-radius: 10px;
  padding: 14px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.login-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.login-btn:not(:disabled):active { opacity: 0.8; }

.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.gate-fade-enter-active, .gate-fade-leave-active {
  transition: opacity 220ms ease;
}
.gate-fade-enter-from, .gate-fade-leave-to { opacity: 0; }
</style>
