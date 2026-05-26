<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Play } from 'lucide-vue-next';
import { apiUrl } from '@/lib/api';

const props = defineProps({
  // Big square cover (album art, playlist gradient, artist photo).
  cover: { type: String, default: '' },
  // Circular variant for artist heroes.
  shape: { type: String, default: 'square' }, // 'square' | 'circle'
  // Fallback color when no cover is loaded.
  bgGradient: { type: String, default: '' },
  // Tag shown above the title (Album / Playlist / Artiste / Mix).
  eyebrow: { type: String, default: '' },
  title: { type: String, default: '' },
  // Either a string or a slot — pass plain text or use #subtitle.
  subtitle: { type: String, default: '' },
  // Display the round play FAB (true for almost every hero).
  showPlay: { type: Boolean, default: true },
  playLabel: { type: String, default: 'Lire' },
});

const emit = defineEmits(['play', 'more']);

const fallbackStyle = computed(() =>
  props.bgGradient ? { background: props.bgGradient } : null,
);
const coverSrc = computed(() => apiUrl(props.cover));

// Scroll-driven progress 0..1 for the Spotify-style shrink-as-you-
// scroll hero. We hand-listen on .view-scroll (the only scroll
// container in the app) instead of using IntersectionObserver because
// we need a smooth continuous value, not a discrete in/out signal.
const scrollProgress = ref(0);
let scrollEl = null;
const FADE_DISTANCE = 220; // px to fade out by

function onScroll() {
  if (!scrollEl) return;
  const y = scrollEl.scrollTop;
  scrollProgress.value = Math.max(0, Math.min(1, y / FADE_DISTANCE));
}

onMounted(() => {
  // .view-scroll is the only scrolling element in the shell. The hero
  // can be inside any sub-view (album / playlist / artist), but they
  // all render into the same scroll container.
  scrollEl = document.querySelector('.app-shell .view-scroll');
  if (scrollEl) {
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    // Reset progress when remounting — sub-views are v-if'd, so a
    // hero appearing for the first time should start un-scrolled
    // regardless of where the previous view was.
    scrollEl.scrollTop = 0;
    scrollProgress.value = 0;
  }
});
onBeforeUnmount(() => {
  if (scrollEl) scrollEl.removeEventListener('scroll', onScroll);
});

// Transform the cover + title block as the user scrolls. Cover shrinks
// and fades; title slides up + fades. The compositor handles both via
// transform/opacity → no layout thrash on scroll.
const coverStyle = computed(() => {
  const p = scrollProgress.value;
  const scale = 1 - p * 0.4; // 1 → 0.6
  return {
    transform: `scale(${scale})`,
    opacity: 1 - p * 1.2,
  };
});
const titleStyle = computed(() => {
  const p = scrollProgress.value;
  return {
    transform: `translateY(${-p * 30}px)`,
    opacity: 1 - p * 1.6,
  };
});
const bgStyle = computed(() => {
  const p = scrollProgress.value;
  return { opacity: 0.45 * (1 - p * 0.6) };
});
</script>

<template>
  <header class="mh">
    <!-- Blurred backdrop: same image as the cover, scaled up + blurred, with a
         dark vignette fading to the page bg. Gives the immersive
         Spotify/Deezer feel without needing a separate banner asset. -->
    <div
      class="mh-bg"
      :style="[
        cover ? { backgroundImage: `url('${coverSrc}')` } : fallbackStyle,
        bgStyle,
      ]"
    />
    <div class="mh-fade" />

    <div class="mh-body">
      <div class="mh-cover-wrap" :class="`shape-${shape}`" :style="coverStyle">
        <img
          v-if="cover"
          class="mh-cover"
          :src="coverSrc"
          alt=""
          loading="eager"
        />
        <div v-else class="mh-cover mh-cover-fallback" :style="fallbackStyle" />
      </div>

      <div class="mh-text" :style="titleStyle">
        <div v-if="eyebrow" class="mh-eyebrow">{{ eyebrow }}</div>
        <h1 class="mh-title">{{ title }}</h1>
        <div v-if="subtitle || $slots.subtitle" class="mh-sub">
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
      </div>

      <div v-if="$slots.actions || showPlay" class="mh-actions">
        <slot name="actions" />
        <button v-if="showPlay" class="mh-play" :aria-label="playLabel" @click="emit('play')">
          <Play :size="24" :stroke-width="2.5" color="var(--bg)" fill="var(--bg)" />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.mh {
  position: relative;
  padding: 16px 16px 20px;
  isolation: isolate;
  overflow: hidden;
}

.mh-bg {
  position: absolute;
  inset: -40px;
  background-size: cover;
  background-position: center;
  filter: blur(40px) saturate(1.2);
  opacity: 0.45;
  z-index: -2;
}

.mh-fade {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 80% at 50% 0%, transparent 0%, var(--bg) 90%),
    linear-gradient(180deg, rgba(13, 15, 20, 0.2) 0%, var(--bg) 100%);
  z-index: -1;
}

.mh-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
}

.mh-cover-wrap {
  width: min(60vw, 240px);
  aspect-ratio: 1 / 1;
  margin-bottom: 16px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
  transform-origin: center top;
  transition: transform 0s, opacity 0s;
  will-change: transform, opacity;
}
/* Eyebrow + title + subtitle grouped so the scroll-driven transform
 * affects them as one block. Centered to match the original layout
 * (the parent was already a flex column centering its children). */
.mh-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  will-change: transform, opacity;
}
.mh-cover-wrap.shape-square { border-radius: 8px; overflow: hidden; }
.mh-cover-wrap.shape-circle { border-radius: 50%; overflow: hidden; }

.mh-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.mh-cover-fallback { background: var(--card-hover); }

.mh-eyebrow {
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 1.4px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.mh-title {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 700;
  margin: 0;
  text-align: center;
  color: var(--text);
  line-height: 1.15;
  /* Long titles wrap rather than truncate — keeps the page readable. */
  max-width: 100%;
  word-break: break-word;
}

.mh-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 8px;
  text-align: center;
  line-height: 1.4;
}

.mh-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  width: 100%;
  justify-content: flex-end;
}

.mh-play {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent);
  border: 0;
  display: grid;
  place-items: center;
}
</style>
