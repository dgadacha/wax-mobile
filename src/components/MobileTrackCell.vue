<script setup>
import { computed, ref } from 'vue';
import { Heart, MoreHorizontal, Play, Check, Download as DownloadIcon } from 'lucide-vue-next';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';

const props = defineProps({
  track: { type: Object, required: true },
  // Show the leading numeric index (Spotify-style for albums / playlists).
  index: { type: Number, default: 0 },
  showIndex: { type: Boolean, default: false },
  // 'thumb' shows the cover art instead of the index.
  variant: { type: String, default: 'thumb' }, // 'thumb' | 'index'
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
  // Drives the circular progress ring shown in place of the offline
  // indicator while the MP3 is being fetched server-side.
  downloadProgress: { type: Number, default: null },
});

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
  if (t.uploader) bits.push(t.uploader);
  if (t.duration) bits.push(fmtDuration(t.duration));
  return bits.join(' · ');
});

function onCellClick() { emit('play'); }

// Heart-tap pop animation. The class is added on click and removed
// 420 ms later — long enough for the CSS keyframe to play out once.
// Spotify/Apple Music both do a short scale bounce on like; reads
// as "I registered your choice" instantly.
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
      <Play v-else-if="isPlaying" :size="14" :stroke-width="2.5" color="var(--accent)" fill="var(--accent)" />
      <span v-else>{{ index + 1 }}</span>
    </div>

    <div v-if="variant === 'thumb'" class="thumb">
      <img v-if="track.thumbnail" :src="apiUrl(track.thumbnail)" alt="" loading="lazy" />
    </div>

    <div class="meta">
      <div class="title">{{ track.title }}</div>
      <div class="sub">{{ sub }}</div>
    </div>

    <div class="actions" @click.stop>
      <!-- Offline / download status. Four states:
           - Queued or just-started (downloadProgress === 0) → indeterminate
             spinner. yt-dlp can take 5-10s to emit its first progress
             line, and the queue can hold a track at 0% even longer; a
             dead ring at 0% looks indistinguishable from "nothing
             happening", so spin instead.
           - In flight with real progress (0 < downloadProgress < 100) →
             circular progress ring around a Download icon, accent color.
           - Downloaded (track.file) → solid Download chip, accent.
           - Otherwise → nothing rendered. -->
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
      <div
        v-else-if="track.file"
        class="mtc-dl done"
        title="Disponible hors-ligne"
        aria-label="Disponible hors-ligne"
      >
        <DownloadIcon :size="12" :stroke-width="2.5" color="var(--bg)" />
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
        <MoreHorizontal :size="20" :stroke-width="2" color="var(--text-muted)" />
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
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--motion-short) var(--ease);
  /* iOS sees the long-press as a text-selection gesture and pops
   * the Copy / Look up / Translate callout under our action sheet.
   * Disable both the callout AND text selection on rows so the
   * long-press cleanly maps to "open the menu" with no native UI
   * fighting for the same touch. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
/* Tactile feedback on press — slight scale + background tint. iOS
 * fires :active immediately on touchstart, so this gives instant
 * "I registered your tap" feedback before any other handler runs. */
.mtc:active {
  background: var(--card-hover);
  transform: scale(0.985);
  transition: transform 80ms var(--ease), background 80ms var(--ease);
}
.mtc.is-muted { opacity: 0.55; }

.mtc-index {
  /* Fixed wider column + grid centering — guarantees the digit /
   * play icon / spinner all land at the same x and the next
   * column (meta) starts at the same offset on every row, even
   * across single- and double-digit indexes. */
  width: 32px;
  display: grid;
  place-items: center;
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.mtc.is-playing .mtc-index { color: var(--accent); }

.mtc .thumb {
  width: 44px;
  height: 44px;
  border-radius: var(--r-1);
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.mtc .thumb img { width: 100%; height: 100%; object-fit: cover; }

.mtc .meta { flex: 1 1 auto; min-width: 0; }
.mtc .title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mtc.is-playing .title { color: var(--accent-bright); }
.mtc .sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 3px;
  line-height: 1.2;
  /* Uppercase normalises the visual rhythm — uploader names come
   * raw from YouTube where channel casing is inconsistent ("TSEW
   * THE KID", "Lomepal", "lord-fhel"). Forcing uppercase gives
   * every row the same caps-feel without us having to munge the
   * source string. */
  text-transform: uppercase;
  letter-spacing: 0.3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mtc .off-dot { margin-left: 4px; vertical-align: middle; }

.mtc .actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Offline/download chip on the right of each row. The "done" variant is
 * a small accent-filled pill with a Download icon — clearly distinct
 * from the per-row ellipsis + heart so users immediately see which
 * tracks they have on the device. The in-flight variant overlays a
 * Download icon on top of a circular progress ring. */
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
.mtc-dl.done {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent);
}
.mtc-btn {
  width: 32px;
  height: 32px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.mtc-btn:active { background: rgba(255, 255, 255, 0.08); }

/* Heart bounce on like — overshoot scale + settle back. Targets
 * the SVG directly so the button's :active bg stays unaffected. */
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
