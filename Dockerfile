# Multi-stage build. Base images below have official arm64/v8 variants
# (Raspberry Pi 5 is aarch64), so this builds natively on-device or via
# `docker buildx build --platform linux/arm64` from another machine.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS run
WORKDIR /app
# Fixed container-internal port/host — not meant to be overridden by the
# app-level .env file. docker-compose.yml maps a configurable host port
# (HOST_PORT) onto this fixed internal one.
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=build /app/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
