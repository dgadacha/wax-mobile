<p align="center">
  <img src="./public/textlogo-dark.png" alt="Wax" width="480" />
</p>

<h1 align="center">Wax mobile</h1>

<p align="center">
  Player musique mobile façon Spotify — YouTube en source, MP3 hors-ligne, multi-profil Netflix.
  <br/>
  <em>Fork mobile de <a href="https://github.com/dgadacha/wax">dgadacha/wax</a> (desktop Electron).</em>
</p>

<p align="center">
  <a href="https://github.com/dgadacha/wax-mobile"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-dgadacha%2Fwax--mobile-181717?logo=github"/></a>
  &nbsp;
  <a href="https://github.com/dgadacha/wax-mobile/actions/workflows/deploy-pages.yml"><img alt="Pages" src="https://img.shields.io/github/actions/workflow/status/dgadacha/wax-mobile/deploy-pages.yml?branch=main&label=Pages&logo=github"/></a>
  &nbsp;
  <a href="https://dgadacha.github.io/wax-mobile/"><img alt="Démo" src="https://img.shields.io/badge/d%C3%A9mo-dgadacha.github.io%2Fwax--mobile-7c5cff"/></a>
</p>

---

## Pour les utilisateurs

### Sur iPhone (Safari)

1. Ouvre <https://dgadacha.github.io/wax-mobile/> dans **Safari** (Chrome marche pas pour l'install — c'est Apple qui bloque).
2. Bouton **Partager** (le carré avec la flèche vers le haut).
3. Fais défiler et tape **Sur l'écran d'accueil**.
4. Confirme. L'icône Wax apparaît, l'app s'ouvre en plein écran sans la barre Safari.

> Astuce : à la première ouverture, choisis ton profil ou crée-en un. Si t'es le seul à utiliser ton iPhone, tape sur "Moi" — tu peux le renommer plus tard depuis Réglages.

### Sur Android (Chrome)

1. Ouvre <https://dgadacha.github.io/wax-mobile/> dans **Chrome**.
2. Menu (⋮) en haut à droite → **Installer l'application**, ou attends le prompt qui sort tout seul en bas.
3. L'app s'installe comme un APK natif — apparaît dans le tiroir et l'écran d'accueil.

### Une fois installée

- **Accueil** : tes derniers titres + une grille "Pour toi" qui se génère à partir de tes favoris.
- **Rechercher** : tape un titre, un artiste, ou colle une URL YouTube. Heart pour ajouter aux favoris, tap pour lire.
- **Bibliothèque** : tes playlists, albums et artistes regroupés. Le bouton "+ Nouvelle playlist" est dans le filtre Playlists.
- **Réglages** : choisis ton thème, ta couleur d'accent, ton EQ. Exporte/importe ta lib en JSON.
- **Multi-profil** : depuis Réglages → Profil → Changer, tu peux créer plusieurs profils. Chacun a ses propres favoris et playlists.

### Limites de la PWA (Safari iOS)

- **Lecture en background** : Safari finit par tuer la lecture après quelques minutes quand l'écran est verrouillé. C'est un choix d'Apple, pas une bug. Sur Android Chrome ça tient bien tant que la notif média est active.
- **Pas de retours haptiques** ni de share natif — fonctionne sur la version Capacitor (App Store / sideload Xcode) mais pas en PWA Safari.
- **Offline** : l'interface se lance hors-ligne (service worker précache l'app shell), mais la recherche / streaming / téléchargement ont besoin du réseau.

---

## Stack

- **Frontend** : Vue 3 + Vite + Pinia + [Vant](https://vant.pro) (UI mobile) + [Lucide](https://lucide.dev) (icons).
- **PWA** : `vite-plugin-pwa` (manifest + service worker précaching).
- **Wrapping mobile** : Capacitor 6 (iOS + Android) avec haptics, filesystem, share, preferences, status bar.
- **Backend** : Node 20 + Express + `yt-dlp` + `ffmpeg`, packagé via Docker + manifests k8s.

## Installation dev

### Prérequis

- Node 20+
- Pour le backend en local : `yt-dlp` + `ffmpeg` (`brew install yt-dlp ffmpeg`)
- Pour build iOS : Xcode 15+ et un Apple ID
- Pour build Android : Android Studio + JDK 17

### Lancer en dev (web mobile dans le navigateur)

```bash
git clone https://github.com/dgadacha/wax-mobile.git
cd wax-mobile
npm install
cp .env.example .env   # laisse VITE_API_BASE_URL vide pour le dev local

# Terminal 1 — backend
node server.cjs

# Terminal 2 — frontend (Vite proxy /api → :3000)
npm run dev
```

Ouvre <http://localhost:5173> et active le mode mobile dans les devtools (Cmd+Opt+M dans Chrome).

### Builder pour iOS / Android (vraie app)

Première fois, ajoute les plateformes natives + applique les patches background audio :

```bash
npm run build         # vite → dist/
npx cap add ios       # nécessite Xcode
npx cap add android   # nécessite Android Studio + JDK 17
npm run cap:setup     # patches background audio (idempotent)
```

Ensuite, pour reconstruire + ouvrir Xcode / Android Studio :

```bash
echo "VITE_API_BASE_URL=https://wax-api.nc-maiz.org" > .env

npm run ios            # build + cap sync + cap:setup + cap open ios
npm run android        # build + cap sync + cap:setup + cap open android
```

`scripts/setup-native.mjs` patche idempotamment :

- `ios/App/App/Info.plist` → `UIBackgroundModes = [audio]`
- `ios/App/App/AppDelegate.swift` → `AVAudioSession.setCategory(.playback)` + `beginReceivingRemoteControlEvents()`
- `android/app/src/main/AndroidManifest.xml` → permissions `WAKE_LOCK` + `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`

`npm run cap:sync` enchaîne `cap sync && cap:setup` pour ré-appliquer après chaque sync (Capacitor peut régénérer certains fichiers natifs).

## Déploiement PWA (GitHub Pages)

Un workflow `.github/workflows/deploy-pages.yml` build et publie à chaque push sur `main`. Setup une seule fois :

1. **Settings → Pages → Source** = "GitHub Actions".
2. **Settings → Secrets and variables → Actions** → New repository secret :
   - Name : `VITE_API_BASE_URL`
   - Value : l'URL publique de ton backend (ex. `https://wax-api.nc-maiz.org`)
3. Push sur `main`. Le workflow tourne et publie sur `https://<user>.github.io/<repo>/`.

Pas besoin de toucher au `.env` local — le secret est injecté pendant le build CI.

## Déploiement backend (k8s + Cloudflare Tunnel, façon kuro)

```bash
# Build + push
docker build -t registry.gitlab.com/kidnar/wax:latest .
docker push registry.gitlab.com/kidnar/wax:latest

# Déploiement
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml   # LAN seulement (Traefik)
```

Le `Deployment` utilise `strategy: Recreate` (lib JSON sur PVC RWO), `imagePullSecrets: gitlab-registry` (à créer une fois avec `kubectl create secret docker-registry gitlab-registry ...`), expose `:3000`. CORS est permissif (`Access-Control-Allow-Origin: <origin>`) donc la PWA hébergée sur n'importe quel domaine peut taper dessus.

L'accès public passe par un Cloudflare Tunnel pointant vers le `Service` ClusterIP — même pattern que [kuro](https://gitlab.com/kidnar/kuro) (cluster ne expose aucun port entrant).

### Sans cluster k8s, vite fait

Le `Dockerfile` est déployable tel quel sur :

- **Fly.io** (free tier généreux) : `flyctl launch` + `flyctl deploy`.
- **Render** (free tier, app dort après inactivité).
- **Cloudflare Tunnel quick** sur ton Mac : `cloudflared tunnel --url http://localhost:3000` te donne une URL `*.trycloudflare.com` temporaire — parfait pour tester avec un pote, sans dépendance externe.

## Variables d'environnement

| Variable | Côté | Description |
|---|---|---|
| `VITE_API_BASE_URL` | frontend | URL absolue du backend en prod (PWA + Capacitor). Vide en dev. |
| `VITE_DEV_PROXY_TARGET` | frontend, dev | Override de la cible du proxy Vite. Défaut `http://localhost:3000`. |
| `PORT` | backend | Port Express. Défaut 3000. |
| `WAX_LIBRARY_DIR` | backend | Répertoire de la bibliothèque. Défaut `./library`, l'image Docker pointe sur `/data`. |
| `WAX_YT_DLP` | backend | Override du chemin `yt-dlp`. |
| `WAX_FFMPEG` | backend | Override du chemin `ffmpeg`. |

## Architecture (résumé)

```
                 ┌──────────────────────────────────────────┐
                 │  Téléphone (PWA Safari/Chrome OU         │
                 │  app native via Capacitor)               │
                 └────────────────┬─────────────────────────┘
                                  │ HTTPS
                                  ▼
                 ┌──────────────────────────────────────────┐
                 │  Cloudflare Tunnel (TLS, edge)           │
                 │  wax-api.nc-maiz.org                     │
                 └────────────────┬─────────────────────────┘
                                  │ sortie chiffrée
                                  ▼
                 ┌──────────────────────────────────────────┐
                 │  k8s cluster                             │
                 │   ┌─────────────────────────────────┐    │
                 │   │ Deployment wax (server.cjs)     │    │
                 │   │   - Express :3000               │    │
                 │   │   - yt-dlp + ffmpeg             │    │
                 │   │   - per-user library JSON       │    │
                 │   │   - SSE pour download progress  │    │
                 │   └────────────┬────────────────────┘    │
                 │                ▼                          │
                 │   ┌─────────────────────────────────┐    │
                 │   │ PVC wax-data (10 GiB RWO)       │    │
                 │   │   /data/users/<id>/{lib,pls}.json│   │
                 │   │   /data/audio/<ytId>.mp3        │    │
                 │   │   /data/covers, /artists, etc.  │    │
                 │   └─────────────────────────────────┘    │
                 └──────────────────────────────────────────┘
```

Chaque profil a son propre `users/<id>/library.json` + `playlists.json` (multi-user clean). Les MP3 audio et les covers sont partagés (déterministes par `ytId`). Voir `CLAUDE.md` pour le détail.

## Statut

Pré-1.0, en chantier actif.

**Fait** : tab bar (Accueil / Rechercher / Bibliothèque / Réglages), Spotify-like library unifiée, profil Netflix "Qui écoute ?", player mini + plein écran avec barre de progression, mix YouTube, action sheets, theme picker 10 themes + couleur d'accent, langue (fr/en), EQ 3-bandes live, backup export/import, pull-to-refresh, haptics, safe areas iOS/Android, PWA installable, lyrics, queue sheet.

**Reste** : drag-reorder playlists, offline storage device-side via Capacitor filesystem, background audio Android via foreground service, share natif, upload d'avatar profil par caméra. Voir `CLAUDE.md` pour le détail.

## Licence

MIT — voir `LICENSE`.
