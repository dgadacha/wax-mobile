<script setup>
// "Wrapped" — yearly recap-style stats view, Spotify Wrapped-lite.
// Triggered from a Settings cell so the user can re-open it any
// time (not gated on end-of-year). Top tracks/artists are computed
// locally from the per-track playCount; the listened-time hero comes
// from the server-tracked lib.listenedSeconds (real content-time).
//
// Scope: "all-time" since we don't track a play HISTORY (just totals).
// Could become a real per-year breakdown if we ever start writing
// play-event timestamps server-side.
import { computed, onMounted } from 'vue';
import { Music, Clock, Heart, Sparkles, Mic2, Disc3, Users } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { fmtDuration, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';

const lib = useLibraryStore();
const player = usePlayerStore();
const view = useViewStore();

// Pull the real per-profile listened-seconds counter (server-tracked,
// content-time). Seeds from the old estimate on first access server-side.
onMounted(() => { lib.fetchStats(); });

// ── Aggregates ────────────────────────────────────────────────────

const playedTracks = computed(() =>
  lib.tracks.filter((t) => (t.playCount || 0) > 0),
);

const totalPlays = computed(() =>
  playedTracks.value.reduce((sum, t) => sum + (t.playCount || 0), 0),
);

// Legacy estimate = sum of (duration × playCount). Kept as a fallback
// while the real counter is still loading (or for very old profiles
// before the server seed ran). The real value comes from
// lib.listenedSeconds — actual content-time heard, tracked by the
// player (delta of currentTime, flushed every ~15 s).
const estimateSeconds = computed(() =>
  playedTracks.value.reduce(
    (sum, t) => sum + (t.duration || 0) * (t.playCount || 0),
    0,
  ),
);
const totalSeconds = computed(() =>
  lib.listenedSeconds > 0 ? lib.listenedSeconds : estimateSeconds.value,
);

const totalHours = computed(() => Math.floor(totalSeconds.value / 3600));
const totalMinutes = computed(() => Math.round((totalSeconds.value % 3600) / 60));

// Top tracks by playCount, top 5.
const topTracks = computed(() =>
  [...playedTracks.value]
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
    .slice(0, 5),
);

// Top artists — group by normalized key so different YouTube channels
// for the same artist count as one. Returns {name, plays, top:track}.
const topArtists = computed(() => {
  const byArtist = new Map();
  for (const t of playedTracks.value) {
    const parsed = parseTrackTitle(t);
    const name = parsed.artist || t.uploader;
    if (!name) continue;
    const key = normalizeArtistKey(name);
    if (!key) continue;
    const plays = t.playCount || 0;
    const cur = byArtist.get(key) || { name, plays: 0, top: t };
    cur.plays += plays;
    if ((t.playCount || 0) > (cur.top.playCount || 0)) cur.top = t;
    byArtist.set(key, cur);
  }
  return [...byArtist.values()].sort((a, b) => b.plays - a.plays).slice(0, 5);
});

// Distinct artists across the whole library — a genuine "variety"
// stat, unlike the old "discoveries (12 mois)" which just mirrored
// the library size.
const distinctArtists = computed(() => {
  const keys = new Set();
  for (const t of lib.tracks) {
    const parsed = parseTrackTitle(t);
    const name = parsed.artist || t.uploader;
    if (!name) continue;
    const key = normalizeArtistKey(name);
    if (key) keys.add(key);
  }
  return keys.size;
});

// Favorite ratio — % of library that's marked as favori.
const favoriteRatio = computed(() => {
  if (lib.tracks.length === 0) return 0;
  return Math.round((lib.favorites.length / lib.tracks.length) * 100);
});

// ── Actions ───────────────────────────────────────────────────────

function playTrack(t) {
  haptics.light();
  player.playFromList(t.id, [t.id]);
}
function openArtist(name) {
  haptics.light();
  view.switchTo('artist', name);
}

// Empty state — user hasn't played anything yet. Cheeky message
// rather than a sad blank screen.
const hasData = computed(() => totalPlays.value > 0);
</script>

<template>
  <div class="wrapped-view">
    <div v-if="!hasData" class="wrapped-empty">
      <Sparkles :size="56" :stroke-width="1.5" color="var(--text-muted)" />
      <h2>Pas encore d'historique</h2>
      <p>
        Joue quelques morceaux — Wax garde un compteur d'écoutes pour générer
        ta sélection.
      </p>
    </div>

    <div v-else class="wrapped-body">
      <!-- Hero stat: total time -->
      <section class="wp-hero">
        <Clock :size="28" :stroke-width="1.8" color="var(--accent)" />
        <div class="wp-hero-big">
          {{ totalHours }}<span class="wp-hero-unit">h</span>
          {{ totalMinutes }}<span class="wp-hero-unit">min</span>
        </div>
        <div class="wp-hero-sub">d'écoute cumulée</div>
      </section>

      <!-- Stat row: plays + tracks + distinct artists -->
      <section class="wp-stats">
        <div class="wp-stat">
          <Music :size="20" :stroke-width="1.8" color="var(--accent)" />
          <div class="wp-stat-n">{{ totalPlays }}</div>
          <div class="wp-stat-l">écoutes</div>
        </div>
        <div class="wp-stat">
          <Disc3 :size="20" :stroke-width="1.8" color="var(--accent)" />
          <div class="wp-stat-n">{{ lib.tracks.length }}</div>
          <div class="wp-stat-l">titres en biblio</div>
        </div>
        <div class="wp-stat">
          <Users :size="20" :stroke-width="1.8" color="var(--accent)" />
          <div class="wp-stat-n">{{ distinctArtists }}</div>
          <div class="wp-stat-l">artistes différents</div>
        </div>
      </section>

      <!-- Top tracks -->
      <section v-if="topTracks.length > 0" class="wp-section">
        <div class="wp-section-head">
          <Music :size="18" :stroke-width="2.4" class="wp-head-icon" />
          <h2>Tes morceaux préférés</h2>
        </div>
        <button
          v-for="(t, i) in topTracks"
          :key="t.id"
          class="wp-row"
          @click="playTrack(t)"
        >
          <div class="wp-row-rank" :class="`wp-rank-${i + 1}`">{{ i + 1 }}</div>
          <div class="wp-row-cover">
            <img v-if="t.thumbnail" :src="apiUrl(t.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="wp-row-meta">
            <div class="wp-row-title text-ellipsis">{{ t.title }}</div>
            <div class="wp-row-sub">{{ t.playCount }} écoute{{ t.playCount > 1 ? 's' : '' }} · {{ fmtDuration(t.duration || 0) }}</div>
          </div>
        </button>
      </section>

      <!-- Top artists -->
      <section v-if="topArtists.length > 0" class="wp-section">
        <div class="wp-section-head">
          <Mic2 :size="18" :stroke-width="2.4" class="wp-head-icon" />
          <h2>Tes artistes préférés</h2>
        </div>
        <button
          v-for="(a, i) in topArtists"
          :key="a.name"
          class="wp-row"
          @click="openArtist(a.name)"
        >
          <div class="wp-row-rank" :class="`wp-rank-${i + 1}`">{{ i + 1 }}</div>
          <div class="wp-row-cover wp-row-cover-circle">
            <img v-if="a.top?.thumbnail" :src="apiUrl(a.top.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="wp-row-meta">
            <div class="wp-row-title text-ellipsis">{{ a.name }}</div>
            <div class="wp-row-sub">{{ a.plays }} écoute{{ a.plays > 1 ? 's' : '' }}</div>
          </div>
        </button>
      </section>

      <!-- Library health -->
      <section class="wp-card">
        <Heart :size="22" :stroke-width="2" color="var(--accent)" />
        <div>
          <div class="wp-card-big">{{ favoriteRatio }}%</div>
          <div class="wp-card-sub">de ta bibliothèque en favoris ({{ lib.favorites.length }} titres)</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wrapped-view {
  min-height: 100%;
  padding-bottom: var(--sp-12);
}

.wrapped-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-12) var(--sp-4);
  color: var(--text-muted);
}
.wrapped-empty h2 {
  font-family: var(--font-display);
  font-size: 20px;
  color: var(--text);
  margin: var(--sp-4) 0 var(--sp-2);
}
.wrapped-empty p { font-size: 14px; line-height: 1.5; max-width: 28ch; margin: 0; }

.wrapped-body { padding: var(--sp-2) var(--sp-4) 0; }

/* Hero — large total-hours number, accent gradient backdrop */
.wp-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-8) var(--sp-4);
  background: linear-gradient(160deg, var(--accent-soft) 0%, transparent 80%);
  border-radius: var(--r-3);
  margin-bottom: var(--sp-4);
}
.wp-hero-big {
  font-family: var(--font-display);
  font-size: 56px;
  font-weight: 800;
  color: var(--text);
  line-height: 1;
  margin-top: var(--sp-3);
}
.wp-hero-unit {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 0 var(--sp-1) 0 2px;
}
.wp-hero-sub {
  font-size: 14px;
  color: var(--text-muted);
  margin-top: var(--sp-2);
}

/* Three-stat row */
.wp-stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--sp-2);
  margin-bottom: var(--sp-6);
}
.wp-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-3) var(--sp-2);
  background: var(--card);
  border-radius: var(--r-2);
}
.wp-stat-n {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin-top: var(--sp-1);
}
.wp-stat-l {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.2;
}

/* Sections */
.wp-section { margin-bottom: var(--sp-6); }
.wp-section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.wp-section-head h2 {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.wp-head-icon { color: var(--accent); }

.wp-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  background: transparent;
  border: 0;
  padding: var(--sp-2) 0;
  text-align: left;
  cursor: pointer;
}
.wp-row:active { background: var(--card-hover); border-radius: var(--r-1); }
.wp-row-rank {
  width: 24px;
  text-align: center;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--text-muted);
  flex: 0 0 auto;
}
/* Podium medals for the top 3 */
.wp-rank-1 { color: #f6c945; }
.wp-rank-2 { color: #c7ccd1; }
.wp-rank-3 { color: #d68b54; }
.wp-row-cover {
  width: 48px;
  height: 48px;
  border-radius: var(--r-1);
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.wp-row-cover-circle { border-radius: 50%; }
.wp-row-cover img { width: 100%; height: 100%; object-fit: cover; }
.wp-row-meta { flex: 1 1 auto; min-width: 0; }
.wp-row-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}
.wp-row-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* Library health card */
.wp-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--card);
  border-radius: var(--r-2);
}
.wp-card-big {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}
.wp-card-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}
</style>
