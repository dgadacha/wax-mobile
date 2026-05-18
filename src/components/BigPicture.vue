<script setup>
import { computed, onBeforeUnmount, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { useViewStore } from '@/stores/view';
import { t } from '@/lib/i18n';
import { onThumbError, onThumbLoad, parseTrackTitle, gradientFromString } from '@/lib/format';
import { ICON_HEART, ICON_HEART_OUTLINE } from '@/lib/icons';
import { showLyrics } from '@/composables/useLyrics';

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

const parsed = computed(() => current.value ? parseTrackTitle(current.value) : { artist: '', song: '' });
const artist = computed(() => parsed.value.artist || current.value?.uploader || '');
const song = computed(() => parsed.value.song || current.value?.title || '');
const fav = computed(() => current.value && lib.isFavorite(current.value));
const heroBg = computed(() => artist.value ? gradientFromString(artist.value) : '');

function close() { player.closeBigPicture(); }
function toggleFav() { if (current.value) lib.toggleFav(current.value); }
function openArtist() {
  if (!artist.value) return;
  view.switchTo('artist', artist.value);
  close();
}

// Esc closes — listener bound only while open so it doesn't compete
// with other modals when this view isn't visible.
function onKey(e) { if (e.key === 'Escape') close(); }
watch(() => player.bigPictureOpen, (open) => {
  if (open) document.addEventListener('keydown', onKey);
  else document.removeEventListener('keydown', onKey);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <transition name="bp-fade">
      <div
        v-if="player.bigPictureOpen && current"
        class="big-picture"
        :style="current.thumbnail ? { '--bp-bg': `url('${current.thumbnail}')` } : null"
        @click.self="close"
      >
        <button class="bp-close" :title="t('common.close')" :aria-label="t('common.close')" @click="close">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
        <div class="bp-content">
          <div class="bp-cover-wrap" :style="{ backgroundImage: heroBg }">
            <img
              class="bp-cover"
              :src="current.thumbnail || ''"
              :alt="song"
              @error="onThumbError"
              @load="onThumbLoad"
            />
          </div>
          <div class="bp-meta">
            <div class="bp-eyebrow">{{ t('player.now_playing') }}</div>
            <h1 class="bp-title">{{ song }}</h1>
            <a v-if="artist" class="bp-artist" @click="openArtist">{{ artist }}</a>
            <div class="bp-actions">
              <button
                class="icon-btn round large"
                :class="{ 'is-liked': fav }"
                :title="fav ? t('player.remove_from_favorites') : t('player.add_to_favorites')"
                @click="toggleFav"
                v-html="fav ? ICON_HEART : ICON_HEART_OUTLINE"
              ></button>
              <button class="icon-btn round large" :title="t('player.lyrics')" @click="showLyrics">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M4 6h16M4 12h12M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>
