// Playlists store. Maps to public/js/playlists.js minus its DOM-rendering.
import { defineStore } from 'pinia';
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { confirmModal, promptModal } from '@/lib/modal';
import { t } from '@/lib/i18n';

// Per-profile localStorage snapshot — same role as library.js's,
// guarantees the playlists card grid renders offline even if the
// SW NetworkFirst cache is cold.
const SNAPSHOT_KEY = 'wax:playlists-snapshot';
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
    return Array.isArray(data?.items) ? data.items : null;
  } catch { return null; }
}
function saveSnapshot(items) {
  try {
    localStorage.setItem(snapshotKey(), JSON.stringify({ items, savedAt: Date.now() }));
  } catch {}
}

export const usePlaylistsStore = defineStore('playlists', {
  state: () => ({
    items: [],
    loading: true,
  }),
  getters: {
    findById: (state) => (id) => state.items.find((p) => p.id === id) || null,
  },
  actions: {
    restoreSnapshot() {
      const snap = loadSnapshot();
      if (snap && this.items.length === 0) {
        this.items = snap;
        this.loading = false;
      }
    },
    persistSnapshot() {
      saveSnapshot(this.items);
    },
    async fetch() {
      try {
        const { playlists } = await api('/api/playlists');
        this.items = playlists || [];
        this.persistSnapshot();
      } catch (e) {
        const snap = loadSnapshot();
        if (snap && this.items.length === 0) this.items = snap;
        throw e;
      } finally {
        this.loading = false;
      }
    },
    // Drop a track id from every playlist locally (no fetch). Used after
    // library.remove or library.deleteTrack so the sidebar/views reflect
    // the deletion immediately without a round-trip.
    dropTrackLocally(trackId) {
      for (const pl of this.items) {
        const i = pl.trackIds.indexOf(trackId);
        if (i !== -1) pl.trackIds.splice(i, 1);
      }
    },
    async create() {
      const name = await promptModal({
        title: t('prompt.new_playlist.title'),
        placeholder: t('prompt.new_playlist.placeholder'),
        confirmLabel: t('common.create'),
      });
      if (!name) return null;
      try {
        const { playlist } = await api('/api/playlists', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        // Local mutation — push the new playlist; sidebar reacts instantly.
        this.items.push(playlist);
        showToast(t('toast.playlist_created'), 'success');
        return playlist;
      } catch (e) {
        showToast(e.message, 'error');
      }
    },
    async remove(id) {
      const pl = this.findById(id);
      if (!pl) return false;
      const ok = await confirmModal({
        title: t('confirm.delete_playlist.title', pl.name),
        message: t('confirm.delete_playlist.message', pl.name),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!ok) return false;
      try {
        await api(`/api/playlists/${id}`, { method: 'DELETE' });
        await this.fetch();
        showToast(t('toast.playlist_deleted'), 'success');
        return true;
      } catch (e) {
        showToast(e.message, 'error');
        return false;
      }
    },
    async rename(id) {
      const pl = this.findById(id);
      if (!pl) return;
      const name = await promptModal({
        title: t('prompt.rename_playlist.title'),
        defaultValue: pl.name,
        confirmLabel: t('common.rename'),
      });
      if (!name) return;
      try {
        await api(`/api/playlists/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name }),
        });
        await this.fetch();
        showToast(t('toast.playlist_renamed'), 'success');
      } catch (e) {
        showToast(e.message, 'error');
      }
    },
    // AI reorder — server returns the new track order; refetch to apply it.
    // Throws on failure (caller shows the toast).
    async reorderWithAI(id) {
      const res = await api(`/api/ai/playlists/${id}/reorder`, { method: 'POST' });
      await this.fetch();
      return res;
    },
    async addTrack(playlistId, trackId) {
      try {
        await api(`/api/playlists/${playlistId}/tracks`, {
          method: 'POST',
          body: JSON.stringify({ trackId }),
        });
        await this.fetch();
      } catch (e) {
        showToast(e.message, 'error');
      }
    },
    async addTracksBulk(playlistId, trackIds) {
      try {
        await api(`/api/playlists/${playlistId}/tracks/bulk`, {
          method: 'POST',
          body: JSON.stringify({ trackIds }),
        });
        await this.fetch();
        return true;
      } catch (e) {
        showToast(t('common.error_prefix', e.message), 'error');
        return false;
      }
    },
    async removeTrack(playlistId, trackId) {
      try {
        await api(`/api/playlists/${playlistId}/tracks/${trackId}`, {
          method: 'DELETE',
        });
        await this.fetch();
      } catch (e) {
        showToast(e.message, 'error');
      }
    },
    async reorder(playlistId, draggedId, targetId, above) {
      const pl = this.findById(playlistId);
      if (!pl) return;
      const ids = pl.trackIds.filter((id) => id !== draggedId);
      const targetIdx = ids.indexOf(targetId);
      if (targetIdx === -1) return;
      const insertAt = above ? targetIdx : targetIdx + 1;
      ids.splice(insertAt, 0, draggedId);
      pl.trackIds = ids;
      try {
        await api(`/api/playlists/${playlistId}`, {
          method: 'PUT',
          body: JSON.stringify({ trackIds: ids }),
        });
      } catch (e) {
        showToast(t('toast.reorder_error', e.message), 'error');
        this.fetch();
      }
    },
  },
});
