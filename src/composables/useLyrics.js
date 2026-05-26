// Lyrics fetcher — composable used by the player's lyrics overlay.
// The overlay UI lives in MobilePlayer.vue; this file only knows how
// to clean a YouTube title, hit /api/lyrics and parse the LRC reply.
// (The legacy modal-based showLyrics() was removed when we moved
// lyrics into a Spotify-style inline overlay inside the player.)
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

export function guessArtistAndTitle(track) {
  const raw = track?.title || '';
  const cleaned = raw
    .replace(/\s*[\[\(](?:slowed|reverb(?:ed)?|lyrics|official|audio|video|hq|4k|remaster|m\/v|mv|hd)[^)\]]*[\]\)]/gi, '')
    .trim();
  const m = cleaned.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: track?.uploader || '', title: cleaned };
}

/**
 * Fetch lyrics for a track. Returns `{artist, title, content, synced}`
 * on success, where `synced` is an array of {time, text} (empty if
 * lrclib had no LRC and we fell back to plain text). Throws on error.
 *
 * Caller (MobilePlayer) owns the UI state — set its `lyricsLoading`
 * flag before awaiting and clear on resolve / reject.
 */
export async function fetchLyrics(track) {
  if (!track) throw new Error(t('toast.no_track_playing'));
  const { artist, title } = guessArtistAndTitle(track);
  const data = await api(
    `/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`,
  );
  return {
    artist,
    title,
    content: data.lyrics || '',
    synced: parseLrc(data.synced),
  };
}

// Parse an LRC string into an array of {time, text}. Drops metadata
// lines like [ar:Artist] / [ti:Title] / [length:0:00] etc. (those
// don't have a timestamp followed by lyric text). Multiple
// timestamps on one line are expanded into one entry each.
//
// Format: `[mm:ss.xx]Some line` or `[mm:ss]Some line`
export function parseLrc(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of raw.split('\n')) {
    re.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      stamps.push(mm * 60 + ss + frac);
    }
    if (stamps.length === 0) continue;
    const text = line.replace(re, '').trim();
    if (!text) continue;
    for (const t of stamps) out.push({ time: t, text });
  }
  return out.sort((a, b) => a.time - b.time);
}
