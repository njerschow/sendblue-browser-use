# sendblue-browser-use

A standalone debug browser for agents. Stealth-patched Chromium behind a tiny HTTP API, with persistent named sessions, an easy purge endpoint, auto screenshots, and CDP attach so any client (Playwright, Puppeteer, undetected-chromedriver, custom scripts) can drive it.

It runs as its own process — not tied to any one Claude / Cursor / Codex session — so multiple agents can share it concurrently, debug each other's flows, and reuse a logged-in session without paying the auth tax every run.

## Why this exists

| Need | What you get |
|---|---|
| **Not coupled to a single agent** | Long-running HTTP daemon. Any tool with a bearer token can drive it. |
| **Doesn't look automated** | Chromium patched via `patchright`: `navigator.webdriver` is hidden, CDP detection vectors are patched, real Chromium binary (no Playwright fingerprints). Passes the typical Cloudflare / hCaptcha / `cmt-detect` checks. |
| **Reusable sessions** | Named persistent profiles. Log in once, every subsequent debug run reuses the cookies. |
| **One-click reset** | `POST /sessions/:name/purge` clears cookies + storage but keeps the session id, so your client code keeps working. |
| **Multi-agent friendly** | Each session is an isolated `BrowserContext` (or its own profile). Run 5+ debug sessions in parallel without state bleed. |
| **CDP attach** | `GET /sessions/:name/cdp-url` returns a wss URL that Playwright / Puppeteer / any CDP client can `connect()` to. |
| **Auto evidence** | Every navigation auto-screenshots into `~/.sendblue-browser-use/runs/<session>/`. Optional Playwright traces. |
| **HTTP-controlled** | Plain `curl` works. No SDK required. |
| **Self-contained deploy** | One `docker compose up` on any Mac mini / EC2 / Codespace. No host Chromium needed. |

## Quick start (local)

```sh
git clone https://github.com/njerschow/sendblue-browser-use.git
cd sendblue-browser-use
bun install
bun x patchright install chromium

cp .env.example .env
# generate a token
echo "BROWSER_USE_API_KEY=$(openssl rand -hex 32)" > .env

bun run dev
```

Then in another terminal:

```sh
source .env
TOKEN="Authorization: Bearer $BROWSER_USE_API_KEY"

# 1. create a persistent session (log in here once, reuse it forever)
curl -s -X POST http://127.0.0.1:8787/sessions \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"qa","persistent":true}'

# 2. navigate
curl -s -X POST http://127.0.0.1:8787/sessions/qa/navigate \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://trybloom.so/"}'

# 3. screenshot
curl -s http://127.0.0.1:8787/sessions/qa/screenshot?fullPage=true \
  -H "$TOKEN" -o /tmp/qa.png

# 4. wipe state without losing the session
curl -s -X POST http://127.0.0.1:8787/sessions/qa/purge -H "$TOKEN"
```

## Quick start (Docker)

```sh
echo "BROWSER_USE_API_KEY=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Same API, exposed on `127.0.0.1:8787`. CDP is on `127.0.0.1:9222`. Data persists in `./data/`.

## API

All routes require `Authorization: Bearer $BROWSER_USE_API_KEY` except `/health`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ ok, sessions, cdpUrl }` |
| `GET` | `/sessions` | — | `{ sessions: [...] }` |
| `POST` | `/sessions` | `{ name, persistent?, headless?, viewport?, userAgent?, locale?, timezone?, traces?, proxy? }` | `{ session }` |
| `GET` | `/sessions/:name` | — | session info + current page url/title |
| `POST` | `/sessions/:name/purge` | — | clear cookies + storage, keep session id |
| `DELETE` | `/sessions/:name` | — | close context, remove profile |
| `POST` | `/sessions/:name/navigate` | `{ url, waitUntil? }` | `{ url, title, status }` |
| `GET` | `/sessions/:name/screenshot` | `?fullPage=true&selector=...` | `image/png` |
| `POST` | `/sessions/:name/script` | `{ code }` | `{ result }` — code runs in page context |
| `GET` | `/sessions/:name/cookies` | `?url=...` | `{ cookies }` |
| `POST` | `/sessions/:name/cookies` | `{ cookies: [...] }` | `{ ok }` |
| `GET` | `/sessions/:name/console` | `?limit=100` | `{ messages: [...] }` (ring buffer) |
| `GET` | `/sessions/:name/cdp-url` | — | `{ cdpUrl }` — for non-persistent sessions only |

### Session options

```ts
{
  name: string;            // required, [a-z0-9_-]
  persistent?: boolean;    // default true — survives restarts via on-disk profile
  headless?: boolean | "new"; // default false (env DEFAULT_HEADLESS)
  viewport?: { width, height };
  userAgent?: string;
  locale?: string;         // default "en-US"
  timezone?: string;
  traces?: boolean;        // capture a Playwright trace.zip on session close
  proxy?: { server, username?, password?, bypass? };
}
```

### Persistent vs non-persistent

- **`persistent: true` (default)** — cookies, localStorage, IndexedDB persist under `~/.sendblue-browser-use/profiles/<name>/`. Survives server restart. **CDP attach is not available** for these sessions because each gets its own private browser instance.
- **`persistent: false`** — shares the central Chromium process via a fresh `BrowserContext`. State is in-memory only. **CDP attach IS available** via `/sessions/:name/cdp-url`.

Pick persistent for "log in once, debug for a week" workflows. Pick non-persistent when you need to attach Playwright / Puppeteer directly.

## Examples

- [`examples/attach-from-playwright.ts`](examples/attach-from-playwright.ts) — connect Playwright over CDP and drive a page
- [`examples/attach-from-puppeteer.ts`](examples/attach-from-puppeteer.ts) — same with Puppeteer
- [`examples/multi-agent-debug.ts`](examples/multi-agent-debug.ts) — two agents driving two surfaces in parallel
- [`examples/run-script.sh`](examples/run-script.sh) — curl-only walkthrough

## Stealth notes

This is built on [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a maintained fork of Playwright that:

- Hides `navigator.webdriver`
- Removes CDP runtime markers
- Drops Playwright-specific extensions and command flags
- Uses real Chromium so most fingerprint surfaces match a normal user

Sufficient for QAing your own sites against real auth providers (Clerk, Stripe, Google OAuth, Cloudflare). It is **not** a tool for hostile scraping at scale — for that use [Camoufox](https://github.com/daijro/camoufox).

## Storage

```
~/.sendblue-browser-use/
├── profiles/
│   └── <session>/          # persistent profile dir
└── runs/
    └── <session>/
        ├── 2026-05-25T...-nav.png   # auto-screenshot per nav
        └── 2026-05-25T...-trace.zip # if traces:true at create
```

`POST /sessions/:name/purge` clears cookies + storage + console buffer. It does **not** delete the on-disk profile (so the session id stays valid). To wipe the profile too, `DELETE /sessions/:name` and recreate.

## Security

- Bind to `127.0.0.1` by default. Setting `BIND=0.0.0.0` exposes you to your LAN — put a reverse proxy with auth in front before doing this.
- `POST /sessions/:name/script` runs arbitrary JS in the page context. The bearer token is the only gate. Don't share the token.
- CDP port is bound to `127.0.0.1` always.

## Architecture

```
HTTP :8787  ──►  Hono router  ──►  session manager  ──►  patchright Chromium
                                    │                    └─►  CDP :9222 (localhost)
                                    └─►  on-disk profiles + runs
```

Inspired by the [Sendblue channel-server](https://github.com/sendblue-api/) pattern (Bun + Hono + bearer auth + simple HTTP surface).

## License

MIT. See [LICENSE](LICENSE).
