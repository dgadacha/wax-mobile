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
  <a href="https://wax.nc-maiz.org"><img alt="Démo" src="https://img.shields.io/badge/d%C3%A9mo-wax.nc--maiz.org-7c5cff"/></a>
</p>

---

## Pour les utilisateurs

### Sur iPhone (Safari)

1. Ouvre <https://wax.nc-maiz.org> dans **Safari** (Chrome marche pas pour l'install — c'est Apple qui bloque).
2. Bouton **Partager** (le carré avec la flèche vers le haut).
3. Fais défiler et tape **Sur l'écran d'accueil**.
4. Confirme. L'icône Wax apparaît, l'app s'ouvre en plein écran sans la barre Safari.

> Astuce : à la première ouverture, choisis ton profil ou crée-en un. Si t'es le seul à utiliser ton iPhone, tape sur "Moi" — tu peux le renommer plus tard depuis Réglages.

### Sur Android (Chrome)

1. Ouvre <https://wax.nc-maiz.org> dans **Chrome**.
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

## Auto-hébergement (self-host)

Une seule image Docker contient le frontend (build Vite baked-in via le stage `web-builder`) et le backend (`server.cjs` + `yt-dlp` + `ffmpeg`). Un conteneur, un URL public, pas de CORS, pas de host statique séparé. Exactement le pattern [kuro](https://gitlab.com/kidnar/kuro).

### Prérequis

- Docker + accès à un registry (GitLab / GitHub Container Registry / Docker Hub — au choix)
- Un cluster Kubernetes (k3s, k8s, …) avec `kubectl` configuré
- Un moyen d'exposer publiquement : **Cloudflare Tunnel** (recommandé, gratuit) ou un Ingress avec cert-manager

### 1. Build + push l'image

Clone le repo et build pour ton propre registry. Remplace `<ton-registry>/<ton-namespace>` par le tien (ex. `registry.gitlab.com/<ton-user>` ou `ghcr.io/<ton-user>`).

```bash
git clone https://github.com/dgadacha/wax-mobile.git
cd wax-mobile

# Login au registry (une fois)
docker login <ton-registry>

# Build (frontend + backend dans la même image, ~5 min sur cache vide)
docker build -t <ton-registry>/<ton-namespace>/wax:latest .
docker push <ton-registry>/<ton-namespace>/wax:latest
```

### 2. Ajuste les manifests k8s

Édite [`k8s/deployment.yaml`](k8s/deployment.yaml) :

- Ligne `image:` → remplace `registry.gitlab.com/kidnar/wax:latest` par ton image.
- Ligne `imagePullSecrets: - name: gitlab-registry` → soit garde le nom, soit renomme. C'est juste un nom de secret k8s.

Si ton image est sur GitHub Container Registry (ghcr.io), tu peux la rendre publique → pas besoin de pull secret du tout, supprime le bloc `imagePullSecrets`.

### 3. Crée le pull secret (si registry privé)

```bash
kubectl create namespace wax

# GitLab registry
kubectl -n wax create secret docker-registry gitlab-registry \
  --docker-server=registry.gitlab.com \
  --docker-username=<ton-user-gitlab> \
  --docker-password=<un-personal-access-token-avec-read_registry>

# Ou GitHub Container Registry
kubectl -n wax create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<ton-user-github> \
  --docker-password=<ghp_xxx_avec-read-packages>
```

### 4. Apply les manifests

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml   # ingress Traefik LAN, optionnel

# Vérifie
kubectl -n wax get pods -w   # attend que le pod soit Running
kubectl -n wax logs deploy/wax | head -20
# Tu dois voir "[frontend] serving /app/dist at /" puis "Serveur lancé sur http://localhost:3000"
```

Le `Deployment` utilise `strategy: Recreate` (la lib JSON vit sur un PVC RWO de 10 GiB), expose `:3000`, et démarre comme user non-root `wax` (uid 999).

### 5. Expose publiquement

#### Option A — Cloudflare Tunnel (recommandé)

Dans ton dashboard Cloudflare Zero Trust :

1. **Networks → Tunnels → ton tunnel existant** (ou nouveau si tu n'en as pas)
2. **Public Hostnames → Add public hostname** :
   - Subdomain : `wax`
   - Domain : ton domaine (ex. `nc-maiz.org`)
   - Service type : `HTTP`
   - URL : `wax.wax.svc.cluster.local:80` (nom DNS interne k8s : `<service>.<namespace>.svc.cluster.local`)
3. Save. Cloudflare gère le TLS et le tunnel sortant — aucun port à exposer côté cluster.

Pas de port entrant ouvert sur ton cluster. Le tunnel sort vers Cloudflare edge.

#### Option B — Ingress public

Si tu préfères un ingress classique (cert-manager + Let's Encrypt), édite [`k8s/ingress.yaml`](k8s/ingress.yaml), mets ton domaine + une annotation `cert-manager.io/cluster-issuer: letsencrypt-prod`. Mais le tunnel Cloudflare est plus simple et plus safe.

### 6. C'est tout

L'URL publique répond → tes amis l'ouvrent dans Safari iPhone / Chrome Android → "Sur l'écran d'accueil" / "Installer l'application". Ils n'ont rien à installer chez eux.

### Tester avant de déployer

```bash
# Run le conteneur localement, avec un volume monté pour la persistance
docker run --rm -p 3000:3000 \
  -v $(pwd)/library:/data \
  <ton-registry>/<ton-namespace>/wax:latest

# Ouvre http://localhost:3000 — l'app doit charger
```

### Sans cluster k8s, vite fait

Si tu veux juste un déploiement express sans monter un cluster :

- **Fly.io** (free tier généreux) : `flyctl launch` (détecte le Dockerfile) + `flyctl deploy`. Volume persistent à mounter sur `/data`.
- **Render** : connecte le repo, choisit "Docker", set la persistent disk sur `/data`. Free tier mais l'app dort après inactivité.
- **Cloudflare Tunnel quick** sur ton Mac/serveur perso : `node server.cjs &` + `cloudflared tunnel --url http://localhost:3000` → URL `*.trycloudflare.com` temporaire, parfait pour tester sans cluster.

### Frontend hébergé séparément (optionnel)

Le workflow `.github/workflows/deploy-pages.yml` peut publier `dist/` sur GitHub Pages à chaque push `main`. Utile comme **miroir static** si ton backend tombe — le shell PWA se charge quand même, juste sans données. Setup :

1. **Settings → Pages → Source** = "GitHub Actions".
2. **Settings → Secrets and variables → Actions → New repository secret** : `VITE_API_BASE_URL` = l'URL de ton backend (`https://wax.nc-maiz.org`).
3. Push sur `main`. CORS est permissif côté backend donc ça marche cross-origin.

## Variables d'environnement

| Variable | Côté | Description |
|---|---|---|
| `VITE_API_BASE_URL` | frontend | URL absolue du backend en prod (PWA + Capacitor). Vide en dev. |
| `VITE_DEV_PROXY_TARGET` | frontend, dev | Override de la cible du proxy Vite. Défaut `http://localhost:3000`. |
| `PORT` | backend | Port Express. Défaut 3000. |
| `WAX_LIBRARY_DIR` | backend | Répertoire de la bibliothèque. Défaut `./library`, l'image Docker pointe sur `/data`. |
| `WAX_FRONTEND_DIR` | backend | Répertoire du frontend buildé (sert au root + SPA fallback). Défaut `./dist`, image Docker `/app/dist`. Si absent, le serving frontend est désactivé (utile en dev quand Vite tourne sur :5173). |
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
                 │   │   - /app/dist served at /       │    │
                 │   │     + SPA fallback              │    │
                 │   │   - /api/* yt-dlp + ffmpeg      │    │
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

Un seul conteneur sert le frontend (build Vite baked-in via le `web-builder` stage du Dockerfile) ET l'API. Pas de CORS, pas de host statique séparé. Chaque profil a son propre `users/<id>/library.json` + `playlists.json` (multi-user clean). Les MP3 audio et les covers sont partagés (déterministes par `ytId`). Voir `CLAUDE.md` pour le détail.

## Statut

Pré-1.0, en chantier actif.

**Fait** : tab bar (Accueil / Rechercher / Bibliothèque / Réglages), Spotify-like library unifiée, profil Netflix "Qui écoute ?", player mini + plein écran avec barre de progression, mix YouTube, action sheets, theme picker 10 themes + couleur d'accent, langue (fr/en), EQ 3-bandes live, backup export/import, pull-to-refresh, haptics, safe areas iOS/Android, PWA installable, lyrics, queue sheet.

**Reste** : drag-reorder playlists, offline storage device-side via Capacitor filesystem, background audio Android via foreground service, share natif, upload d'avatar profil par caméra. Voir `CLAUDE.md` pour le détail.

## Licence

MIT — voir `LICENSE`.
