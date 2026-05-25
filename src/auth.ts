import type { MiddlewareHandler } from "hono";
import { env } from "./env";

/**
 * Bearer-token auth on every route except /health.
 * Send: Authorization: Bearer $BROWSER_USE_API_KEY
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/health") return next();
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token || !timingSafeEqual(token, env.BROWSER_USE_API_KEY)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
