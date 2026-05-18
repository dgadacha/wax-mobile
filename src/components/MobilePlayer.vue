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

const cover = computed(() => apiUrl(player.currentTrack?.thumbnail || ''));
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
          <button class="np-extra" aria-label="File d'attente">
            <ListMusic :size="22" :stroke-width="2" color="var(--text-muted)" />
          </button>
        </div>
      </div>
    </div>
  </van-popup>
</template>

<style>
/* mini player */
.mini-player {
  height: var(--mini-height);
  border-radius: 12px;
  background: var(--card);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
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
  box-shadow: 0 12px 24px rgba(124, 92, 255, 0.4);
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
</style>
