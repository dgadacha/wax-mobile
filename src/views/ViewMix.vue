<script setup>
import { computed } from 'vue';
import { Bookmark, Sparkles } from 'lucide-vue-next';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { gradientFromString } from '@/lib/format';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';

const mix = useMixStore();
const view = useViewStore();
const streams = useStreamsStore();
const player = usePlayerStore();

const tracks = computed(() => {
  if (!mix.current) return [];
  return mix.current.queueIds
    .map((id) => streams.get(id))
    .filter(Boolean);
});

const queueIds = computed(() => mix.current?.queueIds || []);
const sourceTitle = computed(() => mix.current?.sourceTitle || 'Mix');
const cover = computed(() => tracks.value[0]?.thumbnail || '');
const bgGradient = computed(() => gradientFromString(sourceTitle.value));

const subtitle = computed(() => {
  const n = queueIds.value.length;
  if (!n) return '';
  return `${n} titres · Mix temporaire`;
});

function playAll() {
  if (queueIds.value.length === 0) return;
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
  <div v-if="mix.current" class="mix-view">
    <MobileHero
      :cover="cover"
      :bg-gradient="bgGradient"
      eyebrow="Mix"
      :title="`Mix : ${sourceTitle}`"
      :subtitle="subtitle"
      @play="playAll"
    >
      <template #actions>
        <button class="hero-icon-btn save" aria-label="Sauvegarder" @click="save">
          <Bookmark :size="16" :stroke-width="2.2" color="var(--bg)" />
          <span>Sauvegarder</span>
        </button>
      </template>
    </MobileHero>

    <div class="track-list">
      <MobileTrackCell
        v-for="(t, i) in tracks"
        :key="t.id"
        :track="t"
        :index="i"
        variant="thumb"
        :is-playing="player.currentTrack && player.currentTrack.id === t.id"
        :is-liked="false"
        :show-more="false"
        @play="playTrack(t)"
      />
    </div>
  </div>
  <div v-else class="empty-state">
    <Sparkles class="icon" :size="48" :stroke-width="1.5" />
    <div class="label">Aucun mix en cours</div>
    <div class="hint">Lance un mix depuis le menu « … » d'un titre.</div>
  </div>
</template>

<style scoped>
.mix-view { min-height: 100%; padding-bottom: 16px; }
.hero-icon-btn.save {
  background: var(--accent);
  color: var(--bg);
  border-radius: 999px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  border: 0;
  width: auto;
  height: auto;
}
</style>
