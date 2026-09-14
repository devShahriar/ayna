/*
  One agent, one session, one tab.

  Every `ayna` command is its own process, so the only identity the database had
  was a pid — which names an invocation, not an agent. A Claude session that ran
  twenty commands produced twenty session rows and twenty tabs, none reused, and
  `ayna status` could not answer "which window is mine?" because every command
  had made a new one.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { identify, KNOWN_AGENTS, findAgentProcess } from '../src/agent.mjs';
import { openSessions } from '../src/sessions.mjs';
import { openDb, appendEvent, pruneEvents, checkpoint, writeCursor, transact, migrate, SCHEMA_VERSION } from '../src/db.mjs';
import { since, sinceAll } from '../src/events.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'ayna-agent-'));

describe('knowing who is asking', () => {
  test('a tool that declares itself is believed over everything else', () => {
    const id = identify({ env: { AYNA_AGENT: 'cursor', AYNA_SESSION: 'abc-123', CLAUDE_CODE_SESSION_ID: 'zzz' } });
    assert.equal(id.tool, 'cursor');
    assert.equal(id.agentId, 'abc-123');
    assert.equal(id.how, 'declared');
  });

  test("a known tool's own session variable identifies it", () => {
    const id = identify({ env: { CLAUDE_CODE_SESSION_ID: 'uuid-1' }, probeProcess: false });
    assert.equal(id.tool, 'claude');
    assert.match(id.agentId, /^claude:uuid-1$/);
    assert.equal(id.how, 'env:CLAUDE_CODE_SESSION_ID');
  });

  test('every tool ayna claims to support can actually be identified', () => {
    for (const a of KNOWN_AGENTS) {
      const id = identify({ env: { [a.env[0]]: 'session-x' }, probeProcess: false });
      assert.equal(id.tool, a.tool, `${a.env[0]} should mean ${a.tool}`);
      assert.equal(id.agentId, `${a.tool}:session-x`);
    }
  });

  test('with nothing to go on it still answers, and says it is guessing', () => {
    const id = identify({ env: {}, probeProcess: false, pid: 4242 });
    assert.equal(id.agentId, 'local:pid-4242');
    assert.equal(id.how, 'none');
  });

  test('the process walk never throws, whatever it finds', () => {
    assert.doesNotThrow(() => findAgentProcess(1));
    assert.doesNotThrow(() => findAgentProcess(999_999));
  });
});

describe('one agent keeps one session and one tab', () => {
  const claude = { tool: 'claude', agentId: 'claude:abc', agentPid: process.pid, how: 'env' };
  const cursor = { tool: 'cursor', agentId: 'cursor:zz', agentPid: process.pid, how: 'declared' };

  test('ten commands from one agent do not open ten windows', async () => {
    const s = await openSessions(await tmp());
    const ids = new Set();
    const tabs = new Set();
    for (let i = 0; i < 10; i++) {
      const { id } = s.resume({ agent: claude });
      ids.add(id);
      tabs.add(s.tabFor({ sessionId: id, url: 'http://localhost:3000/' }).id);
    }
    assert.equal(ids.size, 1, 'one agent, one session');
    assert.equal(tabs.size, 1, 'one agent, one tab');
  });

  test('a second agent works alongside without sharing either', async () => {
    const s = await openSessions(await tmp());
    const a = s.resume({ agent: claude });
    const b = s.resume({ agent: cursor });
    assert.notEqual(a.id, b.id);

    const ta = s.tabFor({ sessionId: a.id, url: 'http://localhost:3000/' });
    const tb = s.tabFor({ sessionId: b.id, url: 'http://localhost:3000/' });
    assert.notEqual(ta.id, tb.id, 'the same URL must not mean the same window');
    assert.equal(s.live().length, 2);
    assert.equal(s.tabs().length, 2);
  });

  test("a dead agent's window is not adopted by its successor", async () => {
    const s = await openSessions(await tmp());
    // A pid that is not running: reuse here would hand new work to a closed window.
    const ghost = { tool: 'codex', agentId: 'codex:x', agentPid: 999_999, how: 'env' };
    s.resume({ agent: ghost });
    assert.equal(s.resume({ agent: ghost }).created, true, 'must start a fresh session');
  });

  test('the sweep judges the agent, not the ayna process that wrote the row', async () => {
    const s = await openSessions(await tmp());
    // agent_pid is this test, which is alive; pid is whatever wrote the row.
    const { id } = s.resume({ agent: claude });
    s.tabFor({ sessionId: id, url: 'http://x/' });

    s.sweep();
    assert.equal(s.live().length, 1, 'a live agent must survive a sweep');
    assert.equal(s.tabs().length, 1, 'and keep its tab');
  });

  test('when the agent does die, its tab is freed rather than closed', async () => {
    const s = await openSessions(await tmp());
    const ghost = { tool: 'claude', agentId: 'claude:gone', agentPid: 999_999, how: 'env' };
    const { id } = s.resume({ agent: ghost });
    s.tabFor({ sessionId: id, url: 'http://x/' });

    const swept = s.sweep();
    assert.equal(swept.sessions, 1);
    assert.equal(swept.tabs, 1, 'the work in it is still owed');
    assert.equal(s.tabs().length, 1, 'the tab stays, unowned, for whoever comes next');
    assert.equal(s.tabs()[0].owner, null);
  });
});

describe('the log stays readable and stops growing', () => {
  test('a capped catch-up says it was capped', async () => {
    const dir = await tmp();
    const db = await openDb(dir);
    for (let i = 0; i < 1200; i++) appendEvent(db, { event: 'edits', n: i });

    const page = await since(dir, { since: 0, limit: 500, db });
    assert.equal(page.events.length, 500);
    assert.equal(page.more, true, 'silently returning 500 of 1200 is the bug');
    assert.equal(page.remaining, 700);

    const all = await sinceAll(dir, { since: 0, db });
    assert.equal(all.events.length, 1200);
    assert.equal(all.more, false);
  });

  test('pruning never removes what a consumer has not read', async () => {
    const dir = await tmp();
    const db = await openDb(dir);
    for (let i = 0; i < 500; i++) appendEvent(db, { event: 'edits', n: i });
    writeCursor(db, 'slow', 100);

    // olderThanMs -1 makes every event old enough; only the cursor should hold.
    const { removed, floor } = pruneEvents(db, { olderThanMs: -1, keepMin: 10, now: Date.now() });
    assert.equal(floor, 100, 'the floor is the slowest consumer');
    assert.equal(removed, 99);
    assert.equal(db.prepare('SELECT MIN(seq) AS s FROM events').get().s, 100);
  });

  test('with no consumers a tail is still kept', async () => {
    const dir = await tmp();
    const db = await openDb(dir);
    for (let i = 0; i < 300; i++) appendEvent(db, { event: 'edits', n: i });

    pruneEvents(db, { olderThanMs: -1, keepMin: 50, now: Date.now() });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, 50);
  });

  test('a checkpoint gives the WAL space back', async () => {
    const dir = await tmp();
    const db = await openDb(dir);
    for (let i = 0; i < 2000; i++) appendEvent(db, { event: 'edits', n: i });
    assert.equal(checkpoint(db), true);
  });
});

describe('the schema can move', () => {
  test('a fresh database lands on the current version', async () => {
    const db = await openDb(await tmp());
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    assert.ok(cols.includes('agent_id') && cols.includes('agent_pid'));
  });

  test('migrating twice changes nothing the second time', async () => {
    const db = await openDb(await tmp());
    assert.deepEqual(migrate(db), [], 'already current');
  });

  /*
    The real failure this caught: the base schema created an index on agent_id,
    but on an existing database CREATE TABLE IF NOT EXISTS is a no-op — so the
    index ran against a table that had no such column yet and openDb threw
    before the migration that would have added it.
  */
  test('a database from before the agent columns is upgraded, not broken', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'v1.db');

    // Build a version-1 database by hand: the old sessions table, no agent columns.
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, tool TEXT NOT NULL, pid INTEGER,
      project TEXT, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
      ended_at INTEGER, status TEXT NOT NULL DEFAULT 'live')`);
    old.exec("INSERT INTO sessions VALUES ('s1','claude',1,'/p',1,1,NULL,'live')");
    old.exec('PRAGMA user_version = 1');
    old.close();

    const db = await openDb(null, { file });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    assert.ok(cols.includes('agent_id'), 'the column is added');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'the row survives');
  });

  test('a database from a newer ayna is left alone, not rewritten', async () => {
    const dir = await tmp();
    const db = await openDb(dir);
    db.exec('PRAGMA user_version = 99');
    assert.deepEqual(migrate(db), []);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  });
});

describe('transactions compose', () => {
  test('a transaction inside a transaction works', async () => {
    const db = await openDb(await tmp());
    assert.doesNotThrow(() =>
      transact(db, () => {
        appendEvent(db, { event: 'outer' });
        transact(db, () => appendEvent(db, { event: 'inner' }));
      }),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, 2);
  });

  test('the outer one still rolls the inner one back', async () => {
    const db = await openDb(await tmp());
    assert.throws(() =>
      transact(db, () => {
        appendEvent(db, { event: 'outer' });
        transact(db, () => appendEvent(db, { event: 'inner' }));
        throw new Error('no');
      }),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, 0, 'all or nothing');
  });

  test('an inner failure can be caught without losing the outer work', async () => {
    const db = await openDb(await tmp());
    transact(db, () => {
      appendEvent(db, { event: 'kept' });
      try {
        transact(db, () => {
          appendEvent(db, { event: 'dropped' });
          throw new Error('inner');
        });
      } catch {
        // handled: the savepoint unwound, the outer transaction continues
      }
      appendEvent(db, { event: 'also-kept' });
    });
    const events = db.prepare('SELECT event FROM events ORDER BY seq').all().map((r) => r.event);
    assert.deepEqual(events, ['kept', 'also-kept']);
  });
});

/*
  An editor and its headless CLI, one letter apart.

  ayna judged puku by the first binary on the PATH — `puku`, a 23-line wrapper
  that opens the editor — and recorded that it had no headless mode. It has one:
  `puku-cli`, which takes -p, --output-format json and --permission-mode, because
  it is Claude Code shaped throughout (PUKU_CLI_SESSION_ID, PUKU_CLI_PLUGIN_ROOT,
  .puku-plugin, PUKU.md). The mistake would have quietly excluded a working agent
  from `ayna work`, and `cursor` / `cursor-agent` is the same trap.
*/
describe('telling an editor from the CLI beside it', () => {
  test('the brain is the binary that does the work, not the one named after the product', async () => {
    const { BRAINS, EDITORS } = await import('../src/brains.mjs');
    for (const [name, expected] of [['puku', 'puku-cli'], ['cursor', 'cursor-agent']]) {
      assert.equal(BRAINS[name].cmd, expected, `${name} must be driven through ${expected}`);
      assert.equal(BRAINS[name].detect, expected, 'and detected by it too, or it reads as missing');
    }
    assert.ok(!EDITORS.puku, 'puku has a headless CLI — it is not an editor-only entry');
  });

  test('puku is identified by its own session variable', async () => {
    const id = identify({ env: { PUKU_CLI_SESSION_ID: 'uuid-9' }, probeProcess: false });
    assert.equal(id.tool, 'puku');
    assert.equal(id.agentId, 'puku:uuid-9');
    assert.equal(id.how, 'env:PUKU_CLI_SESSION_ID');
  });

  test('every brain resolves to a command, and a real editor still explains itself', async () => {
    const { resolveBrain, BRAINS } = await import('../src/brains.mjs');
    for (const name of Object.keys(BRAINS)) {
      assert.ok(resolveBrain({}, name).cmd, `${name} must resolve`);
    }
    assert.throws(() => resolveBrain({}, 'antigravity'), /is an editor, not a headless brain/);
    assert.throws(() => resolveBrain({}, 'nonesuch'), /no brain called "nonesuch"/);
  });
});
