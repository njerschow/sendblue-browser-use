/**
 * Smoke test: boots an in-process Hono app, creates a session, navigates,
 * screenshots, purges, deletes. Exits non-zero on any failure.
 *
 *   bun install
 *   bun --bun x patchright install chromium
 *   BROWSER_USE_API_KEY=test-key bun test/smoke.ts
 */
import { mkdirSync } from "node:fs";

const KEY = process.env.BROWSER_USE_API_KEY ?? "test-key";
process.env.BROWSER_USE_API_KEY = KEY;
process.env.DEFAULT_HEADLESS = "true";

mkdirSync("/tmp/sendblue-browser-use-smoke", { recursive: true });
process.env.DATA_DIR = "/tmp/sendblue-browser-use-smoke";

const { createApp } = await import("../src/server");
const { shutdownAllSessions } = await import("../src/sessions");
const { shutdownBrowser } = await import("../src/browser");

const app = createApp();
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://test${path}`, {
    method,
    headers: auth,
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, json, text };
}

async function callRaw(method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://test${path}`, {
    method,
    headers: auth,
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

try {
  console.log("health:", (await call("GET", "/health")).json);
  const sharedSession = await callRaw("POST", "/sessions", { name: "shared", persistent: false, headless: false });
  if (sharedSession.status !== 201) {
    throw new Error(`expected non-persistent session to ignore headless override and return 201, got ${sharedSession.status}: ${sharedSession.text}`);
  }
  const shared = sharedSession.json as { session?: { headless?: boolean; cdpUrl?: string } };
  if (shared.session?.headless !== true || !shared.session?.cdpUrl) {
    throw new Error(`expected shared session to inherit DEFAULT_HEADLESS=true and expose CDP url: ${sharedSession.text}`);
  }
  console.log("shared:", sharedSession.json);
  console.log("delete shared:", (await call("DELETE", "/sessions/shared")).json);
  console.log("create:", (await call("POST", "/sessions", { name: "smoke" })).json);
  console.log("navigate:", (await call("POST", "/sessions/smoke/navigate", { url: "https://example.com" })).json);
  const shotRes = await app.fetch(new Request("http://test/sessions/smoke/screenshot", { headers: auth }));
  if (!shotRes.ok) throw new Error(`screenshot failed ${shotRes.status}`);
  console.log("screenshot bytes:", (await shotRes.arrayBuffer()).byteLength);
  console.log("purge:", (await call("POST", "/sessions/smoke/purge")).json);
  console.log("delete:", (await call("DELETE", "/sessions/smoke")).json);
  console.log("PASS");
} catch (err) {
  console.error("FAIL:", err);
  process.exitCode = 1;
} finally {
  await shutdownAllSessions().catch(() => {});
  await shutdownBrowser().catch(() => {});
}
