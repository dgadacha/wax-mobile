<script setup>
import { t } from '@/lib/i18n';

defineProps({
  // Drops the album column when true — used by ViewAlbum where every
  // row belongs to the same album so the column would just repeat.
  noAlbum: { type: Boolean, default: false },
});
</script>

<template>
  <div
    class="track-list-header"
    :class="{ 'track-list-header--no-album': noAlbum }"
    aria-hidden="true"
  >
    <span class="track-list-header-num">#</span>
    <span></span>
    <span>{{ t('track.col_title') }}</span>
    <span v-if="!noAlbum" class="track-list-header-album">{{ t('track.col_album') }}</span>
    <span></span>
    <span class="track-list-header-duration">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
        <path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <span></span>
  </div>
</template>
