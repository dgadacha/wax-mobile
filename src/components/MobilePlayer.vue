<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import {
  Play, Pause, SkipBack, SkipForward, Heart, ChevronDown, MoreVertical,
  ListMusic, MicVocal, Shuffle, Repeat, Repeat1, X, Gauge, ListPlus,
  ListEnd, Sparkles, Mic2, Plus,
} from 'lucide-vue-next';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePrefsStore } from '@/stores/prefs';
import { usePlaylistsStore } from '@/stores/playlists';
import { useViewStore } from '@/stores/view';
import { useMixStore } from '@/stores/mix';
import { useActionSheetStore } from '@/stores/actionSheet';
import { fmtDuration, parseTrackTitle } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';
import { fetchLyrics } from '@/composables/useLyrics';
import { showToast } from '@/lib/toast';
import { t } from '@/lib/i18n';
import MarqueeText from '@/components/MarqueeText.vue';
import { useVisualizer, setEq } from '@/composables/useVisualizer';
import { useGestures } from '@/composables/useGestures';
import { extractDominantColor } from '@/lib/extractColor';

const player = usePlayerStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const prefs = usePrefsStore();
const playlists = usePlaylistsStore();
const view = useViewStore();
const mix = useMixStore();
const sheet = useActionSheetStore();

const audioRef = ref(null);
const audio2Ref = ref(null);
const fullscreen = ref(false);
const queueOpen = ref(false);
// Playback speed bottom-sheet.
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

// Lyrics overlay state — slides up over the player content. Spotify
// styles this as a solid sheet in the track's dominant color.
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
  const ct = player.currentTime;
  let lo = 0, hi = lines.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= ct) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
});
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

// Close the overlay automatically when the user skips to a new track.
watch(() => player.currentTrack?.id, (id, prev) => {
  if (lyricsOpen.value && id !== prev) lyricsOpen.value = false;
});

// Gesture surfaces inside the fullscreen player — see useGestures.
//   COVER — horizontal swipes for prev/next with live preview.
//   BODY  — ↓ dismisses the popup, ↑ opens the queue.
const npCoverRef = ref(null);
const npBodyRef = ref(null);
const coverDx = ref(0);
const coverAnimating = ref(false);
const bodyDy = ref(0);
const bodyAnimating = ref(false);

const coverStyle = computed(() => ({
  transform: `translate3d(${coverDx.value}px, 0, 0)`,
  transition: coverAnimating.value
    ? 'transform 220ms cubic-bezier(0.4, 0, 0.2, 1)'
    : 'none',
}));
const sideCoverStyle = computed(() => ({
  opacity: Math.min(1, Math.abs(coverDx.value) / 120),
  transition: coverAnimating.value
    ? 'opacity 220ms cubic-bezier(0.4, 0, 0.2, 1)'
    : 'none',
}));
const bodyStyle = computed(() => ({
  transform: bodyDy.value > 0
    ? `translate3d(0, ${bodyDy.value}px, 0)`
    : 'translate3d(0, 0, 0)',
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

// Cover commit: animate the stage to the side cover's resting position,
// then swap player.next/prev AND reset coverDx in the same Vue tick.
function commitCover(dir) {
  const el = npCoverRef.value;
  const width = (el ? el.offsetWidth : 360) + 16;
  coverAnimating.value = true;
  coverDx.value = dir === 'next' ? -width : width;
  setTimeout(() => {
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
    if (committed) return;
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
    bodyDy.value = dy < 200 ? dy : 200 + (dy - 200) * 0.4;
  },
  onSwipeDown: () => { haptics.light(); fullscreen.value = false; },
  onSwipeUp: () => { haptics.light(); queueOpen.value = true; },
  onEnd: ({ committed }) => {
    if (committed) {
      settleBody();
      return;
    }
    if (bodyDy.value >= window.innerHeight * 0.25) {
      haptics.light();
      fullscreen.value = false;
    }
    settleBody();
  },
});

const cover = computed(() => apiUrl(player.currentTrack?.thumbnail || ''));

// Side covers for the coverflow swipe preview.
function _coverFor(qIdx) {
  if (qIdx < 0 || qIdx >= player.queue.length) return '';
  const id = player.queue[qIdx];
  const tr = lib.findById(id) || streams.get(id);
  return tr ? apiUrl(tr.thumbnail || '') : '';
}
const prevCover = computed(() => _coverFor(player.index - 1));
const nextCover = computed(() => _coverFor(player.index + 1));

// Per-track tint — dominant color of the current cover. Drives the
// fullscreen gradient, the mini-player card and the lyrics sheet.
// Deliberately does NOT touch --accent anymore: the app identity
// (green controls) stays put, only the player's canvas follows the
// artwork — exactly how Spotify does it.
const npColor = ref('#404040');
let _lastTintTrackId = null;
watch(
  () => player.currentTrack?.id,
  async (trackId) => {
    if (!trackId) { _lastTintTrackId = null; npColor.value = '#404040'; return; }
    if (trackId === _lastTintTrackId) return;
    _lastTintTrackId = trackId;
    const url = apiUrl(player.currentTrack?.thumbnail || '');
    if (!url) { npColor.value = '#404040'; return; }
    const hex = await extractDominantColor(url);
    if (_lastTintTrackId !== trackId) return;
    npColor.value = hex || '#404040';
  },
  { immediate: true },
);

const npBgStyle = computed(() => ({
  background: `linear-gradient(180deg,
    color-mix(in srgb, ${npColor.value} 72%, #2a2a2a) 0%,
    color-mix(in srgb, ${npColor.value} 38%, var(--bg)) 46%,
    var(--bg) 88%)`,
}));
const miniStyle = computed(() => ({
  background: `color-mix(in srgb, ${npColor.value} 38%, #1c1c1c)`,
}));
const lyricsSheetStyle = computed(() => ({
  background: `color-mix(in srgb, ${npColor.value} 78%, #3a3a3a)`,
}));

// Resolve every queue id to a track (library or stream).
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
  const track = player.currentTrack;
  if (!track) return;
  lib.toggleFav(track);
}

function onSeek(pct) {
  player.seekToPct(pct);
}

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

// "⋮" in the fullscreen header — Spotify's track context sheet, with
// the cover + gradient header.
async function openTrackSheet() {
  const tr = player.currentTrack;
  if (!tr) return;
  haptics.light();
  try {
    const { index } = await sheet.open(
      [
        { name: player.isLikedCurrent ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: Heart },
        { name: 'Ajouter à une playlist', icon: ListPlus },
        { name: 'Lancer un mix basé sur ce titre', icon: Sparkles },
        { name: 'Voir la file d’attente', icon: ListEnd },
        { name: 'Ouvrir l’artiste', icon: Mic2 },
      ],
      { cover: tr.thumbnail, title: tr.title, subtitle: tr.uploader },
    );
    if (index === 0) toggleLike();
    else if (index === 1) addCurrentToPlaylist(tr);
    else if (index === 2) {
      fullscreen.value = false;
      mix.streamFrom(tr, () => view.switchTo('mix'));
    } else if (index === 3) queueOpen.value = true;
    else if (index === 4) {
      const a = parseTrackTitle(tr).artist || tr.uploader;
      if (a) {
        fullscreen.value = false;
        view.switchTo('artist', a);
      }
    }
  } catch { /* dismissed */ }
}

// Stream tracks aren't in the library yet — add silently first so the
// playlist gets a real library id.
async function ensureLibraryId(tr) {
  if (!tr.isStream) return tr.id;
  const existing = lib.tracks.find((x) => x.ytId === tr.ytId);
  if (existing) return existing.id;
  const added = await lib.add({
    id: tr.ytId, ytId: tr.ytId, title: tr.title, uploader: tr.uploader,
    duration: tr.duration, thumbnail: tr.thumbnail,
    url: `https://www.youtube.com/watch?v=${tr.ytId}`,
  }, { liked: false, silent: true });
  return added?.id || lib.tracks.find((x) => x.ytId === tr.ytId)?.id;
}

async function addCurrentToPlaylist(tr) {
  const actions = [
    { name: 'Nouvelle playlist', icon: Plus, color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id, icon: ListMusic })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try {
    pick = await sheet.open(actions, { title: 'Ajouter à une playlist', subtitle: tr.title });
  } catch { return; }
  const trackId = await ensureLibraryId(tr);
  if (!trackId) return;
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, trackId);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, trackId);
    showToast(`Ajouté à « ${pl.name} »`);
  }
}

onMounted(() => {
  player.bindAudio(audioRef.value, audio2Ref.value);
});

// Audio chain + visualizer + EQ.
useVisualizer();
watch(
  () => prefs.eq,
  (eq) => setEq(eq.bass || 0, eq.mid || 0, eq.treble || 0),
  { deep: true, immediate: true },
);
</script>

<template>
  <!-- Audio elements always mounted so player.bindAudio() has stable refs. -->
  <audio ref="audioRef" preload="metadata" crossorigin="anonymous"></audio>
  <audio ref="audio2Ref" preload="metadata" crossorigin="anonymous"></audio>

  <!-- Mini player: floating rounded card tinted with the track color -->
  <div
    v-if="player.visible"
    class="mini-player"
    :style="miniStyle"
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
      <button class="mp-btn small" aria-label="J'aime" @click="toggleLike">
        <Heart
          :size="20"
          :stroke-width="2"
          :color="player.isLikedCurrent ? 'var(--accent)' : 'rgba(255,255,255,0.8)'"
          :fill="player.isLikedCurrent ? 'var(--accent)' : 'transparent'"
        />
      </button>
      <button class="mp-btn" :aria-label="player.playing ? 'Pause' : 'Lire'" @click="player.togglePlay()">
        <component :is="player.playing ? Pause : Play" :size="24" :stroke-width="0" color="#fff" fill="#fff" />
      </button>
    </div>
    <!-- Thin progress line pinned at the bottom of the card. -->
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
    <div class="np-screen" :style="npBgStyle">
      <!-- Top bar: collapse chevron / context label / track menu. -->
      <div class="np-top">
        <button class="np-top-btn" aria-label="Fermer" @click="fullscreen = false">
          <ChevronDown :size="26" :stroke-width="2.2" color="#fff" />
        </button>
        <div class="np-top-title">En cours de lecture</div>
        <button class="np-top-btn" aria-label="Options du titre" @click="openTrackSheet">
          <MoreVertical :size="22" :stroke-width="2" color="#fff" />
        </button>
      </div>

      <div ref="npBodyRef" class="np-body" :style="bodyStyle">
        <!-- Cover stage — prev / current / next slide together on drag. -->
        <div ref="npCoverRef" class="np-cover-stage" :style="coverStyle">
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

        <!-- Meta row: left-aligned title/artist + heart — Spotify layout. -->
        <div class="np-meta">
          <div class="np-meta-text">
            <MarqueeText class="np-title" :text="title" />
            <div class="np-sub text-ellipsis">{{ sub }}</div>
          </div>
          <button
            class="np-like"
            :class="{ 'is-bouncing': likeBouncing }"
            aria-label="J'aime"
            @click="toggleLike"
          >
            <Heart :size="24" :stroke-width="2"
              :color="player.isLikedCurrent ? 'var(--accent)' : 'rgba(255,255,255,0.75)'"
              :fill="player.isLikedCurrent ? 'var(--accent)' : 'transparent'" />
          </button>
        </div>

        <div class="np-seek">
          <van-slider
            :model-value="seekPct"
            :step="0.1"
            :min="0"
            :max="100"
            active-color="#ffffff"
            inactive-color="rgba(255, 255, 255, 0.25)"
            bar-height="3px"
            button-size="12px"
            @update:model-value="onSeek"
          />
          <div class="np-time">
            <span>{{ fmtDuration(player.currentTime) }}</span>
            <span>{{ fmtDuration(player.duration) }}</span>
          </div>
        </div>

        <!-- Transport: shuffle / prev / WHITE play circle / next / repeat. -->
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
              :color="player.shuffle ? 'var(--accent)' : 'rgba(255,255,255,0.8)'"
            />
          </button>
          <button class="np-ctrl" aria-label="Précédent" @click="onPrev">
            <SkipBack :size="30" :stroke-width="0" color="#fff" fill="#fff" />
          </button>
          <button class="np-play" @click="onTogglePlay">
            <component :is="player.playing ? Pause : Play" :size="30" :stroke-width="0" color="#0b0b0b" fill="#0b0b0b" />
          </button>
          <button class="np-ctrl" aria-label="Suivant" @click="onNext">
            <SkipForward :size="30" :stroke-width="0" color="#fff" fill="#fff" />
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
              :color="player.repeat !== 'off' ? 'var(--accent)' : 'rgba(255,255,255,0.8)'"
            />
          </button>
        </div>

        <!-- Bottom utility row: speed left, lyrics + queue right. -->
        <div class="np-extras">
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
              color="rgba(255,255,255,0.8)"
            />
          </button>
          <div class="np-extras-right">
            <button
              class="np-extra"
              :class="{ 'is-active': lyricsOpen }"
              aria-label="Paroles"
              @click="toggleLyrics"
            >
              <MicVocal
                :size="22"
                :stroke-width="2"
                :color="lyricsOpen ? 'var(--accent)' : 'rgba(255,255,255,0.8)'"
              />
            </button>
            <button class="np-extra" aria-label="File d'attente" @click="queueOpen = true">
              <ListMusic :size="22" :stroke-width="2" color="rgba(255,255,255,0.8)" />
            </button>
          </div>
        </div>
      </div>

      <!-- Speed bottom-sheet -->
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

      <!-- Lyrics overlay — solid sheet in the track's dominant color,
           bold karaoke lines (Spotify's lyrics screen). -->
      <Transition name="lyrics-slide">
        <div v-if="lyricsOpen" class="np-lyrics" @click.self="lyricsOpen = false">
          <div class="np-lyrics-sheet" :style="lyricsSheetStyle">
            <header class="np-lyrics-head">
              <div class="np-lyrics-head-text">
                <div class="np-lyrics-eyebrow">Paroles</div>
                <MarqueeText
                  class="np-lyrics-meta"
                  :text="`${lyricsArtist} — ${lyricsTitle}`"
                />
              </div>
              <button class="np-lyrics-close" aria-label="Fermer" @click="lyricsOpen = false">
                <X :size="22" :stroke-width="2" color="#fff" />
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
                  class="np-lyric-line"
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

  <!-- Queue sheet -->
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
/* Mini player — floating rounded card (positioned by mobile.css),
 * tinted with the current track's dominant color via inline style. */
.mini-player {
  position: relative;
  height: var(--mini-height);
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.mp-progress {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 999px;
}
.mp-progress-fill {
  height: 100%;
  background: #fff;
  border-radius: 999px;
  transition: width 0.25s linear;
}

.mini-player .mp-thumb {
  width: 42px;
  height: 42px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  flex: 0 0 auto;
}
.mini-player .mp-thumb img { width: 100%; height: 100%; object-fit: cover; }

.mini-player .mp-meta {
  flex: 1 1 auto;
  min-width: 0;
}
.mini-player .mp-title {
  font: 600 13px/1.3 var(--font-body);
  color: #fff;
}
.mini-player .mp-sub {
  font: 400 12px/1.3 var(--font-body);
  color: rgba(255, 255, 255, 0.7);
  margin-top: 1px;
}

.mini-player .mp-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
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
.mini-player .mp-btn.small { width: 36px; height: 36px; }
.mini-player .mp-btn:active { background: rgba(255, 255, 255, 0.12); }

/* Fullscreen now playing */
.np-popup { background: var(--bg) !important; }

.np-screen {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  isolation: isolate;
  overflow: hidden;
  padding-top: var(--safe-top);
  transition: background 600ms ease;
}

/* Top bar */
.np-top {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 0;
}
.np-top-btn {
  width: 44px;
  height: 44px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.np-top-btn:active { background: rgba(255, 255, 255, 0.1); }
.np-top-title {
  flex: 1 1 auto;
  text-align: center;
  font: 700 13px/1.2 var(--font-body);
  color: #fff;
  letter-spacing: 0.2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Speed bottom-sheet */
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
  font-weight: 800;
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
  color: var(--on-accent);
  border-color: var(--accent);
}
.np-speed-chip:active { transform: scale(0.95); }

.np-speed-btn { padding: 0; }
.np-speed-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  padding: 4px 8px;
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* Lyrics overlay — solid color sheet, bold karaoke lines. */
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
}
.np-lyrics-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
}
.np-lyrics-head-text {
  flex: 1;
  width: 0;
  min-width: 0;
  overflow: hidden;
}
.np-lyrics-eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.4px;
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 2px;
}
.np-lyrics-meta {
  font: 700 14px/1.3 var(--font-body);
  color: #fff;
  width: 100%;
}
.np-lyrics-close {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.18);
  border: 0;
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  cursor: pointer;
}
.np-lyrics-close:active { background: rgba(0, 0, 0, 0.35); }
.np-lyrics-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: var(--sp-6) var(--sp-5) calc(var(--sp-8) + var(--safe-bottom));
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.np-lyrics-body::-webkit-scrollbar { display: none; }
.np-lyrics-state {
  text-align: center;
  color: #fff;
  font-size: 15px;
  padding: var(--sp-6);
}
.np-lyrics-state.muted { color: rgba(255, 255, 255, 0.7); font-style: italic; }
.np-lyrics-state.error { color: #ffd2d2; }
.np-lyrics-plain {
  white-space: pre-wrap;
  font: 700 20px/1.5 var(--font-display);
  color: #fff;
  text-align: left;
  margin: 0;
  padding: 0 var(--sp-2);
}
/* Karaoke lines — bold, left-aligned, black-dimmed until sung. */
.np-lyric-line {
  font: 800 24px/1.35 var(--font-display);
  letter-spacing: -0.3px;
  text-align: left;
  padding: var(--sp-1) 0;
  color: rgba(0, 0, 0, 0.45);
  transition: color var(--motion-mid) var(--ease);
}
.np-lyric-line.past { color: rgba(255, 255, 255, 0.85); }
.np-lyric-line.active { color: #ffffff; }

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
  padding: 16px 24px calc(28px + var(--safe-bottom));
  gap: 22px;
}

/* Cover stage */
.np-cover-stage {
  position: relative;
  width: min(85vw, 380px);
  aspect-ratio: 1 / 1;
  overflow: visible;
}
.np-cover {
  width: min(85vw, 380px);
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}
.np-cover img { width: 100%; height: 100%; object-fit: cover; }

.np-cover-side {
  position: absolute;
  top: 0;
  width: 100%;
  height: 100%;
}
.np-cover-prev { left: calc(-100% - 16px); }
.np-cover-next { left: calc(100% + 16px); }

/* Meta row — left text, right heart. */
.np-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.np-meta-text {
  flex: 1 1 auto;
  min-width: 0;
}
.np-meta .np-title {
  font: 700 20px/1.25 var(--font-display);
  letter-spacing: -0.3px;
  color: #fff;
  text-align: left;
}
.np-meta .np-sub {
  font: 400 15px/1.3 var(--font-body);
  color: rgba(255, 255, 255, 0.7);
  margin-top: 3px;
  text-align: left;
}
.np-like {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.np-like:active { background: rgba(255, 255, 255, 0.08); }
@keyframes np-heart-pop {
  0%   { transform: scale(1); }
  35%  { transform: scale(1.35); }
  60%  { transform: scale(0.92); }
  85%  { transform: scale(1.08); }
  100% { transform: scale(1); }
}
.np-like.is-bouncing svg {
  animation: np-heart-pop 420ms cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: center;
}

.np-seek { width: 100%; }
.np-seek .np-time {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.65);
  font-variant-numeric: tabular-nums;
}

.np-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 340px;
}
.np-ctrl {
  width: 52px;
  height: 52px;
  background: transparent;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
  border-radius: 50%;
}
.np-ctrl:active { background: rgba(255, 255, 255, 0.08); }
.np-ctrl.ghost { width: 44px; height: 44px; position: relative; }
.np-ctrl.ghost.active::after {
  content: '';
  position: absolute;
  bottom: 5px;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
}
/* Spotify's signature WHITE play circle with black glyph. */
.np-controls .np-play {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: #ffffff;
  border: 0;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.np-controls .np-play:active { transform: scale(0.94); }

.np-extras {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.np-extras-right {
  display: flex;
  align-items: center;
  gap: 4px;
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
  background: rgba(255, 255, 255, 0.25);
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
  font: 700 18px/1.2 var(--font-display);
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
.qrow.current { background: rgba(255, 255, 255, 0.07); }
.qrow-thumb {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.qrow-thumb img { width: 100%; height: 100%; object-fit: cover; }
.qrow-meta { flex: 1 1 auto; min-width: 0; }
.qrow-title { font: 500 14px/1.3 var(--font-body); color: var(--text); }
.qrow.current .qrow-title { color: var(--accent); }
.qrow-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.muted { color: var(--text-muted); }
.empty-state.small { padding: 30px 16px; text-align: center; }
.empty-state.small .hint { font-size: 13px; color: var(--text-muted); }

/* ── Large screen — centred phone-width column ────────────────────
 * The fullscreen player and the queue are Vant popups teleported to
 * <body>, so they live OUTSIDE the framed .app-shell column. Re-frame
 * them to the same phone width on a centred black canvas so they match
 * the rest of the app instead of spanning the whole monitor. */
@media (min-width: 600px) {
  .np-popup,
  .queue-popup { background: #000 !important; }
  .np-screen {
    max-width: var(--app-col);
    margin-inline: auto;
    border-inline: 1px solid rgba(255, 255, 255, 0.06);
  }
  .queue-screen {
    max-width: var(--app-col);
    margin-inline: auto;
    width: 100%;
  }
}
</style>
