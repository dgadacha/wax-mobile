<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import {
  Play, Pause, SkipBack, SkipForward, Heart, ChevronDown,
  ListMusic, MessageSquareText, Shuffle, Repeat, Repeat1,
} from 'lucide-vue-next';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePrefsStore } from '@/stores/prefs';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import { showLyrics } from '@/composables/useLyrics';
import { useVisualizer, setEq } from '@/composables/useVisualizer';
import { useGestures } from '@/composables/useGestures';

const player = usePlayerStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const prefs = usePrefsStore();

const audioRef = ref(null);
const audio2Ref = ref(null);
const fullscreen = ref(false);
const queueOpen = ref(false);

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
  onSwipeLeft: () => { haptics.light(); commitCover('next'); },
  onSwipeRight: () => { haptics.light(); commitCover('prev'); },
  onEnd: ({ committed }) => {
    // Only snap back when the gesture was NOT a commit — commitCover
    // owns the animation in the committed case so we don't fight it.
    if (!committed) settleCover();
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
  onEnd: () => settleBody(),
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

function toggleLike() {
  haptics.medium();
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

function onSeek(pct) {
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
      <div class="mp-title text-ellipsis">{{ title || 'Aucune lecture' }}</div>
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
          <div class="np-cover np-cover-side np-cover-prev">
            <img v-if="prevCover" :src="prevCover" alt="" />
          </div>
          <div class="np-cover">
            <img v-if="cover" :src="cover" alt="" />
          </div>
          <div class="np-cover np-cover-side np-cover-next">
            <img v-if="nextCover" :src="nextCover" alt="" />
          </div>
        </div>
        <div class="np-meta">
          <div class="np-title">{{ title }}</div>
          <div class="np-sub">{{ sub }}</div>
        </div>
        <div class="np-seek">
          <van-slider
            :model-value="seekPct"
            :step="0.1"
            :min="0"
            :max="100"
            active-color="var(--accent)"
            inactive-color="var(--card)"
            bar-height="3px"
            button-size="14px"
            @update:model-value="onSeek"
          />
          <div class="np-time">
            <span>{{ fmtDuration(player.currentTime) }}</span>
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
          <button class="np-extra" aria-label="J'aime" @click="toggleLike">
            <Heart :size="24" :stroke-width="2"
              :color="player.isLikedCurrent ? 'var(--accent)' : 'var(--text-muted)'"
              :fill="player.isLikedCurrent ? 'var(--accent)' : 'transparent'" />
          </button>
          <button class="np-extra" aria-label="Paroles" @click="showLyrics(player.currentTrack)">
            <MessageSquareText :size="22" :stroke-width="2" color="var(--text-muted)" />
          </button>
          <button class="np-extra" aria-label="File d'attente" @click="queueOpen = true">
            <ListMusic :size="22" :stroke-width="2" color="var(--text-muted)" />
          </button>
        </div>
      </div>
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
