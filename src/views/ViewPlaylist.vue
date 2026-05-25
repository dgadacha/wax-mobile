<script setup>
import { computed } from 'vue';
import { showConfirmDialog } from 'vant';
import { Plus, MoreHorizontal, ListMusic } from 'lucide-vue-next';
import { useActionSheetStore } from '@/stores/actionSheet';

const sheet = useActionSheetStore();
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePlayerStore } from '@/stores/player';
import { gradientFromString, fmtDuration, parseTrackTitle } from '@/lib/format';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { openComponentModal, closeModal } from '@/lib/modal';
import BulkAddBody from '@/components/BulkAddBody.vue';

const view = useViewStore();
const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();

const playlist = computed(() => playlists.findById(view.selectedPlaylistId));
const tracks = computed(() => {
  if (!playlist.value) return [];
  return playlist.value.trackIds.map((id) => lib.findById(id)).filter(Boolean);
});
const queueIds = computed(() => tracks.value.map((t) => t.id));
const totalDuration = computed(() => tracks.value.reduce((s, t) => s + (t.duration || 0), 0));

const coverUrl = computed(() => tracks.value[0]?.thumbnail || '');
const bgGradient = computed(() => playlist.value ? gradientFromString(playlist.value.name) : '');

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
    return `${base}  ·  Téléchargement ${downloadedCount.value}/${n}`;
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

async function onTrackMore(t) {
  if (!playlist.value) return;
  try {
    const { index } = await sheet.open([
      { name: t.file ? 'Disponible hors-ligne ✓' : 'Télécharger', disabled: !!t.file },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
      { name: 'Retirer de la playlist', color: 'var(--danger)' },
    ]);
    if (index === 0 && !t.file) lib.downloadTrack(t.id);
    else if (index === 1) player.addToQueue(t.id);
    else if (index === 2) {
      const a = parseTrackTitle(t).artist || t.uploader;
      if (a) view.switchTo('artist', a);
    } else if (index === 3) {
      playlists.removeTrack(playlist.value.id, t.id);
    }
  } catch {}
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
  if (todo.length === 0) return;
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
      eyebrow="Playlist"
      :title="playlist.name"
      :subtitle="subtitle"
      @play="playAll"
    >
      <template #actions>
        <button class="hero-icon-btn" aria-label="Ajouter" @click="addTracks">
          <Plus :size="20" :stroke-width="2.2" color="var(--text)" />
        </button>
        <button class="hero-icon-btn" aria-label="Plus" @click="onMore">
          <MoreHorizontal :size="20" :stroke-width="2.2" color="var(--text)" />
        </button>
      </template>
    </MobileHero>

    <div v-if="tracks.length === 0" class="empty-state">
      <ListMusic class="icon" :size="48" :stroke-width="1.5" />
      <div class="label">Playlist vide</div>
      <div class="hint">Ajoute des titres depuis tes favoris ou la recherche.</div>
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
        @like="lib.toggleFav(t.id)"
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
