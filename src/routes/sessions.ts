import { Hono } from "hono";
import { z } from "zod";
import {
  closeSession,
  createSession,
  getSession,
  listSessions,
  purgeSession,
  touch,
} from "../sessions";
import { validSessionName } from "../lib/id";

export const sessionsRoutes = new Hono();

const errBody = (code: string, message: string, details?: unknown) =>
  details === undefined ? { error: { code, message } } : { error: { code, message, details } };

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
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json(errBody("malformed_json", "request body is not valid JSON"), 400);
  const parsed = CreateBody.safeParse(body);
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
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
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
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json(errBody("malformed_json", "request body is not valid JSON"), 400);
  const parsed = NavigateBody.safeParse(body);
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
    return c.json(errBody("navigate_failed", (err as Error).message), 502);
  }
});

sessionsRoutes.get("/:name/screenshot", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  touch(session);
  const fullPage = c.req.query("fullPage") === "true";
  const selector = c.req.query("selector") ?? undefined;
  const target = selector ? session.page.locator(selector).first() : session.page;
  const buffer = await target.screenshot({ fullPage });
  return new Response(buffer as unknown as BodyInit, {
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
});

sessionsRoutes.post("/:name/script", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json(errBody("malformed_json", "request body is not valid JSON"), 400);
  const parsed = ScriptBody.safeParse(body);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  touch(session);
  try {
    // Code runs in page context. Caller is responsible for what they send;
    // this is a debug tool guarded by bearer auth, not a public endpoint.
    const result = await session.page.evaluate(parsed.data.code);
    return c.json({ result });
  } catch (err) {
    // 422: request was well-formed but the eval threw inside the page.
    return c.json(errBody("script_failed", (err as Error).message), 422);
  }
});

sessionsRoutes.get("/:name/cookies", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  const urls = c.req.query("url")?.split(",");
  const cookies = await session.context.cookies(urls);
  return c.json({ cookies });
});

sessionsRoutes.post("/:name/cookies", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  const body = await c.req.json().catch(() => null);
  if (body === null) return c.json(errBody("malformed_json", "request body is not valid JSON"), 400);
  const parsed = z.object({ cookies: z.array(CookieSchema).max(500) }).safeParse(body);
  if (!parsed.success) return c.json(errBody("invalid_body", "request body failed validation", parsed.error.format()), 400);
  await session.context.addCookies(parsed.data.cookies as unknown as Parameters<typeof session.context.addCookies>[0]);
  return c.json({ ok: true });
});

sessionsRoutes.get("/:name/console", (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 100), session.consoleBuffer.length);
  return c.json({ messages: session.consoleBuffer.slice(-limit) });
});

sessionsRoutes.get("/:name/cdp-url", (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json(errBody("not_found", `session "${c.req.param("name")}" not found`), 404);
  if (!session.cdpUrl) {
    return c.json(
      errBody(
        "cdp_unavailable_for_persistent_session",
        "Persistent sessions back to a private profile and do not expose the shared CDP URL. Create the session with { persistent: false } to attach via CDP.",
      ),
      409,
    );
  }
  return c.json({ cdpUrl: session.cdpUrl });
});
