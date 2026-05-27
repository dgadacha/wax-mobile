<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import {
  ListMusic, Disc3, User, Heart, Plus, ChevronRight, LayoutGrid,
  Download as DownloadIcon, ArrowDownAZ, MoreHorizontal,
} from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { useMixStore } from '@/stores/mix';
import { fmtDuration, parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import MobileSkeleton from '@/components/MobileSkeleton.vue';
import MobileHero from '@/components/MobileHero.vue';
import { useActionSheetStore } from '@/stores/actionSheet';

const mix = useMixStore();
const sheet = useActionSheetStore();

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();
const view = useViewStore();

// Track-list ("Favoris" / "Hors-ligne") moved out of the chip row when
// those views got promoted to full pages via ViewPlaylist's virtual
// id path. Card grid filters stay here.
const FILTERS = [
  { id: 'playlists', label: 'Playlists' },
  { id: 'all',       label: 'Tout' },
  { id: 'albums',    label: 'Albums' },
  { id: 'artists',   label: 'Artistes' },
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

// Card-grid filter. Favoris and Hors-ligne are virtual cards that
// navigate to ViewPlaylist on tap — no inline track-list mode here
// anymore.
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

function openCard(card) {
  // Favoris and Hors-ligne now route through ViewPlaylist via virtual
  // ids — same hero, back arrow, nav-bar title, all the trimmings.
  // The in-place track-list mode that used to live here got removed.
  if (card.kind === 'favorites') view.switchTo('playlist', 'favorites');
  else if (card.kind === 'offline') view.switchTo('playlist', 'offline');
  else if (card.kind === 'playlist') view.switchTo('playlist', card.id);
  else if (card.kind === 'album') view.switchTo('album', card.id);
  else if (card.kind === 'artist') view.switchTo('artist', card.id);
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
    <div class="lib-toolbar">
      <van-search
        v-model="search"
        placeholder="Rechercher dans ta bibliothèque"
        shape="round"
        clearable
      />
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
    </div>

    <!-- Cards (playlists / albums / artistes / tout). Favoris and
         Hors-ligne are virtual cards in the Playlists tab that route
         through ViewPlaylist for their dedicated page. -->
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

    <div v-else class="card-list">
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
  </div>
  </van-pull-refresh>
</template>

<style scoped>
.library-view { min-height: 100%; }

/* Hero action buttons (Favoris / Hors-ligne): same circular outlined
 * style as ViewPlaylist so the row of +/.../play reads consistently
 * across views. Kept scoped (not promoted to a shared component yet)
 * because each view scopes its own header chrome. */
.hero-icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  display: grid;
  place-items: center;
}
.hero-icon-btn:active { background: rgba(255, 255, 255, 0.16); }

.lib-toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg);
  padding-bottom: 6px;
}
.lib-toolbar :deep(.van-search) {
  background: var(--bg);
  padding: 8px 12px 4px;
}
.lib-toolbar :deep(.van-search__content) { background: var(--card); }

.lib-sort-row {
  display: flex;
  justify-content: flex-end;
  padding: 0 var(--sp-4) var(--sp-2);
}
.lib-sort-btn {
  background: transparent;
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--r-1);
}
.lib-sort-btn:active { background: var(--card-hover); }

.lib-chips {
  display: flex;
  gap: 8px;
  padding: 4px 12px 10px;
  overflow-x: auto;
  scrollbar-width: none;
}
.lib-chips::-webkit-scrollbar { display: none; }

.chip {
  flex: 0 0 auto;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--card);
  color: var(--text-soft);
  border: 1px solid var(--border);
  font-size: 13px;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.chip.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 600;
}

.lib-action-row { padding: 4px 0; }
.ghost-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: transparent;
  border: 0;
  color: var(--text);
  font-size: 15px;
  cursor: pointer;
}
.ghost-row:active { background: var(--card-hover); }

.card-list { padding-bottom: 16px; }
.lib-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
}
.lib-card:active { background: var(--card-hover); }
.lib-card-cover {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  background: var(--card-hover);
  overflow: hidden;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}
.lib-card-cover.is-circle { border-radius: 50%; }
.lib-card-cover img { width: 100%; height: 100%; object-fit: cover; }

.lib-card-meta { flex: 1 1 auto; min-width: 0; }
.lib-card-name { font-size: 15px; color: var(--text); font-weight: 500; }
.lib-card-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

.track-list { padding-bottom: 16px; }
</style>
