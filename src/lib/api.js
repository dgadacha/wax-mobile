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

// Variant for EventSource / image src — appends `?profile=<id>` (or `&`)
// so the server's middleware reads the right profile context.
// SSE endpoints (EventSource) can't set custom headers — append token + profile
// as query params so the server's auth middleware can validate them.
export function apiUrlWithProfile(path) {
  const url = apiUrl(path);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}profile=${encodeURIComponent(activeProfileId())}&_token=${encodeURIComponent(authToken())}`;
}

export async function api(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Wax-Profile': activeProfileId(),
      'Authorization': `Bearer ${authToken()}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}
