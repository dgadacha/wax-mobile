# syntax=docker/dockerfile:1.7
#
# Wax all-in-one image: backend (server.cjs) + frontend (built Vite app).
# Same pattern as kuro — one image, one URL, no separate static host. The
# backend serves dist/ at the root and falls back to index.html for SPA
# routes; API endpoints take precedence via path-prefix matching.

############################
# 1) Build the Vite frontend (Vue + Vant + PWA)
############################
FROM node:20-bookworm-slim AS web-builder
WORKDIR /web

# Install dev deps so Vite + plugins are available.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy only the bits Vite needs (source + config + assets) — avoids
# busting the npm cache layer when server.cjs / k8s / Docker stuff
# changes.
COPY index.html vite.config.js capacitor.config.json ./
COPY src ./src
COPY public ./public

# Build args let the CI pass VITE_API_BASE_URL at build time. Empty by
# default → relative API URLs → same-origin requests (perfect when the
# backend itself serves the bundle). Override only when hosting the
# frontend on a different domain than the backend (e.g. GitHub Pages
# pointing at an external API).
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN npm run build
# Result: /web/dist with index.html, /assets/*, manifest.webmanifest, sw.js, …

############################
# 2) Install backend deps in a clean layer (no devDeps in the image)
############################
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

############################
# 3) Runtime image
############################
FROM node:20-bookworm-slim AS runtime

# yt-dlp needs python3 + a recent yt-dlp binary; ffmpeg muxes the m4a stream
# into mp3. ca-certificates so yt-dlp can hit YouTube over TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      ffmpeg \
      curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -m -d /home/wax -s /sbin/nologin wax

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=web-builder /web/dist ./dist
COPY server.cjs ./
COPY package.json ./

# Library dir defaults to /data (mounted PVC in k8s). Frontend dir
# defaults to /app/dist where the web-builder put it.
RUN mkdir -p /data \
 && chown -R wax:wax /app /data

ENV PORT=3000 \
    WAX_LIBRARY_DIR=/data \
    WAX_FRONTEND_DIR=/app/dist \
    WAX_YT_DLP=/usr/local/bin/yt-dlp \
    WAX_FFMPEG=/usr/bin/ffmpeg

USER wax
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.cjs"]
