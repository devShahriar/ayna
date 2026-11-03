import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { gotoSettled, reloadSettled } from './browser.mjs';
import { snapshotProject, roundChanges, hunks, undoChanges } from './rounds.mjs';
import { SKIP_DIRS } from './skipdirs.mjs';

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
/*
  ayna's own chrome, hidden for the length of a capture.

  A crop is taken while the selection box, its label and the numbered pin are
  drawn over the element, so every crop showed "p.text-sm ↑↓ select wider" and a
  badge sitting on the very text the note was about — and that crop is what
  Claude reads and what the activity rail shows. Everything ayna draws carries
  data-ayna; the app's own elements never do, so this hides exactly the chrome.
  `visibility`, not `display`, so nothing in the app moves.

  Only what the crop would take in is hidden, though. Playwright applies the
  style to the live page for the length of the capture, so hiding every
  [data-ayna] blinked the bar, the rail and the open comment box out of the
  user's window on every note. A crop on screen marks just the pieces it
  overlaps; the full-page fallback, which flinches anyway, still hides
  everything. And none of ayna's chrome casts a shadow for the capture: the
  selection's label sits right above the element, outside the crop, and its
  shadow put a dark smudge along the top of every crop of a nav.
*/
export const WITHOUT_CHROME = '[data-ayna] { visibility: hidden !important; }';
const WITHOUT_MARKED = '[data-ayna-crop] { visibility: hidden !important; } [data-ayna] { box-shadow: none !important; }';

/*
  Replace a file whole, never in place.

  status.json and comments.json are read by other processes while the window
  rewrites them: \`ayna wait\` polls the status twice a second, and so do tests.
  writeFile truncates first, so a read in that moment got an empty file and
  "Unexpected end of JSON input". Written beside it and renamed over it, a
  reader sees the old file or the new one, never half of either.
*/
let written = 0;
async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${(written += 1)}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

export async function cropRegion(page, rect, pad) {
  // One trip to the page: measure, work out the clip, and mark what it covers.
  const onScreen = await page
    .evaluate(
      ([r, pad]) => {
        // Judge visibility on the region itself, then clamp the padding to the
        // edges. Testing the padded box instead rejects anything full-width —
        // the padding alone puts it past the right edge — which is most of what
        // people click, so the fast path would exist and never be taken.
        const x = r.x - scrollX;
        const y = r.y - scrollY;
        if (x < 0 || y < 0 || x + r.width > innerWidth || y + r.height > innerHeight) return null;

        // A region inside the app's own area is padded only up to that area's
        // edge, so the bar and the rail beside it are never in the crop and
        // never need hiding. One already under them keeps the viewport's edges.
        const css = getComputedStyle(document.documentElement);
        const inset = (name) => parseFloat(css.getPropertyValue(name)) || 0;
        const app = {
          left: inset('--ayna-inset-left'),
          top: inset('--ayna-inset-top'),
          right: innerWidth,
          bottom: innerHeight - inset('--ayna-inset-bottom'),
        };
        const inApp = x >= app.left && y >= app.top && x + r.width <= app.right && y + r.height <= app.bottom;
        const edge = inApp ? app : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const left = Math.max(edge.left, x - pad);
        const top = Math.max(edge.top, y - pad);
        const clip = {
          x: left,
          y: top,
          width: Math.max(8, Math.min(edge.right, x + r.width + pad) - left),
          height: Math.max(8, Math.min(edge.bottom, y + r.height + pad) - top),
        };

        for (const el of document.querySelectorAll('[data-ayna-crop]')) el.removeAttribute('data-ayna-crop');
        for (const el of document.querySelectorAll('[data-ayna]')) {
          const b = el.getBoundingClientRect();
          const overlaps = b.right > clip.x && b.left < clip.x + clip.width && b.bottom > clip.y && b.top < clip.y + clip.height;
          if (b.width && b.height && overlaps) el.setAttribute('data-ayna-crop', '');
        }
        return clip;
      },
      [rect, pad],
    )
    .catch(() => null);
  if (onScreen) return { clip: onScreen, fullPage: false, style: WITHOUT_MARKED };

  const clip = {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: Math.max(8, rect.width + pad * 2),
    height: Math.max(8, rect.height + pad * 2),
  };
  return { clip, fullPage: true, style: WITHOUT_CHROME };
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
  theme = null,
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
  // Who opened the window. Worked out from the environment when not given;
  // tests pass one, since they run inside an agent themselves.
  agent: givenAgent = null,
}) {
  await mkdir(outDir, { recursive: true });

  /*
    Register the window, and keep saying so.

    Without this the only record of a live review was a pointer file nobody
    cleaned up, so a window that died left its tasks claimed by a process that no
    longer existed and the next session found a locked door. A session row plus a
    heartbeat lets the bookkeeper notice the death and free the work for whoever
    comes next.
  */
  let sessionId = null;
  let tabId = null;
  let sessions = null;
  let beat = null;
  let opener = null;
  if (store?.db) {
    try {
      const { openSessions } = await import('./sessions.mjs');
      const { identify } = await import('./agent.mjs');
      sessions = await openSessions(projectDir, { db: store.db });
      /*
        Resume, don't register.

        One agent holds one conversation and should hold one window with it.
        Registering minted a row per process, so a session that opened a review,
        checked a task and sent a round looked like three participants with three
        tabs — and `ayna status` could not answer "which window is mine?" because
        every command had made a new one.
      */
      const agent = givenAgent ?? identify();
      opener = agent;
      sessionId = sessions.resume({ agent, project: projectDir }).id;
      tabId = sessions.tabFor({ sessionId, url, outDir }).id;
      beat = setInterval(() => {
        try {
          sessions.heartbeat(sessionId);
        } catch {
          // A missed beat is recoverable; the sweep allows for silence.
        }
      }, 20_000);
      beat.unref?.();
    } catch {
      // The window works without any of this; it just cannot be swept up after.
      sessions = null;
    }
  }

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
          tabId,
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
    mirrorTask(record, { status: 'open', url: record.url, comment: record.comment });
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
  // Written by `ayna comments` when it reads a round that is waiting.
  const pickedUpFile = path.join(outDir, 'picked-up');
  let pickedUp = false;
  const commentsFile = path.join(outDir, 'comments.json');
  const auditRequest = path.join(outDir, 'audit-request');
  const auditResult = path.join(outDir, 'audit-live.json');

  const writeStatus = () =>
    writeAtomic(
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
    writeAtomic(
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
  // Its own counter: once the mirror is trimmed its length stops growing, and
  // a seq taken from the length repeated, so a reader past it saw nothing new.
  let feedSeq = 0;
  const pushFeed = (e) => {
    feed.push({ seq: ++feedSeq, at: Date.now(), ...e });
    if (feed.length > 500) feed.shift();
  };
  /*
    With no database the rail reads only this mirror, and the store's task
    events — which put a note in its round and settle the round once every note
    is judged — never reach it. A round there stayed "Your turn" after the last
    approval. So the window writes those events into the mirror itself, under
    an id of its own for each note.
  */
  const mirrorOnly = !store?.db;
  const noteKey = (c) => c.taskId ?? (mirrorOnly ? `note-${c.id}` : null);
  const mirrorTask = (c, fields) => {
    if (mirrorOnly) pushFeed({ event: 'task', taskId: noteKey(c), tabId: null, ...fields });
  };
  // A note's status, set everywhere it is kept: here, the store, and the mirror.
  const setStatus = async (c, status, note) => {
    c.status = status;
    if (store && c.taskId) await store.update(c.taskId, { status }, note, { tabId });
    mirrorTask(c, { status });
  };
  /*
    One data path.

    The console reads the database, and this wrote only to stdout and the local
    mirror — so a round, a landed change or a gate result reached the terminal
    and never the window. The panel showed messages and task changes, because
    those happen to be written by the store, and silently showed nothing else.
    Everything worth seeing goes to the same table, and readers poll that table.

    Task changes are the exception: the store already logs them as it makes them,
    and writing them twice would say everything twice.

    Every row carries this window's tab. Untagged, a round from last week's
    review and a round from this one were indistinguishable, so a new window
    could only replay the project's whole history — "Window closed" at the top,
    and "round 1" twice.
  */
  const emit = (e) => {
    pushFeed(e);
    if (store?.db && e.event !== 'task') {
      import('./db.mjs')
        .then(({ appendEvent }) => appendEvent(store.db, { ...e, tabId, sessionId }))
        .catch(() => {
          // The mirror and stdout still carry it; a log write must not take the
          // window down.
        });
    }
    onEvent(e);
  };

  let editedAt = 0;
  // Every file the watcher saw move this round, and the project as it was
  // before, so the round can say what it changed. See rounds.mjs.
  const roundEdits = new Set();
  let roundSnapshot = null;
  const roundFiles = new Map();
  // Which notes went out with each round, so undoing it can reopen them.
  const roundNotes = new Map();
  /*
    Rounds are numbered per process, and a window can outlive one: an agent that
    resumes its session reuses its tab, so a rail can show a dead process's
    "Round 1" next to this one's. Undo is asked for by this key, never by the
    bare number, so an old card can never take back the wrong round's files.
  */
  const windowKey = Math.random().toString(36).slice(2, 8);
  const roundKey = (n) => `${windowKey}.${n}`;
  // The round a key names, or null when it was some other process's round.
  const roundOf = (key) => {
    const [owner, n] = String(key).split('.');
    return owner === windowKey ? Number(n) : null;
  };
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
        roundEdits.add(rel);
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

  /*
    A cheap signature of how the page looks, not of what it is doing.

    Stylesheet text and element count move when a UI change lands and stay still
    through animation, polling and incoming data — which is the distinction that
    matters, because the question is whether somebody edited this page, not
    whether it is alive.
  */
  const appearanceOf = () =>
    page
      .evaluate(() => {
        let rules = 0;
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) rules += rule.cssText.length;
          } catch {
            // A cross-origin sheet cannot be read; its length is not knowable.
          }
        }
        return { rules, nodes: document.getElementsByTagName('*').length };
      })
      .catch(() => null);

  let appearance = null;

  /** The page's measurable faults, counted per check in SEVERITY's order. */
  const countFaults = async () => {
    const { CHECKS, SEVERITY } = await import('./audit.mjs');
    const measured = await page.evaluate(CHECKS);
    const counts = {};
    for (const [key] of SEVERITY) counts[key] = measured?.[key]?.length ?? 0;
    const serious = SEVERITY.filter(([, sev]) => sev !== 'minor').reduce((n, [k]) => n + counts[k], 0);
    return { counts, serious, unavailable: measured?.unavailable ?? null };
  };

  /*
    What the page measured before anyone touched it.

    The gate after a round reported every fault on the page as "still there",
    which read as "your change did not work" when nearly all of them had been
    there all along — the user's own home page showed 27 of them on a round that
    only renamed a footer. Counting once when the round is sent lets the gate
    say what the round added, and leave what it found alone.

    Bounded, because this sits between pressing Send and Claude hearing about
    it; a page too heavy to measure in a few seconds just goes uncompared.
  */
  let baseline = null;
  const samePage = (a, b) => {
    try {
      const [x, y] = [new URL(a), new URL(b)];
      return x.origin + x.pathname + x.hash === y.origin + y.pathname + y.hash;
    } catch {
      return false;
    }
  };

  /*
    True from Send until the round is announced.

    The page says "waiting" the moment Send is pressed, but the measuring and
    the copy of the project take seconds after that. Nothing can have landed
    for a round nobody has heard of yet, so the loop leaves "Changes are in"
    and the marker alone until then; otherwise "applied" could go out before
    "round", with no files and a watcher left running.
  */
  let opening = false;

  // The user finished a round of comments and wants them acted on.
  await page.exposeFunction('__aynaDone', async () => {
    round += 1;
    phase = 'awaiting-claude';
    opening = true;
    try {
      baseline = null;
      pickedUp = false;
      roundNotes.set(round, comments.filter((c) => c.status !== 'approved').map((c) => c.id));
      // Read before anyone edits, and before Claude hears there is anything to do.
      roundEdits.clear();
      const [before, snapshot] = await Promise.all([
        // The page's two measurements share it, so they go one after the other.
        (async () => {
          appearance = await appearanceOf();
          return Promise.race([countFaults(), new Promise((r) => setTimeout(() => r(null), 3000))]);
        })().catch(() => null),
        projectDir
          ? snapshotProject(projectDir, { skipDirs: SKIP_DIRS, textExt: TEXT_EXT }).catch(() => null)
          : null,
        // Markers left from an earlier round are not news about this one.
        rm(appliedFile, { force: true }),
        rm(pickedUpFile, { force: true }),
      ]);
      // Uncompared is still honest; the gate reports totals as it always has.
      if (before && !before.unavailable) baseline = { url: page.url(), counts: before.counts };
      roundSnapshot = snapshot;
      watchProject();
      await writeManifest();
      await writeStatus();
      emit({
        event: 'round',
        round,
        comments: comments.length,
        open: comments.filter((c) => c.status !== 'approved').length,
        // Which notes this round carries, including ones from earlier windows, so
        // the round is not called approved while any of them is still unjudged.
        notes: comments
          .filter((c) => c.status !== 'approved' && noteKey(c))
          .map((c) => ({ taskId: noteKey(c), comment: c.comment })),
        commentsFile,
        action: 'read-comments',
      });
    } finally {
      opening = false;
    }
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
        const { eventsSince, windowEventsSince } = await import('./db.mjs');
        return tabId
          ? windowEventsSince(store.db, tabId, Number(since) || 0, 200)
          : eventsSince(store.db, Number(since) || 0, 200);
      } catch {
        // Fall through to the mirror rather than leaving the panel blank.
      }
    }
    return feed.filter((e) => e.seq > (Number(since) || 0));
  });

  /*
    A note's crop, for its line in the activity.

    The words of a note are half of it; the other half is what it pointed at,
    and the crop is already on disk with the task. Handed over as a data URL
    because the page cannot read the project's files, and capped so one huge
    framed region cannot stall the rail.
  */
  await page.exposeFunction('__aynaCrop', async (taskId) => {
    if (!store) return null;
    try {
      const file = (await store.get(String(taskId)))?.regionScreenshot;
      if (!file) return null;
      const buf = await readFile(file);
      return buf.length > 512 * 1024 ? null : 'data:image/png;base64,' + buf.toString('base64');
    } catch {
      return null;
    }
  });

  /*
    Take a round back.

    Rejecting a change does not undo it: "Needs work" asks for another attempt
    on top of the one that missed, and the only way back to before was git, by
    hand, outside the window. This restores exactly the files the round
    changed, refuses if any of them has been edited since (see undoChanges),
    and reopens the notes the round carried, because what they asked for is
    still not done.

    Not while Claude is working: a round in flight is writing the same files.
  */
  await page.exposeFunction('__aynaUndo', async (key) => {
    const n = roundOf(key);
    if (n === null) return { ok: false, reason: 'that round was in an earlier window' };
    const changes = roundFiles.get(n);
    if (!changes?.length) return { ok: false, reason: 'nothing to undo' };
    if (phase === 'awaiting-claude') return { ok: false, reason: `Claude is working on round ${round}` };

    const before = await appearanceOf();
    const result = await undoChanges(projectDir, changes);
    if (!result.ok) return result;
    roundFiles.delete(n);

    // Nothing is left on the page to judge. The overlay switches itself, but
    // the window's own phase must not depend on that call coming back.
    if (phase === 'reviewing') {
      phase = 'commenting';
      await rm(appliedFile, { force: true });
    }

    for (const id of roundNotes.get(n) ?? []) {
      const c = comments.find((x) => x.id === id);
      if (!c || c.status === 'open') continue;
      c.rounds.push({ round: n, status: 'open', via: 'undo' });
      await setStatus(c, 'open', `round ${n} undone`);
    }
    await writeManifest();
    await writeStatus();
    emit({ event: 'undone', round: n, files: result.restored, action: 'files-reverted' });

    /*
      Let the page show it. A dev server with hot reload already has; a static
      one needs the reload. Same signature test as after a round, after a
      moment for the dev server to notice — and not awaited, because the call
      that asked for this is running inside the page being reloaded.
    */
    setTimeout(async () => {
      if (page.isClosed()) return;
      const after = await appearanceOf();
      if (before && after && before.rules === after.rules) {
        // The load handler puts the overlay back.
        await reloadSettled(page).catch(() => {});
      }
    }, 1500);
    return { ok: true, restored: result.restored };
  });

  // One file's diff from one round, as lines for the panel. See rounds.mjs.
  // Asked for by the round's key, like undo, so an earlier process's card
  // cannot be shown this process's round of the same number.
  await page.exposeFunction('__aynaDiff', async (key, file) => {
    const change = roundFiles.get(roundOf(key))?.find((c) => c.file === file);
    return change?.ops ? hunks(change.ops) : null;
  });

  /*
    One line for everything before this window.

    Scoping the activity to this window must not make earlier work disappear —
    a note left open last time is still owed, and it is what the user most
    needs to know about the past. So the panel says how many windows came
    before and how much they left open, and the Tasks list has the detail.

    "Before" is when this process attached, not when its tab was first opened:
    a resumed session reuses an old tab, and measuring from that tab's birth
    lost every window opened in between. This tab's own earlier notes are left
    out, because its activity already replays them.
  */
  const attachedAt = Date.now();
  await page.exposeFunction('__aynaEarlier', async () => {
    if (!store?.db || !tabId) return { windows: 0, open: 0 };
    try {
      const { windows } = store.db
        .prepare('SELECT COUNT(*) AS windows FROM tabs WHERE id <> ? AND opened_at < ?')
        .get(tabId, attachedAt);
      const { isPending } = await import('./tasks.mjs');
      // Raised before this window, by any other window or none, and not yet settled.
      const open = (await store.list()).filter(
        (t) => isPending(t) && t.tabId !== tabId && Date.parse(t.createdAt) < attachedAt,
      ).length;
      return { windows, open };
    } catch {
      return { windows: 0, open: 0 };
    }
  });

  /*
    Who else is working on this, and on what.

    A task carries the name of whoever claimed it and when the claim expires, so
    the window can say "worker-1 has task-0003" without anything new being
    tracked. It matters because a review is no longer one person and one Claude:
    another session, a worker, or a different tool entirely can be holding a task
    while you are looking at the page it belongs to, and the alternative to
    showing that is two of you doing the same job.
  */
  /*
    Who will hear a round, as far as anything can show it.

    "Waiting for Claude" was said to every round, and "Claude working" shown
    with it, whether or not any Claude was there: a window started from a plain
    terminal waited for minutes on a round nothing would ever read. An agent is
    attached in one of three ways, and each leaves a trace — it opened this
    window and reads what it prints; it is following the window with `ayna
    wait` or `ayna applied`, which keep a heartbeat; or it has read the round's
    notes. Counting only one of them would cry wolf at the other two.

    'unknown' without a database: there is nowhere for a heartbeat to be.
  */
  const listenerOf = () => {
    if (pickedUp) return 'picked-up';
    if (opener && opener.how !== 'none') return 'opener';
    if (!store?.db) return 'unknown';
    try {
      const at = store.db.prepare("SELECT MAX(seen_at) AS at FROM cursors WHERE consumer LIKE 'listen:%'").get()?.at;
      if (at && Date.now() - at < 10_000) return 'following';
    } catch {
      return 'unknown';
    }
    return 'none';
  };
  await page.exposeFunction('__aynaListening', async () => (phase === 'awaiting-claude' ? listenerOf() : null));

  await page.exposeFunction('__aynaAgents', async () => {
    if (!store) return [];
    const now = Date.now();
    const tasks = await store.list().catch(() => []);
    const busy = new Map();
    for (const t of tasks) {
      if (!t.claimedBy || (t.claimExpiresAt && t.claimExpiresAt < now)) continue;
      if (!busy.has(t.claimedBy)) busy.set(t.claimedBy, { agent: t.claimedBy, tasks: [] });
      busy.get(t.claimedBy).tasks.push({ id: t.id, comment: t.comment, status: t.status });
    }
    // Claude is shown only when something says it is there: see listenerOf.
    const heard = phase === 'awaiting-claude' ? listenerOf() : null;
    if (heard && heard !== 'none' && heard !== 'unknown') {
      const mine = busy.get('claude') ?? { agent: 'claude', tasks: [] };
      mine.working = heard === 'picked-up';
      mine.listening = heard !== 'picked-up';
      busy.set('claude', mine);
    }
    return [...busy.values()];
  });

  await page.exposeFunction('__aynaSay', async (text) => {
    const said = String(text ?? '').trim();
    if (!said) return { ok: false };
    // Just emit: that writes to the log, the mirror and the stream. Writing here
    // as well was a second data path, and it showed — every line the user typed
    // appeared twice in the panel they typed it into.
    emit({ event: 'message', from: 'user', text: said, action: 'read-and-reply' });
    return { ok: true };
  });

  /*
    "Make this bolder" as a button rather than a sentence.

    The overlay offers a short list of directions — impeccable's vocabulary,
    which is a good one — and this is how pressing one reaches an agent. It
    emits a request and nothing else: no edit, no file written, no preview
    conjured here. The answer is expected to come back as `ayna preview`, which
    renders variants in this same window and leaves the source alone until the
    user keeps one.

    That indirection is deliberate. ayna does not generate designs; the agent
    already reading this log has the codebase and the taste references open, and
    it is the better author. What it was missing was a way to be asked.
  */
  await page.exposeFunction('__aynaDesignRequest', async (req) => {
    const action = String(req?.action ?? '').trim();
    if (!action) return { ok: false };

    emit({
      event: 'design-request',
      action,
      note: req.note ?? null,
      selector: req.selector ?? null,
      url: req.url ?? url,
      rect: req.rect ?? null,
      html: req.html ?? null,
      styles: req.styles ?? null,
      // Said plainly, because an agent reading this must not go and edit a file.
      wants: 'css-variants',
      respondWith: 'ayna preview --selector <sel> --css <css> --label <label>',
      action_hint:
        `Offer three variants for "${action}" on ${req.selector ?? 'the selection'} — ` +
        'vary a different axis in each, keep the existing identity, and write nothing to source.',
    });
    return { ok: true };
  });

  /*
    A verdict on something the user could see before it was written.

    Every other path here edits the source first and asks afterwards, which makes
    "no, not that" expensive: the change already happened, and rejecting it does
    not undo it. A preview is CSS applied in the page and nowhere else, so the
    answer arrives before anything is committed to a file — and a rejected one
    costs a stylesheet being removed.
  */
  await page.exposeFunction('__aynaPreviewChoice', async (id, index, accepted, css, label) => {
    emit({
      event: accepted ? 'preview-accepted' : 'preview-rejected',
      previewId: id,
      variant: index,
      label: label ?? null,
      css: accepted ? css : null,
      action: accepted ? 'write-this-to-source' : 'try-something-else',
    });
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
      if (store && c.taskId) await store.update(c.taskId, { comment: note, status: 'open', source: 'user' }, 'redirected by the user', { tabId });
      emit({ event: 'task', id: c.taskId ?? id, status: 'open', comment: note, action: 'do-this-instead' });
    } else if (verdict === 'approve') {
      c.status = 'open'; // approved to go ahead, not approved as done
      if (store && c.taskId) await store.update(c.taskId, { status: 'open' }, 'user approved the proposal', { tabId });
      emit({ event: 'task', id: c.taskId ?? id, status: 'open', comment: c.comment, action: 'go-ahead' });
    } else {
      c.status = 'approved'; // declined and settled; nothing to do
      if (store && c.taskId) await store.update(c.taskId, { status: 'approved' }, 'user declined the proposal', { tabId });
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
    /*
      The same verdict twice is one verdict.

      Pressing "Needs work" again on a note already sent back logged a second
      rejection — two "Sent back" lines in the activity, two entries in the
      comment's history, and a second retry request for the same attempt.
    */
    if (c.status === status) {
      return { ok: true, status, open: comments.filter((x) => x.status !== 'approved').length };
    }
    c.rounds.push({ round, status });
    await setStatus(c, status);
    await writeManifest();
    await writeStatus();
    if (status === 'rejected') {
      emit({ event: 'rejected', id: c.id, comment: c.comment, commentsFile, action: 'retry-rejected' });
    }
    return { ok: true, status, open: comments.filter((x) => x.status !== 'approved').length };
  });

  // They're happy — this is the only thing that closes the window.
  /*
    Closing is not a verdict.

    This used to mark every unjudged comment resolved, which meant one click
    silently signed off work nobody had looked at. A task you have not approved
    stays pending — it survives the window closing and is still waiting next
    time. Each one is approved on its own marker, deliberately.
  */
  let closingTimer = null;
  const finish = async () => {
    clearTimeout(closingTimer);
    closingTimer = null;
    if (done) return;
    phase = 'approved';
    done = true;
    await writeManifest();
    await writeStatus();
    emit({ event: 'closed', approved: true, commentsFile });
  };
  await page.exposeFunction('__aynaApprove', finish);

  /*
    The close countdown: a moment and a half the user can take back.

    It is kept here, not in the page. A timer in the page died with any reload
    in that moment — a dev server's full reload, the overlay reloading itself —
    and the user had pressed Close but the window never closed; a scripted
    review waited on it forever. The page only draws the countdown and says
    when Stay open cancels it. The chrome comes off the page before the end,
    bounded, because the page may be the one mid-reload.
  */
  await page.exposeFunction('__aynaClosing', async (on) => {
    clearTimeout(closingTimer);
    closingTimer = on
      ? setTimeout(async () => {
          await Promise.race([
            page.evaluate(() => window.__aynaCleanup?.()).catch(() => {}),
            new Promise((r) => setTimeout(r, 1000)),
          ]);
          await finish().catch(() => {});
        }, 1500)
      : null;
  });

  // Approving everything is now a deliberate button of its own, never a side
  // effect of closing.
  await page.exposeFunction('__aynaApproveAll', async () => {
    let n = 0;
    for (const c of comments) {
      if (c.status !== 'approved') {
        c.rounds.push({ round, status: 'approved', via: 'approve-all' });
        await setStatus(c, 'approved');
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
    // Lets the activity tell a note made here from one filed from elsewhere.
    tab: tabId,
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
  /*
    The theme is set on the page, not baked into the stylesheet, so a project can
    say what ayna should look like in its own config and everything unset keeps
    the default.
  */
  const applyTheme = async () => {
    if (!theme) return;
    await page
      .evaluate((t) => {
        for (const [k, v] of Object.entries(t)) {
          if (typeof v === 'string') document.documentElement.style.setProperty('--ayna-' + k, v);
        }

        /*
          Work out what colour text belongs on each of those, rather than
          assuming white.

          A brand colour is often bright — kormoOS's is #ccfe05, where white text
          measures 1.18:1 and is simply not readable. Hardcoding white meant any
          light accent produced invisible buttons, so the theme would look
          "applied" and be unusable. The luminance decides, the same arithmetic
          ayna uses to judge everyone else's contrast.
        */
        const luminance = (hex) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
          if (!m) return null;
          const ch = [0, 2, 4]
            .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
            .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
          return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        };

        /*
          Whichever ink actually reads better, measured, not a luminance cut-off.

          The cut-off was 0.4, on the belief that black overtakes white there.
          It overtakes at about 0.18 — where (L+0.05)/0.05 meets 1.05/(L+0.05).
          ayna's own accent sits at 0.37, between the two, so every install got
          white on orange at 2.5:1 for its one call to action, and the active
          mode, which borrows this ink, went white on ivory and disappeared.
        */
        const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const INK_DARK = luminance('#0a0a0a');

        /*
          A light surface, and what has to follow it.

          The defaults were tuned for a near-black rail, so a white one turned
          the lane colours — the names that sign each line, the green of a
          clean check — into pastels at under 2:1, and the accent, used for
          labels as well as for the one call to action, into orange text at
          2.4:1. Any of them that cannot be read on the surface is walked
          toward the text colour until it can; one that already reads is left
          exactly as given. The accent keeps its own value for fills and gets
          a separate one for text. And a recessed well — the message box, a
          diff — is a shade below the surface, which over white is a whisper
          rather than the .32 black it is over the dark rail.
        */
        const rgb = (hex) => {
          const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
          return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
        };
        const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
        const ground = luminance(t.surface);
        const towards = rgb(t.text) ?? (ground !== null && ground > 0.5 ? [10, 10, 10] : [244, 242, 239]);
        const readable = (hex) => {
          const from = rgb(hex);
          if (!from || ground === null) return hex;
          for (let k = 0; k <= 1.0001; k += 0.05) {
            const mixed = hexOf(from.map((v, i) => v + (towards[i] - v) * k));
            if (ratio(luminance(mixed), ground) >= 4.5) return k === 0 ? hex : mixed;
          }
          return hexOf(towards);
        };
        for (const key of ['you', 'agent', 'ayna', 'good', 'warn', 'bad', 'live']) {
          if (typeof t[key] !== 'string') continue;
          const fixed = readable(t[key]);
          if (fixed !== t[key]) {
            t = { ...t, [key]: fixed };
            document.documentElement.style.setProperty('--ayna-' + key, fixed);
          }
        }
        if (typeof t.accent === 'string') {
          document.documentElement.style.setProperty('--ayna-accent-text', readable(t.accent));
        }
        if (ground !== null) {
          document.documentElement.style.setProperty('--ayna-well', ground > 0.5 ? 'rgba(0,0,0,.045)' : 'rgba(0,0,0,.32)');
        }

        for (const key of ['accent', 'good', 'bad', 'warn', 'live']) {
          const l = luminance(t[key]);
          if (l === null) continue;
          const dark = ratio(l, INK_DARK) >= ratio(l, 1);
          document.documentElement.style.setProperty('--ayna-on-' + key, dark ? '#0a0a0a' : '#ffffff');
        }
      }, theme)
      .catch(() => {});
  };

  const injectOverlay = async () => {
    await applyTheme();
    const src = await readFile(overlayFile, 'utf8').catch(() => null);
    if (src) await page.evaluate(src).catch(() => {});
  };
  page.on('load', injectOverlay);

  await gotoSettled(page, url);
  await injectOverlay();

  /*
    Only watch the overlay when someone is working on ayna itself.

    This reloads the open window whenever src/overlay.js changes, which is a fine
    convenience while developing the overlay and indefensible anywhere else: an
    installed plugin is usually a symlink to a checkout, so editing ayna reset a
    user's page — their scroll, their canvas, their diagram — while they were in
    the middle of using it, for a change that had nothing to do with them. A
    checkout has a .git beside it; an install does not.
  */
  const devCheckout =
    process.env.AYNA_DEV === '1' ||
    existsSync(path.join(path.dirname(path.dirname(overlayFile)), '.git'));

  let reloading = false;
  const overlayWatcher = devCheckout ? watch(overlayFile, async () => {
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
  }) : null;

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
    /*
      Measure without moving anything.

      Handing the reserved space back for the length of a measurement did give
      honest bounds, and it did it by resizing the page twice — so every comment
      and every gate made the app snap to full height, flash black where the
      console had been, and snap back. Nobody will accept a flicker on every
      click in exchange for tidier arithmetic.

      The bounds are corrected in the page script instead, from the insets the
      overlay publishes. Nothing moves; the checks simply know that the top and
      bottom strips are not the app's.
    */
    const measureApp = async (script) => page.evaluate(script);

    if (existsSync(auditRequest)) {
      await rm(auditRequest, { force: true });
      try {
        const { CHECKS, scoreFindings } = await import('./audit.mjs');
        const raw = await measureApp(CHECKS);
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

    if (phase === 'awaiting-claude' && existsSync(pickedUpFile)) {
      await rm(pickedUpFile, { force: true });
      if (!pickedUp) {
        pickedUp = true;
        emit({ event: 'picked-up', round });
      }
    }

    if (phase === 'awaiting-claude' && !opening && (existsSync(appliedFile) || editsSettled || saidApplied)) {
      const reason = existsSync(appliedFile) ? 'marker' : saidApplied ? 'user' : 'file-change';
      saidApplied = false;
      stopWatchingProject();
      await rm(appliedFile, { force: true });

      /*
        Do not reload a page that has already updated itself.

        The reload exists to make a fix visible. An app with hot reloading has
        shown it before ayna gets here, so the reload is pure loss: it throws
        away everything the browser was holding — a canvas viewport, a zoom
        level, an open diagram, unsaved edits — and none of that comes back from
        a scroll position. Restoring scroll never helped anyone reviewing a
        canvas, because their place was never scroll.

        The signature is taken before the round is sent and compared now. Style
        text and element count are what a UI fix changes and what animation and
        incoming data do not, so a difference means the page moved on its own.

        Decided before announcing, so the announcement can say which happened.
        It used to go out twice for a hot-reloaded page — once before the check
        and again with `reloaded: false` — and every reader saw it land twice.
      */
      const signature = await appearanceOf();
      const changedItself =
        appearance && signature && appearance.rules === signature.rules
          ? false
          : Boolean(appearance && signature);

      /*
        Which files the round changed, with the counts, so the person judging it
        can see what was done instead of taking "landed" on trust. The diffs are
        kept here for the panel to ask for; the event carries only the list.
      */
      const changes = roundSnapshot ? await roundChanges(roundSnapshot, roundEdits).catch(() => []) : [];
      roundFiles.set(round, changes);
      roundSnapshot = null;
      roundEdits.clear();
      emit({
        event: 'applied',
        round,
        key: roundKey(round),
        via: reason,
        reloaded: !changedItself,
        files: changes.map(({ file, status, added, removed }) => ({ file, status, added, removed })),
      });

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

        if (!changedItself) {
          await reloadSettled(page);
          if (at && (at.x || at.y)) {
            await page.evaluate((p) => scrollTo(p.x, p.y), at).catch(() => {});
          }
        }
        // The overlay is injected per load and that is asynchronous — without
        // waiting for it, __aynaReview fires into a page that has no overlay yet
        // and the review markers never appear.
        await injectOverlay();
        await page.evaluate(() => window.__aynaReview && window.__aynaReview());
        phase = 'reviewing';
        // Published the moment it changes. The gate below takes a beat, and
        // anything asking what phase this window is in was being told the old
        // answer for as long as the measurement ran.
        await writeStatus();

        /*
          Check the claim before the user is asked to judge it.

          "Done" is a prediction until something looks. ayna has had the
          apparatus to look since the audit existed and never pointed it at this
          moment — the one moment where somebody has just asserted that a UI
          problem is fixed. So the measurable checks run the instant changes
          land, and the answer goes on the page next to the changes themselves.

          It gates nothing shut. The verdict is still the user's, and a fault
          that remains is information they should have before giving it, not a
          reason to refuse them the choice.
        */
        try {
          const { counts, serious, unavailable } = await countFaults();
          /*
            `before` is the page when the round was sent and `added` is what is
            new since, per check. Only when it is the same page: a user who
            browsed elsewhere while waiting is looking at different faults, and
            subtracting one page's count from another's is not a comparison.
          */
          const compared = !unavailable && baseline && samePage(baseline.url, page.url()) ? baseline.counts : null;
          emit({
            event: 'gate',
            round,
            clean: !unavailable && serious === 0,
            counts,
            before: compared,
            added: compared
              ? Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.max(0, n - (compared[k] ?? 0))]))
              : null,
            unavailable,
          });
        } catch (err) {
          // A gate that cannot run says so. Reporting it as clean would be the
          // one failure worse than not having it.
          emit({ event: 'gate', round, clean: false, unavailable: err.message.split('\n')[0] });
        }
      } catch {
        // A reload failure shouldn't strand the user — let them keep commenting.
        phase = 'commenting';
      }
      await writeStatus();
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  overlayWatcher?.close();
  stopWatchingProject();
  clearInterval(beat);
  if (sessions) {
    // Say it ended, rather than leaving the bookkeeper to infer it later.
    try {
      if (tabId) sessions.closeTab(tabId);
      if (sessionId) sessions.end(sessionId);
    } catch {
      // The sweep will reach the same conclusion from the heartbeat.
    }
  }

  const fullFile = path.join(outDir, 'full-page.png');
  if (!page.isClosed()) {
    // Same flinch as a region crop, and this fires while the window is still in
    // front of the user. When the page already fits, the viewport *is* the full
    // page, so ask for the expensive capture only when it would show more.
    const overflows = await page
      .evaluate(() => document.documentElement.scrollHeight > innerHeight + 4)
      .catch(() => true);
    await page.screenshot({ path: fullFile, fullPage: overflows, style: WITHOUT_CHROME }).catch(() => {});
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
