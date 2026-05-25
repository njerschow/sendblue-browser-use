import { Hono } from "hono";
import { env } from "./env";
import { requireAuth } from "./auth";
import { sessionsRoutes } from "./routes/sessions";
import { listSessions, startIdleEviction, shutdownAllSessions } from "./sessions";
import { getCdpUrl, shutdownBrowser } from "./browser";
import { log } from "./lib/logger";

export function createApp() {
  const app = new Hono();

  app.use("*", requireAuth);

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "sendblue-browser-use",
      version: "0.1.0",
      sessions: listSessions().length,
      cdpUrl: getCdpUrl(),
    });
  });

  app.route("/sessions", sessionsRoutes);

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));
  app.onError((err, c) => {
    log.error("request_failed", { err: err.message, path: c.req.path });
    return c.json({ error: err.message || "internal_error" }, 500);
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

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await shutdownAllSessions();
    await shutdownBrowser();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return server;
}
