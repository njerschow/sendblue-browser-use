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
const VERSION = "0.2.3";
const MCP_TOKEN = process.env.SENDBLUE_BROWSER_MCP_TOKEN ?? "";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`sendblue-browser-mcp ${VERSION}

Usage:
  sendblue-browser-mcp [--port <port>]
  sendblue-browser-mcp --version

Environment:
  BROWSER_USE_API_KEY              Required daemon bearer token
  BROWSER_USE_URL                  Daemon URL (default http://127.0.0.1:8787)
  SENDBLUE_BROWSER_MCP_TOKEN       Required only for --port HTTP mode
`);
  process.exit(0);
}

if (!TOKEN) {
  console.error(
    "[sendblue-browser-mcp] BROWSER_USE_API_KEY env var is required. " +
      "Set it to the same token you started the daemon with.",
  );
  process.exit(1);
}

const daemonHint =
  "Start it locally with the same token: `cd <sendblue-browser-use> && BROWSER_USE_API_KEY=<this MCP token> bun src/index.ts` " +
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

function createMcpServer() {
  const server = new McpServer({
    name: "sendblue-browser",
    version: VERSION,
  });

server.tool(
  "health",
  "Check if the sendblue-browser-use daemon is reachable. Returns service metadata, active session count, and navScreenshotPolicy. No auth used (the /health endpoint is public).",
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
  "Create a new browser session. persistent=true follows the daemon default and backs to an on-disk profile that survives restarts but does NOT expose a CDP url; set persistent=false for CDP attach. The response includes autoNavScreenshots so clients know whether navigate writes background evidence.",
  {
    name: z.string().min(1).describe("Session id. Must match /^[a-z0-9][a-z0-9_-]{0,62}$/i."),
    persistent: z.boolean().optional(),
    headless: z.union([z.boolean(), z.literal("new")]).optional().describe("Persistent sessions only. Non-persistent sessions inherit daemon DEFAULT_HEADLESS."),
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
      persistent: z.boolean().optional(),
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
  "Inspect a session — current page URL/title, console message count, CDP url, and whether automatic nav screenshots are enabled.",
  { name: z.string().min(1) },
  asyncTool({ name: z.string().min(1) }, ({ name }) => callDaemon("GET", `/sessions/${encodeURIComponent(name)}`)),
);

server.tool(
  "navigate",
  "Navigate the session's page to a URL. http(s) only; file:// and chrome:// are rejected. waitUntil defaults to 'domcontentloaded'. Only sessions with autoNavScreenshots=true write background evidence; call screenshot after headed navigation when you need evidence.",
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
  "Take a PNG screenshot of the session's page. Returns an MCP image block. Optional CSS selector to capture a specific element; selector waits up to 5s. Use after headed navigation because headed sessions usually skip automatic nav screenshots to avoid flicker.",
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
  "Evaluate a JavaScript expression in the session's page context. EXPRESSION form only — wrap statements in an IIFE. 422 if the eval throws. Body cap 200 kB. timeoutMs defaults to 30000; pass 0 to disable.",
  {
    name: z.string().min(1),
    code: z.string().min(1).max(200_000).describe("JavaScript expression. Wrap statements in '(() => { ... })()'."),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  },
  asyncTool(
    {
      name: z.string().min(1),
      code: z.string().min(1).max(200_000),
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
    },
    ({ name, code, timeoutMs }) => callDaemon("POST", `/sessions/${encodeURIComponent(name)}/script`, {
      code,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
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
  "Return the CDP websocket URL and targetId for a non-persistent session so a Playwright/Puppeteer client can connectOverCDP() and select the session page. Persistent sessions return 409.",
  { name: z.string().min(1) },
  asyncTool(
    { name: z.string().min(1) },
    ({ name }) => callDaemon("GET", `/sessions/${encodeURIComponent(name)}/cdp-url`),
  ),
);

server.tool(
  "purge_session",
  "Clear cookies and permissions context-wide, then current open page/origin localStorage, sessionStorage, IndexedDB, ServiceWorkers, CacheStorage, and console buffer — but keep the session id. Does NOT delete the on-disk profile or enumerate every historical origin.",
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

  return server;
}

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
  await createMcpServer().connect(transport);
} else {
  if (!MCP_TOKEN) {
    console.error("[sendblue-browser-mcp] SENDBLUE_BROWSER_MCP_TOKEN env var is required in --port HTTP mode.");
    process.exit(1);
  }
  // Optional: Streamable HTTP transport for clients that prefer remote MCP servers
  // (Cursor + Antigravity + Codex skill MCP deps + Claude Desktop with the remote-mcp setting).
  const httpConnections = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${MCP_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({
        error: "unauthorized",
      }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    let transport: StreamableHTTPServerTransport | undefined;
    if (typeof sessionId === "string") {
      transport = httpConnections.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({
          error: "unknown MCP session",
        }));
        return;
      }
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) httpConnections.set(id, transport);
        },
        onsessionclosed: (id) => {
          httpConnections.delete(id);
        },
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) httpConnections.delete(id);
      };
      await createMcpServer().connect(transport);
    }

    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, "127.0.0.1", () => {
    console.error(`[sendblue-browser-mcp] Streamable HTTP on http://127.0.0.1:${port}/mcp`);
  });
}
