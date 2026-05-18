<script setup>
import { computed, ref } from 'vue';
import { showConfirmDialog } from 'vant';
import {
  ListMusic, Disc3, User, Heart, Plus, ChevronRight, LayoutGrid,
} from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { useViewStore } from '@/stores/view';
import { useMixStore } from '@/stores/mix';
import { fmtDuration, parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { useActionSheetStore } from '@/stores/actionSheet';

const mix = useMixStore();
const sheet = useActionSheetStore();

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();
const view = useViewStore();

const FILTERS = [
  { id: 'all',       label: 'Tout' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'albums',    label: 'Albums' },
  { id: 'artists',   label: 'Artistes' },
  { id: 'tracks',    label: 'Titres' },
];

const filter = ref('all');
const search = ref('');

// ── Playlists ──────────────────────────────────────────────────────
const playlistItems = computed(() => playlists.items.map((pl) => {
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
}));

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

// ── Tracks (favoris) ───────────────────────────────────────────────
const trackItems = computed(() => lib.favorites);

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

const showingTracks = computed(() => filter.value === 'tracks');

function openCard(card) {
  if (card.kind === 'playlist') view.switchTo('playlist', card.id);
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

async function onMore(track) {
  try {
    const { index } = await sheet.open([
      { name: track.file ? 'Disponible hors-ligne ✓' : 'Télécharger', disabled: !!track.file },
      { name: 'Lancer un mix basé sur ce titre' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
      { name: 'Retirer des favoris', color: 'var(--danger)' },
    ]);
    if (index === 0 && !track.file) lib.downloadTrack(track.id);
    else if (index === 1) mix.streamFrom(track, () => view.switchTo('mix'));
    else if (index === 2) player.addToQueue(track.id);
    else if (index === 3) {
      const parsed = parseTrackTitle(track);
      const name = parsed.artist || track.uploader;
      if (name) view.switchTo('artist', name);
    } else if (index === 4) {
      lib.remove(track.id);
    }
  } catch { /* dismissed */ }
}

function cardIcon(card) {
  if (card.kind === 'playlist') return ListMusic;
  if (card.kind === 'album') return Disc3;
  if (card.kind === 'artist') return User;
  return LayoutGrid;
}
</script>

<template>
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

    <!-- Tracks (favoris) -->
    <template v-if="showingTracks">
      <div v-if="filteredTracks.length === 0" class="empty-state">
        <Heart class="icon" :size="48" :stroke-width="1.5" />
        <div class="label">Aucun favori</div>
        <div class="hint">Coche un titre depuis la recherche pour le retrouver ici.</div>
      </div>
      <div v-else class="track-list">
        <MobileTrackCell
          v-for="t in filteredTracks"
          :key="t.id"
          :track="t"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="true"
          @play="playFavoritesFrom(t)"
          @like="lib.remove(t.id)"
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

      <div v-if="filteredCards.length === 0" class="empty-state">
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
    </template>
  </div>
</template>

<style scoped>
.library-view { min-height: 100%; }

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
