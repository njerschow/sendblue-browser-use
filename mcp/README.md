# sendblue-browser-mcp

MCP server that wraps the [`sendblue-browser-use`](https://github.com/SendblueBase/sendblue-browser-use) daemon. Exposes the full HTTP API as MCP tools so any MCP-speaking client (Claude Desktop, OpenAI Codex, Cursor, Google Antigravity, Cline, Windsurf, Claude Code) can drive a stealth-patched Chromium with one line of config.

## Install

```bash
# Most clients: nothing to install — they run via npx automatically.
# Verify it works once:
npx -y sendblue-browser-mcp
```

You must already have the `sendblue-browser-use` daemon running on `127.0.0.1:8787` (or wherever `BROWSER_USE_URL` points). The MCP server is a thin proxy.

## Configure your client

All MCP clients have converged on this shape:

```json
{
  "mcpServers": {
    "sendblue-browser": {
      "command": "npx",
      "args": ["-y", "sendblue-browser-mcp"],
      "env": {
        "BROWSER_USE_URL": "http://127.0.0.1:8787",
        "BROWSER_USE_API_KEY": "<the same token you started the daemon with>"
      }
    }
  }
}
```

Drop that block into:

| Client | Config path |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Claude Code | `~/.claude.json` or repo-level `.claude.json` |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| Google Antigravity | `~/.gemini/config/mcp_config.json` |
| OpenAI Codex | `codex mcp add sendblue-browser npx -- -y sendblue-browser-mcp` (writes `~/.codex/config.toml`) |
| Cline | Settings → MCP Servers → Add |
| Windsurf | Settings → Cascade → MCP → Add |

## Streamable HTTP mode (optional)

If your client prefers remote MCP servers, run the wrapper as an HTTP service:

```bash
sendblue-browser-mcp --port 8788
```

Then point your client at it:

```json
{
  "mcpServers": {
    "sendblue-browser": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

## Tools exposed

| Tool | What it does |
|---|---|
| `health` | Check if the daemon is reachable, including its default headless mode. |
| `list_sessions` | List active browser sessions. |
| `create_session` | Spawn a session. `persistent=false` for CDP attach and ignores per-session `headless`; use `persistent=true, headless=false` for a visible persisted browser. |
| `get_session` | Inspect current page URL/title + console buffer count. |
| `navigate` | Navigate to a URL (http(s) only). |
| `screenshot` | Capture PNG, full-page or per-selector. Returned as MCP image block. |
| `script` | Eval a JS expression in page context (wrap statements in an IIFE). |
| `get_cookies` / `set_cookies` | Playwright-shape cookie I/O. |
| `get_console` | Read recent console messages from the page. |
| `get_cdp_url` | Get the CDP websocket URL for direct Playwright/Puppeteer attach. |
| `purge_session` | Clear cookies + storage + caches, keep session id. |
| `close_session` | Close + delete on-disk profile. |

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `BROWSER_USE_API_KEY` | Yes | — | Same token used to start the daemon. |
| `BROWSER_USE_URL` | No | `http://127.0.0.1:8787` | Daemon base URL. |

## License

MIT. See [LICENSE](../LICENSE) in the parent repo.
