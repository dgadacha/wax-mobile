<script setup>
import { t } from '@/lib/i18n';
</script>

<template>
  <div class="track-list-header" aria-hidden="true">
    <span class="track-list-header-num">#</span>
    <span></span>
    <span>{{ t('track.col_title') }}</span>
    <span class="track-list-header-album">{{ t('track.col_album') }}</span>
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
