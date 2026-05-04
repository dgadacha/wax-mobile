<script setup>
import { computed } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { useViewStore } from '@/stores/view';
import { t } from '@/lib/i18n';
import { onThumbError, onThumbLoad, parseTrackTitle, normalizeArtistKey, gradientFromString } from '@/lib/format';
import { showLyrics } from '@/composables/useLyrics';
import QueueItem from './QueueItem.vue';
import { ICON_HEART, ICON_HEART_OUTLINE } from '@/lib/icons';

const player = usePlayerStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const view = useViewStore();

function findTrack(id) {
  return lib.findById(id) || streams.get(id);
}

const current = computed(() => {
  const id = player.queue[player.index];
  return id ? findTrack(id) : null;
});

const parsedArtist = computed(() => {
  if (!current.value) return '';
  return parseTrackTitle(current.value).artist || current.value.uploader || '';
});
const parsedSong = computed(() => {
  if (!current.value) return '';
  return parseTrackTitle(current.value).song || current.value.title;
});

const upcoming = computed(() => {
  const out = [];
  const start = player.index + 1;
  for (let i = start; i < player.queue.length; i++) {
    const tr = findTrack(player.queue[i]);
    if (tr) out.push({ track: tr, qIdx: i });
  }
  return out;
});

const fav = computed(() => current.value && lib.isFavorite(current.value));
const heroBg = computed(() =>
  parsedArtist.value ? gradientFromString(parsedArtist.value) : '',
);

function toggleFav() {
  if (!current.value) return;
  lib.toggleFav(current.value);
}

function openArtist() {
  if (!parsedArtist.value) return;
  view.switchTo('artist', parsedArtist.value);
}

function openLyrics() {
  showLyrics();
}
</script>

<template>
  <aside class="now-playing">
    <template v-if="current">
      <div class="np-cover-wrap" :style="{ backgroundImage: heroBg }">
        <img
          class="np-cover"
          :src="current.thumbnail || ''"
          alt=""
          loading="lazy"
          @error="onThumbError"
          @load="onThumbLoad"
        />
      </div>
      <div class="np-meta">
        <div class="np-title">{{ parsedSong }}</div>
        <a
          v-if="parsedArtist"
          class="np-artist"
          :title="t('artist.go_to', parsedArtist)"
          @click="openArtist"
        >{{ parsedArtist }}</a>
        <span v-else class="np-artist np-artist-static">{{ current.uploader || '' }}</span>
      </div>
      <div class="np-actions">
        <button
          class="icon-btn round large"
          :class="{ 'is-liked': fav }"
          :title="fav ? t('player.remove_from_favorites') : t('player.add_to_favorites')"
          @click="toggleFav"
          v-html="fav ? ICON_HEART : ICON_HEART_OUTLINE"
        ></button>
        <button
          class="icon-btn round large"
          :title="t('player.lyrics')"
          @click="openLyrics"
        >
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M4 6h16M4 12h12M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="np-queue">
        <h3 class="np-section-heading">{{ t('queue.next_up') }}</h3>
        <ul class="queue-list">
          <QueueItem
            v-for="item in upcoming"
            :key="item.qIdx"
            :track="item.track"
            :q-idx="item.qIdx"
            :is-current="false"
          />
        </ul>
        <p v-if="upcoming.length === 0" class="np-empty">{{ t('queue.empty_after') }}</p>
      </div>
    </template>
    <div v-else class="np-idle">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" aria-hidden="true">
        <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
        <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      </svg>
      <p>{{ t('queue.empty') }}</p>
    </div>
  </aside>
</template>
