import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  closeSession,
  createSession,
  getSession,
  listSessions,
  purgeSession,
  touch,
} from "../sessions";
import { env } from "../env";
import { validSessionName } from "../lib/id";
import { log } from "../lib/logger";

export const sessionsRoutes = new Hono();

const errBody = (code: string, message: string, details?: unknown) =>
  details === undefined ? { error: { code, message } } : { error: { code, message, details } };

// Read JSON with a clean three-way split: empty body, malformed JSON, valid value.
// Hono's c.req.json() throws on both empty and malformed, so we read text first.
async function readJson(c: Context): Promise<
  { ok: true; value: unknown } | { ok: false; status: 400; body: ReturnType<typeof errBody> }
> {
  const raw = await c.req.text().catch(() => "");
  if (!raw.trim()) return { ok: false, status: 400, body: errBody("empty_body", "request body is required") };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, body: errBody("malformed_json", "request body is not valid JSON") };
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/(password=)[^&\s,)]+/gi, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1[redacted]$2");
}

// Strip Playwright/Chromium error noise (multi-line "Call log:" blocks, internal
// target IDs) before echoing to clients. Logs keep the full redacted message.
function sanitizeBrowserError(err: unknown, code: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactSecrets(raw);
  log.warn(`${code}_detail`, { err: redacted });
  return redacted.split("\n")[0]?.slice(0, 300) ?? "browser operation failed";
}

const notFound = (c: Context, name: string) =>
  c.json(errBody("not_found", `session "${name}" not found`), 404);

const CreateBody = z.object({
  name: z.string().refine(validSessionName, "name must match /^[a-z0-9][a-z0-9_-]{0,62}$/i"),
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
});

const NavigateBody = z.object({
  // Allowlist http(s) only — z.string().url() accepts file:/chrome:/view-source: etc,
  // which a bearer-token holder could use to read local files via /screenshot.
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), "url must be http(s)"),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  timeoutMs: z.number().int().min(0).max(120_000).optional(),
});

const ScriptBody = z.object({
  code: z.string().min(1).max(200_000),
});

const SCREENSHOT_TIMEOUT_MS = 5_000;

// Mirror Playwright's Cookie shape rather than accepting arbitrary records.
const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  url: z.string().url().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
}).refine((c) => c.url || (c.domain && c.path), "cookie requires url or (domain + path)");

sessionsRoutes.get("/", (c) => {
  return c.json({ sessions: listSessions() });
});

sessionsRoutes.post("/", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return c.json(body.body, body.status);
  const parsed = CreateBody.safeParse(body.value);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  try {
    const summary = await createSession(parsed.data);
    return c.json({ session: summary }, 201);
  } catch (err) {
    const e = err as Error & { status?: number; code?: string };
    const status = (e.status ?? 500) as 409 | 500;
    return c.json(errBody(e.code ?? (status === 409 ? "already_exists" : "internal_error"), e.message), status);
  }
});

sessionsRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  try {
    const page = session.context.pages()[0];
    const title = page ? await page.title().catch(() => null) : null;
    return c.json({
      name: session.name,
      persistent: session.persistent,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      pageUrl: page?.url() ?? null,
      pageTitle: title,
      consoleMessages: session.consoleBuffer.length,
      cdpUrl: session.cdpUrl,
    });
  } catch (err) {
    return c.json(errBody("session_unreachable", sanitizeBrowserError(err, "session_unreachable")), 502);
  }
});

sessionsRoutes.post("/:name/purge", async (c) => {
  try {
    const summary = await purgeSession(c.req.param("name"));
    return c.json({ session: summary });
  } catch (err) {
    const e = err as Error & { status?: number };
    const status = (e.status ?? 500) as 404 | 500;
    return c.json(errBody(status === 404 ? "not_found" : "internal_error", e.message), status);
  }
});

sessionsRoutes.delete("/:name", async (c) => {
  try {
    await closeSession(c.req.param("name"));
    return c.json({ ok: true });
  } catch (err) {
    const e = err as Error & { status?: number };
    const status = (e.status ?? 500) as 404 | 500;
    return c.json(errBody(status === 404 ? "not_found" : "internal_error", e.message), status);
  }
});

sessionsRoutes.post("/:name/navigate", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  const body = await readJson(c);
  if (!body.ok) return c.json(body.body, body.status);
  const parsed = NavigateBody.safeParse(body.value);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  touch(session);
  try {
    const response = await session.page.goto(parsed.data.url, {
      waitUntil: parsed.data.waitUntil ?? "domcontentloaded",
      timeout: parsed.data.timeoutMs ?? 30_000,
    });
    return c.json({
      url: session.page.url(),
      title: await session.page.title().catch(() => null),
      status: response?.status() ?? null,
    });
  } catch (err) {
    return c.json(errBody("navigate_failed", sanitizeBrowserError(err, "navigate_failed")), 502);
  }
});

sessionsRoutes.get("/:name/screenshot", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  touch(session);
  try {
    const fullPage = c.req.query("fullPage") === "true";
    const selector = c.req.query("selector") ?? undefined;
    const buffer = selector
      ? await session.page.locator(selector).first().screenshot({ timeout: SCREENSHOT_TIMEOUT_MS })
      : await session.page.screenshot({ fullPage, timeout: SCREENSHOT_TIMEOUT_MS });
    return new Response(buffer as unknown as BodyInit, {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  } catch (err) {
    return c.json(errBody("screenshot_failed", sanitizeBrowserError(err, "screenshot_failed")), 502);
  }
});

sessionsRoutes.post("/:name/script", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  const body = await readJson(c);
  if (!body.ok) return c.json(body.body, body.status);
  const parsed = ScriptBody.safeParse(body.value);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  touch(session);
  try {
    // Code runs in page context. Caller is responsible for what they send;
    // this is a debug tool guarded by bearer auth, not a public endpoint.
    const result = await session.page.evaluate(parsed.data.code);
    return c.json({ result });
  } catch (err) {
    // 422: request was well-formed but the eval threw inside the page.
    return c.json(errBody("script_failed", sanitizeBrowserError(err, "script_failed")), 422);
  }
});

sessionsRoutes.get("/:name/cookies", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  try {
    const urls = c.req.query("url")?.split(",");
    const cookies = await session.context.cookies(urls);
    return c.json({ cookies });
  } catch (err) {
    return c.json(errBody("cookie_read_failed", sanitizeBrowserError(err, "cookie_read_failed")), 502);
  }
});

sessionsRoutes.post("/:name/cookies", async (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  const body = await readJson(c);
  if (!body.ok) return c.json(body.body, body.status);
  const parsed = z.object({ cookies: z.array(CookieSchema).max(500) }).safeParse(body.value);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  try {
    await session.context.addCookies(parsed.data.cookies as unknown as Parameters<typeof session.context.addCookies>[0]);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(errBody("cookie_write_failed", sanitizeBrowserError(err, "cookie_write_failed")), 502);
  }
});

sessionsRoutes.get("/:name/console", (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  const parsedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const requestedLimit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
  const limit = Math.min(Math.max(requestedLimit, 0), env.MAX_CONSOLE_BUFFER, session.consoleBuffer.length);
  return c.json({ messages: session.consoleBuffer.slice(-limit) });
});

sessionsRoutes.get("/:name/cdp-url", (c) => {
  const name = c.req.param("name");
  const session = getSession(name);
  if (!session) return notFound(c, name);
  if (!session.cdpUrl) {
    return c.json(
      errBody(
        "cdp_unavailable_for_persistent_session",
        "Persistent sessions are backed by a private profile and do not expose the shared CDP URL. Create the session with { persistent: false } to attach via CDP.",
      ),
      409,
    );
  }
  return c.json({ cdpUrl: session.cdpUrl });
});
