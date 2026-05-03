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
import TrackListHeader from '@/components/TrackListHeader.vue';

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
    albumId: first.albumId || null,
    coverUrl: first.albumCoverUrl || null,
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

// Cover URL: Deezer cover URL when present, fall back to the first
// library track's YouTube thumbnail. `coverFailed` flips on @error so
// a 404 from Deezer's CDN demotes us to the fallback. `coverLoading`
// drives the shimmer overlay until the chosen src loads.
const coverFailed = ref(false);
const coverLoading = ref(true);
watch(() => view.selectedAlbumKey, () => {
  coverFailed.value = false;
  coverLoading.value = true;
});
const coverUrl = computed(() => {
  if (!album.value) return '';
  if (album.value.coverUrl && !coverFailed.value) return album.value.coverUrl;
  return album.value.libTracks[0]?.thumbnail || '';
});
watch(coverUrl, () => { coverLoading.value = true; });

// ──────────────────────────────────────────────────────────────────
// Unified album tracklist via Deezer. Pulls every track of the album
// in canonical position order; for each entry, attaches the matching
// library track when one exists (fuzzy title compare after stripping
// featuring credits / non-alphanum). One ordered list, front to back.
// ──────────────────────────────────────────────────────────────────
const tracklistLoading = ref(false);
const tracklistError = ref(false);
const remoteTracks = ref([]); // [{position, title, length, recordingId}]
const remoteReleaseDate = ref(null);

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*[\[\(](feat\.?|ft\.?|featuring|with)[^)\]]*[\]\)]/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

const albumEntries = computed(() => {
  if (!album.value || remoteTracks.value.length === 0) return [];
  const byTitle = new Map();
  for (const tr of album.value.libTracks) {
    byTitle.set(normalizeTitle(parseTrackTitle(tr).song), tr);
  }
  return remoteTracks.value.map((r, i) => ({
    key: `${r.recordingId || r.title}-${i}`,
    index: i,
    position: r.position || i + 1,
    title: r.title,
    length: r.length,
    libTrack: byTitle.get(normalizeTitle(r.title)) || null,
  }));
});

async function loadTracklist() {
  remoteTracks.value = [];
  remoteReleaseDate.value = null;
  tracklistError.value = false;
  if (!album.value || !album.value.albumId) return;
  tracklistLoading.value = true;
  try {
    const data = await api(`/api/album-tracklist?albumId=${album.value.albumId}`);
    if (!Array.isArray(data.tracks)) throw new Error('bad payload');
    remoteTracks.value = data.tracks;
    remoteReleaseDate.value = data.releaseDate || null;
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
  if (entry._streamId) {
    player.playFromList(entry._streamId, [entry._streamId]);
    return;
  }
  pendingPlay.value.add(idx);
  pendingPlay.value = new Set(pendingPlay.value);
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
    entry._streamId = streamId;
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

// Resolve a missing track to a real YouTube ID via /api/search.
// /api/search returns matches by title alone, which routinely picks a
// different artist's identically-named song (especially for short
// titles like "Maussade"). We score the top results by artist-name
// match (uploader / channel) AND by duration proximity to MusicBrainz
// — the right song is usually within ±5 s of the MB length.
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
    // Artist match — uploader or title containing the album artist.
    const uploaderKey = normalizeArtistKey(r.uploader || '');
    const titleKey = normalizeArtistKey(r.title || '');
    if (uploaderKey === artistKey) s += 100;
    else if (uploaderKey.includes(artistKey) || titleKey.includes(artistKey)) s += 60;
    // Duration proximity — heavy penalty when off by >30 s.
    if (expectedSec && r.duration) {
      const diff = Math.abs(r.duration - expectedSec);
      if (diff <= 5) s += 40;
      else if (diff <= 15) s += 20;
      else if (diff > 30) s -= 60;
    }
    // Slight preference for the SERP-top result on ties.
    s += Math.max(0, 5 - rank);
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  // Reject everything if the best score is too low — better to skip
  // the track than save a wrong one to the user's library.
  if (!best || best.s < 30) return null;
  entry._yt = best.r;
  return best.r;
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

// Save the album's full tracklist (in MB order) as a new playlist.
// Walks albumEntries: for each entry, use the existing library track
// if matched, otherwise resolve YouTube + add to library silently,
// then append to the playlist. Playlist is created instantly so it's
// visible in the sidebar from the first second; tracks fill in order
// as they resolve. The user can navigate away — the fill runs in the
// background.
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
  // Snapshot album entries up front so background resolution doesn't
  // race with reactive recompute (lib.tracks mutates as we add).
  const entries = [...albumEntries.value];
  if (entries.length === 0) return;

  savingAsPlaylist.value = true;
  saveProgress.value = { done: 0, total: entries.length };

  let playlist;
  try {
    const res = await api('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    playlist = res.playlist;
    playlists.items.push(playlist);
    showToast(t('album.save_as_playlist_created', { name }), 'success');
  } catch (e) {
    showToast(e.message || t('common.error'), 'error');
    savingAsPlaylist.value = false;
    return;
  }

  // Fire-and-forget background fill. Sequential per entry to preserve
  // album track order — each resolution awaits the previous one.
  (async () => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let trackId = entry.libTrack?.id;
      if (!trackId) {
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
            if (added && added.id) trackId = added.id;
          }
        } catch {}
      }
      if (trackId) {
        try { await playlists.addTracksBulk(playlist.id, [trackId]); } catch {}
      }
      saveProgress.value = { done: i + 1, total: entries.length };
    }
    savingAsPlaylist.value = false;
    showToast(t('album.save_as_playlist_filled', { name }), 'success');
  })();
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
              }}<span v-if="album.releaseDate || remoteReleaseDate"> · {{ (album.releaseDate || remoteReleaseDate).slice(0, 4) }}</span>
              · {{ t('common.tracks', albumEntries.length || album.libTracks.length) }}<span v-if="totalDuration"> · {{ fmtDuration(totalDuration) }}</span>
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
        <!-- Unified tracklist: MB order, with library matches rendered
             via TrackRow and missing entries rendered as a custom row
             with on-demand resolution. Falls back to libTracks-only
             when MB tracklist is unavailable. -->
        <ul v-if="tracklistLoading" class="track-list track-list-skeleton" aria-busy="true">
          <li v-for="i in 6" :key="i" class="track track-skeleton">
            <span class="skeleton-block skel-num"></span>
            <span class="skeleton-block skel-thumb"></span>
            <span class="skeleton-block skel-title"></span>
            <span class="skeleton-block skel-album"></span>
            <span class="skeleton-block skel-indicator"></span>
            <span class="skeleton-block skel-duration"></span>
            <span class="skeleton-block skel-actions"></span>
          </li>
        </ul>
        <template v-else-if="albumEntries.length > 0">
        <TrackListHeader no-album />
        <ul class="track-list track-list--no-album">
          <template v-for="(entry, i) in albumEntries" :key="entry.key">
            <!-- Library match: full TrackRow with all standard actions. -->
            <TrackRow
              v-if="entry.libTrack"
              :track="entry.libTrack"
              :index="i"
              :queue="libQueueIds"
              :thumb-override="coverUrl"
            />
            <!-- Missing entry: lightweight row with on-demand actions. -->
            <li
              v-else
              class="track album-other-track"
              @dblclick="playMissing(entry, i)"
            >
              <div class="track-num">
                <div v-if="pendingPlay.has(i)" class="track-num-spinner"></div>
                <span v-else class="track-num-default">{{ entry.position }}</span>
                <button
                  class="track-num-action"
                  :aria-label="t('track.play')"
                  @click.stop="playMissing(entry, i)"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
              <img
                v-if="coverUrl"
                class="track-thumb"
                :src="coverUrl"
                :alt="entry.title"
                loading="lazy"
              />
              <div
                v-else
                class="track-thumb album-other-thumb"
                :style="{ backgroundImage: heroBg }"
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
          </template>
        </ul>
        </template>
        <!-- No MB tracklist available: fall back to library-only list. -->
        <template v-else-if="album.libTracks.length > 0">
        <TrackListHeader no-album />
        <ul class="track-list track-list--no-album">
          <TrackRow
            v-for="(tr, i) in album.libTracks"
            :key="tr.id"
            :track="tr"
            :index="i"
            :queue="libQueueIds"
            :thumb-override="coverUrl"
          />
        </ul>
        </template>
        <p v-else-if="tracklistError" class="empty-state">
          {{ t('album.tracklist_error') }}
        </p>
      </div>
    </template>
    <p v-else class="empty-state" style="margin: 80px 32px">
      {{ t('album.not_found') }}
    </p>
  </section>
</template>
