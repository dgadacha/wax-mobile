// Lyrics fetcher — composable used by the player's lyrics button.
import { api } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { openLyricsModal, patchLyricsModal } from '@/lib/modal';
import { t } from '@/lib/i18n';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';

function guessArtistAndTitle(track) {
  const raw = track.title || '';
  const cleaned = raw
    .replace(/\s*[\[\(](?:slowed|reverb(?:ed)?|lyrics|official|audio|video|hq|4k|remaster|m\/v|mv|hd)[^)\]]*[\]\)]/gi, '')
    .trim();
  const m = cleaned.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: track.uploader || '', title: cleaned };
}

export async function showLyrics() {
  const player = usePlayerStore();
  const lib = useLibraryStore();
  const trackId = player.queue[player.index];
  const track = lib.findById(trackId);
  if (!track) {
    showToast(t('toast.no_track_playing'), 'error');
    return;
  }
  const { artist, title } = guessArtistAndTitle(track);
  openLyricsModal({
    artist,
    title,
    status: 'loading',
    content: t('lyrics.loading'),
  });
  try {
    const data = await api(`/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
    // Server returns `synced` (LRC string) when lrclib had a match,
    // empty otherwise. Parse to an array of {time, text} so the modal
    // can highlight the current line + auto-scroll.
    const lines = parseLrc(data.synced);
    patchLyricsModal({
      lyricsStatus: 'ok',
      lyricsContent: data.lyrics,
      lyricsSynced: lines,
    });
  } catch (e) {
    const isNotFound = /lyrics not found/i.test(e.message) || e.message === 'Paroles introuvables';
    const msg = isNotFound
      ? t('lyrics.not_found_detail', { artist, title })
      : t('common.error_prefix', e.message);
    patchLyricsModal({ lyricsStatus: 'error', lyricsContent: msg, lyricsSynced: [] });
  }
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
