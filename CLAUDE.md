# CLAUDE.md — Wax codebase map

Ce fichier est pour **toi, Claude futur**. Lis-le en premier à chaque session sur ce projet.

## TL;DR — c'est quoi ?

**Wax** est une app musicale web/mobile :
- **Frontend** — Vue 3 + Vite + Pinia + **Vant** (UI kit mobile) + **Lucide** icons. **UI/UX calquée sur Spotify iOS** depuis la v0.19 : palette #121212 + vert #1ED760 (thème `spotify` par défaut), police Figtree, tab bar 3 onglets, heros en dégradé tiré de la cover, action sheets plein écran avec artwork. Multi-profil (picker en cercles). **Login obligatoire** avant le choix du profil. PWA offline-capable avec service worker Workbox.
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
  - `wax-ai` — clé `anthropic-api-key` pour la génération de playlist IA (injectée via `ANTHROPIC_API_KEY`, `optional: true`). **N'est PAS créé à la main** : le stage `deploy` de la CI le matérialise (create-or-update) depuis la **variable CI/CD GitLab masquée `ANTHROPIC_API_KEY`** (Settings → CI/CD → Variables), juste avant le `rollout restart`. Étape skippée si la variable n'existe pas. Donc poser la clé en prod = ajouter la variable GitLab, pas de kubectl.

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
- **`src/components/LoginGate.vue`** — overlay plein écran en 2 étapes façon Spotify : écran "Start" (halo coloré + logo + tagline + pill verte "Se connecter") → formulaire (top bar "Connexion" + chevron retour, labels gras "Ton e-mail ?"/"Ton mot de passe ?", inputs gris pleins, pill blanche). Spinner pendant `auth.checking`, `<WifiOff>` + "Pas de connexion" quand offline sans token.
- **`src/lib/api.js`** — envoie `Authorization: Bearer <token>` sur chaque requête. `apiUrlWithProfile()` ajoute `?profile=<id>&_token=<token>` pour les EventSource (SSE ne peut pas envoyer de headers).
- **`App.vue`** — `bootstrapAfterAuth()` : `profile.fetch()` → si `needsPicker` → stop → `ProfileGate`. Sinon `library.fetch()`, `playlists.fetch()`, `player.restorePlayerState()`, etc. Watch sur `auth.loggedIn` déclenche `bootstrapAfterAuth()` quand le user se connecte.

## API base URL — web vs Capacitor

`src/lib/api.js` exporte `apiUrl(path)` (préfixe `VITE_API_BASE_URL`) et `apiUrlWithProfile(path)` (ajoute `?profile=<id>&_token=<token>` pour les SSE). **Tout** ce qui construit une URL backend doit passer par l'un de ces deux.

En dev, `VITE_API_BASE_URL` est vide, le proxy Vite redirige. En Capacitor, setter à l'URL du backend déployé avant `npm run build && cap sync`.

## Multi-profil

Chaque requête porte `X-Wax-Profile: <id>` → le serveur route vers `library/users/<id>/library.json` + `playlists.json`. Audio MP3, covers, photos artistes et cache Deezer sont partagés.

- **Profil par défaut** (`id: 'default'`) auto-créé au premier boot. Migration auto depuis l'ancien `library/library.json` racine.
- **Store** : `src/stores/profile.js` — id actif persisté dans `localStorage['wax:active-profile']`. `api.js` lit la même clé directement.
- **`<ProfileGate />`** — overlay "Qui écoute ?" quand `profile.needsPicker`. Avatars **circulaires** (grille style "Choose artists" de Spotify). Création inline (nom + couleur parmi `ACCENT_SWATCHES`), renommage / suppression (sauf `default`). Logout (si auth activée) en pill au bas des réglages.
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
- **`warmOfflineCache`** (re-fetch des MP3 téléchargés vers le Cache Storage) = **bouton manuel uniquement** (Réglages → Hors-ligne → "Vérifier le cache"). ⛔ Ne le rebranche PAS en auto au boot / sur l'event online : s'il crashe l'onglet (OOM iOS), l'auto-run transforme un crash unique en **boucle de reload infinie** ("un problème récurrent est survenu"). ⛔ Et dans le worker, `cache.put(url, res)` — **jamais `res.clone()`** : cloner une Response dont l'autre branche n'est jamais lue bufferise le MP3 entier en RAM JS → OOM avec POOL workers en vol.

## Enchaînement auto en arrière-plan (lock screen) — double-buffer gapless

**Le contexte (limitation iOS, pas un bug à nous).** En PWA standalone iOS, WebKit ne déclenche **pas** l'événement `ended` quand l'app est en arrière-plan / écran verrouillé ([#173332](https://bugs.webkit.org/show_bug.cgi?id=173332)), et détruit la session audio en fin de piste — au point que même les boutons du lock screen gèlent ([#261858](https://bugs.webkit.org/show_bug.cgi?id=261858)). Régressé depuis iOS 16. **Aucun fix PWA garanti** ; la seule voie sûre = build natif Capacitor (`UIBackgroundModes: audio` + `AVAudioSession.playback`, déjà câblé via `scripts/setup-native.mjs`).

**Ce que fait `stores/player.js` (best-effort, maximise les chances).** Double-buffer gapless via les **deux** `<audio>` (`audioEl` actif / `audioEl2` spare) :
- Les écouteurs sont liés aux **deux** éléments (`_bindListeners`), chacun ignore les events de l'élément qui n'est pas `this.audioEl` (garde `active()`).
- `_prepareNext()` (appelé **eager** en fin de `loadAndPlay` + sur `toggleShuffle`/`cycleRepeat`/mutations de file/`restorePlayerState` + à la fin de `_swapToPreloaded`) calcule l'index suivant (`_planned`, random shuffle roulé **une fois**) et **bufferise réellement** le morceau suivant dans `audioEl2` (`src` + `load()`), en le laissant **`.muted = true`**. Blob offline minté à l'avance ; URL directe online/stream.
- **Le spare est TOUJOURS `.muted`** (cf. `bindAudio`/`_prepareNext`), démuté seulement quand il devient l'actif (`_swapToPreloaded`). iOS relance **tout** `<audio>` bufferisé au retour au premier plan → sans ça, le spare jouait le morceau suivant **par-dessus** l'actif (2 sons). Le mute est indépendant du user-mute (qui passe par `volume`).
- `_swapToPreloaded()` **échange les refs** `audioEl`↔`audioEl2`, **démute** le nouvel actif / **re-mute** l'ancien, et joue l'élément déjà bufferisé — transition sans fetch, donc sans trou (le trou fait tomber la session iOS). Appelé par `_onAudioEnded` ET `next()`.
- `loadAndPlay` ne sert qu'aux sauts **non séquentiels** (tap, `playFromList`, `prev`, restore) : charge sur l'élément actif (toujours démuté), online en **sync** (`trackPlayUrl`), offline awaité (blob obligatoire, iOS bypasse le SW).
- Crossfade (`crossfadeEnabled`, opt-in) possède `audioEl2` → `_prepareNext`/`_swapToPreloaded` se désactivent dans ce mode (mutuellement exclusifs).

**Garde-fous si tu touches à ça (durement appris) :**
- ⛔ **Ne déplace PAS la construction du spare sur l'event `playing`** (ni aucune dépendance à un event qui ne fire pas en background). C'est ce qu'a tenté la 0.19.5 → `playing` ne se déclenche pas en PWA iOS backgroundée → spare jamais reconstruit après un swap → **enchaînement background mort**. Reverté. Le `_prepareNext` doit rester **eager** (synchrone après le `play()`).
- Le spare reste **muté** en permanence ; seul l'actif est démuté.
- Compare `audioEl2.src` **normalisé** (relatif vs absolu) avant de swapper ; swappe les refs **avant** de `pause()` l'ancien (sinon son event `pause` flippe `playing`) ; révoque le blob sortant **après** avoir vidé le `src`.
- ⚠️ **Tout fix audio iOS est invérifiable dans la preview Chrome** (session/background/foreground-resume). Vérifie la logique (états des `<audio>`, swaps, mute), ship **minimal + un changement à la fois**, et laisse le user tester sur device avant d'empiler. Cf. mémoire `ios-player-changes-unverifiable`.

Vérifié en preview : spare bufferisé+muté pendant la lecture, swap synchrone sur `ended`/`next` (démute/re-mute), ping-pong des 2 éléments sur N pistes, wrap repeat='all', stop en fin de file, spare forcé à jouer = silencieux. Reste hors de portée (iOS) : `ended` pas déclenché en background, et le pause→reprise écran verrouillé qui peut repartir muet.

## Gestures (swipes + long-press)

`src/composables/useGestures.js` — composable unifié pour swipe horizontal/vertical + long-press, utilisé dans `MobilePlayer.vue` (swipe bas pour fermer le fullscreen, swipe gauche/droite pour changer de track avec preview en coverflow).

## Couleur dominante (tint player + heros + sheets)

`src/lib/extractColor.js` — extrait la couleur dominante d'une cover (canvas pixel sampling). Depuis la v0.19 elle ne touche **plus** `--accent` (le vert reste l'identité) : elle teinte le **canvas** comme Spotify —
- `MobilePlayer.vue` : dégradé du player fullscreen (`npColor`), fond du mini player flottant, fond coloré du sheet paroles.
- `MobileHero.vue` : dégradé vertical des heros album/playlist/mix.
- `ActionSheet.vue` : dégradé du sheet contextuel quand un header `cover` est passé.

## Lyrics synchronisés

`src/composables/useLyrics.js` — fetch des paroles synchronisées (LRC format) et calcul de la ligne active en fonction du `currentTime` de l'audio. Affiché dans le fullscreen player.

## Stats d'écoute réelles (Wrapped — `ViewWrapped.vue`)

**Temps d'écoute réel, pas l'estimation.** Avant, le hero "écoute cumulée" du Wrapped valait `Σ (durée × playCount)` — sur-compte (un `playCount` est posé à 30s, puis on créditait la durée **entière** du morceau). Depuis 0.19.16 on track le **vrai temps de contenu entendu** :
- **Player** (`stores/player.js`) : `_accumulateListen()` (appelé en tête de `_onAudioTimeUpdate`) somme les deltas de `currentTime` dans `_listenBuffer`, en **ignorant les seeks/resets** (`dt` hors `0..2s`). Flush vers le serveur tous les ~15s (`_flushListen` → `library.recordListen`). Flush **aussi** sur pause (`_onAudioPause`), `stop()`, et au changement de piste (`loadAndPlay`/`_swapToPreloaded`), avec reset de `_listenLastT = null` pour que le `currentTime=0` de la nouvelle piste ne compte pas comme un saut.
- **Store** (`stores/library.js`) : état `listenedSeconds`, `fetchStats()` (GET au mount du Wrapped) + `recordListen(sec)` (bump optimiste + POST fire-and-forget).
- **Serveur** (`server.cjs`) : `GET /api/stats` + `POST /api/stats/listen` (clamp 0..7200s/appel), par profil dans `library/users/<id>/stats.json`. ⚠️ **Seed au premier accès** : `getStats` initialise `listenedSeconds` depuis l'ancienne estimation `Σ durée×playCount` → les profils existants ne voient pas leur total tomber à zéro, le vrai temps s'accumule par-dessus. Supprimer `stats.json` re-seede depuis l'estimation.

**Wrapped UI** : hero = `lib.listenedSeconds` (fallback estimate tant que le fetch n'a pas répondu) ; classements top titres/artistes en **liste numérotée** avec **médailles** or/argent/bronze (`.wp-rank-1/2/3`), façon "Top Songs" du vrai Spotify Wrapped ; 3e stat = **artistes différents** (`distinctArtists`, vrai indicateur de variété) au lieu de l'ancien "découvertes (12 mois)" qui doublonnait la taille de la biblio. ⛔ **Pas de barre de progression par ligne** : testée en 0.19.16 puis retirée — une barre verte fine sous chaque titre se confond avec le scrubber de lecture (chaque ligne semble "en cours de lecture"). **Pas de header interne** : comme `ViewSettings`, la vue s'appuie sur la `van-nav-bar` d'`App.vue` (sub-view plate, titre "Ta sélection" + chevron retour) — ne pas re-rendre de header dans la vue (doublon).

## IA — génération de playlist (Claude Haiku)

Décris une ambiance → Claude Haiku compose une tracklist → le serveur résout chaque titre sur YouTube → playlist créée.

- **Serveur** (`server.cjs`, `POST /api/ai/playlist`) : `getAnthropic()` = client **lazy** (`require('@anthropic-ai/sdk')` + `new Anthropic()` seulement si `ANTHROPIC_API_KEY` présente, sinon **null** → endpoint renvoie **503**, le serveur boote toujours sans clé). Modèle `claude-haiku-4-5` (rapide/pas cher, 1$/5$ par M tokens), **structured outputs** (`output_config.format` + `AI_PLAYLIST_SCHEMA`) → JSON garanti `{name, tracks:[{title,artist}]}`. ⚠️ Haiku **ne supporte pas** `effort` ni le thinking — ne pas les passer. Chaque suggestion est résolue via `aiResolveTrack()` (= `ytsearch1` à travers le sémaphore `runYtDlp`, résout `null` en cas de miss → `Promise.all` ne casse jamais), pliée en biblio en `liked:false` (de-dup par `ytId`), puis la playlist (`aiPrompt` gardé en méta) pointe sur les ids. Tolérant aux échecs partiels (titres introuvables skippés). Renvoie `{playlist, requested, resolved}`. **La clé ne quitte JAMAIS le backend.**
- **Front** : overlay singleton `AiPlaylistSheet.vue` (monté dans `App.vue`), piloté par `view.aiOpen` / `view.openAi()` / `view.closeAi()`. Textarea + chips d'exemples + état loading (~10-15s : Haiku + N recherches yt-dlp). Au succès : `playlists.fetch()` + `lib.fetch()` → toast → `view.switchTo('playlist', id)`. Deux points d'entrée : carte "Playlist IA" de la grille **Parcourir** (Search) + le **"+"** de la Bibliothèque (action sheet "Nouvelle playlist" / "Créer avec l'IA").
- **Déploiement** : `ANTHROPIC_API_KEY` via secret K8s `wax-ai` (clé `anthropic-api-key`), injectée dans le pod en `optional: true` (cf. `k8s/deployment.yaml`). `@anthropic-ai/sdk` est en `dependencies` mais **uniquement `require` par `server.cjs`** → jamais bundlé côté front (Vite n'importe rien depuis `src/`).

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
- `networkpolicy.yaml` — **Ingress** sur port 3000 : Traefik (`kube-system`, accès LAN `wax.maiz.local`) **ET** cloudflared (`cloudflared` ns, accès public `wax.nc-maiz.org` — bypass Traefik, va direct sur le Service). **Egress** : DNS CoreDNS (`kube-system:53`) + internet public HTTP/HTTPS (RFC1918 exclu). Requiert k3s ≥ v1.21.

## File map (src/)

**Entry** : `main.js` → Pinia + Vant CSS + `mobile.css` → `App.vue`

**`App.vue`** :
- `van-nav-bar` **uniquement sur les sub-views** (`v-if`). Deux modes : `nav-float` (heros playlist/album/artist/mix — chevron flottant transparent, scrim + titre qui fade-in au scroll via `--wax-nav-bg-opacity` / `--wax-nav-title-opacity`) et solide centré (settings/wrapped). Les onglets top-level n'ont pas de nav — chaque vue rend son propre header, `.view-scroll.no-nav` pad le safe-top.
- Bannière offline `WifiOff` entre la nav et le scroll
- `.view-scroll` avec les vues (`v-show` top-level, `v-if` drill-down) + transition `view-push/pop/fade` selon la profondeur de l'historique
- `<MobilePlayer />` — mini player flottant + popup plein écran
- `van-tabbar` **3 onglets** (Accueil / Rechercher / Bibliothèque) — actif **blanc** (pas accent), fond noir frosted. Réglages = sub-view de `home` (roue dentée sur l'Accueil), `wrapped` aussi. `SUBVIEW_PARENT` + `HERO_SUBVIEWS` pilotent tab actif + mode de nav.
- `<ModalRoot />` — modales impératives legacy
- `<LoginGate />` (z-index 200) / `<ProfileGate />` (z-index 100)
- `<ActionSheet />` singleton custom (voir Conventions)

**`src/views/`** :
- `ViewHome.vue` — Salutation grasse + icônes (Sparkles → wrapped, Settings → réglages), tuiles 2-col de reprise rapide, carrousels horizontaux (récemment joués / top joués / top artistes en cercles / "Pour toi" du store `discover`). Les 3 carrousels de stats lisent `lib.tracks[].playCount`/`lastPlayedAt` ; ils n'affichent donc QUE des titres en biblio. Le player (`_recordPlay`, appelé par `_trackPlayProgress` à >30s) compte **toute** lecture, y compris les streams (recherche/mix/discover) qu'il **plie en biblio en `liked:false`** (pliés → comptent dans les carrousels, mais hors Favoris). Sans ça, un profil qui n'écoute que des streams voyait ses carrousels figés.
- `ViewSearch.vue` — Titre "Rechercher" + **barre blanche** (van-search restylée), grille "Parcourir" de cartes colorées avec cover inclinée (→ favoris/hors-ligne/chips library via `view.libraryFilter`/wrapped), recherches récentes, résultats. Tap → stream, ♥ → favoris. **`isLiked` teste `liked !== false`** (pas la simple présence en biblio) : un titre ajouté via playlist/mix/album est en `liked:false` et NE doit PAS s'afficher coché. `toggleLike` passe par `lib.toggleFav` (flip du flag), jamais `lib.remove` (qui supprimerait le titre partout).
- `ViewLibrary.vue` — Header avatar + "Ta bibliothèque" + loupe (toggle recherche) + "+". **2 chips seulement : Playlists | Titres** (défaut Playlists ; Albums/Artistes retirés des chips — trop foutoir — mais toujours atteignables via les cartes "Parcourir" de Search qui posent `view.libraryFilter='albums'/'artists'` → mode browse sans chip actif). **Le chip Titres montre TOUS les `lib.tracks`** (pas seulement les favoris) — un titre arrive en biblio en `liked:false` via ajout playlist/album/mix ET via `_recordPlay`, le user veut tout voir là ; le cœur de chaque row indique l'état favori, et la tuile Favoris (sous Playlists) reste le sous-ensemble aimé. **Recherche globale** : dès qu'il y a une query, sections "Playlists" (cartes) + "Titres" (rows, sur **toute** la lib via `displayedTracks`), indépendamment du chip — avant, les titres ne remontaient QUE sous le chip Titres (bug). Tuile Favoris en dégradé indigo, Hors-ligne en vert. Rows 64px sans chevron. Vue grille = `grid-template-columns: repeat(2, minmax(0, 1fr))` + `min-width:0` sur les items — **PAS `1fr`** (= `minmax(auto,1fr)`) qui laisse un nom long nowrap gonfler une colonne au-delà du viewport (1 carte géante, reste hors-écran).
- `ViewPlaylist.vue` — `<MobileHero>` (FAB pause si contexte courant) + tracklist `thumb` + action sheets avec header cover
- `ViewAlbum.vue` — `<MobileHero>` + tracklist Deezer **variant `plain`** (ni index ni thumb, comme Spotify) + library-match
- `ViewArtist.vue` — `<MobileHero shape="banner">` (photo full-bleed, nom overlay) + tracks biblio + recommandés
- `ViewMix.vue` — 3 états : **loading** (`mix.loading`) → hero du `seed` (titre source + cover) + `MobileSkeleton variant="row"` ×8 + meta "Génération du mix…" ; **chargé** (`mix.current`) → `<MobileHero>` + tracklist + bouton Sauvegarder outline ; **vide** → empty state. `mix.streamFrom` bascule la vue AVANT le fetch (navigation immédiate + shimmer), token `_reqId` anti-clobber.
- `ViewSettings.vue` — **sub-view de home** (roue dentée). Ligne profil en tête (avatar + Changer de profil), sections plates à headers gras (plus de cartes inset), Langue, EQ, Lecture, Bibliothèque, Hors-ligne, Sauvegarde, Danger, pill "Se déconnecter" en bas. **Pas de picker de thème/accent** — l'apparence est verrouillée sur le thème `spotify` (cf. `prefs.load` qui force `themeId='spotify'` + accent vert à chaque boot, quelle que soit la valeur stockée).

**`src/components/`** :
- `LoginGate.vue` — auth gate 2 écrans Start → formulaire (z-index 200, state offline)
- `ProfileGate.vue` — gate "Qui écoute ?" en cercles
- `ActionSheet.vue` — sheet contextuel plein écran style Spotify : dégradé depuis la couleur dominante du header.cover, bloc cover+titre+artiste, rows à icônes, "Fermer" centré. Bindé sur le store actionSheet.
- `MobileHero.vue` — hero détail. Props : `cover`, `shape` (`square`/`circle`/`banner`), `title`, `subtitle` (ligne grasse), `meta` (ligne muted), `playing` (FAB play↔pause), slot `#actions` (icônes à gauche du FAB). Dégradé = couleur dominante extraite de la cover, fallback `bgGradient`. Banner = photo full-bleed + nom overlay (artistes).
- `MobileTrackCell.vue` — ligne de track (`thumb` / `index` / `plain`) : titre 16px, badge vert hors-ligne inline dans le sous-titre, barres d'égaliseur animées (figées en pause) sur le titre en cours, heart-pop sur like
- `MobilePlayer.vue` — héberge les 2 `<audio>`, mini player **flottant arrondi teinté** (couleur dominante) + popup fullscreen en **dégradé plein** (plus de blur) : top bar chevron/"En cours de lecture"/⋮ (ouvre le sheet track), meta alignée à gauche + cœur, **play blanc 64px glyphe noir**, extras (vitesse / paroles / file). Paroles = sheet **fond coloré** lignes grasses. Swipe bas = fermer, swipe gauche/droite = prev/next avec preview coverflow.
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
- `mobile.css` — palette Spotify-like par défaut (#121212 / #1ED760 / `--on-accent` noir pour le texte sur accent), police Figtree, vars Vant (tabbar active **blanche**), nav float/solid, mini player flottant, layout primitives, transitions view-push/pop/fade. Le thème `spotify` est **verrouillé** : `prefs.load()` force `themeId='spotify'` + accent vert à chaque boot (le picker de thèmes a été retiré). La machinerie multi-thèmes (`lib/themes.js`, `applyTheme`, `setTheme`) reste en place mais n'est plus exposée.

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
- **Action sheet singleton** : `useActionSheetStore().open(actions, header?)` → promesse `{index, name}`. Actions `{name, icon? (composant Lucide, markRaw géré par le store), color?, disabled?}` ; header `{cover?, title?, subtitle?}` déclenche le bloc artwork + dégradé. Rendu par `<ActionSheet />` monté une seule fois dans App.vue — ne pas monter de sheet par vue.
- **Safe areas** : `--safe-top` / `--safe-bottom` dans `mobile.css`. Tout élément fixe en a besoin.
- **Affichage grand écran (≥600px)** : l'app reste **mobile-first** ; on ne fait PAS de layout desktop. À ≥600px, `mobile.css` cadre l'app en **colonne centrée façon téléphone** (`--app-col: 480px`) sur fond noir. Mécanisme : `.app-shell { max-width: var(--app-col); margin-inline: auto; transform: translateZ(0) }` — le `transform` fait de `.app-shell` le **containing block** de ses enfants `position: fixed` (tab bar, mini-player, action sheet, gates, modales) → confinés à la colonne automatiquement. ⚠️ Les **popups Vant teleportés sur `<body>`** (player fullscreen `.np-popup`, file `.queue-popup`) sont HORS de la colonne → recadrés à part dans `MobilePlayer.vue` (`.np-screen`/`.queue-screen` → `max-width: var(--app-col)`). Le `transform` ne s'applique qu'à ≥600px, donc les workarounds compositor iOS (vrais téléphones <600px) sont intacts.
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
