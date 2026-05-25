import { z } from "zod";
import { homedir } from "node:os";
import { resolve } from "node:path";

const Schema = z.object({
  BROWSER_USE_API_KEY: z.string().min(8, "Set BROWSER_USE_API_KEY in .env (openssl rand -hex 32)"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  BIND: z.string().default("127.0.0.1"),
  CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  DATA_DIR: z.string().default(`${homedir()}/.sendblue-browser-use`),
  DEFAULT_HEADLESS: z.enum(["true", "false", "new"]).default("false"),
  IDLE_SESSION_MINUTES: z.coerce.number().int().min(0).default(120),
  MAX_CONSOLE_BUFFER: z.coerce.number().int().min(10).default(500),
  CHROMIUM_ARGS: z.string().default(""),
});

const parsed = Schema.parse(process.env);

export const env = {
  ...parsed,
  dataDir: parsed.DATA_DIR.startsWith("~/") ? resolve(homedir(), parsed.DATA_DIR.slice(2)) : resolve(parsed.DATA_DIR),
  chromiumArgs: parsed.CHROMIUM_ARGS ? parsed.CHROMIUM_ARGS.split(",").map((a) => a.trim()).filter(Boolean) : [],
  defaultHeadless: parsed.DEFAULT_HEADLESS === "true" ? true : parsed.DEFAULT_HEADLESS === "false" ? false : ("new" as const),
} as const;
