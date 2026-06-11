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
    // Next-track preparation (see _prepareNext). The play URL of the
    // upcoming track is resolved WHILE the current one plays so the
    // ended → next() → play() chain stays fully synchronous — iOS
    // kills any play() issued after an await when the app is
    // backgrounded / the screen is locked.
    _planned: null,   // { idx, trackId } — pre-drawn next queue position
    _preloaded: null, // { trackId, url, isBlob } — resolved play URL for it
    // Sleep timer state. `sleepEndAt` is a Date.now()-style ms timestamp
    // when playback should stop (null = no timer running). The timer
    // itself is stored in `_sleepTimer` so we can cancel/reschedule.
    // The last 5 s ramps volume down so the cut isn't jarring.
    sleepEndAt: null,
    _sleepTimer: null,
    _sleepFadeRaf: null,
    _sleepPreFadeVolume: null,
    // Playback rate, 0.5 → 2.0. Persisted in localStorage via the
    // player-state save loop. Restored on bindAudio + each
    // loadAndPlay so a track change doesn't reset it.
    playbackRate: 1,
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
      // Heart must reflect "is in Favoris" (liked !== false), not "is
      // in library at all". Playlist-only tracks (added silently with
      // liked:false by mix.save or playlist add) would otherwise show
      // the heart filled even though they're not actual favorites.
      let libTrack;
      if (isStreamId(id)) {
        const stream = useStreamsStore().get(id);
        if (!stream) return false;
        libTrack = lib.tracks.find((t) => t.ytId === stream.ytId);
      } else {
        libTrack = lib.findById(id);
      }
      return !!libTrack && libTrack.liked !== false;
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
      // Listeners go on BOTH elements. The gapless engine pre-buffers the
      // next track into the spare element while the current one plays,
      // then SWAPS which element is "active" (this.audioEl) at the track
      // boundary — so the next track starts from an already-buffered
      // element with no fetch gap. A zero-gap transition is the best shot
      // at keeping iOS's audio session alive on the lock screen (the gap
      // is what makes iOS tear the session down → dead queue). Each
      // handler ignores events coming from whichever element is currently
      // the spare (active() re-checks at event time, so swaps are honored).
      this._bindListeners(el);
      this._bindListeners(el2);
    },
    _bindListeners(el) {
      const active = () => el === this.audioEl;
      el.addEventListener('play', () => { if (active()) this._onAudioPlay(); });
      el.addEventListener('pause', () => { if (active()) this._onAudioPause(); });
      el.addEventListener('playing', () => {
        if (!active()) return;
        this.loading = false;
        this._clearStallWatchdog();
        // Build the gapless spare ONLY once the active element is genuinely
        // playing (audio confirmed flowing). The spare must never be a
        // ready, idle <audio> during a fragile window — fresh play()/resume
        // session acquisition — or iOS routes the resumed output to it and
        // the active element advances silently. So: build here (playing),
        // tear down on pause (_releaseSpare). Net effect: the spare only
        // lives during steady playback, which is exactly when next/prev +
        // the boundary swap need it.
        this._prepareNext();
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
        if (!active()) return;
        this.loading = true;
        this._armStallWatchdog();
      });
      el.addEventListener('stalled', () => { if (active()) this._armStallWatchdog(); });
      el.addEventListener('error', () => {
        if (!active()) return; // a spare-element preload error mustn't disrupt playback
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
        if (!active()) return;
        // Any progress means buffer recovered — disarm any in-flight
        // stall watchdog (covers browsers that don't fire 'playing'
        // after a recover).
        if (this.stallTimer) this._clearStallWatchdog();
        this._onAudioTimeUpdate();
      });
      el.addEventListener('ended', () => { if (active()) this._onAudioEnded(); });
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
      // Invalidate any spare plan from the PREVIOUS context — a non-
      // sequential load means the buffered next is no longer the right one.
      // (The fresh spare rebuilds on this track's 'playing' event.) Without
      // this, a super-fast next() right after the load could swap to the
      // stale spare.
      this._discardPreloaded();
      // Stop any in-flight crossfade
      if (this.crossfading && this.audioEl2) {
        try { this.audioEl2.pause(); this.audioEl2.removeAttribute('src'); } catch {}
        this.crossfading = false;
      }
      this.visible = true;
      this.loading = true;
      // loadAndPlay handles NON-sequential loads (tap a track, playFromList,
      // prev, restore-resume) — it loads on the ACTIVE element. The natural
      // ended → next sequential step goes through _swapToPreloaded instead,
      // which plays the already-buffered spare element gaplessly. Online we
      // resolve the URL synchronously (no await) so even the fallback path
      // — when no preload is ready — gives the queue its best shot in the
      // background. Offline-with-a-cached-file is the only awaited case (iOS
      // audio fetches bypass the SW, so the blob: URL from the Cache API is
      // mandatory).
      const previousBlob = this._lastBlobUrl;
      let playUrl = null;
      if (typeof navigator !== 'undefined' && navigator.onLine === false && track.file) {
        playUrl = await resolvePlayUrl(track);
        // Bail out if the track changed under us during the await (the
        // user spammed next/prev). The newer call will own playback.
        if (this.queue[this.index] !== trackId) {
          if (playUrl && playUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(playUrl); } catch {}
          }
          return;
        }
        this._lastBlobUrl = playUrl && playUrl.startsWith('blob:') ? playUrl : null;
      } else {
        playUrl = trackPlayUrl(track);
        this._lastBlobUrl = null;
      }
      if (!playUrl) { this.loading = false; return; }
      this.audioEl.src = playUrl;
      // Previous track's blob can be released now that the element
      // points at the new source.
      if (previousBlob && previousBlob !== playUrl) {
        try { URL.revokeObjectURL(previousBlob); } catch {}
      }
      const prefs = usePrefsStore();
      // Stream prefetch
      if (!track.file && track.ytId) {
        useStreamsStore().prefetch(track.ytId);
      }
      this.audioEl.volume = this.muted ? 0 : prefs.volume;
      // Restore the user-picked playback rate + pitched mode — audio
      // elements reset BOTH on src change, so without this each new
      // track would silently revert to 1.0× preservesPitch=true.
      try { this.audioEl.preservesPitch = false; } catch {}
      try { this.audioEl.webkitPreservesPitch = false; } catch {}
      this.audioEl.playbackRate = this.playbackRate;
      this.audioEl.play().catch(() => { this.loading = false; });
      this._updateMediaMetadata(track);
      this.savePlayerState();
      this.playCountedFor = null;
      // The gapless spare is built on the 'playing' event (once audio is
      // confirmed flowing), not here — keeps it out of the play()
      // session-acquisition window. See the 'playing' listener.
    },
    togglePlay() {
      if (!this.audioEl?.src) return;
      if (this.audioEl.paused) {
        // Resume — the spare rebuilds itself on the 'playing' event once
        // audio is confirmed flowing (kept out of the fragile resume task).
        this.audioEl.play();
      } else {
        this.audioEl.pause();
        // Release the pre-buffered spare while paused. On iOS the second
        // "ready" <audio> competes for the audio session at the moment
        // playback resumes — leaving the active element advancing but
        // silent. Freeing it means resume re-acquires the session with a
        // single element. Steady-state (both live) is fine; only the
        // pause→resume transition was affected.
        this._releaseSpare();
      }
    },
    next() {
      if (this.queue.length === 0) return;
      // Gapless swap when the pre-buffered spare element holds the planned
      // next track — instant, no fetch. Falls back to a normal load
      // otherwise (manual next on the last track still wraps to 0).
      if (this._swapToPreloaded()) return;
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
      // Also clear the spare element holding any buffered next track.
      if (this.audioEl2) {
        try { this.audioEl2.pause(); this.audioEl2.removeAttribute('src'); this.audioEl2.load(); } catch {}
      }
      if (this._lastBlobUrl) {
        try { URL.revokeObjectURL(this._lastBlobUrl); } catch {}
        this._lastBlobUrl = null;
      }
      this._clearStallWatchdog();
      this._discardPreloaded();
      this.playing = false;
      this.loading = false;
      this.visible = false;
    },
    // Shuffle / repeat change which track comes next — re-resolve the
    // preloaded spare so the boundary swap points at the right one. Only
    // while playing: rebuilding the spare while paused would re-introduce
    // the idle-ready element that breaks resume (see _releaseSpare).
    toggleShuffle() {
      this.shuffle = !this.shuffle;
      if (this.audioEl && !this.audioEl.paused) this._prepareNext();
      else this._releaseSpare();
    },
    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
      if (this.audioEl && !this.audioEl.paused) this._prepareNext();
      else this._releaseSpare();
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
      // The just-inserted track may now be the upcoming one — re-resolve
      // the spare (only while playing, see toggleShuffle).
      if (this.audioEl && !this.audioEl.paused) this._prepareNext();
    },
    toggleNowPlayingOpen() { this.nowPlayingOpen = !this.nowPlayingOpen; },
    openBigPicture() { this.bigPictureOpen = true; },
    closeBigPicture() { this.bigPictureOpen = false; },
    toggleBigPicture() { this.bigPictureOpen = !this.bigPictureOpen; },
    removeQueueAt(qIdx) {
      this.queue.splice(qIdx, 1);
      if (qIdx < this.index) this.index -= 1;
      if (this.audioEl && !this.audioEl.paused) this._prepareNext();
    },
    reorderQueue(fromIdx, targetIdx) {
      if (fromIdx <= this.index || fromIdx >= this.queue.length) return;
      if (targetIdx <= this.index) targetIdx = this.index + 1;
      const [moved] = this.queue.splice(fromIdx, 1);
      const adjusted = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      this.queue.splice(adjusted, 0, moved);
      if (this.audioEl && !this.audioEl.paused) this._prepareNext();
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
    // ============================================================
    // Sleep timer
    // ============================================================
    // Schedule playback to stop in `minutes`. Last 5 s smoothly
    // ramps audio volume to 0 (requestAnimationFrame) so the cut
    // doesn't startle the user falling asleep. Volume is restored
    // to its pre-fade value after stop so the next manual play
    // resumes at the user's normal level.
    setSleepTimer(minutes) {
      this.cancelSleepTimer();
      if (!minutes || minutes <= 0) return;
      const totalMs = minutes * 60 * 1000;
      this.sleepEndAt = Date.now() + totalMs;
      const fadeStart = Math.max(0, totalMs - 5000);

      // Phase 1: idle until 5 s before the end.
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = null;
        if (!this.audioEl) { this._finalizeSleep(); return; }
        // Phase 2: 5 s volume fade. Snapshot the volume so we can
        // restore it after the timer fires (otherwise a future play
        // starts silent).
        this._sleepPreFadeVolume = this.audioEl.volume;
        const v0 = this._sleepPreFadeVolume;
        const t0 = performance.now();
        const tick = (now) => {
          if (!this.audioEl) { this._finalizeSleep(); return; }
          const p = Math.min(1, (now - t0) / 5000);
          this.audioEl.volume = v0 * (1 - p);
          if (p < 1) {
            this._sleepFadeRaf = requestAnimationFrame(tick);
          } else {
            this._sleepFadeRaf = null;
            this._finalizeSleep();
          }
        };
        this._sleepFadeRaf = requestAnimationFrame(tick);
      }, fadeStart);
    },
    cancelSleepTimer() {
      if (this._sleepTimer) { clearTimeout(this._sleepTimer); this._sleepTimer = null; }
      if (this._sleepFadeRaf) { cancelAnimationFrame(this._sleepFadeRaf); this._sleepFadeRaf = null; }
      // Restore the volume if a fade was in progress.
      if (this._sleepPreFadeVolume != null && this.audioEl) {
        this.audioEl.volume = this._sleepPreFadeVolume;
      }
      this._sleepPreFadeVolume = null;
      this.sleepEndAt = null;
    },
    _finalizeSleep() {
      // Stop playback + restore volume so the next manual play
      // doesn't start silent.
      if (this.audioEl) this.audioEl.pause();
      if (this._sleepPreFadeVolume != null && this.audioEl) {
        this.audioEl.volume = this._sleepPreFadeVolume;
      }
      this._sleepPreFadeVolume = null;
      this.sleepEndAt = null;
    },
    // ============================================================
    // Playback rate (speed)
    // ============================================================
    // Set audio.playbackRate + DISABLE preservesPitch so the audio
    // is genuinely played faster/slower instead of being time-
    // stretched by the browser's podcast-style algorithm.
    //
    // With preservesPitch = true (the default), changing rate keeps
    // the original pitch — useful for podcasts but for MUSIC the
    // time-stretch artefacts make everything sound robotic and
    // washed-out. Setting it false gives the "slowed + reverbed"
    // / "sped up" remix vibe everyone knows from TikTok / YouTube:
    // 0.85× = darker, lower pitch, dreamier; 1.15× = brighter,
    // higher pitch, energetic. No artefacts because the audio is
    // literally replayed at a different rate.
    //
    // webkitPreservesPitch is the legacy prefixed name; setting both
    // covers iOS 17 → 18 in one go.
    setPlaybackRate(rate) {
      const clamped = Math.max(0.5, Math.min(2, Number(rate) || 1));
      this.playbackRate = clamped;
      for (const el of [this.audioEl, this.audioEl2]) {
        if (!el) continue;
        try { el.preservesPitch = false; } catch {}
        try { el.mozPreservesPitch = false; } catch {}
        try { el.webkitPreservesPitch = false; } catch {}
        el.playbackRate = clamped;
      }
      this.savePlayerState();
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
    // Track finished. Promote the pre-buffered spare element (gapless,
    // synchronous, no fetch) so the audio session has the best chance of
    // surviving the boundary on the lock screen. Falls back to a normal
    // load if the preload wasn't ready. NB: WebKit doesn't reliably fire
    // 'ended' for a backgrounded standalone PWA at all — when it doesn't,
    // nothing here runs; that part is an iOS limitation, not ours.
    _onAudioEnded() {
      if (this.crossfading) return;
      if (this.repeat === 'one') {
        this.audioEl.currentTime = 0;
        this.audioEl.play();
        return;
      }
      if (this._swapToPreloaded()) return;
      const nextIdx = this._naturalNextIndex();
      if (nextIdx < 0 || nextIdx >= this.queue.length) {
        this.playing = false;
        return;
      }
      this.index = nextIdx;
      this.loadAndPlay();
    },
    // The queue position that plays after the current track ends
    // naturally: shuffle picks a random other track, sequential advances
    // by one, repeat:'all' wraps to 0, otherwise -1 (end → stop). Shuffle's
    // random is rolled ONCE here (by _prepareNext) and cached in _planned
    // so the preloaded URL can match the track that'll actually play.
    _naturalNextIndex() {
      if (this.queue.length === 0) return -1;
      if (this.shuffle && this.queue.length > 1) {
        let n;
        do { n = Math.floor(Math.random() * this.queue.length); } while (n === this.index);
        return n;
      }
      if (this.index < this.queue.length - 1) return this.index + 1;
      if (this.repeat === 'all') return 0;
      return -1;
    },
    // While the current track plays, decide the next one and BUFFER ITS
    // AUDIO DATA into the spare element (this.audioEl2) so the boundary
    // transition is gapless — the engine just plays the already-loaded
    // element instead of fetching from scratch. Offline cached files get
    // a blob: URL minted from the Cache API (iOS audio bypasses the SW);
    // online and stream tracks use their direct URL. Safe to call
    // repeatedly — discards any previous plan first.
    async _prepareNext() {
      this._discardPreloaded();
      if (this.index < 0 || this.queue.length === 0 || !this.audioEl2) return;
      if (this.repeat === 'one') return; // same track replays, nothing to preload
      // Crossfade owns audioEl2 + its own next-track loading; don't fight it.
      if (usePrefsStore().crossfadeEnabled) return;
      const nextIdx = this._naturalNextIndex();
      if (nextIdx < 0 || nextIdx === this.index) return;
      const nextId = this.queue[nextIdx];
      const nextTrack = findTrack(nextId);
      if (!nextTrack) return;
      this._planned = { idx: nextIdx, trackId: nextId };
      // Warm the server-side stream URL cache for the upcoming track.
      if (!nextTrack.file && nextTrack.ytId) {
        try { useStreamsStore().prefetch(nextTrack.ytId); } catch {}
      }
      let url = null;
      let isBlob = false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false && nextTrack.file) {
        url = await resolvePlayUrl(nextTrack);
        isBlob = !!url && url.startsWith('blob:');
      } else {
        url = trackPlayUrl(nextTrack);
      }
      // The plan may have been superseded (skip, queue edit) while we
      // awaited the cache lookup — drop the now-orphan blob.
      if (!this._planned || this._planned.trackId !== nextId) {
        if (isBlob && url) { try { URL.revokeObjectURL(url); } catch {} }
        return;
      }
      if (!url) { this._planned = null; return; }
      // Buffer the data into the spare element. preload='auto' + load()
      // make it fetch ahead so the swap at the boundary is instant.
      try {
        this.audioEl2.preload = 'auto';
        this.audioEl2.src = url;
        this.audioEl2.load();
      } catch {}
      this._preloaded = { trackId: nextId, url, isBlob };
    },
    // Promote the pre-buffered spare element to active and play it. Returns
    // true when it actually swapped (preload matched the planned next),
    // false when there was nothing ready — the caller then does a normal
    // load. The element-reference swap means all the `this.audioEl.*` code
    // keeps targeting whatever is now playing, and the listeners bound to
    // both elements (see _bindListeners) keep firing for the active one.
    _swapToPreloaded() {
      const plan = this._planned;
      const pre = this._preloaded;
      if (!plan || !pre || this.crossfading) return false;
      if (plan.idx < 0 || plan.idx >= this.queue.length) return false;
      if (this.queue[plan.idx] !== pre.trackId) return false;
      // Confirm the spare element is actually holding the planned source.
      // audioEl2.src reads back as a normalized absolute URL, so normalize
      // pre.url (which may be a relative '/api/...' path) before comparing.
      const norm = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
      if (!this.audioEl2 || norm(this.audioEl2.src || '') !== norm(pre.url)) return false;
      this._clearStallWatchdog();
      const newActive = this.audioEl2;
      const oldActive = this.audioEl;
      const outgoingBlob = this._lastBlobUrl;
      // Swap refs FIRST so any event the old element fires while we tear it
      // down (pause/emptied) is seen as coming from the now-spare element
      // and ignored by the active()-guarded listeners.
      this.audioEl = markRaw(newActive);
      this.audioEl2 = markRaw(oldActive);
      this.index = plan.idx;
      this._lastBlobUrl = pre.isBlob ? pre.url : null;
      this._preloaded = null;
      this._planned = null;
      this.loading = true;
      const prefs = usePrefsStore();
      newActive.volume = this.muted ? 0 : prefs.volume;
      try { newActive.preservesPitch = false; } catch {}
      try { newActive.webkitPreservesPitch = false; } catch {}
      newActive.playbackRate = this.playbackRate;
      try { newActive.currentTime = 0; } catch {}
      newActive.play().catch(() => { this.loading = false; });
      // Free the outgoing element + release its blob (after clearing src so
      // the element isn't pointing at a revoked URL).
      try { oldActive.pause(); oldActive.removeAttribute('src'); oldActive.load(); } catch {}
      if (outgoingBlob && outgoingBlob !== this._lastBlobUrl) {
        try { URL.revokeObjectURL(outgoingBlob); } catch {}
      }
      const track = findTrack(this.queue[this.index]);
      if (!track.file && track.ytId) { try { useStreamsStore().prefetch(track.ytId); } catch {} }
      this._updateMediaMetadata(track);
      this.savePlayerState();
      this.playCountedFor = null;
      // The NEW next buffers into the now-free spare on the swapped
      // element's 'playing' event (not here) — see the 'playing' listener.
      return true;
    },
    _discardPreloaded() {
      if (this._preloaded?.isBlob && this._preloaded.url) {
        try { URL.revokeObjectURL(this._preloaded.url); } catch {}
      }
      this._preloaded = null;
      this._planned = null;
    },
    // Tear the spare element fully down (src emptied) so it stops holding
    // audio data + competing for the iOS audio session. Called when the
    // user pauses; the spare is rebuilt by _prepareNext on resume.
    _releaseSpare() {
      this._discardPreloaded();
      if (this.audioEl2) {
        try { this.audioEl2.pause(); this.audioEl2.removeAttribute('src'); this.audioEl2.load(); } catch {}
      }
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
      // Note: we DON'T try to recover from the iOS AirPods-reconnect
      // silent-resume bug here. Tested four flavours of recovery
      // (global watchdog, visibility-gated watchdog, MediaSession-
      // play-tap recovery, unconditional reload on MediaSession
      // play) — none of them fixed the background case. iOS suspends
      // PWA JS execution when the app is backgrounded, so any
      // setTimeout-based check can't fire; and iOS's auto-resume on
      // AirPods reinsertion appears to bypass the MediaSession play
      // action entirely, so the synchronous reload also gets no
      // chance to run. The only working "fix" is for the user to
      // briefly tap into the app, which makes iOS rebuild the
      // routing on its own. PWA platform limitation, not a code
      // bug.
      // pause() frees the gapless spare so it can't steal the audio session
      // when playback resumes (the spare rebuilds on the next 'playing'
      // event). play() stays a bare synchronous call — iOS needs it in the
      // handler task. See _releaseSpare / togglePlay.
      try { ms.setActionHandler('play', () => this.audioEl?.play()); } catch {}
      try { ms.setActionHandler('pause', () => { this.audioEl?.pause(); this._releaseSpare(); }); } catch {}
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
            playbackRate: this.playbackRate,
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
      if (typeof saved.playbackRate === 'number' && saved.playbackRate >= 0.5 && saved.playbackRate <= 2) {
        this.playbackRate = saved.playbackRate;
      }
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
      // Track is restored PAUSED — don't build the gapless spare yet (an
      // idle-ready spare during the first resume is exactly what breaks
      // playback). It builds on the first 'playing' event after the user
      // hits play.
    },
  },
});

export { fmtDuration };
