# sendblue-browser-use — debug browser with stealth-patched Chromium.
# Multi-stage so the final image stays slim.

FROM oven/bun:1.3.5 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.5-slim
WORKDIR /app

# OS deps Chromium needs (headed + headless), plus curl for healthcheck
# and gosu so the entrypoint can fix bind-mounted /data ownership before
# dropping privileges.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gosu fonts-liberation libasound2 libatk-bridge2.0-0 \
      libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 wget xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Pre-install the patched Chromium binary into a path the runtime user can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright && bun x patchright install chromium \
    && chown -R bun:bun /ms-playwright /app

# The HTTP API binds to all container interfaces so Docker port publishing works.
# CDP stays loopback-only unless docker-compose or the operator explicitly opts in.
ENV BIND=0.0.0.0 \
    CDP_BIND=127.0.0.1 \
    PORT=8787 \
    CDP_PORT=9222 \
    DATA_DIR=/data \
    DEFAULT_HEADLESS=true

RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 8787 9222

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["bun", "src/index.ts"]
