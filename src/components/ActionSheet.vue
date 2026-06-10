<script setup>
// Spotify-style fullscreen context sheet — replaces van-action-sheet.
// Gradient background pulled from the header cover's dominant color,
// optional cover + title + subtitle block, icon rows, centered close.
// Driven entirely by the actionSheet store (singleton, see store file).
import { ref, computed, watch } from 'vue';
import { useActionSheetStore } from '@/stores/actionSheet';
import { extractDominantColor } from '@/lib/extractColor';
import { apiUrl } from '@/lib/api';
import { haptics } from '@/lib/haptics';

const sheet = useActionSheetStore();

const coverSrc = computed(() =>
  sheet.header?.cover ? apiUrl(sheet.header.cover) : '',
);

// Dominant color of the header cover → top of the gradient. Neutral
// charcoal when there's no artwork (sort pickers, playlist lists…).
const tint = ref('#3a3a3a');
watch(
  () => [sheet.visible, coverSrc.value],
  async ([visible, src]) => {
    if (!visible) return;
    if (!src) { tint.value = '#3a3a3a'; return; }
    const hex = await extractDominantColor(src);
    tint.value = hex || '#3a3a3a';
  },
  { immediate: true },
);

const bgStyle = computed(() => ({
  background: `linear-gradient(180deg,
    color-mix(in srgb, ${tint.value} 60%, #1a1a1a) 0%,
    color-mix(in srgb, ${tint.value} 22%, var(--bg)) 38%,
    var(--bg) 78%)`,
}));

function pick(action, index) {
  if (action.disabled) return;
  haptics.light();
  sheet.onSelect(action, index);
}
function close() {
  haptics.light();
  sheet.onCancel();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="sheet.visible" class="as" :style="bgStyle">
        <div class="as-scroll">
          <header v-if="sheet.header" class="as-head">
            <div v-if="coverSrc" class="as-cover">
              <img :src="coverSrc" alt="" />
            </div>
            <div v-if="sheet.header.title" class="as-title">{{ sheet.header.title }}</div>
            <div v-if="sheet.header.subtitle" class="as-sub">{{ sheet.header.subtitle }}</div>
          </header>
          <div v-else class="as-spacer" />

          <div class="as-items" :class="{ 'no-icons': !sheet.actions.some((a) => a.icon) }">
            <button
              v-for="(a, i) in sheet.actions"
              :key="i"
              class="as-item"
              :class="{ disabled: a.disabled }"
              :style="a.color ? { color: a.color } : null"
              @click="pick(a, i)"
            >
              <component
                v-if="a.icon"
                :is="a.icon"
                class="as-icon"
                :size="22"
                :stroke-width="1.8"
              />
              <span class="as-label">{{ a.name }}</span>
            </button>
          </div>
        </div>

        <footer class="as-foot">
          <button class="as-close" @click="close">Fermer</button>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.as {
  position: fixed;
  inset: 0;
  /* Above the fullscreen player popup (van-popup ~2000+) so track menus
   * opened from anywhere always land on top; below ModalRoot (2100). */
  z-index: 2080;
  display: flex;
  flex-direction: column;
  color: var(--text);
}

.as-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: calc(var(--safe-top) + 24px) 0 12px;
  scrollbar-width: none;
}
.as-scroll::-webkit-scrollbar { display: none; }

.as-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 12px 32px 28px;
}
.as-cover {
  width: 132px;
  height: 132px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.3);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  margin-bottom: 18px;
}
.as-cover img { width: 100%; height: 100%; object-fit: cover; }
.as-title {
  font: 700 16px/1.3 var(--font-display);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as-sub {
  font: 500 13px/1.3 var(--font-body);
  color: rgba(255, 255, 255, 0.7);
  margin-top: 4px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as-spacer { height: 8vh; }

/* The action rows sit in a centered column — Spotify keeps them
 * left-aligned inside a comfortable inset. */
.as-items {
  max-width: 420px;
  margin: 0 auto;
  width: 100%;
  padding: 0 28px;
}
.as-item {
  display: flex;
  align-items: center;
  gap: 18px;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 14px 4px;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
}
.as-item:active { opacity: 0.6; }
.as-item.disabled { opacity: 0.4; cursor: default; }
.as-icon {
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.75);
}
.as-item[style*="color"] .as-icon { color: inherit; }
.as-label {
  font: 500 16px/1.3 var(--font-body);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.as-foot {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  padding: 12px 0 calc(var(--safe-bottom) + 22px);
}
.as-close {
  background: transparent;
  border: 0;
  color: var(--text);
  font: 700 16px/1 var(--font-display);
  padding: 14px 28px;
  border-radius: 999px;
  cursor: pointer;
}
.as-close:active { opacity: 0.6; }

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--motion-mid) var(--ease), transform var(--motion-mid) var(--ease);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
  transform: translateY(24px);
}
</style>
