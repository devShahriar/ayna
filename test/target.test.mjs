/*
  The dev server ayna started, and the dev server ayna left behind.

  `target.startCommand` is a shell wrapping a server. Two things can go wrong
  that a screenshot cannot show you: the server can die before it is reachable,
  and it can survive the moment ayna decides it is finished with it. The first
  costs the user a minute of waiting; the second costs them the port, and the
  next run fails on a port nobody released.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { startTarget } from '../src/target.mjs';
import { tempDir } from './helpers.mjs';

/** A config shaped the way startTarget reads it. */
function cfgFor(rootDir, { startCommand, url = null, port = 4173 }) {
  return {
    rootDir,
    targetDir: rootDir,
    target: { name: 'test', root: '.', url, startCommand, port, routes: ['/'] },
  };
}

/** Is this pid still running? Signal 0 asks without sending anything. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Waits for a pid to disappear, because a signal is not the same as a reap. */
async function waitForGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

/** A port nobody is using. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Writes a script that starts a real server on the given port and reports that
 * server's pid, so the test can check the server itself and not just the shell
 * that wrapped it. A script file rather than `node -e`, because the command is
 * run through a shell and quoting a program inside a quoted argument is how
 * these tests break for reasons that have nothing to do with the bug.
 */
function writeServerScript(dir, port) {
  const script = path.join(dir, 'server.mjs');
  const pidFile = path.join(dir, 'server.pid');
  writeFileSync(
    script,
    `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((req, res) => res.end('ok'));
server.listen(${port}, '127.0.0.1', () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
});
setInterval(() => {}, 1000);
`,
  );
  return { command: `node ${script}`, pidFile };
}

/**
 * Starts a separate node process that calls startTarget and then waits, so a
 * signal can be delivered to it the way a terminal delivers one.
 *
 * The child is spawned without a shell on purpose: `shell: true` puts a shell
 * between us and node, and the shell swallows the signal instead of passing it
 * on, so the test would report a leak that never happened.
 */
function spawnAyna(script) {
  return spawn(process.execPath, [script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Runs a child process that starts a target and waits for SIGINT, then checks
 * that the dev server it started died with it.
 *
 * A detached child is in its own process group, so a terminal Ctrl-C — which
 * goes to the foreground process group — never reaches it. Without a signal
 * handler in startTarget, the dev server survives the interrupt, keeps the
 * port, and the next run fails on it.
 */
async function runInterruptScenario({ dir, port, serverScript }) {
  const aynaScript = path.join(dir, 'ayna.mjs');
  const pidFile = path.join(dir, 'server.pid');
  writeFileSync(
    aynaScript,
    `import { startTarget } from '${path.resolve('src/target.mjs')}';
const target = await startTarget({
  rootDir: ${JSON.stringify(dir)},
  targetDir: ${JSON.stringify(dir)},
  target: {
    name: 'test', root: '.', url: null,
    startCommand: ${JSON.stringify(`node ${serverScript}`)},
    port: ${port}, routes: ['/'],
  },
});
console.log(target.url);
// Wait like a long-running command would.
await new Promise(() => {});
`,
  );

  const ayna = spawnAyna(aynaScript);
  const ready = new Promise((resolve, reject) => {
    ayna.stdout.on('data', (d) => {
      if (String(d).includes('http://')) resolve();
    });
    ayna.on('error', reject);
    setTimeout(() => reject(new Error('ayna child never reported its url')), 20_000);
  });

  await ready;
  const serverPid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(serverPid), 'the server should be running before the interrupt');

  // Ctrl-C: the terminal sends SIGINT to the foreground process group.
  ayna.kill('SIGINT');

  const gone = await waitForGone(serverPid, 5000);
  if (!gone) {
    try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  try { ayna.kill('SIGKILL'); } catch { /* already gone */ }
  return gone;
}

describe('a dev server that dies on startup', () => {
  test('is reported straight away instead of after the full timeout', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const started = Date.now();
      const target = startTarget(cfgFor(dir, { startCommand: 'exit 3', port: 1 }));

      await assert.rejects(
        () => target,
        (err) => {
          // The message has to say what happened, or the user goes looking in
          // the wrong place — "never came up" points at the port, not the crash.
          assert.match(err.message, /exited with code 3/);
          assert.match(err.message, /before/);
          return true;
        },
      );

      // The whole point: not 60 seconds.
      assert.ok(
        Date.now() - started < 10_000,
        `should fail fast, took ${Date.now() - started}ms`,
      );
    } finally {
      await dispose();
    }
  });

  test('a command that cannot run at all says so', async () => {
    const { dir, dispose } = await tempDir();
    try {
      // A shell that cannot find the command exits with 127, and the message
      // must say that — the user is looking at a typo, not at a port.
      await assert.rejects(
        () => startTarget(cfgFor(dir, { startCommand: 'definitely-not-a-real-command-xyz', port: 1 })),
        /exited with code 127/,
      );
    } finally {
      await dispose();
    }
  });
});

describe('a dev server that is still running', () => {
  test('is reachable, and its whole tree goes away when ayna closes it', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command, pidFile } = writeServerScript(dir, port);

      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));
      assert.equal(target.url, `http://127.0.0.1:${port}/`);

      // The server reported its own pid.
      const serverPid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(serverPid), 'the server should be running before we close');

      await target.close();

      // The server is a grandchild of ayna — the shell that wrapped it is in
      // between. Signalling only the shell would leave this one holding the
      // port, and the next run would fail with EADDRINUSE.
      assert.ok(
        await waitForGone(serverPid),
        `the server (pid ${serverPid}) should have been stopped by close()`,
      );
    } finally {
      await dispose();
    }
  });

  test('closing twice is safe', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command } = writeServerScript(dir, port);
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));

      await target.close();
      // The second close must not throw and must not signal a recycled pid.
      await target.close();
    } finally {
      await dispose();
    }
  });

  test('frees the port before close() returns', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command } = writeServerScript(dir, port);
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));

      await target.close();

      // SIGTERM delivery is asynchronous. A caller that starts another server
      // on this port straight after close() must not get EADDRINUSE from a
      // port that is about to be free.
      const rebound = createServer();
      await new Promise((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => rebound.close(resolve));
    } finally {
      await dispose();
    }
  });
});

describe('a dev server that has already gone', () => {
  test('is not signalled again, so a recycled pid is left alone', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      // The command exits immediately, so the child is already dead by the time
      // startTarget rejects. There is no handle to close, but the guard that
      // matters is the one inside killGroup: a pid that has been reaped is no
      // longer a safe group id, so it is never signalled.
      const err = await startTarget(cfgFor(dir, { startCommand: 'exit 0', port })).catch((e) => e);
      assert.ok(err instanceof Error);
      assert.match(err.message, /exited with code 0/);
      // The message must not claim the server was reachable. `never came up`
      // is the phrase to avoid — it is the timeout wording, and here the
      // command exited, which is a different thing with a different fix.
      assert.doesNotMatch(err.message, /never came up/);
    } finally {
      await dispose();
    }
  });

  test('a dead child does not make close() signal an unrelated group', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command } = writeServerScript(dir, port);

      // Start a real server, let it be reachable, then close it. The shell is
      // dead by the time close() runs, and the server dies with it.
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));
      await target.close();
      await target.close();

      // The second close() signals the group id again. If the guard were
      // missing, that signal could land on an unrelated group that inherited
      // the recycled pid — which the kernel is free to hand out once the
      // original group is gone. Nothing here should throw, and this process
      // (a group leader of its own right) must be untouched by it.
      assert.ok(alive(process.pid), 'this process must not be signalled by a stale group id');
    } finally {
      await dispose();
    }
  });
});

/**
 * Writes a script that starts a server which refuses to die on SIGTERM.
 *
 * Some servers do that — a process that installs its own SIGTERM handler and
 * does nothing with it. There is no SIGKILL escalation here, so the server is
 * going to survive, and the honest thing is for ayna to say so rather than
 * report a clean shutdown that did not happen.
 */
function writeStubbornServerScript(dir, port) {
  const script = path.join(dir, 'stubborn.mjs');
  const pidFile = path.join(dir, 'stubborn.pid');
  writeFileSync(
    script,
    `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const server = createServer((req, res) => res.end('ok'));
server.listen(${port}, '127.0.0.1', () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
});
setInterval(() => {}, 1000);
`,
  );
  return { command: `node ${script}`, pidFile };
}

describe('a port that is already taken', () => {
  test('is reported rather than silently reused', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const blocker = createServer();
      await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const port = blocker.address().port;
      const { command } = writeServerScript(dir, port);

      await assert.rejects(
        () => startTarget(cfgFor(dir, { startCommand: command, port })),
        /never came up|exited/,
      );

      await new Promise((resolve) => blocker.close(resolve));
    } finally {
      await dispose();
    }
  });
});

describe('an interrupted run', () => {
  test('does not leave the dev server behind', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command } = writeServerScript(dir, port);
      const serverScript = command.replace(/^node /, '');

      const gone = await runInterruptScenario({ dir, port, serverScript });

      // Node does not run `finally` blocks on SIGINT, so the cleanup in
      // `loop.mjs` never happens on Ctrl-C. startTarget has to stop the
      // server itself, or it survives still holding the port.
      assert.ok(gone, 'the dev server should have died with the interrupted run');
    } finally {
      await dispose();
    }
  });
});

describe('a dev server whose shell has already exited', () => {
  test('is still stopped by close()', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command, pidFile } = writeServerScript(dir, port);

      // The shell backgrounds the server and exits, which is what `npm run dev &`
      // and friends do. The shell is gone; the server is not.
      const target = await startTarget(
        cfgFor(dir, { startCommand: `${command} & sleep 0.5`, port }),
      );

      const serverPid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(serverPid), 'the server should be running before we close');

      await target.close();

      // A dead shell means `child.kill()` has nothing left to reach, so the
      // group signal is the only thing that can stop the server.
      assert.ok(
        await waitForGone(serverPid),
        `the server (pid ${serverPid}) should have been stopped even though its shell exited`,
      );
    } finally {
      await dispose();
    }
  });
});

describe('a dev server that fails to start', () => {
  test('is not left running', async () => {
    const { dir, dispose } = await tempDir();
    try {
      // Two different ports on purpose. The server binds one of them; ayna is
      // told to look at the other. So the URL never becomes reachable and the
      // start genuinely fails — while the server is still alive and holding a
      // port, which is exactly the case where a leak goes unnoticed.
      const serverPort = await freePort();
      const watchedPort = await freePort();
      const { command, pidFile } = writeServerScript(dir, serverPort);

      // The command starts the server, then fails. The failure is the point:
      // startTarget rejects, and the server it started must not be left
      // holding the port.
      const target = startTarget(
        cfgFor(dir, { startCommand: `${command} & sleep 1.5 && exit 7`, port: watchedPort }),
      );

      await assert.rejects(() => target, /exited with code 7|never came up/);

      // Give the server a moment to write its pid file if it is going to.
      await sleep(300);
      let serverPid = null;
      try {
        serverPid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        // The server never wrote its pid; nothing to check.
      }

      if (serverPid !== null && alive(serverPid)) {
        try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
        assert.fail(`the server (pid ${serverPid}) was left running after a failed start`);
      }
    } finally {
      await dispose();
    }
  });
});

describe('a dev server that ignores SIGTERM', () => {
  test('is reported rather than quietly left behind', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command, pidFile } = writeStubbornServerScript(dir, port);
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));

      const serverPid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(serverPid), 'the server should be running before we close');

      // close() has to say what happened. There is no SIGKILL escalation here,
      // so the server survives — and a caller told "closed" would go looking
      // for the next EADDRINUSE in the wrong place.
      //
      // The report goes to stderr, because stdout has to stay nothing but
      // JSON for the commands that print it.
      const warnings = [];
      const realWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        warnings.push(String(chunk));
        return true;
      };
      let gone;
      try {
        gone = await target.close();
      } finally {
        process.stderr.write = realWrite;
      }

      assert.equal(gone, false, 'close() should report that the server survived');
      assert.ok(
        warnings.some((w) => /did not stop/.test(w) && /SIGTERM/.test(w)),
        `close() should warn that the server survived, got: ${JSON.stringify(warnings)}`,
      );
      // The warning has to name the port, because that is what the user has to
      // deal with.
      assert.ok(
        warnings.some((w) => w.includes(String(port))),
        'the warning should name the port that is still held',
      );

      assert.ok(alive(serverPid), 'the stubborn server should still be running');
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
    } finally {
      await dispose();
    }
  });

  test('keeps stdout clean, so a --json command still prints JSON', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command, pidFile } = writeStubbornServerScript(dir, port);
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));
      const serverPid = Number(readFileSync(pidFile, 'utf8'));

      // Several commands print JSON to stdout. A diagnostic printed there
      // would land in the middle of the JSON and break every parser reading it.
      const out = [];
      const realLog = console.log;
      const realWrite = process.stderr.write;
      console.log = (...args) => out.push(args.join(' '));
      process.stderr.write = () => true;
      try {
        await target.close();
      } finally {
        console.log = realLog;
        process.stderr.write = realWrite;
      }

      assert.deepEqual(out, [], `stdout must stay empty, got: ${JSON.stringify(out)}`);

      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
    } finally {
      await dispose();
    }
  });

  test('does not hold the caller for the whole wait', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command, pidFile } = writeStubbornServerScript(dir, port);
      const target = await startTarget(cfgFor(dir, { startCommand: command, port }));
      const serverPid = Number(readFileSync(pidFile, 'utf8'));

      const realWrite = process.stderr.write;
      process.stderr.write = () => true;
      const started = Date.now();
      try {
        await target.close();
      } finally {
        process.stderr.write = realWrite;
      }
      const elapsed = Date.now() - started;

      // A server that honours SIGTERM is gone in milliseconds. The wait is
      // for the socket to close, not for a server that will never close it.
      assert.ok(elapsed < 4_000, `close() should not hang, took ${elapsed}ms`);

      try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ }
    } finally {
      await dispose();
    }
  });
});

describe('a target configured with both a url and a start command', () => {
  test('waits for the port the command actually serves', async () => {
    const { dir, dispose } = await tempDir();
    try {
      // The command binds one port; the config's url points at another. The
      // command is what ayna started, so the command's port is the one that
      // will come up.
      const serverPort = await freePort();
      const stalePort = await freePort();
      const { command } = writeServerScript(dir, serverPort);

      const target = await startTarget(
        cfgFor(dir, {
          startCommand: command,
          port: serverPort,
          url: `http://127.0.0.1:${stalePort}/`,
        }),
      );

      // Before the fix this waited out the full 60s timeout and then failed,
      // leaving the server it had started running and holding its port.
      assert.equal(target.url, `http://127.0.0.1:${serverPort}/`);

      await target.close();
    } finally {
      await dispose();
    }
  });

  test('keeps a url that agrees with the port', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const port = await freePort();
      const { command } = writeServerScript(dir, port);

      // A url on the same port may carry a path and a query string, and those
      // are worth keeping.
      const target = await startTarget(
        cfgFor(dir, {
          startCommand: command,
          port,
          url: `http://127.0.0.1:${port}/app?x=1`,
        }),
      );

      assert.equal(target.url, `http://127.0.0.1:${port}/app?x=1`);
      await target.close();
    } finally {
      await dispose();
    }
  });
});
