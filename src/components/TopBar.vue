<script setup>
import { computed } from 'vue';
import { useViewStore } from '@/stores/view';
import { t } from '@/lib/i18n';

const view = useViewStore();
const canBack = computed(() => view.history.length > 0);

function back() { view.back(); }
</script>

<template>
  <header class="topbar">
    <div class="topbar-nav">
      <button
        class="topbar-arrow"
        :disabled="!canBack"
        :title="t('artist.back')"
        :aria-label="t('artist.back')"
        @click="back"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button
        class="topbar-arrow"
        disabled
        aria-label="Forward"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </header>
</template>
