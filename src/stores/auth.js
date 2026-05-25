import { defineStore } from 'pinia';
import { api } from '@/lib/api';

const TOKEN_KEY = 'wax:auth-token';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: null,
    checking: true, // true while we verify the stored token on startup
  }),
  getters: {
    loggedIn: (s) => !!s.token,
  },
  actions: {
    loadToken() {
      try { this.token = localStorage.getItem(TOKEN_KEY) || null; } catch {}
    },
    _saveToken(t) {
      this.token = t;
      try {
        if (t) localStorage.setItem(TOKEN_KEY, t);
        else localStorage.removeItem(TOKEN_KEY);
      } catch {}
    },
    async verify() {
      if (!this.token) { this.checking = false; return; }
      try {
        await api('/api/auth/verify');
      } catch {
        this._saveToken(null);
      }
      this.checking = false;
    },
    async login(email, password) {
      const { token } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      this._saveToken(token);
    },
    logout() {
      this._saveToken(null);
    },
  },
});
