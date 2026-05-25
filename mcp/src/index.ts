#!/usr/bin/env node
/**
 * sendblue-browser-mcp — MCP server that proxies the sendblue-browser-use HTTP
 * daemon. Stdio transport by default; pass --port N to expose Streamable HTTP.
 *
 * Configure once in your MCP client (Claude Desktop, Codex, Cursor, Antigravity,
 * Cline, Windsurf):
 *
 *   { "mcpServers": { "sendblue-browser": {
 *       "command": "npx", "args": ["-y", "sendblue-browser-mcp"],
 *       "env": { "BROWSER_USE_URL": "http://127.0.0.1:8787",
 *                "BROWSER_USE_API_KEY": "..." } } } }
 *
 * If the daemon is not running, every tool call returns a clear hint
 * with the local start command instead of an opaque connection error.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const BASE_URL = (process.env.BROWSER_USE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.BROWSER_USE_API_KEY ?? "";
const VERSION = "0.2.0";

if (!TOKEN) {
  console.error(
    "[sendblue-browser-mcp] BROWSER_USE_API_KEY env var is required. " +
      "Set it to the same token you started the daemon with.",
  );
  process.exit(1);
}

const daemonHint =
  "Start it locally with: `cd <sendblue-browser-use> && BROWSER_USE_API_KEY=$BROWSER_USE_API_KEY bun src/index.ts` " +
  "or `docker compose up -d`.";

async function callDaemon(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach sendblue-browser-use daemon at ${BASE_URL}. ${daemonHint} (${(err as Error).message})`,
    );
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.startsWith("image/")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { __binary: true, mimeType: ct, base64: buf.toString("base64") };
  }
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const detail = typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : String(parsed);
    throw new Error(`daemon ${res.status}: ${detail}`);
  }
  return parsed;
}

function toolResult(value: unknown) {
  if (value && typeof value === "object" && (value as { __binary?: boolean }).__binary) {
    const b = value as { mimeType: string; base64: string };
    return {
      content: [
        { type: "image" as const, data: b.base64, mimeType: b.mimeType },
      ],
    };
  }
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function asyncTool<T extends z.ZodRawShape>(
  schema: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>,
) {
  return async (args: z.infer<z.ZodObject<T>>) => {
    try {
      return toolResult(await handler(args));
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  };
}

const server = new McpServer({
  name: "sendblue-browser",
  version: VERSION,
});

server.tool(
  "health",
  "Check if the sendblue-browser-use daemon is reachable. Returns service metadata, active session count, and defaultHeadless. No auth used (the /health endpoint is public).",
  {},
  asyncTool({}, async () => {
    const res = await fetch(`${BASE_URL}/health`).catch((err: Error) => {
      throw new Error(`Could not reach daemon at ${BASE_URL}. ${daemonHint} (${err.message})`);
    });
    return await res.json();
  }),
);

server.tool(
  "list_sessions",
  "List every active browser session on the daemon.",
  {},
  asyncTool({}, () => callDaemon("GET", "/sessions")),
);

server.tool(
  "create_session",
  "Create a new browser session. Use persistent=false (default) to enable CDP attach; persistent=true backs to an on-disk profile that survives restarts but does NOT expose a CDP url. The headless option only applies to persistent sessions; non-persistent sessions ignore it and inherit daemon DEFAULT_HEADLESS.",
  {
    name: z.string().min(1).describe("Session id. Must match /^[a-z0-9][a-z0-9_-]{0,62}$/i."),
    persistent: z.boolean().optional().default(false),
    headless: z.union([z.boolean(), z.literal("new")]).optional().describe("Persistent sessions only. Non-persistent sessions ignore this value and inherit daemon DEFAULT_HEADLESS."),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    userAgent: z.string().optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
    traces: z.boolean().optional().describe("Record a Playwright trace.zip on session close."),
    proxy: z.object({
      server: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
      bypass: z.string().optional(),
    }).optional(),
  },
  asyncTool(
    {
      name: z.string().min(1),
      persistent: z.boolean().optional().default(false),
      headless: z.union([z.boolean(), z.literal("new")]).optional(),
      viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
      userAgent: z.string().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
      traces: z.boolean().optional(),
      proxy: z.object({
        server: z.string(),
        username: z.string().optional(),
        password: z.string().optional(),
        bypass: z.string().optional(),
      }).optional(),
    },
    (body) => callDaemon("POST", "/sessions", body),
  ),
);

server.tool(
  "get_session",
  "Inspect a session — current page URL/title, console message count, CDP url.",
  { name: z.string().min(1) },
  asyncTool({ name: z.string().min(1) }, ({ name }) => callDaemon("GET", `/sessions/${encodeURIComponent(name)}`)),
);

server.tool(
  "navigate",
  "Navigate the session's page to a URL. http(s) only; file:// and chrome:// are rejected. waitUntil defaults to 'domcontentloaded'.",
  {
    name: z.string().min(1),
    url: z.string().url().describe("Must start with http:// or https://."),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  },
  asyncTool(
    {
      name: z.string().min(1),
      url: z.string().url(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
    },
    ({ name, ...body }) => callDaemon("POST", `/sessions/${encodeURIComponent(name)}/navigate`, body),
  ),
);

server.tool(
  "screenshot",
  "Take a PNG screenshot of the session's page. Returns an MCP image block. Optional CSS selector to capture a specific element; selector waits up to 5s.",
  {
    name: z.string().min(1),
    fullPage: z.boolean().optional().default(false),
    selector: z.string().optional(),
  },
  asyncTool(
    {
      name: z.string().min(1),
      fullPage: z.boolean().optional().default(false),
      selector: z.string().optional(),
    },
    ({ name, fullPage, selector }) => {
      const q = new URLSearchParams();
      if (fullPage) q.set("fullPage", "true");
      if (selector) q.set("selector", selector);
      const qs = q.toString() ? `?${q.toString()}` : "";
      return callDaemon("GET", `/sessions/${encodeURIComponent(name)}/screenshot${qs}`);
    },
  ),
);

server.tool(
  "script",
  "Evaluate a JavaScript expression in the session's page context. EXPRESSION form only — wrap statements in an IIFE. 422 if the eval throws. Body cap 200 kB.",
  {
    name: z.string().min(1),
    code: z.string().min(1).max(200_000).describe("JavaScript expression. Wrap statements in '(() => { ... })()'."),
  },
  asyncTool(
    { name: z.string().min(1), code: z.string().min(1).max(200_000) },
    ({ name, code }) => callDaemon("POST", `/sessions/${encodeURIComponent(name)}/script`, { code }),
  ),
);

server.tool(
  "get_cookies",
  "Read cookies from the session's context. Optional comma-separated URL filter.",
  { name: z.string().min(1), url: z.string().optional() },
  asyncTool(
    { name: z.string().min(1), url: z.string().optional() },
    ({ name, url }) => {
      const qs = url ? `?url=${encodeURIComponent(url)}` : "";
      return callDaemon("GET", `/sessions/${encodeURIComponent(name)}/cookies${qs}`);
    },
  ),
);

server.tool(
  "set_cookies",
  "Inject cookies. Each cookie needs name+value plus EITHER url OR (domain AND path).",
  {
    name: z.string().min(1),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      url: z.string().url().optional(),
      domain: z.string().optional(),
      path: z.string().optional(),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    })).max(500),
  },
  asyncTool(
    {
      name: z.string().min(1),
      cookies: z.array(z.object({
        name: z.string(),
        value: z.string(),
        url: z.string().url().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
      })).max(500),
    },
    ({ name, cookies }) => callDaemon("POST", `/sessions/${encodeURIComponent(name)}/cookies`, { cookies }),
  ),
);

server.tool(
  "get_console",
  "Read recent console messages from the session's page (ring buffer).",
  { name: z.string().min(1), limit: z.number().int().min(1).max(500).optional() },
  asyncTool(
    { name: z.string().min(1), limit: z.number().int().min(1).max(500).optional() },
    ({ name, limit }) => {
      const qs = limit ? `?limit=${limit}` : "";
      return callDaemon("GET", `/sessions/${encodeURIComponent(name)}/console${qs}`);
    },
  ),
);

server.tool(
  "get_cdp_url",
  "Return the CDP websocket URL for a non-persistent session so a Playwright/Puppeteer client can connectOverCDP() to it. Persistent sessions return 409.",
  { name: z.string().min(1) },
  asyncTool(
    { name: z.string().min(1) },
    ({ name }) => callDaemon("GET", `/sessions/${encodeURIComponent(name)}/cdp-url`),
  ),
);

server.tool(
  "purge_session",
  "Clear cookies, permissions, localStorage, sessionStorage, IndexedDB, ServiceWorkers, CacheStorage, and the console buffer — but keep the session id. Does NOT delete the on-disk profile.",
  { name: z.string().min(1) },
  asyncTool(
    { name: z.string().min(1) },
    ({ name }) => callDaemon("POST", `/sessions/${encodeURIComponent(name)}/purge`),
  ),
);

server.tool(
  "close_session",
  "Close the session and delete its on-disk profile.",
  { name: z.string().min(1) },
  asyncTool(
    { name: z.string().min(1) },
    ({ name }) => callDaemon("DELETE", `/sessions/${encodeURIComponent(name)}`),
  ),
);

const port = (() => {
  const idx = process.argv.indexOf("--port");
  if (idx === -1) return null;
  const raw = process.argv[idx + 1];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
})();

if (port === null) {
  // Default: stdio transport. Works for every MCP client out of the box.
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // Optional: Streamable HTTP transport for clients that prefer remote MCP servers
  // (Cursor + Antigravity + Codex skill MCP deps + Claude Desktop with the remote-mcp setting).
  const httpServer = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, () => {
    console.error(`[sendblue-browser-mcp] Streamable HTTP on http://127.0.0.1:${port}/mcp`);
  });
}
