<script setup>
import { onMounted, computed } from 'vue';
import { RotateCcw, Sparkles } from 'lucide-vue-next';
import { useDiscoverStore } from '@/stores/discover';
import { useStreamsStore } from '@/stores/streams';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';

const discover = useDiscoverStore();
const streams = useStreamsStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const view = useViewStore();

// Lightweight "Recently played" — the last 6 tracks the player touched
// (queue snapshot). Falls back to favorites when the queue is empty.
const recents = computed(() => {
  const ids = (player.queue || []).slice(-6).reverse();
  const map = new Map();
  for (const id of ids) {
    const tr = lib.findById(id) || streams.get(id);
    if (tr) map.set(tr.id, tr);
  }
  const fromQueue = Array.from(map.values());
  if (fromQueue.length > 0) return fromQueue;
  return lib.favorites.slice(0, 6);
});

function playFromDiscover(t) {
  const ids = discover.tracks.map((s) => s.id);
  player.playFromList(t.id, ids);
}

function playOne(t) {
  player.playFromList(t.id, [t.id]);
}

onMounted(() => {
  if (discover.tracks.length === 0 && !discover.loading) discover.refresh();
});

const hello = computed(() => {
  const h = new Date().getHours();
  if (h < 6 || h >= 22) return 'Bonsoir';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
});
</script>

<template>
  <div class="home-view">
    <div class="home-greeting">
      <h1>{{ hello }}</h1>
      <button class="reroll" :disabled="discover.loading" @click="discover.refresh()" aria-label="Re-rouler la sélection">
        <RotateCcw :size="18" :stroke-width="2" color="var(--text)" :class="{ spinning: discover.loading }" />
      </button>
    </div>

    <section v-if="recents.length > 0" class="home-section">
      <div class="row-grid">
        <button
          v-for="t in recents"
          :key="t.id"
          class="row-pill"
          @click="playOne(t)"
        >
          <div class="rp-thumb">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <span class="text-ellipsis">{{ t.title }}</span>
        </button>
      </div>
    </section>

    <section class="home-section">
      <div class="section-head">
        <h2>Pour toi</h2>
        <span v-if="discover.seedTrack" class="seed">d'après «&nbsp;{{ discover.seedTrack.title }}&nbsp;»</span>
      </div>

      <div v-if="discover.loading" class="loading">
        <van-loading size="22" color="var(--accent)" />
      </div>

      <div v-else-if="discover.tracks.length === 0" class="empty-state">
        <Sparkles class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Aucune recommandation</div>
        <div class="hint">Ajoute un titre à tes favoris pour amorcer la découverte.</div>
      </div>

      <div v-else class="discover-grid">
        <button
          v-for="t in discover.tracks"
          :key="t.id"
          class="dc-card"
          @click="playFromDiscover(t)"
        >
          <div class="dc-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="dc-title text-ellipsis">{{ t.title }}</div>
          <div class="dc-sub text-ellipsis">{{ t.uploader }}</div>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-view {
  padding: 8px 0 16px;
}

.home-greeting {
  padding: 8px 16px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.home-greeting h1 {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.reroll {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--card);
  border: 0;
  display: grid;
  place-items: center;
}
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(-360deg); }
}

.home-section { padding: 8px 0 16px; }
.section-head {
  padding: 8px 16px 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.section-head h2 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.section-head .seed {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60%;
}

.row-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 0 12px;
}
.row-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--card);
  border: 0;
  border-radius: 6px;
  padding: 0;
  overflow: hidden;
  text-align: left;
  height: 56px;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
}
.row-pill:active { background: var(--card-hover); }
.row-pill .rp-thumb {
  width: 56px;
  height: 56px;
  background: var(--card-hover);
  flex: 0 0 auto;
  overflow: hidden;
}
.row-pill .rp-thumb img { width: 100%; height: 100%; object-fit: cover; }
.row-pill span { padding-right: 8px; }

.loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.discover-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 0 12px;
}
.dc-card {
  background: var(--card);
  border: 0;
  border-radius: 8px;
  overflow: hidden;
  padding: 8px;
  text-align: left;
  cursor: pointer;
}
.dc-card:active { background: var(--card-hover); }
.dc-cover {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 6px;
  overflow: hidden;
  background: var(--card-hover);
  margin-bottom: 8px;
}
.dc-cover img { width: 100%; height: 100%; object-fit: cover; }
.dc-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.dc-sub {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
</style>
