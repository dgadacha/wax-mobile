<script setup>
import { computed } from 'vue';
import { Search as SearchIcon, Sparkles } from 'lucide-vue-next';
import { useSearchStore, makeSearchHandler } from '@/stores/search';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { usePlaylistsStore } from '@/stores/playlists';
import { parseTrackTitle } from '@/lib/format';
import { showToast } from 'vant';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { useActionSheetStore } from '@/stores/actionSheet';

const search = useSearchStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const player = usePlayerStore();
const mix = useMixStore();
const view = useViewStore();
const playlists = usePlaylistsStore();
const sheet = useActionSheetStore();

const onUrlChange = makeSearchHandler(search);

function onSearchInput(v) {
  search.inputValue = v;
  onUrlChange();
}
function onClear() {
  search.inputValue = '';
  search.clearAll();
}

function isLiked(r) { return lib.tracks.some((t) => t.ytId === r.id); }

function playResult(r) {
  streams.streamSearchResult(r, null, player);
}

function toggleLike(r) {
  if (isLiked(r)) {
    const existing = lib.tracks.find((t) => t.ytId === r.id);
    if (existing) lib.remove(existing.id);
  } else {
    lib.add({
      id: r.id, ytId: r.id, title: r.title, uploader: r.uploader,
      duration: r.duration, thumbnail: r.thumbnail,
      url: `https://www.youtube.com/watch?v=${r.id}`,
    }, { silent: true });
    showToast({ message: 'Ajouté aux favoris', position: 'bottom' });
  }
}

// Ensure a YouTube search result exists in the library (liked:false so
// it doesn't pollute Favoris) and return its library id. Used as the
// pre-step for "add to playlist" / "queue" — playlists need library ids,
// not stream ids.
async function ensureInLibrary(r) {
  const existing = lib.tracks.find((t) => t.ytId === r.id);
  if (existing) return existing.id;
  const added = await lib.add({
    id: r.id, ytId: r.id, title: r.title, uploader: r.uploader,
    duration: r.duration, thumbnail: r.thumbnail,
    url: `https://www.youtube.com/watch?v=${r.id}`,
  }, { liked: false, silent: true });
  return added?.id || lib.tracks.find((t) => t.ytId === r.id)?.id;
}

async function addToPlaylistFlow(r) {
  // Cascade a second action sheet listing the user's playlists. Vant
  // ActionSheet scrolls when there are many actions, so a long playlist
  // list still works on mobile.
  const actions = [
    { name: '＋ Nouvelle playlist', color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id })),
  ];
  // Wait a tick so the previous sheet's close animation completes before
  // the next one slides in — otherwise Vant glitches.
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try { pick = await sheet.open(actions); } catch { return; }
  const trackId = await ensureInLibrary(r);
  if (!trackId) { showToast({ message: 'Impossible d\'ajouter', position: 'bottom' }); return; }
  if (pick.index === 0) {
    // Create a new playlist (uses legacy promptModal under the hood)
    // then add the track.
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, trackId);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, trackId);
    showToast({ message: `Ajouté à « ${pl.name} »`, position: 'bottom' });
  }
}

async function onMore(r) {
  try {
    const { index } = await sheet.open([
      { name: isLiked(r) ? 'Retirer des favoris' : 'Ajouter aux favoris' },
      { name: 'Ajouter à une playlist' },
      { name: 'Lancer un mix basé sur ce titre' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
    ]);
    if (index === 0) toggleLike(r);
    else if (index === 1) addToPlaylistFlow(r);
    else if (index === 2) {
      const pseudo = { ytId: r.id, title: r.title };
      mix.streamFrom(pseudo, () => view.switchTo('mix'));
    } else if (index === 3) {
      const streamId = `stream-${r.id}`;
      if (!streams.get(streamId)) {
        streams.set(streamId, {
          id: streamId, title: r.title, uploader: r.uploader, duration: r.duration,
          thumbnail: r.thumbnail, file: `/api/stream/${r.id}`, ytId: r.id, isStream: true,
        });
      }
      player.addToQueue(streamId);
    } else if (index === 4) {
      const a = parseTrackTitle({ title: r.title, uploader: r.uploader }).artist || r.uploader;
      if (a) view.switchTo('artist', a);
    }
  } catch {}
}

const results = computed(() => search.results || []);
const hasResults = computed(() => !!(search.results && search.results.length));

// Adapt YouTube search results to the shape MobileTrackCell expects.
function asTrack(r) {
  return {
    id: `stream-${r.id}`,
    ytId: r.id,
    title: r.title,
    uploader: r.uploader,
    duration: r.duration,
    thumbnail: r.thumbnail,
  };
}
</script>

<template>
  <div class="search-view">
    <div class="search-bar">
      <van-search
        :model-value="search.inputValue"
        placeholder="Titre, artiste, ou URL YouTube"
        shape="round"
        clearable
        @update:model-value="onSearchInput"
        @clear="onClear"
      />
    </div>

    <div v-if="search.status === 'searching' && !hasResults" class="results shimmer-list">
      <div v-for="i in 8" :key="i" class="shimmer-row">
        <div class="sh sh-thumb" />
        <div class="sh-meta">
          <div class="sh sh-title" />
          <div class="sh sh-sub" />
        </div>
      </div>
    </div>
    <div v-else-if="search.status === 'error'" class="search-status error">
      {{ search.statusMessage }}
    </div>

    <div v-if="hasResults" class="results">
      <MobileTrackCell
        v-for="r in results"
        :key="r.id"
        :track="asTrack(r)"
        :is-playing="player.currentTrack && player.currentTrack.ytId === r.id"
        :is-liked="isLiked(r)"
        @play="playResult(r)"
        @like="toggleLike(r)"
        @more="onMore(r)"
      />
    </div>

    <div v-else-if="!search.inputValue && !search.status" class="empty-state">
      <SearchIcon class="icon" :size="48" :stroke-width="1.5" />
      <div class="label">Recherche un titre, un artiste,</div>
      <div class="hint">ou colle une URL YouTube</div>
    </div>

  </div>
</template>

<style scoped>
.search-view { min-height: 100%; }
.search-bar :deep(.van-search) {
  background: var(--bg);
  padding: 8px 12px;
}
.search-bar :deep(.van-search__content) { background: var(--card); }
.search-status.error {
  padding: 20px;
  text-align: center;
  font-size: 14px;
  color: var(--danger);
}
.results { background: var(--bg); }
.empty-state .icon { color: var(--text-muted); margin-bottom: 12px; }

/* Shimmer skeleton rows while a search is in flight — replaces the
 * loading text. Matches MobileTrackCell layout so the swap feels seamless
 * when results arrive. */
.shimmer-list { padding: 4px 0 16px; }
.shimmer-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.sh {
  background: linear-gradient(
    90deg,
    var(--card) 0%,
    var(--card-hover) 50%,
    var(--card) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
  border-radius: 6px;
}
.sh-thumb { width: 44px; height: 44px; flex: 0 0 auto; }
.sh-meta { flex: 1 1 auto; min-width: 0; }
.sh-title { height: 14px; width: 80%; }
.sh-sub { height: 10px; width: 50%; margin-top: 6px; }
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
