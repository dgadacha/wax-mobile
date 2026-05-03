<script setup>
import { computed } from 'vue';
import { useLibraryStore } from '@/stores/library';
import { useViewStore } from '@/stores/view';
import { t } from '@/lib/i18n';
import { gradientFromString } from '@/lib/format';

const lib = useLibraryStore();
const view = useViewStore();

const albums = computed(() => lib.albums);

function open(album) {
  view.switchTo('album', album.key);
}

// Cover URL for an album: prefer the MusicBrainz/Cover Art Archive image
// when we have a release-group id, fall back to the first track's cover.
function coverFor(album) {
  if (album.releaseGroupId) return `/api/album-cover/${album.releaseGroupId}`;
  return album.tracks[0]?.thumbnail || '';
}
</script>

<template>
  <section id="view-albums" class="view active">
    <header class="hero hero-albums">
      <div class="hero-content">
        <span class="eyebrow">{{ t('albums.eyebrow') }}</span>
        <h1>{{ t('albums.title') }}</h1>
        <p class="hero-meta">
          {{ t('albums.count', albums.length) }}
        </p>
      </div>
    </header>
    <div class="page-body">
      <div v-if="albums.length === 0" class="empty-state">
        {{ t('albums.empty') }}
      </div>
      <div v-else class="album-grid">
        <button
          v-for="album in albums"
          :key="album.key"
          class="album-card"
          @click="open(album)"
        >
          <div
            class="album-cover"
            :style="album.releaseGroupId ? null : { backgroundImage: gradientFromString(album.name) }"
          >
            <img
              v-if="album.releaseGroupId"
              :src="coverFor(album)"
              :alt="album.name"
              loading="lazy"
              @error="(e) => { e.target.style.display = 'none'; e.target.parentElement.style.backgroundImage = gradientFromString(album.name); }"
            />
          </div>
          <div class="album-meta">
            <div class="album-title">{{ album.name }}</div>
            <div class="album-sub">{{ album.artist }}</div>
            <div class="album-count">{{ t('common.tracks', album.tracks.length) }}</div>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>
