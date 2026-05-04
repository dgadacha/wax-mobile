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
    <span></span>
    <span></span>
    <span>{{ t('track.col_title') }}</span>
    <span v-if="!noAlbum" class="track-list-header-album">{{ t('track.col_album') }}</span>
    <span></span>
    <span></span>
    <span></span>
  </div>
</template>
