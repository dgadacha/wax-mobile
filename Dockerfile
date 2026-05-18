# syntax=docker/dockerfile:1.7
#
# Wax backend image. Only ships server.cjs + its Express deps + yt-dlp +
# ffmpeg. The Vue/Vant frontend lives inside the Capacitor app — it is NOT
# served by this container. The backend speaks HTTP to whichever client
# (mobile, dev browser) points at it.

############################
# 1) Install backend deps in a clean layer
############################
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Frontend toolchain (vite, vant, capacitor) is dev-only and irrelevant to
# the server runtime. We still need express + a few small server-side libs
# pulled in via package.json `dependencies`, so use `npm ci --omit=dev`.
RUN npm ci --omit=dev --no-audit --no-fund

############################
# 2) Runtime image
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
COPY server.cjs ./
COPY package.json ./

# Library dir defaults to /data (mounted PVC in k8s).
RUN mkdir -p /data \
 && chown -R wax:wax /app /data

ENV PORT=3000 \
    WAX_LIBRARY_DIR=/data \
    WAX_YT_DLP=/usr/local/bin/yt-dlp \
    WAX_FFMPEG=/usr/bin/ffmpeg

USER wax
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.cjs"]
