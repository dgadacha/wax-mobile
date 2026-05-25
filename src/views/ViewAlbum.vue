<script setup>
import { computed, ref, watch } from 'vue';
import { MoreHorizontal } from 'lucide-vue-next';
import { useActionSheetStore } from '@/stores/actionSheet';

const sheet = useActionSheetStore();
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useStreamsStore } from '@/stores/streams';
import { api } from '@/lib/api';
import { fmtDuration, gradientFromString, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { promptModal } from '@/lib/modal';
import { showToast } from '@/lib/toast';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import MobileSkeleton from '@/components/MobileSkeleton.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const streams = useStreamsStore();

const album = computed(() => {
  const key = view.selectedAlbumKey;
  if (!key) return null;
  const libTracks = lib.albumByKey(key);
  if (libTracks.length === 0) return null;
  const first = libTracks[0];
  return {
    key,
    name: first.album,
    artist: parseTrackTitle(first).artist || first.uploader || '',
    albumId: first.albumId || null,
    coverUrl: first.albumCoverUrl || null,
    releaseDate: first.albumReleaseDate || null,
    libTracks,
  };
});

const coverUrl = computed(() => {
  if (!album.value) return '';
  return album.value.coverUrl || album.value.libTracks[0]?.thumbnail || '';
});
const bgGradient = computed(() => album.value ? gradientFromString(album.value.name) : '');

// Deezer remote tracklist for canonical order + "missing tracks" rows.
const remoteTracks = ref([]);
const tracklistLoading = ref(false);
async function loadTracklist() {
  remoteTracks.value = [];
  if (!album.value || !album.value.albumId) return;
  tracklistLoading.value = true;
  try {
    const data = await api(`/api/album-tracklist?albumId=${album.value.albumId}`);
    if (Array.isArray(data.tracks)) remoteTracks.value = data.tracks;
  } catch { /* swallow */ }
  finally { tracklistLoading.value = false; }
}
watch(() => view.selectedAlbumKey, loadTracklist, { immediate: true });

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*[\[\(](feat\.?|ft\.?|featuring|with)[^)\]]*[\]\)]/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

const albumEntries = computed(() => {
  if (!album.value) return [];
  if (remoteTracks.value.length === 0) {
    return album.value.libTracks.map((tr, i) => ({
      key: `lib-${tr.id}`,
      index: i,
      title: tr.title,
      length: (tr.duration || 0) * 1000,
      libTrack: tr,
    }));
  }
  const byTitle = new Map();
  for (const tr of album.value.libTracks) byTitle.set(normalizeTitle(parseTrackTitle(tr).song), tr);
  return remoteTracks.value.map((r, i) => ({
    key: `${r.recordingId || r.title}-${i}`,
    index: i,
    title: r.title,
    length: r.length,
    libTrack: byTitle.get(normalizeTitle(r.title)) || null,
  }));
});

const libQueueIds = computed(() => album.value ? album.value.libTracks.map((t) => t.id) : []);
const totalDuration = computed(() => {
  if (!album.value) return 0;
  if (albumEntries.value.length > 0) {
    return albumEntries.value.reduce((s, e) => s + ((e.length || 0) / 1000), 0);
  }
  return album.value.libTracks.reduce((s, t) => s + (t.duration || 0), 0);
});

const subtitle = computed(() => {
  if (!album.value) return '';
  const year = album.value.releaseDate ? album.value.releaseDate.slice(0, 4) : '';
  const count = albumEntries.value.length || album.value.libTracks.length;
  const parts = [];
  if (year) parts.push(year);
  parts.push(`${count} titre${count > 1 ? 's' : ''}`);
  if (totalDuration.value) parts.push(fmtDuration(totalDuration.value));
  return parts.join(' · ');
});

function playAll() {
  if (libQueueIds.value.length === 0) return;
  player.playFromList(libQueueIds.value[0], libQueueIds.value);
}

function isLibPlaying(libTrack) {
  return player.currentTrack && libTrack && player.currentTrack.id === libTrack.id;
}

const pendingPlay = ref(new Set());
const heartingIdx = ref(new Set());

async function resolveYoutubeFor(entry) {
  if (entry._yt) return entry._yt;
  const { results } = await api(
    `/api/search?q=${encodeURIComponent(`${album.value.artist} ${entry.title}`)}`,
  );
  const list = results || [];
  if (list.length === 0) return null;
  const artistKey = normalizeArtistKey(album.value.artist);
  const expectedSec = entry.length ? Math.round(entry.length / 1000) : 0;
  const scored = list.slice(0, 5).map((r, rank) => {
    let s = 0;
    const uploaderKey = normalizeArtistKey(r.uploader || '');
    const titleKey = normalizeArtistKey(r.title || '');
    if (uploaderKey === artistKey) s += 100;
    else if (uploaderKey.includes(artistKey) || titleKey.includes(artistKey)) s += 60;
    if (expectedSec && r.duration) {
      const diff = Math.abs(r.duration - expectedSec);
      if (diff <= 5) s += 40;
      else if (diff <= 15) s += 20;
      else if (diff > 30) s -= 60;
    }
    s += Math.max(0, 5 - rank);
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < 30) return null;
  entry._yt = best.r;
  return best.r;
}

async function playEntry(entry, idx) {
  if (entry.libTrack) {
    player.playFromList(entry.libTrack.id, libQueueIds.value.length ? libQueueIds.value : [entry.libTrack.id]);
    return;
  }
  if (!album.value || pendingPlay.value.has(idx)) return;
  pendingPlay.value.add(idx);
  pendingPlay.value = new Set(pendingPlay.value);
  try {
    const yt = await resolveYoutubeFor(entry);
    if (!yt) { showToast('Aucune correspondance trouvée', 'error'); return; }
    const streamId = `stream-${yt.id}`;
    if (!streams.get(streamId)) {
      streams.set(streamId, {
        id: streamId, title: yt.title, uploader: yt.uploader || '',
        duration: yt.duration, thumbnail: yt.thumbnail,
        file: `/api/stream/${yt.id}`, ytId: yt.id, isStream: true,
      });
    }
    player.playFromList(streamId, [streamId]);
  } finally {
    const next = new Set(pendingPlay.value);
    next.delete(idx);
    pendingPlay.value = next;
  }
}

async function heartEntry(entry, idx) {
  if (entry.libTrack) { lib.toggleFav(entry.libTrack.id); return; }
  if (heartingIdx.value.has(idx)) return;
  heartingIdx.value = new Set([...heartingIdx.value, idx]);
  try {
    const yt = await resolveYoutubeFor(entry);
    if (!yt) { showToast('Aucune correspondance trouvée', 'error'); return; }
    await lib.add(
      {
        id: yt.id, ytId: yt.id, title: yt.title, uploader: yt.uploader || '',
        duration: yt.duration, thumbnail: yt.thumbnail,
        url: `https://www.youtube.com/watch?v=${yt.id}`,
      },
      { liked: true, silent: false },
    );
  } finally {
    const next = new Set(heartingIdx.value);
    next.delete(idx);
    heartingIdx.value = next;
  }
}

async function onMore() {
  if (!album.value) return;
  try {
    const { index } = await sheet.open([
      { name: 'Sauvegarder comme playlist' },
      { name: 'Ouvrir l’artiste' },
    ]);
    if (index === 0) saveAsPlaylist();
    else if (index === 1) view.switchTo('artist', album.value.artist);
  } catch {}
}

async function saveAsPlaylist() {
  if (!album.value) return;
  const name = await promptModal({
    title: 'Sauvegarder comme playlist',
    defaultValue: album.value.name,
    confirmLabel: 'Créer',
  });
  if (!name) return;
  // Reuse the legacy save-as-playlist flow by resolving every missing entry
  // and posting one playlist with the resolved IDs.
  // Kept inline to avoid pulling the entire legacy ViewAlbum machinery.
  const entries = [...albumEntries.value];
  const playlist = await api('/api/playlists', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  const newPl = playlist.playlist || playlist;
  const trackIds = [];
  for (const e of entries) {
    if (e.libTrack) { trackIds.push(e.libTrack.id); continue; }
    const yt = await resolveYoutubeFor(e);
    if (!yt) continue;
    const added = await api('/api/library/add', {
      method: 'POST',
      body: JSON.stringify({
        id: yt.id, ytId: yt.id, title: yt.title, uploader: yt.uploader || '',
        duration: yt.duration, thumbnail: yt.thumbnail,
        url: `https://www.youtube.com/watch?v=${yt.id}`,
        liked: false,
      }),
    });
    if (added.track) trackIds.push(added.track.id);
  }
  await api(`/api/playlists/${newPl.id}`, {
    method: 'PUT',
    body: JSON.stringify({ trackIds }),
  });
  view.switchTo('playlist', newPl.id);
}
</script>

<template>
  <div v-if="album" class="album-view">
    <MobileHero
      :cover="coverUrl"
      :bg-gradient="bgGradient"
      eyebrow="Album"
      :title="album.name"
      :subtitle="`${album.artist}  ·  ${subtitle}`"
      @play="playAll"
    >
      <template #actions>
        <button class="hero-icon-btn" aria-label="Plus" @click="onMore">
          <MoreHorizontal :size="20" :stroke-width="2.2" color="var(--text)" />
        </button>
      </template>
    </MobileHero>

    <MobileSkeleton v-if="tracklistLoading && albumEntries.length === 0" variant="row" :count="8" />

    <div v-else class="track-list">
      <MobileTrackCell
        v-for="(e, i) in albumEntries"
        :key="e.key"
        :track="e.libTrack || { id: e.key, title: e.title, duration: (e.length || 0) / 1000, thumbnail: coverUrl }"
        :index="i"
        variant="index"
        :is-playing="isLibPlaying(e.libTrack)"
        :is-liked="!!e.libTrack && lib.isFavorite(e.libTrack)"
        :loading="pendingPlay.has(i)"
        :muted="!e.libTrack"
        :show-more="false"
        :download-progress="e.libTrack ? (lib.libraryDownloads.get(e.libTrack.id)?.progress ?? null) : null"
        @play="playEntry(e, i)"
        @like="heartEntry(e, i)"
      />
    </div>
  </div>
</template>

<style scoped>
.album-view { min-height: 100%; padding-bottom: 16px; }
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
.loading { display: flex; justify-content: center; padding: 32px; }
</style>
