import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Minimal static server for the target UI. No caching, so every reload after an
 * edit shows the current file on disk.
 */
export async function serveStatic(dir, preferredPort = 4173) {
  // Resolve once: a relative `dir` would otherwise make every path fail the
  // containment check below and 403 the whole site.
  const root = path.resolve(dir);

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let filePath = path.resolve(root, `.${path.posix.normalize(urlPath)}`);

      // Never serve outside the target directory.
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      let s = await stat(filePath).catch(() => null);
      if (s?.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        s = await stat(filePath).catch(() => null);
      }
      if (!s) {
        /*
          SPA history fallback. A client-side route like /d/abc123 has no file
          behind it, but the app renders it fine once index.html boots. Without
          this, reloading the page after an edit — which is exactly what a review
          does — lands on a 404 instead of the view being reviewed.

          Only for extensionless paths, so a genuinely missing asset still 404s
          loudly rather than silently returning HTML.
        */
        if (!path.extname(filePath) && existsSync(path.join(root, 'index.html'))) {
          filePath = path.join(root, 'index.html');
          s = await stat(filePath);
        } else {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
      }

      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store, max-age=0',
      });
      createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });

  /*
    Port selection, carefully.

    `server.listen(port, cb)` registers cb as a pending 'listening' listener. If
    that bind fails with EADDRINUSE the callback is NOT discarded — so a later
    successful bind on port+1 fires the stale callback too, and naively resolving
    with the port variable it closed over reports a port nothing is listening on.
    Screenshots then hit ERR_CONNECTION_REFUSED against a server that is actually
    up one port over.

    So: persistent listeners, explicit teardown, and the port comes from
    server.address() — the only source that cannot be stale.
  */
  const port = await new Promise((resolve, reject) => {
    let candidate = preferredPort;
    let attemptsLeft = 20;

    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = () => {
      cleanup();
      resolve(server.address().port);
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        attemptsLeft -= 1;
        candidate += 1;
        server.listen(candidate, '127.0.0.1');
        return;
      }
      cleanup();
      reject(err);
    };

    server.on('error', onError);
    server.on('listening', onListening);
    server.listen(candidate, '127.0.0.1');
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}
