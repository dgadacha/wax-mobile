# CLAUDE.md — Wax codebase map

Ce fichier est pour **toi, Claude futur**. Lis-le en premier à chaque session sur ce projet.

## TL;DR — c'est quoi ?

**Wax** est une app musicale web/mobile :
- **Frontend** — Vue 3 + Vite + Pinia + **Vant** (UI kit mobile) + **Lucide** icons. Multi-profil style Netflix. **Login obligatoire** avant le choix du profil.
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
- **CI** : `.gitlab-ci.yml` — stages `build` (docker build + push) et `deploy` (kubectl via l'agent `wax-agent`). Se déclenche sur push sur `main`.
- **Agent K8s** : `wax-agent` (helm `gitlab/gitlab-agent`, namespace `wax`). Context kubectl dans la CI : `kidnar/wax:wax-agent`.
- **Namespace** : `wax` sur le cluster k3s du serveur `192.168.1.3` (user `salon`).
- **Ingress** : `wax.maiz.local` via Traefik.
- **Secrets K8s** :
  - `gitlab-registry` — deploy token pour puller l'image depuis le registry GitLab.
  - `wax-auth` — clés `email` + `password` pour l'auth app (injectées dans le pod via `WAX_AUTH_EMAIL` / `WAX_AUTH_PASSWORD`).

## Authentification

**Flux** : `LoginGate` (plein écran) → `ProfileGate` ("Qui écoute ?") → app.

### Backend (`server.cjs`)
- `POST /api/auth/login` — vérifie `email` + `password` via `crypto.timingSafeEqual`, retourne un token 32 bytes hex. TTL 30 jours, stocké in-memory.
- `GET /api/auth/verify` — vérifie que le token courant est valide.
- Middleware `app.use('/api', authMiddleware)` — protège tous les `/api/*`. Exemptions :
  - `/api/auth/login` (l'endpoint lui-même)
  - `/api/stream/`, `/api/cover/`, `/api/preview/`, `/api/artist-photo/` — contenu YouTube public, inaccessible via header custom (`<audio>` / `<img>` natifs ne peuvent pas envoyer `Authorization`)
- Credentials via env vars `WAX_AUTH_EMAIL` + `WAX_AUTH_PASSWORD` (secret K8s `wax-auth`). Si les deux sont vides, l'auth est désactivée.

### Frontend
- **`src/stores/auth.js`** — token stocké dans `localStorage` (`wax:auth-token`). Actions : `loadToken()`, `verify()`, `login(email, password)`, `logout()`.
- **`src/components/LoginGate.vue`** — overlay plein écran (même style dark que ProfileGate), spinner pendant `auth.checking`, formulaire email/password sinon. `z-index: 200` (au-dessus de ProfileGate à 100).
- **`src/lib/api.js`** — envoie `Authorization: Bearer <token>` sur chaque requête `api()`. `apiUrlWithProfile()` ajoute aussi `?_token=<token>` pour les EventSource (SSE ne peut pas envoyer de headers).
- **`App.vue`** — séquence init : `auth.loadToken()` → `auth.verify()` → si non connecté, return (LoginGate prend le relais) → `initAfterLogin()`. Un `watch` sur `auth.loggedIn` appelle `initAfterLogin()` quand le user se connecte via le formulaire.

## API base URL — web vs Capacitor

`src/lib/api.js` exporte `apiUrl(path)` (préfixe `VITE_API_BASE_URL`) et `apiUrlWithProfile(path)` (ajoute `?profile=<id>&_token=<token>` pour les SSE). **Tout** ce qui construit une URL backend doit passer par l'un de ces deux.

En dev, `VITE_API_BASE_URL` est vide, le proxy Vite redirige. En Capacitor, le setter à l'URL du backend déployé avant `npm run build && cap sync`.

## Multi-profil

Chaque requête porte `X-Wax-Profile: <id>` → le serveur route vers `library/users/<id>/library.json` + `playlists.json`. Audio MP3, covers, photos artistes et cache Deezer sont partagés.

- **Profil par défaut** (`id: 'default'`) auto-créé au premier boot. Migration auto depuis l'ancien `library/library.json` racine.
- **Store** : `src/stores/profile.js` — id actif persisté dans `localStorage` (`wax:active-profile`). `api.js` lit la même clé directement.
- **`<ProfileGate />`** — overlay "Qui écoute ?" quand `profile.needsPicker`. Création inline (nom + couleur parmi `ACCENT_SWATCHES`), renommage / suppression (sauf `default`).
- Switcher de profil → `location.reload()` (re-fetch de tous les stores).

## Stream audio — proxy YouTube CDN

`GET /api/stream/:videoId` :
1. `getStreamUrl(videoId)` lance yt-dlp avec `-g` (retourne l'URL directe, sans télécharger). Concurrence limitée à 3 via le sémaphore `runYtDlp`. Cache in-memory 5h.
2. Le serveur fait `https.get(audioUrl)` et pipe vers le client.
3. **Gestion des redirects** : yt-dlp peut retourner des URLs `redirector.googlevideo.com` qui font une ou plusieurs redirections 302. La fonction `fetchAndProxy(url, hopsLeft=5)` suit ces redirects côté serveur avant de piper le contenu — sinon le navigateur reçoit un 302 sans `Location` et l'audio échoue silencieusement.
4. Le header `Range` est forwardé pour le streaming partiel (206).

## Docker / k8s

### Dockerfile
Build multi-stage :
1. `web-builder` — `npm ci` + `npm run build` → `dist/`
2. `deps` — `npm ci --omit=dev` → node_modules prod uniquement
3. `runtime` — node:20-bookworm-slim + python3 + ffmpeg + yt-dlp (dernière release GitHub). Copie `dist/`, `node_modules/`, `server.cjs`. User non-root `wax`. Port 3000.

L'image contient **frontend + backend** dans un seul conteneur (kuro pattern) : le backend sert `dist/` à la racine et fait le fallback SPA sur `index.html`.

⚠️ Le build est `--no-cache` dans la CI → yt-dlp est re-téléchargé à chaque pipeline (latest). Si YouTube casse yt-dlp, c'est ici que ça se verra.

### k8s/
- `namespace.yaml` — namespace `wax`
- `deployment.yaml` — `replicas: 1`, `strategy: Recreate` (PVC RWO ne supporte pas le rolling update). Env vars depuis secret `wax-auth`. Pull secret `gitlab-registry`.
- `service.yaml` — ClusterIP :80 → :3000
- `ingress.yaml` — Traefik, host `wax.maiz.local`
- `pvc.yaml` — RWO 10 Gi sur `/data` (library JSON + MP3 + covers)

## File map (src/)

**Entry** : `main.js` → Pinia + Vant CSS + `mobile.css` → `App.vue`

**`App.vue`** :
- `van-nav-bar` en haut (titre dynamique, flèche sur sous-vues)
- `.view-scroll` avec les vues (`v-show` pour les onglets top-level, `v-if` pour les sous-vues drill-down)
- `<MobilePlayer />` — mini barre + popup plein écran
- `van-tabbar` 4 onglets (Accueil / Rechercher / Bibliothèque / Réglages)
- `<ModalRoot />` — modales impératives legacy
- **`<LoginGate />`** — auth gate (z-index 200)
- **`<ProfileGate />`** — profil gate (z-index 100)
- `<van-action-sheet>` singleton

**`src/views/`** :
- `ViewHome.vue` — Salutation + récemment écoutés + grille "Pour toi" (store `discover`)
- `ViewSearch.vue` — `van-search` + résultats. Tap → stream, ♥ → favoris
- `ViewLibrary.vue` — Biblio unifiée Spotify-style. Chips Tout/Playlists/Albums/Artistes/Titres
- `ViewPlaylist.vue` — `<MobileHero>` + tracklist + action sheets
- `ViewAlbum.vue` — `<MobileHero>` + tracklist Deezer + library-match
- `ViewArtist.vue` — `<MobileHero shape="circle">` + tracks biblio + recommandés
- `ViewMix.vue` — `<MobileHero>` + tracklist mix YouTube
- `ViewSettings.vue` — Réglages basiques (counts, reset, profil, accent)

**`src/components/`** :
- `LoginGate.vue` — **nouveau** auth gate
- `ProfileGate.vue` — gate "Qui écoute ?"
- `MobileHero.vue` — hero réutilisable (cover blurée, FAB play, slot actions)
- `MobileTrackCell.vue` — ligne de track (`thumb` ou `index` variant)
- `MobilePlayer.vue` — héberge les 2 `<audio>`, mini player + popup fullscreen
- `ModalRoot.vue`, `BulkAddBody.vue`, `AddToPlaylistBody.vue` — modales legacy encore utilisées

**`src/stores/`** :
- `auth.js` — **nouveau** token auth, `verify()`, `login()`, `logout()`
- `profile.js` — profils multi-utilisateur
- `library.js`, `playlists.js`, `player.js`, `prefs.js`, `view.js`, `mix.js`, `search.js`, `streams.js`, `discover.js`, `jobs.js`, `accent.js`

**`src/lib/`** :
- `api.js` — `apiUrl()`, `apiUrlWithProfile()`, `api()` (envoie `Authorization` + `X-Wax-Profile` automatiquement)
- `format.js`, `icons.js`, `themes.js`, `i18n.js`, `modal.js`, `toast.js`, `backup.js`

**`src/styles/`** :
- `mobile.css` — palette "Midnight" (dark), vars Vant, layout primitives
- `style.css` — legacy desktop, non importé (référence uniquement)

## Flux clés

### Login → profil → app
1. `auth.loadToken()` → si token en localStorage, `auth.verify()` → 200 → `initAfterLogin()`
2. Si pas de token ou token invalide → `LoginGate` affiché (spinner pendant la vérif, formulaire après)
3. Submit login → `auth.login(email, pw)` → token → `auth.loggedIn = true` → watch déclenche `initAfterLogin()`
4. `initAfterLogin()` → `profile.fetch()` → si `needsPicker` → `ProfileGate` affiché
5. Profil choisi → `library.fetch()`, `playlists.fetch()`, `player.restorePlayerState()`, etc.

### Search → stream
1. `ViewSearch` → `search.runSearch()` → `api('/api/search?q=...')`
2. Tap résultat → `streams.streamSearchResult(r, null, player)` → enregistre `stream-<ytId>`, `player.loadAndPlay()`
3. `audioEl.src = apiUrl('/api/stream/<ytId>')` → `fetchAndProxy()` côté serveur → audio CDN YouTube

### Téléchargement
`lib.downloadTrack(trackId)` → `POST /api/library/:id/download` → SSE `/api/jobs/:id/progress` → `track.file = '/audio/<id>.mp3'`

## Conventions

- **Vant** : auto-import via `unplugin-vue-components`. Pour les APIs impératives (`showToast`, `showConfirmDialog`), importer depuis `'vant'`.
- **Action sheet singleton** : `useActionSheetStore().open([...])` — ne pas monter de `<van-action-sheet>` par vue (bug de double-mount avec `v-show`).
- **Safe areas** : `--safe-top` / `--safe-bottom` dans `mobile.css`. Tout élément fixe en a besoin.
- **Composition API + `<script setup>`** uniquement.
- **Pas de commentaires** sauf si le WHY est non-obvieux.

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

- Bouton de téléchargement non câblé dans `ViewLibrary` (le flow backend existe)
- Drag-reorder dans les playlists non porté (besoin d'un long-press handle mobile)
- Création/renommage de playlists et profils passent encore par `window.prompt` — à remplacer par un sheet Vant
- Thèmes (22 thèmes desktop), langue, EQ, backup non portés dans `ViewSettings`
- Pas de tests automatisés
- Les native projects (`ios/`, `android/`) ne sont pas committé — `cap add` les régénère par checkout
