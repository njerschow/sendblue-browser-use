# AGENTS.md — sendblue-browser-use

> Spec: https://agents.md. This file is read by Codex, Cursor, Antigravity, Windsurf, Aider, Cline, Jules, Zed, and most other agents that follow the convention.

## What this repo is

A standalone HTTP daemon that runs a stealth-patched Chromium (`patchright`) for browser automation. Long-lived process, bearer-token-gated REST API, optional CDP attach for any client (Playwright, Puppeteer, custom scripts). Defeats Cloudflare Turnstile and similar low-friction bot checks.

Source layout:
- `src/` — Bun + Hono HTTP server
- `mcp/` — MCP server wrapper (npm-publishable as `sendblue-browser-mcp`)
- `skills/sendblue-browser/SKILL.md` — cross-agent skill (Claude / Codex / Antigravity / Cline)
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `examples/` — Playwright / Puppeteer / multi-agent CDP attach snippets
- `Dockerfile` + `docker-compose.yml` — self-contained deploy

## Setup

```bash
bun install
bun x patchright install chromium
cp .env.example .env
# Set BROWSER_USE_API_KEY (any string ≥ 8 chars; generator: openssl rand -hex 32)
bun run dev          # starts daemon on http://127.0.0.1:8787
```

Or Docker: `docker compose up -d`.

## Common commands

```bash
# Health (no auth)
curl -s http://127.0.0.1:8787/health

# Create a session
curl -s -X POST http://127.0.0.1:8787/sessions \
  -H "Authorization: Bearer $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"qa","persistent":false}'

# Navigate (http/https only)
curl -s -X POST http://127.0.0.1:8787/sessions/qa/navigate \
  -H "Authorization: Bearer $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","waitUntil":"networkidle","timeoutMs":15000}'

# Screenshot
curl -s "http://127.0.0.1:8787/sessions/qa/screenshot?fullPage=true" \
  -H "Authorization: Bearer $BROWSER_USE_API_KEY" -o /tmp/shot.png

# Eval JS — expression form (wrap statements in IIFE)
curl -s -X POST http://127.0.0.1:8787/sessions/qa/script \
  -H "Authorization: Bearer $BROWSER_USE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"(() => document.title)()"}'
```

Full API + error envelope in `README.md`.

## Code style

- TypeScript strict + `noUncheckedIndexedAccess` + `noImplicitOverride`. Prefer `unknown` over `any`.
- Errors: `{ error: { code, message, details? } }` envelope. New error paths must add a code to the README table.
- Routes: small Hono handlers; do work in `src/sessions.ts`; helpers in `src/lib/`.
- Comments: only when the WHY is non-obvious. No "what" comments.

## Build / test / typecheck

```bash
bun run typecheck        # tsc --noEmit, must pass clean
bun run smoke            # end-to-end smoke test (test/smoke.ts)
bun test                 # unit tests when added
```

## Security notes

- HTTP API binds `127.0.0.1` by default. `BIND=0.0.0.0` exposes to LAN — put auth in front first.
- CDP binds `CDP_BIND` (default `127.0.0.1`). Anyone who can reach this port has in-browser RCE. Keep on loopback.
- `POST /sessions/:name/script` runs arbitrary JS in the page context — the bearer token is the only gate. Don't share it.
- `/navigate` only accepts `http(s)` URLs; `file://` / `chrome://` are rejected.
- `/health` is public so probes work without a token; it returns service metadata only.
- See `SECURITY.md` for disclosure process.

## PR guidelines

- One commit per logical change. Subject line under 70 chars.
- Always run `bun run typecheck` before committing.
- Don't add new dependencies without a one-line justification in the commit message.
- Don't change the public API shape without a README + skill update in the same commit.
