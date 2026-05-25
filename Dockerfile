# sendblue-browser-use — debug browser with stealth-patched Chromium.
# Multi-stage so the final image stays slim.

FROM oven/bun:1.1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.1
WORKDIR /app

# Install OS deps Chromium needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
      libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 wget xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Pre-install the patched Chromium binary.
RUN bun x patchright install chromium

ENV BIND=0.0.0.0 \
    PORT=8787 \
    CDP_PORT=9222 \
    DATA_DIR=/data \
    DEFAULT_HEADLESS=true

VOLUME ["/data"]
EXPOSE 8787 9222

CMD ["bun", "src/index.ts"]
