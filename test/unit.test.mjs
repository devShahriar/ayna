import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, DEFAULT_CONFIG } from '../src/config.mjs';
import { snapshot, restore, changedFiles } from '../src/snapshot.mjs';
import { serveStatic } from '../src/server.mjs';
import { writeReport } from '../src/report.mjs';
import { scanInJs } from '../src/annotate.mjs';
import { tempDir, fixtureSite } from './helpers.mjs';

describe('config', () => {
  test('falls back to defaults when no config file exists', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const cfg = await loadConfig(dir);
      assert.equal(cfg.loop.iterations, DEFAULT_CONFIG.loop.iterations);
      assert.equal(cfg.target.root, DEFAULT_CONFIG.target.root);
      assert.equal(cfg.rootDir, dir);
    } finally {
      await dispose();
    }
  });

  test('merges a partial user config without dropping sibling defaults', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { root: 'app' }, loop: { iterations: 7 } }),
      );
      const cfg = await loadConfig(dir);
      assert.equal(cfg.target.root, 'app', 'user value wins');
      assert.equal(cfg.target.port, DEFAULT_CONFIG.target.port, 'sibling default survives');
      assert.equal(cfg.loop.iterations, 7);
      assert.equal(cfg.loop.verify, DEFAULT_CONFIG.loop.verify, 'nested sibling default survives');
    } finally {
      await dispose();
    }
  });

  test('arrays are replaced wholesale, not merged element-wise', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ viewports: [{ name: 'only', width: 800, height: 600 }] }),
      );
      const cfg = await loadConfig(dir);
      assert.equal(cfg.viewports.length, 1);
      assert.equal(cfg.viewports[0].name, 'only');
    } finally {
      await dispose();
    }
  });

  test('malformed JSON does not crash the loader', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await writeFile(path.join(dir, 'ayna.config.json'), '{ not json');
      const cfg = await loadConfig(dir);
      assert.equal(cfg.target.root, DEFAULT_CONFIG.target.root);
    } finally {
      await dispose();
    }
  });
});

describe('snapshot / restore', () => {
  test('restore undoes edits, additions and deletions', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const target = path.join(dir, 'ui');
      await fixtureSite(target);
      const snap = path.join(dir, 'snap');
      await snapshot(target, snap);

      await writeFile(path.join(target, 'styles.css'), 'body{background:red}');
      await writeFile(path.join(target, 'extra.css'), '/* new */');

      await restore(snap, target);

      const css = await readFile(path.join(target, 'styles.css'), 'utf8');
      assert.match(css, /system-ui/, 'edited file is back to original');
      await assert.rejects(
        () => readFile(path.join(target, 'extra.css'), 'utf8'),
        'file added after the snapshot is gone',
      );
    } finally {
      await dispose();
    }
  });

  test('changedFiles reports modified, added and deleted', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const target = path.join(dir, 'ui');
      await fixtureSite(target);
      const snap = path.join(dir, 'snap');
      await snapshot(target, snap);

      await writeFile(path.join(target, 'styles.css'), 'body{background:red}');
      await writeFile(path.join(target, 'added.css'), 'x');
      const { rm } = await import('node:fs/promises');
      await rm(path.join(target, 'index.html'));

      const changes = await changedFiles(snap, target);
      const byFile = Object.fromEntries(changes.map((c) => [c.file, c.kind]));
      assert.equal(byFile['styles.css'], 'modified');
      assert.equal(byFile['added.css'], 'added');
      assert.equal(byFile['index.html'], 'deleted');
    } finally {
      await dispose();
    }
  });

  test('an untouched tree reports no changes', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const target = path.join(dir, 'ui');
      await fixtureSite(target);
      const snap = path.join(dir, 'snap');
      await snapshot(target, snap);
      assert.deepEqual(await changedFiles(snap, target), []);
    } finally {
      await dispose();
    }
  });
});

describe('static server', () => {
  test('serves index.html for the directory root', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const server = await serveStatic(dir, 4400);
      try {
        const res = await fetch(server.url);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(await res.text(), /A headline that is long enough/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('sends no-store so edits are never served stale', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const server = await serveStatic(dir, 4401);
      try {
        const res = await fetch(new URL('/styles.css', server.url));
        assert.match(res.headers.get('cache-control'), /no-store/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('404s a missing file', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const server = await serveStatic(dir, 4402);
      try {
        assert.equal((await fetch(new URL('/nope.css', server.url))).status, 404);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('refuses to serve outside the target directory', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      await writeFile(path.join(dir, 'secret.txt'), 'do not serve me');
      const server = await serveStatic(site, 4403);
      try {
        const res = await fetch(new URL('/..%2Fsecret.txt', server.url));
        assert.notEqual(res.status, 200, 'traversal must not succeed');
        assert.doesNotMatch(await res.text(), /do not serve me/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('serves index.html for a client-side route so a review reload works', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const server = await serveStatic(dir, 4405);
      try {
        const res = await fetch(new URL('/d/d-835f8b1a49a73b39', server.url));
        assert.equal(res.status, 200, 'SPA deep route falls back to the shell');
        assert.match(await res.text(), /A headline that is long enough/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a missing asset still 404s loudly rather than returning HTML', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const server = await serveStatic(dir, 4406);
      try {
        for (const missing of ['/app.js', '/logo.png', '/styles/main.css']) {
          assert.equal((await fetch(new URL(missing, server.url))).status, 404, missing);
        }
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('falls forward to a free port when the preferred one is taken', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      const first = await serveStatic(dir, 4404);
      const second = await serveStatic(dir, 4404);
      try {
        assert.notEqual(first.url, second.url);
        assert.equal((await fetch(second.url)).status, 200);
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('report', () => {
  const cfg = { target: { name: 'test' } };

  test('renders before/after for a normal iteration', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const iterations = [
        {
          n: 1,
          before: { shots: [{ viewport: 'desktop', file: path.join(dir, 'b.png') }] },
          after: { shots: [{ viewport: 'desktop', file: path.join(dir, 'a.png') }] },
          critique: { score: 6, verdict: 'ok', issues: [{ id: '1', severity: 'major', area: 'color', problem: 'p', fix: 'f' }] },
          changes: [{ file: 'styles.css', kind: 'modified' }],
        },
      ];
      const file = await writeReport({ cfg, runId: 'r', runDir: dir, iterations, stopReason: 'done', totalCost: 0 });
      const html = await readFile(file, 'utf8');
      assert.match(html, /b\.png/);
      assert.match(html, /a\.png/);
      assert.match(html, /styles\.css/);
    } finally {
      await dispose();
    }
  });

  test('an iteration that threw still renders instead of crashing the report', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const iterations = [{ n: 1, error: 'browser closed unexpectedly' }];
      const file = await writeReport({ cfg, runId: 'r', runDir: dir, iterations, stopReason: 'failed', totalCost: 0 });
      const html = await readFile(file, 'utf8');
      assert.match(html, /failed/);
      assert.match(html, /browser closed unexpectedly/);
    } finally {
      await dispose();
    }
  });

  test('escapes HTML in model-authored text', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const iterations = [{ n: 1, error: '<script>alert(1)</script>' }];
      const file = await writeReport({ cfg, runId: 'r', runDir: dir, iterations, stopReason: 'x', totalCost: 0 });
      const html = await readFile(file, 'utf8');
      assert.doesNotMatch(html, /<script>alert/);
      assert.match(html, /&lt;script&gt;/);
    } finally {
      await dispose();
    }
  });
});

describe('portable source scan (used where grep is unavailable, e.g. Windows)', () => {
  test('finds the needle with file:line:preview, like grep -rn', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'page.html'), 'line one\n<h1 class="hero-title">Hi</h1>\nline three\n');
      const out = await scanInJs(dir, 'hero-title');
      assert.equal(out.length, 1);
      const [file, line, ...rest] = out[0].split(':');
      assert.match(file, /page\.html$/);
      assert.equal(line, '2', 'reports the correct 1-based line number');
      assert.match(rest.join(':'), /hero-title/);
    } finally {
      await dispose();
    }
  });

  test('skips node_modules and binary-ish files', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(path.join(dir, 'app'), { recursive: true });
      await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'const needle_x = 1;');
      await writeFile(path.join(dir, 'app', 'logo.png'), 'needle_x binary');
      await writeFile(path.join(dir, 'app', 'real.css'), '.needle_x { color: red }');
      const out = await scanInJs(dir, 'needle_x');
      assert.equal(out.length, 1, 'only the real source file');
      assert.match(out[0], /real\.css/);
    } finally {
      await dispose();
    }
  });

  test('returns nothing rather than throwing when there is no match', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await fixtureSite(dir);
      assert.deepEqual(await scanInJs(dir, 'definitely-not-present-anywhere'), []);
    } finally {
      await dispose();
    }
  });
});
