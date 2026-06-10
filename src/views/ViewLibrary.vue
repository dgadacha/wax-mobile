<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import { showConfirmDialog } from 'vant';
import {
  ListMusic, Disc3, User, Heart, Plus, ChevronRight, LayoutGrid,
  Download as DownloadIcon, ArrowDownAZ, LayoutList, Search,
} from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { useMixStore } from '@/stores/mix';
import { useProfileStore } from '@/stores/profile';
import { fmtDuration, parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import MobileSkeleton from '@/components/MobileSkeleton.vue';
import { useActionSheetStore } from '@/stores/actionSheet';

const mix = useMixStore();
const sheet = useActionSheetStore();

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();
const view = useViewStore();
const profile = useProfileStore();

// Initial used in the avatar circle when there's an active profile.
const profileInitial = computed(() => {
  const name = profile.activeProfile?.name || '';
  return name.trim().charAt(0).toUpperCase() || '?';
});
function openProfilePicker() {
  haptics.light();
  profile.openPicker();
}

// View mode for the card list — list (default, denser, Spotify-style)
// vs. grid (2 columns, larger covers). Persisted so it survives reloads.
const VIEW_MODE_KEY = 'wax:lib-view-mode';
const viewMode = ref('list'); // 'list' | 'grid'
onMounted(() => {
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    if (saved === 'list' || saved === 'grid') viewMode.value = saved;
  } catch {}
});
watch(viewMode, (v) => {
  try { localStorage.setItem(VIEW_MODE_KEY, v); } catch {}
});
function toggleViewMode() {
  haptics.selection();
  viewMode.value = viewMode.value === 'list' ? 'grid' : 'list';
}

const FILTERS = [
  { id: 'playlists', label: 'Playlists' },
  { id: 'all',       label: 'Tout' },
  { id: 'albums',    label: 'Albums' },
  { id: 'artists',   label: 'Artistes' },
  { id: 'tracks',    label: 'Titres' },
];

// Default to Playlists — that's where Favoris + Hors-ligne + custom
// playlists live and is the most "home base" view for the bib.
const filter = ref('playlists');
const search = ref('');
const refreshing = ref(false);

// Sort options for the favorites/offline track list. Defaults to
// "Récemment ajoutés" (descending addedAt) which is what Spotify and
// Apple Music both default to. Persisted in localStorage so the user
// keeps their preference across sessions.
const SORT_KEY = 'wax:lib-sort';
const SORTS = [
  { id: 'recent',     label: 'Récemment ajoutés' },
  { id: 'alpha',      label: 'Titre A → Z' },
  { id: 'artist',     label: 'Artiste A → Z' },
  { id: 'duration',   label: 'Durée' },
  { id: 'played',     label: 'Le plus joué' },
  { id: 'lastplayed', label: 'Récemment joués' },
];
const sortMode = ref('recent');
onMounted(() => {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved && SORTS.some((s) => s.id === saved)) sortMode.value = saved;
  } catch {}
});
watch(sortMode, (v) => {
  try { localStorage.setItem(SORT_KEY, v); } catch {}
});
const sortLabel = computed(() => SORTS.find((s) => s.id === sortMode.value)?.label || '');

async function pickSort() {
  haptics.light();
  try {
    const { index } = await sheet.open(
      SORTS.map((s) => ({ name: s.label, _id: s.id })),
    );
    sortMode.value = SORTS[index].id;
  } catch {}
}

// Compare helper — `parseTrackTitle` already strips noise like
// "(Official Video)" so we sort on the cleaned-up artist/song names.
function sortTracks(tracks) {
  const arr = [...tracks];
  switch (sortMode.value) {
    case 'alpha':
      return arr.sort((a, b) => {
        const A = parseTrackTitle(a).song || a.title || '';
        const B = parseTrackTitle(b).song || b.title || '';
        return A.localeCompare(B, undefined, { sensitivity: 'base' });
      });
    case 'artist':
      return arr.sort((a, b) => {
        const A = (parseTrackTitle(a).artist || a.uploader || '').toLowerCase();
        const B = (parseTrackTitle(b).artist || b.uploader || '').toLowerCase();
        return A.localeCompare(B, undefined, { sensitivity: 'base' });
      });
    case 'duration':
      return arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    case 'played':
      return arr.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    case 'lastplayed':
      return arr.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    case 'recent':
    default:
      return arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }
}
async function onRefresh() {
  haptics.medium();
  try { await Promise.all([lib.fetch(), playlists.fetch()]); }
  finally { refreshing.value = false; }
}

// ── Playlists ──────────────────────────────────────────────────────
// Special "Favoris" virtual card always shows at the top — Spotify-style
// "Liked songs" pattern. Tapping it switches the chip to Titres rather
// than pushing a sub-view.
const favoritesCard = computed(() => ({
  kind: 'favorites',
  id: '__favorites__',
  name: 'Favoris',
  subtitle: `Playlist · ${lib.favorites.length} titres`,
  cover: '',
  gradient: 'linear-gradient(135deg, var(--accent-bright) 0%, var(--accent-dark) 100%)',
  sortKey: ' a favoris',
}));

// Virtual "Hors-ligne" playlist: every library track that has a server-
// side download (track.file set). Tap → switches to the dedicated
// offline filter mode (shows ALL offline tracks, not just favorites).
const offlineTracks = computed(() => lib.tracks.filter((t) => !!t.file));
const offlineCard = computed(() => ({
  kind: 'offline',
  id: '__offline__',
  name: 'Hors-ligne',
  subtitle: 'Playlist · ' + offlineTracks.value.length + ' titre' + (offlineTracks.value.length > 1 ? 's' : ''),
  cover: '',
  gradient: 'linear-gradient(135deg, #36c997 0%, #1d8763 100%)',
  sortKey: ' b offline',
}));

const playlistItems = computed(() => {
  const userPls = playlists.items.map((pl) => {
    const firstId = pl.trackIds.find((id) => !!lib.findById(id));
    const firstTrack = firstId ? lib.findById(firstId) : null;
    return {
      kind: 'playlist',
      id: pl.id,
      name: pl.name,
      subtitle: `Playlist · ${pl.trackIds.length} titres`,
      cover: firstTrack?.thumbnail || '',
      gradient: gradientFromString(pl.name),
      sortKey: pl.name.toLowerCase(),
    };
  });
  return [favoritesCard.value, offlineCard.value, ...userPls];
});

// ── Albums ─────────────────────────────────────────────────────────
const albumItems = computed(() => lib.albums.map((al) => ({
  kind: 'album',
  id: al.key,
  name: al.name,
  subtitle: `Album · ${al.artist}`,
  cover: al.coverUrl || al.tracks?.[0]?.thumbnail || '',
  gradient: gradientFromString(al.name),
  sortKey: al.name.toLowerCase(),
})));

// ── Artists ────────────────────────────────────────────────────────
const artistItems = computed(() => {
  const map = new Map();
  for (const t of lib.tracks) {
    const parsed = parseTrackTitle(t);
    const displayName = parsed.artist || t.uploader || '—';
    const key = normalizeArtistKey(displayName);
    if (!map.has(key)) {
      map.set(key, { kind: 'artist', id: displayName, name: displayName, count: 0, cover: t.thumbnail || '' });
    }
    map.get(key).count += 1;
  }
  return Array.from(map.values())
    .filter((a) => a.name && a.name !== '—')
    .map((a) => ({
      ...a,
      subtitle: `Artiste · ${a.count} titres`,
      gradient: gradientFromString(a.name),
      sortKey: a.name.toLowerCase(),
    }));
});

// ── Tracks ────────────────────────────────────────────────────────
// Without a search query: keep the historical "Titres" semantics =
// favorites only (the dedicated Favoris sub-page already shows the
// full list with a hero, so the chip stays a quick filter).
// With a search query: expand to the entire library so the user can
// find ANY track they own — playlist-only / mix-saved entries
// included. The search bar reads "Rechercher dans ta bibliothèque",
// not "Rechercher dans tes favoris".
const trackItems = computed(() => {
  if (filter.value === 'offline') return sortTracks(offlineTracks.value);
  const base = search.value.trim() ? lib.tracks : lib.favorites;
  return sortTracks(base);
});

const filteredCards = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = [];
  if (filter.value === 'all') {
    list = [...playlistItems.value, ...albumItems.value, ...artistItems.value];
  } else if (filter.value === 'playlists') list = playlistItems.value;
  else if (filter.value === 'albums')    list = albumItems.value;
  else if (filter.value === 'artists')   list = artistItems.value;
  if (q) {
    list = list.filter((c) => c.name.toLowerCase().includes(q) || (c.subtitle || '').toLowerCase().includes(q));
  }
  return list.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
});

const filteredTracks = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return trackItems.value;
  return trackItems.value.filter((t) =>
    (t.title || '').toLowerCase().includes(q)
    || (t.uploader || '').toLowerCase().includes(q),
  );
});

// Tracks list shows when chip is 'tracks' (favoris) or 'offline' (the
// virtual card filter mode).
const showingTracks = computed(() => filter.value === 'tracks' || filter.value === 'offline');

function openCard(card) {
  // Favoris and Hors-ligne route through ViewPlaylist with virtual
  // ids so they get the same hero / back arrow / scroll behavior as
  // user-created playlists. The previous in-place filter-swap mode
  // (filter='tracks'/'offline') is kept as fallback for users who
  // tap the "Titres" chip in the chip row, but the cards push a
  // proper sub-view.
  if (card.kind === 'favorites') view.switchTo('playlist', 'favorites');
  else if (card.kind === 'offline') view.switchTo('playlist', 'offline');
  else if (card.kind === 'playlist') view.switchTo('playlist', card.id);
  else if (card.kind === 'album') view.switchTo('album', card.id);
  else if (card.kind === 'artist') view.switchTo('artist', card.id);
}

function playFavoritesFrom(track) {
  const ids = filteredTracks.value.map((t) => t.id);
  player.playFromList(track.id, ids);
}

async function createPlaylist() {
  const { promptModal } = await import('@/lib/modal');
  // The legacy promptModal expects desktop ModalRoot which still mounts in
  // App.vue, so we can reuse it directly.
  const name = await promptModal({
    title: 'Nouvelle playlist',
    placeholder: 'Nom de la playlist',
    confirmLabel: 'Créer',
  });
  if (!name) return;
  await playlists.create.call(playlists, undefined, name); // see note below
}

// playlists.create() opens its own promptModal — for mobile we want to
// pre-fill via Vant's dialog instead. Wrap it.
async function newPlaylistMobile() {
  const { showDialog } = await import('vant');
  showDialog({
    title: 'Nouvelle playlist',
    message: 'Choisis un nom pour la playlist',
    showCancelButton: true,
    confirmButtonText: 'Créer',
    cancelButtonText: 'Annuler',
  }).then(async () => {
    // showDialog has no input; for the input variant we use showConfirmDialog
    // combined with a manual prompt — keep it simple and call legacy.
    await playlists.create();
  }).catch(() => {});
}

async function addToPlaylistFlow(track) {
  const actions = [
    { name: '＋ Nouvelle playlist', color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try { pick = await sheet.open(actions); } catch { return; }
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, track.id);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, track.id);
  }
}

async function onMore(track) {
  try {
    const { index } = await sheet.open([
      { name: track.file ? 'Disponible hors-ligne ✓' : 'Télécharger', disabled: !!track.file },
      { name: 'Ajouter à une playlist' },
      { name: 'Lancer un mix basé sur ce titre' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
      { name: 'Retirer des favoris', color: 'var(--danger)' },
    ]);
    if (index === 0 && !track.file) lib.downloadTrack(track.id);
    else if (index === 1) addToPlaylistFlow(track);
    else if (index === 2) mix.streamFrom(track, () => view.switchTo('mix'));
    else if (index === 3) player.addToQueue(track.id);
    else if (index === 4) {
      const parsed = parseTrackTitle(track);
      const name = parsed.artist || track.uploader;
      if (name) view.switchTo('artist', name);
    } else if (index === 5) {
      lib.remove(track.id);
    }
  } catch { /* dismissed */ }
}

function cardIcon(card) {
  if (card.kind === 'favorites') return Heart;
  if (card.kind === 'offline') return DownloadIcon;
  if (card.kind === 'playlist') return ListMusic;
  if (card.kind === 'album') return Disc3;
  if (card.kind === 'artist') return User;
  return LayoutGrid;
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
  <div class="library-view">
    <!-- Big page header: profile avatar (tap → open picker) on the left,
         display title in the middle, "+" on the right to create a new
         playlist. Universal modern mobile music app pattern. -->
    <header class="lib-header">
      <button
        class="lib-avatar"
        :style="profile.activeProfile ? { background: profile.activeProfile.color } : null"
        aria-label="Changer de profil"
        @click="openProfilePicker"
      >
        {{ profileInitial }}
      </button>
      <h1 class="lib-title">Bibliothèque</h1>
      <button class="lib-action" aria-label="Nouvelle playlist" @click="playlists.create()">
        <Plus :size="22" :stroke-width="2.2" color="var(--text)" />
      </button>
    </header>

    <!-- Filter chips: outlined pill style, horizontally scrollable. -->
    <div class="lib-chips">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        class="chip"
        :class="{ active: filter === f.id }"
        @click="filter = f.id"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- Slim search bar under the chips. Filters cards by name when on
         card modes; filters across the whole library (not just favs) when
         on track mode — see `trackItems` computed. -->
    <div class="lib-search-row">
      <van-search
        v-model="search"
        placeholder="Rechercher dans ta bibliothèque"
        shape="round"
        clearable
      />
    </div>

    <!-- Sort + view-mode row. Sort label only when sort actually applies
         (track mode); the list/grid toggle always shows for cards. -->
    <div
      v-if="(showingTracks && filteredTracks.length > 0) || (!showingTracks && filteredCards.length > 0)"
      class="lib-sort-row"
    >
      <button v-if="showingTracks" class="lib-sort-btn" @click="pickSort">
        <ArrowDownAZ :size="16" :stroke-width="2" color="var(--text-muted)" />
        <span>{{ sortLabel }}</span>
      </button>
      <span v-else />
      <button
        v-if="!showingTracks"
        class="lib-view-toggle"
        :aria-label="viewMode === 'list' ? 'Vue grille' : 'Vue liste'"
        @click="toggleViewMode"
      >
        <LayoutGrid v-if="viewMode === 'list'" :size="18" :stroke-width="2" color="var(--text)" />
        <LayoutList v-else :size="18" :stroke-width="2" color="var(--text)" />
      </button>
    </div>

    <!-- Tracks (favoris OR offline mode via the virtual card) -->
    <template v-if="showingTracks">
      <MobileSkeleton v-if="lib.loading && lib.tracks.length === 0" variant="row" :count="8" />
      <div v-else-if="filteredTracks.length === 0" class="empty-state">
        <component
          :is="filter === 'offline' ? DownloadIcon : Heart"
          class="icon"
          :size="48"
          :stroke-width="1.5"
        />
        <div class="label">
          {{ filter === 'offline' ? 'Aucun titre hors-ligne' : 'Aucun favori' }}
        </div>
        <div class="hint">
          {{
            filter === 'offline'
              ? 'Télécharge un titre depuis l’action sheet « … » pour le retrouver ici.'
              : 'Coche un titre depuis la recherche pour le retrouver ici.'
          }}
        </div>
      </div>
      <div v-else class="track-list">
        <MobileTrackCell
          v-for="t in filteredTracks"
          :key="t.id"
          :track="t"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="lib.isFavorite(t)"
          :download-progress="lib.libraryDownloads.get(t.id)?.progress ?? null"
          @play="playFavoritesFrom(t)"
          @like="lib.toggleFav(t)"
          @more="onMore(t)"
        />
      </div>
    </template>

    <!-- Cards (playlists / albums / artistes / tout) -->
    <template v-else>
      <div v-if="filter === 'playlists'" class="lib-action-row">
        <button class="ghost-row" @click="playlists.create()">
          <Plus :size="22" :stroke-width="2" color="var(--accent)" />
          <span>Nouvelle playlist</span>
        </button>
      </div>

      <MobileSkeleton v-if="lib.loading && lib.tracks.length === 0" variant="card" :count="4" />
      <div v-else-if="filteredCards.length === 0" class="empty-state">
        <LayoutGrid class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Rien ici pour l'instant</div>
        <div class="hint">Ta bibliothèque apparaîtra ici dès que tu ajouteras des titres.</div>
      </div>

      <div v-else class="card-list" :class="{ 'is-grid': viewMode === 'grid' }">
        <div
          v-for="c in filteredCards"
          :key="`${c.kind}-${c.id}`"
          class="lib-card"
          @click="openCard(c)"
        >
          <div
            class="lib-card-cover"
            :class="{ 'is-circle': c.kind === 'artist' }"
            :style="c.cover ? {} : { background: c.gradient }"
          >
            <img v-if="c.cover" :src="apiUrl(c.cover)" alt="" loading="lazy" />
            <component v-else :is="cardIcon(c)" :size="26" :stroke-width="1.8" color="rgba(255,255,255,0.75)" />
          </div>
          <div class="lib-card-meta">
            <div class="lib-card-name text-ellipsis">{{ c.name }}</div>
            <div class="lib-card-sub text-ellipsis">{{ c.subtitle }}</div>
          </div>
          <ChevronRight :size="16" :stroke-width="2" color="var(--text-muted)" />
        </div>
      </div>
    </template>
  </div>
  </van-pull-refresh>
</template>

<style scoped>
.library-view { min-height: 100%; }

/* === Header === Big display title with circular profile avatar + plus
 * action. Same layout vocabulary as every modern mobile music app —
 * the avatar gates profile switching, the title roots the page, the
 * action affords the primary creation gesture. */
.lib-header {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}
.lib-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 0;
  background: var(--accent);
  color: #fff;
  font: 700 15px/1 var(--font-body);
  display: grid;
  place-items: center;
  cursor: pointer;
  flex: 0 0 auto;
}
.lib-avatar:active { transform: scale(0.93); }
.lib-title {
  flex: 1 1 auto;
  margin: 0;
  font: var(--t-display-xl);
  letter-spacing: var(--ls-display);
  color: var(--text);
}
.lib-action {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex: 0 0 auto;
}
.lib-action:active { background: rgba(255,255,255,0.06); }

/* === Filter chips === Outlined pill row, horizontally scrollable. The
 * outlined variant lets the chips breathe and reads as "filter"
 * affordance rather than "primary action". */
.lib-chips {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-3);
  overflow-x: auto;
  scrollbar-width: none;
}
.lib-chips::-webkit-scrollbar { display: none; }

.chip {
  flex: 0 0 auto;
  padding: 7px 16px;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text);
  border: 1px solid rgba(255,255,255,0.15);
  font: 500 14px/1.2 var(--font-body);
  cursor: pointer;
  transition: background var(--motion-short) var(--ease),
              color var(--motion-short) var(--ease),
              border-color var(--motion-short) var(--ease);
}
.chip:active { transform: scale(0.96); }
.chip.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 700;
}

/* === Search === slim, less prominent than before. Lives below the
 * chips so the chips dominate the visual hierarchy at the top of the
 * page. */
.lib-search-row :deep(.van-search) {
  background: var(--bg);
  padding: 0 var(--sp-3) var(--sp-2);
}
.lib-search-row :deep(.van-search__content) {
  background: var(--card);
  border-radius: var(--r-2);
}

/* === Sort + view toggle row === Sort label left (track mode only),
 * grid/list toggle right (cards mode only). */
.lib-sort-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-1) var(--sp-4) var(--sp-2);
}
.lib-sort-btn {
  background: transparent;
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-1) var(--sp-1) 0;
  color: var(--text);
  font: var(--t-meta);
  cursor: pointer;
  border-radius: var(--r-1);
}
.lib-sort-btn:active { color: var(--text-muted); }
.lib-view-toggle {
  width: 32px;
  height: 32px;
  border: 0;
  background: transparent;
  border-radius: var(--r-1);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.lib-view-toggle:active { background: rgba(255,255,255,0.08); }

/* === Action rows + ghost button === unchanged behavior, refined look. */
.lib-action-row { padding: 4px 0; }
.ghost-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: transparent;
  border: 0;
  color: var(--text);
  font: var(--t-subtitle);
  cursor: pointer;
}
.ghost-row:active { background: var(--card-hover); }

/* === Card list (default) === single column, denser, cover + 2-line meta.
 * Circular cover for artists, rounded-square for everything else. */
.card-list { padding: 0 0 var(--sp-4); }
.lib-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
}
.lib-card:active { background: var(--card-hover); }
.lib-card-cover {
  width: 56px;
  height: 56px;
  border-radius: var(--r-1);
  background: var(--card-hover);
  overflow: hidden;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}
.lib-card-cover.is-circle { border-radius: 50%; }
.lib-card-cover img { width: 100%; height: 100%; object-fit: cover; }

/* === Card grid === 2-col with bigger covers + meta below. Same .lib-card
 * children, layout flipped from row to column. */
.card-list.is-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-4);
}
.card-list.is-grid .lib-card {
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-3);
}
.card-list.is-grid .lib-card-cover {
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  border-radius: var(--r-2);
}
.card-list.is-grid .lib-card-cover.is-circle { border-radius: 50%; }
.card-list.is-grid .lib-card-meta { width: 100%; }
.card-list.is-grid :deep(.lucide-chevron-right) { display: none; }

.lib-card-meta { flex: 1 1 auto; min-width: 0; }
.lib-card-name { font-size: 15px; color: var(--text); font-weight: 500; }
.lib-card-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.track-list { padding-bottom: 16px; }
</style>
