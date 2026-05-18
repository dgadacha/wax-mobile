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

// Track which Deezer cover URLs have failed (404 / network) so we fall
// back to a 2x2 mosaic of the album's library tracks. Keyed by album
// key so swapping artists doesn't poison the failure set.
const coverFailed = ref(new Set());
function markCoverFailed(key) {
  const next = new Set(coverFailed.value);
  next.add(key);
  coverFailed.value = next;
}

// Shimmer overlay flag per album. We track the set of *loaded* keys
// (default empty) and treat anything not in it as still-loading. New
// albums that arrive via SSE start out as loading naturally.
const loaded = ref(new Set());
function isLoading(album) { return !loaded.value.has(album.key); }
function markLoaded(key) {
  if (loaded.value.has(key)) return;
  const next = new Set(loaded.value);
  next.add(key);
  loaded.value = next;
}

function primaryCover(album) {
  if (album.albumCoverUrl && !coverFailed.value.has(album.key)) {
    return album.albumCoverUrl;
  }
  return null;
}

// Build a 2x2 mosaic from the album's library tracks when Deezer's
// cover URL fails and the album has 2+ tracks. Same logic as Sidebar.
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

function onCoverError(album) {
  markCoverFailed(album.key);
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
            :class="{
              'album-cover-grid': !primaryCover(album) && fallbackCovers(album).length === 4,
              'cover-loading': isLoading(album),
            }"
            :style="{ backgroundImage: gradientFromString(album.name) }"
          >
            <!-- Deezer cover (full image) when available. -->
            <img
              v-if="primaryCover(album)"
              :src="primaryCover(album)"
              :alt="album.name"
              loading="lazy"
              @error="onCoverError(album)"
              @load="markLoaded(album.key)"
            />
            <!-- Fallback: 2x2 mosaic of library track thumbs when the
                 cover URL is missing or 404'd. -->
            <template v-else-if="fallbackCovers(album).length === 4">
              <img
                v-for="(c, idx) in fallbackCovers(album)"
                :key="idx"
                :src="c"
                :alt="album.name"
                loading="lazy"
                @load="markLoaded(album.key)"
              />
            </template>
            <img
              v-else-if="fallbackCovers(album).length === 1"
              :src="fallbackCovers(album)[0]"
              :alt="album.name"
              loading="lazy"
              @load="markLoaded(album.key)"
            />
          </div>
          <span class="discover-card-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </span>
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
