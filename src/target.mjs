import { spawn } from 'node:child_process';

import { serveStatic } from './server.mjs';

/**
 * Boots whatever serves the UI: the built-in static server, or the user's dev command.
 *
 * The returned handle exposes `ensureUp()`. A run spans many minutes, and if the
 * thing serving the page dies partway through, every later screenshot is a Chrome
 * error page — which the loop would otherwise misread as the UI having broken.
 */
export async function startTarget(cfg) {
  if (cfg.target.url && !cfg.target.startCommand) {
    return { url: cfg.target.url, close: async () => {}, ensureUp: async () => true };
  }

  if (cfg.target.startCommand) {
    const child = spawn(cfg.target.startCommand, {
      cwd: cfg.rootDir,
      shell: true,
      stdio: 'ignore',
      detached: false,
    });
    const url = cfg.target.url ?? `http://127.0.0.1:${cfg.target.port}/`;
    await waitForUrl(url, 60_000);
    return {
      url,
      close: async () => {
        child.kill('SIGTERM');
      },
      // We did not start this server's process tree, so we can only report.
      ensureUp: () => isUp(url),
    };
  }

  const server = await serveStatic(cfg.targetDir, cfg.target.port);
  const handle = {
    url: server.url,
    close: () => server.close(),
    async ensureUp() {
      if (await isUp(handle.url)) return true;
      const fresh = await serveStatic(cfg.targetDir, cfg.target.port);
      handle.url = fresh.url;
      handle.close = () => fresh.close();
      return isUp(handle.url);
    },
  };
  return handle;
}

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never came up at ${url}`);
}
