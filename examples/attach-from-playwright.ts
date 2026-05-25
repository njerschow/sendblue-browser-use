/**
 * Attach to a non-persistent session via CDP and drive it with Playwright.
 *
 *   bun install --no-save playwright
 *   BROWSER_USE_API_KEY=... bun examples/attach-from-playwright.ts
 */
import { chromium, type Browser, type Page } from "playwright";

const KEY = process.env.BROWSER_USE_API_KEY;
if (!KEY) throw new Error("set BROWSER_USE_API_KEY");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const NAME = `playwright-demo-${Date.now().toString(36)}`;

const auth = { authorization: `Bearer ${KEY}` };
const jsonHeaders = { ...auth, "content-type": "application/json" };

async function requestJson(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function targetIdFor(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const info = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    return info.targetInfo?.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function sessionPage(browser: Browser, targetId: string) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (await targetIdFor(page).catch(() => undefined) === targetId) return page;
    }
  }
  throw new Error(`CDP target ${targetId} not found`);
}

const created = await requestJson("/sessions", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ name: NAME, persistent: false }),
});

const { cdpUrl, targetId } = await requestJson(`/sessions/${NAME}/cdp-url`, { headers: auth });
if (!targetId) throw new Error("session did not return a CDP targetId");

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const page = await sessionPage(browser, targetId);
  await page.goto("https://example.com");
  console.log("title:", await page.title());
  await page.screenshot({ path: "/tmp/example.png" });
} finally {
  await fetch(`${BASE}/sessions/${NAME}`, { method: "DELETE", headers: auth });
  console.log("done. session:", created.session.name);
  // Playwright does not expose a Puppeteer-style disconnect() for CDP.
  // Do not call browser.close() against a shared daemon; exiting drops this client connection.
  process.exit(0);
}
