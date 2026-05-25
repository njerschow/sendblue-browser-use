/**
 * Same idea but with Puppeteer. CDP attach works because we patch Chromium itself.
 *
 *   bun install --no-save puppeteer-core
 *   BROWSER_USE_API_KEY=... bun examples/attach-from-puppeteer.ts
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const KEY = process.env.BROWSER_USE_API_KEY;
if (!KEY) throw new Error("set BROWSER_USE_API_KEY");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const NAME = `pptr-demo-${Date.now().toString(36)}`;

const auth = { authorization: `Bearer ${KEY}` };
const jsonHeaders = { ...auth, "content-type": "application/json" };

async function requestJson(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function targetIdFor(page: Page) {
  const cdp = await page.target().createCDPSession();
  try {
    const info = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    return info.targetInfo?.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function sessionPage(browser: Browser, targetId: string) {
  for (const page of await browser.pages()) {
    if (await targetIdFor(page).catch(() => undefined) === targetId) return page;
  }
  throw new Error(`CDP target ${targetId} not found`);
}

await requestJson("/sessions", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ name: NAME, persistent: false }),
});

const { cdpUrl, targetId } = await requestJson(`/sessions/${NAME}/cdp-url`, { headers: auth });
if (!targetId) throw new Error("session did not return a CDP targetId");

const browser = await puppeteer.connect({ browserWSEndpoint: cdpUrl });
try {
  const page = await sessionPage(browser, targetId);
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  console.log("title:", await page.title());
} finally {
  browser.disconnect();
  await fetch(`${BASE}/sessions/${NAME}`, { method: "DELETE", headers: auth });
}
