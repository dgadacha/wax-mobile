# CLAUDE.md — Wax mobile codebase map

This file is for **you, future Claude**. Read it first when starting a session on `wax-mobile`. It is a mobile-first fork of the desktop Wax app (Electron + Vue 3) — the desktop version still lives at `dgadacha/wax`; this repo (`dgadacha/wax-mobile`) only targets iOS + Android via **Capacitor**.

## TL;DR — what is this?

**Wax mobile** is a mobile music app for iOS + Android:
- **Frontend** — Vue 3 + Vite + Pinia + **Vant** (mobile UI kit) + **Lucide** icons, wrapped in **Capacitor** to produce `.ipa` / `.apk`. Multi-profile (Netflix-style "Qui écoute ?" gate at launch).
- **Backend** — `server.cjs` (Express) shells out to `yt-dlp` + `ffmpeg`. Same code as the desktop project, just renamed `.cjs` because the package is now `"type": "module"`. Per-profile library/playlists storage; audio MP3s shared across profiles. Packaged as a Docker image and deployed to k8s (Cloudflare Tunnel in front).

The user is a senior dev who writes in French. Communicate concisely, in **French**. Confirm before destructive ops.

## Quick reference

```bash
# Frontend
npm install                        # vue + vite + vant + capacitor (cli + plugins)
npm run dev                        # vite dev server on :5173, proxies /api → :3000
npm run build                      # dist/ — webDir consumed by Capacitor

# Backend
node server.cjs                    # Express on :3000 (needs yt-dlp + ffmpeg on PATH)

# Capacitor (run after `npm run build`)
npx cap add ios                    # first time only; needs Xcode
npx cap add android                # first time only; needs Android Studio
npm run ios                        # build + cap sync ios + cap open ios
npm run android                    # build + cap sync android + cap open android

# Docker / k8s
docker build -t registry.gitlab.com/kidnar/wax:latest .
docker push registry.gitlab.com/kidnar/wax:latest
kubectl apply -f k8s/
```

Dev URLs: Vite at `http://localhost:5173`, Express at `http://localhost:3000`. Vite proxies `/api/*`, `/audio/*`, `/preview-files/*` → `localhost:3000` (override target via `VITE_DEV_PROXY_TARGET`).

Runtime deps (PATH for `server.cjs`): `yt-dlp`, `ffmpeg`. The Docker image installs both; override with `WAX_YT_DLP` / `WAX_FFMPEG` env vars.

## API base URL — Capacitor vs dev

Capacitor packages the built `dist/` into the native app and serves it from `capacitor://localhost` (iOS) / `https://localhost` (Android) inside a WebView. There is no Vite dev server in prod, so relative URLs like `/api/library` would hit the WebView's own origin and fail.

`src/lib/api.js` exports `apiUrl(path)` which prefixes `import.meta.env.VITE_API_BASE_URL` to any backend-bound path, and `apiUrlWithProfile(path)` which additionally appends `?profile=<id>` for SSE endpoints (EventSource can't set headers). Every place that constructs a URL the backend needs to serve **must** go through one of these:

- Regular requests: `fetch('/api/...')` → `api()` (auto-prefixes + sets `X-Wax-Profile`) or raw `fetch(apiUrl('/api/...'), { headers: { 'X-Wax-Profile': … } })`
- SSE: `new EventSource(apiUrlWithProfile('/api/...'))`
- `audio.src = track.file` → `audio.src = apiUrl(track.file)`
- `audio.src = '/api/stream/<id>'` → `audio.src = apiUrl('/api/stream/<id>')`
- `<img :src="track.thumbnail">` — **TODO**, the legacy tracks carry `/api/cover/<id>` strings; for now `apiUrl()` happens to be a no-op in dev (`VITE_API_BASE_URL=''` → relative URLs → Vite proxy) but the production Capacitor build will need every image binding wrapped too. The artist photo in `ViewArtist.vue` is already wrapped; the rest of the views still bind raw strings.

In dev, leave `VITE_API_BASE_URL` empty (default in `.env.example`) and the Vite proxy handles forwarding. In Capacitor builds, set it to the deployed backend URL (e.g. `https://wax-api.nc-maiz.org`) before running `npm run build && cap sync`.

## Multi-profile (Netflix-style)

Every backend request carries `X-Wax-Profile: <id>`; the server routes to `library/users/<id>/library.json` + `library/users/<id>/playlists.json`. Audio MP3s, covers, artist photos and Deezer caches stay shared at the library root — they're keyed by ytId / artist name so per-user duplication would be wasteful.

- **Default profile** (`id: 'default'`) is auto-created on first boot. If a legacy root `library/library.json` exists from a pre-multi-profile install, it's auto-migrated into `users/default/`.
- **Client store**: `src/stores/profile.js` holds the profile list + active id (persisted in `localStorage` under `wax:active-profile`). `api.js` reads the same key directly so it works without a Pinia round-trip.
- **`<ProfileGate />`** (mounted in `App.vue`) blocks the UI behind a full-screen "Qui écoute ?" overlay whenever `profile.needsPicker` is true. Includes inline profile creation (name + color picked from `ACCENT_SWATCHES`) and a "Gérer les profils" toggle that exposes rename / delete affordances on existing avatars (except `default`, which is undeletable).
- **`/api/profiles`** endpoints: `GET` lists, `POST {name, color}` creates, `PATCH /:id {name?, color?}` updates, `DELETE /:id` removes (and `rm -rf`s the user's data dir; refuses to delete `default`).
- **Switching profiles** triggers a full `location.reload()` — every Pinia store re-fetches against the new `X-Wax-Profile`. Lazier in-place rehydration could replace this later but reload is bulletproof.
- **Album backfill across profiles**: `autoBackfillOnStartup` iterates `listProfileIds()` so every user's library gets the Deezer pass on server start. `scheduleAlbumBackfill(profileId, track, onComplete)` now takes an explicit profileId since it's also called from no-req contexts.

## Accent color picker

`src/stores/prefs.js` exports `ACCENT_SWATCHES` (8 named hex values: violet, sky, emerald, amber, rose, crimson, lime, pearl) and `applyAccent(hex)` which converts to HSL and writes `--accent`, `--accent-bright`, `--accent-dark`, `--accent-soft`, `--accent-glow` on `documentElement`. The chosen swatch persists in `prefs.accentColor` (localStorage `ytmp3:prefs`) and re-applies on `prefs.load()`. The Settings screen renders the swatches as a grid of round dots — the active one shows a Lucide `Check` overlay. Profile avatar colors are independent (stored on the profile record).

## Safe areas

- `index.html` has `viewport-fit=cover` so `env(safe-area-inset-*)` resolves to real values on notched devices (iPhones, Android cutouts).
- `capacitor.config.json` sets `StatusBar.overlaysWebView: true` so the WebView slides under the status bar.
- `App.vue` uses `safe-area-inset-top` on the `<van-nav-bar>` and `safe-area-inset-bottom` on the `<van-tabbar>` — Vant handles the inset additions internally when those props are set. The mini player and `<ProfileGate>` overlay also pad via `--safe-top` / `--safe-bottom`.

## Icons

The whole app uses **Lucide** (`lucide-vue-next`) — a single consistent SVG icon family, tree-shaken per import. `<van-icon>` is no longer used in the mobile shell except where Vant components render internal icons themselves (which we now override via `#icon` / `#left` slots).

Standard imports per file: `import { House, Search, Library, Settings, ChevronLeft, Heart, ... } from 'lucide-vue-next'`. Each icon is a component: `<Heart :size="20" :stroke-width="2" color="…" :fill="…" />`. Use `fill` to render filled variants (filled hearts for "liked", filled play arrows on the index column, etc.).

## File map (where things live)

### Backend
- **`server.cjs`** — Express, single file, identical to the desktop project's `server.js` (just renamed because of `"type": "module"`). All endpoints preserved: search (`ytsearch10:`), playlist enumeration, single-track stream URL extraction (`-g`), MP3 download (`-x --audio-format mp3`), Mix enumeration (`RD<id>`), Deezer album lookup, YouTube artist photo scrape, cover proxy with disk cache. yt-dlp concurrency limited to 3 via the `runYtDlp` semaphore. SSE on `/api/jobs/:id/progress` for downloads and `/api/album-progress` for the auto-backfill stream.
- See the desktop CLAUDE.md (in `dgadacha/wax`) for the long-form description of every endpoint and pipeline — they are unchanged here.

### Capacitor
- **`capacitor.config.json`** — `appId: org.nc-maiz.wax`, `webDir: dist`. iOS + Android schemes are set so the WebView origin is stable. SplashScreen + StatusBar plugins are configured for the dark palette (`#0d0f14`).
- **`ios/`** + **`android/`** — Native projects. NOT committed by default; generated by `npx cap add ios` / `npx cap add android`. Re-add on a fresh checkout.

### Docker / k8s
- **`Dockerfile`** — Two-stage: `deps` installs production npm deps, `runtime` installs python3 + ffmpeg + latest `yt-dlp` from GitHub releases, copies `server.cjs` + node_modules in, runs as a non-root `wax` user on port 3000. The frontend is NOT shipped in the image — Capacitor bundles it into the native app.
- **`k8s/`** — calqued on the kuro project structure:
  - `namespace.yaml` — `wax` namespace.
  - `deployment.yaml` — `replicas: 1`, `strategy: Recreate` (the JSON library files live on a RWO PVC), TCP probes on :3000, 2-core CPU limit (yt-dlp can spike during signature extraction), `imagePullSecrets: gitlab-registry`.
  - `service.yaml` — ClusterIP, :80 → :3000.
  - `ingress.yaml` — Traefik internal (`wax.maiz.local`); public access is through a Cloudflare Tunnel (same pattern as kuro).
  - `pvc.yaml` — RWO 10 GiB for `/data` (library JSON + audio MP3s + covers).

### Frontend (`src/`)

**Entry point**: `src/main.js` imports Vant CSS + `mobile.css`, creates the Pinia store, mounts `App.vue` to `#app`.

**`App.vue`** — Mobile shell:
- Top: `van-nav-bar` (dynamic title from `view.name`, left arrow when in a sub-view; title hidden on top-level tabs so each view's own big heading owns the visual hierarchy — Spotify pattern).
- Middle: `.view-scroll` container that renders the active view via `v-show` (home / download / library / settings — top-level tabs) or `v-if` for the drill-down sub-views (playlist / album / artist / mix).
- `<MobilePlayer />` — mini bar always visible above the tab bar; tap to expand into a fullscreen `van-popup`.
- Bottom: `van-tabbar` with 4 items (Accueil / Rechercher / Bibliothèque / Réglages).
- `<ModalRoot />` for confirm/prompt/lyrics modals (legacy imperative API, works on mobile for `promptModal` text-input flows that Vant doesn't natively cover — playlist create/rename, for example).

The `view` store still drives "current page + back stack", same as desktop. `SUBVIEW_PARENT` in `App.vue` maps `playlist` / `album` / `artist` to the `library` tab (Spotify-style "drill from your library"), and `mix` to the `download` tab.

**`src/views/`** — Status of each view in the mobile world:
- `ViewHome.vue` — **New, mobile-only**. Greeting ("Bonjour" / "Bonsoir" by hour), a 2-col "récemment écoutés" pill grid (from the player queue, falls back to favorites), and a 2-col "Pour toi" cover grid backed by the `discover` store. Refresh button re-rolls the seed.
- `ViewSearch.vue` — **Rewritten mobile**. `van-search` + custom track cells. Tap row → stream, heart icon → add/remove from favorites. URL-paste flow (preview / playlist enumeration / download to library) is NOT ported yet — the desktop search store still supports it but the mobile view ignores it.
- `ViewLibrary.vue` — **Unified Spotify-style bib**. Sticky `van-search` + horizontal chips (`Tout` / `Playlists` / `Albums` / `Artistes` / `Titres`). `Tout` shows playlists + albums + artists as cards (cover/photo + name + meta); `Titres` switches to the favorites track list with action-sheet on the `…` button. Tapping a card pushes the corresponding detail view via `view.switchTo(...)`. The `Playlists` chip surfaces a "Nouvelle playlist" row that calls the legacy `playlists.create()` (which opens its `promptModal` via ModalRoot).
- `ViewPlaylist.vue` — **Rewritten mobile**. `<MobileHero>` with the first track's cover + gradient fallback + "Playlist" eyebrow + `+` and `…` action buttons. Action sheet on `…` exposes rename / add tracks / download all / delete. Per-row action sheet on each track's `…`.
- `ViewAlbum.vue` — **Rewritten mobile**. `<MobileHero>` with the Deezer album cover. Tracklist uses the same Deezer canonical order + library-match logic as the desktop view, with `MobileTrackCell` in `index` variant: matched tracks play immediately, unmatched ones resolve to YouTube on first tap (loading spinner on the index). "Sauvegarder comme playlist" lives in the `…` action sheet — kept the inline implementation rather than depending on legacy code.
- `ViewArtist.vue` — **Rewritten mobile**. `<MobileHero shape="circle">` with the scraped artist photo (via `apiUrl('/api/artist-photo/...')`). Two sections: "Dans ta bibliothèque" and "Recommandé" (filtered to tracks that cluster under the same `normalizeArtistKey`). "Tout aimer" button on the recos section batches `lib.add({silent:true})`.
- `ViewMix.vue` — **Rewritten mobile**. `<MobileHero>` with the first track's cover, "Sauvegarder" pill button in the actions slot. Track list uses `thumb` variant of `MobileTrackCell`.
- `ViewSettings.vue` — **Mobile-only**. `van-cell-group` cards for Bibliothèque counts, version, backend URL, and a "Tout effacer" danger row that confirms via `showConfirmDialog`. Theme picker / language / EQ / backup / playlists management are NOT ported yet.
- `ViewAlbums.vue` — **Removed from routing**. The unified `ViewLibrary` handles the album grid via the `Albums` chip; the legacy view file remains on disk but is no longer imported.

**`src/components/`** — Mobile additions vs legacy:
- `MobileHero.vue` — **New**. Reusable detail-page hero: blurred backdrop derived from the cover, eyebrow + title + subtitle stacked, square or circular cover, right-aligned `actions` slot (action-sheet trigger, etc.), and a round play FAB. Used by ViewPlaylist / ViewAlbum / ViewArtist / ViewMix.
- `MobileTrackCell.vue` — **New**. Reusable list row with `thumb` or `index` variant (number column for albums/playlists, cover thumbnail for search/mix). Emits `play` / `like` / `more` so the parent can wire the right action sheet.
- `MobilePlayer.vue` — **New**. Hosts both `<audio>` elements (so the legacy `player` store's `bindAudio()` still works) + the mini player + the fullscreen `van-popup` with cover, seek (`van-slider`), prev/next, like, lyrics, queue.
- `Player.vue`, `NowPlaying.vue`, `BigPicture.vue`, `Sidebar.vue` — **Legacy desktop, no longer imported by App.vue**. Kept on disk for reference. Safe to delete later.
- `TrackRow.vue`, `TrackListHeader.vue`, `JobItem.vue`, `QueueItem.vue`, `DiscoverGrid.vue`, `Toast.vue`, `SettingsBody.vue` — legacy, no longer referenced. Kept for reference.
- `ModalRoot.vue`, `BulkAddBody.vue`, `AddToPlaylistBody.vue` — **Still used**. `ModalRoot` is mounted by App.vue because the legacy imperative `promptModal` / `openComponentModal` flows (playlist create/rename, bulk-add to playlist) are still wired through it. They render the desktop look-and-feel inside a centered overlay — works on mobile but doesn't match Vant's bottom-sheet aesthetic; consider re-skinning if it bothers you.

**`src/composables/`**:
- `useActionSheet.js` — **New**. Tiny Promise-based wrapper around `<van-action-sheet>` (Vant 4 doesn't ship an imperative helper for ActionSheet). Returns `{ visible, actions, open, onSelect, onCancel }`; the caller drops `<van-action-sheet v-model:show="sheet.visible.value" :actions="sheet.actions.value" @select="sheet.onSelect" @cancel="sheet.onCancel" />` at the bottom of its template, and any control awaits `sheet.open([{name:'…'},…])` to get back `{ index, name }`.
- `useVisualizer.js`, `useLyrics.js`, `useDragReorder.js` — legacy, still on disk. `useLyrics` is wired into the fullscreen `MobilePlayer` comment-icon button.

**`src/stores/`** — Pinia stores all preserved from the desktop project, nothing renamed. The shared model means a port can swap views in place without touching state:
- `library.js`, `playlists.js`, `player.js`, `prefs.js`, `view.js`, `mix.js`, `search.js`, `streams.js`, `discover.js`, `jobs.js`, `accent.js`.
- `accent.js` is unused in the mobile shell (mobile.css has a hardcoded palette) but kept around in case the theme picker is ported.

**`src/lib/`** — Preserved + extended:
- `api.js` — now exports `apiUrl(path)` alongside `api(path, opts)`. See the "API base URL — Capacitor vs dev" section above.
- `format.js`, `icons.js`, `themes.js`, `i18n.js`, `modal.js`, `toast.js`, `backup.js` — unchanged from desktop. `backup.js` was sweeped to use `apiUrl()` for `/api/export`, `/api/import`, `/api/wipe`.

**`src/styles/`**:
- `mobile.css` — **New**. CSS-vars palette (single "Midnight" dark theme for now), Vant `--van-*` overrides, layout primitives (`.app-shell`, `.view-scroll`, `.tab-bar`, `.mini-player`), and the `.track-cell` base used by Search + Library mobile views.
- `style.css` — **Legacy desktop, no longer imported**. ~1700 lines. Kept on disk for reference while porting the remaining views (a lot of details like the `.eq` visualizer SVG transforms, hero band gradients, theme blocks for the 22-theme picker live there).

## Key flows (data flow tracing)

### Search → stream a track (mobile)
1. User types in `van-search` → `ViewSearch.onSearchInput` updates `search.inputValue` and calls the debounced `makeSearchHandler` (500 ms).
2. `search.runSearch` decides URL vs free-text. For text: `api('/api/search?q=...')` → `search.results`.
3. Tap a result → `streams.streamSearchResult(r, null, player)` registers a virtual `stream-<ytId>` track, sets `player.queue = [streamId]`, and the player loads `apiUrl('/api/stream/:ytId')`.
4. Audio element is in `MobilePlayer.vue`, bound to the `player` store via `player.bindAudio(audioRef, audio2Ref)` on mount.

### Library track → offline (unchanged from desktop)
Same `lib.downloadTrack(trackId)` → POST `/api/library/:id/download` → SSE `/api/jobs/:jobId/progress` → local mutation on `lib.findById(trackId).file`. The UI affordance to trigger it is NOT yet wired into the mobile Library view (`ViewLibrary.vue` has no download button) — pending port.

## Conventions / style (mobile-specific)

- **Vant**: components are auto-imported via `unplugin-vue-components` + `@vant/auto-import-resolver` (see `vite.config.js`). You can use `<van-button>`, `<van-cell>`, etc. directly in templates without imports. For imperative APIs (`showToast`, `showConfirmDialog`, `showNotify`) and the type for setup state, import from `'vant'` explicitly. The base CSS bundle `vant/lib/index.css` is loaded once in `main.js`.
- **Safe areas**: every fixed element honors `env(safe-area-inset-top/bottom)` via the `--safe-top` / `--safe-bottom` CSS vars defined in `mobile.css`. The nav bar, tab bar, and mini player are the three callers — if you add another fixed element, pad it the same way.
- **Single theme for now**: only "Midnight" (dark). The desktop's 22-theme picker is not ported. When/if it lands, palette vars from `mobile.css` move into per-theme `html.theme-<id>` blocks like the desktop, and the Vant `--van-*` overrides re-derive from them.
- **i18n**: legacy `lib/i18n.js` is still on disk but the mobile views use raw French strings inline for now. To bring i18n back, call `t('...')` and add to both `en` / `fr` catalogs — same convention as desktop.
- **Composition API + `<script setup>`** only.

## Active TODOs / known gaps

- Capacitor native projects (`ios/`, `android/`) not generated yet — run `npx cap add ios` / `npx cap add android` on first setup, then add icons + splash artwork.
- Background audio plugin not wired — iOS will pause when the WebView goes to background. Pick `@capacitor-community/native-audio` or a custom plugin with `AVAudioSession` / `MediaSessionService` integration.
- Offline storage: download flow still writes to `server.cjs`'s `library/audio/<id>.mp3` (server-side filesystem). For Capacitor, the client should download via `@capacitor/filesystem` so MP3s sit on the device storage, not the backend's PVC. Big architectural shift — design decision pending.
- Prefs storage still uses `localStorage`. Could migrate to `@capacitor/preferences` for better iOS sandboxing, but localStorage works in the WebView so this is optional.
- Image bindings (`<img :src="track.thumbnail">`) NOT prefixed with `apiUrl()`. They work in dev (Vite proxy) but will 404 in the Capacitor build. Sweep needed before first build: every `:src="x.thumbnail"`, `:src="x.coverUrl"`, `:src="x.albumCoverUrl"`. The artist photo (ViewArtist.vue) is already wrapped.
- `SettingsBody.vue` (legacy desktop settings) NOT ported. The mobile `ViewSettings.vue` covers profile / accent / library counts / reset; theme picker (22 themes) / language / EQ / backup are still pending.
- Drag-reorder on Playlist track list not ported (was HTML5 DnD on desktop; mobile needs `van-draggable` or a long-press handle).
- Playlist create / rename still goes through the legacy `promptModal` (mounted via `ModalRoot.vue`) because Vant has no text-input dialog. Profile rename uses a native `window.prompt` for the same reason — consider building a `MobilePromptSheet`.
- Lyrics modal (opened from `MobilePlayer`'s comment icon) is the legacy desktop modal.
- Profile avatars are letter-on-color circles only — no upload-an-image-from-the-camera flow. Capacitor `@capacitor/camera` could do it but adds permissions complexity.
- No tests, no CI for the mobile build yet.

## Communication style

- French, casual. The user says "tu" and writes informally.
- Explain decisions briefly when proposing options. Confirm before destructive changes.
- The user values **performance** and **polish**: small UX issues (alignment, perceived latency, jank, safe-area mistakes) get flagged.
- They often iterate: small change → review → next ask. Don't over-engineer.

## Workflow: "commit et pousse" / "commit and push"

When the user asks to commit & push (any phrasing — "commit et pousse", "commit and push", "push", "envoie ça", etc.), do all four of these in **one** flow before pushing:

1. **Bump the version** in `package.json`.
   - Default: **patch** (0.1.0 → 0.1.1) — bug fix, polish, doc-only.
   - **Minor** (0.1.0 → 0.2.0) — new screen, new public store action, new Capacitor plugin.
   - **Major** (0.x → 1.0.0) — only when the user asks for it explicitly, or for a breaking change they flagged. We are pre-1.0 for now.
2. **Update `README.md`** if the change is user-visible (new feature, new install step, new dep). Skip if it's an internal refactor or tiny fix.
3. **Update `CLAUDE.md`** if architecture, files, stores, key flows, gotchas, or active TODOs shifted. Skip for cosmetic-only fixes.
4. **Then commit and push** in a single commit. Don't ask permission for any of the four — just do them. If a step is genuinely a no-op (e.g. CLAUDE.md needs no change), say so in one line in the reply.

Commit message: imperative, French or English (match the codebase). Do NOT prepend `vX.Y.Z:` — the version lives in `package.json`, not in commit subjects.
