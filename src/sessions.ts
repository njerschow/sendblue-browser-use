import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "patchright";
import { chromium } from "patchright";
import { env } from "./env";
import { log } from "./lib/logger";
import type { ConsoleMessage, Session, SessionOptions, SessionSummary } from "./types";
import { getCdpUrl, getSharedBrowser } from "./browser";

const sessions = new Map<string, Session>();

let evictTimer: ReturnType<typeof setInterval> | null = null;

export function startIdleEviction() {
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
}

function profileDir(name: string) {
  return join(env.dataDir, "profiles", name);
}

function runsDir(name: string) {
  return join(env.dataDir, "runs", name);
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
  if (sessions.has(options.name)) {
    throw Object.assign(new Error(`session "${options.name}" already exists`), { status: 409 });
  }
  mkdirSync(profileDir(options.name), { recursive: true });
  mkdirSync(runsDir(options.name), { recursive: true });

  const persistent = options.persistent !== false;
  let context: BrowserContext;

  if (persistent) {
    // Persistent context = one-off browser instance backed by an on-disk profile.
    // We sacrifice the shared CDP attach url for persistent sessions but gain
    // durable cookies/storage. Use { persistent: false } if you want the shared
    // CDP url + ephemeral state.
    const headlessOpt = options.headless ?? env.defaultHeadless;
    // patchright handles AutomationControlled internally — passing the flag here would defeat it.
    // Only forward userAgent/viewport when caller explicitly sets them.
    context = await chromium.launchPersistentContext(profileDir(options.name), {
      headless: headlessOpt === "new" ? true : headlessOpt,
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

  const session: Session = {
    name: options.name,
    persistent,
    context,
    page,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    consoleBuffer: [],
    runsDir: runsDir(options.name),
    options,
    cdpUrl: persistent ? undefined : (getCdpUrl() ?? undefined),
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

  // Auto-screenshot on every navigation (best-effort, non-blocking).
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(session.runsDir, `${ts}-nav.png`);
    page.screenshot({ path, fullPage: false }).catch(() => {});
  });

  sessions.set(options.name, session);
  log.info("session created", { name: options.name, persistent });
  return summarise(session);
}

export async function purgeSession(name: string): Promise<SessionSummary> {
  const session = sessions.get(name);
  if (!session) throw Object.assign(new Error(`session "${name}" not found`), { status: 404 });
  // Clear cookies, storage, and navigate to about:blank. Keeps the session id.
  await session.context.clearCookies().catch(() => {});
  for (const page of session.context.pages()) {
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    }).catch(() => {});
    await page.goto("about:blank").catch(() => {});
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
    cdpUrl: session.cdpUrl,
  };
}

export async function shutdownAllSessions() {
  const names = [...sessions.keys()];
  await Promise.allSettled(names.map((name) => closeSession(name, { keepProfile: true })));
}
