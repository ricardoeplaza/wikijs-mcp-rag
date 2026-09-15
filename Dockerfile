# syntax=docker/dockerfile:1

# --- Build stage (TypeScript -> dist/) ---
FROM node:20-alpine AS build
WORKDIR /app
# Build toolchain in case better-sqlite3/sqlite-vec need to compile for musl.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Production stage ---
# Fallback if better-sqlite3 fails to compile on Alpine: switch both stages to
# node:20-bookworm-slim and replace the apk line with: apt-get update && apt-get install -y python3 make g++
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/entrypoint.sh /entrypoint.sh
# Pre-create the data dir owned by `node` so named volumes initialized from
# the image are writable; host bind mounts get their ownership fixed at boot
# by the entrypoint (chown when running as root).
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data \
  && chown node:node /data
USER node
EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/main.js"]
