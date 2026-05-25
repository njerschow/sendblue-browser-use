import type { BrowserContext, Page } from "patchright";

export type SessionOptions = {
  name: string;
  persistent?: boolean;
  headless?: boolean | "new";
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  traces?: boolean;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    bypass?: string;
  };
};

export type ConsoleMessage = {
  t: string;
  type: string;
  text: string;
  url?: string;
};

export type Session = {
  name: string;
  persistent: boolean;
  headless: boolean;
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastUsedAt: string;
  consoleBuffer: ConsoleMessage[];
  navScreenshotPaths: string[];
  autoNavScreenshots: boolean;
  runsDir: string;
  options: SessionOptions;
  cdpUrl?: string;
  cdpTargetId?: string;
};

export type SessionSummary = {
  name: string;
  persistent: boolean;
  headless: boolean;
  createdAt: string;
  lastUsedAt: string;
  pageUrl: string | null;
  pageTitle: string | null;
  consoleMessages: number;
  autoNavScreenshots: boolean;
  cdpUrl?: string;
  cdpTargetId?: string;
};
