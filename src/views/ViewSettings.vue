<script setup>
import { ref } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Check } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePrefsStore, ACCENT_SWATCHES } from '@/stores/prefs';
import { useProfileStore } from '@/stores/profile';
import { wipeAllData } from '@/lib/backup';

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const prefs = usePrefsStore();
const profile = useProfileStore();

async function onReset() {
  try {
    await showConfirmDialog({
      title: 'Tout effacer',
      message: 'Cette action supprime tous tes favoris, playlists et fichiers hors-ligne. Continuer ?',
      confirmButtonText: 'Effacer',
      cancelButtonText: 'Annuler',
      confirmButtonColor: 'var(--danger)',
    });
    await wipeAllData();
    showToast({ message: 'Données effacées', position: 'bottom' });
    setTimeout(() => location.reload(), 800);
  } catch { /* cancelled */ }
}

function pickAccent(hex) {
  prefs.setAccentColor(hex);
}

function changeProfile() {
  profile.openPicker();
}
</script>

<template>
  <div class="settings-view">
    <van-cell-group inset title="Profil">
      <van-cell
        :title="profile.activeProfile ? profile.activeProfile.name : 'Aucun profil'"
        value="Changer"
        is-link
        @click="changeProfile"
      >
        <template #icon>
          <div
            class="profile-pill"
            :style="{ background: profile.activeProfile?.color || 'var(--card-hover)' }"
          >
            {{ (profile.activeProfile?.name || '?')[0]?.toUpperCase() }}
          </div>
        </template>
      </van-cell>
    </van-cell-group>

    <van-cell-group inset title="Apparence">
      <div class="accent-row">
        <button
          v-for="s in ACCENT_SWATCHES"
          :key="s.id"
          class="swatch"
          :style="{ background: s.hex }"
          :aria-label="s.label"
          @click="pickAccent(s.hex)"
        >
          <Check
            v-if="prefs.accentColor.toLowerCase() === s.hex.toLowerCase()"
            :size="16"
            :stroke-width="3"
            color="#fff"
          />
        </button>
      </div>
    </van-cell-group>

    <van-cell-group inset title="Bibliothèque">
      <van-cell title="Favoris" :value="lib.favorites.length + ' titres'" />
      <van-cell title="Playlists" :value="playlists.items.length + ''" />
    </van-cell-group>

    <van-cell-group inset title="À propos">
      <van-cell title="Version" value="0.3.5" />
      <van-cell title="Backend" :value="'proxy local'" />
    </van-cell-group>

    <van-cell-group inset title="Danger">
      <van-cell title="Tout effacer" is-link @click="onReset" />
    </van-cell-group>
  </div>
</template>

<style scoped>
.settings-view {
  padding-top: 12px;
  padding-bottom: 20px;
}
.settings-view :deep(.van-cell-group__title) {
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.settings-view :deep(.van-cell-group--inset) {
  margin: 12px 12px 16px;
  border-radius: 12px;
  background: var(--card);
  overflow: hidden;
}
.settings-view :deep(.van-cell) {
  background: transparent;
  color: var(--text);
}
.settings-view :deep(.van-cell__title) { color: var(--text); }
.settings-view :deep(.van-cell__value) { color: var(--text-muted); }

.accent-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 16px;
  justify-content: center;
}
.swatch {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 0.15s ease;
}
.swatch:active { transform: scale(0.92); }

.profile-pill {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  margin-right: 12px;
}
</style>
