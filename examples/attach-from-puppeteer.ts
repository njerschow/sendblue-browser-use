/**
 * Same idea but with Puppeteer. CDP attach works because we patch Chromium itself.
 *
 *   bun install puppeteer-core
 *   BROWSER_USE_API_KEY=... bun examples/attach-from-puppeteer.ts
 */
import puppeteer from "puppeteer-core";

const KEY = process.env.BROWSER_USE_API_KEY!;
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";

await fetch(`${BASE}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ name: "pptr-demo", persistent: false }),
});

const { cdpUrl } = await fetch(`${BASE}/sessions/pptr-demo/cdp-url`, {
  headers: { authorization: `Bearer ${KEY}` },
}).then((r) => r.json());

const browser = await puppeteer.connect({ browserWSEndpoint: cdpUrl });
const pages = await browser.pages();
const page = pages[0] ?? (await browser.newPage());
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log("title:", await page.title());
await browser.disconnect();

await fetch(`${BASE}/sessions/pptr-demo`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${KEY}` },
});
