<script setup>
import { computed, ref } from 'vue';
import { Heart, MoreVertical, Download as DownloadIcon, ArrowDownCircle } from 'lucide-vue-next';
import { usePlayerStore } from '@/stores/player';
import { fmtDuration, displayTitle, displayArtist } from '@/lib/format';
import { apiUrl } from '@/lib/api';

const props = defineProps({
  track: { type: Object, required: true },
  // Leading numeric index (kept for contexts that want it explicitly).
  index: { type: Number, default: 0 },
  showIndex: { type: Boolean, default: false },
  // 'thumb' shows the cover art, 'index' the track number, 'plain'
  // nothing on the left — Spotify's album tracklist layout.
  variant: { type: String, default: 'thumb' }, // 'thumb' | 'index' | 'plain'
  isPlaying: { type: Boolean, default: false },
  isLiked: { type: Boolean, default: false },
  // Show the heart icon on the right (omit on rows where like makes no sense).
  showLike: { type: Boolean, default: true },
  // Show the action-sheet trigger.
  showMore: { type: Boolean, default: true },
  // For missing-album-track rows that need to resolve before play.
  loading: { type: Boolean, default: false },
  // Visual desaturation for unmatched album rows.
  muted: { type: Boolean, default: false },
  // 0..100 when a download is in flight for this track; null otherwise.
  // Drives the circular progress ring shown while the MP3 is being
  // fetched server-side.
  downloadProgress: { type: Number, default: null },
});

// Global play state so the now-playing equalizer bars freeze on pause
// instead of lying about audio that isn't running.
const player = usePlayerStore();

// SVG ring geometry: r=8 → circumference = 2πr ≈ 50.27. Stroke-dashoffset
// goes from full circumference (0%) to 0 (100%).
const RING_CIRC = 50.27;
const ringDashoffset = computed(() => {
  const p = Math.max(0, Math.min(100, props.downloadProgress || 0));
  return RING_CIRC * (1 - p / 100);
});

const emit = defineEmits(['play', 'like', 'more']);

const sub = computed(() => {
  const t = props.track;
  const bits = [];
  const artist = displayArtist(t);
  if (artist) bits.push(artist);
  if (t.duration) bits.push(fmtDuration(t.duration));
  return bits.join(' · ');
});

// "Available offline" = a genuinely DOWNLOADED library track (file =
// '/audio/<id>.mp3'). Stream/mix/recommended tracks carry a `file` too —
// but it's the '/api/stream/<ytId>' endpoint, NOT a downloaded MP3 — so
// guarding on `track.file` alone falsely badges un-downloaded mix tracks
// as offline. Exclude streams (isStream flag + the stream path).
const isOffline = computed(() => {
  const f = props.track.file;
  return !!f && !props.track.isStream && !f.includes('/api/stream');
});

function onCellClick() { emit('play'); }

// Heart-tap pop animation. The class is added on click and removed
// 420 ms later — long enough for the CSS keyframe to play out once.
const likeBouncing = ref(false);
function onLikeClick() {
  likeBouncing.value = true;
  setTimeout(() => { likeBouncing.value = false; }, 420);
  emit('like');
}
</script>

<template>
  <div
    class="mtc track-cell"
    :class="{
      'is-playing': isPlaying,
      'is-loading': loading,
      'is-muted': muted,
    }"
    @click="onCellClick"
  >
    <div v-if="variant === 'index' || showIndex" class="mtc-index">
      <van-loading v-if="loading" size="14" color="var(--accent)" />
      <span v-else>{{ index + 1 }}</span>
    </div>

    <div v-if="variant === 'thumb'" class="thumb">
      <img v-if="track.thumbnail" :src="apiUrl(track.thumbnail)" alt="" loading="lazy" />
    </div>

    <div class="meta">
      <div class="title-row">
        <!-- Spotify's animated now-playing bars — green, frozen on pause. -->
        <span
          v-if="isPlaying"
          class="mtc-eq"
          :class="{ paused: !player.playing }"
          aria-hidden="true"
        >
          <i /><i /><i />
        </span>
        <van-loading v-else-if="loading && variant === 'plain'" size="13" color="var(--accent)" />
        <span class="title">{{ displayTitle(track) }}</span>
      </div>
      <div class="sub">
        <span
          v-if="isOffline && downloadProgress == null"
          class="mtc-off"
          title="Disponible hors-ligne"
          aria-label="Disponible hors-ligne"
        >
          <ArrowDownCircle :size="13" :stroke-width="2.4" />
        </span>
        <span class="sub-text">{{ sub }}</span>
      </div>
    </div>

    <div class="actions" @click.stop>
      <!-- Download in flight: indeterminate spinner while queued (yt-dlp
           can take a while before the first progress line), then a
           progress ring once real numbers arrive. -->
      <div
        v-if="downloadProgress != null && downloadProgress <= 0"
        class="mtc-dl mtc-dl-spin"
        aria-label="Téléchargement en attente"
      >
        <van-loading size="18" color="var(--accent)" />
      </div>
      <div
        v-else-if="downloadProgress != null"
        class="mtc-dl"
        aria-label="Téléchargement en cours"
      >
        <svg viewBox="0 0 20 20" width="22" height="22">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" stroke-width="2" />
          <circle
            cx="10" cy="10" r="8" fill="none"
            stroke="var(--accent)" stroke-width="2"
            :stroke-dasharray="RING_CIRC"
            :stroke-dashoffset="ringDashoffset"
            stroke-linecap="round"
            transform="rotate(-90 10 10)"
          />
        </svg>
        <DownloadIcon class="mtc-dl-icon" :size="10" :stroke-width="2.5" color="var(--accent)" />
      </div>

      <button
        v-if="showLike"
        class="mtc-btn mtc-like"
        :class="{ 'is-bouncing': likeBouncing }"
        :aria-label="isLiked ? 'Retirer' : `J'aime`"
        @click="onLikeClick"
      >
        <Heart
          :size="20"
          :stroke-width="2"
          :color="isLiked ? 'var(--accent)' : 'var(--text-muted)'"
          :fill="isLiked ? 'var(--accent)' : 'transparent'"
        />
      </button>
      <button
        v-if="showMore"
        class="mtc-btn"
        aria-label="Plus"
        @click="emit('more')"
      >
        <MoreVertical :size="20" :stroke-width="2" color="var(--text-muted)" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.mtc {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  transition: background var(--motion-short) var(--ease);
  /* iOS sees the long-press as a text-selection gesture and pops
   * the Copy / Look up / Translate callout under our action sheet.
   * Disable both so the touch cleanly maps to our handlers. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
.mtc:active {
  background: rgba(255, 255, 255, 0.06);
}
.mtc.is-muted { opacity: 0.45; }

.mtc-index {
  width: 28px;
  display: grid;
  place-items: center;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.mtc.is-playing .mtc-index { color: var(--accent); }

.mtc .thumb {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--card);
  flex: 0 0 auto;
}
.mtc .thumb img { width: 100%; height: 100%; object-fit: cover; }

.mtc .meta { flex: 1 1 auto; min-width: 0; }
.mtc .title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mtc .title {
  font: 500 16px/1.3 var(--font-body);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.mtc.is-playing .title { color: var(--accent); }
.mtc .sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font: 400 13px/1.3 var(--font-body);
  color: var(--text-muted);
  margin-top: 3px;
  min-width: 0;
}
.mtc .sub-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
/* Green "available offline" arrow inline with the subtitle — exactly
 * where Spotify puts its downloaded badge. */
.mtc-off {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--accent);
}

.mtc .actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.mtc-dl {
  position: relative;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
}
.mtc-dl-icon {
  position: absolute;
  inset: 0;
  margin: auto;
}
.mtc-btn {
  width: 34px;
  height: 34px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.mtc-btn:active { background: rgba(255, 255, 255, 0.08); }

/* Now-playing equalizer bars — 3 bars bouncing at staggered phases,
 * frozen mid-pose while paused. */
.mtc-eq {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  width: 14px;
  height: 13px;
}
.mtc-eq i {
  width: 3px;
  border-radius: 1px;
  background: var(--accent);
  transform-origin: bottom;
  animation: mtc-eq-bounce 0.9s ease-in-out infinite;
}
.mtc-eq i:nth-child(1) { height: 60%; animation-delay: -0.4s; }
.mtc-eq i:nth-child(2) { height: 100%; animation-delay: -0.1s; }
.mtc-eq i:nth-child(3) { height: 45%; animation-delay: -0.65s; }
.mtc-eq.paused i { animation-play-state: paused; }
@keyframes mtc-eq-bounce {
  0%, 100% { transform: scaleY(0.45); }
  50% { transform: scaleY(1); }
}

/* Heart bounce on like — overshoot scale + settle back. */
@keyframes heart-pop {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.35); }
  60%  { transform: scale(0.92); }
  85%  { transform: scale(1.08); }
  100% { transform: scale(1); }
}
.mtc-like.is-bouncing :deep(svg) {
  animation: heart-pop 420ms cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: center;
}
</style>
