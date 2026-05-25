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
      } catch (e) {
        // Two ways verify can fail:
        //   1) 401 on an auth-enabled server with a bad/missing token
        //   2) Network failure (offline)
        // We can't distinguish them from the thrown Error directly, so
        // use navigator.onLine: when the browser says we're offline AND
        // we have a token, assume the token is fine and let the UI
        // proceed against cached data. The SW's NetworkFirst rule on
        // /api/auth/verify also covers brief flaps — the cached 200
        // response satisfies the try-branch even before this fallback
        // kicks in. Only when we're truly offline with no cached
        // verify hit do we land here.
        if (typeof navigator !== 'undefined' && navigator.onLine === false && this.token) {
          // Stay logged in optimistically — protected calls will 401
          // later when the network returns and api.js will clear the
          // token + fire wax:auth-expired, dropping us back to the
          // login gate. Better than wiping it now and stranding the
          // user in a "can't login because no network" loop.
          this.authEnabled = true;
        } else {
          this.authEnabled = true;
          this._saveToken(null);
        }
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
