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

sessionsRoutes.get("/", (c) => {
  return c.json({ sessions: listSessions() });
});

sessionsRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  try {
    const summary = await createSession(parsed.data);
    return c.json({ session: summary }, 201);
  } catch (err) {
    const e = err as Error & { status?: number };
    return c.json({ error: e.message }, (e.status ?? 500) as 500);
  }
});

sessionsRoutes.get("/:name", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
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
    return c.json({ error: e.message }, (e.status ?? 500) as 500);
  }
});

sessionsRoutes.delete("/:name", async (c) => {
  try {
    await closeSession(c.req.param("name"));
    return c.json({ ok: true });
  } catch (err) {
    const e = err as Error & { status?: number };
    return c.json({ error: e.message }, (e.status ?? 500) as 500);
  }
});

sessionsRoutes.post("/:name/navigate", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ url: z.string().url(), waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  touch(session);
  const response = await session.page.goto(parsed.data.url, { waitUntil: parsed.data.waitUntil ?? "domcontentloaded" });
  return c.json({
    url: session.page.url(),
    title: await session.page.title().catch(() => null),
    status: response?.status() ?? null,
  });
});

sessionsRoutes.get("/:name/screenshot", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  touch(session);
  const fullPage = c.req.query("fullPage") === "true";
  const selector = c.req.query("selector") ?? undefined;
  const target = selector ? session.page.locator(selector).first() : session.page;
  const buffer = await target.screenshot({ fullPage });
  return new Response(buffer as unknown as BodyInit, { headers: { "content-type": "image/png" } });
});

sessionsRoutes.post("/:name/script", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ code: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  touch(session);
  try {
    // Code runs in page context. Caller is responsible for what they send;
    // this is a debug tool guarded by bearer auth, not a public endpoint.
    const result = await session.page.evaluate(parsed.data.code);
    return c.json({ result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

sessionsRoutes.get("/:name/cookies", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  const urls = c.req.query("url")?.split(",");
  const cookies = await session.context.cookies(urls);
  return c.json({ cookies });
});

sessionsRoutes.post("/:name/cookies", async (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ cookies: z.array(z.record(z.unknown())) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  await session.context.addCookies(parsed.data.cookies as unknown as Parameters<typeof session.context.addCookies>[0]);
  return c.json({ ok: true });
});

sessionsRoutes.get("/:name/console", (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 100), session.consoleBuffer.length);
  return c.json({ messages: session.consoleBuffer.slice(-limit) });
});

sessionsRoutes.get("/:name/cdp-url", (c) => {
  const session = getSession(c.req.param("name"));
  if (!session) return c.json({ error: "not_found" }, 404);
  if (!session.cdpUrl) {
    return c.json({
      error: "cdp_unavailable_for_persistent_session",
      message: "Persistent sessions back to a private profile and do not expose the shared CDP URL. Create the session with { persistent: false } to attach via CDP.",
    }, 409);
  }
  return c.json({ cdpUrl: session.cdpUrl });
});
