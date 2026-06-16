<script setup>
import { onMounted, computed, ref } from 'vue';
import { showToast } from 'vant';
import { RotateCcw, Sparkles, Settings } from 'lucide-vue-next';
import { haptics } from '@/lib/haptics';
import { useDiscoverStore } from '@/stores/discover';
import { useStreamsStore } from '@/stores/streams';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import MobileSkeleton from '@/components/MobileSkeleton.vue';

const discover = useDiscoverStore();
const streams = useStreamsStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const view = useViewStore();

// Quick-resume grid — the last 6 tracks the player touched (queue
// snapshot). Falls back to favorites when the queue is empty.
const recents = computed(() => {
  const ids = (player.queue || []).slice(-6).reverse();
  const map = new Map();
  for (const id of ids) {
    const tr = lib.findById(id) || streams.get(id);
    if (tr) map.set(tr.id, tr);
  }
  const fromQueue = Array.from(map.values());
  if (fromQueue.length > 0) return fromQueue.slice(0, 6);
  return lib.favorites.slice(0, 6);
});

// "Récemment joués" — tracks the user has actually played at least
// once, sorted by lastPlayedAt desc. Top 10 for the horizontal row.
const recentlyPlayed = computed(() =>
  lib.tracks
    .filter((t) => t.lastPlayedAt)
    .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    .slice(0, 10),
);

// "Top joués" — tracks sorted by playCount. Skips zero plays so a
// fresh library doesn't show a row of orphan tracks.
const topPlayed = computed(() =>
  lib.tracks
    .filter((t) => (t.playCount || 0) > 0)
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
    .slice(0, 10),
);

// "Top artistes" — group tracks by normalized artist key, sum
// playCount per artist, take the top 6.
const topArtists = computed(() => {
  const byArtist = new Map(); // key -> { name, plays, top }
  for (const t of lib.tracks) {
    const parsed = parseTrackTitle(t);
    const name = parsed.artist || t.uploader;
    if (!name) continue;
    const key = normalizeArtistKey(name);
    if (!key) continue;
    const plays = t.playCount || 0;
    if (plays === 0) continue;
    const cur = byArtist.get(key) || { name, plays: 0, top: t };
    cur.plays += plays;
    if ((t.playCount || 0) > (cur.top.playCount || 0)) cur.top = t;
    byArtist.set(key, cur);
  }
  return Array.from(byArtist.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 8);
});

function openArtist(name) {
  haptics.light();
  view.switchTo('artist', name);
}
function openWrapped() {
  haptics.light();
  view.switchTo('wrapped');
}
function openSettings() {
  haptics.light();
  view.switchTo('settings');
}

function playFromDiscover(t) {
  const ids = discover.tracks.map((s) => s.id);
  player.playFromList(t.id, ids);
}

// Play a track with its whole section as the queue so next/prev keep
// browsing the same shelf — what Spotify does on Home cards.
function playFromSection(t, list) {
  haptics.light();
  player.playFromList(t.id, list.map((x) => x.id));
}

onMounted(() => {
  // Already populated this session → leave it. Else re-hydrate cached AI
  // recos; if none, fall back to the instant (key-free) Deezer mix.
  if (discover.tracks.length > 0 || discover.loading) return;
  if (!discover.loadAiCache()) discover.refresh();
});

async function regenAI() {
  if (discover.loading) return;
  haptics.medium();
  try {
    await discover.refreshAI();
  } catch (e) {
    showToast({ message: 'Erreur : ' + (e.message || 'inconnue'), position: 'bottom' });
  }
}

const hello = computed(() => {
  const h = new Date().getHours();
  if (h < 6 || h >= 22) return 'Bonsoir';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
});

const refreshing = ref(false);
async function onRefresh() {
  haptics.medium();
  try { await discover.refresh(); }
  finally { refreshing.value = false; }
}
</script>

<template>
  <van-pull-refresh
    v-model="refreshing"
    pulling-text="Tire pour rafraîchir"
    loosing-text="Lâche pour rafraîchir"
    loading-text="Mise à jour…"
    success-text=""
    head-height="60"
    @refresh="onRefresh"
  >
  <div class="home-view">
    <!-- Header — greeting + utility icons (stats recap, settings).
         Spotify's Home top row. -->
    <div class="home-head">
      <h1>{{ hello }}</h1>
      <div class="home-head-actions">
        <button class="head-btn" aria-label="Ta sélection" @click="openWrapped">
          <Sparkles :size="22" :stroke-width="2" color="var(--text)" />
        </button>
        <button class="head-btn" aria-label="Réglages" @click="openSettings">
          <Settings :size="22" :stroke-width="2" color="var(--text)" />
        </button>
      </div>
    </div>

    <!-- Quick-resume tiles — Spotify's 2-col "recently played" grid. -->
    <section v-if="recents.length > 0" class="home-section">
      <div class="row-grid">
        <button
          v-for="t in recents"
          :key="t.id"
          class="row-pill"
          @click="playFromSection(t, recents)"
        >
          <div class="rp-thumb">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <span class="rp-label">{{ t.title }}</span>
        </button>
      </div>
    </section>

    <section v-if="recentlyPlayed.length > 0" class="home-section">
      <div class="section-head"><h2>Récemment joués</h2></div>
      <div class="h-scroll">
        <button
          v-for="t in recentlyPlayed"
          :key="t.id"
          class="h-card"
          @click="playFromSection(t, recentlyPlayed)"
        >
          <div class="h-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title">{{ t.title }}</div>
          <div class="h-sub text-ellipsis">{{ t.uploader }}</div>
        </button>
      </div>
    </section>

    <section v-if="topPlayed.length > 0" class="home-section">
      <div class="section-head"><h2>Tes titres du moment</h2></div>
      <div class="h-scroll">
        <button
          v-for="t in topPlayed"
          :key="t.id"
          class="h-card"
          @click="playFromSection(t, topPlayed)"
        >
          <div class="h-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title">{{ t.title }}</div>
          <div class="h-sub text-ellipsis">{{ t.playCount }} écoute{{ t.playCount > 1 ? 's' : '' }}</div>
        </button>
      </div>
    </section>

    <section v-if="topArtists.length > 0" class="home-section">
      <div class="section-head"><h2>Tes artistes préférés</h2></div>
      <div class="h-scroll">
        <button
          v-for="a in topArtists"
          :key="a.name"
          class="h-card h-card-artist"
          @click="openArtist(a.name)"
        >
          <div class="h-cover h-cover-circle">
            <img v-if="a.top?.thumbnail" :src="apiUrl(a.top.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title">{{ a.name }}</div>
          <div class="h-sub text-ellipsis">Artiste</div>
        </button>
      </div>
    </section>

    <section class="home-section">
      <div class="section-head">
        <h2>Pour toi</h2>
        <div class="home-head-actions">
          <button
            class="head-btn small"
            :disabled="discover.loading"
            aria-label="Recommandations IA"
            @click="regenAI"
          >
            <Sparkles
              :size="17"
              :stroke-width="2.2"
              :color="discover.aiActive ? 'var(--accent)' : 'var(--text-muted)'"
              :class="{ spinning: discover.aiLoading }"
            />
          </button>
          <button
            class="head-btn small"
            :disabled="discover.loading"
            aria-label="Re-rouler la sélection"
            @click="discover.refresh()"
          >
            <RotateCcw :size="17" :stroke-width="2.2" color="var(--text-muted)" :class="{ spinning: discover.loading && !discover.aiLoading }" />
          </button>
        </div>
      </div>
      <div v-if="discover.aiLoading && discover.aiProgress.total" class="seed">✨&nbsp;Génération… {{ discover.aiProgress.done }}/{{ discover.aiProgress.total }}</div>
      <div v-else-if="discover.aiActive" class="seed">✨&nbsp;Sélection d'après tes écoutes</div>
      <div v-else-if="discover.seedTrack" class="seed">d'après «&nbsp;{{ discover.seedTrack.title }}&nbsp;»</div>

      <MobileSkeleton v-if="discover.loading && discover.tracks.length === 0" variant="card" :count="6" />

      <div v-else-if="discover.tracks.length === 0" class="empty-state">
        <Sparkles class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Aucune recommandation</div>
        <div class="hint">Ajoute un titre à tes favoris pour amorcer la découverte.</div>
      </div>

      <div v-else class="h-scroll">
        <button
          v-for="t in discover.tracks"
          :key="t.id"
          class="h-card h-card-lg"
          @click="playFromDiscover(t)"
        >
          <div class="h-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title">{{ t.title }}</div>
          <div class="h-sub text-ellipsis">{{ t.uploader }}</div>
        </button>
      </div>
    </section>
  </div>
  </van-pull-refresh>
</template>

<style scoped>
.home-view {
  padding: 8px 0 16px;
}

.home-head {
  padding: 10px 16px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.home-head h1 {
  font: 800 24px/1.1 var(--font-display);
  letter-spacing: -0.4px;
  margin: 0;
  color: var(--text);
}
.home-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.head-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.head-btn:active { background: rgba(255, 255, 255, 0.08); }
.head-btn.small { width: 32px; height: 32px; }
.spinning {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(-360deg); }
}

.home-section { padding: 6px 0 14px; }
.section-head {
  padding: 8px 16px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-head h2 {
  font: 700 20px/1.2 var(--font-display);
  letter-spacing: -0.3px;
  margin: 0;
  color: var(--text);
}
.seed {
  padding: 0 16px 10px;
  margin-top: -8px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Quick-resume tiles — frosted 2-col grid, Spotify Home pattern. */
.row-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 0 16px;
}
.row-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 0;
  border-radius: 4px;
  padding: 0;
  overflow: hidden;
  text-align: left;
  height: 56px;
  cursor: pointer;
  color: var(--text);
}
.row-pill:active { background: rgba(255, 255, 255, 0.18); }
.row-pill .rp-thumb {
  width: 56px;
  height: 56px;
  background: var(--card);
  flex: 0 0 auto;
  overflow: hidden;
}
.row-pill .rp-thumb img { width: 100%; height: 100%; object-fit: cover; }
.rp-label {
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 8px;
  font: 700 12px/1.25 var(--font-body);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Horizontal shelves — fixed-width cards, free scroll. */
.h-scroll {
  display: flex;
  gap: 14px;
  padding: 0 16px 4px;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.h-scroll::-webkit-scrollbar { display: none; }
.h-card {
  flex: 0 0 auto;
  width: 132px;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}
.h-card:active { transform: scale(0.97); transition: transform 80ms var(--ease); }
.h-card-lg { width: 156px; }
.h-cover {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 4px;
  overflow: hidden;
  background: var(--card);
  margin-bottom: 8px;
}
.h-cover img { width: 100%; height: 100%; object-fit: cover; }
.h-cover-circle { border-radius: 50%; }
.h-title {
  font: 600 13px/1.3 var(--font-body);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.h-sub {
  font: 400 12px/1.3 var(--font-body);
  color: var(--text-muted);
  margin-top: 3px;
}
.h-card-artist .h-title { text-align: center; -webkit-line-clamp: 1; }
.h-card-artist .h-sub { text-align: center; }

.empty-state .icon { color: var(--text-muted); }
</style>
