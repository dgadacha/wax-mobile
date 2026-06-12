<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Download, Upload, HardDrive, RefreshCw, Trash2, Sparkles, Moon, ChevronRight, LogOut } from 'lucide-vue-next';
import { useViewStore } from '@/stores/view';
import { usePlayerStore } from '@/stores/player';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePrefsStore } from '@/stores/prefs';
import { useProfileStore } from '@/stores/profile';
import { useActionSheetStore } from '@/stores/actionSheet';
import { useAuthStore } from '@/stores/auth';
import { SUPPORTED_LOCALES } from '@/lib/i18n';
import { haptics } from '@/lib/haptics';
import { exportToFile, readImportFile, importFromData, wipeAllData } from '@/lib/backup';

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const prefs = usePrefsStore();
const profile = useProfileStore();
const sheet = useActionSheetStore();
const auth = useAuthStore();
const view = useViewStore();
const player = usePlayerStore();

// Injected by vite.config.js `define` from package.json so the About
// card always tracks the current version — no more updating the
// literal by hand on every bump.
const appVersion = __APP_VERSION__;

function openWrapped() {
  haptics.light();
  view.switchTo('wrapped');
}

// ── Sleep timer ───────────────────────────────────────────────────
const SLEEP_OPTIONS = [5, 10, 15, 30, 45, 60];
async function pickSleepTimer() {
  haptics.light();
  try {
    const { index } = await sheet.open([
      ...SLEEP_OPTIONS.map((m) => ({ name: `Arrêter dans ${m} min` })),
      { name: 'Désactiver', color: 'var(--danger)' },
    ]);
    if (index < SLEEP_OPTIONS.length) {
      player.setSleepTimer(SLEEP_OPTIONS[index]);
      showToast({ message: `Lecture arrêtée dans ${SLEEP_OPTIONS[index]} min`, position: 'bottom' });
    } else {
      player.cancelSleepTimer();
      showToast({ message: 'Minuteur désactivé', position: 'bottom' });
    }
  } catch {}
}
// Live "X min restantes" label — recomputed every 10 s so the user
// sees the countdown decrement without us setting up our own
// per-second tick. `_now` is the throttled reactive that drives it.
const _now = ref(Date.now());
let _nowTimer = null;
onMounted(() => {
  _nowTimer = setInterval(() => { _now.value = Date.now(); }, 10000);
});
onBeforeUnmount(() => { if (_nowTimer) clearInterval(_nowTimer); });
const sleepLabel = computed(() => {
  if (!player.sleepEndAt) return 'Désactivé';
  const remainingMs = player.sleepEndAt - _now.value;
  if (remainingMs <= 0) return 'Désactivé';
  const mins = Math.max(1, Math.ceil(remainingMs / 60000));
  return `${mins} min restantes`;
});

// Playback rate moved out of Settings — see the speed bottom-sheet
// in MobilePlayer (tap the 1× button in np-extras). Settings keeps
// the player store import for the sleep timer state.

function reopenOnboarding() {
  haptics.light();
  // App.vue listens to this and re-opens the overlay with `rerun=true`.
  window.dispatchEvent(new CustomEvent('wax:reopen-onboarding'));
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

// EQ presets — one-tap settings for common genres + a flat baseline.
// Values are biquad gain in dB (matches the ±12 dB range of the
// existing sliders). Targets a "feels right" balance — Bass+ is
// punchy without muddying, Vocal pushes mids without thinning, etc.
// Lifted from the iTunes preset cohort which most users know.
const EQ_PRESETS = [
  { id: 'flat',     label: 'Plat',       bass: 0,  mid: 0,  treble: 0 },
  { id: 'bass',     label: 'Basses+',    bass: 6,  mid: 0,  treble: -1 },
  { id: 'vocal',    label: 'Vocal',      bass: -2, mid: 4,  treble: 2 },
  { id: 'acoustic', label: 'Acoustique', bass: 2,  mid: 3,  treble: 4 },
  { id: 'rock',     label: 'Rock',       bass: 4,  mid: -1, treble: 4 },
  { id: 'electro',  label: 'Électro',    bass: 5,  mid: -2, treble: 5 },
];
const activePreset = computed(() => {
  // A preset is active if all three values exactly match. Manual
  // slider adjustments leave the chip set unselected — visual
  // signal that the user has tweaked beyond the preset.
  const e = prefs.eq;
  return EQ_PRESETS.find(
    (p) => p.bass === (e.bass || 0) && p.mid === (e.mid || 0) && p.treble === (e.treble || 0),
  )?.id || '';
});
function pickEqPreset(p) {
  haptics.selection();
  prefs.eq = { bass: p.bass, mid: p.mid, treble: p.treble };
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
    // The warmer caps each run (iOS memory safety) — tell the user to
    // re-tap when there's more to do.
    if (result.remaining > 0) parts.push(`${result.remaining} restant${result.remaining > 1 ? 's' : ''} · re-tape pour continuer`);
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

function toggleWifiOnly(v) {
  haptics.selection();
  prefs.downloadsWifiOnly = v;
  prefs.save();
  // If switching OFF and there are queued requests, drain them
  // now — user explicitly said "I want them regardless of network".
  if (!v) lib._drainWifiQueue(true);
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
    <!-- Profile row — avatar + name + "Changer de profil", Spotify's
         settings header. -->
    <button class="profile-row" @click="changeProfile">
      <div
        class="profile-avatar"
        :style="{ background: profile.activeProfile?.color || 'var(--card-hover)' }"
      >
        {{ (profile.activeProfile?.name || '?')[0]?.toUpperCase() }}
      </div>
      <div class="profile-meta">
        <div class="profile-name">{{ profile.activeProfile ? profile.activeProfile.name : 'Aucun profil' }}</div>
        <div class="profile-hint">Changer de profil</div>
      </div>
      <ChevronRight :size="20" :stroke-width="2" color="var(--text-muted)" />
    </button>

    <van-cell-group inset title="Langue">
      <van-cell
        title="Langue"
        :value="SUPPORTED_LOCALES.find((l) => l.id === prefs.locale)?.label || prefs.locale"
        is-link
        @click="pickLocale"
      />
    </van-cell-group>

    <van-cell-group inset title="Égaliseur">
      <!-- Preset chips — tap to load preset values into bass/mid/treble.
           Active chip highlights when sliders exactly match a preset;
           any manual adjustment de-selects them. -->
      <div class="eq-presets">
        <button
          v-for="p in EQ_PRESETS"
          :key="p.id"
          class="eq-preset"
          :class="{ active: activePreset === p.id }"
          @click="pickEqPreset(p)"
        >{{ p.label }}</button>
      </div>
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

    <!-- Lecture — sleep timer + playback speed. Lives above the
         library section because both are playback-related controls
         the user reaches for during a listening session, not
         "library admin". -->
    <van-cell-group inset title="Lecture">
      <van-cell
        title="Minuteur de sommeil"
        :value="sleepLabel"
        is-link
        @click="pickSleepTimer"
      >
        <template #icon>
          <Moon :size="18" :stroke-width="2" :color="player.sleepEndAt ? 'var(--accent)' : 'var(--text-muted)'" class="cell-icon" />
        </template>
      </van-cell>

    </van-cell-group>

    <van-cell-group inset title="Bibliothèque">
      <van-cell title="Favoris" :value="lib.favorites.length + ' titres'" />
      <van-cell title="Playlists" :value="playlists.items.length + ''" />
      <!-- "Wrapped" recap — Spotify-style stat slide of top tracks
           + artists + total listening time. Computed locally from
           playCount / addedAt / lastPlayedAt; no server call. -->
      <van-cell
        title="Ta sélection"
        value="Voir mes stats"
        is-link
        @click="openWrapped"
      >
        <template #icon>
          <Sparkles :size="18" :stroke-width="2" color="var(--accent)" class="cell-icon" />
        </template>
      </van-cell>
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

      <!-- Wi-Fi only toggle. When ON, downloadTrack defers cellular
           requests to a local queue and drains it on the next online
           event with Wi-Fi. Useful for capped data plans (NC, DOM-TOM,
           travelers on roaming). -->
      <van-cell title="Wi-Fi uniquement" center>
        <template #value>
          <van-switch
            :model-value="prefs.downloadsWifiOnly"
            size="20"
            @update:model-value="toggleWifiOnly"
          />
        </template>
        <template #label>
          <span class="cell-hint">
            Met en attente les téléchargements quand tu es en data mobile.
          </span>
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

    <van-cell-group inset title="Aide">
      <!-- Re-open the 3-screen onboarding intro. Useful for users
           who skipped it on install, or to remind them of the
           multi-profile / offline features they may have forgotten.
           Implementation: window event picked up by App.vue, which
           clears the localStorage flag and re-mounts the overlay
           with `rerun: true` (last-screen button reads "Fermer"
           instead of "Commencer"). -->
      <van-cell
        title="Revoir l'introduction"
        is-link
        @click="reopenOnboarding"
      />
    </van-cell-group>

    <van-cell-group inset title="À propos">
      <van-cell title="Version" :value="appVersion" />
      <van-cell title="Backend" :value="'proxy local'" />
    </van-cell-group>

    <van-cell-group inset title="Danger">
      <van-cell title="Tout effacer" is-link @click="onReset" />
    </van-cell-group>

    <!-- Spotify-style outlined logout pill at the very bottom. Only
         renders when the server's auth gate is active — without it,
         signing out would be a no-op. -->
    <div v-if="auth.authEnabled" class="logout-row">
      <button class="logout-pill" @click="onLogout">
        <LogOut :size="16" :stroke-width="2.2" />
        <span>Se déconnecter</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  padding-top: 4px;
  padding-bottom: 20px;
}
/* Spotify settings: flat list on the page background — bold white
 * section headers, plain rows, no inset cards. */
.settings-view :deep(.van-cell-group__title) {
  color: var(--text);
  font: 700 16px/1.2 var(--font-display);
  text-transform: none;
  letter-spacing: -0.2px;
  padding: 20px 16px 6px;
}
.settings-view :deep(.van-cell-group--inset) {
  margin: 0 0 8px;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}
.settings-view :deep(.van-cell) {
  background: transparent;
  color: var(--text);
  padding: 13px 16px;
}
.settings-view :deep(.van-cell::after) { display: none; }
.settings-view :deep(.van-cell__title) {
  color: var(--text);
  font: 500 15px/1.3 var(--font-body);
}
.settings-view :deep(.van-cell__value) {
  color: var(--text-muted);
  font: 400 13px/1.3 var(--font-body);
}
.cell-icon { margin-right: 10px; }
.spin-anim { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Profile header row */
.profile-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 14px 16px;
  cursor: pointer;
  text-align: left;
}
.profile-row:active { background: rgba(255, 255, 255, 0.06); }
.profile-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font: 800 22px/1 var(--font-display);
  color: #fff;
  flex: 0 0 auto;
}
.profile-meta { flex: 1 1 auto; min-width: 0; }
.profile-name {
  font: 700 16px/1.2 var(--font-display);
  color: var(--text);
}
.profile-hint {
  font: 400 13px/1.3 var(--font-body);
  color: var(--text-muted);
  margin-top: 3px;
}

/* Logout pill */
.logout-row {
  display: flex;
  justify-content: center;
  padding: 24px 16px 12px;
}
.logout-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: var(--text);
  border-radius: 999px;
  padding: 11px 24px;
  font: 700 14px/1.2 var(--font-display);
  cursor: pointer;
}
.logout-pill:active { border-color: #fff; transform: scale(0.97); }

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
  color: var(--on-accent);
  border-color: var(--accent);
}
.quality-chip:active { transform: scale(0.97); }


/* Inline cell hint — small grey explanatory text under a Vant cell's
 * title, used to spell out toggle behaviour ("Met en attente quand
 * tu es en data mobile"). */
.cell-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* Storage summary card — lives inside a van-cell-group so it picks
 * up the group's rounded corners. Padded enough to breathe; the
 * progress bar at the bottom gives an instant read of "how full". */
.storage-card {
  margin: 4px 16px 10px;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  background: var(--card);
  border-radius: 10px;
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

/* EQ preset chips — horizontal scroll row above the sliders.
 * Active chip fills with accent. Pill shape matches the rest of
 * the chip vocabulary in the app (library filter chips, theme
 * picker, etc.). */
.eq-presets {
  display: flex;
  gap: var(--sp-2);
  overflow-x: auto;
  padding: var(--sp-3) var(--sp-4);
  scrollbar-width: none;
}
.eq-presets::-webkit-scrollbar { display: none; }
.eq-preset {
  flex: 0 0 auto;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--motion-short) var(--ease);
}
.eq-preset.active {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
.eq-preset:active { transform: scale(0.96); }

/* EQ sliders */
.eq-row {
  display: grid;
  grid-template-columns: 70px 1fr 36px;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}
.eq-label { font-size: 13px; color: var(--text); }
.eq-value {
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
</style>
