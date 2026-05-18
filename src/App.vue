<script setup>
import { onMounted, computed, watch } from 'vue';
import { showToast as vantToast } from 'vant';

import { House, Search, Library, Settings, ChevronLeft } from 'lucide-vue-next';
import MobilePlayer from './components/MobilePlayer.vue';
import ModalRoot from './components/ModalRoot.vue';
import ProfileGate from './components/ProfileGate.vue';

import ViewHome from './views/ViewHome.vue';
import ViewSearch from './views/ViewSearch.vue';
import ViewLibrary from './views/ViewLibrary.vue';
import ViewSettings from './views/ViewSettings.vue';
import ViewPlaylist from './views/ViewPlaylist.vue';
import ViewAlbum from './views/ViewAlbum.vue';
import ViewArtist from './views/ViewArtist.vue';
import ViewMix from './views/ViewMix.vue';

import { useLibraryStore } from './stores/library';
import { usePlaylistsStore } from './stores/playlists';
import { useViewStore } from './stores/view';
import { usePlayerStore } from './stores/player';
import { usePrefsStore } from './stores/prefs';
import { useDiscoverStore } from './stores/discover';
import { useProfileStore } from './stores/profile';
import { useActionSheetStore } from './stores/actionSheet';
import { haptics } from './lib/haptics';
import { closeModal, modalState } from './lib/modal';

const library = useLibraryStore();
const playlists = usePlaylistsStore();
const view = useViewStore();
const player = usePlayerStore();
const prefs = usePrefsStore();
const discover = useDiscoverStore();
const profile = useProfileStore();
const actionSheet = useActionSheetStore();

// Top-level tab routes. Detail views (playlist, album, artist, mix) are
// pushed on top of these and the active tab is whatever spawned them.
const TABS = [
  { id: 'home',     label: 'Accueil',      icon: House },
  { id: 'download', label: 'Rechercher',   icon: Search },
  { id: 'library',  label: 'Bibliothèque', icon: Library },
  { id: 'settings', label: 'Réglages',     icon: Settings },
];

// Sub-views inherit their parent tab so the tab bar highlights stay coherent
// as the user drills down into details.
const SUBVIEW_PARENT = {
  playlist: 'library',
  album:    'library',
  artist:   'library',
  mix:      'download',
};

const activeTab = computed({
  get: () => SUBVIEW_PARENT[view.name] || view.name,
  set: (id) => {
    if (view.name === id) return;
    haptics.selection();
    view.switchTo(id);
  },
});

const isSubview = computed(() => !!SUBVIEW_PARENT[view.name]);

const navTitle = computed(() => {
  switch (view.name) {
    case 'home':     return 'Accueil';
    case 'download': return 'Rechercher';
    case 'library':  return 'Bibliothèque';
    case 'settings': return 'Réglages';
    case 'artist':   return view.selectedArtist || 'Artiste';
    case 'album':    return 'Album';
    case 'playlist': return playlists.items.find(p => p.id === view.selectedPlaylistId)?.name || 'Playlist';
    case 'mix':      return 'Mix';
    default:         return 'Wax';
  }
});

// On the top-level tabs Spotify hides the title (the view renders its own
// big heading) — keep the title visible only on sub-views so the user has a
// stable "where am I" affordance.
const showNavTitle = computed(() => isSubview.value);

watch(() => player.playing, (playing) => {
  document.body.dataset.playing = playing ? 'true' : 'false';
}, { immediate: true });

// Land on Home for new sessions; legacy view stores may have persisted
// 'download' as the default.
onMounted(async () => {
  prefs.load();
  profile.loadActiveFromStorage();
  if (view.name === 'download' || view.name == null) {
    view.switchTo('home');
  }
  setTimeout(() => player.setupMediaSession(), 0);

  // Fetch profiles first — the gate blocks the rest of the UI until a
  // profile is active (the user picks or one is remembered + still valid).
  try { await profile.fetch(); }
  catch { vantToast({ message: 'Backend injoignable', type: 'fail' }); }

  if (profile.needsPicker) {
    // Don't bother fetching library/playlists yet — they'd go through the
    // default profile but get replaced on the page reload after picking.
    return;
  }

  try {
    await library.fetch();
  } catch (e) {
    vantToast({ message: 'Backend injoignable', type: 'fail' });
  }
  player.restorePlayerState();
  playlists.fetch();
  library._listenAlbumProgress();
  discover.refresh();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalState.visible) closeModal();
  });
});
</script>

<template>
  <div class="app-shell">
    <!-- Nav-bar sits at the top of the flex column (.app-shell). NOT fixed —
         Vant's `placeholder` mirrors the base 46px nav height but ignores
         the safe-area-inset-top padding it adds, so fixed+placeholder makes
         the view content slide under the notch. Letting it flow naturally
         keeps everything aligned with no extra math. -->
    <van-nav-bar
      class="nav-bar"
      :title="showNavTitle ? navTitle : ''"
      :border="false"
      safe-area-inset-top
      @click-left="view.back()"
    >
      <template v-if="isSubview" #left>
        <ChevronLeft :size="26" :stroke-width="2" color="var(--text)" />
      </template>
    </van-nav-bar>

    <div class="view-scroll">
      <ViewHome     v-show="view.name === 'home'" />
      <ViewSearch   v-show="view.name === 'download'" />
      <ViewLibrary  v-show="view.name === 'library'" />
      <ViewSettings v-show="view.name === 'settings'" />
      <ViewPlaylist v-if="view.name === 'playlist'" />
      <ViewAlbum    v-if="view.name === 'album'" />
      <ViewArtist   v-if="view.name === 'artist'" />
      <ViewMix      v-if="view.name === 'mix'" />
    </div>

    <MobilePlayer />

    <van-tabbar
      v-model="activeTab"
      class="tab-bar"
      :border="false"
      safe-area-inset-bottom
      active-color="var(--accent)"
      inactive-color="var(--text-muted)"
    >
      <van-tabbar-item v-for="tab in TABS" :key="tab.id" :name="tab.id">
        <template #icon>
          <component :is="tab.icon" :size="22" :stroke-width="2" />
        </template>
        {{ tab.label }}
      </van-tabbar-item>
    </van-tabbar>

    <ModalRoot />
    <ProfileGate />

    <!-- Singleton action sheet (see stores/actionSheet.js). Mounting it
         here instead of per-view avoids the "two views stack two sheets in
         the body teleport" bug. safe-area-inset-bottom keeps the cancel
         button above the iPhone home indicator. -->
    <van-action-sheet
      v-model:show="actionSheet.visible"
      :actions="actionSheet.actions"
      cancel-text="Annuler"
      close-on-click-action
      safe-area-inset-bottom
      @select="actionSheet.onSelect"
      @cancel="actionSheet.onCancel"
    />
  </div>
</template>
