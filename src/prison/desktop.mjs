import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';

/**
 * Built-in Desktop Interface Server and Embeddable SDK for Prison Sandboxes.
 * Provides web-based terminal, file explorer, status monitoring, and iframe
 * embedding capabilities for external AI agent platforms.
 */
export class PrisonDesktop {
  /**
   * @param {Object} options
   * @param {import('./runtime.mjs').PrisonSandbox} options.sandbox - Target sandbox
   * @param {number} [options.port=0] - Preferred port (0 for random assigned port)
   * @param {string} [options.authToken] - Token for authenticating UI sessions
   */
  constructor({ sandbox, port = 0, authToken = null }) {
    if (!sandbox) {
      throw new Error('Sandbox instance is required for PrisonDesktop');
    }
    this.sandbox = sandbox;
    this.port = port;
    this.authToken = authToken;
    this.server = null;
    this.actualPort = null;
  }

  /**
   * Starts the desktop web server.
   *
   * @returns {Promise<{ url: string, port: number }>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this._handleRequest(req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve({
          url: `http://127.0.0.1:${this.actualPort}`,
          port: this.actualPort,
        });
      });
    });
  }

  /**
   * Stops the desktop web server.
   */
  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Checks authorization header or query token.
   */
  _isAuthorized(req, parsedUrl) {
    if (!this.authToken) return true;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.replace(/^Bearer\s+/i, '') === this.authToken) {
      return true;
    }
    if (parsedUrl.searchParams.get('token') === this.authToken) {
      return true;
    }
    return false;
  }

  /**
   * Request router.
   */
  async _handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // CORS & embed headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 1. Static UI routes
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this._renderDesktopHtml({ embedded: false }));
    }

    if (pathname === '/embed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this._renderDesktopHtml({ embedded: true }));
    }

    // Check token for API routes
    if (!this._isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid token' }));
    }

    // 2. API Routes
    if (pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(this.sandbox.status()));
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      const relPath = parsedUrl.searchParams.get('path') || '';
      try {
        const files = await this.sandbox.listFiles(relPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ files }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const relPath = parsedUrl.searchParams.get('path');
      if (!relPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing path query parameter' }));
      }
      try {
        const content = await this.sandbox.readFile(relPath);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(content);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (pathname === '/api/file' && req.method === 'POST') {
      const body = await this._readBodyJson(req);
      if (!body.path || body.content === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Body must include "path" and "content"' }));
      }
      try {
        await this.sandbox.writeFile(body.path, body.content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, path: body.path }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (pathname === '/api/exec' && req.method === 'POST') {
      const body = await this._readBodyJson(req);
      if (!body.command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing command in request body' }));
      }
      try {
        const result = await this.sandbox.exec(body.command, {
          cwd: body.cwd || '',
          timeoutMs: body.timeoutMs,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /**
   * Helper to parse JSON body from request stream.
   */
  async _readBodyJson(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Generates the desktop HTML page.
   */
  _renderDesktopHtml({ embedded = false }) {
    const sandboxId = this.sandbox.id;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prison Desktop – ${sandboxId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: #1e293b; padding: 12px 18px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; }
    .badge { background: #38bdf8; color: #0f172a; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; }
    .main { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 240px; background: #1e293b; border-right: 1px solid #334155; padding: 12px; overflow-y: auto; }
    .sidebar h4 { font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px; }
    .file-item { padding: 4px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; color: #cbd5e1; display: flex; align-items: center; gap: 6px; }
    .file-item:hover { background: #334155; color: #fff; }
    .content { flex: 1; display: flex; flex-direction: column; background: #020617; }
    .terminal-out { flex: 1; padding: 16px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; color: #38bdf8; overflow-y: auto; white-space: pre-wrap; }
    .command-bar { display: flex; background: #1e293b; border-top: 1px solid #334155; padding: 8px 12px; gap: 8px; }
    .command-bar input { flex: 1; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 8px 12px; border-radius: 4px; font-family: inherit; font-size: 14px; }
    .command-bar button { background: #2563eb; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; }
    .command-bar button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <header>
    <div><span class="status-dot"></span><strong>Prison Sandbox Desktop</strong> (${sandboxId})</div>
    <span class="badge">Isolated Runtime</span>
  </header>
  <div class="main">
    <div class="sidebar">
      <h4>Workspace Files</h4>
      <div id="fileTree">Loading files...</div>
    </div>
    <div class="content">
      <div id="terminal" class="terminal-out">Prison Agent Shell Initialized.\nReady to execute commands in isolated workspace...\n$ </div>
      <form class="command-bar" id="cmdForm">
        <input type="text" id="cmdInput" placeholder="Enter shell command (e.g. ls -la, pwd, echo hello)..." autocomplete="off" />
        <button type="submit">Run</button>
      </form>
    </div>
  </div>
  <script>
    const term = document.getElementById('terminal');
    const input = document.getElementById('cmdInput');
    const form = document.getElementById('cmdForm');
    const fileTree = document.getElementById('fileTree');

    async function loadFiles() {
      try {
        const res = await fetch('/api/files');
        const data = await res.json();
        if (data.files && data.files.length) {
          fileTree.innerHTML = data.files.map(f => '<div class="file-item">' + (f.isDirectory ? '📁 ' : '📄 ') + f.name + '</div>').join('');
        } else {
          fileTree.innerHTML = '<div style="color: #64748b; font-size: 12px;">Workspace empty</div>';
        }
      } catch (e) {
        fileTree.innerHTML = '<div style="color: #ef4444; font-size: 12px;">Failed to load files</div>';
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = '';
      term.textContent += cmd + '\\n';
      try {
        const res = await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const out = await res.json();
        if (out.stdout) term.textContent += out.stdout;
        if (out.stderr) term.textContent += '[stderr] ' + out.stderr;
        term.textContent += '\\n$ ';
        term.scrollTop = term.scrollHeight;
        loadFiles();
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'prison:exec_completed', sandboxId: '${sandboxId}', result: out }, '*');
        }
      } catch (err) {
        term.textContent += '[error] ' + err.message + '\\n$ ';
      }
    });

    loadFiles();

    // Listen for postMessage from external embedding platforms
    window.addEventListener('message', async (event) => {
      if (!event.data || !event.data.type) return;
      if (event.data.type === 'prison:exec') {
        const cmd = event.data.command;
        const res = await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const out = await res.json();
        event.source.postMessage({ type: 'prison:exec_result', id: event.data.id, result: out }, '*');
      }
    });
  </script>
</body>
</html>`;
  }
}

/**
 * Client SDK helper for embedding Prison Desktop in external AI platforms.
 */
export class PrisonDesktopSDK {
  /**
   * Generates embeddable iframe HTML snippet.
   */
  static createEmbedSnippet({ sandboxId, serverUrl, token = '', width = '100%', height = '600px' }) {
    const src = `${serverUrl}/embed?token=${encodeURIComponent(token)}`;
    return `<iframe src="${src}" width="${width}" height="${height}" frameborder="0" allow="clipboard-read; clipboard-write" style="border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"></iframe>`;
  }
}
