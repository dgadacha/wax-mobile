<script setup>
// AI playlist generator — describe a vibe, Claude Haiku composes a
// tracklist, the server resolves each title on YouTube and builds the
// playlist. Singleton overlay driven by view.aiOpen (mounted in App.vue).
import { ref, computed, watch, nextTick } from 'vue';
import { Sparkles, X } from 'lucide-vue-next';
import { useViewStore } from '@/stores/view';
import { usePlaylistsStore } from '@/stores/playlists';
import { useLibraryStore } from '@/stores/library';
import { runAiJob } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { haptics } from '@/lib/haptics';

const view = useViewStore();
const playlists = usePlaylistsStore();
const lib = useLibraryStore();

const prompt = ref('');
const mode = ref('discover'); // 'discover' = nouveaux titres (YouTube) | 'library' = pioche dans la biblio
const loading = ref(false);
const error = ref('');
const inputRef = ref(null);
const progress = ref({ done: 0, total: 0 });
const pct = computed(() =>
  progress.value.total ? Math.round((progress.value.done / progress.value.total) * 100) : 0,
);

const EXAMPLES = [
  'road trip années 2000',
  'concentration / deep work',
  'soirée chill entre potes',
  'rap FR motivation',
  'R&B 90s',
  'été, terrasse, cocktails',
];

watch(
  () => view.aiOpen,
  (open) => {
    if (!open) return;
    prompt.value = '';
    mode.value = 'discover';
    error.value = '';
    loading.value = false;
    nextTick(() => inputRef.value?.focus());
  },
);

function pickExample(e) {
  haptics.light();
  prompt.value = e;
  nextTick(() => inputRef.value?.focus());
}

function close() {
  if (loading.value) return;
  view.closeAi();
}

async function generate() {
  const p = prompt.value.trim();
  if (!p || loading.value) return;
  haptics.medium();
  loading.value = true;
  error.value = '';
  progress.value = { done: 0, total: 0 };
  let result;
  try {
    if (mode.value === 'library') {
      // Pick from existing library tracks — one Claude call, no YouTube
      // resolution, so it's quick (the store refetches playlists itself).
      const r = await playlists.generateFromLibrary(p);
      result = { playlist: r.playlist, count: r.count };
    } else {
      const r = await runAiJob('/api/ai/playlist', { prompt: p }, (ev) => {
        if (ev.type === 'total') progress.value = { done: 0, total: ev.total };
        else if (ev.type === 'progress') progress.value = { done: ev.done, total: ev.total };
      });
      await Promise.all([playlists.fetch(), lib.fetch()]);
      result = { playlist: r.playlist, count: r.resolved };
    }
  } catch (e) {
    error.value = e.message || 'Échec de la génération';
    loading.value = false;
    return;
  }
  view.closeAi();
  showToast(`Playlist « ${result.playlist.name} » créée · ${result.count} titres`);
  view.switchTo('playlist', result.playlist.id);
  loading.value = false;
}
</script>

<template>
  <Transition name="ai-fade">
    <div v-if="view.aiOpen" class="ai-overlay" @click.self="close">
      <div class="ai-card">
        <button v-if="!loading" class="ai-close" aria-label="Fermer" @click="close">
          <X :size="22" :stroke-width="2" color="var(--text)" />
        </button>

        <!-- Loading state -->
        <div v-if="loading" class="ai-loading">
          <div class="ai-orb"><Sparkles :size="34" :stroke-width="1.8" color="var(--on-accent)" /></div>
          <template v-if="!progress.total">
            <h2>{{ mode === 'library' ? 'Sélection en cours…' : 'Génération en cours…' }}</h2>
            <p>{{ mode === 'library' ? 'Claude pioche dans ta bibliothèque…' : 'Claude compose ta playlist…' }}</p>
          </template>
          <template v-else>
            <h2>Recherche des titres…</h2>
            <div class="ai-bar"><div class="ai-bar-fill" :style="{ width: pct + '%' }"></div></div>
            <div class="ai-count">{{ progress.done }} / {{ progress.total }} titres trouvés</div>
          </template>
        </div>

        <!-- Prompt state -->
        <template v-else>
          <div class="ai-head">
            <div class="ai-badge"><Sparkles :size="20" :stroke-width="2" color="var(--on-accent)" /></div>
            <h2>Playlist IA</h2>
            <p>Décris une ambiance, un mood, une occasion — Claude s'occupe du reste.</p>
          </div>

          <div class="ai-modes">
            <button class="ai-mode" :class="{ active: mode === 'discover' }" @click="mode = 'discover'">Découvrir</button>
            <button class="ai-mode" :class="{ active: mode === 'library' }" @click="mode = 'library'">Ma bibliothèque</button>
          </div>

          <textarea
            ref="inputRef"
            v-model="prompt"
            class="ai-input"
            rows="3"
            maxlength="500"
            :placeholder="mode === 'library'
              ? 'ex : un truc calme pour bosser, parmi ce que j’ai déjà…'
              : 'ex : une playlist pour coder tard le soir, électro douce et instrumentale…'"
            @keydown.meta.enter="generate"
            @keydown.ctrl.enter="generate"
          />

          <div class="ai-examples">
            <button v-for="e in EXAMPLES" :key="e" class="ai-chip" @click="pickExample(e)">{{ e }}</button>
          </div>

          <div v-if="error" class="ai-error">{{ error }}</div>

          <button class="ai-go" :disabled="!prompt.trim()" @click="generate">
            <Sparkles :size="18" :stroke-width="2.4" color="var(--on-accent)" />
            Générer la playlist
          </button>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ai-overlay {
  position: fixed;
  inset: 0;
  z-index: 150;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: calc(var(--safe-top) + var(--sp-8)) var(--sp-4) var(--sp-4);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.ai-card {
  position: relative;
  width: 100%;
  max-width: 440px;
  background: var(--bg-elev);
  border-radius: var(--r-4);
  padding: var(--sp-6) var(--sp-5) var(--sp-5);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}
.ai-close {
  position: absolute;
  top: var(--sp-3);
  right: var(--sp-3);
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--card);
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.ai-head { text-align: center; margin-bottom: var(--sp-5); }
.ai-badge,
.ai-orb {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--accent);
  display: grid;
  place-items: center;
  margin: 0 auto var(--sp-3);
}
.ai-head h2 {
  font: 800 22px/1.15 var(--font-display);
  letter-spacing: -0.4px;
  margin: 0 0 var(--sp-2);
  color: var(--text);
}
.ai-head p {
  font-size: 14px;
  line-height: 1.45;
  color: var(--text-muted);
  margin: 0;
  max-width: 32ch;
  margin-inline: auto;
}

.ai-modes {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.ai-mode {
  flex: 1;
  padding: 9px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-soft);
  font: 600 13px/1 var(--font-body);
  cursor: pointer;
  transition: all var(--motion-short) var(--ease);
}
.ai-mode:active { transform: scale(0.97); }
.ai-mode.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.ai-input {
  width: 100%;
  background: var(--card);
  border: 1px solid transparent;
  border-radius: var(--r-3);
  color: var(--text);
  font: 500 15px/1.45 var(--font-body);
  padding: var(--sp-3) var(--sp-4);
  outline: none;
  resize: none;
}
.ai-input::placeholder { color: var(--text-muted); }
.ai-input:focus { border-color: var(--accent); }

.ai-examples {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.ai-chip {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-soft);
  font: 600 12px/1 var(--font-body);
  padding: 8px 12px;
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: all var(--motion-short) var(--ease);
}
.ai-chip:active { transform: scale(0.95); background: var(--card-hover); }

.ai-error {
  margin-top: var(--sp-3);
  font-size: 13px;
  color: var(--danger);
  text-align: center;
}

.ai-go {
  width: 100%;
  margin-top: var(--sp-5);
  height: 50px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: var(--on-accent);
  font: 700 16px/1 var(--font-display);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  cursor: pointer;
  transition: transform var(--motion-short) var(--ease), opacity var(--motion-short) var(--ease);
}
.ai-go:active { transform: scale(0.98); }
.ai-go:disabled { opacity: 0.45; cursor: not-allowed; }

/* Loading */
.ai-loading { text-align: center; padding: var(--sp-6) var(--sp-2); }
.ai-orb { animation: ai-pulse 1.4s ease-in-out infinite; }
.ai-loading h2 {
  font: 800 20px/1.2 var(--font-display);
  margin: 0 0 var(--sp-2);
  color: var(--text);
}
.ai-loading p {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-muted);
  margin: 0 auto;
  max-width: 30ch;
}
.ai-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--card-hover);
  overflow: hidden;
  margin: var(--sp-4) auto 0;
  max-width: 280px;
}
.ai-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.3s ease;
}
.ai-count {
  margin-top: var(--sp-3);
  font: 700 14px/1 var(--font-display);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
@keyframes ai-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.12); opacity: 0.78; }
}

.ai-fade-enter-active,
.ai-fade-leave-active { transition: opacity var(--motion-mid) var(--ease); }
.ai-fade-enter-from,
.ai-fade-leave-to { opacity: 0; }
</style>
