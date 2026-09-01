# syntax=docker/dockerfile:1.7
ARG BUN_IMAGE=oven/bun:1-alpine
FROM ${BUN_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

# Use bun for install/build (falls back to sql.js if better-sqlite3 fails, same as npm)
COPY package.json ./
RUN --mount=type=cache,target=/root/.bun \
  bun install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build:bun

FROM ${BUN_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
# Render injects PORT=10000 at runtime — it overrides this default via env var.
# Keep 20128 as local default for `docker run` without -e PORT.
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js

RUN mkdir -p /app/data && chown -R 1000:1000 /app 2>/dev/null || chown -R bun:bun /app 2>/dev/null || chown -R node:node /app 2>/dev/null || true && \
  mkdir -p /app/data-home && chown 1000:1000 /app/data-home 2>/dev/null || chown bun:bun /app/data-home 2>/dev/null || chown node:node /app/data-home 2>/dev/null || true && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes) — try bun user, then node, then run as-is
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R 1000:1000 /app/data /app/data-home 2>/dev/null || true\nchown -R bun:bun /app/data /app/data-home 2>/dev/null || true\nchown -R node:node /app/data /app/data-home 2>/dev/null || true\nexec su-exec bun "$@" 2>/dev/null || exec su-exec node "$@" 2>/dev/null || exec "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128 10000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "custom-server.js"]
