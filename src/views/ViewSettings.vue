<script setup>
import { ref, computed, onMounted } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import { Check, Download, Upload, Music2 } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { usePlaylistsStore } from '@/stores/playlists';
import { usePrefsStore, ACCENT_SWATCHES } from '@/stores/prefs';
import { useProfileStore } from '@/stores/profile';
import { useActionSheetStore } from '@/stores/actionSheet';
import { THEMES } from '@/lib/themes';
import { SUPPORTED_LOCALES } from '@/lib/i18n';
import { haptics } from '@/lib/haptics';
import { exportToFile, readImportFile, importFromData, wipeAllData } from '@/lib/backup';
import { api, apiUrlWithProfile } from '@/lib/api';
import {
  startSpotifyAuth,
  getSpotifyAccessToken,
  isSpotifyConnected,
  clearSpotifyAuth,
  fetchLikedTracks,
  fetchUserPlaylists,
  fetchPlaylistTracks,
} from '@/lib/spotifyAuth';

const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const prefs = usePrefsStore();
const profile = useProfileStore();
const sheet = useActionSheetStore();

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

// ── Spotify import ────────────────────────────────────────────────
const spotifyClientId = ref('');
const spotifyConnected = ref(false);

// Playlist-by-URL
const spotifyUrl = ref('');
const spotifyCreatePlaylist = ref(true);

const spotifyUserPlaylists = ref([]);

// Shared import state
const spotifyImporting = ref(false);
const spotifyProgress = ref({ done: 0, total: 0, current: '', phase: '' });
const spotifyResult = ref(null);

onMounted(async () => {
  try {
    const { clientId, configured } = await api('/api/spotify/status');
    spotifyClientId.value = clientId || '';
    if (clientId && isSpotifyConnected()) {
      spotifyConnected.value = true;
      _refreshSpotifyInfo();
    }
  } catch {}
});

async function _refreshSpotifyInfo() {
  try {
    const token = await getSpotifyAccessToken(spotifyClientId.value);
    if (!token) { spotifyConnected.value = false; return; }
    const pls = await fetchUserPlaylists(token);
    spotifyUserPlaylists.value = pls;
  } catch {}
}

async function connectSpotify() {
  if (!spotifyClientId.value) return;
  haptics.light();
  await startSpotifyAuth(spotifyClientId.value);
}

function disconnectSpotify() {
  clearSpotifyAuth();
  spotifyConnected.value = false;
  spotifyLikedCount.value = null;
  spotifyUserPlaylists.value = [];
  spotifyResult.value = null;
}

async function _runImportJob(jobId) {
  spotifyResult.value = null;
  await new Promise((resolve, reject) => {
    const es = new EventSource(apiUrlWithProfile(`/api/jobs/${jobId}/progress`));
    es.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'progress') {
        spotifyProgress.value = { done: data.done || 0, total: data.total || 0, current: data.current || '', phase: data.phase || '' };
      } else if (data.type === 'ready') {
        es.close();
        spotifyResult.value = { imported: data.imported, skipped: data.skipped, total: data.total };
        resolve();
      } else if (data.type === 'error') {
        es.close();
        reject(new Error(data.error));
      }
    };
    es.onerror = () => { es.close(); reject(new Error('Connexion perdue')); };
  });
}

async function importByUrl() {
  const url = spotifyUrl.value.trim();
  if (!url || spotifyImporting.value) return;
  spotifyImporting.value = true;
  spotifyProgress.value = { done: 0, total: 0, current: '', phase: 'fetching' };
  try {
    const { id: jobId } = await api('/api/spotify/import', {
      method: 'POST',
      body: JSON.stringify({ url, createPlaylist: spotifyCreatePlaylist.value }),
    });
    await _runImportJob(jobId);
    haptics.success();
    lib.fetch();
    playlists.fetch();
    spotifyUrl.value = '';
    showToast({ message: `${spotifyResult.value.imported} titres importés`, position: 'bottom' });
  } catch (err) {
    haptics.error();
    showToast({ message: err.message, position: 'bottom', type: 'fail' });
    spotifyResult.value = null;
  } finally {
    spotifyImporting.value = false;
  }
}

async function importLiked() {
  if (spotifyImporting.value) return;
  spotifyImporting.value = true;
  spotifyProgress.value = { done: 0, total: 0, current: '', phase: 'fetching' };
  try {
    const token = await getSpotifyAccessToken(spotifyClientId.value);
    if (!token) throw new Error('Session Spotify expirée — reconnecte-toi');
    const tracks = await fetchLikedTracks(token);
    const { id: jobId } = await api('/api/spotify/import-tracks', {
      method: 'POST',
      body: JSON.stringify({ tracks, createPlaylist: true, playlistName: 'Titres aimés Spotify' }),
    });
    await _runImportJob(jobId);
    haptics.success();
    lib.fetch();
    playlists.fetch();
    showToast({ message: `${spotifyResult.value.imported} titres importés`, position: 'bottom' });
  } catch (err) {
    haptics.error();
    showToast({ message: err.message, position: 'bottom', type: 'fail' });
    spotifyResult.value = null;
  } finally {
    spotifyImporting.value = false;
  }
}

async function importUserPlaylist(pl) {
  if (spotifyImporting.value) return;
  spotifyImporting.value = true;
  spotifyProgress.value = { done: 0, total: 0, current: '', phase: 'fetching' };
  try {
    const token = await getSpotifyAccessToken(spotifyClientId.value);
    if (!token) throw new Error('Session Spotify expirée — reconnecte-toi');
    const tracks = await fetchPlaylistTracks(token, pl.id);
    const { id: jobId } = await api('/api/spotify/import-tracks', {
      method: 'POST',
      body: JSON.stringify({ tracks, createPlaylist: true, playlistName: pl.name }),
    });
    await _runImportJob(jobId);
    haptics.success();
    lib.fetch();
    playlists.fetch();
    showToast({ message: `${spotifyResult.value.imported} titres importés · "${pl.name}"`, position: 'bottom' });
  } catch (err) {
    haptics.error();
    showToast({ message: err.message, position: 'bottom', type: 'fail' });
    spotifyResult.value = null;
  } finally {
    spotifyImporting.value = false;
  }
}

const spotifyProgressPct = computed(() =>
  spotifyProgress.value.total ? Math.round((spotifyProgress.value.done / spotifyProgress.value.total) * 100) : 0
);
const spotifyProgressLabel = computed(() => {
  const p = spotifyProgress.value;
  if (p.phase === 'fetching') return 'Lecture de la playlist…';
  if (!p.total) return '';
  return `${p.done} / ${p.total}${p.current ? ` — ${p.current}` : ''}`;
});
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

    <!-- ── Spotify ───────────────────────────────────────────── -->
    <van-cell-group inset title="Spotify">
      <template v-if="!spotifyClientId">
        <van-cell title="Spotify non configuré">
          <template #label>
            <span class="spotify-hint">Ajoute WAX_SPOTIFY_CLIENT_ID et WAX_SPOTIFY_CLIENT_SECRET dans le .env</span>
          </template>
        </van-cell>
      </template>

      <template v-else>
        <!-- Connexion utilisateur (titres aimés + playlists privées) -->
        <van-cell
          v-if="!spotifyConnected"
          title="Connecter mon compte Spotify"
          is-link
          @click="connectSpotify"
        >
          <template #icon>
            <Music2 :size="18" :stroke-width="2" color="#1DB954" class="cell-icon" />
          </template>
        </van-cell>
        <template v-else>
          <van-cell title="Compte Spotify connecté" value="Déconnecter" is-link @click="disconnectSpotify">
            <template #icon>
              <Music2 :size="18" :stroke-width="2" color="#1DB954" class="cell-icon" />
            </template>
          </van-cell>
          <van-cell
            title="Importer mes titres aimés"
            :value="spotifyImporting ? '' : 'Importer'"
            is-link
            :disabled="spotifyImporting"
            @click="importLiked"
          />
          <van-cell
            v-for="pl in spotifyUserPlaylists"
            :key="pl.id"
            :title="pl.name"
            :value="`${pl.total} titres`"
            is-link
            :disabled="spotifyImporting"
            @click="importUserPlaylist(pl)"
          />
        </template>

        <!-- Import par URL (playlists publiques, pas besoin de connexion) -->
        <div class="spotify-url-section">
          <div class="spotify-url-label">Ou coller une URL de playlist publique</div>
          <div class="spotify-url-row">
            <input
              v-model="spotifyUrl"
              class="spotify-url-input"
              placeholder="https://open.spotify.com/playlist/…"
              :disabled="spotifyImporting"
            />
            <button
              class="spotify-url-btn"
              :disabled="!spotifyUrl || spotifyImporting"
              @click="importByUrl"
            >
              Importer
            </button>
          </div>
          <label class="spotify-pl-toggle">
            <input v-model="spotifyCreatePlaylist" type="checkbox" :disabled="spotifyImporting" />
            Créer une playlist Wax
          </label>
        </div>

        <!-- Progress -->
        <div v-if="spotifyImporting" class="spotify-progress">
          <van-progress
            :percentage="spotifyProgressPct"
            stroke-width="4"
            color="#1DB954"
            track-color="var(--border)"
          />
          <p class="spotify-progress-label">{{ spotifyProgressLabel }}</p>
        </div>

        <!-- Result -->
        <div v-if="spotifyResult && !spotifyImporting" class="spotify-result">
          {{ spotifyResult.imported }} importés · {{ spotifyResult.skipped }} non trouvés sur {{ spotifyResult.total }}
        </div>
      </template>
    </van-cell-group>

    <van-cell-group inset title="À propos">
      <van-cell title="Version" value="0.7.3" />
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

/* Spotify */
.spotify-hint { font-size: 12px; color: var(--text-muted); }

.spotify-url-section {
  padding: 12px 16px 6px;
  border-top: 1px solid var(--border);
}
.spotify-url-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.spotify-url-row {
  display: flex;
  gap: 8px;
}
.spotify-url-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
  min-width: 0;
}
.spotify-url-input::placeholder { color: var(--text-muted); }
.spotify-url-input:focus { border-color: #1DB954; }
.spotify-url-btn {
  background: #1DB954;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;
}
.spotify-url-btn:disabled { opacity: 0.45; cursor: default; }
.spotify-pl-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 10px;
  cursor: pointer;
}
.spotify-pl-toggle input[type="checkbox"] { accent-color: #1DB954; }

.spotify-progress {
  padding: 10px 16px 6px;
  border-top: 1px solid var(--border);
}
.spotify-progress-label {
  font-size: 12px;
  color: var(--text-muted);
  margin: 6px 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotify-result {
  padding: 10px 16px;
  font-size: 13px;
  color: #1DB954;
  border-top: 1px solid var(--border);
}
</style>
