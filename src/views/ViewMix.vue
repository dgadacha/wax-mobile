<script setup>
import { computed } from 'vue';
import { Bookmark, Sparkles } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { gradientFromString } from '@/lib/format';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';
import MobileSkeleton from '@/components/MobileSkeleton.vue';

const mix = useMixStore();
const view = useViewStore();
const streams = useStreamsStore();
const player = usePlayerStore();
const lib = useLibraryStore();

// Mix tracks are stream-* objects (isStream:true). `lib.toggleFav(t)`
// detects isStream and does the optimistic-add-favorite flow.
// `isLiked` cross-checks against the library by ytId since the stream
// id doesn't exist in lib.tracks.
function isLiked(t) {
  return !!t.ytId && lib.tracks.some((lt) => lt.ytId === t.ytId && lt.liked !== false);
}

const tracks = computed(() => {
  if (!mix.current) return [];
  return mix.current.queueIds
    .map((id) => streams.get(id))
    .filter(Boolean);
});

const queueIds = computed(() => mix.current?.queueIds || []);
// During generation the hero falls back to the seed track (the title the
// mix is based on) so the page isn't empty while the radio is built.
const sourceTitle = computed(() => mix.current?.sourceTitle || mix.seed?.title || 'Mix');
const cover = computed(() =>
  mix.current ? (tracks.value[0]?.thumbnail || '') : (mix.seed?.thumbnail || ''),
);
const bgGradient = computed(() => gradientFromString(sourceTitle.value));

const meta = computed(() => {
  if (mix.loading) return 'Génération du mix…';
  const n = queueIds.value.length;
  if (!n) return '';
  return `Mix temporaire · ${n} titres`;
});

const isCurrentContext = computed(() =>
  !!player.currentTrack && queueIds.value.includes(player.currentTrack.id),
);
const heroPlaying = computed(() => player.playing && isCurrentContext.value);
function onHeroPlay() {
  if (queueIds.value.length === 0) return;
  if (isCurrentContext.value) { player.togglePlay(); return; }
  player.queue = [...queueIds.value];
  player.index = 0;
  player.loadAndPlay();
}

function playTrack(t) {
  player.playFromList(t.id, queueIds.value);
}

function save() {
  mix.save((newPlaylistId) => view.switchTo('playlist', newPlaylistId));
}
</script>

<template>
  <div v-if="mix.current || mix.loading" class="mix-view">
    <MobileHero
      :cover="cover"
      :bg-gradient="bgGradient"
      :title="`Mix : ${sourceTitle}`"
      :meta="meta"
      :show-play="!mix.loading && tracks.length > 0"
      :playing="heroPlaying"
      @play="onHeroPlay"
    >
      <template v-if="!mix.loading" #actions>
        <button class="hero-icon-btn save" aria-label="Sauvegarder" @click="save">
          <Bookmark :size="16" :stroke-width="2.2" color="currentColor" />
          <span>Sauvegarder</span>
        </button>
      </template>
    </MobileHero>

    <!-- Shimmer while the server builds the radio. -->
    <MobileSkeleton v-if="mix.loading" variant="row" :count="8" />

    <div v-else class="track-list">
      <MobileTrackCell
        v-for="(t, i) in tracks"
        :key="t.id"
        :track="t"
        :index="i"
        variant="thumb"
        :is-playing="player.currentTrack && player.currentTrack.id === t.id"
        :is-liked="isLiked(t)"
        :show-more="false"
        @play="playTrack(t)"
        @like="lib.toggleFav(t)"
      />
    </div>
  </div>
  <div v-else class="empty-state mix-empty">
    <Sparkles class="icon" :size="48" :stroke-width="1.5" />
    <div class="label">Aucun mix en cours</div>
    <div class="hint">Lance un mix depuis le menu « ⋮ » d'un titre.</div>
  </div>
</template>

<style scoped>
.mix-view { min-height: 100%; padding-bottom: 16px; }
/* No-mix empty state has no hero — clear the floating nav-bar. */
.mix-empty { padding-top: calc(var(--safe-top) + 96px); }
.hero-icon-btn.save {
  background: transparent;
  color: var(--text);
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 999px;
  padding: 7px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font: 700 13px/1.2 var(--font-body);
  width: auto;
  height: auto;
  cursor: pointer;
}
.hero-icon-btn.save:active { border-color: #fff; }
</style>
