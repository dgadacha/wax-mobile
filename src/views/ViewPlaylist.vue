<script setup>
import { computed } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import {
  Plus, MoreVertical, ListMusic, ArrowDownCircle, ListPlus, ListEnd,
  Sparkles, Mic2, Trash2, Pencil, Download as DownloadIcon, Eraser,
} from 'lucide-vue-next';
import { useActionSheetStore } from '@/stores/actionSheet';

const sheet = useActionSheetStore();
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { useMixStore } from '@/stores/mix';
import { gradientFromString, fmtDuration, parseTrackTitle } from '@/lib/format';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { openComponentModal, closeModal } from '@/lib/modal';
import BulkAddBody from '@/components/BulkAddBody.vue';

const view = useViewStore();
const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();
const mix = useMixStore();

// Virtual playlists — Favoris and Hors-ligne route through this view
// (via view.switchTo('playlist', 'favorites' | 'offline')) so they get
// the exact same hero / back arrow / scroll behavior as a real playlist.
const VIRTUAL = {
  favorites: { id: 'favorites', name: 'Favoris',    isVirtual: true, kind: 'favorites' },
  offline:   { id: 'offline',   name: 'Hors-ligne', isVirtual: true, kind: 'offline' },
};
const virtual = computed(() => VIRTUAL[view.selectedPlaylistId] || null);

const virtualTracks = computed(() => {
  if (!virtual.value) return [];
  if (virtual.value.kind === 'favorites') return lib.favorites;
  if (virtual.value.kind === 'offline') return lib.tracks.filter((t) => !!t.file);
  return [];
});

const playlist = computed(() => {
  if (virtual.value) {
    const ids = virtualTracks.value.map((t) => t.id);
    return { ...virtual.value, trackIds: ids };
  }
  return playlists.findById(view.selectedPlaylistId);
});
const tracks = computed(() => {
  if (!playlist.value) return [];
  if (virtual.value) return virtualTracks.value;
  return playlist.value.trackIds.map((id) => lib.findById(id)).filter(Boolean);
});
const queueIds = computed(() => tracks.value.map((t) => t.id));
const totalDuration = computed(() => tracks.value.reduce((s, t) => s + (t.duration || 0), 0));

const coverUrl = computed(() => tracks.value[0]?.thumbnail || '');
const bgGradient = computed(() => playlist.value ? gradientFromString(playlist.value.name) : '');

const emptyLabel = computed(() => {
  if (virtual.value?.kind === 'favorites') return 'Aucun favori';
  if (virtual.value?.kind === 'offline') return 'Aucun titre hors-ligne';
  return 'Playlist vide';
});
const emptyHint = computed(() => {
  if (virtual.value?.kind === 'favorites') {
    return 'Coche un titre depuis la recherche pour le retrouver ici.';
  }
  if (virtual.value?.kind === 'offline') {
    return 'Télécharge un titre depuis le menu « ⋮ » pour le retrouver ici.';
  }
  return 'Ajoute des titres depuis tes favoris ou la recherche.';
});

const inFlightCount = computed(() => {
  if (!playlist.value) return 0;
  let n = 0;
  for (const id of playlist.value.trackIds) {
    if (lib.libraryDownloads.has(id)) n++;
  }
  return n;
});
const downloadedCount = computed(() =>
  tracks.value.filter((t) => !!t.file).length,
);
const meta = computed(() => {
  if (!playlist.value) return '';
  const n = tracks.value.length;
  if (n === 0) return 'Playlist vide';
  const base = `${n} titre${n > 1 ? 's' : ''} · ${fmtDuration(totalDuration.value)}`;
  if (inFlightCount.value > 0) {
    return `${base} · ${downloadedCount.value}/${n} hors-ligne · ${inFlightCount.value} en file`;
  }
  if (downloadedCount.value === n) return `${base} · Tout hors-ligne`;
  if (downloadedCount.value > 0) return `${base} · ${downloadedCount.value}/${n} hors-ligne`;
  return base;
});

// Hero FAB: pause glyph + toggle when this playlist is the live
// context, otherwise (re)start the whole list — Spotify behavior.
const isCurrentContext = computed(() =>
  !!player.currentTrack && queueIds.value.includes(player.currentTrack.id),
);
const heroPlaying = computed(() => player.playing && isCurrentContext.value);
function onHeroPlay() {
  if (queueIds.value.length === 0) return;
  if (isCurrentContext.value) player.togglePlay();
  else player.playFromList(queueIds.value[0], queueIds.value);
}

function playTrack(t) {
  player.playFromList(t.id, queueIds.value);
}

function isLiked(t) { return lib.isFavorite(t); }

async function onMore() {
  if (!playlist.value) return;
  const header = {
    cover: coverUrl.value,
    title: playlist.value.name,
    subtitle: meta.value,
  };
  if (virtual.value) {
    try {
      const items = virtual.value.kind === 'offline'
        ? [{ name: 'Nettoyer les orphelins', icon: Eraser }]
        : [{ name: 'Tout télécharger', icon: DownloadIcon }];
      const { index } = await sheet.open(items, header);
      if (virtual.value.kind === 'offline') {
        if (index === 0) {
          const removed = await lib.purgeOrphans();
          showToast({
            message: removed
              ? `${removed} titre${removed > 1 ? 's' : ''} nettoyé${removed > 1 ? 's' : ''}`
              : 'Rien à nettoyer',
            position: 'bottom',
          });
        }
      } else {
        if (index === 0) downloadAll();
      }
    } catch { /* dismissed */ }
    return;
  }
  try {
    const { index } = await sheet.open([
      { name: 'Ajouter des titres', icon: ListPlus },
      { name: 'Réorganiser avec l’IA', icon: Sparkles, color: 'var(--accent)' },
      { name: 'Tout télécharger', icon: DownloadIcon },
      { name: 'Renommer', icon: Pencil },
      { name: 'Supprimer la playlist', icon: Trash2, color: 'var(--danger)' },
    ], header);
    if (index === 0) addTracks();
    else if (index === 1) reorderWithAI();
    else if (index === 2) downloadAll();
    else if (index === 3) playlists.rename(playlist.value.id);
    else if (index === 4) deleteThis();
  } catch { /* dismissed */ }
}

// AI reorder — DJ-style flow (uses mood/energy tags when present).
async function reorderWithAI() {
  const pl = playlist.value;
  if (!pl || virtual.value) return; // real playlists only
  const toast = showToast({ message: 'Réorganisation…', type: 'loading', duration: 0, forbidClick: true });
  try {
    const { reordered } = await playlists.reorderWithAI(pl.id);
    toast.close();
    showToast({ message: `Playlist réorganisée · ${reordered} titres`, position: 'bottom' });
  } catch (e) {
    toast.close();
    showToast({ message: 'Erreur : ' + (e.message || 'inconnue'), position: 'bottom' });
  }
}

// Track-level action sheet — same options across every track context,
// only the trailing danger action's label is contextual.
async function onTrackMore(t) {
  if (!playlist.value) return;
  let dangerLabel = 'Retirer de la playlist';
  if (virtual.value?.kind === 'favorites') dangerLabel = 'Retirer des favoris';
  else if (virtual.value?.kind === 'offline') dangerLabel = 'Supprimer du cache';
  try {
    const { index } = await sheet.open(
      [
        { name: t.file ? 'Disponible hors-ligne' : 'Télécharger', icon: ArrowDownCircle, disabled: !!t.file },
        { name: 'Ajouter à une playlist', icon: ListPlus },
        { name: 'Lancer un mix basé sur ce titre', icon: Sparkles },
        { name: 'Ajouter à la file', icon: ListEnd },
        { name: 'Ouvrir l’artiste', icon: Mic2 },
        { name: dangerLabel, icon: Trash2, color: 'var(--danger)' },
      ],
      { cover: t.thumbnail, title: t.title, subtitle: t.uploader },
    );
    if (index === 0 && !t.file) lib.downloadTrack(t.id);
    else if (index === 1) addTrackToPlaylistFlow(t);
    else if (index === 2) mix.streamFrom(t, () => view.switchTo('mix'));
    else if (index === 3) player.addToQueue(t.id);
    else if (index === 4) {
      const a = parseTrackTitle(t).artist || t.uploader;
      if (a) view.switchTo('artist', a);
    } else if (index === 5) {
      if (virtual.value?.kind === 'favorites') lib._setLiked(t.id, false);
      else if (virtual.value?.kind === 'offline') lib.removeDownload(t.id);
      else playlists.removeTrack(playlist.value.id, t.id);
    }
  } catch {}
}

async function addTrackToPlaylistFlow(t) {
  const actions = [
    { name: 'Nouvelle playlist', icon: Plus, color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id, icon: ListMusic })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try {
    pick = await sheet.open(actions, { title: 'Ajouter à une playlist', subtitle: t.title });
  } catch { return; }
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, t.id);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, t.id);
  }
}

function addTracks() {
  if (!playlist.value) return;
  const pl = playlist.value;
  const available = lib.tracks.filter((t) => !pl.trackIds.includes(t.id));
  if (available.length === 0) return;
  const selection = new Set();
  openComponentModal({
    title: `Ajouter à ${pl.name}`,
    component: BulkAddBody,
    componentProps: { available, selection },
    confirmLabel: 'Ajouter',
    wide: true,
    onConfirm: async () => {
      if (selection.size === 0) return;
      const ok = await playlists.addTracksBulk(pl.id, Array.from(selection));
      if (ok) closeModal();
    },
  });
}

async function downloadAll() {
  if (!playlist.value) return;
  const todo = playlist.value.trackIds
    .map((id) => lib.findById(id))
    .filter((tr) => tr && !tr.file && !lib.libraryDownloads.has(tr.id));
  if (todo.length === 0) {
    showToast({ message: 'Déjà tout hors-ligne', position: 'bottom' });
    return;
  }
  showToast({
    message: `${todo.length} titre${todo.length > 1 ? 's' : ''} en file de téléchargement`,
    position: 'bottom',
  });
  for (const tr of todo) lib.downloadTrack(tr.id);
}

async function deleteThis() {
  if (!playlist.value) return;
  try {
    await showConfirmDialog({
      title: 'Supprimer',
      message: `Supprimer la playlist «${playlist.value.name}» ?`,
      confirmButtonText: 'Supprimer',
      cancelButtonText: 'Annuler',
      confirmButtonColor: 'var(--danger)',
    });
    await playlists.remove.call(playlists, playlist.value.id);
  } catch {}
}
</script>

<template>
  <div v-if="playlist" class="playlist-view">
    <MobileHero
      :cover="coverUrl"
      :bg-gradient="bgGradient"
      :title="playlist.name"
      :meta="meta"
      :playing="heroPlaying"
      @play="onHeroPlay"
    >
      <template #actions>
        <button
          class="hero-icon-btn"
          :aria-label="downloadedCount === tracks.length && tracks.length > 0 ? 'Tout hors-ligne' : 'Tout télécharger'"
          @click="downloadAll"
        >
          <ArrowDownCircle
            :size="24"
            :stroke-width="1.8"
            :color="downloadedCount === tracks.length && tracks.length > 0 ? 'var(--accent)' : 'var(--text-muted)'"
          />
        </button>
        <button
          v-if="!virtual"
          class="hero-icon-btn"
          aria-label="Ajouter des titres"
          @click="addTracks"
        >
          <Plus :size="24" :stroke-width="1.8" color="var(--text-muted)" />
        </button>
        <button class="hero-icon-btn" aria-label="Plus" @click="onMore">
          <MoreVertical :size="24" :stroke-width="1.8" color="var(--text-muted)" />
        </button>
      </template>
    </MobileHero>

    <div v-if="tracks.length === 0" class="empty-state">
      <ListMusic class="icon" :size="48" :stroke-width="1.5" />
      <div class="label">{{ emptyLabel }}</div>
      <div class="hint">{{ emptyHint }}</div>
    </div>

    <div v-else class="track-list">
      <MobileTrackCell
        v-for="t in tracks"
        :key="t.id"
        :track="t"
        variant="thumb"
        :is-playing="player.currentTrack && player.currentTrack.id === t.id"
        :is-liked="isLiked(t)"
        :download-progress="lib.libraryDownloads.get(t.id)?.progress ?? null"
        @play="playTrack(t)"
        @like="lib.toggleFav(t)"
        @more="onTrackMore(t)"
      />
    </div>

  </div>
</template>

<style scoped>
.playlist-view { min-height: 100%; padding-bottom: 16px; }
.hero-icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.hero-icon-btn:active { opacity: 0.6; }
</style>
