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
    // Next-track preload state. We warm `audioEl2` with the next
    // track's audio ~1.5 s after the current track starts playing
    // so a manual `next()` (or auto-end) can swap to an already-
    // buffered element instead of fetching from scratch (which used
    // to leave a 1-3 s gap on stream tracks).
    //   _preloadedFor: queue index that audio2 is primed for
    //   _preloadedUrl: the URL currently in audio2.src
    //   _preloadedBlobUrl: blob: URL we minted (needs revoking)
    //   _preloadTimer: debounce timer for _preloadNext()
    _preloadedFor: null,
    _preloadedUrl: null,
    _preloadedBlobUrl: null,
    _preloadTimer: null,
    // Blob URL of the *outgoing* track during a swap fade. Tracked so
    // finishSwap() can revoke it whether the fade completes normally
    // or gets interrupted (a mid-fade loadAndPlay clears crossfading
    // and our RAF bails — without this state field the outgoing blob
    // would leak because _lastBlobUrl already points at the swap's
    // incoming blob by the time loadAndPlay runs its revoke step).
    _swapOutgoingBlob: null,
    // True for the brief window between `audioEl.src = newUrl` and the
    // subsequent .play() resolving. Setting src on a playing audio
    // element fires a spurious `pause` event (HTMLMediaElement spec:
    // src change interrupts current playback). In foreground the
    // following `play` event corrects state instantly, but in iOS
    // background the play event can be delayed / dropped, leaving
    // `playing` stuck at false and mediaSession.playbackState at
    // 'paused' even though audio is actually progressing. The pause
    // listener checks this flag and bails out instead of overwriting
    // state.
    _swapInProgress: false,
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
      // Heart icon must reflect "is in Favoris" (liked !== false), not
      // "is in library at all". Playlist-only tracks have liked:false
      // and used to falsely render as favorites because the previous
      // check was just `lib.tracks.some(t => t.id === id)`.
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
      if (el2) el2.volume = 0;
      // Both elements get the same listeners — after a preload swap
      // the "active" role moves from one element to the other, and
      // we want events from the (new) active element to fire normally.
      // The handlers themselves filter via `event.currentTarget ===
      // this.audioEl` so events from the inactive (preloading /
      // outgoing) element are ignored.
      this._attachAudioListeners(el);
      if (el2) this._attachAudioListeners(el2);
      // Resync mediaSession + `playing` to live audioEl truth on
      // every visibility transition.
      //   - On hide (= phone lock): iOS samples mediaSession state
      //     at this exact moment to render the lock-screen icon. Any
      //     drift accumulated during the previous foreground session
      //     (stalls, coalesced events, etc.) gets corrected before
      //     iOS reads it. Without this the second lock can render a
      //     "play" icon for audio that's actually progressing.
      //   - On show (= unlock / app foreground): catches drift that
      //     happened while we were hidden so the in-app play/pause
      //     button is correct the moment the user looks.
      if (typeof document !== 'undefined' && !this._visibilityBound) {
        this._visibilityBound = true;
        document.addEventListener('visibilitychange', () => {
          this._resyncPlayState();
        });
        // pagehide / pageshow are the iOS-friendly companions to
        // visibilitychange — iOS Safari fires these reliably for PWA
        // lock/unlock while visibilitychange is sometimes flaky in
        // standalone display mode. Double-listening costs nothing.
        window.addEventListener('pagehide', () => this._resyncPlayState());
        window.addEventListener('pageshow', () => this._resyncPlayState());
      }
      // Periodic re-assertion: iOS Safari has a long-standing quirk
      // where it silently resets mediaSession.playbackState to
      // 'paused' across audio-session transitions (page hide, audio
      // route changes, interruption recovery, src changes), and the
      // lock-screen icon flips to "play" until something writes it
      // back. timeupdate covers most cases but in deep background
      // it's throttled and may not fire between an iOS reset and a
      // lock-screen sample. A plain interval that re-writes whatever
      // audioEl.paused currently says is the cheapest bulletproof
      // defense — clamped at 0.5 s to feel "instant" to the user
      // and to win the race against most iOS samples.
      if (!this._stateAssertTimer) {
        this._stateAssertTimer = setInterval(() => this._resyncPlayState(), 500);
      }
    },
    _resyncPlayState() {
      if (!this.audioEl) return;
      const actuallyPlaying = !this.audioEl.paused;
      if (this.playing !== actuallyPlaying) this.playing = actuallyPlaying;
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = actuallyPlaying ? 'playing' : 'paused';
        } catch {}
      }
    },
    _attachAudioListeners(el) {
      // Each handler bails when fired from the inactive element.
      // We can't compare against a captured ref because `this.audioEl`
      // is what gets swapped — we re-evaluate it on every event.
      el.addEventListener('play', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        // Trust the live state over a potentially-stale event. In
        // background iOS coalesces media events and may deliver a
        // play event for a transition that has since been superseded
        // (e.g. user paused right after a background swap). The
        // element's current `.paused` is the source of truth.
        if (this.audioEl.paused) return;
        this._onAudioPlay();
      });
      el.addEventListener('pause', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        // Same defense as above, the more critical direction for the
        // lock-screen icon bug. Setting `audioEl.src = preloadedUrl`
        // during a swap fires a spec-mandated `pause` event for the
        // old playback ending. In foreground the immediate `play()`
        // we issue after fires its own play event right away, but in
        // iOS background that play event is often delayed by seconds
        // — and the queued pause event eventually fires during a
        // moment where audioEl is already playing the new track.
        // Reading audioEl.paused at handler time bails out of those
        // stale events. _swapInProgress is the belt-and-suspenders
        // fallback for the brief window where audioEl.paused may
        // legitimately read true between src= and play().
        if (this._swapInProgress) return;
        if (!this.audioEl.paused) return;
        this._onAudioPause();
      });
      el.addEventListener('playing', (e) => {
        if (e.currentTarget !== this.audioEl) return;
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
        // Once playback is stable, schedule the preload of the next
        // track on audioEl2 so a subsequent next() / auto-end can
        // hand off without the 1-3 s URL-resolve + buffer wait.
        this._schedulePreloadNext();
      });
      // 'waiting' fires when the buffer underruns. The corresponding
      // 'playing' event fires once buffering recovers — but on a stale
      // YouTube CDN URL (signed, expires mid-track) the audio just sits
      // there forever with no error. Watchdog kicks in after 10 s of
      // silence and skips the track.
      el.addEventListener('waiting', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        this.loading = true;
        this._armStallWatchdog();
      });
      el.addEventListener('stalled', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        this._armStallWatchdog();
      });
      el.addEventListener('error', (e) => {
        if (e.currentTarget !== this.audioEl) return;
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
      el.addEventListener('timeupdate', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        // Any progress means buffer recovered — disarm any in-flight
        // stall watchdog (covers browsers that don't fire 'playing'
        // after a recover).
        if (this.stallTimer) this._clearStallWatchdog();
        // Self-healing AND defensive re-assertion. timeupdate firing
        // is proof of life: the audio element IS playing right now.
        // We:
        //   1. Always re-write mediaSession.playbackState to match
        //      reality — iOS Safari has a long-standing quirk where
        //      it silently resets playbackState to 'paused' across
        //      certain transitions (page hide, audio interruption
        //      recovery, src change). Asserting on every timeupdate
        //      (~4Hz foreground, ~1Hz throttled background) over-
        //      writes the bad state within a second of any reset, so
        //      the lock-screen icon stays correct even on the second
        //      / third / Nth lock of the same session.
        //   2. Repair our own `this.playing` if it drifted (event
        //      coalescing in background can pin it to false).
        const isPlaying = !this.audioEl.paused;
        if (isPlaying && !this.playing) this.playing = true;
        if ('mediaSession' in navigator) {
          try {
            navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
          } catch {}
        }
        this._onAudioTimeUpdate();
      });
      el.addEventListener('ended', (e) => {
        if (e.currentTarget !== this.audioEl) return;
        this._onAudioEnded();
      });
    },
    playFromList(trackId, queue) {
      this._invalidatePreload();
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
      // A manual loadAndPlay supersedes any in-flight preload: audio2
      // may be primed for an index we're skipping past.
      this._invalidatePreload();
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
      // Restore the user-picked playback rate + pitched mode — audio
      // elements reset BOTH on src change, so without this each new
      // track would silently revert to 1.0× preservesPitch=true.
      try { this.audioEl.preservesPitch = false; } catch {}
      try { this.audioEl.webkitPreservesPitch = false; } catch {}
      this.audioEl.playbackRate = this.playbackRate;
      this.audioEl.play().catch(() => { this.loading = false; });
      // Optimistic state — same reasoning as _swapToPreloaded: iOS
      // can delay/drop the play event in background, leaving the
      // lock-screen icon stuck on "play" (=paused) while audio
      // progresses. Assert immediately so the next iOS sample sees
      // 'playing'. If play() actually rejects, the periodic
      // _resyncPlayState (setInterval 500 ms) will correct based on
      // audioEl.paused.
      this.playing = true;
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'playing'; } catch {}
      }
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
      // Fast path: if audioEl2 is already buffered with the next
      // track, swap roles with a quick 300 ms crossfade instead of
      // tearing down audioEl and re-fetching from scratch. Skipped
      // in shuffle mode because the real target is random — what we
      // preloaded (index+1) won't match.
      if (!this.shuffle) {
        const targetIdx = (this.index + 1) % this.queue.length;
        if (this._preloadedFor === targetIdx
            && this.audioEl2?.src
            && targetIdx !== this.index) {
          if (this._swapToPreloaded(300)) return;
        }
      }
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
      this._invalidatePreload();
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
      // The slot we may have preloaded for (index+1) is now a
      // different track — drop the stale buffer and re-prime soon.
      this._invalidatePreload();
      if (this.playing) this._schedulePreloadNext(500);
      showToast(t('toast.added_to_queue'), 'success');
    },
    toggleNowPlayingOpen() { this.nowPlayingOpen = !this.nowPlayingOpen; },
    openBigPicture() { this.bigPictureOpen = true; },
    closeBigPicture() { this.bigPictureOpen = false; },
    toggleBigPicture() { this.bigPictureOpen = !this.bigPictureOpen; },
    removeQueueAt(qIdx) {
      this.queue.splice(qIdx, 1);
      this._invalidatePreload();
      if (this.playing) this._schedulePreloadNext(500);
    },
    reorderQueue(fromIdx, targetIdx) {
      if (fromIdx <= this.index || fromIdx >= this.queue.length) return;
      if (targetIdx <= this.index) targetIdx = this.index + 1;
      const [moved] = this.queue.splice(fromIdx, 1);
      const adjusted = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
      this.queue.splice(adjusted, 0, moved);
      this._invalidatePreload();
      if (this.playing) this._schedulePreloadNext(500);
    },
    // ============================================================
    // Crossfade
    // ============================================================
    _startCrossfade(nextIdx) {
      if (this.crossfading) return;
      const prefs = usePrefsStore();
      // If we preloaded the next track on audio2 already, prefer the
      // swap path: it reuses the already-buffered audio (instant) and
      // works for stream tracks too (the legacy reload path below only
      // handled offline tracks via `apiUrl(nextTrack.file)`).
      if (this._preloadedFor === nextIdx && this.audioEl2?.src) {
        this._swapToPreloaded(prefs.crossfadeDuration * 1000);
        return;
      }
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
    // ============================================================
    // Preload + fast swap
    // ============================================================
    // Goal: when the user (or auto-end) advances to the next track,
    // playback should start instantly with a short fade instead of
    // freezing for 1-3 s while the new URL is fetched + buffered.
    //
    // Strategy: ~1.5 s after the current track starts playing,
    // resolve the *next* track's URL and load it into audioEl2
    // (with preload='auto' so the browser actually downloads the
    // audio). On next() / _onAudioEnded, if audioEl2 is primed for
    // the target index, swap roles: audioEl2 becomes the active
    // element (playing the new track from its already-buffered
    // state), the outgoing audioEl becomes audio2 and is faded out.
    //
    // bindAudio attaches listeners to BOTH elements so the swap
    // doesn't lose play/pause/timeupdate/ended wiring — each handler
    // filters by `event.currentTarget === this.audioEl` to ignore
    // events from whichever element is currently inactive.
    //
    // Skipped in shuffle mode (next() picks a random index, so what
    // we preloaded won't match) and when repeat='one' (we already
    // have the buffer).
    _computeNextIndex() {
      if (this.queue.length === 0) return -1;
      if (this.shuffle) return -1;       // random — can't predict
      if (this.repeat === 'one') return -1; // same track, already loaded
      const nextIdx = this.index + 1;
      if (nextIdx >= this.queue.length) {
        return this.repeat === 'all' ? 0 : -1;
      }
      return nextIdx;
    },
    _schedulePreloadNext(delayMs = 1500) {
      if (this._preloadTimer) {
        clearTimeout(this._preloadTimer);
        this._preloadTimer = null;
      }
      this._preloadTimer = setTimeout(() => {
        this._preloadTimer = null;
        this._preloadNext().catch((e) => console.warn('[player] preload err', e));
      }, delayMs);
    },
    async _preloadNext() {
      if (!this.audioEl2) return;
      const nextIdx = this._computeNextIndex();
      if (nextIdx === -1 || nextIdx === this.index) return;
      if (this._preloadedFor === nextIdx && this.audioEl2.src) return;

      const trackId = this.queue[nextIdx];
      const track = findTrack(trackId);
      if (!track) return;

      // Warm the stream URL cache so resolvePlayUrl doesn't have to
      // wait on yt-dlp at swap time.
      if (!track.file && track.ytId) {
        useStreamsStore().prefetch(track.ytId);
      }

      const url = await resolvePlayUrl(track);
      // State may have shifted while resolvePlayUrl was awaiting.
      // Drop the result if the queue rearranged, we already advanced
      // past this index, or we already started playing this track.
      if (!url) return;
      if (this.queue[nextIdx] !== trackId) return;
      if (this.queue[this.index] === trackId) return;

      // Revoke any stale preload blob (don't touch the one currently
      // playing — that's tracked separately in _lastBlobUrl).
      if (this._preloadedBlobUrl && this._preloadedBlobUrl !== this._lastBlobUrl) {
        try { URL.revokeObjectURL(this._preloadedBlobUrl); } catch {}
      }
      this._preloadedBlobUrl = url.startsWith('blob:') ? url : null;

      try {
        this.audioEl2.preload = 'auto';
        this.audioEl2.src = url;
        this.audioEl2.volume = 0;
        // Audio elements reset playbackRate + preservesPitch on src
        // change, so re-assert them or the preloaded track plays at
        // 1× when swapped in.
        try { this.audioEl2.preservesPitch = false; } catch {}
        try { this.audioEl2.webkitPreservesPitch = false; } catch {}
        this.audioEl2.playbackRate = this.playbackRate;
        this.audioEl2.load();
      } catch (e) {
        console.warn('[player] preload assign failed', e);
        this._preloadedBlobUrl = null;
        return;
      }
      this._preloadedFor = nextIdx;
      this._preloadedUrl = url;
    },
    _invalidatePreload() {
      if (this._preloadTimer) {
        clearTimeout(this._preloadTimer);
        this._preloadTimer = null;
      }
      // Only revoke if it's not the URL currently playing (after a
      // swap _lastBlobUrl = the formerly-preloaded blob; we mustn't
      // free it under the active audio element).
      if (this._preloadedBlobUrl && this._preloadedBlobUrl !== this._lastBlobUrl) {
        try { URL.revokeObjectURL(this._preloadedBlobUrl); } catch {}
      }
      this._preloadedBlobUrl = null;
      this._preloadedFor = null;
      this._preloadedUrl = null;
      // Quiesce audio2 unless a crossfade is in flight (in which case
      // it's actively playing the outgoing track and will be cleaned
      // up by the fade itself).
      if (this.audioEl2 && !this.crossfading) {
        try {
          this.audioEl2.pause();
          this.audioEl2.removeAttribute('src');
          this.audioEl2.load();
        } catch {}
      }
    },
    // Hand off the preloaded URL to audioEl and (optionally) fade
    // between the outgoing track parked on audioEl2 and the new one.
    //
    // IMPORTANT — we used to swap audioEl ↔ audioEl2 to "promote" the
    // preloaded element to active. That broke iOS background
    // playback: the audio session is anchored to a specific element
    // and doesn't migrate cleanly when JS is suspended, surfacing as
    // either "doesn't advance" (next track's play() rejected silently
    // because audio2 had no audio session) or "advances but silent"
    // (RAF doesn't fire in background → audioEl.volume stays at 0
    // forever after the start-from-0 ramp).
    //
    // Now audioEl always stays the active session-holder. The
    // preloaded URL is fed directly to audioEl.src — for blob URLs
    // (offline) this is instant (same blob, no fetch); for stream
    // URLs the browser HTTP cache may help (warmed via audio2's
    // earlier .load()). The fade still uses audio2 for the outgoing
    // track when the document is visible; in background we skip the
    // fade entirely so audioEl never sits at volume 0.
    _swapToPreloaded(fadeMs = 300) {
      if (!this.audioEl || !this.audioEl2) return false;
      if (this._preloadedFor == null || !this._preloadedUrl) return false;
      const nextIdx = this._preloadedFor;
      const nextTrackId = this.queue[nextIdx];
      if (!nextTrackId) return false;
      const nextTrack = findTrack(nextTrackId);
      if (!nextTrack) return false;

      const prefs = usePrefsStore();
      const baseVol = this.muted ? 0 : prefs.volume;
      const FADE = Math.max(50, fadeMs);
      // RAF doesn't tick when document.hidden is true (Page Visibility
      // throttles it to ~0Hz). Falling back to setInterval would also
      // be throttled. So in background we just skip the fade and hard-
      // swap volumes — the user can't see the transition anyway, only
      // hear it, and the priority is "audio keeps playing".
      const wantFade = FADE > 0
        && typeof document !== 'undefined'
        && !document.hidden;

      // Mark crossfading so _maybeCrossfade and the about-to-fire
      // 'ended' on audioEl don't double-fire next().
      this.crossfading = true;

      // Hand off blob ownership. _lastBlobUrl (current playing blob)
      // becomes the outgoing one; the preloaded blob becomes the new
      // active. The outgoing blob must stay alive while audio2 plays
      // it back during the fade, so we revoke after the fade ends.
      const preloadedUrl = this._preloadedUrl;
      const outgoingBlob = this._lastBlobUrl;
      this._lastBlobUrl = this._preloadedBlobUrl;
      this._preloadedBlobUrl = null;
      this._preloadedFor = null;
      this._preloadedUrl = null;
      if (this._preloadTimer) {
        clearTimeout(this._preloadTimer);
        this._preloadTimer = null;
      }

      // Park the outgoing track on audio2 so we can fade it out while
      // the new one ramps up. Only do this when we'll actually fade —
      // skipping in background also saves us a doomed audio2.play()
      // call that iOS often rejects without a recent user gesture.
      const outgoingSrc = this.audioEl.src;
      const outgoingTime = this.audioEl.currentTime;
      let outgoingActive = false;
      if (wantFade && outgoingSrc) {
        try {
          this.audioEl2.src = outgoingSrc;
          this.audioEl2.currentTime = outgoingTime;
          this.audioEl2.volume = baseVol;
          this.audioEl2.play().catch(() => {});
          outgoingActive = true;
        } catch {}
      } else {
        // Clear audio2's preload buffer — we just consumed it via
        // preloadedUrl, no need for it to keep its src around.
        try {
          this.audioEl2.pause();
          this.audioEl2.removeAttribute('src');
          this.audioEl2.load();
        } catch {}
      }

      // Start the new track on audioEl. audioEl keeps its audio
      // session — iOS sees a normal "swap the src of an already-
      // active element" which the OS handles gracefully even in
      // background. Volume starts at 0 only when we'll fade in;
      // otherwise jump straight to baseVol so background playback
      // is audible immediately.
      //
      // _swapInProgress muzzles the spurious `pause` event the spec
      // fires when src changes during playback — the pause listener
      // checks the flag and skips state mutation. Cleared after a
      // short delay long enough for the browser to have dispatched
      // its pause+play pair (the play listener still wins because it
      // sets state to true and re-asserts mediaSession).
      this._swapInProgress = true;
      this.audioEl.src = preloadedUrl;
      this.audioEl.volume = wantFade ? 0 : baseVol;
      this.audioEl.currentTime = 0;
      try { this.audioEl.preservesPitch = false; } catch {}
      try { this.audioEl.webkitPreservesPitch = false; } catch {}
      this.audioEl.playbackRate = this.playbackRate;
      this.audioEl.play().catch(() => { this.loading = false; });
      this.playing = true;
      // Lift the muzzle after ~800 ms — long enough that the spec's
      // src-change pause event has been queued, processed, and
      // ignored. The live audioEl.paused check in the pause handler
      // covers events delayed past this window.
      setTimeout(() => { this._swapInProgress = false; }, 800);

      this.index = nextIdx;
      // Metadata FIRST, then playbackState. Some iOS versions reset
      // the lock-screen playbackState back to default when the
      // metadata object is replaced (which would re-flip the icon to
      // "play" after we just set it to 'playing'). Pushing
      // playbackState after the metadata write keeps us as the last
      // word so the lock screen shows the pause icon (= playing).
      this._updateMediaMetadata(nextTrack);
      if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'playing'; } catch {}
      }
      this.playCountedFor = null;
      this.loading = false;

      this._swapOutgoingBlob = outgoingBlob;
      const finishSwap = (interrupted) => {
        if (this.audioEl2 && outgoingActive) {
          try {
            this.audioEl2.pause();
            this.audioEl2.removeAttribute('src');
            this.audioEl2.load();
          } catch {}
        }
        if (this._swapOutgoingBlob && this._swapOutgoingBlob !== this._lastBlobUrl) {
          try { URL.revokeObjectURL(this._swapOutgoingBlob); } catch {}
        }
        this._swapOutgoingBlob = null;
        if (!interrupted) {
          this.crossfading = false;
          this._schedulePreloadNext(800);
        }
      };

      if (!wantFade) {
        // Background path or fade disabled — cleanup synchronously,
        // no RAF, audioEl is already at full volume.
        finishSwap(false);
        this.savePlayerState();
        return true;
      }

      const startTime = performance.now();
      const fade = () => {
        // Interrupted by loadAndPlay / stop — bail without touching
        // volumes (the new caller has already taken control of audioEl).
        // Still finalize cleanup so we don't leak the outgoing blob.
        if (!this.crossfading || !this.audioEl) {
          finishSwap(true);
          return;
        }
        const t = Math.min((performance.now() - startTime) / FADE, 1);
        this.audioEl.volume = baseVol * t;
        if (this.audioEl2 && outgoingActive) this.audioEl2.volume = baseVol * (1 - t);
        if (t < 1) {
          requestAnimationFrame(fade);
        } else {
          finishSwap(false);
        }
      };
      fade();

      this.savePlayerState();
      return true;
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
      // End-of-track flicker guard: HTMLMediaElement fires `pause`
      // right before `ended` on natural completion. In iOS background
      // those two events can be separated by seconds of JS throttling
      // — if we surface the pause here, the lock-screen icon flips to
      // "play" (=paused) for the gap until ended → next() → swap
      // restores 'playing'. Skip the pause and let the ended handler
      // own the transition (it'll either advance with mediaSession
      // back to 'playing' or stop legitimately).
      if (this.audioEl) {
        const dur = this.audioEl.duration;
        const atEnd = this.audioEl.ended
          || (dur > 0 && this.audioEl.currentTime >= dur - 0.1);
        if (atEnd) return;
      }
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
      try { ms.setActionHandler('play', () => this.audioEl?.play()); } catch {}
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
    },
  },
});

export { fmtDuration };
