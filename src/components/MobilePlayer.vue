<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import {
  Play, Pause, SkipBack, SkipForward, Heart, ChevronDown,
  ListMusic, MessageSquareText, Shuffle, Repeat, Repeat1, X, Gauge,
} from 'lucide-vue-next';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePrefsStore } from '@/stores/prefs';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import { fetchLyrics } from '@/composables/useLyrics';
import { showToast } from '@/lib/toast';
import { t } from '@/lib/i18n';
import MarqueeText from '@/components/MarqueeText.vue';
import { useVisualizer, setEq } from '@/composables/useVisualizer';
import { useGestures } from '@/composables/useGestures';
import { applyAccent, revertAccentToUser } from '@/stores/prefs';
import { extractDominantColor } from '@/lib/extractColor';

const player = usePlayerStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const prefs = usePrefsStore();

const audioRef = ref(null);
const audio2Ref = ref(null);
const fullscreen = ref(false);
const queueOpen = ref(false);
// Playback speed bottom-sheet. Lives next to the lyrics overlay
// inside the fullscreen player so the user can scrub the slider
// without leaving the listening context.
const speedSheetOpen = ref(false);
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const speedLabel = computed(() =>
  player.playbackRate.toFixed(2).replace(/\.?0+$/, '') + '×',
);
function onSpeedChange(v) { player.setPlaybackRate(v); }
function pickSpeedPreset(v) {
  haptics.selection();
  player.setPlaybackRate(v);
}
function toggleSpeedSheet() {
  haptics.light();
  speedSheetOpen.value = !speedSheetOpen.value;
}

// Lyrics overlay state — slides up over the player content (Spotify
// style). Owned here instead of a global modal so it can sit inside
// the fullscreen player popup, react to player.currentTime in real
// time, and dismiss without bumping the modal z-index stack.
const lyricsOpen = ref(false);
const lyricsLoading = ref(false);
const lyricsStatus = ref(''); // '' | 'ok' | 'error' | 'not_found'
const lyricsContent = ref('');
const lyricsSynced = ref([]); // [{ time, text }] when lrclib had a match
const lyricsArtist = ref('');
const lyricsTitle = ref('');
const lyricsTrackId = ref(''); // guard against stale fetch resolving for a new track
const lyricsScrollRef = ref(null);

async function toggleLyrics() {
  if (lyricsOpen.value) { lyricsOpen.value = false; return; }
  const track = player.currentTrack;
  if (!track) {
    showToast(t('toast.no_track_playing'), 'error');
    return;
  }
  lyricsOpen.value = true;
  lyricsLoading.value = true;
  lyricsStatus.value = '';
  lyricsSynced.value = [];
  lyricsTrackId.value = track.id;
  try {
    const data = await fetchLyrics(track);
    // Bail if the user skipped to another track while we were fetching.
    if (lyricsTrackId.value !== track.id) return;
    lyricsArtist.value = data.artist;
    lyricsTitle.value = data.title;
    lyricsContent.value = data.content;
    lyricsSynced.value = data.synced;
    lyricsStatus.value = 'ok';
  } catch (e) {
    if (lyricsTrackId.value !== track.id) return;
    const isNotFound = /lyrics not found/i.test(e.message || '')
      || e.message === 'Paroles introuvables';
    lyricsStatus.value = isNotFound ? 'not_found' : 'error';
    lyricsContent.value = isNotFound
      ? t('lyrics.not_found_detail', { artist: lyricsArtist.value || track.uploader, title: lyricsTitle.value || track.title })
      : t('common.error_prefix', e.message);
  } finally {
    lyricsLoading.value = false;
  }
}

// Active synced line — closest timestamp ≤ player.currentTime, via
// binary search so even a 200-line LRC computes in microseconds.
const activeLineIdx = computed(() => {
  if (lyricsSynced.value.length === 0) return -1;
  const lines = lyricsSynced.value;
  const t = player.currentTime;
  let lo = 0, hi = lines.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
});
// Auto-scroll the active line into the container's center as the
// audio progresses. Smooth scrollBehavior reads as karaoke-natural.
watch(activeLineIdx, async (idx) => {
  if (idx < 0 || !lyricsOpen.value) return;
  await nextTick();
  const container = lyricsScrollRef.value;
  if (!container) return;
  const el = container.querySelector(`[data-idx="${idx}"]`);
  if (!el) return;
  const cTop = container.getBoundingClientRect().top;
  const eTop = el.getBoundingClientRect().top;
  const delta = (eTop - cTop) - (container.clientHeight / 2 - el.clientHeight / 2);
  container.scrollBy({ top: delta, behavior: 'smooth' });
});

// Close the overlay automatically when the user skips to a new
// track (otherwise we'd show stale lyrics on top of new audio).
watch(() => player.currentTrack?.id, (id, prev) => {
  if (lyricsOpen.value && id !== prev) lyricsOpen.value = false;
});

// Gesture surfaces inside the fullscreen player.
//
//   COVER  — horizontal swipes for prev/next (iPod cover-flow /
//            Apple Music). Tracks the finger live: the cover
//            translates with the touch and fades slightly so the
//            user feels the gesture before commit, then a quick
//            snap-back tween if uncommitted.
//   BODY   — vertical swipes: ↓ dismisses the popup, ↑ opens the
//            queue. The downward drag translates the whole player
//            so the user gets a "pulling the sheet down" feel.
const npCoverRef = ref(null);
const npBodyRef = ref(null);
// Live transform state — bound into :style on the elements below.
// Reset to defaults via the `coverAnimating` / `bodyAnimating` flag
// which enables a CSS transition on snap-back / commit only.
const coverDx = ref(0);
const coverAnimating = ref(false);
const bodyDy = ref(0);
const bodyAnimating = ref(false);

const coverStyle = computed(() => ({
  // Translate the WHOLE stage — current cover + the two side
  // covers move together so the prev/next slides into view as the
  // user drags. No opacity dimming: the user is here to preview
  // what's coming, fading the strip would defeat the purpose.
  transform: `translate3d(${coverDx.value}px, 0, 0)`,
  transition: coverAnimating.value
    ? 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1)'
    : 'none',
}));
// Side covers (prev/next): invisible at rest, fade in linearly with
// drag distance. Fully opaque once the user has dragged ~120 px, so
// the preview reaches readable contrast well before commit.
const sideCoverStyle = computed(() => ({
  opacity: Math.min(1, Math.abs(coverDx.value) / 120),
  transition: coverAnimating.value
    ? 'opacity 220ms cubic-bezier(0.4, 0, 0.2, 1)'
    : 'none',
}));
const bodyStyle = computed(() => ({
  // Only allow downward drag — upward maps to a queue-open commit,
  // no need for visual tracking on that direction.
  transform: bodyDy.value > 0
    ? `translate3d(0, ${bodyDy.value}px, 0)`
    : 'translate3d(0, 0, 0)',
  // Slight fade as the user pulls down — visual hint the player is
  // about to close.
  opacity: bodyDy.value > 0
    ? 1 - Math.min(0.4, bodyDy.value / 600)
    : 1,
  transition: bodyAnimating.value
    ? 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 220ms cubic-bezier(0.4, 0, 0.2, 1)'
    : 'none',
}));

function settleCover() {
  coverAnimating.value = true;
  coverDx.value = 0;
  setTimeout(() => { coverAnimating.value = false; }, 240);
}
function settleBody() {
  bodyAnimating.value = true;
  bodyDy.value = 0;
  setTimeout(() => { bodyAnimating.value = false; }, 240);
}

// Cover commit: animate the stage all the way to the side cover's
// resting position (one cover-width + the 16 px gap), then swap
// player.next/prev AND reset coverDx to 0 in the same Vue tick so
// the user never sees a slot-shuffling flicker. Without this trick
// the moment of player.next() would teleport the cover from the
// "next" slot at +W+16 to the "current" slot at 0 — a visible jump.
function commitCover(dir) {
  const el = npCoverRef.value;
  // Stage is the same width as a cover; +16 px matches the gap that
  // separates the side covers from the current one in CSS.
  const width = (el ? el.offsetWidth : 360) + 16;
  coverAnimating.value = true;
  coverDx.value = dir === 'next' ? -width : width;
  setTimeout(() => {
    // Atomic: turn off animation, swap track, reset offset. Vue
    // batches these into one DOM patch so the user sees the new
    // current cover land at center with no in-between frame.
    coverAnimating.value = false;
    if (dir === 'next') player.next();
    else player.prev();
    coverDx.value = 0;
  }, 220);
}

useGestures(npCoverRef, {
  onProgress: ({ dx, axis }) => {
    if (axis !== 'x') { coverDx.value = 0; return; }
    coverDx.value = dx;
  },
  // Velocity-based commit (fast swipe, regardless of distance)
  onSwipeLeft: () => { haptics.light(); commitCover('next'); },
  onSwipeRight: () => { haptics.light(); commitCover('prev'); },
  onEnd: ({ committed }) => {
    if (committed) return; // commitCover already owns the animation
    // Distance-based commit fallback: a SLOW drag past ~30% of the
    // cover width still counts. Without this the user had to swipe
    // fast — a relaxed pull-to-center motion (very common) just
    // snapped back which felt unresponsive. 30% mirrors Apple
    // Music's cutoff.
    const el = npCoverRef.value;
    const width = el ? el.offsetWidth : 360;
    const threshold = width * 0.3;
    if (coverDx.value <= -threshold) { haptics.light(); commitCover('next'); }
    else if (coverDx.value >= threshold) { haptics.light(); commitCover('prev'); }
    else settleCover();
  },
});
useGestures(npBodyRef, {
  onProgress: ({ dy, axis }) => {
    if (axis !== 'y' || dy < 0) { bodyDy.value = 0; return; }
    // Resist past 200 px so the player doesn't fly off mid-swipe
    bodyDy.value = dy < 200 ? dy : 200 + (dy - 200) * 0.4;
  },
  onSwipeDown: () => { haptics.light(); fullscreen.value = false; },
  onSwipeUp: () => { haptics.light(); queueOpen.value = true; },
  onEnd: ({ committed }) => {
    if (committed) {
      settleBody();
      return;
    }
    // Slow downward drag past ~25% of viewport → dismiss anyway.
    // Same distance-fallback idea as the cover swipe.
    if (bodyDy.value >= window.innerHeight * 0.25) {
      haptics.light();
      fullscreen.value = false;
    }
    settleBody();
  },
});

const cover = computed(() => apiUrl(player.currentTrack?.thumbnail || ''));

// Side covers for the iPod-coverflow swipe preview. Pulled from the
// queue at index ± 1 so the user sees what they're about to jump to
// as they drag horizontally. Empty when the queue boundary is hit
// (no prev on the first track, no next on the last); the side slot
// just renders a transparent placeholder in that case.
function _coverFor(qIdx) {
  if (qIdx < 0 || qIdx >= player.queue.length) return '';
  const id = player.queue[qIdx];
  const tr = lib.findById(id) || streams.get(id);
  return tr ? apiUrl(tr.thumbnail || '') : '';
}
const prevCover = computed(() => _coverFor(player.index - 1));
const nextCover = computed(() => _coverFor(player.index + 1));

// Adaptive accent: each new track's cover gets sampled for its
// dominant color and pushed into --accent. Reverts to the user-
// picked accent when playback stops or the track has no cover
// available. The extraction runs off the main render frame — it's
// async + canvas-based but with a 40x40 downsample it's <20 ms.
let _lastAccentTrackId = null;
watch(
  () => player.currentTrack?.id,
  async (trackId) => {
    if (!trackId) { _lastAccentTrackId = null; revertAccentToUser(); return; }
    if (trackId === _lastAccentTrackId) return;
    _lastAccentTrackId = trackId;
    const url = apiUrl(player.currentTrack?.thumbnail || '');
    if (!url) { revertAccentToUser(); return; }
    const hex = await extractDominantColor(url);
    // Guard against a race: another track may have started while we
    // were extracting. Bail if so — the newer track's effect wins.
    if (_lastAccentTrackId !== trackId) return;
    if (hex) applyAccent(hex);
    else revertAccentToUser();
  },
);

// Resolve every queue id to a track (library or stream). The currently
// playing one gets the accent treatment.
const queueTracks = computed(() => {
  return (player.queue || []).map((id, idx) => {
    const tr = lib.findById(id) || streams.get(id);
    return tr ? { ...tr, _qIdx: idx, _isCurrent: idx === player.index } : null;
  }).filter(Boolean);
});

function jumpToQueue(idx) {
  haptics.light();
  if (idx === player.index) {
    player.togglePlay();
    return;
  }
  player.index = idx;
  player.loadAndPlay();
}

function removeFromQueue(idx) {
  if (idx === player.index) return; // can't drop the current one
  player.queue.splice(idx, 1);
  if (idx < player.index) player.index -= 1;
}
const title = computed(() => player.currentTrack?.title || '');
const sub = computed(() => player.currentTrack?.uploader || '');
const seekPct = computed(() => {
  if (!player.duration) return 0;
  return (player.currentTime / player.duration) * 100;
});

const likeBouncing = ref(false);
function toggleLike() {
  haptics.medium();
  likeBouncing.value = true;
  setTimeout(() => { likeBouncing.value = false; }, 420);
  const trackId = player.queue[player.index];
  if (!trackId) return;
  if (typeof trackId === 'string' && trackId.startsWith('stream-')) {
    const stream = streams.get(trackId);
    if (!stream) return;
    const existing = lib.tracks.find((t) => t.ytId === stream.ytId);
    if (existing) lib.remove(existing.id);
    else lib.add({
      id: stream.ytId,
      title: stream.title,
      uploader: stream.uploader,
      duration: stream.duration,
      thumbnail: stream.thumbnail,
      url: `https://www.youtube.com/watch?v=${stream.ytId}`,
    });
  } else {
    lib.remove(trackId);
  }
}

// Seekbar gesture handling. We CAN'T bind the slider directly to
// `seekPct` and commit every update:model-value to player.seekToPct,
// because each `audio.currentTime = …` triggers a buffer reload that
// then echoes back through the `timeupdate` event → updates
// player.currentTime → re-computes seekPct → fights the dragging
// finger position. Result: jittery, sticky, "two steps forward one
// step back" scrubbing.
//
// Instead: keep a local `scrubValue` that the slider binds to while
// the user is dragging. We snapshot the position on drag-start, only
// touch player.currentTime on drag-end. Mid-drag the slider feels
// instantly responsive (purely local state, no audio I/O), and the
// audio seeks exactly once at release.
const scrubbing = ref(false);
const scrubValue = ref(0);
const seekDisplayPct = computed(() => (scrubbing.value ? scrubValue.value : seekPct.value));
const seekDisplayTime = computed(() => {
  if (!scrubbing.value) return player.currentTime;
  const dur = player.duration || 0;
  return (scrubValue.value / 100) * dur;
});
function onSeekStart() {
  scrubValue.value = seekPct.value;
  scrubbing.value = true;
}
function onSeekUpdate(pct) {
  // Only meaningful while dragging — the slider also fires this
  // event on tap-to-seek (without a preceding drag-start), in which
  // case we commit immediately like before.
  if (scrubbing.value) scrubValue.value = pct;
  else player.seekToPct(pct);
}
function onSeekEnd() {
  if (!scrubbing.value) return;
  const pct = scrubValue.value;
  scrubbing.value = false;
  player.seekToPct(pct);
}

// Transport handlers with haptic feedback so the buttons feel alive on
// device. Direct player.* in the template would still work, but going
// through these wrappers lets us add the haptic in one place.
function onTogglePlay() { haptics.light(); player.togglePlay(); }
function onPrev()       { haptics.light(); player.prev(); }
function onNext()       { haptics.light(); player.next(); }
function onShuffle()    { haptics.selection(); player.toggleShuffle(); }
function onRepeat()     { haptics.selection(); player.cycleRepeat(); }

const repeatLabel = computed(() => {
  if (player.repeat === 'one') return 'Répéter le titre';
  if (player.repeat === 'all') return 'Répéter la file';
  return 'Pas de répétition';
});

onMounted(() => {
  player.bindAudio(audioRef.value, audio2Ref.value);
});

// Audio chain + visualizer + EQ. useVisualizer attaches a
// source → bass → mid → treble → analyser → destination graph
// on first play; setEq lets us push prefs.eq values into the
// BiquadFilter gain nodes live.
useVisualizer();
watch(
  () => prefs.eq,
  (eq) => setEq(eq.bass || 0, eq.mid || 0, eq.treble || 0),
  { deep: true, immediate: true },
);
</script>

<template>
  <!-- Audio elements always mounted so player.bindAudio() has stable refs.
       Hidden in both mini and fullscreen modes — controls are UI only. -->
  <audio ref="audioRef" preload="metadata" crossorigin="anonymous"></audio>
  <audio ref="audio2Ref" preload="metadata" crossorigin="anonymous"></audio>

  <!-- Mini player: docked above the tab bar when something is playing -->
  <div
    v-if="player.visible"
    class="mini-player"
    @click="fullscreen = true"
  >
    <div class="mp-thumb">
      <img v-if="cover" :src="cover" alt="" />
    </div>
    <div class="mp-meta">
      <MarqueeText class="mp-title" :text="title || 'Aucune lecture'" />
      <div class="mp-sub text-ellipsis">{{ sub }}</div>
    </div>
    <div class="mp-actions" @click.stop>
      <button class="mp-btn" :aria-label="player.playing ? 'Pause' : 'Lire'" @click="player.togglePlay()">
        <component :is="player.playing ? Pause : Play" :size="22" :stroke-width="2.5" color="var(--text)" :fill="player.playing ? 'var(--text)' : 'var(--text)'" />
      </button>
      <button
        v-if="player.queue.length > 1"
        class="mp-btn small"
        aria-label="Suivant"
        @click="player.next()"
      >
        <SkipForward :size="20" :stroke-width="2.2" color="var(--text-muted)" fill="var(--text-muted)" />
      </button>
    </div>
    <!-- Spotify-style thin progress bar pinned at the bottom of the
         mini-player. Lives on the row itself (not in the actions
         column) so it spans the full width. -->
    <div class="mp-progress" aria-hidden="true">
      <div class="mp-progress-fill" :style="{ width: seekPct + '%' }" />
    </div>
  </div>

  <!-- Fullscreen "Now Playing" — Vant popup -->
  <van-popup
    v-model:show="fullscreen"
    position="bottom"
    :style="{ height: '100%' }"
    round
    teleport="body"
    :lazy-render="false"
    class="np-popup"
  >
    <div class="np-screen">
      <!-- Cover-derived background: same image as the album art,
           massively blurred + dark vignette. Same trick as MobileHero
           but full-bleed. Gives every track its own ambient color
           palette without needing a real dominant-color extractor. -->
      <div
        v-if="cover"
        class="np-bg"
        :style="{ backgroundImage: `url('${cover}')` }"
      />
      <div class="np-bg-fade" />

      <!-- Wrapper handles the notch via padding-top so it works even when
           the popup teleports outside the document flow (env(safe-area-*)
           on van-nav-bar's internal class is sometimes flaky in fullscreen
           popups). Don't add safe-area-inset-top on the nav-bar — that
           would double-pad. -->
      <van-nav-bar
        :title="'En cours de lecture'"
        :border="false"
        @click-left="fullscreen = false"
      >
        <template #left>
          <ChevronDown :size="26" :stroke-width="2" color="var(--text)" />
        </template>
      </van-nav-bar>
      <div ref="npBodyRef" class="np-body" :style="bodyStyle">
        <!-- Cover stage — the three slots (prev / current / next)
             move together as the user drags horizontally, so they
             see exactly what's coming. Side covers are absolutely
             positioned just off-screen at -100% / +100% so they
             only become visible when dx pulls them in. -->
        <div ref="npCoverRef" class="np-cover-stage" :style="coverStyle">
          <!-- Side covers (prev/next) fade in only during a swipe —
               opacity scales with |coverDx| via :style so they're
               invisible at rest, fully opaque once the user has
               dragged ~120 px. Keeps the static player clean while
               still previewing what's coming during the gesture. -->
          <div class="np-cover np-cover-side np-cover-prev" :style="sideCoverStyle">
            <img v-if="prevCover" :src="prevCover" alt="" />
          </div>
          <div class="np-cover np-cover-current">
            <img v-if="cover" :src="cover" alt="" />
          </div>
          <div class="np-cover np-cover-side np-cover-next" :style="sideCoverStyle">
            <img v-if="nextCover" :src="nextCover" alt="" />
          </div>
        </div>
        <div class="np-meta">
          <MarqueeText class="np-title" :text="title" />
          <div class="np-sub">{{ sub }}</div>
        </div>
        <div class="np-seek">
          <van-slider
            :model-value="seekDisplayPct"
            :step="0.1"
            :min="0"
            :max="100"
            active-color="var(--accent)"
            inactive-color="var(--card)"
            bar-height="3px"
            button-size="14px"
            @drag-start="onSeekStart"
            @update:model-value="onSeekUpdate"
            @drag-end="onSeekEnd"
          />
          <div class="np-time">
            <span>{{ fmtDuration(seekDisplayTime) }}</span>
            <span>{{ fmtDuration(player.duration) }}</span>
          </div>
        </div>
        <div class="np-controls">
          <button
            class="np-ctrl ghost"
            :class="{ active: player.shuffle }"
            :aria-label="player.shuffle ? 'Aléatoire actif' : 'Aléatoire'"
            @click="onShuffle"
          >
            <Shuffle
              :size="22"
              :stroke-width="2"
              :color="player.shuffle ? 'var(--accent)' : 'var(--text-muted)'"
            />
          </button>
          <button class="np-ctrl" aria-label="Précédent" @click="onPrev">
            <SkipBack :size="30" :stroke-width="2" color="var(--text)" fill="var(--text)" />
          </button>
          <button class="np-play" @click="onTogglePlay">
            <component :is="player.playing ? Pause : Play" :size="28" :stroke-width="2.5" color="var(--bg)" fill="var(--bg)" />
          </button>
          <button class="np-ctrl" aria-label="Suivant" @click="onNext">
            <SkipForward :size="30" :stroke-width="2" color="var(--text)" fill="var(--text)" />
          </button>
          <button
            class="np-ctrl ghost"
            :class="{ active: player.repeat !== 'off' }"
            :aria-label="repeatLabel"
            @click="onRepeat"
          >
            <component
              :is="player.repeat === 'one' ? Repeat1 : Repeat"
              :size="22"
              :stroke-width="2"
              :color="player.repeat !== 'off' ? 'var(--accent)' : 'var(--text-muted)'"
            />
          </button>
        </div>
        <div class="np-extras">
          <button
            class="np-extra np-like"
            :class="{ 'is-bouncing': likeBouncing }"
            aria-label="J'aime"
            @click="toggleLike"
          >
            <Heart :size="24" :stroke-width="2"
              :color="player.isLikedCurrent ? 'var(--accent)' : 'var(--text-muted)'"
              :fill="player.isLikedCurrent ? 'var(--accent)' : 'transparent'" />
          </button>
          <button
            class="np-extra"
            :class="{ 'is-active': lyricsOpen }"
            aria-label="Paroles"
            @click="toggleLyrics"
          >
            <MessageSquareText
              :size="22"
              :stroke-width="2"
              :color="lyricsOpen ? 'var(--accent)' : 'var(--text-muted)'"
            />
          </button>
          <button
            class="np-extra np-speed-btn"
            :class="{ 'is-active': player.playbackRate !== 1 }"
            aria-label="Vitesse de lecture"
            @click="toggleSpeedSheet"
          >
            <span v-if="player.playbackRate !== 1" class="np-speed-badge">{{ speedLabel }}</span>
            <Gauge
              v-else
              :size="22"
              :stroke-width="2"
              color="var(--text-muted)"
            />
          </button>
          <button class="np-extra" aria-label="File d'attente" @click="queueOpen = true">
            <ListMusic :size="22" :stroke-width="2" color="var(--text-muted)" />
          </button>
        </div>
      </div>

      <!-- Speed bottom-sheet — slides up over the player, contains
           a continuous slider + 7 preset chips. preservesPitch is
           false so dragging the slider gives the "slowed/sped up"
           remix vibe (pitch follows tempo) rather than the time-
           stretched podcast effect. -->
      <Transition name="lyrics-slide">
        <div v-if="speedSheetOpen" class="np-speed-sheet" @click.self="speedSheetOpen = false">
          <div class="np-speed-card">
            <div class="np-speed-head">
              <div>
                <div class="np-speed-eyebrow">Vitesse</div>
                <div class="np-speed-value">{{ speedLabel }}</div>
              </div>
              <button class="np-lyrics-close" aria-label="Fermer" @click="speedSheetOpen = false">
                <X :size="22" :stroke-width="2" color="var(--text)" />
              </button>
            </div>
            <div class="np-speed-slider">
              <van-slider
                :model-value="player.playbackRate"
                :min="0.5"
                :max="2"
                :step="0.05"
                bar-height="6px"
                active-color="var(--accent)"
                inactive-color="var(--card-hover)"
                button-size="22px"
                @update:model-value="onSpeedChange"
              />
            </div>
            <div class="np-speed-chips">
              <button
                v-for="v in SPEED_PRESETS"
                :key="v"
                class="np-speed-chip"
                :class="{ active: Math.abs(player.playbackRate - v) < 0.001 }"
                @click="pickSpeedPreset(v)"
              >{{ v }}×</button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Lyrics overlay — slides up over the player content,
           Spotify-style. Lives inside the fullscreen popup so the
           backdrop / nav-bar / blurred bg stay visible underneath.
           Karaoke-style active line tracking when lrclib returned
           LRC, plain-text scroll otherwise. -->
      <Transition name="lyrics-slide">
        <div v-if="lyricsOpen" class="np-lyrics" @click.self="lyricsOpen = false">
          <div class="np-lyrics-sheet">
            <header class="np-lyrics-head">
              <div class="np-lyrics-head-text">
                <div class="np-lyrics-eyebrow">Paroles</div>
                <!-- MarqueeText handles the overflow case (long
                     "Artist — Title (feat. X)" combos that used to
                     push the close button off-screen). Same scroll-
                     when-overflowing pattern as the player titles. -->
                <MarqueeText
                  class="np-lyrics-meta"
                  :text="`${lyricsArtist} — ${lyricsTitle}`"
                />
              </div>
              <button class="np-lyrics-close" aria-label="Fermer" @click="lyricsOpen = false">
                <X :size="22" :stroke-width="2" color="var(--text)" />
              </button>
            </header>
            <div ref="lyricsScrollRef" class="np-lyrics-body">
              <div v-if="lyricsLoading" class="np-lyrics-state">Chargement…</div>
              <div v-else-if="lyricsStatus === 'not_found'" class="np-lyrics-state muted">
                Aucune parole trouvée pour ce morceau.
              </div>
              <div v-else-if="lyricsStatus === 'error'" class="np-lyrics-state error">
                {{ lyricsContent }}
              </div>
              <template v-else-if="lyricsSynced.length > 0">
                <div
                  v-for="(line, i) in lyricsSynced"
                  :key="i"
                  :data-idx="i"
                  class="lyrics-line"
                  :class="{ active: i === activeLineIdx, past: i < activeLineIdx }"
                >{{ line.text }}</div>
              </template>
              <pre v-else class="np-lyrics-plain">{{ lyricsContent }}</pre>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </van-popup>

  <!-- Queue sheet — slides up from the bottom of the fullscreen player.
       Lists every queued track; tap to jump, tap the currently playing
       one to toggle pause; long-press / X to remove. -->
  <van-popup
    v-model:show="queueOpen"
    position="bottom"
    round
    teleport="body"
    :style="{ maxHeight: '85vh' }"
    safe-area-inset-bottom
    class="queue-popup"
  >
    <div class="queue-screen">
      <div class="queue-handle" />
      <div class="queue-head">
        <h2>File d'attente</h2>
        <span class="muted">{{ queueTracks.length }} titre{{ queueTracks.length > 1 ? 's' : '' }}</span>
      </div>
      <div class="queue-list">
        <div v-if="queueTracks.length === 0" class="empty-state small">
          <div class="hint">Rien dans la file pour l'instant.</div>
        </div>
        <button
          v-for="tr in queueTracks"
          :key="tr._qIdx + '-' + tr.id"
          type="button"
          class="qrow"
          :class="{ current: tr._isCurrent }"
          @click="jumpToQueue(tr._qIdx)"
        >
          <div class="qrow-thumb">
            <img v-if="tr.thumbnail" :src="apiUrl(tr.thumbnail)" alt="" loading="lazy" />
          </div>
          <div class="qrow-meta">
            <div class="qrow-title text-ellipsis">{{ tr.title }}</div>
            <div class="qrow-sub text-ellipsis">{{ tr.uploader }}</div>
          </div>
          <component
            :is="tr._isCurrent ? Pause : Play"
            v-if="tr._isCurrent"
            :size="18"
            :stroke-width="2.5"
            color="var(--accent)"
            :fill="player.playing ? 'var(--accent)' : 'transparent'"
          />
        </button>
      </div>
    </div>
  </van-popup>
</template>

<style>
/* mini player — flush with the tab bar (Spotify mobile pattern). Square
 * corners, full width; the bg sits one elevation step above the tab bar
 * (--bg-elev → slightly lighter card mix) so the seam reads as two
 * stacked surfaces. position: relative anchors the .mp-progress bar to
 * the bottom edge. */
.mini-player {
  position: relative;
  height: var(--mini-height);
  background: var(--card);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}

.mp-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--border);
}
.mp-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s linear;
}

.mini-player .mp-thumb {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.mini-player .mp-thumb img { width: 100%; height: 100%; object-fit: cover; }

.mini-player .mp-meta {
  flex: 1 1 auto;
  min-width: 0;
}
.mini-player .mp-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  /* Marquee wrapping — let MarqueeText's inner-span scroll handle
   * overflow. The ellipsis utility was removed because we now
   * marquee-scroll instead of cutting with `…`. */
}
.mini-player .mp-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.mini-player .mp-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.mini-player .mp-btn {
  width: 40px;
  height: 40px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.mini-player .mp-btn.small { width: 34px; height: 34px; }
.mini-player .mp-btn:active { background: rgba(255, 255, 255, 0.08); }

/* Fullscreen now playing */
.np-popup { background: var(--bg) !important; }

.np-screen {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  isolation: isolate;
  /* The blurred .np-bg uses `inset: -60px` to bleed past the edges
   * before the blur kicks in — without clipping at the screen
   * boundary, those overflow pixels become draggable content and
   * iOS treats the popup as horizontally scrollable. Hide the
   * overflow to keep the player rigid. */
  overflow: hidden;
  /* Notch is owned here, not by the nested van-nav-bar — see template
   * comment. Keeps the chevron/title sitting comfortably below the
   * status bar on iPhone notched devices. */
  padding-top: var(--safe-top);
}

/* Cover-derived ambient background — full-bleed, blurred to a soft
 * color wash, dark-vignetted so foreground text stays readable. The
 * 1.2s transition gives a smooth crossfade when the next track loads
 * even though the underlying image swap is instant. */
.np-bg {
  position: absolute;
  inset: -60px;
  background-size: cover;
  background-position: center;
  filter: blur(60px) saturate(1.4);
  opacity: 0.55;
  z-index: -2;
  transition: background-image 1.2s ease, opacity 1.2s ease;
}
.np-bg-fade {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 70% at 50% 0%, transparent 0%, rgba(13, 15, 20, 0.5) 70%, var(--bg) 100%),
    linear-gradient(180deg, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.35) 60%, var(--bg) 100%);
  z-index: -1;
}

/* Speed bottom-sheet — absolute-positioned, anchored bottom so it
 * comes up like an iOS modal. Tapping the dim backdrop closes. */
.np-speed-sheet {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.45);
}
.np-speed-card {
  width: 100%;
  background: var(--card);
  border-radius: var(--r-3) var(--r-3) 0 0;
  padding: var(--sp-4) var(--sp-4) calc(var(--sp-6) + var(--safe-bottom));
  box-shadow: 0 -20px 50px rgba(0, 0, 0, 0.5);
}
.np-speed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-4);
}
.np-speed-eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  color: var(--text-muted);
}
.np-speed-value {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  margin-top: 2px;
}
.np-speed-slider {
  padding: var(--sp-2) 0 var(--sp-4);
}
.np-speed-chips {
  display: flex;
  gap: var(--sp-2);
  overflow-x: auto;
  scrollbar-width: none;
}
.np-speed-chips::-webkit-scrollbar { display: none; }
.np-speed-chip {
  flex: 0 0 auto;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--motion-short) var(--ease);
  min-width: 56px;
}
.np-speed-chip.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.np-speed-chip:active { transform: scale(0.95); }

/* The 1× badge in np-extras when speed != 1× — shows the numeric
 * value as a small pill (compact, accent border) instead of the
 * default Gauge icon, so the user can see at a glance "I'm on
 * 1.25×" without opening the sheet. */
.np-speed-btn { padding: 0; }
.np-speed-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  padding: 4px 8px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* Lyrics overlay — absolute-positioned full-bleed sheet that
 * slides up over the player content (cover, controls, etc.) when
 * the user taps the lyrics button. Backdrop-blur keeps the player's
 * ambient bg visible underneath for continuity. */
.np-lyrics {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: stretch;
}
.np-lyrics-sheet {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding-top: var(--safe-top);
  background: linear-gradient(180deg,
    rgba(13, 15, 20, 0.92) 0%,
    rgba(13, 15, 20, 0.96) 60%,
    rgba(13, 15, 20, 1) 100%);
  backdrop-filter: blur(40px) saturate(1.2);
  -webkit-backdrop-filter: blur(40px) saturate(1.2);
}
.np-lyrics-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border-bottom: 1px solid var(--border);
}
.np-lyrics-head-text {
  /* min-width: 0 is critical: a flex item's default min-width is
   * `auto` (= its content's intrinsic width), so without this the
   * artist — title string would push the close button off-screen
   * on long names like "Chase Atlantic — Consume feat. Goon Des
   * Garcons". With 0 the child can shrink and the inner clip
   * + MarqueeText scroll kicks in.
   *
   * `width: 0` companion to `flex: 1` — some WebKit versions don't
   * honor `flex-basis: 0` alone for shrinking decisions; setting
   * width: 0 forces the row to compute "head-text wants to be
   * tiny" so the flex algorithm hands it exactly the remaining
   * space (viewport - close button - padding - gap). */
  flex: 1;
  width: 0;
  min-width: 0;
  overflow: hidden;
}
.np-lyrics-eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  color: var(--text-muted);
  margin-bottom: 2px;
}
.np-lyrics-meta {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  /* Width pinned to 100% of the parent text column so MarqueeText's
   * internal `scrollWidth > clientWidth` check has a stable
   * reference (the parent's flex-constrained width, not the
   * intrinsic span width). */
  width: 100%;
}
.np-lyrics-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 0;
  display: grid;
  place-items: center;
  /* Hard pin so the title's overflow can NEVER push the close
   * button out of the viewport. */
  flex: 0 0 36px;
}
.np-lyrics-close:active { background: rgba(255, 255, 255, 0.18); }
.np-lyrics-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--sp-8) var(--sp-2) calc(var(--sp-8) + var(--safe-bottom));
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.np-lyrics-body::-webkit-scrollbar { display: none; }
.np-lyrics-state {
  text-align: center;
  color: var(--text);
  font-size: 15px;
  padding: var(--sp-6);
}
.np-lyrics-state.muted { color: var(--text-muted); font-style: italic; }
.np-lyrics-state.error { color: var(--danger); }
.np-lyrics-plain {
  white-space: pre-wrap;
  font: 14px/1.6 var(--font-body);
  color: var(--text);
  text-align: center;
  margin: 0;
  padding: 0 var(--sp-4);
}
/* Slide-up enter/leave (the active-line styling lives in mobile.css
 * since the lyrics modal used the same classes — re-used here). */
.lyrics-slide-enter-active,
.lyrics-slide-leave-active {
  transition: transform var(--motion-mid) var(--ease), opacity var(--motion-mid) var(--ease);
}
.lyrics-slide-enter-from {
  transform: translateY(16px);
  opacity: 0;
}
.lyrics-slide-leave-to {
  transform: translateY(8px);
  opacity: 0;
}

.np-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 32px calc(40px + var(--safe-bottom));
  gap: 24px;
}

/* Cover stage holds the current cover + an off-screen prev (at
 * -100%) + an off-screen next (at +100%). The whole stage gets
 * translated by coverDx on swipe, so the side covers slide into
 * view as the user drags. */
.np-cover-stage {
  position: relative;
  width: min(80vw, 360px);
  aspect-ratio: 1 / 1;
  /* Don't clip — the side covers need to peek out as the user
   * drags. The .np-body that wraps us has overflow:hidden from
   * .np-screen so they never escape the viewport. */
  overflow: visible;
}
.np-cover {
  width: min(80vw, 360px);
  aspect-ratio: 1 / 1;
  border-radius: 16px;
  overflow: hidden;
  background: var(--card);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}
.np-cover img { width: 100%; height: 100%; object-fit: cover; }

/* Side covers — positioned absolutely just off the edge of the
 * stage. A 16 px gap matches Apple Music's coverflow rhythm so
 * the swipe doesn't look like a continuous strip. */
.np-cover-side {
  position: absolute;
  top: 0;
  width: 100%;
  height: 100%;
}
.np-cover-prev { left: calc(-100% - 16px); }
.np-cover-next { left: calc(100% + 16px); }

.np-meta {
  text-align: center;
  width: 100%;
}
.np-meta .np-title {
  font-size: 19px;
  font-weight: 700;
  color: var(--text);
  /* Overflow handled by MarqueeText (slow horizontal scroll on long
   * titles). The old text-overflow:ellipsis used to cut "Tsew The
   * Kid - Quand on danse (lyric…)" at the ellipsis; now the whole
   * title scrolls into view over a few seconds. */
}
.np-meta .np-sub {
  font-size: 14px;
  color: var(--text-muted);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.np-seek { width: 100%; }
.np-seek .np-time {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.np-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 320px;
}
.np-ctrl {
  width: 48px;
  height: 48px;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  border-radius: 50%;
}
.np-ctrl:active { background: rgba(255, 255, 255, 0.08); }
.np-ctrl.ghost { width: 40px; height: 40px; position: relative; }
/* Active dot under shuffle / repeat — Apple Music pattern so the toggled
 * state is glanceable even past the icon color shift. */
.np-ctrl.ghost.active::after {
  content: '';
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
}
.np-controls .np-play {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent);
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.np-extras {
  display: flex;
  justify-content: space-around;
  width: 100%;
  max-width: 320px;
}
.np-extra {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.np-extra:active { background: rgba(255, 255, 255, 0.08); }

/* Queue sheet */
.queue-popup { background: var(--bg-elev) !important; }
.queue-screen {
  display: flex;
  flex-direction: column;
  max-height: 85vh;
  padding: 0 12px;
}
.queue-handle {
  width: 36px;
  height: 4px;
  background: var(--border);
  border-radius: 999px;
  margin: 10px auto 6px;
}
.queue-head {
  padding: 8px 8px 12px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.queue-head h2 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.queue-head .muted { font-size: 12px; color: var(--text-muted); }

.queue-list {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 8px;
}
.qrow {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: transparent;
  border: 0;
  border-radius: 10px;
  padding: 8px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}
.qrow + .qrow { margin-top: 2px; }
.qrow:active { background: var(--card-hover); }
.qrow.current { background: var(--accent-soft); }
.qrow-thumb {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.qrow-thumb img { width: 100%; height: 100%; object-fit: cover; }
.qrow-meta { flex: 1 1 auto; min-width: 0; }
.qrow-title { font-size: 14px; font-weight: 500; color: var(--text); }
.qrow.current .qrow-title { color: var(--accent-bright); }
.qrow-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.muted { color: var(--text-muted); }
.empty-state.small { padding: 30px 16px; text-align: center; }
.empty-state.small .hint { font-size: 13px; color: var(--text-muted); }
</style>
