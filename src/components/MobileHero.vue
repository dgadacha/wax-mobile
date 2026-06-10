<script setup>
// Spotify-style hero for detail views (album / playlist / artist / mix).
//
// Layouts:
//   square / circle — cover centered on a vertical gradient pulled from
//     the artwork's dominant color, then a LEFT-aligned text block
//     (title / subtitle / meta) and an action row whose right edge is
//     the green play FAB. The floating nav-bar overlays the top.
//   banner — full-bleed artist photo with the name overlaid at the
//     bottom (Spotify artist page). Subtitle/meta/actions flow below.
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Play, Pause } from 'lucide-vue-next';
import { apiUrl } from '@/lib/api';
import { extractDominantColor } from '@/lib/extractColor';

const props = defineProps({
  cover: { type: String, default: '' },
  shape: { type: String, default: 'square' }, // 'square' | 'circle' | 'banner'
  // Fallback color when no cover is loaded.
  bgGradient: { type: String, default: '' },
  title: { type: String, default: '' },
  // Strong secondary line (artist / owner). Slot #subtitle overrides.
  subtitle: { type: String, default: '' },
  // Muted meta line ("Album · 2000 · 12 titres").
  meta: { type: String, default: '' },
  // Display the round play FAB (true for almost every hero).
  showPlay: { type: Boolean, default: true },
  // When true the FAB shows a pause glyph (this context is playing).
  playing: { type: Boolean, default: false },
  playLabel: { type: String, default: 'Lire' },
});

const emit = defineEmits(['play']);

const coverSrc = computed(() => apiUrl(props.cover));
const isBanner = computed(() => props.shape === 'banner');

// Dominant color → hero gradient. Falls back to the string-hash
// gradient (bgGradient prop) when there's no artwork to sample.
const tint = ref('');
watch(
  () => coverSrc.value,
  async (src) => {
    tint.value = '';
    if (!src) return;
    const hex = await extractDominantColor(src);
    if (hex) tint.value = hex;
  },
  { immediate: true },
);
const gradientStyle = computed(() => {
  if (tint.value) {
    return {
      background: `linear-gradient(180deg,
        color-mix(in srgb, ${tint.value} 62%, #202020) 0%,
        color-mix(in srgb, ${tint.value} 30%, var(--bg)) 60%,
        var(--bg) 100%)`,
    };
  }
  if (props.bgGradient) return { background: props.bgGradient };
  return { background: 'linear-gradient(180deg, #2e2e2e 0%, var(--bg) 100%)' };
});

// Scroll-driven progress 0..1 for the shrink-as-you-scroll hero.
const scrollProgress = ref(0);
let scrollEl = null;
const FADE_DISTANCE = 220; // px to fade out by

function onScroll() {
  if (!scrollEl) return;
  const y = scrollEl.scrollTop;
  scrollProgress.value = Math.max(0, Math.min(1, y / FADE_DISTANCE));
}

onMounted(() => {
  scrollEl = document.querySelector('.app-shell .view-scroll');
  if (scrollEl) {
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    scrollEl.scrollTop = 0;
    scrollProgress.value = 0;
  }
});
onBeforeUnmount(() => {
  if (scrollEl) scrollEl.removeEventListener('scroll', onScroll);
});

const coverStyle = computed(() => {
  const p = scrollProgress.value;
  const scale = 1 - p * 0.35; // 1 → 0.65
  return {
    transform: `scale(${scale})`,
    opacity: 1 - p * 1.2,
  };
});
const bannerImgStyle = computed(() => {
  const p = scrollProgress.value;
  return { opacity: 1 - p * 1.1, transform: `translateY(${p * 36}px)` };
});
</script>

<template>
  <header class="mh" :class="[`shape-${shape}`]">
    <!-- Gradient backdrop (square/circle) — dominant color → page bg. -->
    <div v-if="!isBanner" class="mh-bg" :style="gradientStyle" />

    <!-- Banner photo (artist) — bleeds under the status bar + nav. -->
    <div v-if="isBanner" class="mh-banner">
      <img
        v-if="cover"
        class="mh-banner-img"
        :src="coverSrc"
        alt=""
        loading="eager"
        :style="bannerImgStyle"
      />
      <div v-else class="mh-banner-fallback" :style="gradientStyle" />
      <div class="mh-banner-scrim" />
      <h1 class="mh-banner-title">{{ title }}</h1>
    </div>

    <div class="mh-body">
      <div v-if="!isBanner" class="mh-cover-wrap" :style="coverStyle">
        <img
          v-if="cover"
          class="mh-cover"
          :src="coverSrc"
          alt=""
          loading="eager"
        />
        <div v-else class="mh-cover mh-cover-fallback" :style="bgGradient ? { background: bgGradient } : null" />
      </div>

      <div class="mh-text">
        <h1 v-if="!isBanner" class="mh-title">{{ title }}</h1>
        <div v-if="subtitle || $slots.subtitle" class="mh-sub">
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
        <div v-if="meta" class="mh-meta">{{ meta }}</div>
      </div>

      <div v-if="$slots.actions || showPlay" class="mh-actions">
        <div class="mh-actions-left">
          <slot name="actions" />
        </div>
        <button v-if="showPlay" class="mh-play" :aria-label="playLabel" @click="emit('play')">
          <component
            :is="playing ? Pause : Play"
            :size="26"
            :stroke-width="0"
            fill="var(--on-accent)"
            color="var(--on-accent)"
          />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.mh {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  /* The floating nav-bar overlays the hero — clear it. */
  padding: calc(var(--safe-top) + 64px) 16px 8px;
}
.mh.shape-banner { padding: 0 0 8px; }

.mh-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
}

.mh-body {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.shape-banner .mh-body { padding: 0 16px; }

.mh-cover-wrap {
  width: min(58vw, 236px);
  aspect-ratio: 1 / 1;
  margin-bottom: 20px;
  box-shadow: 0 20px 56px rgba(0, 0, 0, 0.55);
  transform-origin: center top;
  will-change: transform, opacity;
  border-radius: 6px;
  overflow: hidden;
}
.shape-circle .mh-cover-wrap { border-radius: 50%; }

.mh-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.mh-cover-fallback { background: var(--card-hover); }

/* Banner (artist) — full-bleed photo, name pinned bottom-left. */
.mh-banner {
  position: relative;
  height: min(42vh, 340px);
  margin-bottom: 14px;
  overflow: hidden;
}
.mh-banner-img,
.mh-banner-fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  will-change: transform, opacity;
}
.mh-banner-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0.25) 0%,
    rgba(0, 0, 0, 0) 35%,
    rgba(18, 18, 18, 0.25) 70%,
    var(--bg) 100%);
}
.mh-banner-title {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 4px;
  margin: 0;
  font: 800 44px/1.05 var(--font-display);
  letter-spacing: -1px;
  color: #fff;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45);
  word-break: break-word;
}

/* Left-aligned text block — Spotify album/playlist layout. */
.mh-text {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.mh-title {
  font: 800 24px/1.15 var(--font-display);
  letter-spacing: -0.4px;
  margin: 0;
  color: var(--text);
  word-break: break-word;
}
.mh-sub {
  font: 700 13px/1.4 var(--font-body);
  color: var(--text);
  margin-top: 8px;
}
.mh-meta {
  font: 400 13px/1.4 var(--font-body);
  color: var(--text-muted);
  margin-top: 4px;
}

.mh-actions {
  display: flex;
  align-items: center;
  width: 100%;
  margin-top: 10px;
  min-height: 56px;
}
.mh-actions-left {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Pull the icon row toward the edge so bare icons align with the
   * text block (Spotify uses borderless icons here). */
  margin-left: -8px;
}
.mh-play {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent);
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.mh-play:active { transform: scale(0.94); }
</style>
