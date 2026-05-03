<script setup>
import { computed, ref, watch } from 'vue';
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useStreamsStore } from '@/stores/streams';
import { fmtDuration, gradientFromString, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { showToast } from '@/lib/toast';
import { promptModal } from '@/lib/modal';
import { usePlaylistsStore } from '@/stores/playlists';
import { ICON_HEART, ICON_HEART_OUTLINE, ICON_QUEUE_ADD } from '@/lib/icons';
import TrackRow from '@/components/TrackRow.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const streams = useStreamsStore();
const playlists = usePlaylistsStore();

// Resolve the album from the active selectedAlbumKey. We pull the full
// list of tracks fresh from `lib.tracks` so renames / additions reflect
// instantly without a re-fetch round trip.
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
    releaseGroupId: first.albumReleaseGroupId || null,
    releaseId: first.albumReleaseId || null,
    releaseDate: first.albumReleaseDate || null,
    libTracks,
  };
});

const libQueueIds = computed(() =>
  album.value ? album.value.libTracks.map((tr) => tr.id) : [],
);
const totalDuration = computed(() =>
  album.value ? album.value.libTracks.reduce((s, tr) => s + (tr.duration || 0), 0) : 0,
);
const heroBg = computed(() =>
  album.value ? gradientFromString(album.value.name) : '',
);

// Cover URL: prefer Cover Art Archive (release-group), fall back to the
// first library track's YouTube thumbnail when CAA 404s. We track a
// `coverFailed` flag flipped by @error so the fallback kicks in only
// when the primary src actually fails. `coverLoading` drives the
// shimmer overlay until the chosen src actually loads.
const coverFailed = ref(false);
const coverLoading = ref(true);
watch(() => view.selectedAlbumKey, () => {
  coverFailed.value = false;
  coverLoading.value = true;
});
const coverUrl = computed(() => {
  if (!album.value) return '';
  if (album.value.releaseGroupId && !coverFailed.value) {
    return `/api/album-cover/${album.value.releaseGroupId}`;
  }
  return album.value.libTracks[0]?.thumbnail || '';
});
watch(coverUrl, () => { coverLoading.value = true; });

// ──────────────────────────────────────────────────────────────────
// "Other tracks from this album" — load the full MB tracklist for the
// release, dedupe against the user's library by normalized title, and
// expose the missing tracks. Each missing entry is "pending" until the
// user clicks play, at which point we resolve a YouTube ID via
// /api/search and stream it.
// ──────────────────────────────────────────────────────────────────
const tracklistLoading = ref(false);
const tracklistError = ref(false);
const otherTracks = ref([]); // [{position, title, length}]

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*[\[\(](feat\.?|ft\.?|featuring|with)[^)\]]*[\]\)]/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

async function loadTracklist() {
  otherTracks.value = [];
  tracklistError.value = false;
  if (!album.value || !album.value.releaseId) return;
  tracklistLoading.value = true;
  try {
    const { tracks } = await api(`/api/album-tracklist?releaseId=${album.value.releaseId}`);
    if (!Array.isArray(tracks)) throw new Error('bad payload');
    const libKeys = new Set(album.value.libTracks.map((tr) => normalizeTitle(parseTrackTitle(tr).song)));
    const missing = tracks.filter((mb) => !libKeys.has(normalizeTitle(mb.title)));
    otherTracks.value = missing;
  } catch {
    tracklistError.value = true;
  } finally {
    tracklistLoading.value = false;
  }
}

watch(() => view.selectedAlbumKey, () => loadTracklist(), { immediate: true });

// Resolve a missing track to a streamable YouTube entry on demand.
// First click is slow (yt-dlp search); we cache the result on the entry
// so subsequent clicks are instant. The entry itself stays in
// `otherTracks` reactive — we just patch in the stream metadata.
const pendingPlay = ref(new Set()); // positions currently resolving

async function playMissing(entry, idx) {
  if (!album.value) return;
  if (pendingPlay.value.has(idx)) return;
  // Already resolved? Just play.
  if (entry._streamId) {
    player.playFromList(entry._streamId, [entry._streamId]);
    return;
  }
  pendingPlay.value.add(idx);
  pendingPlay.value = new Set(pendingPlay.value); // trigger reactivity
  try {
    const { results } = await api(
      `/api/search?q=${encodeURIComponent(`${album.value.artist} ${entry.title}`)}`,
    );
    const top = (results || [])[0];
    if (!top) return;
    const streamId = `stream-${top.id}`;
    const stream = {
      id: streamId,
      title: top.title,
      uploader: top.uploader || '',
      duration: top.duration,
      thumbnail: top.thumbnail,
      file: `/api/stream/${top.id}`,
      ytId: top.id,
      isStream: true,
    };
    streams.set(streamId, stream);
    entry._streamId = streamId;
    entry._stream = stream;
    player.playFromList(streamId, [streamId]);
  } finally {
    pendingPlay.value.delete(idx);
    pendingPlay.value = new Set(pendingPlay.value);
  }
}

function playAll() {
  if (!album.value || album.value.libTracks.length === 0) return;
  player.playFromList(libQueueIds.value[0], libQueueIds.value);
}

// Resolve a missing track to a real YouTube ID via /api/search and
// return the top result. Result is memoized on the entry so subsequent
// actions on the same row reuse it.
async function resolveYoutubeFor(entry) {
  if (entry._yt) return entry._yt;
  const { results } = await api(
    `/api/search?q=${encodeURIComponent(`${album.value.artist} ${entry.title}`)}`,
  );
  const top = (results || [])[0];
  if (!top) return null;
  entry._yt = top;
  return top;
}

// Heart action on a missing track — resolves YT, adds to library
// (liked: true), then patches the entry locally so the row can re-
// render (the next album.libTracks pass will hoist it into the
// "In your library" section automatically since lib.tracks updated).
const heartingIdx = ref(new Set());
async function heartMissing(entry, idx) {
  if (heartingIdx.value.has(idx)) return;
  heartingIdx.value = new Set([...heartingIdx.value, idx]);
  try {
    const yt = await resolveYoutubeFor(entry);
    if (!yt) {
      showToast(t('toast.no_match'), 'error');
      return;
    }
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

// Add a missing track to the player queue — same resolve + add to
// streams pattern, then call player.addToQueue.
async function queueMissing(entry, idx) {
  if (heartingIdx.value.has(idx)) return; // reuse the spinner state
  heartingIdx.value = new Set([...heartingIdx.value, idx]);
  try {
    const yt = await resolveYoutubeFor(entry);
    if (!yt) {
      showToast(t('toast.no_match'), 'error');
      return;
    }
    const streamId = `stream-${yt.id}`;
    if (!streams.get(streamId)) {
      streams.set(streamId, {
        id: streamId, title: yt.title, uploader: yt.uploader || '',
        duration: yt.duration, thumbnail: yt.thumbnail,
        file: `/api/stream/${yt.id}`, ytId: yt.id, isStream: true,
      });
    }
    player.addToQueue(streamId);
  } finally {
    const next = new Set(heartingIdx.value);
    next.delete(idx);
    heartingIdx.value = next;
  }
}

// Save the entire album as a new playlist. Resolves YouTube IDs for
// every missing track in series (rate-limited at the server's yt-dlp
// semaphore), adds them to the library silently, then bulk-attaches
// every track id (lib + freshly added) to a new playlist named after
// the album. Switches to the playlist on success.
const savingAsPlaylist = ref(false);
const saveProgress = ref({ done: 0, total: 0 });
async function saveAsPlaylist() {
  if (!album.value || savingAsPlaylist.value) return;
  const name = await promptModal({
    title: t('album.save_as_playlist_title'),
    defaultValue: album.value.name,
    confirmLabel: t('common.create'),
  });
  if (!name) return;
  savingAsPlaylist.value = true;
  saveProgress.value = { done: 0, total: otherTracks.value.length };
  try {
    // Step 1 — resolve + add every missing track. Sequential so the
    // server semaphore handles parallelism; UI shows a counter.
    const newLibIds = [];
    for (let i = 0; i < otherTracks.value.length; i++) {
      const entry = otherTracks.value[i];
      try {
        const yt = await resolveYoutubeFor(entry);
        if (yt) {
          const added = await lib.add(
            {
              id: yt.id, ytId: yt.id, title: yt.title, uploader: yt.uploader || '',
              duration: yt.duration, thumbnail: yt.thumbnail,
              url: `https://www.youtube.com/watch?v=${yt.id}`,
            },
            { liked: false, silent: true },
          );
          if (added && added.id) newLibIds.push(added.id);
        }
      } catch {}
      saveProgress.value = { done: i + 1, total: otherTracks.value.length };
    }
    // Step 2 — create the playlist with name + bulk-attach the union
    // of (existing library tracks for this album) + (newly added).
    const allIds = [...album.value.libTracks.map((tr) => tr.id), ...newLibIds];
    const { playlist } = await api('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    playlists.items.push(playlist);
    if (allIds.length > 0) {
      await playlists.addTracksBulk(playlist.id, allIds);
    }
    showToast(t('album.save_as_playlist_done', { name }), 'success');
    view.switchTo('playlist', playlist.id);
  } catch (e) {
    showToast(e.message || t('common.error'), 'error');
  } finally {
    savingAsPlaylist.value = false;
  }
}

function goBack() {
  view.back();
}
</script>

<template>
  <section id="view-album" class="view active">
    <template v-if="album">
      <header class="hero hero-album" :style="{ backgroundImage: heroBg }">
        <button
          class="hero-back"
          :title="t('artist.back')"
          :aria-label="t('artist.back')"
          @click="goBack"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="hero-content hero-content--with-avatar">
          <div v-if="coverUrl" class="hero-cover-wrap" :class="{ 'cover-loading': coverLoading }">
            <img
              class="hero-cover"
              :src="coverUrl"
              :alt="album.name"
              loading="lazy"
              @error="coverFailed = true; coverLoading = false"
              @load="coverLoading = false"
            />
          </div>
          <div class="hero-text">
            <span class="eyebrow">{{ t('album.eyebrow') }}</span>
            <h1>{{ album.name }}</h1>
            <p class="hero-meta">
              {{ album.artist
              }}<span v-if="album.releaseDate"> · {{ album.releaseDate.slice(0, 4) }}</span>
              · {{ t('common.tracks', album.libTracks.length) }}<span v-if="totalDuration"> · {{ fmtDuration(totalDuration) }}</span>
            </p>
          </div>
        </div>
      </header>
      <div class="page-body">
        <div class="action-row">
          <button class="play-circle" :title="t('playlist.play_all')" @click="playAll">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
          <button
            class="btn-ghost"
            :disabled="savingAsPlaylist"
            :title="t('album.save_as_playlist')"
            @click="saveAsPlaylist"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span v-if="!savingAsPlaylist">{{ t('album.save_as_playlist') }}</span>
            <span v-else>{{ t('album.saving', { done: saveProgress.done, total: saveProgress.total }) }}</span>
          </button>
        </div>
        <h3 v-if="otherTracks.length > 0 || tracklistLoading" class="section-heading">{{ t('album.in_library') }}</h3>
        <ul class="track-list">
          <TrackRow
            v-for="(tr, i) in album.libTracks"
            :key="tr.id"
            :track="tr"
            :index="i"
            :queue="libQueueIds"
          />
        </ul>

        <!-- Other tracks from this album (MB tracklist minus library) -->
        <template v-if="album.releaseId">
          <h3 class="section-heading section-heading--spaced">
            {{ t('album.other_tracks') }}
          </h3>
          <ul v-if="tracklistLoading" class="track-list track-list-skeleton" aria-busy="true">
            <li v-for="i in 4" :key="i" class="track track-skeleton">
              <span class="skeleton-block skel-num"></span>
              <span class="skeleton-block skel-thumb"></span>
              <span class="skeleton-block skel-title"></span>
              <span class="skeleton-block skel-album"></span>
              <span class="skeleton-block skel-indicator"></span>
              <span class="skeleton-block skel-duration"></span>
              <span class="skeleton-block skel-actions"></span>
            </li>
          </ul>
          <ul v-else-if="otherTracks.length > 0" class="track-list">
            <li
              v-for="(entry, i) in otherTracks"
              :key="`${entry.recordingId || entry.title}-${i}`"
              class="track album-other-track"
              @dblclick="playMissing(entry, i)"
            >
              <div class="track-num">
                <div v-if="pendingPlay.has(i)" class="track-num-spinner"></div>
                <span v-else class="track-num-default">{{ i + 1 }}</span>
                <button
                  class="track-num-action"
                  :aria-label="t('track.play')"
                  @click.stop="playMissing(entry, i)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
              <div
                class="track-thumb album-other-thumb"
                :style="{ backgroundImage: coverUrl ? `url('${coverUrl}')` : heroBg }"
              ></div>
              <div class="track-meta">
                <div class="track-title">{{ entry.title }}</div>
                <div class="track-sub">{{ album.artist }}</div>
              </div>
              <span class="track-album track-album-empty"></span>
              <span class="track-offline-indicator empty"></span>
              <span class="track-duration">{{ entry.length ? fmtDuration(entry.length / 1000) : '—' }}</span>
              <div class="track-actions">
                <button
                  class="icon-btn like-btn"
                  :disabled="heartingIdx.has(i)"
                  :title="t('player.add_to_favorites')"
                  @click.stop="heartMissing(entry, i)"
                  v-html="ICON_HEART_OUTLINE"
                ></button>
                <button
                  class="icon-btn queue-add-btn"
                  :disabled="heartingIdx.has(i)"
                  :title="t('track.add_queue')"
                  @click.stop="queueMissing(entry, i)"
                  v-html="ICON_QUEUE_ADD"
                ></button>
              </div>
            </li>
          </ul>
          <p v-else-if="tracklistError" class="empty-state">
            {{ t('album.tracklist_error') }}
          </p>
        </template>
      </div>
    </template>
    <p v-else class="empty-state" style="margin: 80px 32px">
      {{ t('album.not_found') }}
    </p>
  </section>
</template>
