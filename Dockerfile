# sendblue-browser-use — debug browser with stealth-patched Chromium.
# Multi-stage so the final image stays slim.

FROM oven/bun:1.1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.1-slim
WORKDIR /app

# OS deps Chromium needs (headed + headless), plus curl for healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl fonts-liberation libasound2 libatk-bridge2.0-0 \
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

# Inside the container we have to bind to 0.0.0.0 for Docker port publishing
# to work; docker-compose publishes only to 127.0.0.1 on the host. If you run
# the image directly with -p, you are choosing to expose it — see README.
ENV BIND=0.0.0.0 \
    CDP_BIND=0.0.0.0 \
    PORT=8787 \
    CDP_PORT=9222 \
    DATA_DIR=/data \
    DEFAULT_HEADLESS=true

RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 8787 9222

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["bun", "src/index.ts"]
