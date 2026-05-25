// HTTP wrapper used by every store. Errors throw with the server-provided
// message when possible.
//
// API base URL: empty in dev (Vite proxy forwards /api → backend), absolute in
// the Capacitor build (e.g. https://wax-api.nc-maiz.org). Anything that points
// at the backend (fetch, EventSource, audio.src, <img>) must go through
// `apiUrl()` so it works in both contexts.
//
// Profile header: every request carries `X-Wax-Profile: <id>` so the
// multi-profile server routes to the right user's library.json /
// playlists.json. SSE endpoints (which can't set headers) read `?profile=`
// from the URL — use `apiUrlWithProfile()` for those.
//
// Auth: when the server is running with WAX_AUTH_EMAIL + WAX_AUTH_PASSWORD,
// every non-media request must carry `Authorization: Bearer <token>`. SSE
// EventSource can't set headers either, so `apiUrlWithProfile()` also
// appends `&_token=` from the same storage key. A 401 anywhere clears the
// token + dispatches `wax:auth-expired` so the login gate re-renders.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const ACTIVE_PROFILE_KEY = 'wax:active-profile';
const AUTH_TOKEN_KEY = 'wax:auth-token';

function activeProfileId() {
  try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || 'default'; }
  catch { return 'default'; }
}

function authToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; }
  catch { return ''; }
}

export function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return API_BASE + (path.startsWith('/') ? path : '/' + path);
}

// Variant for EventSource / image src — appends `?profile=<id>` and, when
// available, `&_token=<token>` so the server's middleware can read both
// the profile context and the auth token (Authorization header can't be
// set on EventSource).
export function apiUrlWithProfile(path) {
  const url = apiUrl(path);
  const sep = url.includes('?') ? '&' : '?';
  const t = authToken();
  const tokenPart = t ? `&_token=${encodeURIComponent(t)}` : '';
  return `${url}${sep}profile=${encodeURIComponent(activeProfileId())}${tokenPart}`;
}

export async function api(path, opts = {}) {
  const t = authToken();
  const res = await fetch(apiUrl(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Wax-Profile': activeProfileId(),
      ...(t ? { Authorization: 'Bearer ' + t } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // Stale / wrong token — drop it and let the gate re-render. Skip on
    // the login endpoint itself so a wrong-password attempt doesn't wipe
    // a previously-valid token from another tab.
    if (!path.includes('/api/auth/login')) {
      try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
      try { window.dispatchEvent(new CustomEvent('wax:auth-expired')); } catch {}
    }
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}
