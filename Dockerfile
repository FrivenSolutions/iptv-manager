FROM node:24-alpine

LABEL org.opencontainers.image.title="IPTV Manager" \
      org.opencontainers.image.description="Self-hosted IPTV playlist manager: trimmed M3U, XMLTV and Xtream Codes outputs" \
      org.opencontainers.image.source="https://github.com/frittsasaurus/iptv-manager" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/server.js"]
