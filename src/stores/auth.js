import { defineStore } from 'pinia';
import { api } from '@/lib/api';

const TOKEN_KEY = 'wax:auth-token';

// Single-user auth. The server decides whether the gate is active via the
// WAX_AUTH_EMAIL + WAX_AUTH_PASSWORD env vars; the client just plays
// along. /api/auth/verify always returns 200 — its `authEnabled` field
// tells us whether the server requires a token. So:
//   - server auth disabled → authEnabled=false, loggedIn=true regardless
//     (LoginGate stays hidden, full app runs unauthenticated as before)
//   - server auth enabled + no/invalid token → 401 on verify, token
//     cleared, loggedIn=false (LoginGate shows the form)
//   - server auth enabled + valid token → verify succeeds, loggedIn=true
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: null,
    authEnabled: false, // assume open until verify() proves otherwise
    checking: true,     // true while we probe /api/auth/verify on startup
  }),
  getters: {
    // If the server doesn't require auth, every user is effectively
    // logged in. Otherwise we need a token.
    loggedIn: (s) => !s.authEnabled || !!s.token,
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
      try {
        const r = await api('/api/auth/verify');
        this.authEnabled = !!r?.authEnabled;
      } catch {
        // 401 can only happen on auth-enabled servers with no/bad token.
        this.authEnabled = true;
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
      this.authEnabled = true;
    },
    logout() {
      this._saveToken(null);
    },
  },
});
