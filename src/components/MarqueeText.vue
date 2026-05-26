<script setup>
// Auto-scrolling text — measures whether the rendered text overflows
// its container; if so, runs a slow translateX animation with pauses
// at each end so the user can read the full string. If it fits, just
// renders the text statically. Same affordance as Apple Music and
// Spotify use on their now-playing track titles.
//
// Implementation notes:
//   - inline-block child so we can measure scrollWidth vs the
//     clientWidth of the parent's clipping box.
//   - ResizeObserver re-measures on viewport / font-load changes —
//     a track title can land too small initially and overflow once
//     the custom font finishes loading.
//   - Animation runs in BOTH directions (0 → -overflow → 0) so we
//     never need a discontinuous reset. 4 phases:
//       0–15%   hold left (read the start)
//       15–50%  scroll to right edge
//       50–65%  hold right (read the end)
//       65–100% scroll back to start
//   - Speed is roughly px/sec; total duration scales with overflow
//     so longer titles take longer to traverse.
//   - Edges fade via CSS mask so the text appears to enter/exit
//     instead of getting hard-clipped — small detail, big polish.
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';

const props = defineProps({
  text: { type: String, default: '' },
  // Pixels per second of horizontal scroll. 35 px/s is the iOS
  // Now Playing tempo — slow enough to read, fast enough not to
  // feel sluggish on long titles.
  speed: { type: Number, default: 35 },
});

const wrapRef = ref(null);
const innerRef = ref(null);
const overflow = ref(0); // pixels of horizontal overflow (0 = no scroll)

async function measure() {
  await nextTick();
  const w = wrapRef.value;
  const i = innerRef.value;
  if (!w || !i) return;
  const wrap = w.clientWidth;
  const text = i.scrollWidth;
  overflow.value = Math.max(0, text - wrap);
}

const animStyle = computed(() => {
  if (overflow.value === 0) return null;
  // Per-cycle duration: scroll-out + scroll-back time, plus two
  // pauses (~3 s total in the keyframes' percentages).
  const dur = (overflow.value / props.speed) * 2 + 3;
  return {
    '--marquee-shift': `-${overflow.value}px`,
    animationDuration: `${dur.toFixed(1)}s`,
  };
});

let ro = null;
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && wrapRef.value) {
    ro = new ResizeObserver(() => measure());
    ro.observe(wrapRef.value);
  }
  // Font-loading guard: re-measure once when web fonts are ready,
  // otherwise the initial scrollWidth uses fallback font metrics.
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(measure);
  }
});
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
});
watch(() => props.text, measure);
</script>

<template>
  <div ref="wrapRef" class="mq" :class="{ 'is-scrolling': overflow > 0 }">
    <span ref="innerRef" class="mq-inner" :style="animStyle">{{ text }}</span>
  </div>
</template>

<style scoped>
.mq {
  overflow: hidden;
  white-space: nowrap;
  width: 100%;
  /* Soft fade on both edges — only visible when the text scrolls.
   * Static (fitting) text uses the same mask but the gradient lands
   * outside the text bounds, so it doesn't dim. */
  mask-image: linear-gradient(90deg, transparent 0, black 10px, black calc(100% - 10px), transparent 100%);
  -webkit-mask-image: linear-gradient(90deg, transparent 0, black 10px, black calc(100% - 10px), transparent 100%);
}
.mq-inner {
  display: inline-block;
  /* Inherits font + color from the parent so the marquee is
   * invisible until needed. */
}
.mq.is-scrolling .mq-inner {
  animation-name: mq-shift;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}
@keyframes mq-shift {
  0%, 15%   { transform: translateX(0); }
  50%, 65%  { transform: translateX(var(--marquee-shift)); }
  100%      { transform: translateX(0); }
}
</style>
