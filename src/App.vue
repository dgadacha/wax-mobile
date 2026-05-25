<script setup>
import { onMounted, computed, watch, ref, nextTick } from 'vue';
import { showToast as vantToast } from 'vant';

import { House, Search, Library, Settings, ChevronLeft, WifiOff } from 'lucide-vue-next';
import MobilePlayer from './components/MobilePlayer.vue';
import ModalRoot from './components/ModalRoot.vue';
import ProfileGate from './components/ProfileGate.vue';
import LoginGate from './components/LoginGate.vue';

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
import { useAuthStore } from './stores/auth';
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
const auth = useAuthStore();

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

// iOS WebKit cache-busting: every time view.name flips (tab switch,
// sub-view drill-in, back), force a layout read on .view-scroll so
// the compositor invalidates its cached layer and actually repaints
// the newly-visible v-show'd content. Without this, the user can
// land on a fully blank tab until they switch away and back.
watch(() => view.name, () => {
  nextTick(() => {
    const el = document.querySelector('.app-shell .view-scroll');
    if (el) void el.offsetHeight; // reading offsetHeight forces sync layout
  });
});

// Online/offline state. `navigator.onLine` is best-effort (the browser
// only knows whether it has a route to a network, not whether the
// internet works), but combined with the SW's NetworkFirst cache fall-
// back it's accurate enough to drive the banner + skip useless
// online-only fetches (discover, album backfill SSE).
const isOnline = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
function onOnline() { isOnline.value = true; }
function onOffline() { isOnline.value = false; }

// Land on Home for new sessions; legacy view stores may have persisted
// 'download' as the default.
//
// Bootstrap is two-phased so the login gate (if enabled server-side) gets
// a clean fall-through path: synchronous local setup runs immediately,
// then we verify the stored auth token. If the token is valid (or auth
// is disabled — verify() answers ok), we run `bootstrapAfterAuth()` which
// pulls profile, library, playlists, etc. If not, LoginGate stays visible
// and the watch below triggers the post-auth bootstrap once the user
// submits valid credentials.
let bootstrapped = false;

async function bootstrapAfterAuth() {
  if (bootstrapped) return;
  bootstrapped = true;

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
    // Don't toast if we already know we're offline — the banner says it.
    if (isOnline.value) vantToast({ message: 'Backend injoignable', type: 'fail' });
  }
  player.restorePlayerState();
  playlists.fetch();
  // Online-only side channels — open the album SSE + roll the
  // discover seed only when we have a network. Both reconnect / can
  // be re-triggered automatically when the user comes back online via
  // the `online` event handler below.
  if (isOnline.value) {
    library._listenAlbumProgress();
    discover.refresh();
    // Refill any holes in the SW audio cache for tracks the library
    // says are offline-ready. Runs in the background — silent unless
    // a track is gone from the server (in which case warmOfflineCache
    // drops t.file locally so the UI matches reality).
    library.warmOfflineCache().catch(() => {});
  }
}

onMounted(async () => {
  prefs.load();
  profile.loadActiveFromStorage();
  if (view.name === 'download' || view.name == null) {
    view.switchTo('home');
  }
  setTimeout(() => player.setupMediaSession(), 0);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalState.visible) closeModal();
  });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  // When the network comes back, light up the channels we skipped at
  // boot. Idempotent: _listenAlbumProgress guards against double-open,
  // discover.refresh is safe to call repeatedly.
  window.addEventListener('online', () => {
    try { library._listenAlbumProgress(); } catch {}
    try { discover.refresh(); } catch {}
    try { library.warmOfflineCache(); } catch {}
  });

  // Re-render the LoginGate if the server kicks us out (token expired,
  // password rotated, secret file deleted). api.js dispatches this on 401
  // from any protected route. expire() (not logout) forces authEnabled
  // back to true so a stale SW-cached {authEnabled:false} can't keep the
  // gate hidden while every other call 401s in the background.
  window.addEventListener('wax:auth-expired', () => {
    bootstrapped = false;
    auth.expire();
  });

  // Load any persisted token, then probe the server. /api/auth/verify
  // answers 200 either way and tells us whether the gate is active. If
  // it's not, loggedIn flips to true regardless of token presence and
  // bootstrap runs immediately.
  auth.loadToken();
  await auth.verify();
  if (auth.loggedIn) await bootstrapAfterAuth();
});

// Once the user logs in via LoginGate, kick off the bootstrap. Triggers
// only on the false→true transition so re-mounts don't double-bootstrap.
watch(() => auth.loggedIn, async (isLogged, was) => {
  if (isLogged && !was) await bootstrapAfterAuth();
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

    <!-- Offline banner. Slides in between the nav-bar and view scroll
         whenever `navigator.onLine` flips false. The SW's NetworkFirst
         rules keep library/playlists/profiles/auth available from cache,
         so the user can still navigate + play any downloaded MP3. -->
    <div v-if="!isOnline" class="offline-banner" role="status">
      <WifiOff :size="14" :stroke-width="2.2" />
      <span>Mode hors ligne</span>
    </div>

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
    <LoginGate />

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
