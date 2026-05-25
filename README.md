# sendblue-browser-use

A standalone debug browser for agents. Stealth-patched Chromium behind a tiny HTTP API, with persistent named sessions, an easy purge endpoint, auto screenshots, and CDP attach so any client (Playwright, Puppeteer, undetected-chromedriver, custom scripts) can drive it.

It runs as its own process — not tied to any one Claude / Cursor / Codex session — so multiple agents can share it concurrently, debug each other's flows, and reuse a logged-in session without paying the auth tax every run.

## Why this exists

| Need | What you get |
|---|---|
| **Not coupled to a single agent** | Long-running HTTP daemon. Any tool with a bearer token can drive it. |
| **Doesn't look automated** | Chromium patched via `patchright`: `navigator.webdriver` is hidden, CDP detection vectors are patched, real Chromium binary (no Playwright fingerprints). Passes typical Cloudflare Turnstile and similar low-friction checks; not for hostile scraping at scale. |
| **Reusable sessions** | Named persistent profiles. Log in once, every subsequent debug run reuses the cookies. |
| **One-click reset** | `POST /sessions/:name/purge` clears cookies + storage but keeps the session id, so your client code keeps working. |
| **Multi-agent friendly** | Each session is an isolated `BrowserContext` (or its own profile). Run 5+ debug sessions in parallel without state bleed. |
| **CDP attach** | `GET /sessions/:name/cdp-url` returns the shared browser CDP URL for non-persistent sessions, so Playwright / Puppeteer / any CDP client can `connect()` to the debug browser. |
| **Auto evidence** | Every navigation auto-screenshots into `~/.sendblue-browser-use/runs/<session>/`. Optional Playwright traces. |
| **HTTP-controlled** | Plain `curl` works. No SDK required. |
| **Self-contained deploy** | One `docker compose up` on any Mac mini / EC2 / Codespace. No host Chromium needed. |

## Quick start (local)

Prereqs: Bun `>=1.3` and Node.js `>=20` on your `PATH`.

```sh
git clone https://github.com/njerschow/sendblue-browser-use.git
cd sendblue-browser-use
bun install
bun --bun x patchright install chromium

cp .env.example .env
# generate and set the required token
TOKEN="$(openssl rand -hex 32)"
sed -i.bak "s/^BROWSER_USE_API_KEY=.*/BROWSER_USE_API_KEY=$TOKEN/" .env
rm .env.bak

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
| `GET` | `/health` | — | `{ ok, service, version, sessions }` |
| `GET` | `/sessions` | — | `{ sessions: [...] }` |
| `POST` | `/sessions` | `{ name, persistent?, headless?, viewport?, userAgent?, locale?, timezone?, traces?, proxy? }` | `{ session }` |
| `GET` | `/sessions/:name` | — | session info + current page url/title |
| `POST` | `/sessions/:name/purge` | — | `{ session }` — clear cookies + active-origin storage, keep session id |
| `DELETE` | `/sessions/:name` | — | `{ ok }` — close context, remove profile |
| `POST` | `/sessions/:name/navigate` | `{ url, waitUntil?, timeoutMs? }` | `{ url, title, status }` |
| `GET` | `/sessions/:name/screenshot` | `?fullPage=true&selector=...` | `image/png` |
| `POST` | `/sessions/:name/script` | `{ code, timeoutMs? }` (≤200kB) | `{ result }` — code runs in page context |
| `GET` | `/sessions/:name/cookies` | `?url=...` | `{ cookies }` |
| `POST` | `/sessions/:name/cookies` | `{ cookies: [...] }` | `{ ok }` |
| `GET` | `/sessions/:name/console` | `?limit=100` | `{ messages: [...] }` (ring buffer) |
| `GET` | `/sessions/:name/cdp-url` | — | `{ cdpUrl }` — for non-persistent sessions only |

`POST /sessions/:name/script` passes `code` directly to Playwright's `page.evaluate`. Send a JavaScript expression, or wrap statements in an IIFE. Scripts time out after 30s by default; pass `timeoutMs` up to `120000`, or `0` to disable the request timeout.

```json
{ "code": "(() => { const x = 1; return x; })()" }
```

### Errors

All non-2xx responses share the same envelope. Failures from Playwright are
truncated to one line before being returned; the full message is logged
server-side with proxy credentials redacted.

```json
{ "error": { "code": "navigate_failed", "message": "net::ERR_NAME_NOT_RESOLVED" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `empty_body` | request body is required but was missing |
| 400 | `malformed_json` | body was not valid JSON |
| 400 | `invalid_body` | body failed Zod validation (see `error.details`) |
| 401 | `unauthorized` | missing or wrong bearer token |
| 404 | `not_found` | session does not exist |
| 409 | `already_exists` | a session with that name is already running |
| 409 | `cdp_unavailable_for_persistent_session` | persistent sessions don't expose the shared CDP url |
| 422 | `script_failed` | `/script` request was valid but the in-page eval threw |
| 500 | `internal_error` | unexpected — check server logs |
| 502 | `navigate_failed` `screenshot_failed` `cookie_read_failed` `cookie_write_failed` `session_unreachable` | Chromium-side failure |

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

### Cookie shape

`POST /sessions/:name/cookies` accepts up to 500 Playwright-style cookies:

```ts
{
  cookies: Array<{
    name: string;
    value: string;
    url?: string;       // or domain + path
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
}
```

Each cookie must include either `url` or both `domain` and `path`.

### Persistent vs non-persistent

- **`persistent: true` (default)** — cookies, localStorage, IndexedDB persist under `~/.sendblue-browser-use/profiles/<name>/`. Survives server restart. **CDP attach is not available** for these sessions because each gets its own private browser instance.
- **`persistent: false`** — shares the central Chromium process via a fresh `BrowserContext`. State is in-memory only. **CDP attach IS available** via `/sessions/:name/cdp-url`, which returns the shared browser-level CDP endpoint. CDP clients can see the shared debug browser, so keep the CDP port local and trusted.

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

We deliberately do **not** pass `--disable-blink-features=AutomationControlled` or override `userAgent`/`viewport` by default — patchright handles those internally and our overrides would defeat its rebrowser patches. Pass an explicit `userAgent` per session only if you have a reason.

Why patchright over alternatives:

- **vs `nodriver` / `undetected-playwright`** — patchright is actively maintained, matches Playwright's API surface, and integrates cleanly with the existing TypeScript ecosystem.
- **vs [Camoufox](https://github.com/daijro/camoufox)** — Camoufox uses Firefox with deeper fingerprint randomization, better for hostile scraping at scale. patchright is the right pick for QAing your own auth flows (Clerk, Stripe, Google OAuth, Cloudflare Turnstile) without the maintenance burden.

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

`POST /sessions/:name/purge` clears cookies and permissions context-wide, then clears `localStorage`, `sessionStorage`, `IndexedDB`, ServiceWorker registrations, CacheStorage, and the console buffer for currently open pages/origins. It does **not** enumerate every historical origin in a persistent profile, does not delete the on-disk profile (so the session id stays valid), and does not clear browser-level HTTP cache or HSTS state. To wipe the profile too, `DELETE /sessions/:name` and recreate.

Auto-screenshots are capped at `MAX_NAV_SCREENSHOTS` per session (default 200, oldest deleted first). Set to `0` to disable.

## Security

- The HTTP API binds to `127.0.0.1` by default. Setting `BIND=0.0.0.0` exposes you to your LAN — put a reverse proxy with auth in front before doing this. The Docker image sets `BIND=0.0.0.0` so host port-publishing works, but `docker-compose.yml` publishes only to `127.0.0.1`. If you `docker run -p 8787:8787` directly, you are choosing to expose the HTTP API.
- CDP is bound to `CDP_BIND` (default `127.0.0.1`; the Docker image default is also loopback-only). `docker-compose.yml` opts into `CDP_BIND=0.0.0.0` inside the container but publishes only to `127.0.0.1` on the host. Anyone who can reach this port gets full in-browser RCE — keep it on loopback.
- `POST /sessions/:name/script` runs arbitrary JS in the page context. The bearer token is the only gate. Don't share the token.
- `POST /sessions/:name/navigate` only accepts `http(s)` URLs — `file://`, `chrome://`, etc. are rejected.
- Healthcheck (`GET /health`) is public so Docker/k8s probes work without a token; it returns service metadata only.

## Architecture

```
HTTP :8787  ──►  Hono router  ──►  session manager  ──►  patchright Chromium
                                    │                    └─►  CDP :9222 (localhost)
                                    └─►  on-disk profiles + runs
```

Inspired by the [Sendblue channel-server](https://github.com/sendblue-api/) pattern (Bun + Hono + bearer auth + simple HTTP surface).

## License

MIT. See [LICENSE](LICENSE).
