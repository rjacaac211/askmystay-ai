# ---- build stage ----------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Install with dev dependencies — vite, svelte and the adapter are needed to build.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# No OPENAI_API_KEY or DATABASE_URL is available here, and none is needed:
# every client is constructed lazily at runtime and secrets are read through
# $env/dynamic/private, so route analysis does not touch them.
RUN npm run build


# ---- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only; adapter-node bundles the rest into build/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

# Deliberately no seed script here: seeding needs tsx (a dev dependency) and its
# toolchain, which would undo the slim runtime. Postgres publishes 5432, so run
# `npm run seed` from the host instead — see the README.

USER node
EXPOSE 3000

CMD ["node", "build"]
