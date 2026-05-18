<script setup>
import { computed, ref } from 'vue';
import { Check } from 'lucide-vue-next';
import { fmtDuration } from '@/lib/format';
import { apiUrl } from '@/lib/api';
import { modalState } from '@/lib/modal';
import { t } from '@/lib/i18n';

const props = defineProps({
  available: { type: Array, required: true },
  selection: { type: Set, required: true },
});

const filter = ref('');

const visible = computed(() => {
  if (!filter.value) return props.available;
  const q = filter.value.toLowerCase();
  return props.available.filter(
    (tr) =>
      tr.title.toLowerCase().includes(q) ||
      (tr.uploader || '').toLowerCase().includes(q),
  );
});

// Forced reactivity bump — Set mutations don't trigger Vue dependency
// tracking through getters, so we toggle this ref after every change.
const _bumpKey = ref(0);
function bump() {
  _bumpKey.value++;
  modalState.confirmEnabled = props.selection.size > 0;
  modalState.confirmLabel = props.selection.size === 0
    ? t('common.add')
    : t('common.add_n', props.selection.size);
}

function toggleTrack(tr) {
  if (props.selection.has(tr.id)) props.selection.delete(tr.id);
  else props.selection.add(tr.id);
  bump();
}
function selectAllVisible() {
  for (const tr of visible.value) props.selection.add(tr.id);
  bump();
}
function selectNoneVisible() {
  for (const tr of visible.value) props.selection.delete(tr.id);
  bump();
}

bump();
</script>

<template>
  <div class="bulk-wrap">
    <div class="bulk-toolbar">
      <van-search
        v-model="filter"
        :placeholder="t('modal.bulk_filter')"
        shape="round"
        clearable
      />
      <div class="bulk-meta">
        <span class="muted">
          {{ props.selection.size }} / {{ props.available.length }}
          <span style="display:none">{{ _bumpKey }}</span>
        </span>
        <div class="bulk-quick">
          <button type="button" class="link-btn" @click="selectAllVisible">{{ t('common.all') }}</button>
          <button type="button" class="link-btn" @click="selectNoneVisible">{{ t('common.none') }}</button>
        </div>
      </div>
    </div>

    <div class="bulk-list">
      <div v-if="visible.length === 0" class="empty-state small">
        <div class="hint">{{ t('modal.bulk_no_results') }}</div>
      </div>
      <button
        v-for="tr in visible"
        :key="tr.id"
        type="button"
        class="bulk-row"
        :class="{ selected: props.selection.has(tr.id) }"
        @click="toggleTrack(tr)"
      >
        <div class="bulk-thumb">
          <img v-if="tr.thumbnail" :src="apiUrl(tr.thumbnail)" alt="" loading="lazy" />
        </div>
        <div class="bulk-meta-col">
          <div class="bulk-title text-ellipsis">{{ tr.title }}</div>
          <div class="bulk-sub text-ellipsis">
            <span>{{ tr.uploader || '' }}</span>
            <span v-if="tr.duration"> · {{ fmtDuration(tr.duration) }}</span>
          </div>
        </div>
        <div class="bulk-check" :class="{ on: props.selection.has(tr.id) }">
          <Check v-if="props.selection.has(tr.id)" :size="14" :stroke-width="3" color="var(--bg)" />
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bulk-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 70vh;
}

.bulk-toolbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
}
.bulk-toolbar :deep(.van-search) {
  background: transparent;
  padding: 4px 0 0;
}
.bulk-toolbar :deep(.van-search__content) { background: var(--bg); }
.bulk-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 10px;
  font-size: 12px;
}
.muted { color: var(--text-muted); }
.bulk-quick { display: flex; gap: 8px; }
.link-btn {
  background: transparent;
  border: 0;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  padding: 4px 6px;
  cursor: pointer;
}

.bulk-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0 0;
  -webkit-overflow-scrolling: touch;
}

/* Rows sit inside the modal-body padding (no negative margins), so the
 * selected pill stays naturally inset from the modal walls. The row owns
 * the pill via background + border-radius — no pseudo gymnastics. */
.bulk-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: transparent;
  border: 0;
  border-radius: 12px;
  padding: 8px 12px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
  transition: background 120ms;
}
.bulk-row + .bulk-row { margin-top: 2px; }
.bulk-row:active { background: var(--card-hover); }
.bulk-row.selected { background: var(--accent-soft); }

.bulk-thumb {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--card-hover);
  flex: 0 0 auto;
}
.bulk-thumb img { width: 100%; height: 100%; object-fit: cover; }

.bulk-meta-col { flex: 1 1 auto; min-width: 0; }
.bulk-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}
.bulk-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.bulk-check {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid var(--border);
  display: grid;
  place-items: center;
  background: transparent;
  transition: background 120ms, border-color 120ms;
}
.bulk-check.on {
  background: var(--accent);
  border-color: var(--accent);
}

.empty-state.small { padding: 32px 16px; text-align: center; }
.empty-state.small .hint { font-size: 13px; color: var(--text-muted); }
</style>
