import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { gotoSettled, reloadSettled } from './browser.mjs';

/**
 * Point-and-comment review on the live page.
 *
 * The user clicks the thing they mean, types what's wrong, and optionally pastes a
 * reference image. We capture the element's selector, its computed styles, a crop
 * of that exact region, and the attached image — so Claude gets the precise target
 * instead of a paraphrase like "the button at the top looks off".
 *
 * No endpoint or extension needed: `page.exposeFunction` lets the in-page overlay
 * call straight into Node, so this works against any URL, including the user's own
 * dev server.
 */

/**
 * Crop a page-coordinate region without disturbing what the user is looking at.
 *
 * `fullPage: true` is the obvious way to clip an arbitrary page rect, and on a
 * window-following page (`viewport: null`, which is every review window) it makes
 * Chromium relay the page out at a different size and back. Nothing in Node
 * notices — `innerWidth` reads the same before and after — but the page fires
 * `window` and `visualViewport` resize events, so anything that re-measures on
 * resize re-renders at the wrong size and snaps back. On a canvas app that is the
 * whole UI flinching, every time you frame a region or open the comment box.
 *
 * A clip *without* `fullPage` fires no resize events at all. Its coordinates are
 * viewport-relative rather than page-relative, so subtract the scroll offset. That
 * only works while the region is on screen — which it is, because the user just
 * pointed at it. Anything scrolled out falls back to the disruptive path, since a
 * silently truncated crop of what they framed would be worse than a flinch.
 */
export async function cropRegion(page, rect, pad) {
  const clip = {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: Math.max(8, rect.width + pad * 2),
    height: Math.max(8, rect.height + pad * 2),
  };

  const view = await page
    .evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }))
    .catch(() => null);

  if (view) {
    // Judge visibility on the region itself, then clamp the padding to the edges.
    // Testing the padded box instead rejects anything full-width — the padding
    // alone puts it past the right edge — which is most of what people click, so
    // the fast path would exist and never be taken.
    const x = rect.x - view.x;
    const y = rect.y - view.y;
    const visible = x >= 0 && y >= 0 && x + rect.width <= view.w && y + rect.height <= view.h;
    if (visible) {
      const left = Math.max(0, x - pad);
      const top = Math.max(0, y - pad);
      return {
        clip: {
          x: left,
          y: top,
          width: Math.max(8, Math.min(view.w, x + rect.width + pad) - left),
          height: Math.max(8, Math.min(view.h, y + rect.height + pad) - top),
        },
        fullPage: false,
      };
    }
  }
  return { clip, fullPage: true };
}

/**
 * Best-effort map from a DOM node back to the source that produced it.
 *
 * `pageUrl` matters on multi-page sites: a grep for "about" hits the *link* to
 * /about.html in index.html before the page itself, so candidates whose path
 * resembles the page the comment was made on are ranked first.
 */
async function findInSource(projectDir, { id, classes, text }, pageUrl) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const needles = [];
  if (id) needles.push(id);
  for (const c of (classes ?? []).slice(0, 3)) needles.push(c);
  // A distinctive phrase from the element beats a generic class name.
  const phrase = (text ?? '').split('\n')[0].trim().slice(0, 40);
  if (phrase.length > 12) needles.push(phrase);

  const hits = [];
  for (const needle of needles) {
    let lines = [];
    try {
      const { stdout } = await exec(
        'grep',
        ['-rn', '--binary-files=without-match', ...GREP_EXCLUDES, '-F', needle, projectDir],
        { maxBuffer: 1024 * 1024 },
      );
      lines = stdout.split('\n');
    } catch (err) {
      // grep exits 1 when nothing matches — not an error. But ENOENT means there
      // is no grep at all (Windows), and silently returning no source locations
      // would quietly gut the feature, so fall back to scanning in JS.
      if (err.code === 'ENOENT') lines = await scanInJs(projectDir, needle);
    }

    for (const line of lines.slice(0, 4)) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) hits.push({ needle, file: path.relative(projectDir, m[1]), line: Number(m[2]), preview: m[3].trim().slice(0, 120) });
    }
    if (hits.length >= 6) break;
  }
  return rankByPage(hits, pageUrl);
}

/*
  Build output is not source. A Next.js project answers a grep for a class name
  from .next/server/... and .next/static/chunks/... long before it reaches the
  component that produced it — so the file:line handed to Claude pointed at
  generated code that is rewritten on every build. Same for dist, build, .nuxt
  and friends.
*/
const SKIP_DIRS = [
  'node_modules', '.git', '.ayna', '.next', '.nuxt', '.svelte-kit', '.output',
  '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'vendor', '__pycache__',
];

const GREP_EXCLUDES = SKIP_DIRS.map((d) => `--exclude-dir=${d}`);
const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.vue', '.svelte', '.astro', '.php', '.erb', '.hbs', '.ejs', '.md', '.json',
]);

/** Portable stand-in for `grep -rn`, used where grep isn't available. Exported for tests. */
export async function scanInJs(dir, needle, out = [], budget = { files: 4000 }) {
  const { readdir, readFile } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= 8 || budget.files <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue;
      await scanInJs(full, needle, out, budget);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    budget.files -= 1;
    const text = await readFile(full, 'utf8').catch(() => null);
    if (!text || !text.includes(needle)) continue;
    text.split('\n').forEach((line, i) => {
      if (out.length < 8 && line.includes(needle)) out.push(`${full}:${i + 1}:${line}`);
    });
  }
  return out;
}

/** Files whose path echoes the current route are the likelier source. */
function rankByPage(hits, pageUrl) {
  if (!pageUrl || hits.length < 2) return hits;

  let route;
  try {
    route = new URL(pageUrl).pathname;
  } catch {
    return hits;
  }
  // "/about.html" -> "about"; "/" or "/index.html" -> "index"
  const stem = path.basename(route, path.extname(route)) || 'index';

  const score = (hit) => {
    const base = path.basename(hit.file, path.extname(hit.file));
    if (base === stem) return 0;
    if (hit.file.includes(`/${stem}`) || base.includes(stem)) return 1;
    return 2;
  };
  // Stable sort keeps the original grep order within each tier.
  return hits.map((h, i) => ({ h, i })).sort((a, b) => score(a.h) - score(b.h) || a.i - b.i).map((x) => x.h);
}

/**
 * Opens the page with the overlay and resolves once the user clicks
 * "Send to Claude" or closes the tab.
 */
export async function runAnnotate({
  browser,
  // A persistent context can be handed in so a login survives between reviews.
  context: providedContext,
  url,
  outDir,
  projectDir,
  viewport,
  onReady,
  /*
    Called the moment anything happens that Claude should act on.

    Waiting used to need a second process — `wait` or `applied` — that somebody had
    to remember to start. When nobody did, a comment sat in the file and the user
    watched a page that said "Sent". Emitting events from the process that already
    owns the window means one thing to run and nothing to re-arm.
  */
  onEvent = () => {},
  /*
    The task store. Comments are written to it as they are made and their verdicts
    written back, so the window stops being where the work lives. Anything still
    owed from an earlier session is loaded on open, which is the whole point:
    closing the window no longer loses it.
  */
  store = null,
}) {
  await mkdir(outDir, { recursive: true });

  const ownsContext = !providedContext;
  const context =
    providedContext ??
    (await browser.newContext({
      viewport: viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    }));
  // A persistent context opens with a page already; reuse it rather than stacking.
  const page = context.pages()[0] ?? (await context.newPage());

  const comments = [];
  let nextId = 1;
  let done = false;

  // Pending work from before this window existed.
  let resumed = 0;
  if (store) {
    for (const t of await store.list({ pending: true })) {
      comments.push({
        id: nextId++,
        taskId: t.id,
        n: comments.length + 1,
        status: t.status,
        kind: t.kind ?? 'comment',
        comment: t.comment,
        // A proposal carries the fix it is proposing; without it the card offers
        // a verdict on something the user cannot see.
        fix: t.fix ?? null,
        source: t.source ?? 'user',
        selector: t.selector,
        elements: t.elements ?? [],
        region: t.region ?? null,
        move: t.move ?? null,
        rect: t.rect ?? null,
        styles: t.styles ?? {},
        url: t.url,
        regionScreenshot: t.regionScreenshot,
        attachments: t.attachments ?? [],
        sourceCandidates: t.sourceCandidates ?? [],
        rounds: [],
        resumed: true,
      });
      resumed += 1;
    }
  }

  await page.exposeFunction('__aynaSubmit', async (payload) => {
    const n = comments.length + 1;
    const dir = path.join(outDir, `comment-${String(n).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });

    // Crop the exact region the user pointed at, with a little breathing room.
    const regionFile = path.join(dir, 'region.png');
    try {
      await page.screenshot({ path: regionFile, ...(await cropRegion(page, payload.rect, 12)) });
    } catch {
      // An off-screen or zero-size target just means no crop; the comment still stands.
    }

    // Whatever the user pasted in as a reference.
    const attachments = [];
    for (const [idx, dataUrl] of (payload.images ?? []).entries()) {
      const m = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl);
      if (!m) continue;
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      const file = path.join(dir, `attached-${idx + 1}.${ext}`);
      await writeFile(file, Buffer.from(m[2], 'base64'));
      attachments.push(file);
    }

    // One comment can cover several elements (shift-click); map each of them.
    const described = payload.elements?.length ? payload.elements : [payload];
    const perElement = [];
    for (const el of described) {
      perElement.push({
        selector: el.selector ?? payload.selector,
        tag: el.tag,
        id: el.id,
        classes: el.classes,
        text: el.text,
        outerHTML: el.outerHTML,
        styles: el.styles,
        rect: el.rect,
        sourceCandidates: await findInSource(projectDir, el, payload.url),
      });
    }
    const source = perElement.flatMap((e) => e.sourceCandidates);

    const record = {
      // Stable across deletions; `n` is just display order and gets renumbered.
      id: nextId++,
      n,
      /*
        open     — Claude has not addressed it yet
        resolved — the user looked at the change and accepted it
        rejected — the user looked and wants another attempt
        Resolved comments stay in the manifest as a record of what changed.
      */
      status: 'open',
      rounds: [],
      // 'comment' is a note about an element; 'move' is a reorder the user
      // performed in the page and wants reflected in the source.
      kind: payload.kind ?? 'comment',
      move: payload.move ?? null,
      // Set when the user dragged a box instead of clicking one element.
      region: payload.region ?? null,
      comment: payload.comment,
      selector: payload.selector,
      element: {
        tag: payload.tag,
        id: payload.id,
        classes: payload.classes,
        text: payload.text,
        outerHTML: payload.outerHTML,
      },
      elements: perElement,
      styles: payload.styles,
      rect: payload.rect,
      url: payload.url,
      regionScreenshot: existsSync(regionFile) ? regionFile : null,
      attachments,
      sourceCandidates: source,
    };
    if (store) {
      const task = await store.create(
        {
          /*
            The same comment is about to be written to comments.json as well, and
            importLegacy adopts that file later keyed on session#id. Without
            claiming the key here, every comment made in a live window would be
            imported a second time and the user would see each of their notes
            twice.
          */
          legacyKey: `${path.basename(outDir)}#${record.id}`,
          url: record.url,
          kind: record.kind,
          comment: record.comment,
          selector: record.selector,
          elements: record.elements,
          region: record.region,
          move: record.move,
          rect: record.rect,
          styles: record.styles,
          sourceCandidates: record.sourceCandidates,
        },
        { regionScreenshot: record.regionScreenshot, attachments: record.attachments },
      );
      record.taskId = task.id;
    }

    comments.push(record);
    await writeFile(path.join(dir, 'comment.json'), JSON.stringify(record, null, 2));
    return { ok: true, n, id: record.id };
  });

  // Undo a comment the user changed their mind about. Without this the only way
  // out of a mistaken pin is to close the window and start the review over.
  await page.exposeFunction('__aynaRemove', async (id) => {
    const idx = comments.findIndex((c) => c.id === id);
    if (idx === -1) return { ok: false, count: comments.length };
    comments.splice(idx, 1);
    // Keep display numbering contiguous after a removal.
    comments.forEach((c, i) => {
      c.n = i + 1;
    });
    await writeStatus();
    return { ok: true, count: comments.length };
  });

  // Phase is the contract between the browser, Node, and Claude:
  //   commenting → awaiting-claude → reviewing → approved
  // Claude polls status.json; the user never loses the window in between.
  let phase = 'commenting';
  let round = 0;
  const statusFile = path.join(outDir, 'status.json');
  const appliedFile = path.join(outDir, 'applied');
  const commentsFile = path.join(outDir, 'comments.json');
  const auditRequest = path.join(outDir, 'audit-request');
  const auditResult = path.join(outDir, 'audit-live.json');

  const writeStatus = () =>
    writeFile(
      statusFile,
      JSON.stringify(
        {
          phase,
          round,
          comments: comments.length,
          open: comments.filter((c) => c.status !== 'approved').length,
          resolved: comments.filter((c) => c.status === 'approved').length,
          rejected: comments.filter((c) => c.status === 'rejected').length,
          approved: done,
          url,
        },
        null,
        2,
      ),
    );

  const writeManifest = () =>
    writeFile(
      commentsFile,
      JSON.stringify(
        { url, capturedAt: outDir, fullPage: path.join(outDir, 'full-page.png'), round, comments },
        null,
        2,
      ),
    );

  // A marker left behind by an earlier session would make us skip the waiting
  // phase and jump straight to "review" the moment the first round is sent.
  await rm(appliedFile, { force: true });
  await writeStatus();

  /*
    Notice the work instead of waiting to be told about it.

    Leaving "waiting for Claude" required somebody to run `ayna applied`. When
    nobody did — a session that never learned the command, a run that ended, a
    plain forgotten step — the window sat on that spinner forever while the edits
    it was waiting for were already on disk. The user was told to wait for
    something that had happened.

    A marker is cooperation; a changed file is evidence. So watch the project, and
    once edits stop arriving, treat the round as applied. The marker still works
    and still wins, for anything that does report in.
  */
  /*
    Everything worth showing in the window, in order.

    The event stream went to stdout, which meant the terminal — so following a
    review meant watching a window and a terminal at once, and the person who
    wanted to stay on the page had to keep leaving it. The same events feed a
    console inside the window now. The database is the real record when there is
    one; this mirror keeps the panel working when there is not.
  */
  const feed = [];
  const pushFeed = (e) => {
    feed.push({ seq: feed.length + 1, at: Date.now(), ...e });
    if (feed.length > 500) feed.shift();
  };
  const emit = (e) => {
    pushFeed(e);
    onEvent(e);
  };

  let editedAt = 0;
  let projectWatcher = null;
  const watchProject = () => {
    if (projectWatcher || !projectDir) return;
    try {
      projectWatcher = watch(projectDir, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = String(name);
        const parts = rel.split(/[\\/]/);
        // Our own output changes constantly; so does anything generated.
        if (parts.some((part) => part === '.ayna' || SKIP_DIRS.includes(part))) return;
        if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) return;
        editedAt = Date.now();
      });
    } catch {
      // No recursive watch on this platform — the marker path still works.
      projectWatcher = null;
    }
  };
  const stopWatchingProject = () => {
    projectWatcher?.close();
    projectWatcher = null;
    editedAt = 0;
  };

  // The user finished a round of comments and wants them acted on.
  await page.exposeFunction('__aynaDone', async () => {
    round += 1;
    phase = 'awaiting-claude';
    watchProject();
    await writeManifest();
    await writeStatus();
    emit({
      event: 'round',
      round,
      comments: comments.length,
      open: comments.filter((c) => c.status !== 'approved').length,
      commentsFile,
      action: 'read-comments',
    });
  });

  /*
    The user can always say the changes have landed.

    Even with the watcher, an edit made somewhere this cannot see — another
    machine, a container, a generated file — leaves them stuck. Nobody should have
    to kill a window to escape a progress message.
  */
  let saidApplied = false;
  await page.exposeFunction('__aynaApplied', async () => {
    saidApplied = true;
  });

  /*
    What the console shows, and what it can send.

    Reading comes from the database when there is one, because that survives the
    window and every process around it; the local mirror covers the case where
    there is not. Writing goes to the same place, so a line typed on the page is
    the same kind of thing as a line Claude wrote — one stream, one order, no
    second channel to keep in sync.
  */
  await page.exposeFunction('__aynaFeed', async (since = 0) => {
    if (store?.db) {
      try {
        const { eventsSince } = await import('./db.mjs');
        return eventsSince(store.db, Number(since) || 0, 200);
      } catch {
        // Fall through to the mirror rather than leaving the panel blank.
      }
    }
    return feed.filter((e) => e.seq > (Number(since) || 0));
  });

  await page.exposeFunction('__aynaSay', async (text) => {
    const said = String(text ?? '').trim();
    if (!said) return { ok: false };
    if (store?.db) {
      try {
        const { appendEvent } = await import('./db.mjs');
        appendEvent(store.db, { event: 'message', from: 'user', text: said });
      } catch {
        // The mirror below still carries it to anything watching this session.
      }
    }
    emit({ event: 'message', from: 'user', text: said, action: 'read-and-reply' });
    return { ok: true };
  });

  // They looked at the result and want another pass.
  await page.exposeFunction('__aynaMore', async () => {
    phase = 'commenting';
    stopWatchingProject();
    await rm(appliedFile, { force: true });
    await writeStatus();
  });

  /*
    Screenshot a region on demand and hand it straight back as a data URL, so the
    comment box can show what it captured before you write a word. On a canvas the
    framed pixels are the entire message — you should be able to see that they were
    taken, not take it on faith.
  */
  await page.exposeFunction('__aynaPreview', async (rect) => {
    try {
      const buf = await page.screenshot(await cropRegion(page, rect, 8));
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch {
      return null;
    }
  });

  /*
    The user's answer to a proposal. They can wave it through, refuse it, or type
    what they want instead — which turns Claude's suggestion into their
    instruction and sends it back as work to do.
  */
  await page.exposeFunction('__aynaRespond', async (id, verdict, note) => {
    const c = comments.find((x) => x.id === id);
    if (!c) return { ok: false };

    if (verdict === 'redirect' && note) {
      c.comment = note;
      c.status = 'open';
      c.source = 'user';
      if (store && c.taskId) await store.update(c.taskId, { comment: note, status: 'open', source: 'user' }, 'redirected by the user');
      emit({ event: 'task', id: c.taskId ?? id, status: 'open', comment: note, action: 'do-this-instead' });
    } else if (verdict === 'approve') {
      c.status = 'open'; // approved to go ahead, not approved as done
      if (store && c.taskId) await store.update(c.taskId, { status: 'open' }, 'user approved the proposal');
      emit({ event: 'task', id: c.taskId ?? id, status: 'open', comment: c.comment, action: 'go-ahead' });
    } else {
      c.status = 'approved'; // declined and settled; nothing to do
      if (store && c.taskId) await store.update(c.taskId, { status: 'approved' }, 'user declined the proposal');
    }
    await writeManifest();
    await writeStatus();
    return { ok: true, status: c.status };
  });

  // Comments survive navigation (they live here, not in the page), so a rebuilt
  // overlay can ask for the real running total.
  await page.exposeFunction('__aynaCount', async () => comments.length);

  // The review overlay re-anchors these on the page after Claude's edits land.
  await page.exposeFunction('__aynaList', async () =>
    comments.map((c) => ({
      id: c.id,
      n: c.n,
      comment: c.comment,
      kind: c.kind,
      fix: c.fix ?? null,
      source: c.source ?? 'user',
      selector: c.selector,
      rect: c.rect,
      status: c.status,
      url: c.url,
    })),
  );

  // Per-comment verdict. Approving keeps the comment as history; rejecting puts
  // it back in front of Claude for another attempt.
  await page.exposeFunction('__aynaResolve', async (id, status) => {
    const c = comments.find((x) => x.id === id);
    if (!c || !['approved', 'rejected', 'open'].includes(status)) {
      return { ok: false };
    }
    c.status = status;
    c.rounds.push({ round, status });
    if (store && c.taskId) await store.update(c.taskId, { status });
    await writeManifest();
    await writeStatus();
    if (status === 'rejected') {
      emit({ event: 'rejected', id: c.id, comment: c.comment, commentsFile, action: 'retry-rejected' });
    }
    return { ok: true, status, open: comments.filter((x) => x.status !== 'approved').length };
  });

  // They're happy — this is the only thing that closes the window.
  await page.exposeFunction('__aynaApprove', async () => {
    /*
      Closing is not a verdict.

      This used to mark every unjudged comment resolved, which meant one click
      silently signed off work nobody had looked at. A task you have not approved
      stays pending — it survives the window closing and is still waiting next
      time. Each one is approved on its own marker, deliberately.
    */
    phase = 'approved';
    done = true;
    await writeManifest();
    await writeStatus();
    emit({ event: 'closed', approved: true, commentsFile });
  });

  // Approving everything is now a deliberate button of its own, never a side
  // effect of closing.
  await page.exposeFunction('__aynaApproveAll', async () => {
    let n = 0;
    for (const c of comments) {
      if (c.status !== 'approved') {
        c.status = 'approved';
        if (store && c.taskId) await store.update(c.taskId, { status: 'approved' });
        c.rounds.push({ round, status: 'approved', via: 'approve-all' });
        n += 1;
      }
    }
    await writeManifest();
    await writeStatus();
    return { ok: true, resolved: n };
  });

  // Lets a rebuilt overlay restore what it was in the middle of.
  await page.exposeFunction('__aynaState', async () => ({
    phase,
    round,
    count: comments.length,
    pending: comments.filter((c) => c.status !== 'approved').length,
    resumed,
  }));

  /*
    Inject on every load rather than with addInitScript.

    addInitScript captures the source once, so an open window kept running
    whatever the overlay was when the process started — every fix meant closing
    the review and starting over. Reading the file per load means a reload picks
    up the current code, and the watcher below turns an edit into a reload.
  */
  const overlayFile = fileURLToPath(new URL('./overlay.js', import.meta.url));
  const injectOverlay = async () => {
    const src = await readFile(overlayFile, 'utf8').catch(() => null);
    if (src) await page.evaluate(src).catch(() => {});
  };
  page.on('load', injectOverlay);

  await gotoSettled(page, url);
  await injectOverlay();

  // Editing the overlay reloads the open window, so a fix lands without the user
  // losing their place.
  let reloading = false;
  const overlayWatcher = watch(overlayFile, async () => {
    if (reloading || page.isClosed()) return;
    reloading = true;
    setTimeout(async () => {
      try {
        await reloadSettled(page);
      } catch {
        // The window may have gone; the loop below will notice.
      }
      reloading = false;
    }, 250);
  });

  // Lets tests and scripted flows drive the overlay without a human at the mouse.
  // Deliberately not awaited: a real user clicks while the watch loop below is
  // running, and awaiting here would stall that loop and deadlock the round-trip.
  if (onReady) {
    onReady(page).catch(async (err) => {
      // Swallowing this would leave the watch loop below waiting for an approval
      // that can never come — an infinite hang with no explanation. Close the page
      // so the loop exits and the failure is visible.
      process.stderr.write(`[ayna] scripted interaction failed: ${err.message}\n`);
      await page.close().catch(() => {});
    });
  }

  // Stay open until the user approves or closes the tab themselves. While waiting,
  // watch for Claude's "applied" marker — that's the cue to show them the result.
  while (!done && !page.isClosed()) {
    /*
      Audit the window the user is actually looking at.

      Chrome allows one process per profile, so a separate audit run meant closing
      their review first — and it could only ever measure the state the page loads
      in, not the one they had clicked into. Measuring in place solves both: it is
      the same window, in its current state, whatever they navigated to.
    */
    if (existsSync(auditRequest)) {
      await rm(auditRequest, { force: true });
      try {
        const { CHECKS, scoreFindings } = await import('./audit.mjs');
        const raw = await page.evaluate(CHECKS);
        const shot = path.join(outDir, 'audit-live.png');
        await page.screenshot({ path: shot }).catch(() => {});
        const report = scoreFindings(page.url(), [
          { ...raw, viewport: 'live', size: `${raw.viewport.width}x${raw.viewport.height}`, screenshot: shot },
        ]);
        await writeFile(auditResult, JSON.stringify(report, null, 2));
        emit({ event: 'audit', url: page.url(), counts: report.counts, clean: report.clean, file: auditResult });
      } catch (err) {
        await writeFile(auditResult, JSON.stringify({ error: err.message.split('\n')[0] }));
      }
    }

    // Edits have to stop arriving before the page reloads, or a save mid-edit
    // shows a half-finished screen and calls it the result.
    const editsSettled = editedAt > 0 && Date.now() - editedAt > 1800;

    if (phase === 'awaiting-claude' && (existsSync(appliedFile) || editsSettled || saidApplied)) {
      const reason = existsSync(appliedFile) ? 'marker' : saidApplied ? 'user' : 'file-change';
      saidApplied = false;
      stopWatchingProject();
      await rm(appliedFile, { force: true });
      emit({ event: 'applied', round, via: reason });
      // Anything the user sent back for another attempt has now had one, so it
      // returns to the pile to be judged again rather than staying "rejected".
      for (const c of comments) {
        if (c.status === 'rejected') c.status = 'open';
      }
      try {
        /*
          Come back to where they were standing.

          The reload is how a fix becomes visible, but it also returns the page to
          the top. Someone who commented on something far down the page pressed
          approve and lost their place, on every round — so the thing they were
          judging was off screen exactly when they needed to look at it.
        */
        const at = await page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => null);
        await reloadSettled(page);
        if (at && (at.x || at.y)) {
          await page.evaluate((p) => scrollTo(p.x, p.y), at).catch(() => {});
        }
        // The overlay is injected per load and that is asynchronous — without
        // waiting for it, __aynaReview fires into a page that has no overlay yet
        // and the review markers never appear.
        await injectOverlay();
        await page.evaluate(() => window.__aynaReview && window.__aynaReview());
        phase = 'reviewing';
      } catch {
        // A reload failure shouldn't strand the user — let them keep commenting.
        phase = 'commenting';
      }
      await writeStatus();
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  overlayWatcher.close();
  stopWatchingProject();

  const fullFile = path.join(outDir, 'full-page.png');
  if (!page.isClosed()) {
    // Same flinch as a region crop, and this fires while the window is still in
    // front of the user. When the page already fits, the viewport *is* the full
    // page, so ask for the expensive capture only when it would show more.
    const overflows = await page
      .evaluate(() => document.documentElement.scrollHeight > innerHeight + 4)
      .catch(() => true);
    await page.screenshot({ path: fullFile, fullPage: overflows }).catch(() => {});
    if (ownsContext) await context.close().catch(() => {});
  }

  phase = done ? 'approved' : 'closed';
  await writeStatus();
  if (!done) emit({ event: 'closed', approved: false, commentsFile });

  const manifest = {
    url,
    capturedAt: outDir,
    fullPage: existsSync(fullFile) ? fullFile : null,
    approved: done,
    rounds: round,
    comments,
  };
  await writeFile(commentsFile, JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function loadComments(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
