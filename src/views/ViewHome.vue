<script setup>
import { onMounted, computed, ref } from 'vue';
import { RotateCcw, Sparkles, TrendingUp, Clock, Mic2 } from 'lucide-vue-next';
import { haptics } from '@/lib/haptics';
import { useDiscoverStore } from '@/stores/discover';
import { useStreamsStore } from '@/stores/streams';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { fmtDuration, parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import MobileSkeleton from '@/components/MobileSkeleton.vue';

const discover = useDiscoverStore();
const streams = useStreamsStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const view = useViewStore();

// Lightweight "Reprends ta lecture" — the last 6 tracks the player touched
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
// playCount per artist, take the top 6. Each entry surfaces its
// most-played track as the cover.
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
    .slice(0, 6);
});

function openArtist(name) {
  haptics.light();
  view.switchTo('artist', name);
}

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
    <div class="home-greeting">
      <h1>{{ hello }}</h1>
      <button class="reroll" :disabled="discover.loading" @click="discover.refresh()" aria-label="Re-rouler la sélection">
        <RotateCcw :size="18" :stroke-width="2" color="var(--text)" :class="{ spinning: discover.loading }" />
      </button>
    </div>

    <section v-if="recents.length > 0" class="home-section">
      <div class="section-head"><h2>Reprends ta lecture</h2></div>
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

    <section v-if="recentlyPlayed.length > 0" class="home-section">
      <div class="section-head">
        <h2><Clock :size="16" :stroke-width="2.4" class="head-icon" /> Récemment joués</h2>
      </div>
      <div class="h-scroll">
        <button
          v-for="t in recentlyPlayed"
          :key="t.id"
          class="h-card"
          @click="playOne(t)"
        >
          <div class="h-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title text-ellipsis">{{ t.title }}</div>
          <div class="h-sub text-ellipsis">{{ t.uploader }}</div>
        </button>
      </div>
    </section>

    <section v-if="topPlayed.length > 0" class="home-section">
      <div class="section-head">
        <h2><TrendingUp :size="16" :stroke-width="2.4" class="head-icon" /> Top joués</h2>
      </div>
      <div class="h-scroll">
        <button
          v-for="t in topPlayed"
          :key="t.id"
          class="h-card"
          @click="playOne(t)"
        >
          <div class="h-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="h-title text-ellipsis">{{ t.title }}</div>
          <div class="h-sub text-ellipsis">{{ t.playCount }} écoute{{ t.playCount > 1 ? 's' : '' }}</div>
        </button>
      </div>
    </section>

    <section v-if="topArtists.length > 0" class="home-section">
      <div class="section-head">
        <h2><Mic2 :size="16" :stroke-width="2.4" class="head-icon" /> Top artistes</h2>
      </div>
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
          <div class="h-title text-ellipsis">{{ a.name }}</div>
          <div class="h-sub text-ellipsis">{{ a.plays }} écoute{{ a.plays > 1 ? 's' : '' }}</div>
        </button>
      </div>
    </section>

    <section class="home-section">
      <div class="section-head">
        <h2>Pour toi</h2>
        <span v-if="discover.seedTrack" class="seed">d'après «&nbsp;{{ discover.seedTrack.title }}&nbsp;»</span>
      </div>

      <MobileSkeleton v-if="discover.loading && discover.tracks.length === 0" variant="card" :count="6" />

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
  </van-pull-refresh>
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
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.head-icon { color: var(--accent); }
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

/* Horizontal scrolling card rows — Apple Music / Spotify pattern
 * for "Top X" carousels. Each card is fixed-width and the row
 * scroll-snaps so the user can flick through naturally. */
.h-scroll {
  display: flex;
  gap: var(--sp-3);
  padding: 0 var(--sp-4) var(--sp-2);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.h-scroll::-webkit-scrollbar { display: none; }
.h-card {
  flex: 0 0 auto;
  width: 130px;
  scroll-snap-align: start;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}
.h-card:active { transform: scale(0.97); transition: transform 80ms var(--ease); }
.h-cover {
  width: 130px;
  height: 130px;
  border-radius: var(--r-2);
  overflow: hidden;
  background: var(--card-hover);
  margin-bottom: var(--sp-2);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.h-cover img { width: 100%; height: 100%; object-fit: cover; }
.h-cover-circle { border-radius: 50%; }
.h-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}
.h-sub {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.h-card-artist .h-title { text-align: center; }
.h-card-artist .h-sub { text-align: center; }

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
