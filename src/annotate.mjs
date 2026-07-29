import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

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
        ['-rn', '--binary-files=without-match', '--exclude-dir=node_modules',
         '--exclude-dir=.git', '--exclude-dir=.ayna', '-F', needle, projectDir],
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

const SKIP_DIRS = new Set(['node_modules', '.git', '.ayna', 'dist', 'build', '.next', 'coverage']);
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
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
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
export async function runAnnotate({ browser, url, outDir, projectDir, viewport, onReady }) {
  await mkdir(outDir, { recursive: true });

  const context = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const comments = [];
  let nextId = 1;
  let done = false;

  await page.exposeFunction('__aynaSubmit', async (payload) => {
    const n = comments.length + 1;
    const dir = path.join(outDir, `comment-${String(n).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });

    // Crop the exact region the user pointed at, with a little breathing room.
    const pad = 12;
    const clip = {
      x: Math.max(0, payload.rect.x - pad),
      y: Math.max(0, payload.rect.y - pad),
      width: Math.max(8, payload.rect.width + pad * 2),
      height: Math.max(8, payload.rect.height + pad * 2),
    };
    const regionFile = path.join(dir, 'region.png');
    try {
      await page.screenshot({ path: regionFile, clip, fullPage: true });
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

  const writeStatus = () =>
    writeFile(
      statusFile,
      JSON.stringify(
        {
          phase,
          round,
          comments: comments.length,
          open: comments.filter((c) => c.status !== 'resolved').length,
          resolved: comments.filter((c) => c.status === 'resolved').length,
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

  // The user finished a round of comments and wants them acted on.
  await page.exposeFunction('__aynaDone', async () => {
    round += 1;
    phase = 'awaiting-claude';
    await writeManifest();
    await writeStatus();
  });

  // They looked at the result and want another pass.
  await page.exposeFunction('__aynaMore', async () => {
    phase = 'commenting';
    await rm(appliedFile, { force: true });
    await writeStatus();
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
    if (!c || !['resolved', 'rejected', 'open'].includes(status)) {
      return { ok: false };
    }
    c.status = status;
    c.rounds.push({ round, status });
    await writeManifest();
    await writeStatus();
    return { ok: true, status, open: comments.filter((x) => x.status !== 'resolved').length };
  });

  // They're happy — this is the only thing that closes the window.
  await page.exposeFunction('__aynaApprove', async () => {
    /*
      Approving the session means approving what's left. Without this, closing via
      the global button left every comment 'open' and the resolved history empty —
      the record of what changed would show nothing changed. Anything explicitly
      rejected keeps that verdict; it was a deliberate judgement.
    */
    for (const c of comments) {
      if (c.status === 'open') {
        c.status = 'resolved';
        c.rounds.push({ round, status: 'resolved', via: 'approve-all' });
      }
    }
    phase = 'approved';
    done = true;
    await writeManifest();
    await writeStatus();
  });

  const overlay = await readFile(new URL('./overlay.js', import.meta.url), 'utf8');
  await page.addInitScript(overlay);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

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
    if (phase === 'awaiting-claude' && existsSync(appliedFile)) {
      await rm(appliedFile, { force: true });
      // Anything the user sent back for another attempt has now had one, so it
      // returns to the pile to be judged again rather than staying "rejected".
      for (const c of comments) {
        if (c.status === 'rejected') c.status = 'open';
      }
      try {
        await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
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

  const fullFile = path.join(outDir, 'full-page.png');
  if (!page.isClosed()) {
    await page.screenshot({ path: fullFile, fullPage: true }).catch(() => {});
    await context.close().catch(() => {});
  }

  phase = done ? 'approved' : 'closed';
  await writeStatus();

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
