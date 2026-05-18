// Spotify PKCE OAuth — no server secret needed.
// CLIENT_ID is served by the backend (/api/spotify/status).
// The redirect_uri MUST be registered in your Spotify Developer app settings.

const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
const TOKEN_KEY = 'wax:spotify-token';
const REFRESH_KEY = 'wax:spotify-refresh';
const EXPIRY_KEY = 'wax:spotify-expiry';
const VERIFIER_KEY = 'wax:spotify-verifier';
const STATE_KEY = 'wax:spotify-state';

function redirectUri() {
  return window.location.origin;
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateVerifier() {
  const arr = crypto.getRandomValues(new Uint8Array(64));
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(arr).map((b) => chars[b % chars.length]).join('');
}

async function generateChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

export async function startSpotifyAuth(clientId) {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));

  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
  } catch {}

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) throw new Error('Connexion Spotify refusée');
  if (!code || !state) return false;

  let verifier, savedState;
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY);
    savedState = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch {}

  if (!verifier || state !== savedState) throw new Error('State invalide — réessaie');

  // clientId is fetched from backend during this exchange
  const statusRes = await fetch('/api/spotify/status');
  const { clientId } = await statusRes.json();
  if (!clientId) throw new Error('Spotify non configuré côté serveur');

  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || `Token exchange failed (${resp.status})`);
  }
  const data = await resp.json();
  _saveTokens(data);

  window.history.replaceState({}, '', window.location.pathname);
  return true;
}

function _saveTokens(data) {
  try {
    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + (data.expires_in - 60) * 1000));
    if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
  } catch {}
}

export async function getSpotifyAccessToken(clientId) {
  try {
    const expiry = parseInt(localStorage.getItem(EXPIRY_KEY) || '0');
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && Date.now() < expiry) return token;

    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return null;

    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    if (!resp.ok) { clearSpotifyAuth(); return null; }
    const data = await resp.json();
    _saveTokens(data);
    return data.access_token;
  } catch { return null; }
}

export function isSpotifyConnected() {
  try {
    return !!(localStorage.getItem(TOKEN_KEY) || localStorage.getItem(REFRESH_KEY));
  } catch { return false; }
}

export function clearSpotifyAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(EXPIRY_KEY);
  } catch {}
}

// Fetch all liked tracks from Spotify (paginated)
export async function fetchLikedTracks(token) {
  const tracks = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';
  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Spotify API ${resp.status}`);
    const data = await resp.json();
    for (const item of (data.items || [])) {
      const tr = item && item.track;
      if (!tr || !tr.name) continue;
      tracks.push({
        name: tr.name,
        artist: tr.artists?.[0]?.name || '',
      });
    }
    url = data.next || null;
    if (tracks.length >= 2000) break; // safety cap
  }
  return tracks;
}

// Fetch all tracks from a Spotify playlist (user-owned or followed)
export async function fetchPlaylistTracks(token, playlistId) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&fields=items(track(name,artists)),next`;
  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Spotify API ${resp.status}`);
    const data = await resp.json();
    for (const item of (data.items || [])) {
      const tr = item && item.track;
      if (!tr || !tr.name) continue;
      tracks.push({
        name: tr.name,
        artist: tr.artists?.[0]?.name || '',
      });
    }
    url = data.next || null;
  }
  return tracks;
}

// Fetch the user's playlists
export async function fetchUserPlaylists(token) {
  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Spotify API ${resp.status}`);
    const data = await resp.json();
    for (const pl of (data.items || [])) {
      if (!pl || !pl.name) continue;
      playlists.push({ id: pl.id, name: pl.name, total: pl.tracks?.total || 0 });
    }
    url = data.next || null;
  }
  return playlists;
}
