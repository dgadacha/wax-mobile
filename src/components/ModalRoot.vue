<script setup>
import { computed, watch, ref, nextTick, onUnmounted } from 'vue';
import { modalState, closeModal, confirmFromModal } from '@/lib/modal';
import { t } from '@/lib/i18n';
import { usePlayerStore } from '@/stores/player';

const inputRef = ref(null);
const player = usePlayerStore();

const isPrompt = computed(() => modalState.variant === 'prompt');
const isConfirm = computed(() => modalState.variant === 'confirm');
const isLyrics = computed(() => modalState.variant === 'lyrics');
const isComponent = computed(() => modalState.variant === 'component');

// Synced lyrics: highlight the line whose timestamp is closest-to-
// but-not-past the current audio time. Scroll the modal body so the
// active line stays centered. Disabled when no LRC data was found —
// modal falls back to the plain-text <pre> renderer.
const syncedLines = computed(() => modalState.lyricsSynced || []);
const isSynced = computed(() => isLyrics.value && syncedLines.value.length > 0);
const activeLineIdx = computed(() => {
  if (!isSynced.value) return -1;
  const t = player.currentTime;
  const lines = syncedLines.value;
  let lo = 0;
  let hi = lines.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
});

const syncedScrollRef = ref(null);
watch(activeLineIdx, async (idx) => {
  if (idx < 0) return;
  await nextTick();
  const container = syncedScrollRef.value;
  if (!container) return;
  const el = container.querySelector(`[data-idx="${idx}"]`);
  if (!el) return;
  // Scroll so the active line is centered. Smooth behaviour reads
  // as karaoke-natural, not abrupt.
  const cTop = container.getBoundingClientRect().top;
  const eTop = el.getBoundingClientRect().top;
  const delta = (eTop - cTop) - (container.clientHeight / 2 - el.clientHeight / 2);
  container.scrollBy({ top: delta, behavior: 'smooth' });
});

onUnmounted(() => {
  // No-op cleanup placeholder — watcher disposes on its own.
});

function onPromptKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    confirmFromModal();
  }
}

watch(
  () => modalState.visible,
  async (vis) => {
    if (vis && isPrompt.value) {
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  },
);
</script>

<template>
  <!-- Teleport to body so the modal escapes .app-shell's stacking context
       (which is position: fixed, creating one). Without this, the modal's
       z-index can't compete with van-popup elements that already teleport
       to body. -->
  <Teleport to="body">
    <div class="modal" v-show="modalState.visible">
      <div class="modal-overlay" @click="closeModal"></div>
    <div class="modal-content" :class="{ wide: modalState.wide }">
      <h3>{{ modalState.title }}</h3>
      <div class="modal-body">
        <p v-if="isConfirm" class="modal-message">{{ modalState.message }}</p>
        <div v-else-if="isPrompt">
          <p
            v-if="modalState.promptLabel"
            class="modal-message"
            style="margin-bottom: 12px"
          >
            {{ modalState.promptLabel }}
          </p>
          <input
            ref="inputRef"
            type="text"
            v-model="modalState.promptValue"
            :placeholder="modalState.promptPlaceholder"
            maxlength="100"
            @keydown="onPromptKey"
          />
        </div>
        <div v-else-if="isLyrics">
          <div class="lyrics-meta">
            {{ modalState.lyricsArtist }} — {{ modalState.lyricsTitle }}
          </div>
          <!-- Synced karaoke-style renderer when lrclib.net returned
               LRC for this track. Active line is highlighted +
               centered as the audio progresses. -->
          <div
            v-if="isSynced"
            ref="syncedScrollRef"
            class="lyrics-synced"
          >
            <div
              v-for="(line, i) in syncedLines"
              :key="i"
              :data-idx="i"
              class="lyrics-line"
              :class="{ active: i === activeLineIdx, past: i < activeLineIdx }"
            >{{ line.text }}</div>
          </div>
          <!-- Fallback: plain text without timing -->
          <pre
            v-else
            class="lyrics-content"
            :class="{
              placeholder: modalState.lyricsStatus === 'loading',
              error: modalState.lyricsStatus === 'error',
            }"
          >{{ modalState.lyricsContent }}</pre>
        </div>
        <component
          v-else-if="isComponent && modalState.component"
          :is="modalState.component"
          v-bind="modalState.componentProps || {}"
        />
      </div>
      <div class="modal-actions">
        <button class="secondary-btn" @click="closeModal">
          {{ modalState.cancelLabel || t('common.cancel') }}
        </button>
        <button
          v-if="modalState.onConfirm"
          class="primary-btn"
          :class="{ danger: modalState.danger }"
          :disabled="modalState.confirmEnabled === false"
          @click="confirmFromModal"
        >
          {{ modalState.confirmLabel || t('common.confirm') }}
        </button>
      </div>
    </div>
    </div>
  </Teleport>
</template>
