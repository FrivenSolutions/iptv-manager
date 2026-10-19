# Stage 1: note which commit is being built, so the app can tell whether it is up to date.
# The final image gets only version.json, never the .git history.
FROM node:24-alpine AS version
WORKDIR /src
COPY . .
RUN node src/version.js --write /version.json

FROM node:24-alpine

LABEL org.opencontainers.image.title="Simple IPTV Manager" \
      org.opencontainers.image.description="Self-hosted IPTV playlist manager: trimmed M3U, XMLTV and Xtream Codes outputs" \
      org.opencontainers.image.source="https://github.com/FrivenSolutions/simple-iptv-manager" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# ffmpeg for light streams (only runs while someone watches one), with Intel's VAAPI drivers
# for Quick Sync on x86_64 (iHD for 2015+ CPUs such as the N100, i965 for older ones).
RUN apk add --no-cache ffmpeg \
 && if [ "$(apk --print-arch)" = x86_64 ]; then apk add --no-cache intel-media-driver libva-intel-driver; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY --from=version /version.json ./version.json

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
