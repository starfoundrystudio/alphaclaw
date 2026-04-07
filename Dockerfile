FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    curl \
    git \
    procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json .npmrc tailwind.config.cjs ./
COPY scripts ./scripts
COPY patches ./patches

RUN npm ci

COPY bin ./bin
COPY lib ./lib

RUN npm run build:ui \
  && npm prune --omit=dev \
  && node ./scripts/restore-openclaw-bundled-plugin-deps.js

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    curl \
    git \
    procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app /app

ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV ALPHACLAW_ROOT_DIR=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "bin/alphaclaw.js", "start"]
