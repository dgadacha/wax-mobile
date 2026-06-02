// Multi-profile store (Netflix-style "Qui écoute ?"). Persists the active
// profile id in localStorage so the gate only shows on the very first run
// or after the user explicitly switches.
//
// The server reads `X-Wax-Profile: <id>` (or `?profile=<id>` for SSE
// endpoints which can't set headers) — see src/lib/api.js.
import { defineStore } from 'pinia';
import { api } from '@/lib/api';

const ACTIVE_KEY = 'wax:active-profile';
const PROFILES_SNAPSHOT_KEY = 'wax:profiles-snapshot';

// localStorage cache of the profiles list — without it, an offline
// boot wipes profile.profiles, needsPicker flips true, and the
// ProfileGate shows a useless empty picker that strands the user
// even though they had a valid active profile from a previous session.
function loadProfilesSnapshot() {
  try {
    const raw = localStorage.getItem(PROFILES_SNAPSHOT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data?.profiles) ? data.profiles : null;
  } catch { return null; }
}
function saveProfilesSnapshot(profiles) {
  try {
    localStorage.setItem(
      PROFILES_SNAPSHOT_KEY,
      JSON.stringify({ profiles, savedAt: Date.now() }),
    );
  } catch {}
}

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
      // Restore the profiles snapshot too so the gate has names/colors
      // to render offline. fetch() will overwrite once the network is
      // back.
      const snap = loadProfilesSnapshot();
      if (snap && this.profiles.length === 0) this.profiles = snap;
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
        saveProfilesSnapshot(this.profiles);
        // If our remembered profile no longer exists (deleted on another
        // device, fresh server, etc.), drop it so the gate shows.
        if (this.activeId && !this.profiles.find((p) => p.id === this.activeId)) {
          this.activeId = null;
          this.saveActive();
        }
      } catch (e) {
        // Offline / network failure — the snapshot loaded in
        // loadActiveFromStorage already populated this.profiles so the
        // active profile still resolves. Re-throw so the caller can
        // toast (App.vue silences when navigator.onLine === false).
        throw e;
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
