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
    // android player client is ~2x faster than the default web client because
    // it skips ad/SABR signature dance. Trade-off: returns the combined mp4
    // (itag 18, video+audio @360p) — browsers happily play it as audio source,
    // bandwidth ~150KB/s instead of ~80KB/s for m4a-only. We try web as
    // fallback so audio-only formats remain available when android is blocked.
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
    ytdlp.on('close', code => {
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
const LIBRARY_DIR = process.env.WAX_LIBRARY_DIR || path.join(ROOT, 'library');
const AUDIO_DIR = path.join(LIBRARY_DIR, 'audio');
const PREVIEW_DIR = path.join(LIBRARY_DIR, 'previews');
const COVERS_DIR = path.join(LIBRARY_DIR, 'covers');
const ARTISTS_DIR = path.join(LIBRARY_DIR, 'artists');
const ALBUMS_DIR = path.join(LIBRARY_DIR, 'albums');           // MusicBrainz lookup JSON cache
const ALBUM_COVERS_DIR = path.join(LIBRARY_DIR, 'album-covers'); // Cover Art Archive cache
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'library.json');
const PLAYLISTS_FILE = path.join(LIBRARY_DIR, 'playlists.json');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });
fs.mkdirSync(ARTISTS_DIR, { recursive: true });
fs.mkdirSync(ALBUMS_DIR, { recursive: true });
fs.mkdirSync(ALBUM_COVERS_DIR, { recursive: true });
if (!fs.existsSync(LIBRARY_FILE)) fs.writeFileSync(LIBRARY_FILE, '[]');
if (!fs.existsSync(PLAYLISTS_FILE)) fs.writeFileSync(PLAYLISTS_FILE, '[]');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1d' }));
app.use('/preview-files', express.static(PREVIEW_DIR, { maxAge: '1h' }));

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
// Album metadata pipeline — `/api/album-lookup` + `/api/album-cover/:mbid`.
//
// yt-dlp doesn't expose an `album` field for YouTube videos (verified
// across regular videos, Topic auto-channels, and music.youtube.com URLs
// — every one returns NA). So we resolve album info via MusicBrainz:
//   1. POST artist+title → /ws/2/recording?query=… → JSON results
//   2. Filter to high-confidence matches (score >= 90)
//   3. Pick the best release attached: prefer Album type over Single /
//      Compilation / Soundtrack / EP, then earliest release date
//   4. Cache result on disk by hash(normalized artist + title)
//
// Cover art comes from Cover Art Archive, MB's image partner, via
//   https://coverartarchive.org/release-group/<mbid>/front
// proxied through `/api/album-cover/:mbidGroup` so the client gets a
// single stable URL and we keep one disk-cached copy.
//
// MB requires a real User-Agent + 1 req/sec rate limit. We honor both.
// ----------------------------------------------------------------

// Mirror of the client's parseTrackTitle (src/lib/format.js) so we can
// clean up "Artist - Song (Official Video)" titles before querying MB.
const SERVER_TITLE_CRUFT = /\s*[\[\(](?:slowed|reverb(?:ed)?|reverb|lyrics?|official|audio|video|hq|4k|hd|remaster(?:ed)?|m\/v|mv|live|acoustic|cover|extended|radio edit|version|sped[ -]?up|nightcore|8d|3d|bass boosted|visualizer|color(?:ed)? coded)[^)\]]*[\]\)]/gi;

function parseTrackTitle(title, uploader) {
  const raw = (title || '').trim();
  const cleaned = raw.replace(SERVER_TITLE_CRUFT, '').replace(/\s+/g, ' ').trim();
  const m = cleaned.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), song: m[2].trim() };
  return { artist: uploader || '', song: cleaned };
}

// Strip parenthesized featuring noise so MusicBrainz matches on the
// canonical title — "Blinding Lights (feat. ROSALIA)" → "Blinding Lights".
function cleanTitleForMB(title) {
  return String(title || '')
    .replace(/\s*[\[\(](feat\.?|ft\.?|featuring|with|prod\.?\s*by)[^)\]]*[\]\)]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistForMB(artist) {
  // MB indexes "feat." / "ft." inside artist credits as separate entities.
  // Clip at the first feat to keep the primary artist for our query.
  return String(artist || '')
    .replace(/\s+(feat\.?|ft\.?|with)\s+.*$/i, '')
    .trim();
}

function albumCacheKey(artist, title) {
  const base = `${normalizeArtistKey(artist)}|${cleanTitleForMB(title).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

// MusicBrainz rate limiter — they ask for 1 req/sec sustained. Queue any
// request that would breach the gap and stagger them. Single-flight per
// process is enough for our scale (background backfills + manual lookups).
const MB_MIN_GAP_MS = 1100;
let mbLastReq = 0;
const mbQueue = [];
let mbDraining = false;
function mbThrottle(fn) {
  return new Promise((resolve, reject) => {
    mbQueue.push({ fn, resolve, reject });
    drainMbQueue();
  });
}
async function drainMbQueue() {
  if (mbDraining) return;
  mbDraining = true;
  while (mbQueue.length) {
    const { fn, resolve, reject } = mbQueue.shift();
    const wait = Math.max(0, MB_MIN_GAP_MS - (Date.now() - mbLastReq));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    mbLastReq = Date.now();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  mbDraining = false;
}

// Read package.json once for User-Agent, MB rejects requests without one.
let MB_UA = 'Wax/1.0.0 (https://github.com/dgadacha/wax)';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  MB_UA = `Wax/${pkg.version} (https://github.com/dgadacha/wax)`;
} catch {}

function mbFetchJson(urlStr) {
  return mbThrottle(() => new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'User-Agent': MB_UA, 'Accept': 'application/json' } }, (r) => {
      if (r.statusCode === 503) {
        // MB rate-limit response — back off and resolve as null so callers
        // treat it as "no match for now" rather than a hard failure.
        r.resume();
        return resolve(null);
      }
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error(`MB HTTP ${r.statusCode}`));
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

// Score a release for "album-likeness". Higher = more canonical.
// Albums by primary-type win, secondary-types like Compilation/Live/Remix
// take big hits, and we award a small bonus for each recording from the
// query that maps to this release-group (canonical albums appear across
// many recordings; one-off compilations appear in only one).
// Title-based deboost: many reissues, deluxe editions, soundtracks etc.
// share an `Album` primary-type with no secondary-types set in MB. The
// title is the only reliable signal we have to demote them in favor of
// the canonical original release. Collectors / Anniversary / Remastered
// edits are particularly common in the dataset for popular artists.
const TITLE_DEMOTE = /\b(deluxe|collectors?\b|collector\s*'?s|anniversary|remastered?|special\s*edition|expanded|reissue|limited\s*edition|bonus\s*tracks?|extended\s*edition|complete\s*edition|original\s*soundtrack|full\s*soundtrack|\bost\b|motion\s*picture|video\s*game)/i;
// Live bootleg recordings often have title formats like
// "2003-06-04: Electric Lady Studios, NY" — sometimes with unicode
// hyphens (U+2010) instead of ASCII. Match any non-digit separator.
const TITLE_DATE_PREFIX = /^\s*\d{4}[^\d]\d{2}[^\d]\d{2}/;

function scoreReleaseGroup(release, hits) {
  const rg = release['release-group'] || {};
  const t = String(rg['primary-type'] || '').toLowerCase();
  const sec = (rg['secondary-types'] || []).map((s) => String(s).toLowerCase());
  let s = 0;
  if (t === 'album') s = 100;
  else if (t === 'ep') s = 60;
  else if (t === 'single') s = 50;
  else if (t === 'soundtrack') s = 40;
  else if (t === 'broadcast') s = 20;
  else s = 10;
  if (sec.includes('compilation')) s -= 60;
  if (sec.includes('live')) s -= 35;
  if (sec.includes('remix')) s -= 35;
  if (sec.includes('soundtrack')) s -= 10;
  if (sec.includes('mixtape/street')) s -= 25;
  if (sec.includes('demo')) s -= 30;
  // Title-based deboost — catches "DAMN. Collectors Edition" beating
  // "DAMN.", "Piece by Piece Full Soundtrack" beating "Random Access
  // Memories", etc.
  const title = String(rg.title || release.title || '');
  if (TITLE_DEMOTE.test(title)) s -= 40;
  if (TITLE_DATE_PREFIX.test(title)) s -= 80;
  s += Math.min(20, hits * 3);
  return s;
}

async function lookupAlbumOnMB(artist, title) {
  const cleanArtist = cleanArtistForMB(artist);
  const cleanTitle = cleanTitleForMB(title);
  if (!cleanArtist || !cleanTitle) return null;
  // MB Lucene-style query. We use `artistname` instead of `artist` because
  // multi-credit recordings (e.g. "Daft Punk feat. Pharrell Williams" on
  // "Get Lucky") don't match a strict `artist:"Daft Punk"` query — that
  // field is the canonical primary artist only. `artistname` matches any
  // name in the artist-credit chain, which is what we want.
  const esc = (s) => s.replace(/"/g, '\\"');
  const baseQuery = `artistname:"${esc(cleanArtist)}" AND recording:"${esc(cleanTitle)}"`;
  // We run both queries — the unfiltered baseline catches normal cases
  // (Daft Punk's Random Access Memories, etc.) and the Live/Compilation
  // exclusion saves us on bootleg-flooded artists (Radiohead, Phish,
  // Grateful Dead) where MB's first 50 unfiltered hits are pure
  // bootlegs. Both pools feed the same scoring; the highest scored
  // release-group across the union wins. Costs ~1 s extra (rate-limit
  // adds the gap) but the result is materially better.
  const filteredQuery = `${baseQuery} AND NOT secondarytype:Live AND NOT secondarytype:Compilation`;
  const [result, filtered] = await Promise.all([
    tryMBQuery(baseQuery, cleanArtist),
    tryMBQuery(filteredQuery, cleanArtist),
  ]);
  if (!result && !filtered) return null;
  let winner = result;
  if (!result) winner = filtered;
  else if (filtered && (filtered._rgScore || 0) > (result._rgScore || 0)) winner = filtered;
  // Strip the internal scoring field — caller only sees user-facing data.
  if (winner) delete winner._rgScore;
  return winner;
}

async function tryMBQuery(query, cleanArtist) {
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=15&inc=releases+release-groups+artist-credits`;
  const data = await mbFetchJson(url).catch(() => null);
  if (!data || !Array.isArray(data.recordings)) return null;
  // Filter recordings: score >= 75 AND artist-credit normalizes to query
  // artist. The artist filter is what saves us from "compilation X also
  // contains a track called <Title>" — the compilation's artist-credit
  // is "Various Artists", which won't match our query.
  const queryKey = normalizeArtistKey(cleanArtist);
  const matched = data.recordings.filter((rec) => {
    if ((rec.score || 0) < 75) return false;
    const credit = rec['artist-credit'] || [];
    const names = credit.map((c) => (c && (c.name || (c.artist && c.artist.name))) || '').join(' ');
    return queryKey && normalizeArtistKey(names).includes(queryKey);
  });
  if (matched.length === 0) return null;
  // Aggregate releases across all matched recordings, grouped by
  // release-group id. Track how many recordings reference each group —
  // the canonical album of a popular track is referenced by many
  // recordings (radio edit, remaster, deluxe, single, etc.).
  const groups = new Map(); // groupId -> { release, hits }
  matched.forEach((rec) => {
    (rec.releases || []).forEach((release) => {
      const gid = release['release-group'] && release['release-group'].id;
      if (!gid) return;
      const prev = groups.get(gid);
      if (prev) prev.hits++;
      else groups.set(gid, { release, hits: 1 });
    });
  });
  if (groups.size === 0) return null;
  const scored = Array.from(groups.values()).map(({ release, hits }) => ({
    release, hits, score: scoreReleaseGroup(release, hits),
  }));
  scored.sort((a, b) => {
    const ds = b.score - a.score;
    if (ds !== 0) return ds;
    // Tiebreaker: earliest release date wins (canonical original release
    // beats reissues).
    const ad = a.release.date || '9999';
    const bd = b.release.date || '9999';
    return ad.localeCompare(bd);
  });
  const best = scored[0];
  if (!best || best.score < 30) return null; // reject all-bad pools
  const release = best.release;
  const topRecording = matched[0];
  return {
    album: release.title,
    releaseDate: release.date || null,
    releaseId: release.id,
    releaseGroupId: (release['release-group'] && release['release-group'].id) || null,
    _rgScore: best.score,
    primaryType: (release['release-group'] && release['release-group']['primary-type']) || null,
    artist: (topRecording['artist-credit'] && topRecording['artist-credit'][0] && topRecording['artist-credit'][0].name) || cleanArtist,
    score: topRecording.score,
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
      } else {
        return cached;
      }
    } catch {}
  }
  let inflight = albumLookupInflight.get(key);
  if (!inflight) {
    inflight = (async () => {
      const result = await lookupAlbumOnMB(artist, title);
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

// Cover Art Archive proxy — keeps one disk copy per release-group, gives
// the client a stable `/api/album-cover/:id` URL. CAA returns a 307 to
// the actual image; we follow it once and cache.
function fetchAlbumCover(releaseGroupId) {
  return new Promise((resolve) => {
    const dest = path.join(ALBUM_COVERS_DIR, `${releaseGroupId}.jpg`);
    const url = `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
    const follow = (u, hops = 0) => {
      if (hops > 4) return resolve(null);
      https.get(u, { headers: { 'User-Agent': MB_UA } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          return follow(r.headers.location, hops + 1);
        }
        if (r.statusCode !== 200) {
          r.resume();
          return resolve(null);
        }
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 500) return resolve(null);
          try { fs.writeFileSync(dest, buf); resolve(dest); } catch { resolve(null); }
        });
        r.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    };
    follow(url);
  });
}

const albumCoverInflight = new Map();

app.get('/api/album-cover/:mbid', async (req, res) => {
  const mbid = String(req.params.mbid || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(mbid)) return res.status(400).end();
  const localPath = path.join(ALBUM_COVERS_DIR, `${mbid}.jpg`);
  if (fs.existsSync(localPath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(localPath);
  }
  const missPath = path.join(ALBUM_COVERS_DIR, `${mbid}.miss`);
  if (fs.existsSync(missPath)) {
    const age = Date.now() - fs.statSync(missPath).mtimeMs;
    if (age < 7 * 86400_000) return res.status(404).end();
    try { fs.unlinkSync(missPath); } catch {}
  }
  let inflight = albumCoverInflight.get(mbid);
  if (!inflight) {
    inflight = fetchAlbumCover(mbid).finally(() => albumCoverInflight.delete(mbid));
    albumCoverInflight.set(mbid, inflight);
  }
  const cached = await inflight;
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(cached);
  }
  try { fs.writeFileSync(missPath, ''); } catch {}
  res.status(404).end();
});

const getLibrary = () => readJson(LIBRARY_FILE).map(t => ({
  ...t,
  // Funnel every thumbnail through the local cover endpoint — works offline
  // once cached, gives us a single fallback path. Tracks without a ytId
  // (rare, defensive) keep their stored URL as-is.
  thumbnail: t.ytId ? coverUrl(t.ytId) : t.thumbnail,
}));
const saveLibrary = (lib) => writeJson(LIBRARY_FILE, lib);
const getPlaylists = () => readJson(PLAYLISTS_FILE);
const savePlaylists = (pls) => writeJson(PLAYLISTS_FILE, pls);

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
    const lib = getLibrary();
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
    const currentLib = getLibrary();
    if (job.updateExisting) {
      track = currentLib.find(t => t.id === job.trackId);
      if (track) {
        track.file = `/audio/${job.trackId}.mp3`;
        if (!track.duration && info.duration) track.duration = info.duration;
        saveLibrary(currentLib);
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
      saveLibrary(currentLib);
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
  res.json({ tracks: getLibrary() });
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
    library: readJson(LIBRARY_FILE),
    playlists: getPlaylists(),
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
  saveLibrary(library);
  savePlaylists(playlists);
  res.json({ ok: true, tracks: library.length, playlists: playlists.length });
});

// Factory reset: empties library.json + playlists.json and deletes every
// file in the audio + preview directories. Client-side prefs (theme,
// locale, EQ, crossfade, volume) live in localStorage and are NOT touched
// — those are UI settings, not data.
app.post('/api/wipe', (req, res) => {
  try {
    const removed = { audio: 0, previews: 0, covers: 0 };
    saveLibrary([]);
    savePlaylists([]);
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
  const lib = getLibrary();
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
  saveLibrary(lib);
  res.json({ track });
  // Fire-and-forget: resolve the album via MusicBrainz, persist on the
  // track. Throttled to 1 req/sec by mbThrottle, runs entirely in the
  // background. The client gets an album field on its next library
  // refresh — or via SSE if we wire that up later.
  scheduleAlbumBackfill(track);
});

// SSE listeners for live album-resolved events. The client subscribes
// to `/api/album-progress` once on mount; when a backfill resolves an
// album, every connected client gets a `{type:'album', trackId, album,
// albumReleaseGroupId, albumReleaseDate}` event and patches its local
// state without a full library refetch.
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
// still there.
function scheduleAlbumBackfill(track) {
  const parsed = parseTrackTitle(track.title, track.uploader);
  if (!parsed.artist || !parsed.song) return;
  resolveAlbum(parsed.artist, parsed.song)
    .then((album) => {
      if (!album) return;
      const fresh = readJson(LIBRARY_FILE);
      const idx = fresh.findIndex((t) => t.id === track.id);
      if (idx === -1) return;
      fresh[idx].album = album.album;
      fresh[idx].albumReleaseGroupId = album.releaseGroupId || null;
      fresh[idx].albumReleaseDate = album.releaseDate || null;
      saveLibrary(fresh);
      broadcastAlbumEvent({
        type: 'album',
        trackId: track.id,
        album: album.album,
        albumReleaseGroupId: album.releaseGroupId || null,
        albumReleaseDate: album.releaseDate || null,
      });
    })
    .catch(() => {});
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

// Auto-backfill at startup — schedule a lookup for every library track
// missing an `album` field. Throttled by `mbThrottle` to 1 req/sec.
// Runs in the background, fully non-blocking. Idempotent: tracks that
// already resolved won't be re-queried (the cache short-circuits) and
// tracks where MB had no match get a `.miss` sentinel that's only
// re-tried after 7 days, so this never spams the API.
function autoBackfillOnStartup() {
  let triggered = 0;
  try {
    const lib = readJson(LIBRARY_FILE);
    for (const track of lib) {
      if (track.album) continue;
      scheduleAlbumBackfill(track);
      triggered++;
    }
  } catch {}
  if (triggered > 0) {
    console.log(`[album] queued ${triggered} library track(s) for MusicBrainz lookup`);
  }
}

app.post('/api/library/:trackId/download', (req, res) => {
  const lib = getLibrary();
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
  const lib = getLibrary();
  const track = lib.find(t => t.id === req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  if (!track.file) return res.status(409).json({ error: 'Pas téléchargée' });
  try { fs.unlinkSync(path.join(AUDIO_DIR, `${track.id}.mp3`)); } catch {}
  track.file = null;
  saveLibrary(lib);
  res.json({ track });
});

app.put('/api/library/order', (req, res) => {
  const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
  if (!trackIds) return res.status(400).json({ error: 'trackIds required' });
  const lib = getLibrary();
  const byId = new Map(lib.map(t => [t.id, t]));
  const reordered = [];
  for (const id of trackIds) {
    if (typeof id !== 'string') continue;
    const t = byId.get(id);
    if (t) { reordered.push(t); byId.delete(id); }
  }
  for (const t of byId.values()) reordered.push(t);
  saveLibrary(reordered);
  res.json({ ok: true });
});

app.patch('/api/library/:id', (req, res) => {
  const lib = getLibrary();
  const track = lib.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  if (typeof req.body?.liked === 'boolean') track.liked = req.body.liked;
  if (typeof req.body?.title === 'string' && req.body.title.trim()) {
    track.title = req.body.title.trim().slice(0, 200);
  }
  saveLibrary(lib);
  res.json({ track });
});

app.post('/api/library/:id/play', (req, res) => {
  const lib = getLibrary();
  const track = lib.find(t => t.id === req.params.id);
  if (!track) return res.status(404).json({ error: 'Piste introuvable' });
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayedAt = Date.now();
  saveLibrary(lib);
  res.json({ track });
});

app.delete('/api/library/:id', (req, res) => {
  const lib = getLibrary();
  const idx = lib.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Piste introuvable' });
  const [track] = lib.splice(idx, 1);
  saveLibrary(lib);

  const pls = getPlaylists();
  let plsChanged = false;
  for (const pl of pls) {
    const before = pl.trackIds.length;
    pl.trackIds = pl.trackIds.filter(tid => tid !== track.id);
    if (pl.trackIds.length !== before) plsChanged = true;
  }
  if (plsChanged) savePlaylists(pls);

  try { fs.unlinkSync(path.join(AUDIO_DIR, `${track.id}.mp3`)); } catch {}
  res.json({ ok: true });
});

app.get('/api/playlists', (req, res) => {
  res.json({ playlists: getPlaylists() });
});

app.post('/api/playlists', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const pls = getPlaylists();
  const playlist = {
    id: crypto.randomBytes(6).toString('hex'),
    name: name.slice(0, 100),
    trackIds: [],
    createdAt: Date.now(),
  };
  pls.push(playlist);
  savePlaylists(pls);
  res.json({ playlist });
});

app.put('/api/playlists/:id', (req, res) => {
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    pl.name = req.body.name.trim().slice(0, 100);
  }
  if (Array.isArray(req.body?.trackIds)) {
    pl.trackIds = req.body.trackIds.filter(t => typeof t === 'string');
  }
  savePlaylists(pls);
  res.json({ playlist: pl });
});

app.delete('/api/playlists/:id', (req, res) => {
  const pls = getPlaylists();
  const idx = pls.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist introuvable' });
  pls.splice(idx, 1);
  savePlaylists(pls);
  res.json({ ok: true });
});

app.post('/api/playlists/:id/tracks', (req, res) => {
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  const trackId = String(req.body?.trackId || '');
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  const lib = getLibrary();
  if (!lib.find(t => t.id === trackId)) return res.status(404).json({ error: 'Piste introuvable' });
  if (!pl.trackIds.includes(trackId)) pl.trackIds.push(trackId);
  savePlaylists(pls);
  res.json({ playlist: pl });
});

app.post('/api/playlists/:id/tracks/bulk', (req, res) => {
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [];
  const lib = getLibrary();
  let added = 0;
  for (const tid of trackIds) {
    if (typeof tid !== 'string') continue;
    if (!lib.find(t => t.id === tid)) continue;
    if (!pl.trackIds.includes(tid)) {
      pl.trackIds.push(tid);
      added++;
    }
  }
  savePlaylists(pls);
  res.json({ playlist: pl, added });
});

app.delete('/api/playlists/:plId/tracks/:trackId', (req, res) => {
  const pls = getPlaylists();
  const pl = pls.find(p => p.id === req.params.plId);
  if (!pl) return res.status(404).json({ error: 'Playlist introuvable' });
  pl.trackIds = pl.trackIds.filter(tid => tid !== req.params.trackId);
  savePlaylists(pls);
  res.json({ playlist: pl });
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
  // Kick off album resolution for any track that doesn't already have
  // metadata. Throttled, fire-and-forget, broadcasts via SSE as each
  // track resolves so connected clients update in place.
  autoBackfillOnStartup();
});
