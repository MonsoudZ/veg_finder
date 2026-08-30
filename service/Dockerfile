FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY data/catalog.seed.json ./data/catalog.seed.json

RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VEGFINDER_DATABASE_PATH=/data/vegfinder.sqlite \
    BROWSER_EXECUTABLE=/usr/bin/chromium \
    MENU_CHECK_INTERVAL_HOURS=24

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["npm", "start"]
