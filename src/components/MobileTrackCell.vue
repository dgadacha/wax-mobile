<script setup>
import { computed } from 'vue';
import { Heart, MoreHorizontal, Play, Check } from 'lucide-vue-next';
import { fmtDuration } from '@/lib/format';

const props = defineProps({
  track: { type: Object, required: true },
  // Show the leading numeric index (Spotify-style for albums / playlists).
  index: { type: Number, default: 0 },
  showIndex: { type: Boolean, default: false },
  // 'thumb' shows the cover art instead of the index.
  variant: { type: String, default: 'thumb' }, // 'thumb' | 'index'
  isPlaying: { type: Boolean, default: false },
  isLiked: { type: Boolean, default: false },
  // Show the heart icon on the right (omit on rows where like makes no sense).
  showLike: { type: Boolean, default: true },
  // Show the action-sheet trigger.
  showMore: { type: Boolean, default: true },
  // For missing-album-track rows that need to resolve before play.
  loading: { type: Boolean, default: false },
  // Visual desaturation for unmatched album rows.
  muted: { type: Boolean, default: false },
});

const emit = defineEmits(['play', 'like', 'more']);

const sub = computed(() => {
  const t = props.track;
  const bits = [];
  if (t.uploader) bits.push(t.uploader);
  if (t.duration) bits.push(fmtDuration(t.duration));
  return bits.join(' · ');
});
</script>

<template>
  <div
    class="mtc track-cell"
    :class="{
      'is-playing': isPlaying,
      'is-loading': loading,
      'is-muted': muted,
    }"
    @click="emit('play')"
  >
    <div v-if="variant === 'index' || showIndex" class="mtc-index">
      <van-loading v-if="loading" size="14" color="var(--accent)" />
      <Play v-else-if="isPlaying" :size="14" :stroke-width="2.5" color="var(--accent)" fill="var(--accent)" />
      <span v-else>{{ index + 1 }}</span>
    </div>

    <div v-if="variant === 'thumb'" class="thumb">
      <img v-if="track.thumbnail" :src="track.thumbnail" alt="" loading="lazy" />
    </div>

    <div class="meta">
      <div class="title">{{ track.title }}</div>
      <div class="sub">
        {{ sub }}
        <Check v-if="track.file" :size="11" :stroke-width="3" color="var(--success)" class="off-dot" />
      </div>
    </div>

    <div class="actions" @click.stop>
      <button
        v-if="showLike"
        class="mtc-btn"
        :aria-label="isLiked ? 'Retirer' : `J'aime`"
        @click="emit('like')"
      >
        <Heart
          :size="20"
          :stroke-width="2"
          :color="isLiked ? 'var(--accent)' : 'var(--text-muted)'"
          :fill="isLiked ? 'var(--accent)' : 'transparent'"
        />
      </button>
      <button
        v-if="showMore"
        class="mtc-btn"
        aria-label="Plus"
        @click="emit('more')"
      >
        <MoreHorizontal :size="20" :stroke-width="2" color="var(--text-muted)" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.mtc {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.mtc:active { background: var(--card-hover); }
.mtc.is-muted { opacity: 0.55; }

.mtc-index {
  width: 28px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.mtc.is-playing .mtc-index { color: var(--accent); }

.mtc .thumb {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.mtc .thumb img { width: 100%; height: 100%; object-fit: cover; }

.mtc .meta { flex: 1 1 auto; min-width: 0; }
.mtc .title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mtc.is-playing .title { color: var(--accent-bright); }
.mtc .sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mtc .off-dot { margin-left: 4px; vertical-align: middle; }

.mtc .actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}
.mtc-btn {
  width: 32px;
  height: 32px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.mtc-btn:active { background: rgba(255, 255, 255, 0.08); }
</style>
