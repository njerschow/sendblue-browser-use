/**
 * Smoke test: boots an in-process Hono app, creates a session, navigates,
 * screenshots, purges, deletes. Exits non-zero on any failure.
 *
 *   bun install
 *   bun --bun x patchright install chromium
 *   BROWSER_USE_API_KEY=test-key bun test/smoke.ts
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.BROWSER_USE_API_KEY ?? "test-key";
process.env.BROWSER_USE_API_KEY = KEY;
process.env.DEFAULT_HEADLESS = "true";
process.env.NAV_SCREENSHOT_POLICY = "headless";

const DATA_DIR = "/tmp/sendblue-browser-use-smoke";
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;

const { createApp } = await import("../src/server");
const { shouldAutoScreenshotNavigation, shutdownAllSessions } = await import("../src/sessions");
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function navScreenshotCount(name: string): number {
  try {
    return readdirSync(join(DATA_DIR, "runs", name)).filter((file) => file.endsWith("-nav.png")).length;
  } catch {
    return 0;
  }
}

try {
  console.log("health:", (await call("GET", "/health")).json);
  if (shouldAutoScreenshotNavigation(false) !== false) {
    throw new Error("expected NAV_SCREENSHOT_POLICY=headless to skip headed auto nav screenshots");
  }
  console.log("headed policy: skip auto nav screenshots");

  const smokeCreate = await call("POST", "/sessions", { name: "smoke" });
  console.log("create:", smokeCreate.json);
  if ((smokeCreate.json as { session?: { autoNavScreenshots?: boolean } }).session?.autoNavScreenshots !== true) {
    throw new Error(`expected headless session to report autoNavScreenshots=true: ${smokeCreate.text}`);
  }
  console.log("navigate:", (await call("POST", "/sessions/smoke/navigate", { url: "https://example.com" })).json);
  await sleep(300);
  if (navScreenshotCount("smoke") < 1) {
    throw new Error("expected headless session to write an automatic nav screenshot");
  }
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
