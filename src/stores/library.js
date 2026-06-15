// Library: tracks the user has favorited or downloaded.
import { defineStore } from 'pinia';
import { api, apiUrl, apiUrlWithProfile } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { confirmModal } from '@/lib/modal';
import { t } from '@/lib/i18n';
import { isStreamId, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { usePlayerStore } from './player';
import { usePlaylistsStore } from './playlists';
import { useStreamsStore } from './streams';

// localStorage snapshot of library tracks. Keyed per-profile so a
// profile switch doesn't show someone else's library while offline.
// We keep this in sync with the in-memory store on every mutation that
// changes the tracks list — fetch, add, remove, _setLiked, etc. — so
// a cold boot offline can restore the full library even when the
// service-worker NetworkFirst cache for /api/library got evicted.
const SNAPSHOT_KEY = 'wax:library-snapshot';
function snapshotKey() {
  let pid = 'default';
  try { pid = localStorage.getItem('wax:active-profile') || 'default'; } catch {}
  return `${SNAPSHOT_KEY}:${pid}`;
}
function loadSnapshot() {
  try {
    const raw = localStorage.getItem(snapshotKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data?.tracks) ? data.tracks : null;
  } catch { return null; }
}
function saveSnapshot(tracks) {
  try {
    localStorage.setItem(snapshotKey(), JSON.stringify({ tracks, savedAt: Date.now() }));
  } catch {}
}

export const useLibraryStore = defineStore('library', {
  state: () => ({
    tracks: [],
    loading: true,
    search: '',                 // current filter
    libraryDownloads: new Map(), // trackId -> { progress, phase }
    ytdlpStatus: { active: 0, queued: 0 },
    // Tracks deferred by the "Wi-Fi only" toggle when the device
    // was on cellular at request time. Drained on the next `online`
    // event that lands the device on Wi-Fi.
    _wifiQueue: [],
    // Client-side download pool. Each download opens a long-lived
    // EventSource for progress; browsers cap HTTP/1.1 to ~6 connections
    // per origin, so firing 50 at once would saturate the cap and 44
    // would stall PENDING (server processes them anyway, but the client
    // never sees `ready` events). The pool throttles new SSE openings
    // to MAX_PARALLEL_DOWNLOADS — surplus calls queue on _dlWaiters
    // and resolve when a slot frees up.
    _dlActive: 0,
    _dlWaiters: [], // pending Promise resolvers waiting for a slot
    // Album rescan progress driven by the server's SSE rescan events.
    // Settings UI watches this for the progress bar.
    albumRescan: { running: false, done: 0, total: 0 },
    // Real accumulated listening time (seconds) for the active profile —
    // fed by the player (content-time deltas) and shown in the Wrapped
    // hero. Server-seeded from the legacy playCount×duration estimate on
    // first access so it never starts at zero for existing users.
    listenedSeconds: 0,
  }),
  getters: {
    inLibraryByYtId: (state) => (ytId) => state.tracks.some((t) => t.ytId === ytId),
    findById: (state) => (id) => state.tracks.find((t) => t.id === id) || null,
    // Tracks the user has explicitly hearted. Treats undefined `liked` as
    // true for backward compat with rows added before the field existed.
    favorites: (state) => state.tracks.filter((t) => t.liked !== false),
    filtered(state) {
      const base = state.tracks.filter((t) => t.liked !== false);
      const q = state.search.toLowerCase();
      if (!q) return base;
      return base.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.uploader || '').toLowerCase().includes(q),
      );
    },
    // Returns every library track whose parsed artist matches the given key
    // (after normalization). Caller passes either the raw display name or
    // the normalized key — we normalize both sides before comparing.
    tracksByArtist: (state) => (artist) => {
      const key = normalizeArtistKey(artist);
      if (!key) return [];
      return state.tracks.filter((tr) => {
        const parsed = parseTrackTitle(tr);
        return normalizeArtistKey(parsed.artist) === key;
      });
    },
    // Group library tracks by `album`. Tracks without album metadata
    // (resolved later via the Deezer backfill) are excluded.
    // Map key = albumId (stable Deezer numeric ID) when present, falling
    // back to a synthetic `normalizedArtist::albumName` so an album with
    // the same name by two artists doesn't collapse into one entry.
    albums(state) {
      const map = new Map();
      for (const tr of state.tracks) {
        if (!tr.album) continue;
        const key = tr.albumId
          ? `deezer:${tr.albumId}`
          : `${normalizeArtistKey(parseTrackTitle(tr).artist)}::${tr.album}`;
        if (!map.has(key)) {
          map.set(key, {
            key,
            name: tr.album,
            artist: parseTrackTitle(tr).artist,
            albumId: tr.albumId || null,
            albumCoverUrl: tr.albumCoverUrl || null,
            releaseDate: tr.albumReleaseDate || null,
            tracks: [],
          });
        }
        map.get(key).tracks.push(tr);
      }
      return Array.from(map.values()).sort((a, b) => {
        const ad = a.releaseDate || '0';
        const bd = b.releaseDate || '0';
        if (ad !== bd) return bd.localeCompare(ad);
        return a.name.localeCompare(b.name);
      });
    },
    albumByKey: (state) => (key) => state.tracks.filter((tr) => {
      if (!tr.album) return false;
      const trackKey = tr.albumId
        ? `deezer:${tr.albumId}`
        : `${normalizeArtistKey(parseTrackTitle(tr).artist)}::${tr.album}`;
      return trackKey === key;
    }),
  },
  actions: {
    isInLibrary(track) {
      if (!track) return false;
      if (track.isStream) return this.tracks.some((t) => t.ytId === track.ytId);
      return this.tracks.some((t) => t.id === track.id);
    },
    // For the heart UI: is this track in the user's Favoris (liked!==false)?
    isFavorite(track) {
      if (!track) return false;
      const lib = track.isStream
        ? this.tracks.find((t) => t.ytId === track.ytId)
        : this.findById(track.id);
      return !!lib && lib.liked !== false;
    },
    // Hydrate from localStorage snapshot synchronously. Called before
    // fetch() at boot so the UI has SOMETHING to render even when both
    // the network AND the SW NetworkFirst cache are unavailable.
    restoreSnapshot() {
      const snap = loadSnapshot();
      if (snap && this.tracks.length === 0) {
        this.tracks = snap;
        this.loading = false;
      }
    },
    persistSnapshot() {
      saveSnapshot(this.tracks);
    },
    async fetch() {
      try {
        const { tracks } = await api('/api/library');
        this.tracks = tracks || [];
        this.persistSnapshot();
      } catch (e) {
        // Network down OR SW cache miss — try the localStorage
        // snapshot. If that's also empty (truly cold offline boot
        // without prior online run), let the empty state win.
        const snap = loadSnapshot();
        if (snap && this.tracks.length === 0) this.tracks = snap;
        // Re-throw so the caller can decide whether to surface a
        // toast (App.vue silences it when isOnline is already false).
        throw e;
      } finally {
        this.loading = false;
      }
    },
    // Pull the real accumulated listening time for this profile (seeded
    // server-side from the legacy estimate on first call). Used by Wrapped.
    async fetchStats() {
      try {
        const s = await api('/api/stats');
        if (typeof s.listenedSeconds === 'number') this.listenedSeconds = s.listenedSeconds;
      } catch {}
    },
    // Record real seconds heard (content-time). Called by the player on
    // flush. Optimistic local bump + fire-and-forget persist.
    recordListen(seconds) {
      const sec = Math.max(0, Math.round(seconds || 0));
      if (sec <= 0) return;
      this.listenedSeconds += sec;
      api('/api/stats/listen', { method: 'POST', body: JSON.stringify({ seconds: sec }) })
        .then((s) => { if (typeof s.listenedSeconds === 'number') this.listenedSeconds = s.listenedSeconds; })
        .catch(() => {});
    },
    async add(r, opts = {}) {
      const liked = opts.liked !== false; // default true: explicit favorites
      const silent = opts.silent === true;
      try {
        const data = await api('/api/library/add', {
          method: 'POST',
          body: JSON.stringify({
            ytId: r.id || r.ytId,
            title: r.title,
            uploader: r.uploader,
            duration: r.duration,
            thumbnail: r.thumbnail,
            url: r.url,
            liked,
          }),
        });
        if (!data.duplicate && data.track) {
          this.tracks.unshift(data.track);
          if (!silent) showToast(liked ? t('toast.added_to_favorites') : t('toast.added'), 'success');
        } else if (!silent) {
          showToast(t('toast.already_in_library'), 'success');
        }
        return data.track;
      } catch (e) {
        if (!silent) showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async removeByYtId(ytId) {
      const track = this.tracks.find((tr) => tr.ytId === ytId);
      if (!track) return;
      await this.remove(track.id);
    },
    async remove(trackId) {
      try {
        await api(`/api/library/${trackId}`, { method: 'DELETE' });
        const player = usePlayerStore();
        if (player.queue.includes(trackId)) {
          const wasPlaying = player.queue[player.index] === trackId;
          player.queue = player.queue.filter((qid) => qid !== trackId);
          if (wasPlaying) player.stop();
        }
        // Local mutation: drop track + clean playlist references.
        const idx = this.tracks.findIndex((t) => t.id === trackId);
        if (idx !== -1) this.tracks.splice(idx, 1);
        const playlists = usePlaylistsStore();
        playlists.dropTrackLocally(trackId);
        showToast(t('toast.removed_from_favorites'));
      } catch (e) {
        showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async deleteTrack(id) {
      const track = this.findById(id);
      const ok = await confirmModal({
        title: t('confirm.delete_track.title'),
        message: track
          ? t('confirm.delete_track.message', track.title)
          : t('confirm.delete_track.fallback'),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/library/${id}`, { method: 'DELETE' });
        const player = usePlayerStore();
        if (player.queue.includes(id)) {
          const wasPlaying = player.queue[player.index] === id;
          player.queue = player.queue.filter((qid) => qid !== id);
          if (wasPlaying) player.stop();
        }
        const idx = this.tracks.findIndex((t) => t.id === id);
        if (idx !== -1) this.tracks.splice(idx, 1);
        const playlists = usePlaylistsStore();
        playlists.dropTrackLocally(id);
        showToast(t('toast.track_deleted'), 'success');
      } catch (e) {
        showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async toggleLike(trackId) {
      const track = this.findById(trackId);
      if (!track) return;
      const newLiked = !track.liked;
      track.liked = newLiked;
      try {
        await api(`/api/library/${trackId}`, {
          method: 'PATCH',
          body: JSON.stringify({ liked: newLiked }),
        });
      } catch (e) {
        track.liked = !newLiked;
        showToast(t('toast.fav_error'), 'error');
      }
    },
    async toggleFav(track) {
      if (track.isStream) {
        const existing = this.tracks.find((t) => t.ytId === track.ytId);
        if (existing) {
          this._setLiked(existing.id, !(existing.liked !== false));
        } else {
          this._optimisticAddFavorite(track);
        }
      } else {
        this._setLiked(track.id, !(track.liked !== false));
      }
    },
    // Insert a synthetic favorite immediately so the heart UI flips on click,
    // then sync to the server. The server returns a canonical track which
    // replaces the optimistic placeholder; on failure we revert.
    async _optimisticAddFavorite(track) {
      const optimistic = {
        id: track.ytId,
        ytId: track.ytId,
        title: track.title,
        uploader: track.uploader,
        duration: track.duration,
        thumbnail: track.thumbnail,
        url: `https://www.youtube.com/watch?v=${track.ytId}`,
        liked: true,
        addedAt: Date.now(),
        _optimistic: true,
      };
      this.tracks.unshift(optimistic);
      showToast(t('toast.added_to_favorites'), 'success');
      try {
        const data = await api('/api/library/add', {
          method: 'POST',
          body: JSON.stringify({
            ytId: track.ytId,
            title: track.title,
            uploader: track.uploader,
            duration: track.duration,
            thumbnail: track.thumbnail,
            url: `https://www.youtube.com/watch?v=${track.ytId}`,
            liked: true,
          }),
        });
        // Pinia/Vue wraps state in proxies, so `t === optimistic` (raw)
        // never matches. Locate by the synthetic flag + ytId instead.
        const idx = this.tracks.findIndex((t) => t._optimistic && t.ytId === track.ytId);
        if (data.track && idx !== -1) this.tracks.splice(idx, 1, data.track);
        else if (idx !== -1) this.tracks.splice(idx, 1);
      } catch (e) {
        const idx = this.tracks.findIndex((tr) => tr._optimistic && tr.ytId === track.ytId);
        if (idx !== -1) this.tracks.splice(idx, 1);
        showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async _setLiked(trackId, liked) {
      const track = this.findById(trackId);
      if (!track) return;
      track.liked = liked;
      try {
        await api(`/api/library/${trackId}`, {
          method: 'PATCH',
          body: JSON.stringify({ liked }),
        });
      } catch (e) {
        track.liked = !liked;
        showToast(t('toast.fav_error'), 'error');
      }
    },
    // Walk every downloaded track and make sure the SW audio cache
    // actually has the MP3. Three failure modes the user can fall
    // into otherwise:
    //   - track was downloaded before the seed-fetch existed in older
    //     client builds
    //   - the post-download seed `fetch()` failed silently
    //   - iOS evicted the cache under storage pressure
    // Plus the big one: iOS Safari does NOT route <audio> fetches
    // through the Service Worker, so even when the cache IS populated
    // by the SW the audio element bypasses it and goes straight to
    // network. We solve that in player.resolvePlayUrl by reading the
    // cache via the Caches API and serving a blob: URL.
    //
    // Crucially, this function writes to the cache DIRECTLY via
    // `cache.put()` instead of relying on the SW's CacheFirst rule
    // to intercept the fetch. That's belt-and-suspenders against SW
    // interception flakiness (Workbox version quirks, iOS edge cases,
    // SW not yet activated, etc.) and makes the warmer self-contained.
    //
    // Returns `{ total, hits, fetched, failed, cacheEntries }` so
    // callers can show real feedback to the user instead of fake
    // "Préparation…" then no visible change.
    async warmOfflineCache(onProgress) {
      const result = { total: 0, hits: 0, fetched: 0, failed: 0, cacheEntries: 0 };
      if (typeof caches === 'undefined') return result;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return result;

      let cache;
      try { cache = await caches.open('wax-audio'); }
      catch (e) {
        console.warn('[warmer] caches.open failed', e);
        return result;
      }

      const downloaded = this.tracks.filter((tr) => tr.file);
      result.total = downloaded.length;

      // Check which ones are already in cache. Don't re-fetch hits.
      const missing = [];
      for (const tr of downloaded) {
        try {
          const hit = await cache.match(tr.file, { ignoreSearch: true });
          if (hit) result.hits++;
          else missing.push(tr);
        } catch {}
      }

      console.log(`[warmer] ${result.hits}/${result.total} already cached, ${missing.length} to fetch`);

      if (missing.length === 0) {
        result.cacheEntries = (await cache.keys().catch(() => [])).length;
        return result;
      }

      // GENTLE on purpose. Pre-caching MP3s on iOS Safari is the most
      // memory/storage-sensitive thing the app does: each file is ~5-12 MB,
      // and caching dozens in a burst spikes memory + Cache Storage faster
      // than WebKit reclaims it, which CRASHES the tab (white screen → the
      // SW reloads → the user's seen "Vérifier le cache" kill the app).
      // So we go nearly-sequential, breathe between files to let WebKit
      // flush/GC, and stop before the storage quota overflows (iOS crashes
      // on overflow rather than throwing).
      const POOL = 2;
      const BREATH_MS = 120; // pause after each file so WebKit can reclaim
      // Hard ceiling per click: never try to cache more than this in one
      // run, regardless of how big the offline library is. iOS Safari
      // crashes (not throws) when a burst of cache writes overwhelms it, so
      // we bound each run and let the user re-tap to continue the rest.
      const MAX_BYTES_PER_RUN = 150 * 1024 * 1024;
      let idx = 0;
      let bytesThisRun = 0;
      let stopped = false; // tripped at the byte ceiling or near the quota
      const store = this;
      let lastReport = 0;
      function report() {
        const done = result.hits + result.fetched + result.failed;
        const now = Date.now();
        if (onProgress && (now - lastReport >= 250 || done === result.total)) {
          lastReport = now;
          onProgress(done, result.total);
        }
      }
      async function storageHeadroomOk() {
        try {
          if (!navigator.storage?.estimate) return true;
          const { usage, quota } = await navigator.storage.estimate();
          if (!quota) return true;
          return usage / quota < 0.9; // keep 10% headroom
        } catch { return true; }
      }
      report();

      async function worker() {
        while (idx < missing.length && !stopped) {
          // Bail before overflowing storage — leaves the rest for a later
          // run (or for the on-play CacheFirst rule) instead of crashing.
          if (!(await storageHeadroomOk())) { stopped = true; break; }
          const i = idx++;
          // POOL workers share `idx`; the while-check + idx++ aren't atomic
          // across the awaits, so a worker can grab an index past the end
          // when fewer items remain than workers. Guard it.
          if (i >= missing.length) break;
          const tr = missing[i];
          try {
            const url = apiUrl(tr.file);
            const res = await fetch(url, { cache: 'reload' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const len = parseInt(res.headers.get('content-length') || '0', 10) || 8 * 1024 * 1024;
            // Pass `res` DIRECTLY — never `res.clone()` (cloning buffers the
            // whole MP3 in JS memory; OOM). `cache.put` streams to storage.
            await cache.put(url, res);
            result.fetched++;
            bytesThisRun += len;
            if (bytesThisRun >= MAX_BYTES_PER_RUN) stopped = true; // hit the per-run ceiling
          } catch (e) {
            console.warn('[warmer] failed for', tr.title, e?.message || e);
            result.failed++;
            // Server may have lost the file (PVC wipe, server-side
            // delete). Drop t.file locally so the UI reflects reality.
            try {
              const live = store.findById(tr.id);
              if (live && live.file) live.file = null;
            } catch {}
          }
          report();
          // Breathe: yield the event loop so WebKit can flush the cache
          // write + reclaim memory before the next big fetch.
          await new Promise((r) => setTimeout(r, BREATH_MS));
        }
      }
      await Promise.all(Array.from({ length: POOL }, () => worker()));
      // Files not reached this run (hit the per-run ceiling / storage guard)
      // — surfaced so the UI can invite a re-tap to continue.
      result.remaining = Math.max(0, missing.length - idx);
      if (stopped) console.warn(`[warmer] stopped early — ${result.remaining} left for next run`);

      result.cacheEntries = (await cache.keys().catch(() => [])).length;
      console.log('[warmer] done', result);
      return result;
    },
    async reorder(draggedId, targetId, above) {
      const ids = this.tracks.map((tr) => tr.id).filter((id) => id !== draggedId);
      const targetIdx = ids.indexOf(targetId);
      if (targetIdx === -1) return;
      const insertAt = above ? targetIdx : targetIdx + 1;
      ids.splice(insertAt, 0, draggedId);
      const byId = new Map(this.tracks.map((tr) => [tr.id, tr]));
      this.tracks = ids.map((id) => byId.get(id)).filter(Boolean);
      try {
        await api('/api/library/order', {
          method: 'PUT',
          body: JSON.stringify({ trackIds: ids }),
        });
      } catch (e) {
        showToast(t('common.error_prefix', e.message), 'error');
        this.fetch();
      }
    },
    async renameTrack(trackId, newTitle) {
      const track = this.findById(trackId);
      if (!track) return;
      const old = track.title;
      track.title = newTitle;
      try {
        await api(`/api/library/${trackId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: newTitle }),
        });
      } catch (e) {
        track.title = old;
        showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async removeDownload(trackId) {
      const track = this.findById(trackId);
      if (!track || !track.file) return;
      try {
        await api(`/api/library/${trackId}/download`, { method: 'DELETE' });
        track.file = null;
        showToast(t('toast.local_file_removed'));
      } catch (e) {
        showToast(t('common.error_prefix', e.message), 'error');
      }
    },
    async purgeOrphans() {
      const pls = usePlaylistsStore();
      const playlistTrackIds = new Set(pls.items.flatMap((pl) => pl.trackIds));
      const orphans = this.tracks.filter((tr) => tr.liked === false && !playlistTrackIds.has(tr.id));
      if (orphans.length === 0) return 0;
      for (const tr of orphans) {
        try {
          await api(`/api/library/${tr.id}`, { method: 'DELETE' });
          const idx = this.tracks.findIndex((o) => o.id === tr.id);
          if (idx !== -1) this.tracks.splice(idx, 1);
        } catch {}
      }
      return orphans.length;
    },
    // Best-effort connection check. navigator.connection is a draft
    // standard; iOS Safari < 17.5 doesn't expose it, so we treat
    // "no API" as "assume Wi-Fi" (the safer fallback — better to
    // allow a download than to block forever on a working network).
    _isOnWifi() {
      if (typeof navigator === 'undefined' || !navigator.onLine) return false;
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return true; // no API → optimistic
      if (c.type === 'wifi' || c.type === 'ethernet') return true;
      // Some browsers populate `effectiveType` ('4g'/'3g'/'2g') but
      // not `type`. effectiveType === '4g' on Wi-Fi is common, so we
      // can't 100% rule out cellular from that field alone. Treat
      // explicit 'cellular' type as the only hard fail; otherwise
      // give the benefit of the doubt.
      if (c.type === 'cellular') return false;
      return true;
    },
    // Called from App.vue on the `online` window event AND from
    // ViewSettings when the user disables the Wi-Fi-only toggle.
    // Each queued track re-enters downloadTrack; on the online-event
    // path we let downloadTrack re-check Wi-Fi (so cellular online
    // still leaves them queued), on the toggle-off path we pass
    // force=true to short-circuit the check.
    _drainWifiQueue(force = false) {
      if (this._wifiQueue.length === 0) return;
      if (!force && !this._isOnWifi()) return;
      const queue = [...this._wifiQueue];
      this._wifiQueue = [];
      for (const id of queue) {
        const m = new Map(this.libraryDownloads);
        m.delete(id); // clear the wifi-wait sentinel before re-queuing
        this.libraryDownloads = m;
        this.downloadTrack(id);
      }
    },
    // Reserve a slot in the download pool. Resolves immediately if a
    // slot is free, otherwise queues the resolver on _dlWaiters and
    // resolves it when an in-flight download finishes.
    _acquireDownloadSlot() {
      // 4 stays below the browser's 6-connections-per-origin cap with
      // headroom for the album-progress SSE + ad-hoc fetches. The
      // server-side yt-dlp semaphore is 3 so one slot is always
      // queue-warming — no idle waste.
      const MAX = 4;
      return new Promise((resolve) => {
        if (this._dlActive < MAX) {
          this._dlActive++;
          resolve();
        } else {
          this._dlWaiters.push(resolve);
        }
      });
    },
    _releaseDownloadSlot() {
      if (this._dlWaiters.length > 0) {
        // Hand the slot directly to the next waiter — _dlActive stays
        // at MAX, no transient gap that could let a race grab the slot.
        const next = this._dlWaiters.shift();
        next();
      } else {
        this._dlActive = Math.max(0, this._dlActive - 1);
      }
    },
    async downloadTrack(trackId) {
      if (this.libraryDownloads.has(trackId)) return;

      // Wi-Fi-only gate: if the user opted in and the device is on
      // cellular, defer the job until the next online + wifi event.
      // navigator.connection isn't perfectly supported on iOS Safari
      // (returns 'unknown' for type) — fall back to a presence check
      // on connection.effectiveType to detect cellular bandwidth.
      const prefs = (await import('./prefs')).usePrefsStore();
      if (prefs.downloadsWifiOnly && !this._isOnWifi()) {
        if (!this._wifiQueue.includes(trackId)) this._wifiQueue.push(trackId);
        const m0 = new Map(this.libraryDownloads);
        m0.set(trackId, { progress: 0, phase: 'wifi-wait' });
        this.libraryDownloads = m0;
        showToast(
          'En attente du Wi-Fi pour télécharger',
          'success',
        );
        return;
      }

      // Mark as queued IMMEDIATELY so the UI shows intent (progress
      // ring at 0% on every row in a bulk "Tout télécharger") instead
      // of looking inert while the pool drains the waiter queue.
      const m = new Map(this.libraryDownloads);
      m.set(trackId, { progress: 0, phase: 'queued' });
      this.libraryDownloads = m;

      await this._acquireDownloadSlot();
      try {
        // Pass the user-picked download quality so the server's
        // yt-dlp call uses the right --audio-quality. Falls back to
        // 320 server-side if the body is missing/invalid.
        const prefs = (await import('./prefs')).usePrefsStore();
        const { id: jobId } = await api(`/api/library/${trackId}/download`, {
          method: 'POST',
          body: JSON.stringify({ bitrate: prefs.downloadQuality }),
        });
        this._listenLibraryProgress(jobId, trackId);
      } catch (e) {
        const m2 = new Map(this.libraryDownloads);
        m2.delete(trackId);
        this.libraryDownloads = m2;
        showToast(t('common.error_prefix', e.message), 'error');
        this._releaseDownloadSlot();
      }
    },
    _listenLibraryProgress(jobId, trackId) {
      const url = apiUrlWithProfile(`/api/jobs/${jobId}/progress`);
      const es = new EventSource(url);
      // released flag guards against double-release if the server
      // sends a terminal event AND the SSE then errors during close.
      let released = false;
      let receivedAny = false; // true once we get at least one event
      const closeAndRelease = () => {
        if (released) return;
        released = true;
        es.close();
        this._releaseDownloadSlot();
      };
      es.onmessage = (event) => {
        receivedAny = true;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'progress') {
          const m = new Map(this.libraryDownloads);
          m.set(trackId, { progress: data.progress, phase: data.phase });
          this.libraryDownloads = m;
        } else if (data.type === 'ready') {
          const m = new Map(this.libraryDownloads);
          m.delete(trackId);
          this.libraryDownloads = m;
          // Mark the local track as offline-ready instead of full re-fetch.
          const track = this.findById(trackId);
          if (track) track.file = `/audio/${trackId}.mp3`;
          showToast(t('toast.available_offline'), 'success');
          // Seed the Service Worker cache with the freshly-downloaded
          // MP3 so it's available without network even before the user
          // plays it once. The SW's CacheFirst rule on /audio/* picks
          // up the response and stores it.
          // Fire-and-forget; failures are silent.
          fetch(apiUrl(`/audio/${trackId}.mp3`), { cache: 'reload' }).catch(() => {});
          closeAndRelease();
        } else if (data.type === 'error') {
          const m = new Map(this.libraryDownloads);
          m.delete(trackId);
          this.libraryDownloads = m;
          showToast(t('toast.dl_error', data.error), 'error');
          closeAndRelease();
        }
        if (typeof data.ytdlpActive === 'number') {
          this.ytdlpStatus = { active: data.ytdlpActive, queued: data.ytdlpQueued ?? 0 };
        }
      };
      // SSE error handling has two flavours:
      //   - CONNECTING (readyState 0): network blip — EventSource will
      //     auto-reconnect on its own. The server's /api/jobs/:id/progress
      //     handler replays job.status on reconnect (ready/error if done,
      //     fresh progress otherwise), so we just keep the row visible
      //     and let the reconnect close the loop. No cleanup needed.
      //   - CLOSED (readyState 2): HTTP error (401 stale token, 404 job
      //     gone after a server restart) — no auto-reconnect is coming.
      //     Clean up + poll the library to see if a download finished
      //     server-side despite us losing the stream.
      es.onerror = () => {
        if (released) return; // ignore the close-after-ready flap

        if (es.readyState !== EventSource.CLOSED) {
          // CONNECTING — auto-reconnect will fire. Just log and keep
          // the row + slot so the UI doesn't lie about state.
          console.warn('[download] SSE blip, auto-reconnecting', url);
          return;
        }

        const m = new Map(this.libraryDownloads);
        m.delete(trackId);
        this.libraryDownloads = m;
        console.warn('[download] SSE permanently closed', url, { receivedAny });
        if (!receivedAny) {
          // Initial connect failed outright — almost always auth or a
          // 404 from a server restart. Tell the user immediately.
          showToast(
            t('toast.dl_error', 'Connexion au téléchargement perdue'),
            'error',
          );
        }
        closeAndRelease();
        // Wait a beat for the server-side download to potentially
        // finish (yt-dlp may still be running in the background even
        // after our SSE died), refetch the library, and surface a
        // toast if the track STILL didn't materialize so the user
        // doesn't think "ça télécharge rien".
        setTimeout(async () => {
          try { await this.fetch(); } catch {}
          const tr = this.findById(trackId);
          if (!tr || !tr.file) {
            showToast(
              t('toast.dl_error', 'Le téléchargement n\'a pas abouti'),
              'error',
            );
          }
        }, 12000);
      };
    },
    // Subscribe once on app boot to the album-resolved stream. The
    // server auto-backfills missing metadata at startup + on every track
    // add; we patch the track in place when each event arrives so the
    // album column on TrackRow, the sidebar Albums entry, and ViewAlbum
    // all update without a full library refetch. Reconnects on error
    // because EventSource silently fails on macOS sleep / network blips.
    //
    // Performance: incoming album events are coalesced via
    // requestAnimationFrame. During the boot-time backfill the server
    // can fire ~50 events/sec, each of which triggers Vue reactivity
    // (lib.albums getter, sidebar mosaics, TrackRow album columns).
    // Batching them into one frame's worth of mutations cuts the
    // re-render storm to one flush per frame (~60 Hz max).
    _listenAlbumProgress() {
      if (this._albumEs) return;
      const es = new EventSource(apiUrlWithProfile('/api/album-progress'));
      this._albumEs = es;
      // On (re)connect, sync the rescan state from the server so a
      // rescan that ran while we were disconnected (Vite HMR reload,
      // macOS sleep, etc.) doesn't leave the UI thinking it's still
      // at the seed value. SSE alone misses these transitions.
      es.onopen = async () => {
        try {
          const res = await fetch(apiUrl('/api/library/rescan-albums'));
          const data = await res.json();
          if (data && (data.total || 0) > 0) {
            this.albumRescan = {
              running: !!data.running,
              done: data.done || 0,
              total: data.total || 0,
            };
          }
        } catch {}
      };
      // pendingAlbums entries are { ...payload, retries }. We keep
      // entries whose track isn't found yet — race condition: when MB
      // has a cache hit for a freshly-added track, the SSE event can
      // beat the HTTP response from /api/library/add, so the track
      // isn't in this.tracks yet at flush time. Retried up to 5x with
      // a 200ms gap (~1s total window) which more than covers any
      // realistic network ordering on localhost or LAN.
      const pendingAlbums = new Map(); // trackId -> { payload, retries }
      let flushScheduled = false;
      const flush = () => {
        flushScheduled = false;
        for (const [trackId, entry] of pendingAlbums) {
          const track = this.findById(trackId);
          if (track) {
            track.album = entry.album;
            track.albumId = entry.albumId || null;
            track.albumCoverUrl = entry.albumCoverUrl || null;
            track.albumReleaseDate = entry.albumReleaseDate || null;
            // Strip stale MB-shaped fields if they're still around.
            track.albumReleaseGroupId = null;
            track.albumReleaseId = null;
            pendingAlbums.delete(trackId);
          } else if (entry.retries < 5) {
            entry.retries++;
          } else {
            pendingAlbums.delete(trackId);
          }
        }
        // Outstanding entries → schedule another flush in 200ms so the
        // next attempt can pick up tracks added in the interim.
        if (pendingAlbums.size > 0) {
          setTimeout(scheduleFlush, 200);
        }
      };
      const scheduleFlush = () => {
        if (flushScheduled) return;
        flushScheduled = true;
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(flush);
        } else {
          setTimeout(flush, 16);
        }
      };
      es.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'album' && data.trackId) {
          pendingAlbums.set(data.trackId, { ...data, retries: 0 });
          scheduleFlush();
        } else if (data.type === 'rescan') {
          this.albumRescan = {
            running: !!data.running,
            done: data.done || 0,
            total: data.total || 0,
          };
        }
      };
      es.onerror = () => {
        es.close();
        this._albumEs = null;
        // Reconnect after 5 s; server's heartbeat keeps the stream
        // healthy in steady state, this only fires on real disconnect.
        setTimeout(() => this._listenAlbumProgress(), 5_000);
      };
    },
  },
});

// Lookup helper used by the player; checks streams too.
export function findTrackById(id) {
  const lib = useLibraryStore();
  const streams = useStreamsStore();
  return lib.findById(id) || streams.get(id) || null;
}

export { isStreamId };
