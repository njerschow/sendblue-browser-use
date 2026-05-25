/**
 * Attach to a non-persistent session via CDP and drive it with Playwright.
 *
 *   bun install playwright
 *   BROWSER_USE_API_KEY=... bun examples/attach-from-playwright.ts
 */
import { chromium } from "playwright";

const KEY = process.env.BROWSER_USE_API_KEY!;
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

const created = await fetch(`${BASE}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ name: "playwright-demo", persistent: false }),
}).then((r) => r.json());

const { cdpUrl } = await fetch(`${BASE}/sessions/playwright-demo/cdp-url`, {
  headers: { authorization: `Bearer ${KEY}` },
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(cdpUrl);
const ctx = browser.contexts()[0]!;
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://example.com");
console.log("title:", await page.title());
await page.screenshot({ path: "/tmp/example.png" });
await browser.close();

await fetch(`${BASE}/sessions/playwright-demo`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${KEY}` },
});
console.log("done. session:", created.session.name);
