<script setup>
import { computed } from 'vue';
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { fmtDuration, gradientFromString } from '@/lib/format';
import { t } from '@/lib/i18n';
import TrackRow from '@/components/TrackRow.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();

// Resolve the album from the active selectedAlbumKey. We pull the full
// list of tracks fresh from `lib.tracks` so renames / additions reflect
// instantly without a re-fetch round trip.
const album = computed(() => {
  const key = view.selectedAlbumKey;
  if (!key) return null;
  const tracks = lib.albumByKey(key);
  if (tracks.length === 0) return null;
  const first = tracks[0];
  return {
    key,
    name: first.album,
    artist: first.uploader || '',
    releaseGroupId: first.albumReleaseGroupId || null,
    releaseDate: first.albumReleaseDate || null,
    tracks,
  };
});

const queueIds = computed(() => album.value ? album.value.tracks.map((tr) => tr.id) : []);
const totalDuration = computed(() =>
  album.value ? album.value.tracks.reduce((s, tr) => s + (tr.duration || 0), 0) : 0,
);
const heroBg = computed(() =>
  album.value ? gradientFromString(album.value.name) : '',
);
const coverUrl = computed(() => {
  if (!album.value) return '';
  if (album.value.releaseGroupId) return `/api/album-cover/${album.value.releaseGroupId}`;
  return album.value.tracks[0]?.thumbnail || '';
});

function playAll() {
  if (!album.value || album.value.tracks.length === 0) return;
  player.playFromList(queueIds.value[0], queueIds.value);
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
          <img
            v-if="coverUrl"
            class="hero-cover"
            :src="coverUrl"
            :alt="album.name"
            loading="lazy"
            @error="(e) => { e.target.style.display = 'none'; }"
          />
          <div class="hero-text">
            <span class="eyebrow">{{ t('album.eyebrow') }}</span>
            <h1>{{ album.name }}</h1>
            <p class="hero-meta">
              {{ album.artist
              }}<span v-if="album.releaseDate"> · {{ album.releaseDate.slice(0, 4) }}</span>
              · {{ t('common.tracks', album.tracks.length) }}<span v-if="totalDuration"> · {{ fmtDuration(totalDuration) }}</span>
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
        </div>
        <ul class="track-list">
          <TrackRow
            v-for="(tr, i) in album.tracks"
            :key="tr.id"
            :track="tr"
            :index="i"
            :queue="queueIds"
          />
        </ul>
      </div>
    </template>
    <p v-else class="empty-state" style="margin: 80px 32px">
      {{ t('album.not_found') }}
    </p>
  </section>
</template>
