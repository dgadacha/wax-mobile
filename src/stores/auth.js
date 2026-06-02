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
      // Offline short-circuit. There's no point hitting the network
      // when we can't reach it — and trying then failing leaves the
      // user staring at a spinner that resolves into a login gate
      // they can't satisfy without internet. Trust the local token:
      // if present assume it's still valid (a 401 once we're back
      // online will fire wax:auth-expired); if absent assume the
      // server is open (best-effort; if it really has a gate the
      // first protected call will 401 and surface the LoginGate).
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) {
        this.authEnabled = !!this.token;
        this.checking = false;
        return;
      }
      try {
        const r = await api('/api/auth/verify');
        this.authEnabled = !!r?.authEnabled;
      } catch (e) {
        // Either a 401 on an auth-enabled server with a bad token, or
        // a network blip the SW cache couldn't cover. If we have a
        // token, keep it and assume offline-ish — the next protected
        // call will correct via wax:auth-expired if the token is
        // truly dead.
        if (this.token) {
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
    // Server-driven session reset. Called when api.js sees a real 401:
    // the server is enforcing auth, our token is dead. Forcing
    // authEnabled=true is important — if the SW had cached an old
    // {authEnabled:false} from before auth was turned on, our local
    // state would keep believing "no gate needed" and the LoginGate
    // would never appear despite every API call 401-ing.
    expire() {
      this.authEnabled = true;
      this._saveToken(null);
    },
    // User-initiated logout. Leaves authEnabled alone — on a no-auth
    // server, clicking logout shouldn't suddenly plaster a LoginGate
    // the user can't move past.
    logout() {
      this._saveToken(null);
    },
  },
});
