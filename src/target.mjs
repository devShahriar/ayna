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
      // The command is a shell, and the shell is a wrapper around the server that
      // actually holds the port. Signalling the shell alone leaves that server
      // running, and the next run then fails on a port it never released. A
      // detached child is a process-group leader, so the group can be signalled
      // as one thing.
      //
      // Detaching also puts the server in its own session, which is what makes
      // the group kill reach it — and which means a terminal Ctrl-C no longer
      // does. So the signal is handled here, where the group is known.
      //
      // A server that puts *itself* in a new session (`setsid`, some daemon
      // wrappers) leaves the group behind and survives the group signal.
      // Reaching that would mean tracking every descendant's session, so the
      // guarantee here is "the group", not "the whole tree".
      detached: true,
    });
    const url = waitTarget(cfg);

    // Node does not run `finally` blocks on SIGINT, so a caller that cleans up
    // in a `finally` — `loop.mjs` does exactly that — never gets to clean up
    // when the user presses Ctrl-C. The server would survive, still holding the
    // port, and the next run would fail on it. So the group is stopped here,
    // and the signal is left to do what it would have done anyway.
    const onSignal = () => {
      killGroup(child);
      process.exit(130); // 128 + SIGINT, the usual exit code for an interrupt.
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const stopOnSignal = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    // A ChildProcess with no `error` listener turns a late `error` event into
    // an uncaught exception, and this child is never waited on to completion:
    // it is stopped by a signal, and the signal can arrive after `close()` has
    // taken its own listeners off. This one stays for the child's whole life
    // and does nothing but stop that crash.
    child.on('error', () => {});

    try {
      await waitForUrl(url, 60_000, child);
    } catch (err) {
      // Nothing holds this handle now, so nothing else will ever stop the
      // command. Without this, every failed startup leaves the server running
      // and holding the port.
      stopOnSignal();
      killGroup(child);
      if (!(await waitForGroupGone(child, EXIT_WAIT_MS))) reportSurvivor(cfg.target.port);
      throw err;
    }
    return {
      url,
      close: async () => {
        stopOnSignal();
        killGroup(child);
        // SIGTERM delivery is asynchronous, so the server may still be holding
        // the port when this returns. A caller that starts another server on
        // the same port right afterwards would get EADDRINUSE from a port that
        // is about to be free. So wait for the process to actually go.
        const gone = await waitForGroupGone(child, EXIT_WAIT_MS);
        if (!gone) reportSurvivor(cfg.target.port);
        return gone;
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

/**
 * The URL to wait for when ayna boots the dev command itself.
 *
 * `target.url` and `target.startCommand` can both be set — a config file is
 * allowed to carry both, and nothing stops somebody from writing a `url` that
 * points at a port the command does not bind. The command is what ayna
 * started, so the command's port is the one that will come up; waiting on a
 * stale `url` would sit there for the full timeout and then leave the server
 * it *did* start running and holding that port.
 *
 * So: a `url` that agrees with `target.port` is used as given — it may carry
 * a path, a host, a query string, and those are worth keeping. A `url` that
 * points somewhere else is dropped in favour of the port the command was
 * asked to serve.
 */
function waitTarget(cfg) {
  const fallback = `http://127.0.0.1:${cfg.target.port}/`;
  if (!cfg.target.url) return fallback;
  try {
    const parsed = new URL(cfg.target.url);
    // The port the URL names, defaulting by scheme the way a browser would.
    const implied = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (Number(implied) === Number(cfg.target.port)) return cfg.target.url;
    return fallback;
  } catch {
    // Not a URL at all. The command's port is the only thing we can trust.
    return fallback;
  }
}

async function waitForUrl(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  // A dev server that dies on startup is the common case, not the rare one.
  // Polling for the full timeout after the child is already gone just makes the
  // user wait a minute for news the process table already had.
  let exited = null;
  let exitedAt = 0;
  const onExit = (code, signal) => {
    exited = { code, signal };
    exitedAt = Date.now();
  };
  const onError = (err) => {
    exited = { error: err };
    exitedAt = Date.now();
  };
  child.on('exit', onExit);
  child.on('error', onError);

  try {
    while (Date.now() < deadline) {
      // Ask the URL first, always. The child that exited is a wrapper shell
      // whose server may still be starting — `npm run dev &`, a `predev` hook
      // that backgrounds the server, a dev server that takes a second or two to
      // bind. Treating the shell's exit as proof the server is gone rejects
      // servers that are about to work, and leaves them running with nobody
      // holding their handle.
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status < 500) return;
      } catch {
        // Not up yet.
      }
      // Only now is the exit evidence. And give the port a grace period: a
      // server that is still binding needs a moment, and the wrapper exiting
      // says nothing about whether it did.
      if (exited && Date.now() - exitedAt > EXIT_GRACE_MS) {
        throw new Error(startupFailure(url, exited));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`dev server never came up at ${url}`);
  } finally {
    // The child is done either way; a listener left behind would fire on a
    // later exit and keep this closure alive for the life of the process.
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
  }
}

/** How long the URL gets after the wrapper process exits before it counts as failed. */
const EXIT_GRACE_MS = 3_000;

/**
 * How long to wait for the command to actually go away after signalling it.
 *
 * Short, because a server that honours SIGTERM is gone in milliseconds — the
 * wait is for the socket to close, not for the server to think about it. A
 * server that ignores SIGTERM will never go, and holding the caller for the
 * whole wait only delays the report that it survived.
 *
 * Escalating to SIGKILL is not an option here: the group can hold work the
 * user did not ask to have killed.
 */
const EXIT_WAIT_MS = 2_000;

/**
 * Waits for the command's process group to empty out, or gives up after
 * `timeoutMs`.
 *
 * The point is the port. SIGTERM delivery is asynchronous, and the process
 * holding the port is usually not the one ayna spawned — `sh` forks the dev
 * command rather than exec'ing it, so the child ayna knows about is a shell
 * that exits the moment it is signalled while the server underneath it is
 * still closing its socket. Waiting for the *group* to empty is what makes
 * the port genuinely free by the time this returns.
 *
 * The wait is bounded, and a group that never empties is not an error: a
 * server that ignores SIGTERM survives, and there is nothing to escalate to.
 */
async function waitForGroupGone(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupHasMembers(child.pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !groupHasMembers(child.pid);
}

/** Is anyone still in this process group? */
function groupHasMembers(pgid) {
  try {
    // Signal 0 asks the kernel whether the group exists at all. A group with
    // a live member exists; a group whose members have all been reaped does
    // not, and the kernel says so with ESRCH.
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM means the group is there but not ours to signal.
    return err?.code === 'EPERM';
  }
}

/**
 * Says that the server survived the signal.
 *
 * There is no escalation to SIGKILL here on purpose — the group can hold work
 * the user did not ask to have killed. But the port is still held, and the
 * next run will fail on it, so a caller that was told nothing would go looking
 * for the bug in the wrong place.
 *
 * This goes to stderr, not stdout: several commands print JSON to stdout, and
 * stdout there must be nothing but JSON. A diagnostic belongs on stderr
 * anyway — it is about the run, not about the result.
 */
function reportSurvivor(port) {
  process.stderr.write(
    `  ! the dev server did not stop — it is ignoring SIGTERM. ` +
      `Port ${port} is still in use; stop it by hand.\n`,
  );
}

/** Says what actually happened, because "never came up" sends people looking in the wrong place. */
function startupFailure(url, exited) {
  if (exited.error) return `dev server failed to start: ${exited.error.message}`;
  // The thing that exited is the command's wrapper, not necessarily the server
  // itself, so the message says "command" rather than claiming the server died.
  if (exited.signal) return `the dev command exited on ${exited.signal} before ${url} was reachable`;
  return `the dev command exited with code ${exited.code} before ${url} was reachable`;
}

/**
 * SIGTERM the whole process group.
 *
 * `child.kill()` reaches the shell and nothing else. The group is what the
 * shell's own children live in, so this is the signal that reaches the server.
 *
 * The group id is the child's pid, and it stays a valid group id for as long
 * as *any* member of the group is alive — the kernel keeps that pid allocated
 * for the group's whole lifetime, so it cannot be recycled onto an unrelated
 * group. That matters here: the shell often exits before the server it
 * started, and a shell that has already exited is exactly when the server is
 * most likely to still be running and still holding the port. So the group
 * signal is sent whether or not the leader has exited, and ESRCH — which the
 * kernel returns once the group is genuinely gone — is the only thing that
 * stops it.
 */
function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (err) {
    if (err?.code === 'ESRCH') return; // Group already gone.
    // The group signal failed for some other reason; the child itself is still
    // ours to stop.
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
