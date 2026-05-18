<script setup>
import { computed } from 'vue';
import { Search as SearchIcon, Sparkles } from 'lucide-vue-next';
import { useSearchStore, makeSearchHandler } from '@/stores/search';
import { useLibraryStore } from '@/stores/library';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { parseTrackTitle } from '@/lib/format';
import { showToast } from 'vant';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import { useActionSheet } from '@/composables/useActionSheet';

const search = useSearchStore();
const lib = useLibraryStore();
const streams = useStreamsStore();
const player = usePlayerStore();
const mix = useMixStore();
const view = useViewStore();
const sheet = useActionSheet();

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

async function onMore(r) {
  try {
    const { index } = await sheet.open([
      { name: isLiked(r) ? 'Retirer des favoris' : 'Ajouter aux favoris' },
      { name: 'Lancer un mix basé sur ce titre' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
    ]);
    if (index === 0) toggleLike(r);
    else if (index === 1) {
      const pseudo = { ytId: r.id, title: r.title };
      mix.streamFrom(pseudo, () => view.switchTo('mix'));
    } else if (index === 2) {
      const streamId = `stream-${r.id}`;
      if (!streams.get(streamId)) {
        streams.set(streamId, {
          id: streamId, title: r.title, uploader: r.uploader, duration: r.duration,
          thumbnail: r.thumbnail, file: `/api/stream/${r.id}`, ytId: r.id, isStream: true,
        });
      }
      player.addToQueue(streamId);
    } else if (index === 3) {
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

    <div v-if="search.status === 'searching'" class="search-status">
      <van-loading color="var(--accent)" size="20" />
      <span>{{ search.statusMessage || 'Recherche…' }}</span>
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

    <van-action-sheet
      v-model:show="sheet.visible.value"
      :actions="sheet.actions.value"
      cancel-text="Annuler"
      close-on-click-action
      @select="sheet.onSelect"
      @cancel="sheet.onCancel"
    />
  </div>
</template>

<style scoped>
.search-view { min-height: 100%; }
.search-bar :deep(.van-search) {
  background: var(--bg);
  padding: 8px 12px;
}
.search-bar :deep(.van-search__content) { background: var(--card); }
.search-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-muted);
  font-size: 14px;
}
.search-status.error { color: var(--danger); }
.results { background: var(--bg); }
.empty-state .icon { color: var(--text-muted); margin-bottom: 12px; }
</style>
