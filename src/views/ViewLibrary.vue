<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import {
  ListMusic, Disc3, User, Heart, Plus, LayoutGrid, ArrowDownCircle,
  Download as DownloadIcon, ArrowUpDown, LayoutList, Search as SearchIcon,
  ListPlus, ListEnd, Sparkles, Mic2, Trash2,
} from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { useMixStore } from '@/stores/mix';
import { useProfileStore } from '@/stores/profile';
import { parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
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

// Deliberately just two chips — Playlists + Titres. Albums/Artistes used
// to live here too but cluttered the library; they're still reachable as
// "Parcourir" cards on the Search tab (which set view.libraryFilter and
// land here in an album/artist browse mode, no chip highlighted).
const FILTERS = [
  { id: 'playlists', label: 'Playlists' },
  { id: 'tracks',    label: 'Titres' },
];

const filter = ref('playlists'); // 'playlists' | 'tracks' (+ external 'albums'/'artists')
function tapChip(id) {
  haptics.selection();
  filter.value = id;
}

// Browse cards on the Search tab preset a chip before switching here.
watch(
  () => view.libraryFilter,
  (f) => {
    if (!f) return;
    filter.value = f;
    view.libraryFilter = null;
  },
  { immediate: true },
);

// Search field — hidden behind the header's magnifier, Spotify-style.
const searchOpen = ref(false);
const search = ref('');
function toggleSearch() {
  haptics.light();
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) search.value = '';
}

const refreshing = ref(false);

// Sort options for the track list mode.
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
      { title: 'Trier par' },
    );
    sortMode.value = SORTS[index].id;
  } catch {}
}

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
// "Favoris" virtual card — Spotify's "Liked Songs" indigo gradient tile.
const favoritesCard = computed(() => ({
  kind: 'favorites',
  id: '__favorites__',
  name: 'Favoris',
  subtitle: `Playlist · ${lib.favorites.length} titres`,
  cover: '',
  gradient: 'linear-gradient(135deg, #450af5 0%, #8e8ee5 100%)',
  sortKey: ' a favoris',
}));

const offlineTracks = computed(() => lib.tracks.filter((t) => !!t.file));
const offlineCard = computed(() => ({
  kind: 'offline',
  id: '__offline__',
  name: 'Hors-ligne',
  subtitle: 'Playlist · ' + offlineTracks.value.length + ' titre' + (offlineTracks.value.length > 1 ? 's' : ''),
  cover: '',
  gradient: 'linear-gradient(135deg, #1ED760 0%, #14613a 100%)',
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
      subtitle: 'Artiste',
      gradient: gradientFromString(a.name),
      sortKey: a.name.toLowerCase(),
    }));
});

// ── Search (global, across the whole library) ──────────────────────
// A query searches EVERYTHING regardless of the active chip — typing a
// song title surfaces it even from the Playlists tab. (The old behaviour
// only matched tracks when the Titres chip was selected, so songs never
// showed up otherwise — that was the reported bug.)
const searching = computed(() => !!search.value.trim());

// Tracks shown in the list. Searching → global title/artist match over the
// WHOLE library. Else the Titres chip → EVERY track in the library, not just
// favorites: tracks land here liked:false via playlist/album/mix adds AND
// via _recordPlay folding played streams in, and the user expects "Titres"
// to list all of them. (Favoris stays the curated liked subset, reachable
// via the Favoris tile under Playlists.) The play queue uses whatever shows.
const displayedTracks = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (q) {
    return sortTracks(lib.tracks.filter((t) =>
      (t.title || '').toLowerCase().includes(q)
      || (t.uploader || '').toLowerCase().includes(q),
    ));
  }
  return sortTracks(lib.tracks);
});

// Playlists matching the query — shown as a section above the tracks.
const searchPlaylists = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return [];
  return playlistItems.value
    .filter((c) => c.name.toLowerCase().includes(q) || (c.subtitle || '').toLowerCase().includes(q))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
});

// Cards for the non-search filter. Playlists by default; albums/artists
// only when navigated here from a Search "Parcourir" card.
const filteredCards = computed(() => {
  let list;
  if (filter.value === 'albums') list = albumItems.value;
  else if (filter.value === 'artists') list = artistItems.value;
  else list = playlistItems.value;
  return [...list].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
});

const showingTracks = computed(() => filter.value === 'tracks');

function openCard(card) {
  if (card.kind === 'favorites') view.switchTo('playlist', 'favorites');
  else if (card.kind === 'offline') view.switchTo('playlist', 'offline');
  else if (card.kind === 'playlist') view.switchTo('playlist', card.id);
  else if (card.kind === 'album') view.switchTo('album', card.id);
  else if (card.kind === 'artist') view.switchTo('artist', card.id);
}

function playFavoritesFrom(track) {
  const ids = displayedTracks.value.map((t) => t.id);
  player.playFromList(track.id, ids);
}

async function addToPlaylistFlow(track) {
  const actions = [
    { name: 'Nouvelle playlist', icon: Plus, color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id, icon: ListMusic })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try {
    pick = await sheet.open(actions, { title: 'Ajouter à une playlist', subtitle: track.title });
  } catch { return; }
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, track.id);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, track.id);
  }
}

async function onMore(track) {
  const isFav = lib.isFavorite(track);
  try {
    const { index } = await sheet.open(
      [
        { name: isFav ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: Heart },
        { name: track.file ? 'Disponible hors-ligne' : 'Télécharger', icon: ArrowDownCircle, disabled: !!track.file },
        { name: 'Ajouter à une playlist', icon: ListPlus },
        { name: 'Lancer un mix basé sur ce titre', icon: Sparkles },
        { name: 'Ajouter à la file', icon: ListEnd },
        { name: 'Ouvrir l’artiste', icon: Mic2 },
        { name: 'Supprimer de la bibliothèque', icon: Trash2, color: 'var(--danger)' },
      ],
      { cover: track.thumbnail, title: track.title, subtitle: track.uploader },
    );
    if (index === 0) lib.toggleFav(track);
    else if (index === 1 && !track.file) lib.downloadTrack(track.id);
    else if (index === 2) addToPlaylistFlow(track);
    else if (index === 3) mix.streamFrom(track, () => view.switchTo('mix'));
    else if (index === 4) player.addToQueue(track.id);
    else if (index === 5) {
      const parsed = parseTrackTitle(track);
      const name = parsed.artist || track.uploader;
      if (name) view.switchTo('artist', name);
    } else if (index === 6) {
      lib.remove(track.id);
    }
  } catch { /* dismissed */ }
}

function cardIcon(card) {
  if (card.kind === 'favorites') return Heart;
  if (card.kind === 'offline') return ArrowDownCircle;
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
    <!-- Header — avatar / big bold title / search + create. -->
    <header class="lib-header">
      <button
        class="lib-avatar"
        :style="profile.activeProfile ? { background: profile.activeProfile.color } : null"
        aria-label="Changer de profil"
        @click="openProfilePicker"
      >
        {{ profileInitial }}
      </button>
      <h1 class="lib-title">Ta bibliothèque</h1>
      <button class="lib-action" aria-label="Rechercher" @click="toggleSearch">
        <SearchIcon :size="22" :stroke-width="2.2" color="var(--text)" />
      </button>
      <button class="lib-action" aria-label="Nouvelle playlist" @click="playlists.create()">
        <Plus :size="26" :stroke-width="2" color="var(--text)" />
      </button>
    </header>

    <!-- Filter chips — frosted pills, accent fill when active, tap
         again to deselect (Spotify chip behavior). -->
    <div class="lib-chips">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        class="chip"
        :class="{ active: filter === f.id }"
        @click="tapChip(f.id)"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="searchOpen" class="lib-search-row">
      <van-search
        v-model="search"
        placeholder="Rechercher dans ta bibliothèque"
        shape="round"
        clearable
        autofocus
      />
    </div>

    <!-- Sort + view-mode row (hidden while searching — search has its own
         sections). -->
    <div
      v-if="!searching && ((showingTracks && displayedTracks.length > 0) || (!showingTracks && filteredCards.length > 0))"
      class="lib-sort-row"
    >
      <button v-if="showingTracks" class="lib-sort-btn" @click="pickSort">
        <ArrowUpDown :size="15" :stroke-width="2.2" color="var(--text)" />
        <span>{{ sortLabel }}</span>
      </button>
      <span v-else class="lib-sort-hint">{{ filteredCards.length }} élément{{ filteredCards.length > 1 ? 's' : '' }}</span>
      <button
        v-if="!showingTracks"
        class="lib-view-toggle"
        :aria-label="viewMode === 'list' ? 'Vue grille' : 'Vue liste'"
        @click="toggleViewMode"
      >
        <LayoutGrid v-if="viewMode === 'list'" :size="17" :stroke-width="2" color="var(--text)" />
        <LayoutList v-else :size="17" :stroke-width="2" color="var(--text)" />
      </button>
    </div>

    <!-- SEARCH MODE: global results across the whole library — matching
         playlists (cards) then matching tracks (rows), regardless of chip. -->
    <template v-if="searching">
      <template v-if="searchPlaylists.length">
        <div class="lib-results-head">Playlists</div>
        <div class="card-list">
          <div
            v-for="c in searchPlaylists"
            :key="`${c.kind}-${c.id}`"
            class="lib-card"
            @click="openCard(c)"
          >
            <div class="lib-card-cover" :style="c.cover ? {} : { background: c.gradient }">
              <img v-if="c.cover" :src="apiUrl(c.cover)" alt="" loading="lazy" />
              <component v-else :is="cardIcon(c)" :size="24" :stroke-width="2" color="#ffffff" :fill="c.kind === 'favorites' ? '#ffffff' : 'transparent'" />
            </div>
            <div class="lib-card-meta">
              <div class="lib-card-name text-ellipsis">{{ c.name }}</div>
              <div class="lib-card-sub text-ellipsis">{{ c.subtitle }}</div>
            </div>
          </div>
        </div>
      </template>

      <template v-if="displayedTracks.length">
        <div class="lib-results-head">Titres</div>
        <div class="track-list">
          <MobileTrackCell
            v-for="t in displayedTracks"
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

      <div v-if="!searchPlaylists.length && !displayedTracks.length" class="empty-state">
        <SearchIcon class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Aucun résultat</div>
        <div class="hint">Rien dans ta bibliothèque pour « {{ search }} ».</div>
      </div>
    </template>

    <!-- TITRES chip — TOUS les titres de la bibliothèque -->
    <template v-else-if="showingTracks">
      <MobileSkeleton v-if="lib.loading && lib.tracks.length === 0" variant="row" :count="8" />
      <div v-else-if="displayedTracks.length === 0" class="empty-state">
        <ListMusic class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Aucun titre</div>
        <div class="hint">Écoute ou ajoute un titre et il apparaîtra ici.</div>
      </div>
      <div v-else class="track-list">
        <MobileTrackCell
          v-for="t in displayedTracks"
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

    <!-- PLAYLISTS chip (+ albums/artistes en mode browse depuis Search) -->
    <template v-else>
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
            <component
              v-else
              :is="cardIcon(c)"
              :size="24"
              :stroke-width="2"
              color="#ffffff"
              :fill="c.kind === 'favorites' ? '#ffffff' : 'transparent'"
            />
          </div>
          <div class="lib-card-meta">
            <div class="lib-card-name text-ellipsis">{{ c.name }}</div>
            <div class="lib-card-sub text-ellipsis">{{ c.subtitle }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
  </van-pull-refresh>
</template>

<style scoped>
.library-view { min-height: 100%; }

/* === Header === */
.lib-header {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 10px 16px 12px;
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
  font: 800 24px/1.1 var(--font-display);
  letter-spacing: -0.4px;
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

/* Section header inside the search-results list (Playlists / Titres). */
.lib-results-head {
  font: 700 16px/1.2 var(--font-display);
  color: var(--text);
  padding: 14px 16px 6px;
}

/* === Filter chips === frosted pills, accent fill when active. */
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
  padding: 8px 16px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  border: 0;
  font: 500 13px/1.2 var(--font-body);
  cursor: pointer;
  transition: background var(--motion-short) var(--ease),
              color var(--motion-short) var(--ease);
}
.chip:active { transform: scale(0.96); }
.chip.active {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
}

.lib-search-row :deep(.van-search) {
  background: transparent;
  padding: 0 var(--sp-3) var(--sp-2);
}
.lib-search-row :deep(.van-search__content) {
  background: var(--card);
  border-radius: var(--r-2);
}

/* === Sort + view toggle row === */
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
  font: 600 13px/1.2 var(--font-body);
  cursor: pointer;
  border-radius: var(--r-1);
}
.lib-sort-btn:active { opacity: 0.6; }
.lib-sort-hint {
  font: 400 12px/1.2 var(--font-body);
  color: var(--text-muted);
}
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

/* === Card list === */
.card-list { padding: 0 0 var(--sp-4); }
.lib-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
}
.lib-card:active { background: rgba(255,255,255,0.06); }
.lib-card-cover {
  width: 64px;
  height: 64px;
  border-radius: 4px;
  background: var(--card);
  overflow: hidden;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}
.lib-card-cover.is-circle { border-radius: 50%; }
.lib-card-cover img { width: 100%; height: 100%; object-fit: cover; }

/* === Card grid === 2 equal columns. minmax(0, 1fr) — NOT 1fr — is
 * critical: 1fr = minmax(auto, 1fr), where `auto` grows a column to its
 * content's min-content width. A long unbreakable playlist name (nowrap)
 * then blows the column past the viewport, so you see one giant card with
 * the rest off-screen. minmax(0,...) lets columns shrink to a true 50/50,
 * and the name's ellipsis clips inside the half-width cell. */
.card-list.is-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-5) var(--sp-3);
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
}
.card-list.is-grid .lib-card {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
  padding: 0;
  border-radius: 0;
  min-width: 0; /* allow the grid item to shrink below its content width */
}
.card-list.is-grid .lib-card:active { background: transparent; opacity: 0.7; }
.card-list.is-grid .lib-card-cover {
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  border-radius: 6px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}
.card-list.is-grid .lib-card-cover.is-circle { border-radius: 50%; box-shadow: none; }
.card-list.is-grid .lib-card-cover :deep(svg),
.card-list.is-grid .lib-card-cover > svg { width: 38px; height: 38px; }
.card-list.is-grid .lib-card-meta { width: 100%; min-width: 0; }
.card-list.is-grid .lib-card-name { font-size: 15px; font-weight: 600; }
.card-list.is-grid .lib-card-sub { font-size: 12px; }

.lib-card-meta { flex: 1 1 auto; min-width: 0; }
.lib-card-name {
  font: 500 16px/1.3 var(--font-body);
  color: var(--text);
}
.lib-card-sub {
  font: 400 13px/1.3 var(--font-body);
  color: var(--text-muted);
  margin-top: 3px;
}

.track-list { padding-bottom: 16px; }
</style>
