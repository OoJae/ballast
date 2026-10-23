# Public, keyless Ballast host: the market recorder plus the read-only API serving the web app.
# It holds no keys and never signs a Strike request, so it may run in any region (CLAUDE.md
# hosting rule). Recordings live on the /data volume.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

COPY . .
RUN pnpm install --frozen-lockfile && pnpm web:build

ENV NODE_ENV=production
CMD ["bash", "deploy/railway/start.sh"]
