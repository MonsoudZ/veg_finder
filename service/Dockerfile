FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
COPY src ./src
COPY migrations ./migrations
COPY data/catalog.seed.json ./data/catalog.seed.json

RUN npm ci --omit=dev

RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BROWSER_EXECUTABLE=/usr/bin/chromium \
    MENU_CHECK_INTERVAL_HOURS=24

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "start"]
