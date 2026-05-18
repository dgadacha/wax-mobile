const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const ytAgent = new https.Agent({ keepAlive: true, maxSockets: 10, maxFreeSockets: 5 });

// Allow Electron-packaged builds to point at bundled binaries via env vars.
// Falls back to the system PATH lookup, preserving old behavior.
const YT_DLP_BIN = process.env.WAX_YT_DLP || 'yt-dlp';
const FFMPEG_BIN = process.env.WAX_FFMPEG || '';
const ytdlpExtraArgs = FFMPEG_BIN ? ['--ffmpeg-location', FFMPEG_BIN] : [];

const streamUrlCache = new Map(); // videoId -> { url, expiry }
const inflightStreamUrls = new Map(); // videoId -> Promise<url>

// Bound concurrency on yt-dlp child processes — prefetch storms (10 results
// + a mix of 50) would otherwise saturate the CPU and cause 30s+ stalls.
const YTDLP_MAX_PARALLEL = 3;
let ytdlpActive = 0;
const ytdlpQueue = [];
function runYtDlp(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      ytdlpActive++;
      fn().then(resolve, reject).finally(() => {
        ytdlpActive--;
        const next = ytdlpQueue.shift();
        if (next) next();
      });
    };
    if (ytdlpActive < YTDLP_MAX_PARALLEL) task();
    else ytdlpQueue.push(task);
  });
}

function getStreamUrlViaYtDlp(videoId) {
  return runYtDlp(() => new Promise((resolve, reject) => {
    // android player client is ~2x faster (no SABR/sig dance) but only
    // exposes the combined 360p mp4 (itag 18). web is the reliable
    // fallback that exposes audio-only m4a. The combined mp4 makes
    // Chromium emit 'Unsupported pixel format: -1' for every track —
    // we silence that at the Electron layer (app.commandLine
    // disable-logging) instead of paying the speed/reliability hit of
    // a web-first ordering.
    const ytdlp = spawn(YT_DLP_BIN, [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '-g',
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=android,web',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    let out = '', err = '';
    ytdlp.stdout.on('data', d => { out += d; });
    ytdlp.stderr.on('data', d => { err += d; });
    ytdlp.on('error', reject);
    // 25 s safety net — a wedged yt-dlp would otherwise hold the
    // semaphore slot indefinitely and starve the queue.
    const killTimer = setTimeout(() => {
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('yt-dlp timeout'));
    }, 25000);
    ytdlp.on('close', code => {
      clearTimeout(killTimer);
      if (code !== 0 || !out.trim()) return reject(new Error(err.slice(-200) || 'yt-dlp failed'));
      resolve(out.trim().split('\n')[0]);
    });
  }));
}

function getStreamUrl(videoId) {
  const cached = streamUrlCache.get(videoId);
  if (cached && cached.expiry > Date.now()) return Promise.resolve(cached.url);
  const inflight = inflightStreamUrls.get(videoId);
  if (inflight) return inflight;

  const promise = (async () => {
    const url = await getStreamUrlViaYtDlp(videoId);
    streamUrlCache.set(videoId, { url, expiry: Date.now() + 5 * 3600 * 1000 });
    return url;
  })().finally(() => inflightStreamUrls.delete(videoId));

  inflightStreamUrls.set(videoId, promise);
  return promise;
}

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = process.env.WAX_PUBLIC_DIR || path.join(ROOT, 'public');
// Frontend build output. In prod (Docker / k8s), the image bakes the Vite
// build into /app/dist and we serve it at the root + SPA fallback below —
// kuro pattern. In dev, dist/ doesn't exist; the static middleware just
// no-ops and Vite serves the frontend on :5173 with its own proxy.
const FRONTEND_DIR = process.env.WAX_FRONTEND_DIR || path.join(ROOT, 'dist');
const LIBRARY_DIR = process.env.WAX_LIBRARY_DIR || path.join(ROOT, 'library');
const AUDIO_DIR = path.join(LIBRARY_DIR, 'audio');
const PREVIEW_DIR = path.join(LIBRARY_DIR, 'previews');
const COVERS_DIR = path.join(LIBRARY_DIR, 'covers');
const ARTISTS_DIR = path.join(LIBRARY_DIR, 'artists');
const ALBUMS_DIR = path.join(LIBRARY_DIR, 'albums');           // Deezer lookup JSON cache
// Per-profile storage. Each user gets their own `library.json` +
// `playlists.json` under `library/users/<profileId>/`. Audio MP3s, covers,
// artist photos and Deezer caches stay shared at the library root — they're
// keyed by ytId/artist name so there's nothing per-user about them.
const USERS_DIR = path.join(LIBRARY_DIR, 'users');
const PROFILES_FILE = path.join(LIBRARY_DIR, 'profiles.json');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });
fs.mkdirSync(ARTISTS_DIR, { recursive: true });
fs.mkdirSync(ALBUMS_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });

function sanitizeProfileId(id) {
  return String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'default';
}
function libraryFile(profileId) {
  return path.join(USERS_DIR, sanitizeProfileId(profileId), 'library.json');
}
function playlistsFile(profileId) {
  return path.join(USERS_DIR, sanitizeProfileId(profileId), 'playlists.json');
}
function ensureProfileDir(profileId) {
  const id = sanitizeProfileId(profileId);
  fs.mkdirSync(path.join(USERS_DIR, id), { recursive: true });
  if (!fs.existsSync(libraryFile(id))) fs.writeFileSync(libraryFile(id), '[]');
  if (!fs.existsSync(playlistsFile(id))) fs.writeFileSync(playlistsFile(id), '[]');
}
function listProfileIds() {
  try {
    return fs.readdirSync(USERS_DIR).filter((name) =>
      fs.existsSync(libraryFile(name)),
    );
  } catch { return []; }
}

ensureProfileDir('default');

// One-shot migration: if a legacy root `library.json` / `playlists.json`
// (from before multi-profile) still exists and the default profile is
// empty, move them into the default user's folder.
const legacyLibrary = path.join(LIBRARY_DIR, 'library.json');
const legacyPlaylists = path.join(LIBRARY_DIR, 'playlists.json');
for (const [src, dst] of [
  [legacyLibrary, libraryFile('default')],
  [legacyPlaylists, playlistsFile('default')],
]) {
  if (fs.existsSync(src)) {
    try {
      const srcContent = fs.readFileSync(src, 'utf8');
      const dstContent = fs.readFileSync(dst, 'utf8');
      if (dstContent.trim() === '[]' && srcContent.trim() !== '[]') {
        fs.writeFileSync(dst, srcContent);
        console.log('[migrate] moved legacy', path.basename(src), '→ users/default/');
      }
      fs.unlinkSync(src);
    } catch (e) { console.warn('[migrate]', e.message); }
  }
}

// Bootstrap the default profile entry if profiles.json is empty/missing.
if (!fs.existsSync(PROFILES_FILE)) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify([
    { id: 'default', name: 'Moi', color: '#7c5cff', createdAt: new Date().toISOString() },
  ], null, 2));
}

app.use(express.json({ limit: '1mb' }));

// Permissive CORS — Capacitor apps run under the capacitor:// / https://localhost
// origin and need access to every endpoint + the SSE channels.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.header('Origin') || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Wax-Profile, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ----------------------------------------------------------------
// Auth — single-user password gate.
// Credentials are read from env vars WAX_AUTH_EMAIL + WAX_AUTH_PASSWORD.
// When both are set, every /api/* request must carry a valid session
// token in the Authorization header (or ?_token= for SSE endpoints).
// ----------------------------------------------------------------
const AUTH_EMAIL = process.env.WAX_AUTH_EMAIL || '';
const AUTH_PASSWORD = process.env.WAX_AUTH_PASSWORD || '';

const authTokens = new Map(); // token -> { createdAt }
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function authEnabled() { return !!(AUTH_EMAIL && AUTH_PASSWORD); }

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isValidToken(token) {
  if (!authEnabled()) return true;
  const entry = authTokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) { authTokens.delete(token); return false; }
  return true;
}

// Login — exempt from the auth middleware below.
app.post('/api/auth/login', (req, res) => {
  if (!authEnabled()) return res.json({ token: 'disabled', ok: true });
  const { email, password } = req.body || {};
  if (!safeCompare(email, AUTH_EMAIL) || !safeCompare(password, AUTH_PASSWORD)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, { createdAt: Date.now() });
  res.json({ token, ok: true });
});

// Auth middleware — protects all /api/* routes except the login endpoint above.
app.use('/api', (req, res, next) => {
  if (!authEnabled()) return next();
  // Already handled by the route above — skip middleware check for login.
  if (req.method === 'POST' && req.path === '/auth/login') return next();
  const bearerHeader = req.header('Authorization') || '';
  const headerToken = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : '';
  const queryToken = typeof req.query._token === 'string' ? req.query._token : '';
  if (!isValidToken(headerToken || queryToken)) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
});

app.get('/api/auth/verify', (_req, res) => {
  // Reaching here means the middleware passed — token is valid.
  res.json({ ok: true });
});

// Per-request profile resolution. Header takes precedence (mobile app
// sends X-Wax-Profile); query param `profile=` is a fallback for SSE
// EventSource which can't set headers.
app.use((req, _res, next) => {
  const headerId = req.header('X-Wax-Profile');
  const queryId = typeof req.query.profile === 'string' ? req.query.profile : '';
  req.profileId = sanitizeProfileId(headerId || queryId || 'default');
  ensureProfileDir(req.profileId);
  next();
});

app.use(express.static(PUBLIC_DIR));
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1d' }));
app.use('/preview-files', express.static(PREVIEW_DIR, { maxAge: '1h' }));

// Frontend (kuro pattern: backend serves the built Vite app at the root,
// no separate static host needed). Only mounts when dist/ exists — in
// dev, Vite serves it on :5173 and this is a no-op. Heavy precaching
// (hashed JS / CSS) gets a long max-age; index.html and the PWA
// manifest must stay fresh for service-worker updates to propagate.
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, {
    maxAge: '30d',
    setHeaders: (res, filePath) => {
      const base = path.basename(filePath);
      if (base === 'index.html' || base === 'manifest.webmanifest' || base === 'sw.js' || base === 'registerSW.js') {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  console.log(`[frontend] serving ${FRONTEND_DIR} at /`);
} else {
  console.log(`[frontend] dist/ not found at ${FRONTEND_DIR} — run \`npm run build\` for prod, or use Vite dev on :5173`);
}

const YT_REGEX = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|playlist\?list=)|youtu\.be\/)[A-Za-z0-9_\-=&?%/]+/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ----------------------------------------------------------------
// Cover art pipeline.
//
// All track thumbnails — library, search, mix, trending, discover — are
// served through `/api/cover/:ytId`. The endpoint:
//   1. Returns the cached file from `library/covers/<ytId>.jpg` if it
//      exists (works fully offline once cached).
//   2. Otherwise fetches from YouTube, trying maxres → hq → mq → default,
//      caches the result on disk, and serves it.
//   3. Returns 404 if every variant fails — the client then falls back
//      to a local SVG placeholder.
//
// Tracks downloaded for offline (POST /api/library/:id/download) also
// trigger a cover fetch as a side-effect, so the cover lives on disk
// alongside the MP3 and the user can browse covers without network.
// ----------------------------------------------------------------

function coverUrl(ytId) {
  return `/api/cover/${ytId}`;
}

// Download a cover from YouTube, try variants in order, cache to disk.
// Returns the local path on success, null on failure.
function fetchCoverFromYouTube(ytId) {
  const dest = path.join(COVERS_DIR, `${ytId}.jpg`);
  return new Promise((resolve) => {
    const variants = ['maxresdefault', 'hqdefault', 'mqdefault', 'default'];
    let i = 0;
    const tryNext = () => {
      if (i >= variants.length) return resolve(null);
      const variant = variants[i++];
      const url = `https://i.ytimg.com/vi/${ytId}/${variant}.jpg`;
      https.get(url, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          return tryNext();
        }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          // YouTube returns a 120×90 grey placeholder (~3-4 KB) for
          // missing maxres variants. Reject and try the next size down.
          if (variant === 'maxresdefault' && buf.length < 5000) return tryNext();
          try {
            fs.writeFileSync(dest, buf);
            resolve(dest);
          } catch {
            resolve(null);
          }
        });
        r.on('error', () => tryNext());
      }).on('error', () => tryNext());
    };
    tryNext();
  });
}

app.get('/api/cover/:ytId', async (req, res) => {
  const ytId = req.params.ytId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(ytId)) {
    return res.status(400).end();
  }
  const localPath = path.join(COVERS_DIR, `${ytId}.jpg`);
  if (fs.existsSync(localPath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(localPath);
  }
  const cached = await fetchCoverFromYouTube(ytId);
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(cached);
  }
  // All variants failed — client falls back to its placeholder.
  res.status(404).end();
});

// ----------------------------------------------------------------
// Artist photo pipeline — `/api/artist-photo/:name`.
//
// Two-step scrape via yt-dlp:
//   1. ytsearch1:<name> → grab the top video result, read its `channel_url`
//   2. <channel_url> with --playlist-items 0 -J → channel-level JSON,
//      contains a `thumbnails` array (the avatar in multiple sizes).
// We pick the largest thumbnail, download it, cache to disk under
// `library/artists/<key>.jpg` (key = normalized lowercase alphanum,
// matches client-side normalizeArtistKey() so the same artist clusters
// under one cache file regardless of the spelling we look up).
// 404 on failure → client falls back to the gradient hero.
// ----------------------------------------------------------------

function normalizeArtistKey(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\s*[-—]\s*topic$/i, '')
    .replace(/\s*(vevo|official|music|tv|hd|records?)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

// In-flight dedupe so concurrent hits on the same artist only fire one yt-dlp.
const artistPhotoInflight = new Map(); // key -> Promise<localPath|null>

function fetchArtistPhotoFromYouTube(name) {
  return new Promise((resolve) => {
    // Step 1: search for 5 videos, look at every distinct channel that
    // produced a hit, and pick the one whose name best matches the artist
    // (via normalizeArtistKey). Cheap fan-channel / lyrics-channel filter:
    // unrelated channels score 0, exact-match scores 100, "<name> - Topic"
    // (YouTube's auto-generated official artist page) and VEVO variants
    // score high too. Without this we'd often pick the first result's
    // uploader, which is regularly some random reaction/lyrics account.
    const queryKey = normalizeArtistKey(name);
    runYtDlp(() => new Promise((r1) => {
      const ytdlp = spawn(YT_DLP_BIN, [
        '--no-warnings',
        '--skip-download',
        '--flat-playlist',
        '--print', '%(channel)s|||%(channel_url)s|||%(uploader)s|||%(uploader_url)s|||%(channel_id)s|||%(uploader_id)s',
        '--playlist-end', '5',
        `ytsearch5:${name}`,
      ]);
      let out = '', err = '';
      ytdlp.stdout.on('data', d => { out += d; });
      ytdlp.stderr.on('data', d => { err += d; });
      ytdlp.on('error', () => r1(null));
      ytdlp.on('close', code => {
        if (code !== 0) return r1(null);
        const seen = new Map(); // url -> {url, score, rank}
        const lines = out.split('\n').filter((l) => l.trim());
        lines.forEach((line, rank) => {
          const parts = line.split('|||').map((s) => (s === 'NA' ? '' : s));
          const [chName, chUrl, upName, upUrl, chId, upId] = parts;
          let url = chUrl || upUrl;
          if (!url && chId && /^UC[\w-]+$/.test(chId)) url = `https://www.youtube.com/channel/${chId}`;
          if (!url && upId && /^UC[\w-]+$/.test(upId)) url = `https://www.youtube.com/channel/${upId}`;
          if (!url) return;
          const candidateName = chName || upName || '';
          const cKey = normalizeArtistKey(candidateName);
          let score = 0;
          if (cKey && cKey === queryKey) score = 100;
          // partial match — covers "ArtistVEVO", "ArtistOfficial", etc. that
          // normalizeArtistKey already strips, so this fires only for distinct
          // suffixes still attached after normalization.
          else if (cKey && (cKey.startsWith(queryKey) || queryKey.startsWith(cKey))) score = 70;
          else if (cKey && cKey.includes(queryKey)) score = 40;
          // First search hits get a tiny rank tiebreaker.
          score += Math.max(0, 5 - rank);
          const prev = seen.get(url);
          if (!prev || prev.score < score) seen.set(url, { url, score });
        });
        const sorted = Array.from(seen.values()).sort((a, b) => b.score - a.score);
        // Demand a positive score: we'd rather 404 than serve the avatar of
        // a random reaction channel that happened to top the results.
        const winner = sorted[0];
        r1(winner && winner.score >= 40 ? winner.url : null);
      });
    })).then((channelUrl) => {
      if (!channelUrl) return resolve(null);
      // Step 2: pull the full channel JSON. The `thumbnails` array mixes
      // banner shots (wide aspect) with avatars; we filter to avatar-only
      // by preferring entries explicitly tagged `avatar_uncropped`, then
      // any square entry (width === height), and pick the largest.
      runYtDlp(() => new Promise((r2) => {
        const ytdlp = spawn(YT_DLP_BIN, [
          '--no-warnings',
          '--skip-download',
          '--playlist-items', '0',
          '-J',
          channelUrl,
        ]);
        let out = '', err = '';
        ytdlp.stdout.on('data', d => { out += d; });
        ytdlp.stderr.on('data', d => { err += d; });
        ytdlp.on('error', () => r2(null));
        ytdlp.on('close', code => {
          if (code !== 0) return r2(null);
          try {
            const data = JSON.parse(out);
            const thumbs = (data && data.thumbnails) || [];
            // Tier 1: explicit avatar entry.
            let best = thumbs.find((th) => th && th.id === 'avatar_uncropped');
            // Tier 2: largest square entry.
            if (!best) {
              const squares = thumbs.filter((th) => th && th.url && th.width && th.height && th.width === th.height);
              squares.sort((a, b) => (b.width || 0) - (a.width || 0));
              best = squares[0];
            }
            // Tier 3: anything tagged with "avatar" in id, fallback last resort.
            if (!best) {
              best = thumbs.find((th) => th && th.url && /avatar/i.test(String(th.id || '')));
            }
            r2(best && best.url ? best.url : null);
          } catch {
            r2(null);
          }
        });
      })).then((photoUrl) => {
        // Last-ditch fallback: scrape the channel page HTML for the
        // <meta property="og:image"> tag — YouTube always populates that
        // with the channel avatar, even when yt-dlp's JSON returns only
        // banner thumbnails.
        if (photoUrl) return photoUrl;
        return new Promise((r3) => {
          https.get(channelUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
            if (r.statusCode !== 200) { r.resume(); return r3(null); }
            let html = '';
            r.setEncoding('utf8');
            r.on('data', (c) => { html += c; if (html.length > 500_000) { r.destroy(); } });
            r.on('end', () => {
              const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
              r3(m ? m[1] : null);
            });
            r.on('close', () => {
              if (!html) return r3(null);
              const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
              r3(m ? m[1] : null);
            });
            r.on('error', () => r3(null));
          }).on('error', () => r3(null));
        });
      }).then((photoUrl) => {
        if (!photoUrl) return resolve(null);
        // Download the picked URL to disk.
        const dest = path.join(ARTISTS_DIR, `${normalizeArtistKey(name)}.jpg`);
        https.get(photoUrl, (r) => {
          if (r.statusCode !== 200) {
            r.resume();
            return resolve(null);
          }
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length < 500) return resolve(null); // likely a placeholder
            try {
              fs.writeFileSync(dest, buf);
              resolve(dest);
            } catch {
              resolve(null);
            }
          });
          r.on('error', () => resolve(null));
        }).on('error', () => resolve(null));
      });
    });
  });
}

app.get('/api/artist-photo/:name', async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).end();
  const key = normalizeArtistKey(name);
  if (!key) return res.status(400).end();
  const localPath = path.join(ARTISTS_DIR, `${key}.jpg`);
  if (fs.existsSync(localPath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(localPath);
  }
  // Negative cache: a `.miss` sentinel lives next to a real .jpg when the
  // last lookup failed. Spares us re-running yt-dlp on every page visit
  // for an artist YouTube genuinely doesn't have a photo for.
  const missPath = path.join(ARTISTS_DIR, `${key}.miss`);
  if (fs.existsSync(missPath)) {
    // Re-try after 24h.
    const age = Date.now() - fs.statSync(missPath).mtimeMs;
    if (age < 86400_000) return res.status(404).end();
    try { fs.unlinkSync(missPath); } catch {}
  }
  let inflight = artistPhotoInflight.get(key);
  if (!inflight) {
    inflight = fetchArtistPhotoFromYouTube(name).finally(() => {
      artistPhotoInflight.delete(key);
    });
    artistPhotoInflight.set(key, inflight);
  }
  const cached = await inflight;
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(cached);
  }
  try { fs.writeFileSync(missPath, ''); } catch {}
  res.status(404).end();
});

// ----------------------------------------------------------------
// Album metadata pipeline — `/api/album-lookup` + `/api/album-tracklist`.
//
// yt-dlp doesn't expose an `album` field for YouTube videos, so we
// resolve album info via the **Deezer Search API** — free, no auth,
// generous rate limit (~50 req/sec), and returns album name + cover
// URL + album id in a single response. The cover URL is a CDN link
// that the client can hit directly (no proxy needed).
//
// Why Deezer over MusicBrainz: MB's data is volunteer-curated and
// dramatically over-represents bootlegs / live recordings / deluxe
// editions for popular artists, which forced us into a complex
// scoring system to pick the canonical album. Deezer is a streaming
// service so its catalogue is naturally organised around canonical
// releases, and its francophone coverage (Tsew The Kid, Jok'Air,
// Josman, etc.) is materially better than MB's.
//
// We cache successful + miss responses on disk per (artist, title)
// hash so re-scans never repeat HTTP calls.
// ----------------------------------------------------------------

// Mirror of the client's parseTrackTitle (src/lib/format.js) so we can
// clean up "Artist - Song (Official Video)" titles before querying.
const SERVER_TITLE_CRUFT = /\s*[\[\(](?:slowed|reverb(?:ed)?|reverb|lyrics?|official|audio|video|hq|4k|hd|remaster(?:ed)?|m\/v|mv|live|acoustic|cover|extended|radio edit|version|sped[ -]?up|nightcore|8d|3d|bass boosted|visualizer|color(?:ed)? coded)[^)\]]*[\]\)]/gi;

function parseTrackTitle(title, uploader) {
  const raw = (title || '').trim();
  const cleaned = raw.replace(SERVER_TITLE_CRUFT, '').replace(/\s+/g, ' ').trim();
  const m = cleaned.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), song: m[2].trim() };
  return { artist: uploader || '', song: cleaned };
}

function cleanTitleForLookup(title) {
  return String(title || '')
    .replace(/\s*[\[\(](feat\.?|ft\.?|featuring|with|prod\.?\s*by)[^)\]]*[\]\)]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistForLookup(artist) {
  return String(artist || '')
    .replace(/\s+(feat\.?|ft\.?|with)\s+.*$/i, '')
    .trim();
}

function albumCacheKey(artist, title) {
  const base = `${normalizeArtistKey(artist)}|${cleanTitleForLookup(title).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

// Read package.json once for User-Agent — Deezer doesn't enforce this
// but it's polite and helps if they want to reach out about API usage.
let WAX_UA = 'Wax/1.0.0 (https://github.com/dgadacha/wax)';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  WAX_UA = `Wax/${pkg.version} (https://github.com/dgadacha/wax)`;
} catch {}

// Deezer's public API caps unauthenticated traffic at ~50 req/5s per
// IP. We self-throttle to ~8 req/sec sustained (40/5s, ~20% headroom)
// via a sliding-window queue so a 500-track boot rescan never trips
// 429 / IP block. Bursts up to 8 in flight at once; once those settle
// we wait the remainder of the 1s window before releasing the next.
const DEEZER_BURST = 8;
const DEEZER_WINDOW_MS = 1000;
let deezerActive = 0;
const deezerWindow = []; // timestamps of requests in the last second
const deezerQueue = [];
function deezerThrottle(fn) {
  return new Promise((resolve, reject) => {
    deezerQueue.push({ fn, resolve, reject });
    drainDeezer();
  });
}
function drainDeezer() {
  // Trim window to the last second.
  const now = Date.now();
  while (deezerWindow.length && now - deezerWindow[0] > DEEZER_WINDOW_MS) {
    deezerWindow.shift();
  }
  while (deezerQueue.length && deezerWindow.length < DEEZER_BURST) {
    const { fn, resolve, reject } = deezerQueue.shift();
    deezerWindow.push(Date.now());
    deezerActive++;
    fn().then(resolve, reject).finally(() => {
      deezerActive--;
      drainDeezer();
    });
  }
  if (deezerQueue.length && deezerWindow.length >= DEEZER_BURST) {
    // Schedule another drain when the oldest request leaves the window.
    const wait = DEEZER_WINDOW_MS - (now - deezerWindow[0]) + 5;
    setTimeout(drainDeezer, Math.max(50, wait));
  }
}

function deezerFetchJson(urlStr) {
  return deezerThrottle(() => new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'User-Agent': WAX_UA, 'Accept': 'application/json' } }, (r) => {
      if (r.statusCode === 429 || r.statusCode === 503) {
        // Rate-limited — treat as a transient miss, cache will retry later.
        r.resume();
        return resolve(null);
      }
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error(`Deezer HTTP ${r.statusCode}`));
      }
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { data += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  }));
}

// Deezer search → top result whose artist matches our query, then
// preference for `album.type === 'album'` over singles. Falls back
// to the broader (no field-qualified) search when the strict query
// returns nothing — covers cases where Deezer's quoted-field syntax
// is too strict (apostrophes, accents).
async function lookupAlbumOnDeezer(artist, title) {
  const cleanArtist = cleanArtistForLookup(artist);
  const cleanTitle = cleanTitleForLookup(title);
  if (!cleanArtist || !cleanTitle) return null;
  const esc = (s) => s.replace(/"/g, '\\"');
  const queryKey = normalizeArtistKey(cleanArtist);

  const tryQuery = async (q) => {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`;
    const data = await deezerFetchJson(url).catch(() => null);
    if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
    // Filter to results whose primary artist normalizes to our query
    // artist — drops karaoke/cover/lookalike-title hits.
    const matched = data.data.filter((r) => {
      const aKey = normalizeArtistKey(r.artist?.name || '');
      return aKey && (aKey === queryKey || aKey.includes(queryKey) || queryKey.includes(aKey));
    });
    if (matched.length === 0) return null;
    // Prefer album-type albums over singles, then by Deezer's own rank
    // (which roughly correlates with the canonical version).
    matched.sort((a, b) => {
      const aIsAlbum = (a.album?.type === 'album') ? 1 : 0;
      const bIsAlbum = (b.album?.type === 'album') ? 1 : 0;
      if (aIsAlbum !== bIsAlbum) return bIsAlbum - aIsAlbum;
      return (b.rank || 0) - (a.rank || 0);
    });
    return matched[0];
  };

  // Strict field-qualified query first; falls through to a broad
  // free-text search if the strict one returns nothing.
  const strictQ = `artist:"${esc(cleanArtist)}" track:"${esc(cleanTitle)}"`;
  const broadQ = `${cleanArtist} ${cleanTitle}`;
  const top = (await tryQuery(strictQ)) || (await tryQuery(broadQ));
  if (!top) return null;
  return {
    album: top.album?.title || '',
    albumId: top.album?.id || null,
    albumCoverUrl: top.album?.cover_xl || top.album?.cover_big || top.album?.cover_medium || null,
    albumReleaseDate: null, // Deezer search doesn't include release_date; tracklist endpoint will.
    artist: top.artist?.name || cleanArtist,
  };
}

const albumLookupInflight = new Map(); // cacheKey -> Promise

async function resolveAlbum(artist, title) {
  if (!artist || !title) return null;
  const key = albumCacheKey(artist, title);
  const cachePath = path.join(ALBUMS_DIR, `${key}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      // .miss === true → re-try after 7 days; otherwise treat as authoritative.
      if (cached.miss) {
        const age = Date.now() - (cached.cachedAt || 0);
        if (age < 7 * 86400_000) return null;
      } else if (cached.albumId) {
        // Only treat as a hit if the cache is in the new Deezer-shaped
        // schema. Old MB-shaped entries get re-resolved.
        return cached;
      }
    } catch {}
  }
  let inflight = albumLookupInflight.get(key);
  if (!inflight) {
    inflight = (async () => {
      const result = await lookupAlbumOnDeezer(artist, title);
      const payload = result ? { ...result, cachedAt: Date.now() } : { miss: true, cachedAt: Date.now() };
      try { fs.writeFileSync(cachePath, JSON.stringify(payload)); } catch {}
      return result;
    })().finally(() => albumLookupInflight.delete(key));
    albumLookupInflight.set(key, inflight);
  }
  return inflight;
}

app.get('/api/album-lookup', async (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const title = String(req.query.title || '').trim();
  if (!artist || !title) return res.status(400).json({ error: 'artist + title required' });
  try {
    const album = await resolveAlbum(artist, title);
    if (!album) return res.status(404).json({ error: 'No album match' });
    res.json(album);
  } catch (e) {
    res.status(500).json({ error: e.message || 'lookup failed' });
  }
});

// Album tracklist — given a Deezer album id, return the full ordered
// track list of that album. The client uses this on ViewAlbum to render
// every track of the album (library matches + missing entries that
// resolve to YouTube on play).
const albumTracklistCache = new Map(); // albumId -> Promise<{tracks, releaseDate}|null>

async function fetchAlbumTracklist(albumId) {
  // /album/:id returns full album metadata including a `tracks.data`
  // array with track_position, title, duration in the canonical order.
  const url = `https://api.deezer.com/album/${encodeURIComponent(albumId)}`;
  const data = await deezerFetchJson(url).catch(() => null);
  if (!data || !Array.isArray(data.tracks?.data)) return null;
  const tracks = data.tracks.data.map((tr, i) => ({
    position: tr.track_position || i + 1,
    title: tr.title || tr.title_short || '',
    length: tr.duration ? tr.duration * 1000 : null, // ms for parity with the previous MB shape
    recordingId: String(tr.id || ''),
  }));
  return { tracks, releaseDate: data.release_date || null };
}

app.get('/api/album-tracklist', async (req, res) => {
  const albumId = String(req.query.albumId || req.query.releaseId || '').trim();
  if (!albumId) return res.status(400).json({ error: 'albumId required' });
  let inflight = albumTracklistCache.get(albumId);
  if (!inflight) {
    inflight = fetchAlbumTracklist(albumId);
    albumTracklistCache.set(albumId, inflight);
  }
  try {
    const result = await inflight;
    if (!result) return res.status(404).json({ error: 'Tracklist not available' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || 'lookup failed' });
  }
});

// All four take a profileId. Endpoints pass `req.profileId`; background
// timers (scheduleAlbumBackfill / autoBackfillOnStartup) iterate
// `listProfileIds()` so every user's library gets backfilled.
const getLibrary = (profileId) => readJson(libraryFile(profileId)).map(t => ({
  ...t,
  // Funnel every thumbnail through the local cover endpoint — works offline
  // once cached, gives us a single fallback path. Tracks without a ytId
  // (rare, defensive) keep their stored URL as-is.
  thumbnail: t.ytId ? coverUrl(t.ytId) : t.thumbnail,
}));
const saveLibrary = (profileId, lib) => writeJson(libraryFile(profileId), lib);
const getPlaylists = (profileId) => readJson(playlistsFile(profileId));
const savePlaylists = (profileId, pls) => writeJson(playlistsFile(profileId), pls);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

app.get('/api/mix/:videoId', (req, res) => {
  const id = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(id)) return res.status(400).json({ error: 'ID invalide' });

  // YouTube refuses to serve RD<id> via /playlist?list=... ("unviewable").
  // The /watch?v=...&list=RD... form is still accepted by yt-dlp.
  const mixUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
  const ytdlp = spawn(YT_DLP_BIN, [
    '--flat-playlist',
    '--skip-download',
    '--print', '%(id)s|||%(title)s|||%(uploader)s|||%(duration)s',
    '--no-warnings',
    '--playlist-end', '50',
    mixUrl,
  ]);
  let out = '', err = '';
  ytdlp.stdout.on('data', d => { out += d; });
  ytdlp.stderr.on('data', d => { err += d; });
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp indisponible' }); });
  ytdlp.on('close', code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: 'Mix indisponible', details: err.slice(-200) });
    const tracks = out.split('\n').filter(l => l.trim()).map(line => {
      const [vid, title, uploader, duration] = line.split('|||');
      return {
        id: vid,
        title: title || 'Sans titre',
        uploader: uploader === 'NA' ? '' : (uploader || ''),
        duration: parseFloat(duration) || 0,
        url: `https://www.youtube.com/watch?v=${vid}`,
        thumbnail: coverUrl(vid),
      };
    });
    res.json({ tracks });
  });
});

app.get('/api/lyrics', (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const title = String(req.query.title || '').trim();
  if (!artist || !title) return res.status(400).json({ error: 'artist + title required' });

  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let data = '';
    r.on('data', chunk => { data += chunk; });
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.lyrics && json.lyrics.trim()) {
          res.json({ lyrics: json.lyrics, artist, title });
        } else {
          res.status(404).json({ error: 'Lyrics not found' });
        }
      } catch {
        res.status(404).json({ error: 'Paroles introuvables' });
      }
    });
  }).on('error', () => res.status(500).json({ error: 'Network error' }));
});

app.get('/api/info', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!YT_REGEX.test(url)) return res.status(400).json({ error: 'URL invalide' });
  try {
    const data = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    // Extract the ytId from the URL or oembed thumbnail so the client hits
    // our local /api/cover endpoint instead of YouTube's CDN directly.
    const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})|shorts\/([A-Za-z0-9_-]{11})/);
    const ytId = m ? (m[1] || m[2] || m[3]) : null;
    res.json({
      title: data.title,
      author: data.author_name,
      thumbnail: ytId ? coverUrl(ytId) : data.thumbnail_url,
      isPlaylist: /[?&]list=/.test(url) && !/[?&]v=/.test(url),
    });
  } catch (e) {
    const isPlaylist = /[?&]list=/.test(url) && !/[?&]v=/.test(url);
    if (isPlaylist) return res.json({ isPlaylist: true });
    res.status(500).json({ error: 'oEmbed indisponible', details: e.message });
  }
});

app.post('/api/stream/:videoId/prefetch', async (req, res) => {
  const id = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(id)) return res.status(400).json({ error: 'ID invalide' });
  try {
    await getStreamUrl(id);
    res.json({ ok: true, cached: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed' });
  }
});

app.get('/api/stream/:videoId', async (req, res) => {
  const id = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(id)) return res.status(400).end();

  let aborted = false;
  let upstream = null;
  req.on('close', () => { aborted = true; if (upstream) upstream.destroy(); });

  let audioUrl;
  try {
    audioUrl = await getStreamUrl(id);
  } catch {
    if (!res.headersSent) res.status(500).end();
    return;
  }
  if (aborted) return;

  const opts = { agent: ytAgent, headers: { 'User-Agent': 'Mozilla/5.0' } };
  if (req.headers.range) opts.headers['Range'] = req.headers.range;

  upstream = https.get(audioUrl, opts, (audioRes) => {
    if (aborted) { audioRes.destroy(); return; }
    res.statusCode = audioRes.statusCode;
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (audioRes.headers[h]) res.setHeader(h, audioRes.headers[h]);
    });
    audioRes.pipe(res);
    req.on('close', () => audioRes.destroy());
  });
  upstream.on('error', () => {
    // URL might have expired, invalidate cache
    streamUrlCache.delete(id);
    if (!res.headersSent) res.status(500).end();
  });
});

app.get('/api/preview/:videoId', (req, res) => {
  const id = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{6,15}$/.test(id)) return res.status(400).json({ error: 'ID invalide' });

  const previewFile = path.join(PREVIEW_DIR, `${id}.mp3`);
  const publicUrl = `/preview-files/${id}.mp3`;

  if (fs.existsSync(previewFile)) {
    return res.json({ url: publicUrl });
  }

  const outTemplate = path.join(PREVIEW_DIR, `${id}.%(ext)s`);
  const ytdlp = spawn(YT_DLP_BIN, [
    ...ytdlpExtraArgs,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '5',
    '--download-sections', '*0:00-0:12',
    '--no-playlist',
    '--no-warnings',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  let stderr = '';
  ytdlp.stderr.on('data', (d) => { stderr += d; });
  ytdlp.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp indisponible' });
  });
  const timeout = setTimeout(() => {
    try { ytdlp.kill('SIGKILL'); } catch {}
    if (!res.headersSent) res.status(504).json({ error: 'Timeout aperçu' });
  }, 25000);
  ytdlp.on('close', (code) => {
    clearTimeout(timeout);
    if (res.headersSent) return;
    if (code !== 0 || !fs.existsSync(previewFile)) {
      return res.status(500).json({ error: 'Aperçu indisponible', details: stderr.slice(-200) });
    }
    res.json({ url: publicUrl });
  });
});

app.get('/api/trending', (req, res) => {
  // YouTube's official "Today's Top Hits"-style auto-curated playlist.
  // RDCLAK5... ids are stable Mix radios maintained by YouTube.
  const TRENDING_PLAYLIST = 'https://www.youtube.com/playlist?list=RDCLAK5uy_ly6s4irLuZAcjEDwJmqcA_UtSipMyGgbQ';
  const ytdlp = spawn(YT_DLP_BIN, [
    TRENDING_PLAYLIST,
    '--flat-playlist',
    '--skip-download',
    '--print', '%(id)s|||%(title)s|||%(uploader)s|||%(duration)s',
    '--no-warnings',
    '--playlist-end', '30',
  ]);
  let out = '', err = '';
  ytdlp.stdout.on('data', d => { out += d; });
  ytdlp.stderr.on('data', d => { err += d; });
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp indisponible' }); });
  ytdlp.on('close', code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: 'Trending échoué', details: err.slice(-200) });
    const tracks = out.split('\n').filter(l => l.trim()).map(line => {
      const [id, title, uploader, duration] = line.split('|||');
      return {
        id,
        title: title || 'Sans titre',
        uploader: uploader === 'NA' ? '' : (uploader || ''),
        duration: parseFloat(duration) || 0,
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail: coverUrl(id),
      };
    });
    res.json({ tracks });
  });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  if (q.length > 200) return res.status(400).json({ error: 'Requête trop longue' });

  const ytdlp = spawn(YT_DLP_BIN, [
    `ytsearch10:${q}`,
    '--flat-playlist',
    '--skip-download',
    '--print', '%(id)s|||%(title)s|||%(uploader)s|||%(duration)s',
    '--no-warnings',
  ]);
  let out = '', err = '';
  ytdlp.stdout.on('data', d => { out += d; });
  ytdlp.stderr.on('data', d => { err += d; });
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp indisponible' }); });
  ytdlp.on('close', code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: 'Recherche échouée', details: err.slice(-200) });
    const results = out.split('\n').filter(l => l.trim()).map(line => {
      const [id, title, uploader, duration] = line.split('|||');
      return {
        id,
        title: title || 'Sans titre',
        uploader: uploader === 'NA' ? '' : (uploader || ''),
        duration: parseFloat(duration) || 0,
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail: coverUrl(id),
      };
    });
    res.json({ results });
  });
});

app.get('/api/playlist-info', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!YT_REGEX.test(url)) return res.status(400).json({ error: 'URL invalide' });

  const ytdlp = spawn(YT_DLP_BIN, [
    '--flat-playlist',
    '--skip-download',
    '--print', '%(id)s|||%(title)s|||%(uploader)s|||%(duration)s',
    '--no-warnings',
    url,
  ]);
  let out = '', err = '';
  ytdlp.stdout.on('data', d => { out += d; });
  ytdlp.stderr.on('data', d => { err += d; });
  ytdlp.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp indisponible' }); });
  ytdlp.on('close', code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: 'Énumération échouée', details: err.slice(-300) });
    const items = out.split('\n').filter(l => l.trim()).map(line => {
      const [id, title, uploader, duration] = line.split('|||');
      return {
        id,
        title: title || 'Sans titre',
        uploader: uploader === 'NA' ? '' : (uploader || ''),
        duration: parseFloat(duration) || 0,
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail: coverUrl(id),
      };
    });
    res.json({ tracks: items });
  });
});

const jobs = new Map();

function broadcast(job, payload) {
  const enriched = { ...payload, ytdlpActive, ytdlpQueued: ytdlpQueue.length };
  const data = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const listener of job.listeners) {
    try { listener.write(data); } catch {}
  }
  if (payload.type === 'ready' || payload.type === 'error') {
    for (const listener of job.listeners) {
      try { listener.end(); } catch {}
    }
    job.listeners.clear();
  }
}

function startJob(job) {
  const expectedFile = path.join(AUDIO_DIR, `${job.trackId}.mp3`);
  const infoJsonFile = path.join(AUDIO_DIR, `${job.trackId}.info.json`);
  const outputTemplate = path.join(AUDIO_DIR, `${job.trackId}.%(ext)s`);

  if (!job.updateExisting) {
    const lib = getLibrary(req.profileId);
    if (lib.some(t => t.url === job.url && t.file)) {
      const existing = lib.find(t => t.url === job.url && t.file);
      job.status = 'ready';
      job.progress = 100;
      job.track = existing;
      setTimeout(() => broadcast(job, { type: 'ready', track: existing, duplicate: true }), 50);
      return;
    }
  }

  const args = [
    ...ytdlpExtraArgs,
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', `${job.bitrate}K`,
    '--no-playlist',
    '--newline',
    '--write-info-json',
    '--no-warnings',
    '-o', outputTemplate,
    job.url,
  ];

  const ytdlp = spawn(YT_DLP_BIN, args);
  job.status = 'downloading';
  job.phase = 'download';
  let stderr = '';

  ytdlp.stdout.on('data', (data) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) {
        const pct = parseFloat(m[1]);
        if (!isNaN(pct)) {
          job.progress = pct;
          broadcast(job, { type: 'progress', progress: pct, phase: 'download' });
        }
      } else if (line.startsWith('[ExtractAudio]') || line.startsWith('[ffmpeg]')) {
        if (job.phase !== 'converting') {
          job.phase = 'converting';
          broadcast(job, { type: 'progress', progress: 100, phase: 'converting' });
        }
      }
    }
  });

  ytdlp.stderr.on('data', (d) => { stderr += d; });

  ytdlp.on('error', (err) => {
    job.status = 'error';
    job.error = err.message;
    broadcast(job, { type: 'error', error: err.message });
  });

  ytdlp.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(expectedFile)) {
      job.status = 'error';
      job.error = stderr.split('\n').filter(l => l.trim()).slice(-3).join(' | ').slice(0, 500) || 'Unknown error';
      broadcast(job, { type: 'error', error: job.error });
      try { fs.unlinkSync(expectedFile); } catch {}
      try { fs.unlinkSync(infoJsonFile); } catch {}
      return;
    }

    let info = {};
    try { info = JSON.parse(fs.readFileSync(infoJsonFile, 'utf8')); } catch {}

    let track;
    const currentLib = getLibrary(req.profileId);
    if (job.updateExisting) {
      track = currentLib.find(t => t.id === job.trackId);
      if (track) {
        track.file = `/audio/${job.trackId}.mp3`;
        if (!track.duration && info.duration) track.duration = info.duration;
        saveLibrary(req.profileId, currentLib);
      }
    } else {
      const safeTitle = String(info.title || 'Sans titre').replace(/[\/\\:*?"<>|]/g, '').slice(0, 200);
      track = {
        id: job.trackId,
        title: safeTitle,
        uploader: info.uploader || info.channel || '',
        duration: info.duration || 0,
        // Store the local cover URL when we know the ytId (works offline,
        // single fallback path). Falls back to whatever yt-dlp returned
        // (usually a YouTube CDN URL) when no id is available.
        thumbnail: info.id ? coverUrl(info.id) : (info.thumbnail || ''),
        ytId: info.id || '',
        url: info.webpage_url || job.url,
        bitrate: job.bitrate,
        file: `/audio/${job.trackId}.mp3`,
        addedAt: Date.now(),
      };
      currentLib.unshift(track);
      saveLibrary(req.profileId, currentLib);
    }

    try { fs.unlinkSync(infoJsonFile); } catch {}

    // Side-effect: pre-cache the cover so the downloaded track has its
    // artwork available offline alongside the MP3. Fire-and-forget — the
    // download is already "ready" without waiting on the cover.
    if (track.ytId) fetchCoverFromYouTube(track.ytId).catch(() => {});

    job.status = 'ready';
    job.progress = 100;
    job.phase = 'done';
    job.track = track;
    broadcast(job, { type: 'ready', track });
  });
}

app.post('/api/jobs', (req, res) => {
  const { url, quality } = req.body || {};
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl || !YT_REGEX.test(cleanUrl)) return res.status(400).json({ error: 'URL invalide' });
  const bitrate = ['128', '192', '320'].includes(String(quality)) ? String(quality) : '192';

  const id = crypto.randomBytes(8).toString('hex');
  const trackId = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    trackId,
    url: cleanUrl,
    bitrate,
    progress: 0,
    phase: 'starting',
    status: 'pending',
    track: null,
    error: null,
    listeners: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  setImmediate(() => startJob(job));
  res.json({ id, trackId });
});

app.get('/api/jobs/:id/progress', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (job.status === 'ready') {
    res.write(`data: ${JSON.stringify({ type: 'ready', track: job.track })}\n\n`);
    return res.end();
  }
  if (job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', error: job.error })}\n\n`);
    return res.end();
  }

  res.write(`data: ${JSON.stringify({ type: 'progress', progress: job.progress, phase: job.phase })}\n\n`);
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

app.get('/api/library', (req, res) => {
  res.json({ tracks: getLibrary(req.profileId) });
});

// -------------------------------------------------------------
// Backup / restore — full export + import of library + playlists.
// Audio files (library/audio/*.mp3) are NOT included; the user can
// copy that folder separately. On import, every track keeps its `file`
// path: if the corresponding MP3 isn't present, the player falls back
// to streaming and the user can re-download on demand.
// -------------------------------------------------------------
app.get('/api/export', (req, res) => {
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    library: readJson(libraryFile(req.profileId)),
    playlists: getPlaylists(req.profileId),
  });
});

// Import accepts a payload up to 32 MB so very large libraries fit in
// JSON form. We don't pipe through `app.use(express.json)` because that
// caps at 1 MB; use a per-route override instead.
app.post('/api/import', express.json({ limit: '32mb' }), (req, res) => {
  const { version, library, playlists } = req.body || {};
  if (version !== 1) return res.status(400).json({ error: 'Unsupported export version' });
  if (!Array.isArray(library) || !Array.isArray(playlists)) {
    return res.status(400).json({ error: 'Invalid payload shape' });
  }
  // Validate basic shape — every entry must at least have an id + title for
  // tracks, and id + name + trackIds[] for playlists.
  for (const t of library) {
    if (!t || typeof t !== 'object' || !t.id || !t.title) {
      return res.status(400).json({ error: 'Invalid track entry' });
    }
  }
  for (const p of playlists) {
    if (!p || typeof p !== 'object' || !p.id || typeof p.name !== 'string' || !Array.isArray(p.trackIds)) {
      return res.status(400).json({ error: 'Invalid playlist entry' });
    }
  }
  saveLibrary(req.profileId, library);
  savePlaylists(req.profileId, playlists);
  res.json({ ok: true, tracks: library.length, playlists: playlists.length });
});

// Factory reset: empties library.json + playlists.json and deletes every
// file in the audio + preview directories. Client-side prefs (theme,
// locale, EQ, crossfade, volume) live in localStorage and are NOT touched
// — those are UI settings, not data.
app.post('/api/wipe', (req, res) => {
  try {
    const removed = { audio: 0, previews: 0, covers: 0 };
    saveLibrary(req.profileId, []);
    savePlaylists(req.profileId, []);
    for (const [dir, key] of [[AUDIO_DIR, 'audio'], [PREVIEW_DIR, 'previews'], [COVERS_DIR, 'covers']]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, file));
          removed[key]++;
        } catch {}
      }
    }
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/library/add', (req, res) => {
  const { ytId, title, uploader, duration, thumbnail, url, liked } = req.body || {};
  if (!ytId || !title) return res.status(400).json({ error: 'ytId + title required' });
  const lib = getLibrary(req.profileId);
  const existing = lib.find(t => t.ytId === ytId);
  if (existing) return res.json({ track: existing, duplicate: true });
  const id = crypto.randomBytes(6).toString('hex');
  const track = {
    id,
    title: String(title).slice(0, 200),
    uploader: uploader || '',
    duration: parseFloat(duration) || 0,
    thumbnail: thumbnail || coverUrl(ytId),
    ytId,
    url: url || `https://www.youtube.com/watch?v=${ytId}`,
    file: null,
    liked: typeof liked === 'boolean' ? liked : true,
    addedAt: Date.now(),
  };
  lib.unshift(track);
  saveLibrary(req.profileId, lib);
  res.json({ track });
  // Fire-and-forget: resolve the album for the new track in this user's
  // library, plus give every other pending track (across every profile)
  // another shot — cache hits short-circuit, so this is cheap.
  scheduleAlbumBackfill(req.profileId, track);
  scheduleAutoBackfill();
});

// SSE listeners for live album-resolved events. The client subscribes
// to `/api/album-progress` once on mount; when a backfill resolves an
// album, every connected client gets a `{type:'album', trackId, album,
// albumId, albumCoverUrl, albumReleaseDate}` event and patches its
// local state without a full library refetch.
const albumSseClients = new Set();
function broadcastAlbumEvent(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of albumSseClients) {
    try { client.write(line); } catch {}
  }
}

// Backfill helpers — run an album lookup, write the result back into
// library.json + broadcast over SSE. Tolerant of races: re-reads the
// library on success, finds the track by id, and only persists if it's
// still there. `onComplete` fires after every attempt (hit or miss) so
// the rescan endpoint can drive a progress bar.
//
// Skip-write optimization: when the lookup result matches what's
// already on the track (cache-hit case where we re-process tracks
// during a debounced rescan), we don't re-write library.json or
// broadcast — saves disk I/O + saves the client from no-op patches.
function scheduleAlbumBackfill(profileId, track, onComplete) {
  const parsed = parseTrackTitle(track.title, track.uploader);
  if (!parsed.artist || !parsed.song) {
    if (onComplete) onComplete();
    return;
  }
  resolveAlbum(parsed.artist, parsed.song)
    .then((album) => {
      if (album) {
        const fresh = readJson(libraryFile(profileId));
        const idx = fresh.findIndex((t) => t.id === track.id);
        if (idx !== -1) {
          const cur = fresh[idx];
          const newId = album.albumId || null;
          const newCover = album.albumCoverUrl || null;
          const newDate = album.albumReleaseDate || null;
          const unchanged =
            cur.album === album.album &&
            (cur.albumId || null) === newId &&
            (cur.albumCoverUrl || null) === newCover &&
            (cur.albumReleaseDate || null) === newDate;
          if (!unchanged) {
            cur.album = album.album;
            cur.albumId = newId;
            cur.albumCoverUrl = newCover;
            cur.albumReleaseDate = newDate;
            delete cur.albumReleaseGroupId;
            delete cur.albumReleaseId;
            saveLibrary(profileId, fresh);
            broadcastAlbumEvent({
              type: 'album',
              profileId,
              trackId: track.id,
              album: album.album,
              albumId: newId,
              albumCoverUrl: newCover,
              albumReleaseDate: newDate,
            });
          }
        }
      }
      if (onComplete) onComplete();
    })
    .catch(() => { if (onComplete) onComplete(); });
}

// Trailing-edge debounce around autoBackfillOnStartup so multiple
// engagement events in the same window (e.g. a bulk drag-drop of 20
// tracks into a playlist) coalesce into one library walk instead of
// firing 20 of them.
let backfillDebounceTimer = null;
function scheduleAutoBackfill() {
  if (backfillDebounceTimer) return; // a tick is already queued
  backfillDebounceTimer = setTimeout(() => {
    backfillDebounceTimer = null;
    autoBackfillOnStartup();
  }, 2000);
}

// SSE endpoint — clients subscribe once on app mount and stay connected
// for the lifetime of the page. We send a comment-only heartbeat every
// 25 s so middleboxes don't kill idle connections.
app.get('/api/album-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  albumSseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch {}
  }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    albumSseClients.delete(res);
  });
});

// Manual rescan — same logic as autoBackfillOnStartup but driven from
// the UI. Tracks progress in-process and broadcasts `{type:'rescan',
// done, total}` SSE events after each lookup completes (hit or miss)
// so the Settings UI can render a real progress bar. Idempotent: a
// POST while another rescan is running just returns the live state.
let albumRescanState = { running: false, done: 0, total: 0 };

app.get('/api/library/rescan-albums', (req, res) => {
  res.json(albumRescanState);
});

app.post('/api/library/rescan-albums', (req, res) => {
  if (albumRescanState.running) return res.json(albumRescanState);
  const lib = readJson(libraryFile(req.profileId));
  const targets = lib.filter((t) => !t.album || !t.albumId);
  albumRescanState = { running: true, done: 0, total: targets.length };
  res.json(albumRescanState);
  if (targets.length === 0) {
    albumRescanState.running = false;
    broadcastAlbumEvent({ type: 'rescan', done: 0, total: 0, running: false });
    return;
  }
  const profileId = req.profileId;
  setImmediate(() => {
    for (const track of targets) {
      scheduleAlbumBackfill(profileId, track, () => {
        albumRescanState.done++;
        const finished = albumRescanState.done >= albumRescanState.total;
        if (finished) albumRescanState.running = false;
        broadcastAlbumEvent({
          type: 'rescan',
          done: albumRescanState.done,
          total: albumRescanState.total,
          running: !finished,
        });
      });
    }
    console.log(`[album] rescan queued ${targets.length} track(s) for profile=${profileId}`);
  });
});

// Auto-backfill at startup — schedule a lookup for every library track
// that's either missing the `album` field outright OR has an album but
// no `albumId` (older entries written before the Deezer migration;
// without an albumId, ViewAlbum can't fetch the tracklist). Runs in
// the background, fully non-blocking. Idempotent: tracks that already
// resolved get disk-cache hits with no Deezer call. Tracks where
// Deezer had no match get a `.miss` sentinel re-tried after 7 days.
function autoBackfillOnStartup() {
  let triggered = 0;
  for (const profileId of listProfileIds()) {
    try {
      const lib = readJson(libraryFile(profileId));
      for (const track of lib) {
        const needsRescan = !track.album || !track.albumId;
        if (!needsRescan) continue;
        scheduleAlbumBackfill(profileId, track);
        triggered++;
      }
    } catch {}
  }
  if (triggered > 0) {
    console.log(`[album] queued ${triggered} library track(s) for Deezer lookup`);
  }
  return triggered;
}

app.post('/api/library/:trackId/download', (req, res) => {
  const lib = getLibrary(req.profileId);
  const track = lib.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  if (track.file) return res.status(409).json({ error: 'Déjà téléchargée' });
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    trackId: track.id,
    url: track.url,
    bitrate: '320',
    progress: 0,
    phase: 'starting',
    status: 'pending',
    track: null,
    error: null,
    listeners: new Set(),
    createdAt: Date.now(),
    updateExisting: true,
  };
  jobs.set(id, job);
  setImmediate(() => startJob(job));
  res.json({ id, trackId: track.id });
});

app.delete('/api/library/:trackId/download', (req, res) => {
  const lib = getLibrary(req.profileId);
  const track = lib.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  if (!track.file) return res.status(409).json({ error: 'Pas téléchargée' });
  try { fs.unlinkSync(path.join(AUDIO_DIR, `${track.id}.mp3`)); } catch {}
  track.file = null;
  saveLibrary(req.profileId, lib);
  res.json({ track });
});

app.put('/api/library/order', (req, res) => {
  const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
  if (!trackIds) return res.status(400).json({ error: 'trackIds required' });
  const lib = getLibrary(req.profileId);
  const byId = new Map(lib.map(t => [t.id, t]));
  const reordered = [];
  for (const id of trackIds) {
    if (typeof id !== 'string') continue;
    const t = byId.get(id);
    if (t) { reordered.push(t); byId.delete(id); }
  }
  for (const t of byId.values()) reordered.push(t);
  saveLibrary(req.profileId, reordered);
  res.json({ ok: true });
});

app.patch('/api/library/:id', (req, res) => {
  const lib = getLibrary(req.profileId);
  const track = lib.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  const wasLiked = track.liked !== false;
  if (typeof req.body?.liked === 'boolean') track.liked = req.body.liked;
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    track.title = req.body.title.trim().slice(0, 200);
  }
  saveLibrary(req.profileId, lib);
  res.json({ track });
  // Toggling a track to liked = true is a meaningful "user is engaging
  // with this" signal — re-trigger the album scan so anything still
  // missing metadata gets another shot. Cheap (cache-hit dominated).
  if (req.body?.liked === true && !wasLiked) {
    scheduleAutoBackfill();
  }
});

app.post('/api/library/:id/play', (req, res) => {
  const lib = getLibrary(req.profileId);
  const track = lib.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayedAt = Date.now();
  saveLibrary(req.profileId, lib);
  res.json({ track });
});

app.delete('/api/library/:id', (req, res) => {
  const lib = getLibrary(req.profileId);
  const idx = lib.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Piste introuvable' });
  const [track] = lib.splice(idx, 1);
  saveLibrary(req.profileId, lib);

  const pls = getPlaylists(req.profileId);
  let plsChanged = false;
  for (const pl of pls) {
    const before = pl.trackIds.length;
    pl.trackIds = pl.trackIds.filter(tid => tid !== track.id);
    if (pl.trackIds.length !== before) plsChanged = true;
  }
  if (plsChanged) savePlaylists(req.profileId, pls);

  try { fs.unlinkSync(path.join(AUDIO_DIR, `${track.id}.mp3`)); } catch {}
  res.json({ ok: true });
});

app.get('/api/playlists', (req, res) => {
  res.json({ playlists: getPlaylists(req.profileId) });
});

app.post('/api/playlists', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const pls = getPlaylists(req.profileId);
  const playlist = {
    id: crypto.randomBytes(6).toString('hex'),
    name: name.slice(0, 100),
    trackIds: [],
    createdAt: Date.now(),
  };
  pls.push(playlist);
  savePlaylists(req.profileId, pls);
  res.json({ playlist });
});

app.put('/api/playlists/:id', (req, res) => {
  const pls = getPlaylists(req.profileId);
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    pl.name = req.body.name.trim().slice(0, 100);
  }
  if (Array.isArray(req.body?.trackIds)) {
    pl.trackIds = req.body.trackIds.filter(t => typeof t === 'string');
  }
  savePlaylists(req.profileId, pls);
  res.json({ playlist: pl });
});

app.delete('/api/playlists/:id', (req, res) => {
  const pls = getPlaylists(req.profileId);
  const idx = pls.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist introuvable' });
  pls.splice(idx, 1);
  savePlaylists(req.profileId, pls);
  res.json({ ok: true });
});

app.post('/api/playlists/:id/tracks', (req, res) => {
  const pls = getPlaylists(req.profileId);
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  const trackId = String(req.body?.trackId || '');
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  const lib = getLibrary(req.profileId);
  if (!lib.find(t => t.id === trackId)) return res.status(404).json({ error: 'Piste introuvable' });
  if (!pl.trackIds.includes(trackId)) pl.trackIds.push(trackId);
  savePlaylists(req.profileId, pls);
  res.json({ playlist: pl });
  // Adding to a playlist is a "user cares about this" signal — give
  // any still-pending album lookups another shot.
  scheduleAutoBackfill();
});

app.post('/api/playlists/:id/tracks/bulk', (req, res) => {
  const pls = getPlaylists(req.profileId);
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [];
  const lib = getLibrary(req.profileId);
  let added = 0;
  for (const tid of trackIds) {
    if (typeof tid !== 'string') continue;
    if (!lib.find(t => t.id === tid)) continue;
    if (!pl.trackIds.includes(tid)) {
      pl.trackIds.push(tid);
      added++;
    }
  }
  savePlaylists(req.profileId, pls);
  res.json({ playlist: pl, added });
  if (added > 0) scheduleAutoBackfill();
});

app.delete('/api/playlists/:plId/tracks/:trackId', (req, res) => {
  const pls = getPlaylists(req.profileId);
  const pl = pls.find(p => p.id === req.params.plId);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  pl.trackIds = pl.trackIds.filter(tid => tid !== req.params.trackId);
  savePlaylists(req.profileId, pls);
  res.json({ playlist: pl });
});

// ──────────────────────────────────────────────────────────────────────
// Profiles — Netflix-style multi-user. Each entry maps to a folder under
// `library/users/<id>/` that holds the user's `library.json` +
// `playlists.json`. Audio MP3s and covers stay shared.
// ──────────────────────────────────────────────────────────────────────
function readProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); }
  catch { return []; }
}
function writeProfiles(list) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/profiles', (_req, res) => {
  res.json({ profiles: readProfiles() });
});

app.post('/api/profiles', (req, res) => {
  const { name, color } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name required' });
  }
  const cleanName = name.trim().slice(0, 32);
  const cleanColor = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#7c5cff';
  const id = crypto.randomBytes(6).toString('hex');
  const profile = { id, name: cleanName, color: cleanColor, createdAt: new Date().toISOString() };
  const profiles = readProfiles();
  profiles.push(profile);
  writeProfiles(profiles);
  ensureProfileDir(id);
  res.json({ profile });
});

app.patch('/api/profiles/:id', (req, res) => {
  const profiles = readProfiles();
  const p = profiles.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    p.name = req.body.name.trim().slice(0, 32);
  }
  if (typeof req.body?.color === 'string' && /^#[0-9a-f]{6}$/i.test(req.body.color)) {
    p.color = req.body.color;
  }
  writeProfiles(profiles);
  res.json({ profile: p });
});

app.delete('/api/profiles/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'default') {
    return res.status(400).json({ error: "Le profil par défaut ne peut pas être supprimé" });
  }
  const profiles = readProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  profiles.splice(idx, 1);
  writeProfiles(profiles);
  // Best-effort: remove the user's data dir.
  try {
    fs.rmSync(path.join(USERS_DIR, sanitizeProfileId(id)), { recursive: true, force: true });
  } catch {}
  res.json({ ok: true });
});

// SPA fallback: any unknown route that's not an API / asset path returns
// index.html so client-side routing works on direct deep-link loads.
// Skips API + audio + preview-files (those should 404 cleanly if missing)
// AND only kicks in when the frontend bundle exists. `app.get('*')` must
// be the LAST route — it catches everything that didn't match above.
if (fs.existsSync(FRONTEND_DIR)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/audio/') || req.path.startsWith('/preview-files/')) {
      return next();
    }
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
  autoBackfillOnStartup();
});
