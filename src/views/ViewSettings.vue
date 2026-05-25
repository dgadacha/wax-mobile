<script setup>
import { ref, computed, onMounted } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Check, Download, Upload, HardDrive } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePrefsStore, ACCENT_SWATCHES } from '@/stores/prefs';
import { useProfileStore } from '@/stores/profile';
import { useActionSheetStore } from '@/stores/actionSheet';
import { useAuthStore } from '@/stores/auth';
import { THEMES } from '@/lib/themes';
import { SUPPORTED_LOCALES } from '@/lib/i18n';
import { haptics } from '@/lib/haptics';
import { exportToFile, readImportFile, importFromData, wipeAllData } from '@/lib/backup';

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const prefs = usePrefsStore();
const profile = useProfileStore();
const sheet = useActionSheetStore();
const auth = useAuthStore();

// ── Theme picker ──────────────────────────────────────────────────
const darkThemes = computed(() => THEMES.filter((t) => t.kind === 'dark'));
const lightThemes = computed(() => THEMES.filter((t) => t.kind === 'light'));
function pickTheme(id) {
  haptics.selection();
  prefs.setTheme(id);
}

function pickAccent(hex) {
  haptics.selection();
  prefs.setAccentColor(hex);
}

// ── Language picker ───────────────────────────────────────────────
async function pickLocale() {
  try {
    const { index } = await sheet.open(
      SUPPORTED_LOCALES.map((l) => ({ name: l.label, _id: l.id })),
    );
    const id = SUPPORTED_LOCALES[index].id;
    haptics.selection();
    prefs.setLocale(id);
  } catch {}
}

// ── EQ ────────────────────────────────────────────────────────────
const eqBass = computed({
  get: () => prefs.eq.bass || 0,
  set: (v) => { prefs.eq = { ...prefs.eq, bass: v }; prefs.save(); },
});
const eqMid = computed({
  get: () => prefs.eq.mid || 0,
  set: (v) => { prefs.eq = { ...prefs.eq, mid: v }; prefs.save(); },
});
const eqTreble = computed({
  get: () => prefs.eq.treble || 0,
  set: (v) => { prefs.eq = { ...prefs.eq, treble: v }; prefs.save(); },
});
function resetEq() {
  haptics.light();
  prefs.eq = { bass: 0, mid: 0, treble: 0 };
  prefs.save();
}

// ── Backup ────────────────────────────────────────────────────────
const exporting = ref(false);
const importing = ref(false);
const fileInput = ref(null);

async function onExport() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await exportToFile();
    haptics.success();
    showToast({ message: 'Export généré', position: 'bottom' });
  } catch (e) {
    haptics.error();
    showToast({ message: 'Export raté : ' + e.message, position: 'bottom', type: 'fail' });
  } finally { exporting.value = false; }
}

function triggerImport() {
  fileInput.value?.click();
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const data = await readImportFile(file);
    await importFromData(data);
    haptics.success();
    showToast({ message: 'Import réussi', position: 'bottom' });
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    haptics.error();
    showToast({ message: 'Import raté : ' + err.message, position: 'bottom', type: 'fail' });
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

// ── Offline storage ───────────────────────────────────────────────
const storageUsage = ref(null);   // bytes
const storageQuota = ref(null);   // bytes
const audioCacheCount = ref(0);
const clearing = ref(false);

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function refreshStorage() {
  // navigator.storage.estimate() returns the total used by ALL origins
  // for this app (cache + indexedDB + localStorage). Good enough as a
  // proxy for "how much downloaded music is taking up".
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      storageUsage.value = est.usage;
      storageQuota.value = est.quota;
    }
  } catch {}
  // Count entries in the wax-audio cache directly — gives us the exact
  // number of cached tracks (more meaningful than the global usage).
  try {
    if ('caches' in window) {
      const cache = await caches.open('wax-audio');
      const keys = await cache.keys();
      audioCacheCount.value = keys.length;
    }
  } catch {}
}

async function clearAudioCache() {
  try {
    await showConfirmDialog({
      title: 'Vider le cache audio',
      message: `Supprimer les ${audioCacheCount.value} titre${audioCacheCount.value > 1 ? 's' : ''} en cache sur ce téléphone ? Les MP3 restent côté serveur — un nouvel appui sur Lire les re-téléchargera.`,
      confirmButtonText: 'Vider',
      cancelButtonText: 'Annuler',
      confirmButtonColor: 'var(--danger)',
    });
    clearing.value = true;
    haptics.warning();
    await caches.delete('wax-audio');
    await refreshStorage();
    showToast({ message: 'Cache audio vidé', position: 'bottom' });
  } catch { /* cancelled or no cache API */ }
  finally { clearing.value = false; }
}

onMounted(refreshStorage);

// ── Danger zone ───────────────────────────────────────────────────
async function onReset() {
  try {
    await showConfirmDialog({
      title: 'Tout effacer',
      message: 'Cette action supprime tous tes favoris, playlists et fichiers hors-ligne. Continuer ?',
      confirmButtonText: 'Effacer',
      cancelButtonText: 'Annuler',
      confirmButtonColor: 'var(--danger)',
    });
    haptics.warning();
    await wipeAllData();
    showToast({ message: 'Données effacées', position: 'bottom' });
    setTimeout(() => location.reload(), 800);
  } catch { /* cancelled */ }
}

function changeProfile() {
  haptics.light();
  profile.openPicker();
}

async function onLogout() {
  try {
    await showConfirmDialog({
      title: 'Déconnexion',
      message: 'Te déconnecter ? Tu auras besoin de tes identifiants à la prochaine ouverture.',
      confirmButtonText: 'Déconnexion',
      cancelButtonText: 'Annuler',
    });
    haptics.warning();
    auth.logout();
    // Reload so the bootstrap state is wiped and the gate re-renders
    // from a clean slate.
    location.reload();
  } catch { /* cancelled */ }
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
      <!-- Logout cell only renders when the server's auth gate is active.
           Without it, signing out would be a no-op (the next call would
           still go through). -->
      <van-cell
        v-if="auth.authEnabled"
        title="Déconnexion"
        value=""
        is-link
        @click="onLogout"
      />
    </van-cell-group>

    <van-cell-group inset title="Apparence">
      <van-cell title="Thème" :value="darkThemes.find((t) => t.id === prefs.themeId)?.id || lightThemes.find((t) => t.id === prefs.themeId)?.id || '—'" />
      <div class="theme-section">
        <div class="theme-row-label">Sombres</div>
        <div class="theme-grid">
          <button
            v-for="t in darkThemes"
            :key="t.id"
            class="theme-pill"
            :class="{ active: prefs.themeId === t.id }"
            :aria-label="t.id"
            @click="pickTheme(t.id)"
          >
            <span class="stripe" :style="{ background: t.swatch[0] }" />
            <span class="stripe" :style="{ background: t.swatch[1] }" />
            <span class="stripe" :style="{ background: t.swatch[2] }" />
            <Check v-if="prefs.themeId === t.id" class="theme-pill-check" :size="14" :stroke-width="3" color="#fff" />
          </button>
        </div>
        <div class="theme-row-label">Clairs</div>
        <div class="theme-grid">
          <button
            v-for="t in lightThemes"
            :key="t.id"
            class="theme-pill"
            :class="{ active: prefs.themeId === t.id }"
            :aria-label="t.id"
            @click="pickTheme(t.id)"
          >
            <span class="stripe" :style="{ background: t.swatch[0] }" />
            <span class="stripe" :style="{ background: t.swatch[1] }" />
            <span class="stripe" :style="{ background: t.swatch[2] }" />
            <Check v-if="prefs.themeId === t.id" class="theme-pill-check" :size="14" :stroke-width="3" color="#fff" />
          </button>
        </div>
      </div>
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

    <van-cell-group inset title="Langue">
      <van-cell
        title="Langue"
        :value="SUPPORTED_LOCALES.find((l) => l.id === prefs.locale)?.label || prefs.locale"
        is-link
        @click="pickLocale"
      />
    </van-cell-group>

    <van-cell-group inset title="Égaliseur">
      <div class="eq-row">
        <span class="eq-label">Basses</span>
        <van-slider
          v-model="eqBass"
          :min="-12"
          :max="12"
          :step="1"
          bar-height="4px"
          active-color="var(--accent)"
          inactive-color="var(--border)"
        />
        <span class="eq-value">{{ eqBass > 0 ? '+' : '' }}{{ eqBass }}</span>
      </div>
      <div class="eq-row">
        <span class="eq-label">Médiums</span>
        <van-slider
          v-model="eqMid"
          :min="-12"
          :max="12"
          :step="1"
          bar-height="4px"
          active-color="var(--accent)"
          inactive-color="var(--border)"
        />
        <span class="eq-value">{{ eqMid > 0 ? '+' : '' }}{{ eqMid }}</span>
      </div>
      <div class="eq-row">
        <span class="eq-label">Aigus</span>
        <van-slider
          v-model="eqTreble"
          :min="-12"
          :max="12"
          :step="1"
          bar-height="4px"
          active-color="var(--accent)"
          inactive-color="var(--border)"
        />
        <span class="eq-value">{{ eqTreble > 0 ? '+' : '' }}{{ eqTreble }}</span>
      </div>
      <van-cell title="Réinitialiser" is-link @click="resetEq" />
    </van-cell-group>

    <van-cell-group inset title="Bibliothèque">
      <van-cell title="Favoris" :value="lib.favorites.length + ' titres'" />
      <van-cell title="Playlists" :value="playlists.items.length + ''" />
    </van-cell-group>

    <van-cell-group inset title="Hors-ligne">
      <van-cell
        title="Cache audio"
        :value="audioCacheCount + ' titre' + (audioCacheCount > 1 ? 's' : '')"
      >
        <template #icon>
          <HardDrive :size="18" :stroke-width="2" color="var(--text-muted)" class="cell-icon" />
        </template>
      </van-cell>
      <van-cell
        title="Espace utilisé"
        :value="fmtBytes(storageUsage) + (storageQuota ? ' / ' + fmtBytes(storageQuota) : '')"
      />
      <van-cell
        title="Vider le cache audio"
        :value="clearing ? 'En cours…' : ''"
        is-link
        @click="clearAudioCache"
      />
    </van-cell-group>

    <van-cell-group inset title="Sauvegarde">
      <van-cell
        title="Exporter"
        :value="exporting ? 'Export…' : ''"
        is-link
        @click="onExport"
      >
        <template #icon>
          <Download :size="18" :stroke-width="2" color="var(--text-muted)" class="cell-icon" />
        </template>
      </van-cell>
      <van-cell
        title="Importer"
        :value="importing ? 'Import…' : ''"
        is-link
        @click="triggerImport"
      >
        <template #icon>
          <Upload :size="18" :stroke-width="2" color="var(--text-muted)" class="cell-icon" />
        </template>
      </van-cell>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        style="display: none"
        @change="onImportFile"
      />
    </van-cell-group>

    <van-cell-group inset title="À propos">
      <van-cell title="Version" value="0.9.3" />
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
.cell-icon { margin-right: 10px; }

/* Theme picker */
.theme-section { padding: 4px 16px 14px; }
.theme-row-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-muted);
  margin: 12px 0 8px;
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}
.theme-pill {
  position: relative;
  height: 44px;
  border-radius: 10px;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  overflow: hidden;
  padding: 0;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.theme-pill:active { transform: scale(0.94); }
.theme-pill.active { border-color: var(--accent); }
.theme-pill .stripe { flex: 1 1 0; height: 100%; }
.theme-pill-check {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}

/* Accent swatches (kept from before) */
.accent-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 6px 16px 16px;
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

/* Profile pill in the Profil cell */
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

/* EQ sliders */
.eq-row {
  display: grid;
  grid-template-columns: 70px 1fr 36px;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.eq-row:last-of-type { border-bottom: 0; }
.eq-label { font-size: 13px; color: var(--text); }
.eq-value {
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
</style>
