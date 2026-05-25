---
name: sendblue-browser
description: Drive a long-running stealth-patched Chromium daemon over a tiny REST API to navigate pages, take screenshots, evaluate JavaScript, manage sessions, and attach Playwright/Puppeteer over CDP. Use whenever the user needs browser automation, signup QA, headed-browser scraping, or bypass of low-friction bot checks (Cloudflare Turnstile, etc.).
metadata:
  short-description: Stealth Chromium daemon (sendblue-browser-use) — REST API + CDP attach.
---

# sendblue-browser

Long-running stealth Chromium (`patchright`) exposed via a tiny REST API. One process, many named sessions, durable cookies, one-click purge, and a CDP url for Playwright/Puppeteer to attach. Defeats Cloudflare Turnstile and similar low-friction bot checks; not for hostile scraping at scale.

Repo: https://github.com/SendblueBase/sendblue-browser-use

## Is the daemon running?

```bash
curl -s http://127.0.0.1:8787/health
```

If you get a JSON `{ ok: true, ... }` response, skip to "Drive a session". Otherwise:

```bash
# Local dev (Bun)
cd <path-to-sendblue-browser-use>
BROWSER_USE_API_KEY=$(openssl rand -hex 32) bun src/index.ts &

# Docker
docker compose up -d
```

Wait ~3s, then re-check `/health`.

## Auth

Every endpoint except `/health` requires a bearer token (`BROWSER_USE_API_KEY` env var):

```
Authorization: Bearer $BROWSER_USE_API_KEY
```

## Drive a session

```bash
TOKEN="Authorization: Bearer $BROWSER_USE_API_KEY"

# 1. Create a session. persistent=false exposes a CDP url; persistent=true backs to an on-disk profile.
curl -s -X POST http://127.0.0.1:8787/sessions \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"qa","persistent":false,"viewport":{"width":1440,"height":900}}'

# 2. Navigate. http/https only; file:// and chrome:// are rejected. timeoutMs default 30s.
curl -s -X POST http://127.0.0.1:8787/sessions/qa/navigate \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","waitUntil":"networkidle","timeoutMs":15000}'

# 3. Screenshot. ?fullPage=true and ?selector=CSS supported. Returns image/png.
curl -s "http://127.0.0.1:8787/sessions/qa/screenshot?fullPage=true" \
  -H "$TOKEN" -o /tmp/shot.png

# 4. Eval JS in page. EXPRESSION FORM ONLY — wrap statements in an IIFE.
#    Body cap 200 kB. 422 if the eval throws inside the page.
curl -s -X POST http://127.0.0.1:8787/sessions/qa/script \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"(() => ({ title: document.title, h1: document.querySelector(\"h1\")?.innerText }))()"}'

# 5. Cookies (Playwright shape: name+value + url OR domain+path)
curl -s -X POST http://127.0.0.1:8787/sessions/qa/cookies \
  -H "$TOKEN" -H "Content-Type: application/json" \
  -d '{"cookies":[{"name":"session","value":"abc","url":"https://example.com"}]}'
curl -s "http://127.0.0.1:8787/sessions/qa/cookies?url=https://example.com" -H "$TOKEN"

# 6. Console ring buffer (last N messages from page)
curl -s "http://127.0.0.1:8787/sessions/qa/console?limit=50" -H "$TOKEN"

# 7. Clear cookies + storage but keep the session id
curl -s -X POST http://127.0.0.1:8787/sessions/qa/purge -H "$TOKEN"

# 8. Close + delete profile
curl -s -X DELETE http://127.0.0.1:8787/sessions/qa -H "$TOKEN"
```

## Attach Playwright/Puppeteer over CDP (complex flows)

For multi-step interactions (forms, OTP, file upload, real mouse), drive via Playwright. Non-persistent sessions expose a CDP websocket URL; persistent ones do not (they have their own private browser instance).

```js
const { cdpUrl } = await fetch("http://127.0.0.1:8787/sessions/qa/cdp-url", {
  headers: { Authorization: `Bearer ${process.env.BROWSER_USE_API_KEY}` }
}).then(r => r.json());

const { chromium } = require("playwright");
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages()[0];

await page.locator("input[name=emailAddress]").pressSequentially("user@example.com", { delay: 50 });
await page.locator("input[name=password]").pressSequentially("hunter2!", { delay: 50 });
await page.locator("button[data-localization-key='formButtonPrimary']").first().click({ delay: 90 });
```

Puppeteer works identically with `puppeteer.connect({ browserWSEndpoint: cdpUrl })`.

## Persistent vs non-persistent sessions

| Pick | When |
|---|---|
| `persistent: true` (default) | Log in once, debug for a week. Cookies + localStorage + IndexedDB persist under `~/.sendblue-browser-use/profiles/<name>/`. No CDP attach. |
| `persistent: false` | Need Playwright/Puppeteer over CDP. State is in-memory only. Each session is a fresh `BrowserContext` on a shared Chromium process. |

## Error envelope

Every non-2xx response: `{ "error": { "code": "...", "message": "..." } }`. Common codes:

| Status | Code | Meaning |
|---|---|---|
| 400 | `empty_body` | request body required |
| 400 | `malformed_json` | body not valid JSON |
| 400 | `invalid_body` | failed Zod validation (see `error.details`) |
| 401 | `unauthorized` | missing/wrong bearer token |
| 404 | `not_found` | no such session |
| 409 | `already_exists` | session name collision |
| 409 | `cdp_unavailable_for_persistent_session` | persistent sessions have no shared CDP url |
| 422 | `script_failed` | eval threw inside the page |
| 500 | `internal_error` | unexpected — check server logs |
| 502 | `navigate_failed` `screenshot_failed` `cookie_read_failed` `cookie_write_failed` `session_unreachable` | Chromium-side failure |

Playwright errors are truncated to one line + 300 chars before being returned to clients; the full message stays in server logs.

## When NOT to use this

- **Hostile scraping at scale.** Use [Camoufox](https://github.com/daijro/camoufox) instead — Firefox with deeper fingerprint randomization.
- **You only need a one-off browser run inside a single agent process.** Use Playwright directly; the daemon shines for multi-agent + reusable sessions.
- **You need TLS/JA3 fingerprint patching.** Chromium drives the requests, so the JA3 surface is real-Chromium — not patched.

## Worked examples

See `examples/`:
- `examples/attach-from-playwright.ts` — Playwright over CDP
- `examples/attach-from-puppeteer.ts` — Puppeteer over CDP
- `examples/multi-agent-debug.ts` — two agents driving two surfaces in parallel
- `examples/run-script.sh` — curl-only walkthrough
