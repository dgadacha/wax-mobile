<script setup>
import { computed } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Plus, MoreHorizontal, ListMusic } from 'lucide-vue-next';
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
// the exact same hero / back arrow / scroll behavior as a real
// playlist. We synthesize a playlist-shaped object on the fly and
// flag it `isVirtual` so the action menus can hide rename/delete and
// swap "Retirer de la playlist" for the right semantic per kind.
const VIRTUAL = {
  favorites: { id: 'favorites', name: 'Favoris',    eyebrow: 'Bibliothèque', isVirtual: true, kind: 'favorites' },
  offline:   { id: 'offline',   name: 'Hors-ligne', eyebrow: 'Bibliothèque', isVirtual: true, kind: 'offline' },
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
const eyebrow = computed(() => virtual.value?.eyebrow || 'Playlist');

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
    return 'Télécharge un titre depuis l’action sheet « … » pour le retrouver ici.';
  }
  return 'Ajoute des titres depuis tes favoris ou la recherche.';
});

// "Tout télécharger" doesn't have its own batch state — we derive it
// from libraryDownloads on the playlist tracks. While at least one is
// in flight, surface "Téléchargement X/Y" in the hero subtitle.
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
const subtitle = computed(() => {
  if (!playlist.value) return '';
  const n = tracks.value.length;
  if (n === 0) return 'Playlist vide';
  const base = `${n} titre${n > 1 ? 's' : ''} · ${fmtDuration(totalDuration.value)}`;
  if (inFlightCount.value > 0) {
    // Show both axes so "0/50" doesn't read as "nothing's happening"
    // during the long wait between click and the first finished MP3.
    return `${base}  ·  ${downloadedCount.value}/${n} hors-ligne · ${inFlightCount.value} en file`;
  }
  if (downloadedCount.value === n) return `${base}  ·  Tout hors-ligne`;
  if (downloadedCount.value > 0) return `${base}  ·  ${downloadedCount.value}/${n} hors-ligne`;
  return base;
});

function playAll() {
  if (queueIds.value.length === 0) return;
  player.playFromList(queueIds.value[0], queueIds.value);
}

function playTrack(t) {
  player.playFromList(t.id, queueIds.value);
}

function isLiked(t) { return lib.isFavorite(t); }

async function onMore() {
  if (!playlist.value) return;
  // Virtual playlists (Favoris / Hors-ligne) skip rename / delete /
  // bulk-add — those only make sense for user-created playlists.
  if (virtual.value) {
    try {
      const items = virtual.value.kind === 'offline'
        ? [{ name: 'Nettoyer les orphelins' }]
        : [{ name: 'Tout télécharger' }];
      const { index } = await sheet.open(items);
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
      { name: 'Ajouter des titres' },
      { name: 'Tout télécharger' },
      { name: 'Renommer' },
      { name: 'Supprimer la playlist', color: 'var(--danger)' },
    ]);
    if (index === 0) addTracks();
    else if (index === 1) downloadAll();
    else if (index === 2) playlists.rename(playlist.value.id);
    else if (index === 3) deleteThis();
  } catch { /* dismissed */ }
}

// Track-level action sheet. Same options across every track context
// (favoris, hors-ligne, playlist, playlist-from-mix) so there's only
// one menu to learn — only the trailing danger action's label is
// contextual (Retirer de la playlist / des favoris / du cache).
async function onTrackMore(t) {
  if (!playlist.value) return;
  let dangerLabel = 'Retirer de la playlist';
  if (virtual.value?.kind === 'favorites') dangerLabel = 'Retirer des favoris';
  else if (virtual.value?.kind === 'offline') dangerLabel = 'Supprimer du cache';
  try {
    const { index } = await sheet.open([
      { name: t.file ? 'Disponible hors-ligne ✓' : 'Télécharger', disabled: !!t.file },
      { name: 'Ajouter à une playlist' },
      { name: 'Lancer un mix basé sur ce titre' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
      { name: dangerLabel, color: 'var(--danger)' },
    ]);
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

// Per-track add to a playlist (vs the bulk "Ajouter des titres" on
// the hero, which is whole-list). Mirrors ViewLibrary.addToPlaylistFlow.
async function addTrackToPlaylistFlow(t) {
  const actions = [
    { name: '＋ Nouvelle playlist', color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try { pick = await sheet.open(actions); } catch { return; }
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
  // Confirm to the user that the request landed — the pool throttles
  // to 4 simultaneous SSE connections so the first ready event can take
  // ~30 s, plenty of time to make the page look broken otherwise.
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
    await playlists.remove.call(playlists, playlist.value.id); // legacy uses its own modal
  } catch {}
}
</script>

<template>
  <div v-if="playlist" class="playlist-view">
    <MobileHero
      :cover="coverUrl"
      :bg-gradient="bgGradient"
      :eyebrow="eyebrow"
      :title="playlist.name"
      :subtitle="subtitle"
      @play="playAll"
    >
      <template #actions>
        <!-- "+" hidden for virtual Favoris/Hors-ligne — they're
             auto-populated, not user-curated. -->
        <button
          v-if="!virtual"
          class="hero-icon-btn"
          aria-label="Ajouter"
          @click="addTracks"
        >
          <Plus :size="20" :stroke-width="2.2" color="var(--text)" />
        </button>
        <button class="hero-icon-btn" aria-label="Plus" @click="onMore">
          <MoreHorizontal :size="20" :stroke-width="2.2" color="var(--text)" />
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
        v-for="(t, i) in tracks"
        :key="t.id"
        :track="t"
        :index="i"
        variant="index"
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
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  display: grid;
  place-items: center;
}
.hero-icon-btn:active { background: rgba(255, 255, 255, 0.16); }
</style>
