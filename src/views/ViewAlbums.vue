<script setup>
import { computed, ref } from 'vue';
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

// Track which release-groups have failed CAA so we fall back to the
// first track's YouTube thumbnail. Reactive set so the v-bind picks it
// up. Avoids a permanent broken-image icon when CAA doesn't have art.
const caaFailed = ref(new Set());
function markCaaFailed(key) {
  const next = new Set(caaFailed.value);
  next.add(key);
  caaFailed.value = next;
}

function coverFor(album) {
  if (album.releaseGroupId && !caaFailed.value.has(album.key)) {
    return `/api/album-cover/${album.releaseGroupId}`;
  }
  return album.tracks[0]?.thumbnail || '';
}

function onImgError(e, album) {
  // Mark this release-group as CAA-missing so we fall back to the
  // YouTube thumb. The img re-renders via :src reactivity.
  markCaaFailed(album.key);
  // If even the YouTube thumb fails, hide the img and show the gradient.
  if (!album.tracks[0]?.thumbnail) {
    e.target.style.display = 'none';
  }
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
            :style="{ backgroundImage: gradientFromString(album.name) }"
          >
            <img
              v-if="coverFor(album)"
              :src="coverFor(album)"
              :alt="album.name"
              loading="lazy"
              @error="(e) => onImgError(e, album)"
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
