<script setup>
import { computed, ref, watch } from 'vue';
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useStreamsStore } from '@/stores/streams';
import { api } from '@/lib/api';
import { fmtDuration, gradientFromString, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { t } from '@/lib/i18n';
import { showToast } from '@/lib/toast';
import TrackRow from '@/components/TrackRow.vue';
import TrackListHeader from '@/components/TrackListHeader.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const streams = useStreamsStore();

const artistName = computed(() => view.selectedArtist || '');

// Artist hero photo. We optimistically point an <img> at the endpoint —
// the server scrapes via yt-dlp + caches on disk. On 404 we hide the
// avatar and the gradient background carries the hero alone.
const photoOk = ref(true);
const photoUrl = computed(() =>
  artistName.value ? `/api/artist-photo/${encodeURIComponent(artistName.value)}` : '',
);
watch(() => view.selectedArtist, () => { photoOk.value = true; });

// Library tracks already attributed to this artist.
const libraryTracks = computed(() => lib.tracksByArtist(artistName.value));
const libraryQueueIds = computed(() => libraryTracks.value.map((tr) => tr.id));
const totalDuration = computed(() =>
  libraryTracks.value.reduce((s, tr) => s + (tr.duration || 0), 0),
);
const heroBg = computed(() =>
  artistName.value ? gradientFromString(artistName.value) : '',
);

function playAll() {
  if (libraryTracks.value.length === 0) return;
  player.playFromList(libraryQueueIds.value[0], libraryQueueIds.value);
}

// ──────────────────────────────────────────────────────────────────
// "More from this artist" — fetch top YouTube results for the artist
// name, filter to tracks whose parsed artist clusters with the active
// one (via normalizeArtistKey), and drop anything already in the
// library so we only surface genuine recommendations.
// ──────────────────────────────────────────────────────────────────
const recommendations = ref([]);
const loadingRecs = ref(false);
const recsError = ref(false);

async function loadRecommendations(name) {
  if (!name) {
    recommendations.value = [];
    return;
  }
  loadingRecs.value = true;
  recsError.value = false;
  recommendations.value = [];
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(name)}`);
    const artistKey = normalizeArtistKey(name);
    const libYtIds = new Set(lib.tracks.map((tr) => tr.ytId));
    const filtered = (results || [])
      .filter((r) => {
        const parsed = parseTrackTitle({ title: r.title, uploader: r.uploader });
        return normalizeArtistKey(parsed.artist) === artistKey;
      })
      .filter((r) => !libYtIds.has(r.id))
      .slice(0, 10);
    recommendations.value = filtered.map((r) => {
      const streamId = `stream-${r.id}`;
      let entry = streams.get(streamId);
      if (!entry) {
        entry = {
          id: streamId,
          title: r.title,
          uploader: r.uploader || '',
          duration: r.duration,
          thumbnail: r.thumbnail,
          file: `/api/stream/${r.id}`,
          ytId: r.id,
          isStream: true,
        };
        streams.set(streamId, entry);
      }
      return entry;
    });
  } catch {
    recsError.value = true;
  } finally {
    loadingRecs.value = false;
  }
}

const recommendationQueueIds = computed(() => recommendations.value.map((tr) => tr.id));

const addingAll = ref(false);
async function addAllRecommendations() {
  if (addingAll.value || recommendations.value.length === 0) return;
  addingAll.value = true;
  try {
    const libYtIds = new Set(lib.tracks.map((tr) => tr.ytId));
    const toAdd = recommendations.value.filter((tr) => !libYtIds.has(tr.ytId));
    let added = 0;
    for (const tr of toAdd) {
      const result = await lib.add(
        {
          id: tr.ytId,
          title: tr.title,
          uploader: tr.uploader,
          duration: tr.duration,
          thumbnail: tr.thumbnail,
        },
        { silent: true, liked: true },
      );
      if (result) added += 1;
    }
    showToast(t('artist.add_all_done', added), 'success');
    // Drop newly-added tracks from the recs list — they now live in the library section above.
    recommendations.value = recommendations.value.filter(
      (tr) => !lib.tracks.some((libTr) => libTr.ytId === tr.ytId),
    );
  } finally {
    addingAll.value = false;
  }
}

function goBack() {
  view.back();
}

// Refetch every time the user lands on a different artist.
watch(
  () => view.selectedArtist,
  (n) => loadRecommendations(n),
  { immediate: true },
);
</script>

<template>
  <section id="view-artist" class="view active">
    <header class="hero hero-artist" :style="{ backgroundImage: heroBg }">
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
        <img
          v-if="photoOk && photoUrl"
          class="hero-avatar"
          :src="photoUrl"
          :alt="artistName"
          loading="lazy"
          @error="photoOk = false"
        />
        <div class="hero-text">
          <span class="eyebrow">{{ t('artist.eyebrow') }}</span>
          <h1>{{ artistName || t('artist.eyebrow') }}</h1>
          <p class="hero-meta">
            {{ t('common.tracks', libraryTracks.length)
            }}<span v-if="totalDuration"> · {{ fmtDuration(totalDuration) }}</span>
          </p>
        </div>
      </div>
    </header>
    <div class="page-body">
      <!-- Library tracks: only when the user has at least one. -->
      <template v-if="libraryTracks.length > 0">
        <div class="action-row">
          <button class="play-circle" :title="t('playlist.play_all')" @click="playAll">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          <span>{{ t('common.play') }}</span>
        </button>
        </div>
        <h3 class="section-heading">{{ t('artist.in_library') }}</h3>
        <TrackListHeader />
        <ul class="track-list">
          <TrackRow
            v-for="(tr, i) in libraryTracks"
            :key="tr.id"
            :track="tr"
            :index="i"
            :queue="libraryQueueIds"
          />
        </ul>
      </template>

      <!-- "More from this artist" — recommendations from YouTube. -->
      <div class="section-heading-row section-heading--spaced">
        <h3 class="section-heading">
          {{ t('artist.discover_heading', artistName) }}
        </h3>
        <button
          v-if="recommendations.length > 0"
          class="btn-ghost btn-add-all"
          :disabled="addingAll"
          :title="t('artist.add_all')"
          @click="addAllRecommendations"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>{{ t('artist.add_all') }}</span>
        </button>
      </div>
      <ul v-if="loadingRecs" class="track-list track-list-skeleton" aria-busy="true">
        <li v-for="i in 5" :key="i" class="track track-skeleton">
          <span class="skeleton-block skel-num"></span>
          <span class="skeleton-block skel-thumb"></span>
          <span class="skeleton-block skel-title"></span>
          <span class="skeleton-block skel-album"></span>
          <span class="skeleton-block skel-indicator"></span>
          <span class="skeleton-block skel-duration"></span>
          <span class="skeleton-block skel-actions"></span>
        </li>
      </ul>
      <template v-else-if="recommendations.length > 0">
        <TrackListHeader />
        <ul class="track-list">
          <TrackRow
            v-for="(tr, i) in recommendations"
            :key="tr.id"
            :track="tr"
            :index="i"
            :queue="recommendationQueueIds"
          />
        </ul>
      </template>
      <p v-else-if="recsError" class="empty-state">
        {{ t('artist.discover_error') }}
      </p>
      <p v-else class="empty-state">
        {{ t('artist.discover_empty') }}
      </p>

      <p class="empty-state" :hidden="libraryTracks.length > 0 || loadingRecs || recommendations.length > 0">
        {{ t('artist.empty') }}
      </p>
    </div>
  </section>
</template>
