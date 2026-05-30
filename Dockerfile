# CCE data delivery validator — app image.
# Multi-stage: build with dev deps (tsc), then a slim runtime with prod deps only.

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# Dependency layer first for cache reuse.
COPY package.json package-lock.json ./
RUN npm ci

# Sources + build assets, then compile (tsc) and copy vendored schemas.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled output (includes copied schemas under dist/schemas).
COPY --from=build /app/dist ./dist

EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
