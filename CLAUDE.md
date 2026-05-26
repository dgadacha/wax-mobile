# CLAUDE.md — Wax codebase map

Ce fichier est pour **toi, Claude futur**. Lis-le en premier à chaque session sur ce projet.

## TL;DR — c'est quoi ?

**Wax** est une app musicale web/mobile :
- **Frontend** — Vue 3 + Vite + Pinia + **Vant** (UI kit mobile) + **Lucide** icons. Multi-profil style Netflix. **Login obligatoire** avant le choix du profil. PWA offline-capable avec service worker Workbox.
- **Backend** — `server.cjs` (Express) qui appelle `yt-dlp` + `ffmpeg`. Stockage par profil (`library/users/<id>/`). Audio MP3 partagé entre profils.
- **Déployé** sur Kubernetes (namespace `wax`, ingress `wax.maiz.local`) via GitLab CI, image Docker dans le registry GitLab (`registry.gitlab.com/kidnar/wax:latest`).

L'utilisateur est dev senior, communique en **français**, tutoiement, style informel.

## Quick reference

```bash
# Frontend dev
npm install
npm run dev          # Vite sur :5173, proxy /api → :3000

# Backend dev
node server.cjs      # Express sur :3000 (yt-dlp + ffmpeg sur le PATH)

# Docker (build local)
docker build -t registry.gitlab.com/kidnar/wax:latest .
docker push registry.gitlab.com/kidnar/wax:latest

# K8s (depuis le serveur 192.168.1.3)
kubectl apply -f k8s/
kubectl rollout restart deployment/wax -n wax
```

Dev URLs : Vite → `http://localhost:5173`, Express → `http://localhost:3000`.
Vite proxie `/api/*`, `/audio/*`, `/preview-files/*` → `localhost:3000` (override via `VITE_DEV_PROXY_TARGET`).

Runtime deps : `yt-dlp`, `ffmpeg`. Override avec `WAX_YT_DLP` / `WAX_FFMPEG`.

## Déploiement

- **GitLab** : `gitlab.com/kidnar/wax` (groupe `kidnar`)
- **CI** : `.gitlab-ci.yml` — stages `build` (docker build + push) et `deploy` (kubectl via l'agent `wax-agent`). Se déclenche sur push sur `main`. Le stage deploy fait `kubectl apply -f k8s/` (tout le dossier) — ajouter un manifest suffit, pas besoin de toucher la CI.
- **Agent K8s** : `wax-agent` (helm `gitlab/gitlab-agent`, namespace `wax`). Context kubectl dans la CI : `kidnar/wax:wax-agent`.
- **Namespace** : `wax` sur le cluster k3s du serveur `192.168.1.3` (user `salon`).
- **Ingress** : `wax.maiz.local` via Traefik (k3s built-in).
- **Secrets K8s** :
  - `gitlab-registry` — deploy token pour puller l'image depuis le registry GitLab.
  - `wax-auth` — clés `email` + `password` pour l'auth app (injectées dans le pod via `WAX_AUTH_EMAIL` / `WAX_AUTH_PASSWORD`).

## Authentification

**Flux** : `LoginGate` (plein écran, z-index 200) → `ProfileGate` ("Qui écoute ?", z-index 100) → app.

### Backend (`server.cjs`)
- `POST /api/auth/login` — vérifie `email` + `password` via `crypto.timingSafeEqual` sur les sha256 des valeurs, retourne un token HMAC signé `<base64url(payload)>.<hex(hmac)>` (payload = `{email, exp}`, TTL 30 jours). Le secret HMAC est persisté dans `library/.auth-secret` (auto-généré au premier boot, mode 0600) → les tokens survivent aux redémarrages. Supprimer ce fichier invalide toutes les sessions.
- `GET /api/auth/verify` — retourne `{ok: true, authEnabled: bool}`. Le flag `authEnabled` dit au client si le token vide = "pas de gate" ou "afficher le formulaire".
- Middleware `app.use('/api', authMiddleware)` — protège tous les `/api/*`. Exemptions :
  - `/api/auth/login` (l'endpoint lui-même)
  - `/api/stream/`, `/api/cover/`, `/api/preview/`, `/api/artist-photo/` — contenu YouTube public, inaccessible via header custom (`<audio>` / `<img>` natifs ne peuvent pas envoyer `Authorization`)
- Credentials via env vars `WAX_AUTH_EMAIL` + `WAX_AUTH_PASSWORD` (secret K8s `wax-auth`). Si les deux sont vides, l'auth est désactivée (mode dev).

### Frontend
- **`src/stores/auth.js`** — `{token, authEnabled, checking}`. Getter `loggedIn = !authEnabled || !!token` (pas de gate → tout le monde est connecté). `verify()` probe `/api/auth/verify`, lit `authEnabled`, efface le token sur 401. Token stocké dans `localStorage['wax:auth-token']`. Une 401 sur n'importe quel endpoint dispatch `wax:auth-expired` et réaffiche la gate.
- **`src/components/LoginGate.vue`** — overlay plein écran (dark gradient). Spinner pendant `auth.checking`, `<WifiOff>` + "Pas de connexion" quand offline sans token, formulaire email/password sinon.
- **`src/lib/api.js`** — envoie `Authorization: Bearer <token>` sur chaque requête. `apiUrlWithProfile()` ajoute `?profile=<id>&_token=<token>` pour les EventSource (SSE ne peut pas envoyer de headers).
- **`App.vue`** — `bootstrapAfterAuth()` : `profile.fetch()` → si `needsPicker` → stop → `ProfileGate`. Sinon `library.fetch()`, `playlists.fetch()`, `player.restorePlayerState()`, etc. Watch sur `auth.loggedIn` déclenche `bootstrapAfterAuth()` quand le user se connecte.

## API base URL — web vs Capacitor

`src/lib/api.js` exporte `apiUrl(path)` (préfixe `VITE_API_BASE_URL`) et `apiUrlWithProfile(path)` (ajoute `?profile=<id>&_token=<token>` pour les SSE). **Tout** ce qui construit une URL backend doit passer par l'un de ces deux.

En dev, `VITE_API_BASE_URL` est vide, le proxy Vite redirige. En Capacitor, setter à l'URL du backend déployé avant `npm run build && cap sync`.

## Multi-profil

Chaque requête porte `X-Wax-Profile: <id>` → le serveur route vers `library/users/<id>/library.json` + `playlists.json`. Audio MP3, covers, photos artistes et cache Deezer sont partagés.

- **Profil par défaut** (`id: 'default'`) auto-créé au premier boot. Migration auto depuis l'ancien `library/library.json` racine.
- **Store** : `src/stores/profile.js` — id actif persisté dans `localStorage['wax:active-profile']`. `api.js` lit la même clé directement.
- **`<ProfileGate />`** — overlay "Qui écoute ?" quand `profile.needsPicker`. Création inline (nom + couleur parmi `ACCENT_SWATCHES`), renommage / suppression (sauf `default`). Logout (si auth activée) dans les réglages.
- Switcher de profil → `location.reload()` (re-fetch de tous les stores).

## Stream audio — proxy YouTube CDN

`GET /api/stream/:videoId` :
1. `getStreamUrl(videoId)` lance yt-dlp avec `-g` (retourne l'URL directe, sans télécharger). Concurrence limitée à 3 via le sémaphore `runYtDlp`. Cache in-memory 5h.
2. Le serveur fait `https.get(audioUrl)` et pipe vers le client.
3. **Gestion des redirects** : `fetchAndProxy(url, hopsLeft=5)` suit les redirections 302 côté serveur (YouTube CDN renvoie parfois des `redirector.googlevideo.com` qui ne forwarded pas de `Location` au navigateur).
4. Le header `Range` est forwardé pour le streaming partiel (206).

## Offline mode (PWA)

Service worker via `vite-plugin-pwa` + Workbox. Ce qui est offline :
- **App shell** — précaché à build time (JS, CSS, HTML, assets).
- **Auth verify** — NetworkFirst, fallback cache 1 semaine. Le token existant est gardé optimistement quand `navigator.onLine === false`.
- **Library + playlists** — NetworkFirst avec cache-key incluant `X-Wax-Profile` (Profile A ne reçoit pas les données de Profile B depuis le cache).
- **Covers** — StaleWhileRevalidate, 500 entrées, 30 jours.
- **MP3 téléchargés** (`/audio/*.mp3`) — CacheFirst, 500 entrées, 1 an, `rangeRequests: true` pour le seek dans les fichiers cachés.
- **Bannière offline** dans `App.vue` quand `navigator.onLine` flips false.
- **SSE channels** (`_listenAlbumProgress`, `discover.refresh`) skipés au boot si offline.

## Gestures (swipes + long-press)

`src/composables/useGestures.js` — composable unifié pour swipe horizontal/vertical + long-press, utilisé dans `MobilePlayer.vue` (swipe bas pour fermer le fullscreen, swipe gauche/droite pour changer de track avec preview en coverflow).

## Couleur d'accent adaptative

`src/lib/extractColor.js` — extrait la couleur dominante d'une cover (canvas pixel sampling) pour adapter l'accent couleur au morceau en cours. Utilisé dans `MobilePlayer.vue` fullscreen.

## Lyrics synchronisés

`src/composables/useLyrics.js` — fetch des paroles synchronisées (LRC format) et calcul de la ligne active en fonction du `currentTime` de l'audio. Affiché dans le fullscreen player.

## Docker / k8s

### Dockerfile
Build multi-stage (kuro pattern — frontend + backend dans un seul conteneur) :
1. `web-builder` — `npm ci` + `npm run build` → `dist/`
2. `deps` — `npm ci --omit=dev` → node_modules prod uniquement
3. `runtime` — node:20-bookworm-slim + python3 + ffmpeg + yt-dlp (dernière release GitHub). Copie `dist/`, `node_modules/`, `server.cjs`. User non-root `wax`. Port 3000.

Le backend sert `dist/` à la racine et fait le fallback SPA sur `index.html`.

⚠️ Le build est `--no-cache` dans la CI → yt-dlp est re-téléchargé à chaque pipeline (latest). Si YouTube casse yt-dlp, c'est ici que ça se verra.

### k8s/
- `namespace.yaml` — namespace `wax`
- `deployment.yaml` — `replicas: 1`, `strategy: Recreate` (PVC RWO ne supporte pas le rolling update). Env vars depuis secret `wax-auth`. Pull secret `gitlab-registry`.
- `service.yaml` — ClusterIP :80 → :3000
- `ingress.yaml` — Traefik, host `wax.maiz.local`, entrypoint `web`
- `pvc.yaml` — RWO 10 Gi sur `/data` (library JSON + MP3 + covers)
- `networkpolicy.yaml` — **Ingress** : uniquement depuis les pods Traefik (`kube-system`, label `app.kubernetes.io/name=traefik`) sur port 3000. **Egress** : DNS vers CoreDNS (`kube-system:53`) + internet public HTTP/HTTPS (RFC1918 exclu — le pod ne peut pas atteindre le LAN ni les autres pods). Requiert k3s ≥ v1.21 (network policy controller intégré).

## File map (src/)

**Entry** : `main.js` → Pinia + Vant CSS + `mobile.css` → `App.vue`

**`App.vue`** :
- `van-nav-bar` en haut (titre avec fade-in au scroll sur les sub-views — pattern Spotify)
- Bannière offline `WifiOff` entre la nav et le scroll
- `.view-scroll` avec les vues (`v-show` top-level, `v-if` drill-down) + transition `view-push/pop/fade` selon la profondeur de l'historique
- `<MobilePlayer />` — mini barre + popup plein écran
- `van-tabbar` 4 onglets (Accueil / Rechercher / Bibliothèque / Réglages)
- `<ModalRoot />` — modales impératives legacy
- `<LoginGate />` (z-index 200) / `<ProfileGate />` (z-index 100)
- `<van-action-sheet>` singleton

**`src/views/`** :
- `ViewHome.vue` — Salutation (Bonjour/Bonsoir), grille 2-col récemment écoutés + "Pour toi" (store `discover`)
- `ViewSearch.vue` — `van-search` + résultats. Tap → stream, ♥ → favoris. Choix de qualité (128/192/320k) au téléchargement.
- `ViewLibrary.vue` — Biblio unifiée Spotify-style. Chips Tout/Playlists/Albums/Artistes/Titres
- `ViewPlaylist.vue` — `<MobileHero>` + tracklist + action sheets
- `ViewAlbum.vue` — `<MobileHero>` + tracklist Deezer + library-match
- `ViewArtist.vue` — `<MobileHero shape="circle">` + tracks biblio + recommandés
- `ViewMix.vue` — `<MobileHero>` + tracklist mix YouTube
- `ViewSettings.vue` — Profil, Apparence (22 thèmes + accent), Langue, EQ, Stockage offline (usage + clear cache + repair), Bibliothèque (counts + album rescan), Sauvegarde (export/import JSON), Danger (reset)

**`src/components/`** :
- `LoginGate.vue` — auth gate (z-index 200, state offline)
- `ProfileGate.vue` — gate "Qui écoute ?"
- `MobileHero.vue` — hero réutilisable (cover blurée, FAB play, slot actions)
- `MobileTrackCell.vue` — ligne de track (`thumb` ou `index` variant) avec animation heart-pop sur like
- `MobilePlayer.vue` — héberge les 2 `<audio>`, mini player + popup fullscreen. Swipe bas = fermer, swipe gauche/droite = prev/next avec preview coverflow. Couleur d'accent adaptative depuis la cover. Lyrics synchronisés.
- `ModalRoot.vue`, `BulkAddBody.vue`, `AddToPlaylistBody.vue` — modales legacy encore utilisées

**`src/composables/`** :
- `useGestures.js` — swipe (horizontal/vertical) + long-press avec feedback tactile
- `useLyrics.js` — fetch + parsing LRC, ligne active par currentTime

**`src/stores/`** :
- `auth.js` — token HMAC, `authEnabled`, `verify()`, `login()`, `logout()`
- `profile.js`, `library.js`, `playlists.js`, `player.js`, `prefs.js`, `view.js`, `mix.js`, `search.js`, `streams.js`, `discover.js`, `jobs.js`, `accent.js`

**`src/lib/`** :
- `api.js` — `apiUrl()`, `apiUrlWithProfile()`, `api()` (envoie `Authorization` + `X-Wax-Profile` automatiquement)
- `extractColor.js` — dominant color extraction depuis une cover (canvas pixel sampling)
- `format.js`, `icons.js`, `themes.js`, `i18n.js`, `modal.js`, `toast.js`, `backup.js`

**`src/styles/`** :
- `mobile.css` — palette "Midnight" (dark), vars Vant, layout primitives, transitions view-push/pop/fade

## Flux clés

### Login → profil → app
1. `auth.loadToken()` → si token en localStorage, `auth.verify()` → 200 + `authEnabled` → `bootstrapAfterAuth()`
2. Si pas de token ou token invalide → `LoginGate` affiché (spinner pendant vérif, formulaire après)
3. Submit login → `auth.login(email, pw)` → token HMAC → `auth.loggedIn = true` → watch déclenche `bootstrapAfterAuth()`
4. `bootstrapAfterAuth()` → `profile.fetch()` → si `needsPicker` → `ProfileGate`
5. Profil choisi → `library.fetch()`, `playlists.fetch()`, `player.restorePlayerState()`, etc.

### Search → stream
1. `ViewSearch` → `search.runSearch()` → `api('/api/search?q=...')`
2. Tap résultat → `streams.streamSearchResult(r, null, player)` → `player.loadAndPlay()`
3. `audioEl.src = apiUrl('/api/stream/<ytId>')` → `fetchAndProxy()` côté serveur → audio CDN YouTube

### Téléchargement
`lib.downloadTrack(trackId)` → `POST /api/library/:id/download` (avec qualité) → SSE `/api/jobs/:id/progress` → `track.file = '/audio/<id>.mp3'`. Pool client 4-large (`_acquireDownloadSlot`) pour ne pas saturer les connexions HTTP.

## Conventions

- **Vant** : auto-import via `unplugin-vue-components`. Pour les APIs impératives (`showToast`, `showConfirmDialog`), importer depuis `'vant'`.
- **Action sheet singleton** : `useActionSheetStore().open([...])` — ne pas monter de `<van-action-sheet>` par vue (bug de double-mount avec `v-show`).
- **Safe areas** : `--safe-top` / `--safe-bottom` dans `mobile.css`. Tout élément fixe en a besoin.
- **Composition API + `<script setup>`** uniquement.
- **Pas de commentaires** sauf si le WHY est non-obvieux.
- **Commit workflow** : bump version dans `package.json` (patch/minor/major), update README si user-visible, update CLAUDE.md si archi change, puis commit + push en un seul commit.

## Capacitor (natif iOS/Android)

`ios/` et `android/` sont gitignorés — régénérés par `npx cap add ios/android`. Workflow :

```bash
npm run build
npx cap add ios       # première fois
npm run cap:setup     # patches background audio (idempotent)
npm run ios           # build + sync + open Xcode
```

`scripts/setup-native.mjs` applique les patches background audio (iOS Info.plist + AppDelegate.swift, Android AndroidManifest.xml).

## TODOs / gaps connus

- Drag-reorder dans les playlists non porté (besoin d'un long-press handle mobile)
- Création/renommage de playlists et profils passent encore par `window.prompt` / `promptModal` → à remplacer par un sheet Vant
- Offline audio côté Capacitor : les MP3 téléchargés sont sur le PVC serveur, pas sur le device — `@capacitor/filesystem` requis pour un vrai mode offline natif
- Profile avatars : initiale seule, pas de photo depuis la caméra
- Pas de tests automatisés
- Les native projects (`ios/`, `android/`) ne sont pas commités — `cap add` les régénère par checkout
