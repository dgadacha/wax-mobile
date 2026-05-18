// Multi-profile store (Netflix-style "Qui écoute ?"). Persists the active
// profile id in localStorage so the gate only shows on the very first run
// or after the user explicitly switches.
//
// The server reads `X-Wax-Profile: <id>` (or `?profile=<id>` for SSE
// endpoints which can't set headers) — see src/lib/api.js.
import { defineStore } from 'pinia';
import { api } from '@/lib/api';

const ACTIVE_KEY = 'wax:active-profile';

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profiles: [],          // [{id, name, color, createdAt}]
    activeId: null,        // string | null — null shows the gate
    pickerVisible: false,  // imperative open/close from anywhere
    loading: false,
  }),
  getters: {
    activeProfile: (s) => s.profiles.find((p) => p.id === s.activeId) || null,
    needsPicker: (s) => !s.activeId || !s.profiles.find((p) => p.id === s.activeId),
  },
  actions: {
    loadActiveFromStorage() {
      try { this.activeId = localStorage.getItem(ACTIVE_KEY) || null; } catch {}
    },
    saveActive() {
      try {
        if (this.activeId) localStorage.setItem(ACTIVE_KEY, this.activeId);
        else localStorage.removeItem(ACTIVE_KEY);
      } catch {}
    },
    async fetch() {
      this.loading = true;
      try {
        const { profiles } = await api('/api/profiles');
        this.profiles = profiles || [];
        // If our remembered profile no longer exists (deleted on another
        // device, fresh server, etc.), drop it so the gate shows.
        if (this.activeId && !this.profiles.find((p) => p.id === this.activeId)) {
          this.activeId = null;
          this.saveActive();
        }
      } finally { this.loading = false; }
    },
    pick(id) {
      const p = this.profiles.find((x) => x.id === id);
      if (!p) return;
      const switched = this.activeId !== id;
      this.activeId = id;
      this.saveActive();
      this.pickerVisible = false;
      if (switched) {
        // Switching profiles invalidates every cached store. Reloading is
        // the lazy-but-correct option — every store re-fetches against
        // the new X-Wax-Profile.
        setTimeout(() => location.reload(), 100);
      }
    },
    async create({ name, color }) {
      const { profile } = await api('/api/profiles', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      this.profiles.push(profile);
      return profile;
    },
    async rename(id, name) {
      const { profile } = await api(`/api/profiles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx !== -1) this.profiles[idx] = profile;
    },
    async remove(id) {
      await api(`/api/profiles/${id}`, { method: 'DELETE' });
      this.profiles = this.profiles.filter((p) => p.id !== id);
      if (this.activeId === id) {
        this.activeId = null;
        this.saveActive();
        this.pickerVisible = true;
      }
    },
    openPicker() { this.pickerVisible = true; },
    closePicker() { this.pickerVisible = false; },
  },
});
