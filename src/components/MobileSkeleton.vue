<script setup>
/**
 * Tiny shimmer skeleton. Reuses the .sh / @keyframes shimmer rules from
 * ViewSearch (now hoisted to mobile.css). Two variants:
 *   - variant="row"  → MobileTrackCell-shaped row (thumb + 2 lines)
 *   - variant="card" → grid card (square cover + 2 lines)
 *
 * Repeat N rows/cards via `count` (default 6).
 */
defineProps({
  variant: { type: String, default: 'row' },
  count: { type: Number, default: 6 },
});
</script>

<template>
  <div v-if="variant === 'card'" class="skel-grid">
    <div v-for="i in count" :key="i" class="skel-card">
      <div class="sh skel-card-cover" />
      <div class="sh skel-card-title" />
      <div class="sh skel-card-sub" />
    </div>
  </div>
  <div v-else class="skel-list">
    <div v-for="i in count" :key="i" class="shimmer-row">
      <div class="sh sh-thumb" />
      <div class="sh-meta">
        <div class="sh sh-title" />
        <div class="sh sh-sub" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.skel-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 0 12px;
}
.skel-card {
  background: var(--card);
  border-radius: 8px;
  padding: 8px;
}
.skel-card-cover {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 6px;
  margin-bottom: 8px;
}
.skel-card-title { height: 12px; width: 80%; }
.skel-card-sub { height: 10px; width: 50%; margin-top: 6px; }
.skel-list { padding: 4px 0; }
</style>
