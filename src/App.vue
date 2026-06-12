<script setup>
import { onMounted, computed, watch, ref, nextTick } from 'vue';
import { showToast as vantToast } from 'vant';

import { House, Search, Library, ChevronLeft, WifiOff } from 'lucide-vue-next';
import MobilePlayer from './components/MobilePlayer.vue';
import ActionSheet from './components/ActionSheet.vue';
import ModalRoot from './components/ModalRoot.vue';
import ProfileGate from './components/ProfileGate.vue';
import LoginGate from './components/LoginGate.vue';
import OnboardingOverlay from './components/OnboardingOverlay.vue';

import ViewHome from './views/ViewHome.vue';
import ViewSearch from './views/ViewSearch.vue';
import ViewLibrary from './views/ViewLibrary.vue';
import ViewSettings from './views/ViewSettings.vue';
import ViewPlaylist from './views/ViewPlaylist.vue';
import ViewAlbum from './views/ViewAlbum.vue';
import ViewArtist from './views/ViewArtist.vue';
import ViewMix from './views/ViewMix.vue';
import ViewWrapped from './views/ViewWrapped.vue';

import { useLibraryStore } from './stores/library';
import { usePlaylistsStore } from './stores/playlists';
import { useViewStore } from './stores/view';
import { usePlayerStore } from './stores/player';
import { usePrefsStore } from './stores/prefs';
import { useDiscoverStore } from './stores/discover';
import { useProfileStore } from './stores/profile';
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
const auth = useAuthStore();

// Top-level tab routes — Spotify's 3-tab layout. Settings is reached via
// the gear icon on Home (and pushed as a sub-view), not a tab.
const TABS = [
  { id: 'home',     label: 'Accueil',      icon: House },
  { id: 'download', label: 'Rechercher',   icon: Search },
  { id: 'library',  label: 'Bibliothèque', icon: Library },
];

// Sub-views inherit their parent tab so the tab bar highlights stay coherent
// as the user drills down into details.
const SUBVIEW_PARENT = {
  playlist: 'library',
  album:    'library',
  artist:   'library',
  mix:      'download',
  settings: 'home',
  wrapped:  'home',
};

// Hero sub-views get the floating transparent nav-bar (chevron over the
// gradient, scrim fades in on scroll). Flat sub-views (settings, wrapped)
// keep a solid bar with a centered title — Spotify's Settings layout.
const HERO_SUBVIEWS = new Set(['playlist', 'album', 'artist', 'mix']);

const activeTab = computed({
  get: () => SUBVIEW_PARENT[view.name] || view.name,
  set: (id) => {
    if (view.name === id) return;
    haptics.selection();
    view.switchTo(id);
  },
});

const isSubview = computed(() => !!SUBVIEW_PARENT[view.name]);
const isHeroSubview = computed(() => HERO_SUBVIEWS.has(view.name));

const navTitle = computed(() => {
  switch (view.name) {
    case 'home':     return 'Accueil';
    case 'download': return 'Rechercher';
    case 'library':  return 'Bibliothèque';
    case 'settings': return 'Réglages';
    case 'artist':   return view.selectedArtist || 'Artiste';
    case 'album':    return 'Album';
    case 'playlist': {
      // Virtual ids (Favoris / Hors-ligne) aren't in playlists.items;
      // map them so the nav-bar title fades in on scroll like a real
      // playlist.
      const id = view.selectedPlaylistId;
      if (id === 'favorites') return 'Favoris';
      if (id === 'offline') return 'Hors-ligne';
      return playlists.items.find(p => p.id === id)?.name || 'Playlist';
    }
    case 'mix':      return 'Mix';
    case 'wrapped':  return 'Ta sélection';
    default:         return 'Wax';
  }
});

// Scroll progress 0..1 of the current sub-view's hero. Drives the
// Spotify-style "title slides into the nav-bar" effect: at the top
// the hero owns the title (nav-bar is empty), once the user scrolls
// past ~half the hero the nav-bar title fades in. Computed in this
// component (rather than emitted from MobileHero) so the nav-bar
// doesn't need to know about hero internals.
const heroScrollProgress = ref(0);
// On the top-level tabs Spotify hides the title (the view renders its own
// big heading) — keep the title visible only on sub-views so the user has a
// stable "where am I" affordance. On sub-views, fade in as the hero
// scrolls off so the two never compete for attention.
const showNavTitle = computed(() => isSubview.value);
const navTitleStyle = computed(() => {
  // Flat sub-views (settings / wrapped) show their title immediately —
  // there's no hero to compete with.
  if (!isHeroSubview.value) return { opacity: 1 };
  // Stay invisible until the user has scrolled past 50% of the hero,
  // then ramp to fully visible by 90%. Mirrors Apple Music / Spotify.
  const t = Math.max(0, Math.min(1, (heroScrollProgress.value - 0.5) / 0.4));
  return { opacity: t };
});
// Scrim behind the floating nav — solidifies a bit earlier than the
// title so the chevron never floats on unreadable artwork.
const navBgOpacity = computed(() => {
  if (!isHeroSubview.value) return 1;
  return Math.max(0, Math.min(1, (heroScrollProgress.value - 0.35) / 0.45));
});

watch(() => player.playing, (playing) => {
  document.body.dataset.playing = playing ? 'true' : 'false';
}, { immediate: true });

// iOS WebKit cache-busting + scroll reset. Every time view.name
// flips (tab switch, sub-view drill-in, back), force a layout read
// on .view-scroll so the compositor invalidates its cached layer
// AND scroll the container back to the top so the new view always
// starts at its header — Spotify/Apple Music both reset scroll on
// tab switch, and otherwise navigating from a scrolled-down
// Settings into the Wrapped sub-view leaves you mid-page.
watch(() => view.name, () => {
  nextTick(() => {
    const el = document.querySelector('.app-shell .view-scroll');
    if (!el) return;
    void el.offsetHeight; // reading offsetHeight forces sync layout
    el.scrollTop = 0;
  });
});

// Sub-view <Transition> direction. Push (drilling into playlist/album/
// artist/mix) slides from the right; back (popping to a top-level tab)
// slides off to the right too — we use the view store's history depth
// as the cue: history growing = forward = slide-left, history shrinking
// = back = slide-right. Falls back to a fade on the very first transition.
const transitionName = ref('view-fade');
let lastHistoryDepth = 0;
watch(() => view.history?.length ?? 0, (depth) => {
  if (depth > lastHistoryDepth) transitionName.value = 'view-push';
  else if (depth < lastHistoryDepth) transitionName.value = 'view-pop';
  else transitionName.value = 'view-fade';
  lastHistoryDepth = depth;
});

// Scroll listener wired to .view-scroll for the hero-fade-out + nav-
// bar-title-fade-in. Same 220 px FADE_DISTANCE as MobileHero uses
// internally so the two effects stay in sync. Reset on view change
// because a sub-view re-mount snaps scrollTop back to 0.
const HERO_FADE_DISTANCE = 220;
function onViewScroll() {
  const el = document.querySelector('.app-shell .view-scroll');
  if (!el) return;
  heroScrollProgress.value = Math.max(
    0,
    Math.min(1, el.scrollTop / HERO_FADE_DISTANCE),
  );
}
watch(() => view.name, () => {
  heroScrollProgress.value = 0;
});

// Onboarding overlay — shown on first launch (no localStorage flag),
// dismissible from inside, re-openable from Settings via a window
// event we listen to here. Re-mounts via the `key` increment so the
// component starts fresh on every re-open even if the user dismissed
// mid-walkthrough last time.
const showOnboarding = ref(false);
const onboardingKey = ref(0);
const onboardingRerun = ref(false);
function checkOnboarding() {
  try {
    if (!localStorage.getItem('wax:onboarding-done')) showOnboarding.value = true;
  } catch {}
}
function openOnboardingRerun() {
  try { localStorage.removeItem('wax:onboarding-done'); } catch {}
  onboardingKey.value += 1;
  onboardingRerun.value = true;
  showOnboarding.value = true;
}
function onOnboardingDone() {
  showOnboarding.value = false;
  onboardingRerun.value = false;
}

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

  // Hydrate from localStorage snapshots BEFORE any network call so
  // the UI has data to render even if every fetch below times out.
  // Each store's fetch() also re-applies the snapshot on catch as a
  // belt-and-suspenders fallback, but doing it eagerly here means the
  // first paint after auth is instant regardless of cache state.
  library.restoreSnapshot();
  playlists.restoreSnapshot();
  // profile.loadActiveFromStorage was already called in onMounted —
  // it restores the profiles snapshot too.

  try { await profile.fetch(); }
  catch {
    // Silenced when offline (banner already says it); the snapshot
    // restored earlier covers UI rendering for the existing profile.
    if (isOnline.value) vantToast({ message: 'Backend injoignable', type: 'fail' });
  }

  if (profile.needsPicker) {
    // Don't bother fetching library/playlists yet — they'd go through the
    // default profile but get replaced on the page reload after picking.
    return;
  }

  try {
    await library.fetch();
  } catch (e) {
    if (isOnline.value) vantToast({ message: 'Backend injoignable', type: 'fail' });
  }
  player.restorePlayerState();
  playlists.fetch().catch(() => {});
  // Online-only side channels — open the album SSE + roll the
  // discover seed only when we have a network. Both reconnect / can
  // be re-triggered automatically when the user comes back online via
  // the `online` event handler below.
  //
  // NB: warmOfflineCache is NO LONGER auto-run here. It's a heavy pass
  // (re-fetches every downloaded MP3) and if it ever crashes the tab —
  // e.g. iOS Safari OOM — auto-running it on every boot turned a one-off
  // crash into an unrecoverable reload loop. It stays available behind
  // the manual "Vérifier le cache" button (Réglages → Hors-ligne); normal
  // offline playback still works via the SW CacheFirst rule on play.
  if (isOnline.value) {
    library._listenAlbumProgress();
    discover.refresh();
  }
}

onMounted(async () => {
  prefs.load();
  profile.loadActiveFromStorage();
  // Restore localStorage snapshots SYNCHRONOUSLY at boot, before the
  // first await. That way Vue's first render sees the full library +
  // playlists (offline-cached version) immediately — no flicker
  // through "loading…" / empty states, and no risk of a component
  // throwing on unexpected empty data while the async bootstrap is
  // still in flight.
  try { library.restoreSnapshot(); } catch (e) { console.warn('[boot] library snapshot', e); }
  try { playlists.restoreSnapshot(); } catch (e) { console.warn('[boot] playlists snapshot', e); }
  if (view.name === 'download' || view.name == null) {
    view.switchTo('home');
  }
  setTimeout(() => player.setupMediaSession(), 0);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalState.visible) closeModal();
  });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  // Auto-persist library + playlists snapshots on every mutation
  // (debounced) so the localStorage cache stays in lockstep with
  // the in-memory state. That way a cold offline boot can restore
  // the exact data the user saw last time, not just whatever the
  // last fetch returned.
  let libT = null;
  library.$subscribe(() => {
    if (libT) return;
    libT = setTimeout(() => { libT = null; library.persistSnapshot(); }, 1500);
  });
  let plT = null;
  playlists.$subscribe(() => {
    if (plT) return;
    plT = setTimeout(() => { plT = null; playlists.persistSnapshot(); }, 1500);
  });

  // Hook the hero-scroll listener onto .view-scroll once the DOM is
  // mounted. Passive for buttery scroll perf — we only read scrollTop.
  nextTick(() => {
    const el = document.querySelector('.app-shell .view-scroll');
    if (el) el.addEventListener('scroll', onViewScroll, { passive: true });
  });
  // When the network comes back, light up the channels we skipped at
  // boot. Idempotent: _listenAlbumProgress guards against double-open,
  // discover.refresh is safe to call repeatedly.
  window.addEventListener('online', () => {
    try { library._listenAlbumProgress(); } catch {}
    try { discover.refresh(); } catch {}
    // warmOfflineCache intentionally NOT auto-run on reconnect either —
    // see the note in bootstrapAfterAuth. Manual button only.
    // Drain any downloads deferred by the Wi-Fi-only toggle —
    // each one re-enters downloadTrack and re-checks the network
    // (so if we're STILL on cellular here, they stay queued).
    try { library._drainWifiQueue(); } catch {}
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
  //
  // Wrapped in try/catch so a thrown error during boot (network blip
  // before our offline short-circuit kicks in, JSON parse failure on a
  // weird SW response, etc.) doesn't blank the page. The snapshots
  // restored at the top already gave Vue something to render.
  try {
    auth.loadToken();
    await auth.verify();
    if (auth.loggedIn) await bootstrapAfterAuth();
  } catch (e) {
    console.error('[boot] failed', e);
  }

  // Check onboarding AFTER auth so a fresh-install user lands on
  // the login gate first, then sees the 3-screen intro post-login.
  checkOnboarding();
  // Settings → "Revoir l'introduction" dispatches this event so we
  // can re-open the overlay without prop drilling through the view
  // hierarchy.
  window.addEventListener('wax:reopen-onboarding', openOnboardingRerun);
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
      v-if="isSubview"
      class="nav-bar"
      :class="{ 'nav-float': isHeroSubview }"
      :title="showNavTitle ? navTitle : ''"
      :border="false"
      :style="{
        '--wax-nav-title-opacity': navTitleStyle.opacity,
        '--wax-nav-bg-opacity': navBgOpacity,
      }"
      safe-area-inset-top
      @click-left="view.back()"
    >
      <template #left>
        <ChevronLeft :size="26" :stroke-width="2.4" color="var(--text)" />
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

    <div class="view-scroll" :class="{ 'no-nav': !isSubview }">
      <ViewHome     v-show="view.name === 'home'" />
      <ViewSearch   v-show="view.name === 'download'" />
      <ViewLibrary  v-show="view.name === 'library'" />
      <!-- Sub-views slide in from the right on push, slide out left on
           back. Wrapped in <Transition> so each mount/unmount animates;
           the v-if's stay one-at-a-time (only one sub-view exists at
           a time) so we get a clean cross-fade-slide without overlap. -->
      <Transition :name="transitionName">
        <ViewPlaylist v-if="view.name === 'playlist'" key="playlist" />
        <ViewAlbum    v-else-if="view.name === 'album'"    key="album" />
        <ViewArtist   v-else-if="view.name === 'artist'"   key="artist" />
        <ViewMix      v-else-if="view.name === 'mix'"      key="mix" />
        <ViewSettings v-else-if="view.name === 'settings'" key="settings" />
        <ViewWrapped  v-else-if="view.name === 'wrapped'"  key="wrapped" />
      </Transition>
    </div>

    <MobilePlayer />

    <van-tabbar
      v-model="activeTab"
      class="tab-bar"
      :border="false"
      safe-area-inset-bottom
      active-color="var(--text)"
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
    <OnboardingOverlay
      v-if="showOnboarding"
      :key="onboardingKey"
      :rerun="onboardingRerun"
      @done="onOnboardingDone"
    />

    <!-- Singleton action sheet (see stores/actionSheet.js). Custom
         Spotify-style fullscreen sheet: gradient pulled from the
         track/playlist cover, icon rows, centered close button. -->
    <ActionSheet />
  </div>
</template>
