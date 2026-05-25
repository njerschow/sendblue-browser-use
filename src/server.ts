import { Hono } from "hono";
import { env } from "./env";
import { requireAuth } from "./auth";
import { sessionsRoutes } from "./routes/sessions";
import { listSessions, startIdleEviction, stopIdleEviction, shutdownAllSessions } from "./sessions";
import { shutdownBrowser } from "./browser";
import { log } from "./lib/logger";

export function createApp() {
  const app = new Hono();

  // /health is public so container/k8s probes work without a token.
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "sendblue-browser-use",
      version: "0.2.0",
      sessions: listSessions().length,
      defaultHeadless: env.defaultHeadless === "new" ? true : env.defaultHeadless,
      navScreenshotPolicy: env.navScreenshotPolicy,
    });
  });

  app.use("*", requireAuth);
  app.route("/sessions", sessionsRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route ${c.req.method} ${c.req.path}` } }, 404));
  app.onError((err, c) => {
    log.error("request_failed", { err: err.message, path: c.req.path });
    return c.json({ error: { code: "internal_error", message: "request failed" } }, 500);
  });

  return app;
}

export async function startServer() {
  startIdleEviction();
  const app = createApp();
  const server = Bun.serve({
    port: env.PORT,
    hostname: env.BIND,
    fetch: app.fetch,
  });
  log.info("server listening", { url: `http://${server.hostname}:${server.port}`, dataDir: env.dataDir });

  // Keep the daemon observable for transient Chromium callbacks; supervisors can still restart on fatal exits.
  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", { err: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", { reason: String(reason) });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    // Hard cap shutdown — if Chromium hangs, Docker will SIGKILL us at 10s anyway.
    const timer = setTimeout(() => {
      log.warn("shutdown_timeout, forcing exit");
      process.exit(1);
    }, 8000);
    try {
      stopIdleEviction();
      await shutdownAllSessions();
      await shutdownBrowser();
      server.stop(true);
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return server;
}
