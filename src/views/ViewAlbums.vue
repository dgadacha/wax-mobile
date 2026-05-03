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

// Track which release-groups have failed CAA so we fall back to a
// 2x2 mosaic of the album's library tracks (or single thumb when 1).
const caaFailed = ref(new Set());
function markCaaFailed(key) {
  const next = new Set(caaFailed.value);
  next.add(key);
  caaFailed.value = next;
}

function caaUrl(album) {
  if (album.releaseGroupId && !caaFailed.value.has(album.key)) {
    return `/api/album-cover/${album.releaseGroupId}`;
  }
  return null;
}

// Build a 2x2 mosaic from the album's library tracks when CAA fails
// and the album has 2+ tracks. Identical pattern to the playlist
// fallback in Sidebar.
function fallbackCovers(album) {
  if (album.tracks.length === 0) return [];
  if (album.tracks.length === 1) return [album.tracks[0]?.thumbnail].filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const tr of album.tracks) {
    const c = tr?.thumbnail;
    if (c && !seen.has(c)) {
      seen.add(c);
      unique.push(c);
      if (unique.length === 4) break;
    }
  }
  if (unique.length === 0) return [];
  if (unique.length === 1) return unique;
  // 2-3 distinct → cycle to fill 2x2.
  const grid = [];
  for (let i = 0; i < 4; i++) grid.push(unique[i % unique.length]);
  return grid;
}

function onCaaError(album) {
  markCaaFailed(album.key);
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
            :class="{ 'album-cover-grid': !caaUrl(album) && fallbackCovers(album).length === 4 }"
            :style="{ backgroundImage: gradientFromString(album.name) }"
          >
            <!-- CAA cover (full image) when available. -->
            <img
              v-if="caaUrl(album)"
              :src="caaUrl(album)"
              :alt="album.name"
              loading="lazy"
              @error="onCaaError(album)"
            />
            <!-- Fallback: 2x2 mosaic of library track thumbs when CAA
                 missed and we have 2+ tracks. Single thumb when 1. -->
            <template v-else-if="fallbackCovers(album).length === 4">
              <img
                v-for="(c, idx) in fallbackCovers(album)"
                :key="idx"
                :src="c"
                :alt="album.name"
                loading="lazy"
              />
            </template>
            <img
              v-else-if="fallbackCovers(album).length === 1"
              :src="fallbackCovers(album)[0]"
              :alt="album.name"
              loading="lazy"
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
