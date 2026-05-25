import { mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "patchright";
import { chromium } from "patchright";
import { env } from "./env";
import { log } from "./lib/logger";
import type { ConsoleMessage, Session, SessionOptions, SessionSummary } from "./types";
import { getCdpUrl, getSharedBrowser, onBrowserDisconnected } from "./browser";

const sessions = new Map<string, Session>();
const creatingSessions = new Set<string>();

let evictTimer: ReturnType<typeof setInterval> | null = null;
let disconnectUnsub: (() => void) | null = null;

// When the shared browser dies, every non-persistent session points at a dead
// context. Drop them from the map so callers get 404 instead of crashes.
function dropNonPersistentSessions() {
  for (const [name, session] of sessions) {
    if (!session.persistent) {
      log.warn("dropping session after shared browser disconnect", { name });
      sessions.delete(name);
    }
  }
}

export function startIdleEviction() {
  if (!disconnectUnsub) disconnectUnsub = onBrowserDisconnected(dropNonPersistentSessions);
  if (evictTimer || env.IDLE_SESSION_MINUTES === 0) return;
  evictTimer = setInterval(() => {
    const cutoff = Date.now() - env.IDLE_SESSION_MINUTES * 60_000;
    for (const [name, session] of sessions) {
      if (new Date(session.lastUsedAt).getTime() < cutoff) {
        log.info("evicting idle session", { name, lastUsedAt: session.lastUsedAt });
        void closeSession(name, { keepProfile: true }).catch(() => {});
      }
    }
  }, 60_000);
}

export function stopIdleEviction() {
  if (evictTimer) clearInterval(evictTimer);
  evictTimer = null;
  if (disconnectUnsub) { disconnectUnsub(); disconnectUnsub = null; }
}

function profileDir(name: string) {
  return join(env.dataDir, "profiles", name);
}

function runsDir(name: string) {
  return join(env.dataDir, "runs", name);
}

function effectiveHeadless(value: boolean | "new"): boolean {
  return value === "new" ? true : value;
}

export function shouldAutoScreenshotNavigation(sessionHeadless: boolean): boolean {
  if (env.MAX_NAV_SCREENSHOTS === 0 || env.navScreenshotPolicy === "off") return false;
  if (env.navScreenshotPolicy === "always") return true;
  return sessionHeadless;
}

async function resolveCdpTargetId(context: BrowserContext, page: Page, name: string): Promise<string | undefined> {
  let cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  try {
    cdp = await context.newCDPSession(page);
    const info = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    return typeof info.targetInfo?.targetId === "string" ? info.targetInfo.targetId : undefined;
  } catch (err) {
    log.warn("cdp_target_id_unavailable", { name, err: String(err) });
    return undefined;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

export function listSessions(): SessionSummary[] {
  return [...sessions.values()].map(summarise);
}

export function getSession(name: string): Session | undefined {
  return sessions.get(name);
}

export function touch(session: Session) {
  session.lastUsedAt = new Date().toISOString();
}

export async function createSession(options: SessionOptions): Promise<SessionSummary> {
  if (sessions.has(options.name) || creatingSessions.has(options.name)) {
    throw Object.assign(new Error(`session "${options.name}" already exists`), { status: 409 });
  }
  creatingSessions.add(options.name);

  const persistent = options.persistent !== false;
  const defaultHeadless = effectiveHeadless(env.defaultHeadless);
  const requestedHeadless = options.headless === undefined ? undefined : effectiveHeadless(options.headless);
  const sessionHeadless = persistent ? (requestedHeadless ?? defaultHeadless) : defaultHeadless;
  const autoNavScreenshots = shouldAutoScreenshotNavigation(sessionHeadless);
  let context: BrowserContext | undefined;
  try {
    mkdirSync(profileDir(options.name), { recursive: true });
    mkdirSync(runsDir(options.name), { recursive: true });

    if (persistent) {
      // Persistent context = one-off browser instance backed by an on-disk profile.
      // We sacrifice the shared CDP attach url for persistent sessions but gain
      // durable cookies/storage. Use { persistent: false } if you want the shared
      // CDP url + ephemeral state.
      // patchright handles AutomationControlled internally — passing the flag here would defeat it.
      // Only forward userAgent/viewport when caller explicitly sets them.
      context = await chromium.launchPersistentContext(profileDir(options.name), {
        headless: sessionHeadless,
        viewport: options.viewport ?? null,
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        locale: options.locale ?? "en-US",
        timezoneId: options.timezone,
        proxy: options.proxy,
        acceptDownloads: true,
        args: ["--no-first-run", "--no-default-browser-check", ...env.chromiumArgs],
      });
    } else {
      const browser = await getSharedBrowser();
      context = await browser.newContext({
        viewport: options.viewport ?? null,
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        locale: options.locale ?? "en-US",
        timezoneId: options.timezone,
        proxy: options.proxy,
        acceptDownloads: true,
      });
    }

    const page = context.pages()[0] ?? (await context.newPage());

    if (options.traces) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }

    const cdpTargetId = persistent ? undefined : await resolveCdpTargetId(context, page, options.name);

    const session: Session = {
      name: options.name,
      persistent,
      context,
      page,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      consoleBuffer: [],
      navScreenshotPaths: [],
      autoNavScreenshots,
      runsDir: runsDir(options.name),
      options,
      cdpUrl: persistent ? undefined : (getCdpUrl() ?? undefined),
      cdpTargetId,
    };

    // Capture console messages into a ring buffer.
    page.on("console", (msg) => {
      pushConsole(session, {
        t: new Date().toISOString(),
        type: msg.type(),
        text: msg.text(),
        url: page.url(),
      });
    });
    page.on("pageerror", (err) => {
      pushConsole(session, {
        t: new Date().toISOString(),
        type: "pageerror",
        text: err.message,
        url: page.url(),
      });
    });

    // Auto-screenshot navigation according to NAV_SCREENSHOT_POLICY, capped at
    // MAX_NAV_SCREENSHOTS per session so a long-lived nav-heavy run can't fill
    // the host disk. Headed captures can visibly repaint during navigation.
    if (autoNavScreenshots) {
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filePath = join(session.runsDir, `${ts}-nav.png`);
        page.screenshot({ path: filePath, fullPage: false })
          .then(() => {
            session.navScreenshotPaths.push(filePath);
            while (session.navScreenshotPaths.length > env.MAX_NAV_SCREENSHOTS) {
              const oldest = session.navScreenshotPaths.shift();
              if (oldest) try { unlinkSync(oldest); } catch {}
            }
          })
          .catch(() => {});
      });
    }

    sessions.set(options.name, session);
    log.info("session created", { name: options.name, persistent });
    return summarise(session);
  } catch (err) {
    await context?.close().catch(() => {});
    throw err;
  } finally {
    creatingSessions.delete(options.name);
  }
}

export async function purgeSession(name: string): Promise<SessionSummary> {
  const session = sessions.get(name);
  if (!session) throw Object.assign(new Error(`session "${name}" not found`), { status: 404 });
  // Clear cookies + permissions at the context level, then localStorage,
  // sessionStorage, IndexedDB, ServiceWorkers, and CacheStorage in every page.
  await session.context.clearCookies().catch((err) => log.warn("purge_clear_cookies_failed", { name, err: String(err) }));
  await session.context.clearPermissions().catch((err) => log.warn("purge_clear_permissions_failed", { name, err: String(err) }));
  for (const page of session.context.pages()) {
    await page.evaluate(async () => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        const dbs = await indexedDB.databases?.() ?? [];
        await Promise.all(dbs.map((db) => new Promise<void>((resolve) => {
          if (!db.name) return resolve();
          const req = indexedDB.deleteDatabase(db.name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        })));
      } catch {}
      try {
        const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
        await Promise.all(regs.map((r) => r.unregister()));
      } catch {}
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {}
    }).catch((err) => log.warn("purge_page_eval_failed", { name, err: String(err) }));
    await page.goto("about:blank").catch((err) => log.warn("purge_goto_blank_failed", { name, err: String(err) }));
  }
  session.consoleBuffer.length = 0;
  touch(session);
  log.info("session purged", { name });
  return summarise(session);
}

export async function closeSession(name: string, opts: { keepProfile?: boolean } = {}): Promise<void> {
  const session = sessions.get(name);
  if (!session) throw Object.assign(new Error(`session "${name}" not found`), { status: 404 });
  if (session.options.traces) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await session.context.tracing.stop({ path: join(session.runsDir, `${ts}-trace.zip`) }).catch(() => {});
  }
  await session.context.close().catch(() => {});
  sessions.delete(name);
  if (!opts.keepProfile && existsSync(profileDir(name))) {
    rmSync(profileDir(name), { recursive: true, force: true });
  }
  log.info("session closed", { name, keptProfile: !!opts.keepProfile });
}

function pushConsole(session: Session, message: ConsoleMessage) {
  session.consoleBuffer.push(message);
  if (session.consoleBuffer.length > env.MAX_CONSOLE_BUFFER) {
    session.consoleBuffer.splice(0, session.consoleBuffer.length - env.MAX_CONSOLE_BUFFER);
  }
}

function summarise(session: Session): SessionSummary {
  const page = session.context.pages()[0];
  return {
    name: session.name,
    persistent: session.persistent,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    pageUrl: page?.url() ?? null,
    pageTitle: null, // computed lazily where needed; sync read here keeps list fast
    consoleMessages: session.consoleBuffer.length,
    autoNavScreenshots: session.autoNavScreenshots,
    cdpUrl: session.cdpUrl,
    cdpTargetId: session.cdpTargetId,
  };
}

export async function shutdownAllSessions() {
  const names = [...sessions.keys()];
  await Promise.allSettled(names.map((name) => closeSession(name, { keepProfile: true })));
}
