# syntax=docker/dockerfile:1

# --- Stage 1: build (TypeScript -> dist/) ---
FROM node:20-alpine AS build
WORKDIR /app
# Build toolchain in case better-sqlite3/sqlite-vec need to compile for musl.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Stage 2: production ---
# Fallback if better-sqlite3 fails to compile on Alpine: switch both stages to
# node:20-bookworm-slim and replace the apk line with: apt-get update && apt-get install -y python3 make g++
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8000
CMD ["node", "dist/main.js"]
