<script setup>
import { computed, ref, onMounted, watch } from 'vue';
import {
  Sparkles, Clock, X, Heart, ListMusic, Disc3,
  User, ArrowDownCircle, Plus, ListPlus, ListEnd, Mic2,
} from 'lucide-vue-next';
import { useSearchStore, makeSearchHandler } from '@/stores/search';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { usePlaylistsStore } from '@/stores/playlists';
import { parseTrackTitle } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import { showToast } from 'vant';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { useActionSheetStore } from '@/stores/actionSheet';

const search = useSearchStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const player = usePlayerStore();
const mix = useMixStore();
const view = useViewStore();
const playlists = usePlaylistsStore();
const sheet = useActionSheetStore();

const onUrlChange = makeSearchHandler(search);

function onSearchInput(v) {
  search.inputValue = v;
  onUrlChange();
}
function onClear() {
  search.inputValue = '';
  search.clearAll();
}

// "Liked" means the track is in Favoris (liked !== false) — NOT merely
// present in the library. Tracks land in the library with liked:false
// through playlist adds / saved mixes / album imports; the old
// presence-only check showed those as already-hearted in search.
function isLiked(r) {
  return lib.tracks.some((t) => t.ytId === r.id && t.liked !== false);
}

function playResult(r) {
  haptics.light();
  streams.streamSearchResult(r, null, player);
}

function toggleLike(r) {
  haptics.medium();
  // toggleFav flips the liked flag (or optimistically adds a favorite).
  // The old path called lib.remove() on un-heart, which DELETED the row
  // from the library and yanked it out of every playlist.
  lib.toggleFav({ ...asTrack(r), isStream: true });
}

// Ensure a YouTube search result exists in the library (liked:false so
// it doesn't pollute Favoris) and return its library id.
async function ensureInLibrary(r) {
  const existing = lib.tracks.find((t) => t.ytId === r.id);
  if (existing) return existing.id;
  const added = await lib.add({
    id: r.id, ytId: r.id, title: r.title, uploader: r.uploader,
    duration: r.duration, thumbnail: r.thumbnail,
    url: `https://www.youtube.com/watch?v=${r.id}`,
  }, { liked: false, silent: true });
  return added?.id || lib.tracks.find((t) => t.ytId === r.id)?.id;
}

async function addToPlaylistFlow(r) {
  const actions = [
    { name: 'Nouvelle playlist', icon: Plus, color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id, icon: ListMusic })),
  ];
  // Wait a tick so the previous sheet's close animation completes.
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try {
    pick = await sheet.open(actions, { title: 'Ajouter à une playlist', subtitle: r.title });
  } catch { return; }
  const trackId = await ensureInLibrary(r);
  if (!trackId) { showToast({ message: 'Impossible d\'ajouter', position: 'bottom' }); return; }
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, trackId);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, trackId);
    showToast({ message: `Ajouté à « ${pl.name} »`, position: 'bottom' });
  }
}

async function onMore(r) {
  try {
    const { index } = await sheet.open(
      [
        { name: isLiked(r) ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: Heart },
        { name: 'Ajouter à une playlist', icon: ListPlus },
        { name: 'Lancer un mix basé sur ce titre', icon: Sparkles },
        { name: 'Ajouter à la file', icon: ListEnd },
        { name: 'Ouvrir l’artiste', icon: Mic2 },
      ],
      { cover: r.thumbnail, title: r.title, subtitle: r.uploader },
    );
    if (index === 0) toggleLike(r);
    else if (index === 1) addToPlaylistFlow(r);
    else if (index === 2) {
      const pseudo = { ytId: r.id, title: r.title, thumbnail: r.thumbnail };
      mix.streamFrom(pseudo, () => view.switchTo('mix'));
    } else if (index === 3) {
      const streamId = `stream-${r.id}`;
      if (!streams.get(streamId)) {
        streams.set(streamId, {
          id: streamId, title: r.title, uploader: r.uploader, duration: r.duration,
          thumbnail: r.thumbnail, file: `/api/stream/${r.id}`, ytId: r.id, isStream: true,
        });
      }
      player.addToQueue(streamId);
    } else if (index === 4) {
      const a = parseTrackTitle({ title: r.title, uploader: r.uploader }).artist || r.uploader;
      if (a) view.switchTo('artist', a);
    }
  } catch {}
}

const results = computed(() => search.results || []);
const hasResults = computed(() => !!(search.results && search.results.length));

// ── Browse cards ─────────────────────────────────────────────────
// Spotify's "Parcourir tout" colored tiles, fed with the user's own
// library: each card jumps to a corner of the app and wears the first
// matching cover, tilted in the bottom-right corner.
const offlineTracks = computed(() => lib.tracks.filter((t) => !!t.file));
function goLibrary(filter) {
  haptics.light();
  view.libraryFilter = filter;
  view.switchTo('library');
}
const browseCards = computed(() => [
  {
    id: 'ai', label: 'Playlist IA', color: '#7b3ff2',
    cover: '',
    go: () => view.openAi(), icon: Sparkles,
  },
  {
    id: 'favorites', label: 'Favoris', color: '#8d67ab',
    cover: lib.favorites[0]?.thumbnail || '',
    go: () => view.switchTo('playlist', 'favorites'), icon: Heart,
  },
  {
    id: 'offline', label: 'Hors-ligne', color: '#27856a',
    cover: offlineTracks.value[0]?.thumbnail || '',
    go: () => view.switchTo('playlist', 'offline'), icon: ArrowDownCircle,
  },
  {
    id: 'playlists', label: 'Playlists', color: '#e8115b',
    cover: lib.findById(playlists.items[0]?.trackIds?.[0])?.thumbnail || '',
    go: () => goLibrary('playlists'), icon: ListMusic,
  },
  {
    id: 'albums', label: 'Albums', color: '#e13300',
    cover: lib.albums[0]?.coverUrl || lib.albums[0]?.tracks?.[0]?.thumbnail || '',
    go: () => goLibrary('albums'), icon: Disc3,
  },
  {
    id: 'artists', label: 'Artistes', color: '#537aa1',
    cover: lib.tracks[0]?.thumbnail || '',
    go: () => goLibrary('artists'), icon: User,
  },
  {
    id: 'wrapped', label: 'Ta sélection', color: '#509bf5',
    cover: '',
    go: () => view.switchTo('wrapped'), icon: Sparkles,
  },
]);

// ── Search history ──────────────────────────────────────────────
const HISTORY_KEY = 'wax:search-history';
const HISTORY_MAX = 10;
const history = ref([]);
onMounted(() => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history.value = parsed.filter((s) => typeof s === 'string');
    }
  } catch {}
});
function pushToHistory(q) {
  const trimmed = (q || '').trim();
  if (!trimmed || trimmed.length < 2) return;
  if (/^https?:\/\//i.test(trimmed)) return;
  const next = [trimmed, ...history.value.filter((h) => h.toLowerCase() !== trimmed.toLowerCase())]
    .slice(0, HISTORY_MAX);
  history.value = next;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
}
function removeFromHistory(q) {
  history.value = history.value.filter((h) => h !== q);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value)); } catch {}
}
function clearHistory() {
  history.value = [];
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}
function rerunSearch(q) {
  haptics.light();
  search.inputValue = q;
  onUrlChange();
}
watch(
  () => [search.status, hasResults.value],
  ([status, ok]) => {
    if (status && status !== 'searching' && status !== 'error' && ok) {
      pushToHistory(search.inputValue);
    }
  },
);

// Adapt YouTube search results to the shape MobileTrackCell expects.
function asTrack(r) {
  return {
    id: `stream-${r.id}`,
    ytId: r.id,
    title: r.title,
    uploader: r.uploader,
    duration: r.duration,
    thumbnail: r.thumbnail,
  };
}
</script>

<template>
  <div class="search-view">
    <div class="search-head">
      <h1>Rechercher</h1>
    </div>

    <!-- White search field — Spotify's high-contrast search bar. -->
    <div class="search-bar">
      <van-search
        :model-value="search.inputValue"
        placeholder="Titre, artiste, ou URL YouTube"
        shape="square"
        clearable
        @update:model-value="onSearchInput"
        @clear="onClear"
      />
    </div>

    <div v-if="search.status === 'searching' && !hasResults" class="results shimmer-list">
      <div v-for="i in 8" :key="i" class="shimmer-row">
        <div class="sh sh-thumb" />
        <div class="sh-meta">
          <div class="sh sh-title" />
          <div class="sh sh-sub" />
        </div>
      </div>
    </div>
    <div v-else-if="search.status === 'error'" class="search-status error">
      {{ search.statusMessage }}
    </div>

    <div v-if="hasResults" class="results">
      <MobileTrackCell
        v-for="r in results"
        :key="r.id"
        :track="asTrack(r)"
        :is-playing="player.currentTrack && player.currentTrack.ytId === r.id"
        :is-liked="isLiked(r)"
        @play="playResult(r)"
        @like="toggleLike(r)"
        @more="onMore(r)"
      />
    </div>

    <div v-else-if="!search.inputValue && !search.status" class="search-empty">
      <div v-if="history.length > 0" class="search-history">
        <div class="search-history-head">
          <span class="search-history-title">Recherches récentes</span>
          <button class="search-history-clear" @click="clearHistory">Effacer</button>
        </div>
        <div class="search-history-list">
          <div
            v-for="q in history"
            :key="q"
            class="search-history-row"
            @click="rerunSearch(q)"
          >
            <div class="search-history-thumb">
              <Clock :size="18" :stroke-width="2" color="var(--text-muted)" />
            </div>
            <span class="search-history-q">{{ q }}</span>
            <button
              class="search-history-x"
              :aria-label="`Retirer ${q}`"
              @click.stop="removeFromHistory(q)"
            >
              <X :size="18" :stroke-width="2" color="var(--text-muted)" />
            </button>
          </div>
        </div>
      </div>

      <!-- Browse tiles — colored cards with a tilted cover, Spotify's
           "Browse all" grid, mapped onto the user's own library. -->
      <div class="browse">
        <div class="browse-title">Parcourir</div>
        <div class="browse-grid">
          <button
            v-for="c in browseCards"
            :key="c.id"
            class="browse-card"
            :style="{ background: c.color }"
            @click="c.go"
          >
            <span class="browse-label">{{ c.label }}</span>
            <div class="browse-art">
              <img v-if="c.cover" :src="apiUrl(c.cover)" alt="" loading="lazy" />
              <component v-else :is="c.icon" :size="34" :stroke-width="1.6" color="rgba(255,255,255,0.85)" />
            </div>
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.search-view { min-height: 100%; }

.search-head {
  padding: 10px 16px 4px;
}
.search-head h1 {
  font: 800 24px/1.1 var(--font-display);
  letter-spacing: -0.4px;
  margin: 0;
  color: var(--text);
}

/* White search bar — the one deliberately light surface on the page. */
.search-bar :deep(.van-search) {
  background: transparent;
  padding: 10px 16px;
}
.search-bar :deep(.van-search__content) {
  background: #ffffff;
  border-radius: 8px;
}
.search-bar :deep(.van-field__control) {
  color: #121212;
  font-weight: 500;
}
.search-bar :deep(.van-field__control::placeholder) {
  color: #5e5e5e;
  font-weight: 500;
}
.search-bar :deep(.van-search__field .van-field__left-icon .van-icon),
.search-bar :deep(.van-field__clear) {
  color: #121212;
}

.search-status.error {
  padding: 20px;
  text-align: center;
  font-size: 14px;
  color: var(--danger);
}
.results { background: transparent; padding-top: 4px; }
.shimmer-list { padding: 4px 0 16px; }

/* Search history — Spotify's "Recent searches" list. */
.search-history {
  padding: var(--sp-2) 0;
}
.search-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-4) var(--sp-3);
}
.search-history-title {
  font: 700 16px/1.2 var(--font-display);
  color: var(--text);
}
.search-history-clear {
  background: transparent;
  border: 0;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-1);
}
.search-history-clear:active { background: var(--card-hover); }
.search-history-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  transition: background var(--motion-short) var(--ease);
}
.search-history-row:active { background: rgba(255, 255, 255, 0.06); }
.search-history-thumb {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--card);
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.search-history-q {
  flex: 1 1 auto;
  font: 500 15px/1.3 var(--font-body);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-history-x {
  background: transparent;
  border: 0;
  padding: var(--sp-2);
  cursor: pointer;
  display: grid;
  place-items: center;
}

/* Browse tiles */
.browse { padding: var(--sp-3) var(--sp-4); }
.browse-title {
  font: 700 16px/1.2 var(--font-display);
  color: var(--text);
  margin-bottom: var(--sp-3);
}
.browse-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.browse-card {
  position: relative;
  height: 96px;
  border-radius: 8px;
  border: 0;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  padding: 12px 14px;
  color: #fff;
  isolation: isolate;
}
.browse-card:active { filter: brightness(1.1); }
.browse-label {
  font: 700 16px/1.2 var(--font-display);
  letter-spacing: -0.2px;
  max-width: 70%;
  display: inline-block;
}
.browse-art {
  position: absolute;
  right: -14px;
  bottom: -6px;
  width: 72px;
  height: 72px;
  border-radius: 4px;
  transform: rotate(25deg);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  display: grid;
  place-items: center;
}
.browse-art img { width: 100%; height: 100%; object-fit: cover; }
</style>
