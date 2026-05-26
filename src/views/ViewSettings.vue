<script setup>
import { ref, computed, onMounted } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Check, Download, Upload, HardDrive, RefreshCw, Trash2 } from 'lucide-vue-next';
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

// Storage bar percentage 0–100. Capped at 100 (quotas can shift).
const storagePct = computed(() => {
  if (!storageQuota.value || !storageUsage.value) return 0;
  return Math.min(100, Math.round((storageUsage.value / storageQuota.value) * 1000) / 10);
});

// Tap the storage card → refresh numbers + log cache diagnostic to
// console for power-user debugging. The dump used to live as a
// dedicated cell but it was visually loud; consigning it to console
// keeps the surface clean.
async function onTapStorageCard() {
  haptics.light();
  await refreshStorage();
  await refreshCacheDiagnostic();
  console.log('[settings] cache diagnostic:', cacheDiagnostic.value);
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

// Manual trigger for warmOfflineCache. Live progress shown in the
// cell value so the user can see something is actually happening
// (vs. a silent "Préparation…" → no visible change which doesn't
// distinguish "succeeded with cache already full" from "everything
// failed silently").
const warming = ref(false);
const warmingProgress = ref(''); // e.g. "12/92"
const warmingSummary = ref(''); // last summary like "92 prêts · 0 erreurs"
async function repairOfflineCache() {
  if (warming.value) return;
  warming.value = true;
  warmingProgress.value = '';
  warmingSummary.value = '';
  haptics.light();
  try {
    const result = await lib.warmOfflineCache((done, total) => {
      warmingProgress.value = total > 0 ? `${done}/${total}` : '';
    });
    await refreshStorage();
    // Detailed summary — important to surface failures so the user
    // knows when the server has lost a file.
    const parts = [`${result.cacheEntries} en cache`];
    if (result.fetched > 0) parts.push(`+${result.fetched} pré-téléchargés`);
    if (result.failed > 0) parts.push(`${result.failed} échec${result.failed > 1 ? 's' : ''}`);
    warmingSummary.value = parts.join(' · ');
    showToast({ message: warmingSummary.value, position: 'bottom' });
  } catch (e) {
    showToast({ message: 'Erreur : ' + (e.message || 'inconnue'), type: 'fail', position: 'bottom' });
  } finally {
    warming.value = false;
  }
}

// Diagnostic: list every cache + their entry count. Useful for
// proving "the cache is empty" vs. "the cache is full but Settings
// is reading the wrong name". Tap the cell to refresh.
const cacheDiagnostic = ref('');
async function refreshCacheDiagnostic() {
  if (typeof caches === 'undefined') {
    cacheDiagnostic.value = 'Cache API non supportée';
    return;
  }
  try {
    const names = await caches.keys();
    if (names.length === 0) {
      cacheDiagnostic.value = '(aucune)';
      return;
    }
    const parts = [];
    for (const n of names) {
      try {
        const c = await caches.open(n);
        const keys = await c.keys();
        parts.push(`${n}: ${keys.length}`);
      } catch {
        parts.push(`${n}: ?`);
      }
    }
    cacheDiagnostic.value = parts.join(' · ');
  } catch (e) {
    cacheDiagnostic.value = 'Erreur: ' + (e.message || 'inconnue');
  }
}

onMounted(() => { refreshStorage(); refreshCacheDiagnostic(); });

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

function pickQuality(b) {
  if (prefs.downloadQuality === b) return;
  haptics.selection();
  prefs.downloadQuality = b;
  prefs.save();
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
      <!-- Storage summary card: drive icon + count + size + progress
           bar. Replaces the old triple Cell stack (Cache audio /
           Espace utilisé / Diagnostic) which wrapped ugly on long
           values. Tap the bar to refresh the underlying numbers. -->
      <div class="storage-card" @click="onTapStorageCard">
        <div class="storage-card-row">
          <div class="storage-card-icon">
            <HardDrive :size="20" :stroke-width="1.8" color="var(--accent)" />
          </div>
          <div class="storage-card-meta">
            <div class="storage-card-title">{{ audioCacheCount }} titre{{ audioCacheCount > 1 ? 's' : '' }} hors-ligne</div>
            <div class="storage-card-sub">{{ fmtBytes(storageUsage) }}<span v-if="storageQuota"> sur {{ fmtBytes(storageQuota) }}</span></div>
          </div>
        </div>
        <div v-if="storageQuota" class="storage-bar">
          <div class="storage-bar-fill" :style="{ width: storagePct + '%' }" />
        </div>
      </div>

      <!-- MP3 download bitrate. 320 kbps is iTunes/Apple Music
           quality; 192 and 128 trade fidelity for storage. Persisted
           in prefs.downloadQuality, sent on every download POST. -->
      <van-cell title="Qualité du téléchargement" :value="prefs.downloadQuality + ' kbps'">
        <template #label>
          <div class="quality-chips">
            <button
              v-for="b in ['128', '192', '320']"
              :key="b"
              class="quality-chip"
              :class="{ active: prefs.downloadQuality === b }"
              @click="pickQuality(b)"
            >{{ b }} kbps</button>
          </div>
        </template>
      </van-cell>

      <van-cell
        :title="warming ? 'Vérification en cours' : 'Vérifier le cache'"
        :value="warming ? warmingProgress : (warmingSummary || 'Re-télécharger les manquants')"
        is-link
        @click="repairOfflineCache"
      >
        <template #icon>
          <RefreshCw
            :size="18"
            :stroke-width="2"
            :color="warming ? 'var(--accent)' : 'var(--text-muted)'"
            class="cell-icon"
            :class="{ 'spin-anim': warming }"
          />
        </template>
      </van-cell>

      <van-cell
        :title="clearing ? 'Suppression…' : 'Vider le cache audio'"
        is-link
        @click="clearAudioCache"
      >
        <template #icon>
          <Trash2 :size="18" :stroke-width="2" color="var(--danger)" class="cell-icon" />
        </template>
      </van-cell>
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
      <van-cell title="Version" value="0.13.4" />
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
.spin-anim { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Quality picker chips — three small pills laid out in a row
 * below the cell title. Active one fills with the accent. */
.quality-chips {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.quality-chip {
  flex: 1 1 0;
  padding: var(--sp-2) 0;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--motion-short) var(--ease);
}
.quality-chip.active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.quality-chip:active { transform: scale(0.97); }

/* Storage summary card — lives inside a van-cell-group so it picks
 * up the group's rounded corners. Padded enough to breathe; the
 * progress bar at the bottom gives an instant read of "how full". */
.storage-card {
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  background: var(--card);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.storage-card-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.storage-card-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--r-2);
  background: var(--accent-soft, rgba(124, 92, 255, 0.12));
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.storage-card-meta { min-width: 0; flex: 1 1 auto; }
.storage-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.storage-card-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 2px;
}
.storage-bar {
  margin-top: var(--sp-3);
  height: 6px;
  border-radius: 999px;
  background: var(--card-hover);
  overflow: hidden;
}
.storage-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width var(--motion-mid) var(--ease);
}

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
