<script setup>
// First-launch onboarding — three full-screen panels that explain
// the three things a new user needs to know to use Wax:
//   1. What Wax is (YouTube → your offline library)
//   2. Multi-profile + auth (private listening per person)
//   3. Offline downloads + Wi-Fi-only toggle (the headline feature)
//
// Dismissal: tap "Commencer" on the last panel OR the "Passer"
// link top-right. Both set localStorage['wax:onboarding-done'].
// App.vue checks this on mount and only renders this component
// when the flag is missing.
//
// The Settings → "Revoir l'introduction" entry re-opens this by
// emitting `reset` to the parent, which clears the flag + re-mounts.
import { ref, computed } from 'vue';
import {
  ChevronRight, Music, Users, Download,
} from 'lucide-vue-next';
import { haptics } from '@/lib/haptics';
import { useGestures } from '@/composables/useGestures';

const props = defineProps({
  // True when the user re-opens from Settings — same UI but the
  // "Commencer" button reads "Fermer" because they've already
  // onboarded.
  rerun: { type: Boolean, default: false },
});

const emit = defineEmits(['done']);

const PANELS = [
  {
    icon: Music,
    title: 'Ta musique, à toi',
    body: 'Cherche n\'importe quel titre YouTube, ajoute-le à tes favoris, ou compose des playlists comme tu veux. Wax extrait l\'audio et te le sert sans pub, sans algorithme.',
  },
  {
    icon: Users,
    title: 'Plusieurs profils',
    body: 'Chacun ses favoris, ses playlists, son historique. Choisis « Qui écoute ? » au démarrage. Idéal pour la famille ou si tu partages avec un proche.',
  },
  {
    icon: Download,
    title: 'Hors-ligne partout',
    body: 'Télécharge tes titres préférés pour les écouter sans connexion : avion, métro, plage. Active « Wi-Fi uniquement » dans les réglages pour préserver tes data.',
  },
];

const step = ref(0);
const isLast = computed(() => step.value === PANELS.length - 1);
const ctaLabel = computed(() => {
  if (isLast.value) return props.rerun ? 'Fermer' : 'Commencer';
  return 'Suivant';
});

function next() {
  haptics.light();
  if (isLast.value) finish();
  else step.value += 1;
}
function skip() {
  haptics.light();
  finish();
}
function finish() {
  try { localStorage.setItem('wax:onboarding-done', '1'); } catch {}
  emit('done');
}

// Swipe between panels — same useGestures composable powering the
// player's coverflow. Right swipe = previous, left = next.
const overlayRef = ref(null);
useGestures(overlayRef, {
  onSwipeLeft: () => { if (!isLast.value) { haptics.light(); step.value += 1; } },
  onSwipeRight: () => { if (step.value > 0) { haptics.light(); step.value -= 1; } },
});
</script>

<template>
  <div ref="overlayRef" class="onb">
    <button v-if="!isLast" class="onb-skip" @click="skip">Passer</button>

    <div class="onb-panels" :style="{ transform: `translateX(-${step * 100}%)` }">
      <section v-for="(p, i) in PANELS" :key="i" class="onb-panel">
        <div class="onb-icon">
          <component :is="p.icon" :size="56" :stroke-width="1.6" color="var(--accent)" />
        </div>
        <h1 class="onb-title">{{ p.title }}</h1>
        <p class="onb-body">{{ p.body }}</p>
      </section>
    </div>

    <div class="onb-dots">
      <span
        v-for="(_, i) in PANELS"
        :key="i"
        class="onb-dot"
        :class="{ active: step === i }"
      />
    </div>

    <button class="onb-cta" @click="next">
      <span>{{ ctaLabel }}</span>
      <ChevronRight v-if="!isLast" :size="18" :stroke-width="2.4" />
    </button>
  </div>
</template>

<style scoped>
.onb {
  position: fixed;
  inset: 0;
  z-index: 250;
  background: linear-gradient(180deg, #0a0c11 0%, #15181f 70%, #0a0c11 100%);
  color: #f3f4f6;
  display: flex;
  flex-direction: column;
  padding: calc(var(--safe-top, 0px) + 24px) 0 calc(var(--safe-bottom, 0px) + 24px);
  overflow: hidden;
  /* Block the rest of the app from receiving touches while the
   * overlay is up. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.onb-skip {
  position: absolute;
  top: calc(var(--safe-top, 0px) + 24px);
  right: 20px;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  padding: 8px 12px;
  cursor: pointer;
  z-index: 2;
}
.onb-skip:active { color: rgba(255, 255, 255, 0.8); }

/* Panel strip — three full-width panels laid out horizontally,
 * translated by step. CSS transition handles the smooth slide. */
.onb-panels {
  display: flex;
  width: 300%;
  flex: 1 1 auto;
  transition: transform var(--motion-mid, 220ms) var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.onb-panel {
  flex: 0 0 33.3333%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 32px;
  text-align: center;
}
.onb-icon {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: rgba(124, 92, 255, 0.12);
  display: grid;
  place-items: center;
  margin-bottom: 24px;
}
.onb-title {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  margin: 0 0 14px;
  letter-spacing: -0.3px;
  line-height: 1.2;
}
.onb-body {
  font-size: 15px;
  color: rgba(255, 255, 255, 0.65);
  line-height: 1.55;
  max-width: 32ch;
  margin: 0;
}

.onb-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 24px;
}
.onb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  transition: background var(--motion-short, 120ms) var(--ease, cubic-bezier(0.4, 0, 0.2, 1)),
              transform var(--motion-short, 120ms) var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.onb-dot.active {
  background: var(--accent);
  transform: scaleX(2.2);
  border-radius: 4px;
}

.onb-cta {
  margin: 0 32px;
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--bg);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: opacity var(--motion-short, 120ms) var(--ease, cubic-bezier(0.4, 0, 0.2, 1));
}
.onb-cta:active { opacity: 0.85; }
</style>
