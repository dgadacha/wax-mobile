// "Découverte" recommendations for the Home "Pour toi" carousel.
//   - Deezer/YouTube mix (refresh): instant, free, no key — the cold-start
//     and fallback source.
//   - AI (refreshAI): Claude reasons over the real listening profile (top
//     artists by playCount, favourite tracks, dominant moods) and recommends
//     tracks the user doesn't own yet. Resolved on YouTube server-side.
// Both expose the result as stream-track objects registered in the streams
// store. AI results are cached in localStorage (per profile) so they survive
// a reload instead of falling back to Deezer.
import { defineStore } from 'pinia';
import { api, runAiJob } from '@/lib/api';
import { useLibraryStore } from './library';
import { useStreamsStore } from './streams';

const AI_CACHE_PREFIX = 'wax:ai-discover';
function aiCacheKey() {
  try { return `${AI_CACHE_PREFIX}:${localStorage.getItem('wax:active-profile') || 'default'}`; }
  catch { return AI_CACHE_PREFIX; }
}

export const useDiscoverStore = defineStore('discover', {
  state: () => ({
    tracks: [],       // array of stream-track objects (registered in streams store)
    loading: false,
    seedTrack: null,  // the favorite/library track used as seed (Deezer mode)
    aiActive: false,  // true when the current tracks are AI recommendations
    aiLoading: false, // true only while an AI reco job runs (vs Deezer refresh)
    aiProgress: { done: 0, total: 0 },
  }),
  actions: {
    // Map raw {id,title,uploader,duration,thumbnail} → stream entries.
    _mapStreams(raw) {
      const streams = useStreamsStore();
      return (raw || []).map((m) => {
        const streamId = `stream-${m.id}`;
        let entry = streams.get(streamId);
        if (!entry) {
          entry = {
            id: streamId,
            title: m.title,
            uploader: m.uploader || '',
            duration: m.duration,
            thumbnail: m.thumbnail,
            file: `/api/stream/${m.id}`,
            ytId: m.id,
            isStream: true,
          };
          streams.set(streamId, entry);
        }
        return entry;
      });
    },

    async refresh() {
      const lib = useLibraryStore();
      const candidates = (lib.favorites.length > 0 ? lib.favorites : lib.tracks).filter(
        (t) => !!t.ytId,
      );

      this.loading = true;
      this.tracks = [];
      this.seedTrack = null;
      this.aiActive = false;

      try {
        let rawTracks = [];
        if (candidates.length > 0) {
          const seed = candidates[Math.floor(Math.random() * candidates.length)];
          this.seedTrack = seed;
          const { tracks } = await api(`/api/mix/${seed.ytId}`);
          rawTracks = tracks || [];
        } else {
          const { tracks } = await api('/api/trending');
          rawTracks = tracks || [];
        }

        const favYtIds = new Set(lib.favorites.map((t) => t.ytId).filter(Boolean));
        const filtered = rawTracks.filter((m) => !favYtIds.has(m.id)).slice(0, 30);
        this.tracks = this._mapStreams(filtered);
      } catch (e) {
        console.error('[discover] refresh failed:', e);
        this.tracks = [];
      } finally {
        this.loading = false;
      }
    },

    // AI recommendations from the real listening profile. Throws on failure
    // (caller surfaces the toast). Caches the raw list so a reload keeps it.
    async refreshAI(onProgress) {
      this.loading = true;
      this.aiLoading = true;
      this.aiProgress = { done: 0, total: 0 };
      try {
        const { tracks } = await runAiJob('/api/ai/discover', {}, (ev) => {
          if (ev.type === 'total') this.aiProgress = { done: 0, total: ev.total };
          else if (ev.type === 'progress') {
            this.aiProgress = { done: ev.done, total: ev.total };
            if (onProgress) onProgress(ev.done, ev.total);
          }
        });
        const raw = tracks || [];
        this.tracks = this._mapStreams(raw);
        this.seedTrack = null;
        this.aiActive = true;
        try { localStorage.setItem(aiCacheKey(), JSON.stringify(raw)); } catch {}
      } finally {
        this.loading = false;
        this.aiLoading = false;
      }
    },

    // Re-hydrate AI recos from cache (called on Home mount before falling
    // back to Deezer). Returns true if it loaded something.
    loadAiCache() {
      try {
        const raw = JSON.parse(localStorage.getItem(aiCacheKey()) || 'null');
        if (Array.isArray(raw) && raw.length) {
          this.tracks = this._mapStreams(raw);
          this.aiActive = true;
          return true;
        }
      } catch {}
      return false;
    },
  },
});
