import { chromium, type Browser } from "patchright";
import { env } from "./env";
import { log } from "./lib/logger";

let sharedBrowser: Browser | null = null;
let sharedCdpUrl: string | null = null;
let launching: Promise<Browser> | null = null;

/**
 * Lazily launch a single Chromium instance shared across all named sessions.
 * Each session gets its own BrowserContext (cookies/storage isolated).
 *
 * patchright applies stealth patches automatically:
 *   - navigator.webdriver hidden
 *   - CDP detection vectors patched (rebrowser patches)
 *   - Real Chromium binary (no Playwright-injected fingerprints)
 */
export async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    log.info("launching shared chromium", { cdpPort: env.CDP_PORT, headless: env.defaultHeadless });
    const browser = await chromium.launch({
      headless: env.defaultHeadless === "new" ? true : env.defaultHeadless,
      args: [
        `--remote-debugging-port=${env.CDP_PORT}`,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        ...env.chromiumArgs,
      ],
    });
    sharedBrowser = browser;
    // Resolve CDP url from the well-known DevTools JSON endpoint.
    try {
      const res = await fetch(`http://127.0.0.1:${env.CDP_PORT}/json/version`);
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        sharedCdpUrl = data.webSocketDebuggerUrl ?? null;
      }
    } catch (err) {
      log.warn("could not resolve cdp url", { err: String(err) });
    }
    browser.on("disconnected", () => {
      log.warn("shared chromium disconnected");
      sharedBrowser = null;
      sharedCdpUrl = null;
    });
    launching = null;
    return browser;
  })();
  return launching;
}

export function getCdpUrl(): string | null {
  return sharedCdpUrl;
}

export async function shutdownBrowser() {
  if (sharedBrowser) {
    log.info("shutting down shared chromium");
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    sharedCdpUrl = null;
  }
}
