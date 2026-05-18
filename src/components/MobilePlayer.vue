<script setup>
import { ref, computed, onMounted } from 'vue';
import {
  Play, Pause, SkipBack, SkipForward, Heart, ChevronDown,
  ListMusic, MessageSquareText, Shuffle, Repeat,
} from 'lucide-vue-next';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { showLyrics } from '@/composables/useLyrics';

const player = usePlayerStore();
const lib = useLibraryStore();
const streams = useStreamsStore();

const audioRef = ref(null);
const audio2Ref = ref(null);
const fullscreen = ref(false);
const queueOpen = ref(false);

const cover = computed(() => apiUrl(player.currentTrack?.thumbnail || ''));

// Resolve every queue id to a track (library or stream). The currently
// playing one gets the accent treatment.
const queueTracks = computed(() => {
  return (player.queue || []).map((id, idx) => {
    const tr = lib.findById(id) || streams.get(id);
    return tr ? { ...tr, _qIdx: idx, _isCurrent: idx === player.index } : null;
  }).filter(Boolean);
});

function jumpToQueue(idx) {
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

onMounted(() => {
  player.bindAudio(audioRef.value, audio2Ref.value);
});
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
  </div>

  <!-- Fullscreen "Now Playing" — Vant popup -->
  <van-popup
    v-model:show="fullscreen"
    position="bottom"
    :style="{ height: '100%' }"
    round
    teleport="body"
    class="np-popup"
  >
    <div class="np-screen">
      <van-nav-bar
        :title="'En cours de lecture'"
        :border="false"
        safe-area-inset-top
        @click-left="fullscreen = false"
      >
        <template #left>
          <ChevronDown :size="26" :stroke-width="2" color="var(--text)" />
        </template>
      </van-nav-bar>
      <div class="np-body">
        <div class="np-cover">
          <img v-if="cover" :src="cover" alt="" />
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
          <button class="np-ctrl ghost" aria-label="Aléatoire">
            <Shuffle :size="22" :stroke-width="2" color="var(--text-muted)" />
          </button>
          <button class="np-ctrl" aria-label="Précédent" @click="player.prev()">
            <SkipBack :size="30" :stroke-width="2" color="var(--text)" fill="var(--text)" />
          </button>
          <button class="np-play" @click="player.togglePlay()">
            <component :is="player.playing ? Pause : Play" :size="28" :stroke-width="2.5" color="var(--bg)" fill="var(--bg)" />
          </button>
          <button class="np-ctrl" aria-label="Suivant" @click="player.next()">
            <SkipForward :size="30" :stroke-width="2" color="var(--text)" fill="var(--text)" />
          </button>
          <button class="np-ctrl ghost" aria-label="Répétition">
            <Repeat :size="22" :stroke-width="2" color="var(--text-muted)" />
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
 * stacked surfaces. */
.mini-player {
  height: var(--mini-height);
  background: var(--card);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
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
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  /* No padding-top here — the nested <van-nav-bar safe-area-inset-top>
   * already eats the notch height. Adding it would double up. */
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

.np-cover {
  width: min(80vw, 360px);
  aspect-ratio: 1 / 1;
  border-radius: 16px;
  overflow: hidden;
  background: var(--card);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}
.np-cover img { width: 100%; height: 100%; object-fit: cover; }

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
.np-ctrl.ghost { width: 40px; height: 40px; }
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
