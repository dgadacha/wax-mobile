<script setup>
// Auth gate — Spotify's onboarding look in two steps:
//   1. "Start" hero: logo + tagline + green pill CTA.
//   2. Credentials form: centered "Connexion" top bar with back chevron,
//      bold field labels above solid gray inputs, white pill submit.
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { Loader, WifiOff, ChevronLeft } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const step = ref('start'); // 'start' | 'form'
const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

// Mirror navigator.onLine reactively — a fresh install with no network
// can't possibly log in, show the offline notice instead of the form.
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
// Reset to the start screen whenever the gate re-appears (logout,
// token expiry) so the user always lands on the hero.
watch(visible, (v) => {
  if (v) { step.value = 'start'; error.value = ''; password.value = ''; }
});

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

      <!-- Loading spinner while the stored token is being verified -->
      <div v-if="auth.checking" class="login-center">
        <Loader class="spin" :size="32" color="rgba(255,255,255,0.4)" :stroke-width="1.5" />
      </div>

      <!-- Offline + no token: the form can't succeed, say it plainly. -->
      <div v-else-if="!isOnline" class="login-center">
        <WifiOff :size="48" color="rgba(255,255,255,0.6)" :stroke-width="1.5" />
        <h1 class="start-title small">Pas de connexion</h1>
        <p class="login-offline-hint">
          La connexion réseau est requise pour la première ouverture.
          Reconnecte-toi et l'app reprendra automatiquement.
        </p>
      </div>

      <!-- Step 1 — Start hero -->
      <div v-else-if="step === 'start'" class="login-start">
        <div class="start-art" aria-hidden="true">
          <div class="start-glow" />
        </div>
        <div class="start-body">
          <img src="/logo.png" alt="Wax" class="start-logo" />
          <h1 class="start-title">Toute ta musique.<br />Sur Wax.</h1>
          <button class="pill pill-accent" @click="step = 'form'">Se connecter</button>
        </div>
      </div>

      <!-- Step 2 — credentials form -->
      <div v-else class="login-form-screen">
        <header class="form-topbar">
          <button class="form-back" aria-label="Retour" @click="step = 'start'">
            <ChevronLeft :size="26" :stroke-width="2.4" color="#fff" />
          </button>
          <div class="form-topbar-title">Connexion</div>
          <span class="form-topbar-spacer" />
        </header>

        <form class="login-form" @submit.prevent="submit">
          <label class="field-label" for="login-email">Ton e-mail ?</label>
          <input
            id="login-email"
            v-model="email"
            type="email"
            class="login-input"
            autocomplete="email"
            :disabled="loading"
          />

          <label class="field-label" for="login-password">Ton mot de passe ?</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            class="login-input"
            autocomplete="current-password"
            :disabled="loading"
          />

          <p v-if="error" class="login-error">{{ error }}</p>

          <div class="form-submit-row">
            <button
              type="submit"
              class="pill pill-light"
              :disabled="loading || !email.trim() || !password"
            >
              <Loader v-if="loading" class="spin" :size="16" :stroke-width="2" />
              <span v-else>Se connecter</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.login-gate {
  position: fixed;
  inset: 0;
  background: #0b0b0b;
  color: #fff;
  z-index: 200;
  display: flex;
  flex-direction: column;
}

.login-center {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 24px;
  text-align: center;
}

/* ── Step 1 : Start ───────────────────────────────────────────── */
.login-start {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}
.start-art {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
}
.start-glow {
  position: absolute;
  inset: -30%;
  background:
    radial-gradient(45% 38% at 28% 36%, rgba(30, 215, 96, 0.28) 0%, transparent 100%),
    radial-gradient(50% 42% at 75% 25%, rgba(125, 90, 255, 0.22) 0%, transparent 100%),
    radial-gradient(55% 45% at 55% 70%, rgba(255, 94, 138, 0.16) 0%, transparent 100%);
  filter: blur(20px);
}
.start-art::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 30%, #0b0b0b 100%);
}
.start-body {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding: 0 28px calc(var(--safe-bottom, 0px) + 48px);
}
.start-logo {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  object-fit: contain;
}
.start-title {
  font: 800 28px/1.25 var(--font-display);
  letter-spacing: -0.5px;
  text-align: center;
  margin: 0;
  color: #fff;
}
.start-title.small { font-size: 22px; }

.pill {
  width: 100%;
  max-width: 340px;
  border: 0;
  border-radius: 999px;
  padding: 15px 24px;
  font: 700 16px/1.2 var(--font-display);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: transform 0.12s ease, opacity 0.12s ease;
}
.pill:active { transform: scale(0.97); }
.pill:disabled { opacity: 0.4; cursor: not-allowed; }
.pill-accent { background: var(--accent, #1ED760); color: #0b0b0b; }
.pill-light { background: #ffffff; color: #0b0b0b; }

/* ── Step 2 : Form ────────────────────────────────────────────── */
.login-form-screen {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding-top: var(--safe-top, 0px);
}
.form-topbar {
  display: flex;
  align-items: center;
  padding: 8px 8px 18px;
}
.form-back {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.form-back:active { background: rgba(255, 255, 255, 0.1); }
.form-topbar-title {
  flex: 1 1 auto;
  text-align: center;
  font: 700 17px/1.2 var(--font-display);
  color: #fff;
}
.form-topbar-spacer { width: 44px; flex: 0 0 auto; }

.login-form {
  display: flex;
  flex-direction: column;
  padding: 0 24px;
}
.field-label {
  font: 800 22px/1.2 var(--font-display);
  letter-spacing: -0.4px;
  color: #fff;
  margin: 14px 0 10px;
}
.login-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.22);
  border: 0;
  color: #fff;
  padding: 14px 16px;
  border-radius: 6px;
  font: 600 16px/1.3 var(--font-body);
  outline: none;
  transition: background 0.15s ease;
  box-sizing: border-box;
}
.login-input:focus { background: rgba(255, 255, 255, 0.3); }
.login-input:disabled { opacity: 0.5; }

.login-error {
  font-size: 13px;
  color: #f87171;
  margin: 14px 0 0;
  text-align: center;
}

.form-submit-row {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}
.form-submit-row .pill { max-width: 220px; }

.login-offline-hint {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.4;
  text-align: center;
  margin: 0;
  max-width: 300px;
}

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
