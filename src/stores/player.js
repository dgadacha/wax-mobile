// Audio player store. Owns the queue, the <audio> elements, and exposes
// playback methods. Event listeners are wired in the Player.vue mount
// callback (see init()).
import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api, apiUrl } from '@/lib/api';
import { isStreamId, fmtDuration } from '@/lib/format';
import { useLibraryStore } from './library';
import { useStreamsStore } from './streams';
import { usePrefsStore } from './prefs';
import { showToast } from '@/lib/toast';
import { t } from '@/lib/i18n';

const PLAYER_STATE_KEY = 'wax:player';

function findTrack(id) {
  const lib = useLibraryStore();
  const streams = useStreamsStore();
  return lib.findById(id) || streams.get(id) || null;
}

function trackPlayUrl(track) {
  if (!track) return null;
  if (track.file) return apiUrl(track.file);
  if (track.ytId) return apiUrl(`/api/stream/${track.ytId}`);
  return null;
}

// iOS Safari does NOT route <audio> fetches through the Service Worker
// (WebKit bug 237305 + family). So even if warmOfflineCache populated
// the wax-audio Cache Storage entry, the audio element bypasses it
// and goes straight to network — fail offline.
//
// Workaround: pre-fetch the MP3 via the Caches API (which DOES work
// from the page, including on iOS), turn the cached Response into a
// Blob, mint a blob: URL, and feed THAT to audio.src. The audio
// element plays from memory, never touches the network. Seeking,
// metadata, crossfade — all work as normal because blob URLs are
// fully addressable.
//
// Returns the original direct URL when we have no cache (online play,
// stream tracks, etc.). Caller is responsible for revoking any
// previous blob URL via revokeBlobIfAny() to avoid memory leaks.
async function resolvePlayUrl(track) {
  if (!track) return null;
  if (!track.file) {
    // Stream track — no cache to consult, return the direct URL.
    return track.ytId ? apiUrl(`/api/stream/${track.ytId}`) : null;
  }
  if (typeof caches === 'undefined') return apiUrl(track.file);
  try {
    const cache = await caches.open('wax-audio');
    const hit = await cache.match(track.file, { ignoreSearch: true });
    if (hit) {
      const blob = await hit.blob();
      return URL.createObjectURL(blob);
    }
  } catch (e) {
    // Cache API can throw on quota / privacy mode — fall back to URL.
    console.warn('[player] resolvePlayUrl cache lookup failed', e);
  }
  return apiUrl(track.file);
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    queue: [],
    index: -1,
    playing: false,
    loading: false,  // true between loadAndPlay() and the first 'playing' event
    shuffle: false,
    repeat: 'off', // 'off' | 'all' | 'one'
    muted: false,
    nowPlayingOpen: true, // controls right-column visibility (cover + queue)
    bigPictureOpen: false, // fullscreen "Now Playing" mode triggered by clicking the player cover
    crossfading: false,
    audioEl: null,   // primary <audio>
    audioEl2: null,  // crossfade <audio>
    visible: false,
    currentTime: 0,
    duration: 0,
    playCountedFor: null,
    saveStateTimer: null,
    stallTimer: null, // armed by 'waiting'/'stalled', cleared on progress or pause
    _lastBlobUrl: null, // last URL.createObjectURL — revoked on next loadAndPlay / stop
  }),
  getters: {
    currentTrackId: (state) => state.queue[state.index] || null,
    currentTrack(state) {
      const id = state.queue[state.index];
      if (!id) return null;
      return findTrack(id);
    },
    isLikedCurrent(state) {
      const id = state.queue[state.index];
      if (!id) return false;
      const lib = useLibraryStore();
      if (isStreamId(id)) {
        const stream = useStreamsStore().get(id);
        return !!stream && lib.tracks.some((t) => t.ytId === stream.ytId);
      }
      return lib.tracks.some((t) => t.id === id);
    },
  },
  actions: {
    bindAudio(el, el2) {
      // Don't let Pinia wrap raw HTMLAudioElements in reactive proxies —
      // it adds overhead and breaks some media APIs.
      this.audioEl = markRaw(el);
      this.audioEl2 = markRaw(el2);
      const prefs = usePrefsStore();
      el.volume = this.muted ? 0 : prefs.volume;
      // Wire event listeners
      el.addEventListener('play', () => this._onAudioPlay());
      el.addEventListener('pause', () => this._onAudioPause());
      el.addEventListener('playing', () => {
        this.loading = false;
        this._clearStallWatchdog();
        // iOS Safari (17/18) only honors the registered MediaSession
        // handler set if you set them AFTER the audio is actively
        // playing. Setting them at app boot / before the first
        // `playing` event makes iOS fall back to its default lock-
        // screen controls (the ±10 s seek arrows). Re-asserting them
        // here on every `playing` event is the documented WebKit
        // workaround — costs nothing and finally lets ⏮/⏭ show up.
        this._registerMediaSessionHandlers();
      });
      // 'waiting' fires when the buffer underruns. The corresponding
      // 'playing' event fires once buffering recovers — but on a stale
      // YouTube CDN URL (signed, expires mid-track) the audio just sits
      // there forever with no error. Watchdog kicks in after 10 s of
      // silence and skips the track.
      el.addEventListener('waiting', () => {
        this.loading = true;
        this._armStallWatchdog();
      });
      el.addEventListener('stalled', () => this._armStallWatchdog());
      el.addEventListener('error', () => {
        this._clearStallWatchdog();
        this.loading = false;
        const track = findTrack(this.queue[this.index]);
        // Offline + the track *was supposed* to be cached = SW cache
        // hole. Tell the user explicitly instead of the generic "can't
        // play" so they understand this was a "should have worked
        // offline" failure (and that warmOfflineCache will fix it
        // next time they're online).
        const offlineMiss = typeof navigator !== 'undefined'
          && navigator.onLine === false
          && track?.file;
        showToast(
          offlineMiss
            ? `Pas en cache hors-ligne — ${track.title}`
            : (track ? t('toast.play_error_named', track.title) : t('toast.play_error')),
          'error',
        );
        setTimeout(() => { if (this.queue.length > 1) this.next(); }, 3000);
      });
      el.addEventListener('timeupdate', () => {
        // Any progress means buffer recovered — disarm any in-flight
        // stall watchdog (covers browsers that don't fire 'playing'
        // after a recover).
        if (this.stallTimer) this._clearStallWatchdog();
        this._onAudioTimeUpdate();
      });
      el.addEventListener('ended', () => this._onAudioEnded());
    },
    playFromList(trackId, queue) {
      const idx = queue.indexOf(trackId);
      this.queue = [...queue];
      this.index = idx >= 0 ? idx : 0;
      this.loadAndPlay();
    },
    async loadAndPlay() {
      const trackId = this.queue[this.index];
      const track = findTrack(trackId);
      if (!track || !this.audioEl) return;
      // Switching tracks — drop any stall watchdog from the previous one.
      this._clearStallWatchdog();
      // Stop any in-flight crossfade
      if (this.crossfading && this.audioEl2) {
        try { this.audioEl2.pause(); this.audioEl2.removeAttribute('src'); } catch {}
        this.crossfading = false;
      }
      this.visible = true;
      this.loading = true;
      // Revoke the previous blob URL (if any) before minting a new one.
      // Blob URLs keep the underlying memory alive until revoked.
      if (this._lastBlobUrl) {
        try { URL.revokeObjectURL(this._lastBlobUrl); } catch {}
        this._lastBlobUrl = null;
      }
      const playUrl = await resolvePlayUrl(track);
      if (playUrl && playUrl.startsWith('blob:')) this._lastBlobUrl = playUrl;
      // Bail out if the track changed under us during the await (the
      // user spammed next/prev). The newer call will own playback.
      if (this.queue[this.index] !== trackId) return;
      this.audioEl.src = playUrl;
      const prefs = usePrefsStore();
      // Stream prefetch
      if (!track.file && track.ytId) {
        useStreamsStore().prefetch(track.ytId);
      }
      this.audioEl.volume = this.muted ? 0 : prefs.volume;
      this.audioEl.play().catch(() => { this.loading = false; });
      // Look-ahead: warm the next streamable track's URL so the queue
      // transition feels instant. Only prefetches the immediate next.
      const streamsStore = useStreamsStore();
      const nextIdx = (this.index + 1) % this.queue.length;
      if (nextIdx !== this.index) {
        const nextTrack = findTrack(this.queue[nextIdx]);
        if (nextTrack && !nextTrack.file && nextTrack.ytId) {
          streamsStore.prefetch(nextTrack.ytId);
        }
      }
      this._updateMediaMetadata(track);
      this.savePlayerState();
      this.playCountedFor = null;
    },
    togglePlay() {
      if (!this.audioEl?.src) return;
      if (this.audioEl.paused) this.audioEl.play();
      else this.audioEl.pause();
    },
    next() {
      if (this.queue.length === 0) return;
      if (this.shuffle) {
        this.index = Math.floor(Math.random() * this.queue.length);
      } else {
        this.index = (this.index + 1) % this.queue.length;
      }
      this.loadAndPlay();
    },
    prev() {
      if (this.queue.length === 0) return;
      if (this.audioEl?.currentTime > 3) {
        this.audioEl.currentTime = 0;
        return;
      }
      this.index = (this.index - 1 + this.queue.length) % this.queue.length;
      this.loadAndPlay();
    },
    stop() {
      if (this.audioEl) {
        this.audioEl.pause();
        this.audioEl.src = '';
      }
      if (this._lastBlobUrl) {
        try { URL.revokeObjectURL(this._lastBlobUrl); } catch {}
        this._lastBlobUrl = null;
      }
      this._clearStallWatchdog();
      this.playing = false;
      this.loading = false;
      this.visible = false;
    },
    toggleShuffle() { this.shuffle = !this.shuffle; },
    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
    },
    toggleMute() {
      const prefs = usePrefsStore();
      this.muted = !this.muted;
      if (this.audioEl) this.audioEl.volume = this.muted ? 0 : prefs.volume;
    },
    setVolume(v) {
      const prefs = usePrefsStore();
      prefs.volume = v;
      this.muted = false;
      if (this.audioEl) this.audioEl.volume = v;
      prefs.save();
    },
    seekToPct(pct) {
      if (!this.audioEl?.duration) return;
      this.audioEl.currentTime = (pct / 100) * this.audioEl.duration;
    },
    addToQueue(trackId) {
      if (this.queue.includes(trackId)) {
        showToast(t('toast.already_in_queue'));
        return;
      }
      const insertAt = this.queue.length > 0 ? this.index + 1 : 0;
      this.queue.splice(insertAt, 0, trackId);
      showToast(t('toast.added_to_queue'), 'success');
    },
    toggleNowPlayingOpen() { this.nowPlayingOpen = !this.nowPlayingOpen; },
    openBigPicture() { this.bigPictureOpen = true; },
    closeBigPicture() { this.bigPictureOpen = false; },
    toggleBigPicture() { this.bigPictureOpen = !this.bigPictureOpen; },
    removeQueueAt(qIdx) {
      this.queue.splice(qIdx, 1);
    },
    reorderQueue(fromIdx, targetIdx) {
      if (fromIdx <= this.index || fromIdx >= this.queue.length) return;
      if (targetIdx <= this.index) targetIdx = this.index + 1;
      const [moved] = this.queue.splice(fromIdx, 1);
      const adjusted = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      this.queue.splice(adjusted, 0, moved);
    },
    // ============================================================
    // Crossfade
    // ============================================================
    _startCrossfade(nextIdx) {
      if (this.crossfading) return;
      const prefs = usePrefsStore();
      const baseVol = this.muted ? 0 : prefs.volume;
      const nextTrackId = this.queue[nextIdx];
      const nextTrack = findTrack(nextTrackId);
      if (!nextTrack || !this.audioEl || !this.audioEl2) return;
      this.crossfading = true;

      // Park the currently-playing track on audio2, then start audio fresh on
      // the next track.
      this.audioEl2.src = this.audioEl.src;
      this.audioEl2.currentTime = this.audioEl.currentTime;
      this.audioEl2.volume = baseVol;
      this.audioEl2.play().catch(() => {});

      this.audioEl.src = apiUrl(nextTrack.file);
      this.audioEl.volume = 0;
      this.audioEl.currentTime = 0;
      this.audioEl.play().catch(() => {});

      this.index = nextIdx;
      this._updateMediaMetadata(nextTrack);
      this.playCountedFor = null;

      const startTime = performance.now();
      const fade = () => {
        const elapsed = (performance.now() - startTime) / 1000;
        const t = Math.min(elapsed / prefs.crossfadeDuration, 1);
        this.audioEl.volume = baseVol * t;
        this.audioEl2.volume = baseVol * (1 - t);
        if (t < 1) {
          requestAnimationFrame(fade);
        } else {
          this.audioEl2.pause();
          try {
            this.audioEl2.removeAttribute('src');
            this.audioEl2.load();
          } catch {}
          this.crossfading = false;
        }
      };
      fade();
    },
    _maybeCrossfade() {
      if (this.crossfading) return;
      const prefs = usePrefsStore();
      if (!prefs.crossfadeEnabled) return;
      if (this.audioEl?.paused || !this.audioEl?.duration) return;
      const remaining = this.audioEl.duration - this.audioEl.currentTime;
      if (remaining > prefs.crossfadeDuration || remaining <= 0) return;
      let nextIdx = -1;
      if (this.shuffle && this.queue.length > 1) {
        do { nextIdx = Math.floor(Math.random() * this.queue.length); } while (nextIdx === this.index);
      } else if (this.index < this.queue.length - 1) {
        nextIdx = this.index + 1;
      } else if (this.repeat === 'all' && this.queue.length > 0) {
        nextIdx = 0;
      }
      if (nextIdx === -1) return;
      this._startCrossfade(nextIdx);
    },
    // ============================================================
    // Audio event handlers
    // ============================================================
    _onAudioPlay() {
      this.playing = true;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      this.savePlayerState();
    },
    _onAudioPause() {
      this.playing = false;
      this._clearStallWatchdog();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      this.savePlayerState();
    },
    _armStallWatchdog() {
      this._clearStallWatchdog();
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        // Real stall: still here, not paused, but no progress made.
        if (!this.audioEl || this.audioEl.paused) return;
        const track = findTrack(this.queue[this.index]);
        showToast(track ? t('toast.play_error_named', track.title) : t('toast.play_error'), 'error');
        if (this.queue.length > 1) this.next();
        else this.loading = false;
      }, 10000);
    },
    _clearStallWatchdog() {
      if (this.stallTimer) {
        clearTimeout(this.stallTimer);
        this.stallTimer = null;
      }
    },
    _onAudioTimeUpdate() {
      if (!this.audioEl?.duration) return;
      this.currentTime = this.audioEl.currentTime;
      this.duration = this.audioEl.duration;
      this._trackPlayProgress();
      this._maybeCrossfade();
      this._updateMediaPosition();
      this.savePlayerState();
    },
    _onAudioEnded() {
      if (this.crossfading) return;
      if (this.repeat === 'one') {
        this.audioEl.currentTime = 0;
        this.audioEl.play();
        return;
      }
      if (this.index >= this.queue.length - 1 && this.repeat !== 'all' && !this.shuffle) {
        this.playing = false;
        return;
      }
      this.next();
    },
    _trackPlayProgress() {
      const trackId = this.queue[this.index];
      if (!trackId || isStreamId(trackId)) return;
      if (this.audioEl.currentTime > 30 && this.playCountedFor !== trackId) {
        this.playCountedFor = trackId;
        api(`/api/library/${trackId}/play`, { method: 'POST' })
          .then(() => {
            const lib = useLibraryStore();
            const t = lib.findById(trackId);
            if (t) {
              t.playCount = (t.playCount || 0) + 1;
              t.lastPlayedAt = Date.now();
            }
          })
          .catch(() => {});
      }
    },
    // ============================================================
    // MediaSession integration
    // ============================================================
    // Kept for App.vue's `player.setupMediaSession()` call on boot,
    // but the real work happens in _registerMediaSessionHandlers
    // fired by the 'playing' event listener. Setting handlers at
    // boot doesn't stick on iOS — the OS reads the handler set when
    // the audio session activates, which is on the first `playing`
    // event after a play() call.
    setupMediaSession() {
      // intentionally a no-op; see comment above + the listener in init()
    },
    _registerMediaSessionHandlers() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      // Play from MediaSession (lock-screen tap, AirPods double-tap,
      // CarPlay, possibly iOS auto-resume after AirPods reconnect)
      // unconditionally reloads the audio element before resuming.
      // The AirPods-reconnect bug leaves iOS's audio routing
      // decoupled from the element; just calling .play() resumes
      // silently. audio.load() + restore src/currentTime + play
      // forces iOS to rebuild the routing pipeline.
      //
      // Cost: a tiny gap (~150 ms) when the user explicitly taps
      // play from the lock screen. Worth it given there's no other
      // way to recover in background where JS is suspended and
      // setTimeout can't fire. Blob URLs (offline) skip the reload
      // since memory playback has no routing decouple.
      try {
        ms.setActionHandler('play', () => {
          if (!this.audioEl) return;
          const isBlob = typeof this.audioEl.src === 'string'
            && this.audioEl.src.startsWith('blob:');
          if (isBlob) {
            this.audioEl.play().catch(() => {});
            return;
          }
          const src = this.audioEl.src;
          const t = this.audioEl.currentTime;
          try {
            this.audioEl.load();
            this.audioEl.src = src;
            this.audioEl.currentTime = t;
            this.audioEl.play().catch(() => {});
          } catch {}
        });
      } catch {}
      try { ms.setActionHandler('pause', () => this.audioEl?.pause()); } catch {}
      try { ms.setActionHandler('previoustrack', () => this.prev()); } catch {}
      try { ms.setActionHandler('nexttrack', () => this.next()); } catch {}
      // Re-arm seekto so the in-app + Chrome/Android lock-screen
      // scrubber still works. On iOS, having seekto registered AT
      // PLAYING TIME (as opposed to at boot) does NOT force the
      // ±10s buttons — that quirk only happens when handlers are
      // set before the audio session is active.
      try {
        ms.setActionHandler('seekto', (e) => {
          if (!this.audioEl) return;
          if (e.fastSeek && 'fastSeek' in this.audioEl) this.audioEl.fastSeek(e.seekTime);
          else this.audioEl.currentTime = e.seekTime;
        });
      } catch {}
      // Hard-null these so any older registration is wiped.
      try { ms.setActionHandler('seekbackward', null); } catch {}
      try { ms.setActionHandler('seekforward', null); } catch {}
    },
    _updateMediaMetadata(track) {
      if (!('mediaSession' in navigator)) return;
      if (!track) {
        navigator.mediaSession.metadata = null;
        return;
      }
      try {
        // iOS Safari's Control Center fetches the artwork URL out of the
        // page context — relative URLs don't resolve correctly there.
        // Force absolute via location.href as base. Multiple sizes let
        // iOS pick the best variant for the lock-screen / Now Playing.
        const thumbAbs = track.thumbnail
          ? new URL(track.thumbnail, location.href).href
          : '';
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || '',
          artist: track.uploader || '',
          album: track.album || 'Wax',
          artwork: thumbAbs
            ? [
                { src: thumbAbs, sizes: '96x96',   type: 'image/jpeg' },
                { src: thumbAbs, sizes: '192x192', type: 'image/jpeg' },
                { src: thumbAbs, sizes: '256x256', type: 'image/jpeg' },
                { src: thumbAbs, sizes: '512x512', type: 'image/jpeg' },
              ]
            : [],
        });
      } catch {}
    },
    _updateMediaPosition() {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
      if (!this.audioEl?.duration || isNaN(this.audioEl.duration)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: this.audioEl.duration,
          playbackRate: this.audioEl.playbackRate || 1,
          position: Math.min(this.audioEl.currentTime || 0, this.audioEl.duration),
        });
      } catch {}
    },
    // ============================================================
    // State persistence
    // ============================================================
    savePlayerState() {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = setTimeout(() => {
        const persistableQueue = this.queue.filter((id) => !isStreamId(id));
        if (!persistableQueue.length || this.index < 0) {
          try { localStorage.removeItem(PLAYER_STATE_KEY); } catch {}
          return;
        }
        if (this.queue.some(isStreamId)) return;
        try {
          localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
            queue: this.queue,
            index: this.index,
            currentTime: this.audioEl?.currentTime || 0,
            shuffle: this.shuffle,
            repeat: this.repeat,
          }));
        } catch {}
      }, 800);
    },
    restorePlayerState() {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(PLAYER_STATE_KEY) || 'null'); } catch { return; }
      if (!saved || !Array.isArray(saved.queue)) return;
      const lib = useLibraryStore();
      const validQueue = saved.queue.filter((id) => lib.findById(id));
      if (validQueue.length === 0) return;
      let idx = saved.index;
      if (idx < 0 || idx >= validQueue.length) idx = 0;
      this.queue = validQueue;
      this.index = idx;
      this.shuffle = !!saved.shuffle;
      this.repeat = saved.repeat || 'off';
      const track = lib.findById(validQueue[idx]);
      if (!track) return;
      this.visible = true;
      if (!this.audioEl) return;
      this.audioEl.src = apiUrl(track.file);
      const prefs = usePrefsStore();
      this.audioEl.volume = this.muted ? 0 : prefs.volume;
      this.audioEl.addEventListener('loadedmetadata', () => {
        const t = Math.min(saved.currentTime || 0, Math.max((this.audioEl.duration || 0) - 1, 0));
        this.audioEl.currentTime = t;
      }, { once: true });
      this._updateMediaMetadata(track);
    },
  },
});

export { fmtDuration };
