import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openDb, eventsSince, latestSeq } from './db.mjs';
import { openStore, isPending, STATUSES } from './tasks.mjs';
import { STALE_AFTER } from './sessions.mjs';
import { DEFAULT_THEME } from './config.mjs';
import { themeTokens, flatten, mix, contrast, luminance } from './theme.mjs';

/**
 * Everything the store knows, as one page somebody can read.
 *
 * The database holds the whole story — every comment, every status a task moved
 * through, who claimed what, what the window and the agents said to each other —
 * and the only other ways to see it are a terminal list, raw JSON, or a task
 * panel that shows the page currently open. None of those answer the questions a
 * person has after a few days of reviews: what is still owed, what is stuck,
 * which page is worst, what keeps being sent back.
 *
 * It is a static file, not a server: it reads the store and writes one HTML page
 * with its styles and script inline, so it opens from disk, works offline, adds
 * no dependency and cannot change a task. Opened from a review window it is
 * live — the window hands it two functions, and it rewrites and reloads itself
 * when the store moves. Opened from the CLI it is a snapshot, and says so.
 *
 * It wears the review window's own material: the `Ayna` theme is painted from
 * the same tokens (src/theme.mjs), and `Light` is a quiet GitHub-like paper for
 * anyone who wants one. The page passes ayna's own audit in both.
 */

/** How each status reads, and which colour it borrows. */
export const STATUS = {
  proposed: { label: 'Proposed', tone: 'agent', hint: 'Found by a tool or an agent — waiting for your go-ahead' },
  open: { label: 'Open', tone: 'neutral', hint: 'Waiting to be worked on' },
  in_progress: { label: 'In progress', tone: 'live', hint: 'An agent is working on it' },
  applied: { label: 'Applied', tone: 'you', hint: 'Changed — waiting for your review' },
  needs_confirmation: { label: 'Needs confirmation', tone: 'warn', hint: 'verify could not settle it — it needs your word' },
  rejected: { label: 'Rejected', tone: 'bad', hint: 'Sent back for another attempt' },
  approved: { label: 'Approved', tone: 'good', hint: 'You accepted the change' },
  obsolete: { label: 'Obsolete', tone: 'ayna', hint: 'verify found the fault gone' },
};

const labelOf = (s) => STATUS[s]?.label ?? String(s ?? 'unknown');
const toneOf = (s) => STATUS[s]?.tone ?? 'neutral';
const hintOf = (s) => STATUS[s]?.hint ?? '';

/** What a task's history says, one step at a time. */
const STEP = {
  proposed: 'Proposed',
  open: 'Reopened',
  in_progress: 'Picked up',
  applied: 'Changed — waiting for your review',
  approved: 'Approved',
  rejected: 'Sent back',
  needs_confirmation: 'Needs your word',
  obsolete: 'Closed by verify — the fault is gone',
};
const FIRST_STEP = { open: 'Raised', proposed: 'Proposed', needs_confirmation: 'Raised — needs your word' };

/** Where a task lives, in a form that groups: one row per page, not per hash. */
export function pageOf(url) {
  if (!url) return { key: '', label: 'No page recorded', host: null };
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}` || '/';
    return { key: `${u.origin}${p}`, label: p, host: u.host };
  } catch {
    return { key: url, label: url, host: null };
  }
}

/**
 * Why a task needs a person, or null when it does not.
 *
 * Ranked by who is blocked: something applied or unsettled is waiting on the
 * user's eye right now, a rejection is waiting on an agent, and a proposal is
 * only a suggestion. A task in progress is fine while somebody holds a live
 * claim on it, and stuck the moment nobody does.
 */
export function attentionFor(task, now = Date.now()) {
  switch (task.status) {
    case 'needs_confirmation':
      return { rank: 0, why: 'verify could not settle it — it needs your word' };
    case 'applied':
      return { rank: 1, why: 'changed, and waiting for your review' };
    case 'rejected':
      return { rank: 2, why: 'sent back — waiting for another attempt' };
    case 'in_progress':
      if (!task.claimedBy) return { rank: 3, why: 'marked in progress, but nobody holds it' };
      if (task.claimExpiresAt && task.claimExpiresAt < now) {
        return { rank: 3, why: 'its claim expired — nobody is working on it' };
      }
      return null;
    case 'proposed':
      return { rank: 4, why: 'waiting for your go-ahead' };
    default:
      return null;
  }
}

const quote = (s, n = 140) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

const short = (id) => {
  const s = String(id ?? '');
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The audit's check names, as the rail says them. */
const FAULT = {
  covered: ['covered control', 'covered controls'],
  offscreen: ['cut off at the edge', 'cut off at the edge'],
  overlaps: ['overlap', 'overlaps'],
  clipped: ['clipped text', 'clipped texts'],
  lowContrast: ['low-contrast text', 'low-contrast texts'],
  noFocusIndicator: ['missing focus ring', 'missing focus rings'],
  faintFocusIndicator: ['faint focus ring', 'faint focus rings'],
  unlabelled: ['unlabelled control', 'unlabelled controls'],
  smallTargets: ['small tap target', 'small tap targets'],
  tinyText: ['text under 12px', 'texts under 12px'],
};
const faults = (counts) =>
  Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(FAULT[k] ?? [k, k])[n === 1 ? 0 : 1]}`)
    .join(' · ');
const sum = (counts) => Object.values(counts ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);

/** Signed the way the rail signs its lines. */
const WHO = { you: 'You', claude: 'Claude', ayna: 'Ayna' };

/**
 * One line of activity: what happened, the detail under it, its colour, and who
 * did it. Unknown events still read as something rather than vanishing.
 */
export function describeEvent(e) {
  const id = e.taskId ?? e.id ?? '';
  switch (e.event) {
    case 'task':
      if ('comment' in e) return { text: `New task ${id}`, detail: quote(e.comment), tone: toneOf(e.status), who: null };
      return { text: `${id} moved to ${labelOf(e.status)}`, detail: quote(e.note), tone: toneOf(e.status), who: null };
    case 'round':
      return {
        text: e.round ? `Round ${e.round} sent` : 'Round sent',
        detail: e.comments != null ? plural(e.comments, 'note') : '',
        tone: 'you',
        who: WHO.you,
      };
    case 'picked-up':
      return { text: 'Picked up the round', detail: '', tone: 'agent', who: WHO.claude };
    case 'applied': {
      if (id) return { text: `${id} applied`, detail: quote(e.note), tone: 'you', who: WHO.claude };
      const files = Array.isArray(e.files) ? e.files : [];
      return {
        text: e.round ? `Round ${e.round} landed` : 'Changes landed',
        detail: files.length
          ? `${plural(files.length, 'file')} · ${files.slice(0, 3).map((f) => String(f.file ?? '').split(/[\\/]/).slice(-2).join('/')).join(', ')}${files.length > 3 ? ' …' : ''}`
          : '',
        tone: 'agent',
        who: WHO.claude,
      };
    }
    case 'gate': {
      if (e.unavailable) return { text: 'Could not measure the page', detail: quote(e.unavailable), tone: 'warn', who: WHO.ayna };
      if (e.added) {
        const added = sum(e.added);
        const before = sum(e.before);
        return added
          ? { text: `${plural(added, 'new fault')} since this round`, detail: faults(e.added), tone: 'warn', who: WHO.ayna }
          : { text: 'No new faults', detail: before ? `${before} already there` : '', tone: 'good', who: WHO.ayna };
      }
      const total = sum(e.counts);
      return e.clean || !total
        ? { text: 'No measurable faults', detail: '', tone: 'good', who: WHO.ayna }
        : { text: `${plural(total, 'fault')} on the page`, detail: faults(e.counts), tone: 'warn', who: WHO.ayna };
    }
    case 'undone': {
      const files = Array.isArray(e.files) ? e.files.length : 0;
      return { text: e.round ? `Round ${e.round} undone` : 'Round undone', detail: files ? `${plural(files, 'file')} restored` : '', tone: 'warn', who: WHO.you };
    }
    case 'rejected':
      return { text: 'Sent a change back', detail: quote(e.comment), tone: 'bad', who: WHO.you };
    case 'message': {
      const who = e.from === 'user' ? WHO.you : e.from === 'claude' ? WHO.claude : e.from ? e.from[0].toUpperCase() + e.from.slice(1) : 'Agent';
      return { text: 'Wrote', detail: quote(e.text, 220), tone: e.from === 'user' ? 'you' : 'agent', who };
    }
    case 'closed':
      return { text: e.approved ? 'Approved and closed the review' : 'Closed the review', detail: '', tone: e.approved ? 'good' : 'neutral', who: WHO.you };
    case 'audit': {
      const total = sum(e.counts);
      return e.clean || !total
        ? { text: 'Audit found nothing measurable', detail: '', tone: 'good', who: WHO.ayna }
        : { text: `Audit found ${plural(total, 'fault')}`, detail: faults(e.counts), tone: 'warn', who: WHO.ayna };
    }
    case 'preview': {
      const n = Array.isArray(e.variants) ? e.variants.length : 0;
      const sel = Array.isArray(e.selector) ? e.selector.join(', ') : e.selector;
      return { text: `Offered ${n ? plural(n, 'variant') : 'variants'} to try`, detail: quote(sel), tone: 'agent', who: WHO.claude };
    }
    case 'preview-timeout':
      return { text: 'A preview went unanswered', detail: '', tone: 'neutral', who: WHO.ayna };
    case 'design-request':
      return { text: 'Asked for a direction', detail: quote(e.direction ?? e.ask ?? ''), tone: 'you', who: WHO.you };
    case 'tab-opened':
      return { text: 'Review window opened', detail: e.url ? pageOf(e.url).label : '', tone: 'neutral', who: null };
    case 'tab-closed':
      return { text: 'Review window closed', detail: '', tone: 'neutral', who: null };
    case 'claimed':
      return { text: `${id} claimed`, detail: e.by ? `by ${short(e.by)}` : '', tone: 'live', who: null };
    case 'working':
      return { text: `Work started on ${id}`, detail: quote(e.comment), tone: 'live', who: null };
    case 'failed':
      return { text: `${id} failed`, detail: quote(e.why), tone: 'bad', who: null };
    default:
      return { text: String(e.event ?? 'event').replace(/[-_]/g, ' '), detail: id || '', tone: 'neutral', who: null };
  }
}

/** Housekeeping the log keeps for machines; nobody reading activity wants it. */
const QUIET_EVENTS = new Set([
  'ready', 'swept', 'pruned', 'leases-expired', 'edits', 'session-started', 'session-ended',
  'session-died', 'tab-claimed', 'released', 'skipped',
  // The window says `closed` itself, with whether it was approved; the
  // bookkeeper's `tab-closed` for the same moment would only say it twice.
  'tab-closed',
]);

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * Activity, grouped into what a person thinks in: one box per task, telling its
 * whole history, and one per review window for the rounds, messages and checks
 * that happened in it. Anything addressed to no window is kept per day.
 */
export function groupActivity({ tasks = [], events = [], tabs = [] } = {}) {
  const boxes = new Map();
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  for (const t of tasks) {
    const steps = (t.history ?? [])
      .map((h, i) => ({
        at: Date.parse(h.at),
        text: i === 0 ? FIRST_STEP[h.status] ?? `Raised as ${labelOf(h.status)}` : STEP[h.status] ?? labelOf(h.status),
        detail: h.note ?? '',
        tone: toneOf(h.status),
        who: null,
      }))
      .filter((s) => Number.isFinite(s.at));
    if (!steps.length) continue;
    boxes.set(`task:${t.id}`, {
      key: `task:${t.id}`,
      kind: 'task',
      taskId: t.id,
      status: t.status,
      title: quote(t.comment, 120) || '(no comment)',
      label: quote(t.comment, 120) || '(no comment)',
      sub: `${t.id} · ${pageOf(t.url).label}`,
      steps,
      latestAt: Math.max(...steps.map((s) => s.at)),
    });
  }

  /*
    `ayna say` and `ayna preview` file their events under no window: they cannot
    know which one is open. The rail shows them in the window that was open when
    they were said, so the dashboard does too — an untagged event inside a
    window's lifetime belongs to that window. One never marked closed is taken
    to have ended half an hour after the last thing filed under it, so a window
    that crashed does not adopt everything said for days afterwards.
  */
  const lastTagged = new Map();
  for (const e of events) if (e.tabId) lastTagged.set(e.tabId, Math.max(lastTagged.get(e.tabId) ?? 0, e.at));
  const windowAt = (at) => {
    let best = null;
    for (const t of tabs) {
      if (!Number.isFinite(t.openedAt) || t.openedAt > at) continue;
      const end = t.closedAt ?? Math.max(t.openedAt, lastTagged.get(t.id) ?? 0) + 30 * 60_000;
      if (at <= end && (!best || t.openedAt > best.openedAt)) best = t;
    }
    return best?.id ?? null;
  };

  for (const e of events) {
    // A task tells its own story from its history; its events would repeat it.
    if (QUIET_EVENTS.has(e.event) || e.event === 'task' || e.taskId) continue;
    const tabId = e.tabId ?? windowAt(e.at);
    const key = tabId ? `tab:${tabId}` : `day:${dayKey(e.at)}`;
    let box = boxes.get(key);
    if (!box) {
      const tab = tabId ? tabById.get(tabId) : null;
      const where = tab?.url ? pageOf(tab.url).label : '';
      box = tabId
        ? { key, kind: 'window', title: where || 'Review window', label: where ? `Review of ${where}` : 'Review window', sub: '', steps: [], latestAt: 0 }
        : { key, kind: 'other', title: 'Between reviews', label: 'Between reviews', sub: 'Said or offered while no review window was open', steps: [], latestAt: 0 };
      boxes.set(key, box);
    }
    const d = describeEvent(e);
    box.steps.push({ at: e.at, text: d.text, detail: d.detail, tone: d.tone, who: d.who });
    box.latestAt = Math.max(box.latestAt, e.at);
  }

  for (const b of boxes.values()) {
    b.steps.sort((x, y) => x.at - y.at);
    if (b.kind === 'window') {
      const rounds = new Set(b.steps.map((s) => /^Round (\d+) sent$/.exec(s.text)?.[1]).filter(Boolean)).size;
      b.sub = [rounds ? plural(rounds, 'round') : '', plural(b.steps.length, 'step')].filter(Boolean).join(' · ');
    }
  }
  return [...boxes.values()].filter((b) => b.steps.length).sort((a, b) => b.latestAt - a.latestAt);
}

/**
 * When something happened, the way a person would say it.
 *
 * Written to run in the page as well as here — it is inlined into the page's
 * script with toString() — so it uses nothing outside itself.
 */
export function humanTime(ms, now = Date.now(), locale = 'en-GB') {
  if (!Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) {
    const m = Math.max(1, Math.round(diff / 60_000));
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  const d = new Date(ms);
  const n = new Date(now);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (days === 0) {
    const h = Math.floor(diff / 3_600_000);
    return h < 6 ? (h === 1 ? '1 hour ago' : `${h} hours ago`) : `Today at ${time}`;
  }
  if (days === 1) return `Yesterday at ${time}`;
  if (days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d)} at ${time}`;
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d);
  return d.getFullYear() === n.getFullYear() ? `${date} at ${time}` : `${date} ${d.getFullYear()}`;
}

/** Changes whenever anything the page shows could have changed. */
export function dashboardVersion(db) {
  const updated = db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS u FROM tasks').get()?.u ?? 0;
  return `${latestSeq(db)}:${updated}`;
}

/** Everything the page shows, gathered without writing to the store. */
export async function gatherDashboard(projectDir, { db: given, now = Date.now(), activityLimit = 400 } = {}) {
  const db = given ?? (await openDb(projectDir));
  try {
    return await collect(projectDir, db, now, activityLimit);
  } finally {
    /*
      A connection this opened is this one's to close. Left open, it held
      ayna.db and its -wal and -shm files for as long as the process lived — and
      on Windows an open file cannot be deleted or moved, so whatever tried to
      clean up after `ayna dashboard` failed with EBUSY. One handed in belongs to
      the caller: a review window keeps its own open for the whole review.
    */
    if (!given) db.close();
  }
}

async function collect(projectDir, db, now, activityLimit) {
  const store = await openStore(projectDir, { db });
  const tasks = await store.list();

  const counts = { total: tasks.length, pending: tasks.filter(isPending).length };
  for (const s of STATUSES) counts[s] = tasks.filter((t) => t.status === s).length;
  counts.waiting = counts.proposed + counts.applied + counts.needs_confirmation;
  counts.done = counts.approved + counts.obsolete;

  const rejections = (t) => (t.history ?? []).filter((h) => h.status === 'rejected').length;

  const attention = tasks
    .map((t) => ({ t, a: attentionFor(t, now) }))
    .filter((x) => x.a)
    .sort((x, y) => x.a.rank - y.a.rank || Date.parse(x.t.updatedAt) - Date.parse(y.t.updatedAt))
    .map(({ t, a }) => ({ id: t.id, why: a.why }));

  // Pages, worst first. The host is shown only when there is more than one.
  const groups = new Map();
  for (const t of tasks) {
    const p = pageOf(t.url);
    const g = groups.get(p.key) ?? { ...p, total: 0, pending: 0, done: 0, byStatus: {}, lastAt: 0 };
    g.total += 1;
    if (isPending(t)) g.pending += 1;
    else g.done += 1;
    g.byStatus[t.status] = (g.byStatus[t.status] ?? 0) + 1;
    g.lastAt = Math.max(g.lastAt, Date.parse(t.updatedAt) || 0);
    groups.set(p.key, g);
  }
  const hosts = new Set([...groups.values()].map((g) => g.host).filter(Boolean));
  const pages = [...groups.values()]
    .map((g) => ({ ...g, label: hosts.size > 1 && g.host ? `${g.host}${g.label}` : g.label }))
    .sort((a, b) => b.pending - a.pending || b.total - a.total || a.label.localeCompare(b.label));

  const sentBack = tasks
    .map((t) => ({ id: t.id, rejected: rejections(t), applied: (t.history ?? []).filter((h) => h.status === 'applied').length }))
    .filter((x) => x.rejected > 0)
    .sort((a, b) => b.rejected - a.rejected || b.applied - a.applied);

  // The newest events. Pruning removes the oldest, so the tail is contiguous.
  const latest = latestSeq(db);
  const events = eventsSince(db, Math.max(0, latest - activityLimit), activityLimit);
  const tabs = db
    .prepare('SELECT id, url, opened_at AS openedAt, closed_at AS closedAt FROM tabs')
    .all()
    .map((t) => ({ ...t }));
  const boxes = groupActivity({ tasks, events, tabs });

  // Every session the project has seen, not only the live ones: a session that
  // died holding a claim is exactly the one worth seeing.
  const claims = {};
  try {
    const rows = db
      .prepare("SELECT json_extract(payload, '$.by') AS who, COUNT(*) AS n FROM events WHERE event = 'claimed' GROUP BY who")
      .all();
    for (const r of rows) if (r.who) claims[r.who] = r.n;
  } catch {
    // No JSON functions in this SQLite build: claims stay uncounted, not wrong.
  }
  const agents = db
    .prepare('SELECT * FROM sessions ORDER BY heartbeat_at DESC LIMIT 50')
    .all()
    .map((s) => ({
      id: s.id,
      tool: s.tool,
      agentId: s.agent_id ?? null,
      state: s.status === 'live' ? (now - s.heartbeat_at > STALE_AFTER ? 'quiet' : 'live') : s.status,
      startedAt: s.started_at,
      lastSeenAt: s.ended_at ?? s.heartbeat_at,
      claims: claims[s.id] ?? 0,
      holding: tasks.filter((t) => t.claimedBy === s.id && (!t.claimExpiresAt || t.claimExpiresAt > now)).length,
    }));

  return {
    project: path.basename(path.resolve(projectDir)),
    generatedAt: now,
    version: dashboardVersion(db),
    counts,
    tasks: tasks.map((t) => ({ ...t, rejections: rejections(t) })),
    attention,
    pages,
    sentBack,
    boxes,
    agents,
  };
}

/* ────────────────────────────── the two palettes ────────────────────────────── */

const TONES = ['neutral', 'accent', 'you', 'agent', 'ayna', 'live', 'good', 'warn', 'bad'];
const hexOr = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? v : fallback);

/** `color`, walked toward `towards` until it reads at 4.5:1 on every ground. */
function ink(color, grounds, towards) {
  for (let k = 0; k <= 1.0001; k += 0.05) {
    const c = k === 0 ? color : mix(color, towards, k);
    if (grounds.every((g) => (contrast(c, g) ?? 0) >= 4.5)) return c;
  }
  return towards;
}

/**
 * Both palettes as plain colours. Solid hex wherever text is involved: ayna's
 * audit will not guess the contrast of translucent ink, and a page that wants
 * to be held to the 4.5:1 floor has to say what its colours really are.
 */
export function dashboardPalettes(theme) {
  const T = themeTokens({ ...DEFAULT_THEME, ...(theme ?? {}) });
  const surface = hexOr(flatten(T.surface, '#000000'), '#0a0a0b');
  const text = hexOr(flatten(T.text, surface), '#f4f2ef');
  const top = hexOr(flatten(T.bar, surface), surface);
  const raised = hexOr(flatten(T.panel, surface), mix(surface, text, 0.04));
  const raised2 = mix(raised, text, 0.045);
  const sel = mix(raised, text, 0.1);
  const grounds = [surface, top, raised, raised2, sel];
  const muted = ink(hexOr(flatten(T.muted, surface), mix(surface, text, 0.62)), grounds, text);
  const dim = ink(hexOr(flatten(T.dim, surface), mix(surface, text, 0.5)), grounds, text);
  const accent = hexOr(flatten(T.accent, surface), '#de9446');
  const scheme = (luminance(surface) ?? 0) > 0.5 ? 'light' : 'dark';

  const ayna = {
    bg: surface, top, side: surface, raised, 'raised-2': raised2, sel,
    line: T.line, 'line-2': T['panel-line'] ?? T.line,
    text, muted, dim,
    accent, 'accent-text': ink(hexOr(T['accent-text'], accent), grounds, text), 'on-accent': T['on-accent'] ?? '#0a0a0a',
    focus: accent, well: hexOr(flatten(T.well ?? 'rgba(0,0,0,.32)', raised), surface),
    'chip-bg': mix(raised, text, 0.08), 'chip-fg': text, 'code-bg': mix(raised, text, 0.08), 'code-fg': text,
    'seg-track': mix(top, text, 0.035),
  };
  const lanes = { neutral: muted, accent, you: T.you, agent: T.agent, ayna: T.ayna, live: T.live, good: T.good, warn: T.warn, bad: T.bad };
  for (const tone of TONES) {
    const c = hexOr(flatten(lanes[tone], surface), muted);
    const soft = mix(raised, c, 0.16);
    const fg = ink(c, grounds, text);
    Object.assign(ayna, {
      [`${tone}-dot`]: c,
      [`${tone}-fg`]: fg,
      // The rail's pill: an outline in the lane's colour, nothing filled.
      [`${tone}-pbg`]: 'transparent',
      [`${tone}-pline`]: mix(raised, c, 0.55),
      [`${tone}-pfg`]: fg,
      [`${tone}-soft`]: soft,
      [`${tone}-softfg`]: ink(c, [soft], text),
      [`${tone}-solid`]: soft,
      [`${tone}-on`]: ink(c, [soft], text),
    });
  }

  /*
    Light: GitHub's paper. White ground, a cool grey for what sits behind, one
    hairline, and colour only in status — soft labels in lists, a filled badge
    for the one status that heads a page.
  */
  const L = {
    bg: '#ffffff', top: '#ffffff', side: '#f6f8fa', raised: '#ffffff', 'raised-2': '#f6f8fa', sel: '#eef1f4',
    line: '#d8dee4', 'line-2': '#d1d9e0', text: '#1f2328', muted: '#59636e', dim: '#59636e',
    accent: '#0969da', 'accent-text': '#0969da', 'on-accent': '#ffffff', focus: '#0969da', well: '#f6f8fa',
    'chip-bg': '#ddf4ff', 'chip-fg': '#0969da', 'code-bg': '#eff2f5', 'code-fg': '#1f2328', 'seg-track': '#f6f8fa',
  };
  const LIGHT_TONES = {
    neutral: ['#59636e', '#eff2f5', '#59636e', '#818b98'],
    accent: ['#0969da', '#ddf4ff', '#0969da', '#0969da'],
    you: ['#9a6700', '#fff8c5', '#9a6700', '#bf8700'],
    agent: ['#8250df', '#fbefff', '#8250df', '#8250df'],
    ayna: ['#1b7c83', '#e3f6f5', '#1b7c83', '#1b7c83'],
    live: ['#0969da', '#ddf4ff', '#0969da', '#0969da'],
    good: ['#1a7f37', '#dafbe1', '#1f883d', '#1f883d'],
    warn: ['#bc4c00', '#fff1e5', '#bc4c00', '#e16f24'],
    bad: ['#d1242f', '#ffebe9', '#cf222e', '#cf222e'],
  };
  const lightGrounds = [L.bg, L.side, L.raised, L['raised-2'], L.sel];
  const light = { ...L };
  for (const [tone, [fg, soft, solid, dot]] of Object.entries(LIGHT_TONES)) {
    Object.assign(light, {
      [`${tone}-dot`]: dot,
      [`${tone}-fg`]: ink(fg, lightGrounds, L.text),
      [`${tone}-pbg`]: soft,
      [`${tone}-pline`]: soft,
      [`${tone}-pfg`]: ink(fg, [soft], L.text),
      [`${tone}-soft`]: soft,
      [`${tone}-softfg`]: ink(fg, [soft], L.text),
      [`${tone}-solid`]: solid,
      [`${tone}-on`]: (contrast('#ffffff', solid) ?? 0) >= 4.5 ? '#ffffff' : L.text,
    });
  }
  return { ayna: { scheme, vars: ayna }, light: { scheme: 'light', vars: light } };
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A path an <img> on this page can load, on any OS — Windows writes backslashes. */
export function assetUrl(file, fromDir) {
  if (!file) return null;
  return path.relative(fromDir, file).split(path.sep).map(encodeURIComponent).join('/');
}

const FULL = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** Absolute and exact in the markup; the page rewrites it as "2 hours ago". */
const when = (value, now) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '<span class="dim">—</span>';
  return `<time datetime="${new Date(ms).toISOString()}" data-human title="${esc(FULL.format(ms))}">${esc(humanTime(ms, now))}</time>`;
};

/** Just the clock, for a step on the same day as the one before it. */
const clock = (ms) =>
  `<time datetime="${new Date(ms).toISOString()}" data-human="clock" title="${esc(FULL.format(ms))}">${esc(CLOCK.format(ms))}</time>`;
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

const ICON = {
  overview: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  pages: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  agents: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

const pill = (status) =>
  `<span class="pill t-${toneOf(status)}" title="${esc(hintOf(status))}"><span class="dot" aria-hidden="true"></span>${esc(labelOf(status))}</span>`;

const sourceLabel = (c) => {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c.line ? `${c.file}:${c.line}` : String(c.file ?? '');
};

const VIEWS = [
  ['overview', 'Overview'],
  ['tasks', 'Tasks'],
  ['activity', 'Activity'],
  ['pages', 'Pages'],
  ['agents', 'Agents'],
];

function overview(d) {
  const c = d.counts;
  const now = d.generatedAt;
  const tile = (k, v, s) =>
    `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const present = STATUSES.filter((s) => c[s] > 0);
  const dist = c.total
    ? `<div class="dist">
        <div class="bar" role="img" aria-label="${esc(present.map((s) => `${c[s]} ${labelOf(s)}`).join(', '))}">${present
          .map((s) => `<span class="t-${toneOf(s)}" style="flex:${c[s]}"></span>`)
          .join('')}</div>
        <ul class="legend">${present
          .map((s) => `<li class="t-${toneOf(s)}"><span class="dot" aria-hidden="true"></span>${esc(labelOf(s))} <b>${c[s]}</b></li>`)
          .join('')}</ul>
      </div>`
    : '';

  const byId = new Map(d.tasks.map((t) => [t.id, t]));
  const attention = d.attention.slice(0, 5).map(({ id, why }) => {
    const t = byId.get(id);
    return `<a class="row" href="#tasks/${encodeURIComponent(id)}">
          <span class="dot t-${toneOf(t.status)}" aria-hidden="true"></span>
          <span><span class="title">${esc(quote(t.comment, 90) || '(no comment)')}</span><span class="meta">${esc(id)} · <b class="t-${toneOf(t.status)} status">${esc(labelOf(t.status))}</b> · ${esc(why)}</span></span>
          <span class="when">${when(t.updatedAt, now)}</span>
        </a>`;
  });
  const recent = d.boxes.slice(0, 5).map((b) => {
    const last = b.steps.at(-1);
    const href = b.kind === 'task' ? `#tasks/${encodeURIComponent(b.taskId)}` : '#activity';
    return `<a class="row" href="${href}">
          <span class="dot t-${last.tone}" aria-hidden="true"></span>
          <span><span class="title">${esc(b.label)}</span><span class="meta">${last.who ? `${esc(last.who)} · ` : ''}${esc(last.text)}</span></span>
          <span class="when">${when(last.at, now)}</span>
        </a>`;
  });

  return `
    <div class="tiles">
      ${tile('Outstanding', c.pending, `of ${plural(c.total, 'task')}`)}
      ${tile('Waiting on you', c.waiting, 'to approve, judge or allow')}
      ${tile('In progress', c.in_progress, 'claimed by an agent')}
      ${tile('Done', c.done, `${c.obsolete} closed by verify`)}
    </div>
    ${dist}
    <div class="cols">
      <section class="card" aria-labelledby="h-attention">
        <div class="card-head"><h2 id="h-attention">Needs attention</h2>${d.attention.length ? `<a class="link" href="#tasks">All ${d.attention.length}</a>` : ''}</div>
        ${attention.length ? attention.join('') : '<p class="empty">Nothing is stuck. Every open task has somebody on it.</p>'}
      </section>
      <section class="card" aria-labelledby="h-recent">
        <div class="card-head"><h2 id="h-recent">Recent activity</h2>${d.boxes.length ? '<a class="link" href="#activity">All activity</a>' : ''}</div>
        ${recent.length ? recent.join('') : '<p class="empty">Nothing has happened here yet.</p>'}
      </section>
    </div>`;
}

function taskRow(t, now) {
  const page = pageOf(t.url);
  const search = [t.id, t.comment, page.label, t.selector, labelOf(t.status)].join(' ').toLowerCase();
  return `<a class="task-row t-${toneOf(t.status)}" href="#tasks/${encodeURIComponent(t.id)}" data-task-row data-id="${esc(t.id)}" data-done="${isPending(t) ? '0' : '1'}" data-page="${esc(page.key)}" data-search="${esc(search)}">
          <span class="dot" aria-hidden="true"></span>
          <span class="body">
            <span class="title">${esc(quote(t.comment, 120) || '(no comment)')}</span>
            <span class="meta"><span class="mono">${esc(t.id)}</span><span class="sep" aria-hidden="true">·</span><span class="mono">${esc(page.label)}</span><span class="sep" aria-hidden="true">·</span>${when(t.updatedAt, now)}${t.rejections ? `<span class="tag">Sent back ${t.rejections}×</span>` : ''}</span>
          </span>
        </a>`;
}

function taskDetail(t, d, outDir) {
  const now = d.generatedAt;
  const page = pageOf(t.url);
  const crop = assetUrl(t.regionScreenshot, outDir);
  const atts = (t.attachments ?? []).map((a) => assetUrl(a, outDir));
  // The source scan can find one line through two needles; it is one place to look.
  const sources = [...new Set((t.sourceCandidates ?? []).map(sourceLabel).filter(Boolean))].slice(0, 5);
  const verdict = t.verdict?.verdict ? `${t.verdict.verdict}${t.verdict.why ? ` — ${t.verdict.why}` : ''}` : null;
  const props = [
    ['Status', `${esc(labelOf(t.status))} <span class="muted">— ${esc(hintOf(t.status))}</span>`],
    ['Page', t.url ? `<span class="chip" title="${esc(t.url)}">${esc(page.label)}</span>` : null],
    ['Element', t.selector ? `<code class="chip code">${esc(quote(t.selector, 160))}</code>` : null],
    ['Source', sources.length ? `<span class="stack">${sources.map((s) => `<code class="chip code">${esc(s)}</code>`).join('')}</span>` : null],
    ['Kind', t.kind ? esc(t.kind) : null],
    ['Claimed by', t.claimedBy ? `<span class="mono">${esc(short(t.claimedBy))}</span>` : null],
    ['verify said', verdict ? esc(verdict) : null],
    ['Raised', when(t.createdAt, now)],
    ['Last change', when(t.updatedAt, now)],
  ].filter(([, v]) => v);
  const history = (t.history ?? []).map(
    (h, i) => `<li class="t-${toneOf(h.status)}"><span class="dot" aria-hidden="true"></span><div><span class="what">${esc(i === 0 ? FIRST_STEP[h.status] ?? `Raised as ${labelOf(h.status)}` : STEP[h.status] ?? labelOf(h.status))}</span>${when(h.at, now)}${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}</div></li>`,
  );
  return `<article class="detail" data-detail="${esc(t.id)}" hidden aria-labelledby="dt-${esc(t.id)}">
          <a class="back" href="#tasks">${icon('back')}All tasks</a>
          <div class="eyebrow">${esc(t.id)}</div>
          <h2 id="dt-${esc(t.id)}">${esc(t.comment || '(no comment)')}</h2>
          <div class="badges">
            <span class="badge t-${toneOf(t.status)}"><span class="dot" aria-hidden="true"></span>${esc(labelOf(t.status))}</span>
            ${t.url ? `<span class="chip">${esc(page.label)}</span>` : ''}
            ${t.rejections ? `<span class="tag">Sent back ${t.rejections}×</span>` : ''}
          </div>
          ${crop ? `<h3>What was pointed at</h3><figure class="shot"><img src="${esc(crop)}" alt="The element ${esc(t.id)} is about" loading="lazy"></figure>` : ''}
          ${atts.length ? `<h3>Attached</h3>${atts.map((a) => `<figure class="shot"><img src="${esc(a)}" alt="An image attached to ${esc(t.id)}" loading="lazy"></figure>`).join('')}` : ''}
          <h3>Details</h3>
          <dl class="props">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
          ${history.length ? `<h3>History</h3><ol class="timeline">${history.join('')}</ol>` : ''}
        </article>`;
}

function tasksView(d, outDir) {
  if (!d.tasks.length) {
    return '<div class="card"><p class="empty">No tasks yet. Run <code class="chip">ayna annotate</code> and comment on the page — every comment lands here.</p></div>';
  }
  const now = d.generatedAt;
  const done = d.counts.done;
  // Newest work first: what moved last is what somebody is thinking about.
  const ordered = [...d.tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return `<div class="split" data-split>
      <div class="list-pane">
        <div class="list-tools">
          <div class="tabs" role="tablist" aria-label="Show">
            <button type="button" role="tab" data-filter="open" aria-selected="true">Open <span class="n">${d.counts.pending}</span></button>
            <button type="button" role="tab" data-filter="done" aria-selected="false">Done <span class="n">${done}</span></button>
            <button type="button" role="tab" data-filter="all" aria-selected="false">All <span class="n">${d.counts.total}</span></button>
          </div>
          <label class="search">${icon('search')}<input type="search" placeholder="Search tasks, pages, elements" aria-label="Search tasks" autocomplete="off" data-search-input></label>
          <div class="page-filter" data-page-filter hidden><span>Page</span><span class="chip" data-page-label></span><button type="button" class="icon-btn" data-clear-page aria-label="Show every page">${icon('close')}</button></div>
        </div>
        <div class="rows">${ordered.map((t) => taskRow(t, now)).join('')}</div>
        <p class="empty" data-no-match hidden>No tasks match.</p>
      </div>
      <div class="detail-pane">
        <div class="detail-empty" data-detail-empty>Select a task to see what was pointed at, and what happened to it.</div>
        ${ordered.map((t) => taskDetail(t, d, outDir)).join('')}
      </div>
    </div>`;
}

const BOXES_SHOWN = 12;
const STEPS_SHOWN = 4;

function activityView(d) {
  if (!d.boxes.length) return '<div class="card"><p class="empty">Nothing has happened here yet.</p></div>';
  const now = d.generatedAt;
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  let lastDay = null;
  const out = [];
  d.boxes.forEach((b, i) => {
    const older = i >= BOXES_SHOWN;
    const day = dayKey(b.latestAt);
    if (day !== lastDay) {
      lastDay = day;
      const name = day === today ? 'Today' : day === yesterday ? 'Yesterday' : DAY.format(b.latestAt);
      out.push(`<h2 class="day-label"${older ? ' data-older' : ''}>${esc(name)}</h2>`);
    }
    const hiddenSteps = Math.max(0, b.steps.length - STEPS_SHOWN);
    const head =
      b.kind === 'task'
        ? `${pill(b.status)}<a class="box-title" href="#tasks/${encodeURIComponent(b.taskId)}"><span class="title">${esc(b.title)}</span><span class="sub">${esc(b.sub)}</span></a>`
        : `<span class="kind">${b.kind === 'window' ? 'Review' : 'Notes'}</span><span class="box-title"><span class="title${b.kind === 'window' ? ' mono' : ''}">${esc(b.title)}</span>${b.sub ? `<span class="sub">${esc(b.sub)}</span>` : ''}</span>`;
    const steps = b.steps
      .map(
        (s, j) => `<li class="step t-${s.tone}${j < hiddenSteps ? ' early' : ''}">${dayKey(s.at) === dayKey(b.latestAt) ? clock(s.at) : when(s.at, now)}<span class="what"><span class="dot" aria-hidden="true"></span><span>${s.who ? `<b class="who t-${s.who === 'You' ? 'you' : s.who === 'Ayna' ? 'ayna' : 'agent'}">${esc(s.who)}</b>` : ''}${esc(s.text)}${s.detail ? `<span class="detail-text">${esc(s.detail)}</span>` : ''}</span></span></li>`,
      )
      .join('');
    out.push(`<section class="box" data-box="${esc(b.key)}"${older ? ' data-older' : ''}>
        <div class="box-head">${head}<span class="when">${when(b.latestAt, now)}</span></div>
        ${hiddenSteps ? `<button type="button" class="more-btn" data-more-steps aria-expanded="false">${icon('chevron')}Show ${plural(hiddenSteps, 'earlier step')}</button>` : ''}
        <ol class="steps">${steps}</ol>
      </section>`);
  });
  const olderCount = Math.max(0, d.boxes.length - BOXES_SHOWN);
  return `<div class="feed" data-feed>${out.join('')}
      ${olderCount ? `<button type="button" class="more-btn more-boxes" data-more-boxes aria-expanded="false">${icon('chevron')}Show ${olderCount} older</button>` : ''}
    </div>`;
}

function pagesView(d) {
  if (!d.pages.length) return '<div class="card"><p class="empty">No pages yet.</p></div>';
  const now = d.generatedAt;
  const rows = d.pages
    .map(
      (p) => `<a class="page-row" href="#tasks?page=${encodeURIComponent(p.key)}">
          <span class="path">${esc(p.label)}</span>
          <span class="mini" role="img" aria-label="${p.pending} outstanding, ${p.done} done">${STATUSES.filter((s) => p.byStatus[s])
            .map((s) => `<span class="t-${toneOf(s)}" style="flex:${p.byStatus[s]}"></span>`)
            .join('')}</span>
          <span class="count"><b>${p.pending}</b> outstanding · ${p.total} total</span>
          <span class="when">${when(p.lastAt, now)}</span>
        </a>`,
    )
    .join('');
  return `<div class="list">
      <div class="list-head page-cols"><span>Page</span><span>Status</span><span>Tasks</span><span>Last change</span></div>
      ${rows}
    </div>`;
}

function agentsView(d) {
  if (!d.agents.length) return '<div class="card"><p class="empty">No agent has opened a session here yet.</p></div>';
  const now = d.generatedAt;
  const STATE = { live: ['Live', 'good'], quiet: ['Quiet', 'you'], ended: ['Ended', 'neutral'], dead: ['Went away', 'bad'] };
  const rows = d.agents
    .map((a) => {
      const [label, tone] = STATE[a.state] ?? [a.state, 'neutral'];
      return `<div class="agent-row">
          <span class="avatar" aria-hidden="true">${esc(String(a.tool ?? '?').slice(0, 1).toUpperCase())}</span>
          <span><span class="title">${esc(a.tool)}</span><span class="meta mono" title="${esc(a.agentId ?? a.id)}">${esc(short(a.agentId ?? a.id))}</span></span>
          <span><span class="pill t-${tone}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span></span>
          <span class="c-start">${when(a.startedAt, now)}</span>
          <span class="c-seen">${when(a.lastSeenAt, now)}</span>
          <span class="c-claims num">${a.claims}${a.holding ? ` <span class="muted">(${a.holding} now)</span>` : ''}</span>
        </div>`;
    })
    .join('');
  return `<div class="list">
      <div class="list-head agent-cols"><span></span><span>Agent</span><span>State</span><span>Started</span><span>Last seen</span><span>Claims</span></div>
      ${rows}
    </div>`;
}

const HEADS = {
  overview: ['Overview', 'What is owed, what is stuck, and what happened last.'],
  tasks: ['Tasks', 'Every comment and finding, wherever it stands.'],
  activity: ['Activity', 'Each task’s story, and what happened in each review window.'],
  pages: ['Pages', 'Where the work is, worst page first.'],
  agents: ['Agents', 'Every session that has worked in this project.'],
};

const cssVars = (vars) =>
  Object.entries(vars)
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

export function renderDashboard(d, { outDir, theme = null } = {}) {
  const palettes = dashboardPalettes(theme);
  const pageLabels = Object.fromEntries(d.pages.map((p) => [p.key, p.label]));
  const conf = { version: d.version, project: d.project, pageLabels };
  // `<` escaped so a comment or path containing "</script>" cannot end the block.
  const json = JSON.stringify(conf).replace(/</g, '\\u003c');
  const counts = { tasks: d.counts.total, pages: d.pages.length, agents: d.agents.length };
  const body = {
    overview: overview(d),
    tasks: tasksView(d, outDir),
    activity: activityView(d),
    pages: pagesView(d),
    agents: agentsView(d),
  };

  return `<!doctype html>
<html lang="en" data-theme="ayna">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overview · ${esc(d.project)} · Ayna</title>
<link rel="icon" href="data:,">
<script>(function(){try{var q=new URLSearchParams(location.search).get('theme');var s=q||localStorage.getItem('ayna.dashboard.theme');if(s==='ayna'||s==='light')document.documentElement.setAttribute('data-theme',s);}catch(e){}})();</script>
<style>
:root,:root[data-theme="ayna"]{${cssVars(palettes.ayna.vars)};color-scheme:${palettes.ayna.scheme}}
:root[data-theme="light"]{${cssVars(palettes.light.vars)};color-scheme:light}
${TONES.map((t) => `.t-${t}{--fg:var(--${t}-fg);--dot:var(--${t}-dot);--pbg:var(--${t}-pbg);--pline:var(--${t}-pline);--pfg:var(--${t}-pfg);--soft:var(--${t}-soft);--softfg:var(--${t}-softfg);--solid:var(--${t}-solid);--on:var(--${t}-on)}`).join('\n')}
${CSS}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <span class="brand">Ayna</span>
    <span class="crumb"><b>${esc(d.project)}</b><span class="sep" aria-hidden="true">/</span><span id="view-name">Overview</span></span>
    <div class="top-end">
      <span class="stamp"><span class="live-dot" aria-hidden="true"></span><span data-stamp-label>Snapshot ·</span> ${when(d.generatedAt, d.generatedAt)}</span>
      <button type="button" class="icon-btn" id="refresh" aria-label="Refresh" title="Refresh now">${icon('refresh')}</button>
      <div class="seg" role="group" aria-label="Theme">
        <button type="button" data-theme-set="ayna" aria-pressed="true" aria-label="Ayna theme" title="Ayna — the review window’s own dark">${icon('moon')}<span>Ayna</span></button>
        <button type="button" data-theme-set="light" aria-pressed="false" aria-label="Light theme" title="Light">${icon('sun')}<span>Light</span></button>
      </div>
    </div>
  </header>
  <nav class="side" aria-label="Views">
    ${VIEWS.map(([id, label]) => `<a href="#${id}" data-nav="${id}">${icon(id)}<span>${esc(label)}</span>${counts[id] ? `<span class="count">${counts[id]}</span>` : ''}</a>`).join('\n    ')}
    <p class="side-note" data-side-note>A snapshot of <code>.ayna/ayna.db</code>. Run <code>ayna dashboard</code> again to refresh it.</p>
  </nav>
  <main class="main">
    ${VIEWS.map(
      ([id]) => `<section class="view" data-view="${id}"${id === 'overview' ? '' : ' hidden'} aria-labelledby="vh-${id}">
      <div class="view-head"><div><h1 id="vh-${id}">${esc(HEADS[id][0])}</h1><p>${esc(HEADS[id][1])}</p></div></div>
      ${body[id]}
    </section>`,
    ).join('\n    ')}
  </main>
</div>
<script type="application/json" id="ayna-data">${json}</script>
<script>(${client.toString()})(${humanTime.toString()});</script>
</body>
</html>
`;
}

/** Gather, render, write. Returns the file and what went into it. */
export async function writeDashboard(projectDir, { outDir = path.join(projectDir, '.ayna', 'dashboard'), db, now, theme = null } = {}) {
  const data = await gatherDashboard(projectDir, { db, now });
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  await writeFile(file, renderDashboard(data, { outDir, theme }));
  return { file, data };
}

/*
  The page's only script. It runs in the browser, so it is written as a function
  and inlined with toString(): nothing from this module is in scope there, and
  humanTime arrives as its argument. It builds no markup from data — every row
  and every detail is already in the page, escaped — it only decides what shows.
*/
function client(humanTime) {
  const root = document.documentElement;
  const conf = JSON.parse(document.getElementById('ayna-data').textContent);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const local = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const session = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private window */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* private window */ } },
  };

  // ── theme ──
  const setTheme = (name, remember) => {
    root.setAttribute('data-theme', name);
    $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === name)));
    if (remember) local.set('ayna.dashboard.theme', name);
  };
  setTheme(root.getAttribute('data-theme') === 'light' ? 'light' : 'ayna', false);
  $$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet, true)));

  // ── time, in words ──
  const full = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const clockOf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const stamp = () =>
    $$('time[data-human]').forEach((t) => {
      const ms = Date.parse(t.dateTime);
      if (!Number.isFinite(ms)) return;
      t.textContent = t.dataset.human === 'clock' ? clockOf.format(ms) : humanTime(ms, Date.now());
      t.title = full.format(ms);
    });
  stamp();
  setInterval(stamp, 60000);

  // ── views ──
  const VIEWS = ['overview', 'tasks', 'activity', 'pages', 'agents'];
  const NAMES = { overview: 'Overview', tasks: 'Tasks', activity: 'Activity', pages: 'Pages', agents: 'Agents' };
  const state = { view: 'overview', task: null, page: null, filter: 'open', query: '' };
  const wide = () => window.matchMedia('(min-width: 901px)').matches;
  const split = $('[data-split]');
  const input = $('[data-search-input]');

  const parse = () => {
    const [where, query] = location.hash.slice(1).split('?');
    const [view, task] = (where || '').split('/');
    const params = new URLSearchParams(query || '');
    return {
      view: VIEWS.includes(view) ? view : 'overview',
      task: task ? decodeURIComponent(task) : null,
      page: params.has('page') ? params.get('page') : undefined,
    };
  };

  const applyTasks = () => {
    if (!split) return;
    const q = state.query.trim().toLowerCase();
    let first = null;
    let shown = 0;
    $$('[data-task-row]').forEach((row) => {
      const doneRow = row.dataset.done === '1';
      const ok =
        (state.filter === 'all' || (state.filter === 'done') === doneRow) &&
        (!q || row.dataset.search.includes(q)) &&
        (state.page == null || row.dataset.page === state.page);
      row.hidden = !ok;
      if (ok) {
        shown += 1;
        first = first || row;
      }
    });
    $('[data-no-match]').hidden = shown > 0;
    $$('[data-filter]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.filter === state.filter)));
    const pf = $('[data-page-filter]');
    pf.hidden = state.page == null;
    if (state.page != null) $('[data-page-label]').textContent = conf.pageLabels[state.page] || state.page || 'No page recorded';

    // A wide window has room for the detail, so it is never left empty.
    if (!state.task && wide() && first) {
      state.task = first.dataset.id;
      history.replaceState(null, '', '#tasks/' + encodeURIComponent(state.task) + (state.page != null ? '?page=' + encodeURIComponent(state.page) : ''));
    }
    $$('[data-task-row]').forEach((row) => row.setAttribute('aria-current', String(row.dataset.id === state.task)));
    let found = false;
    $$('[data-detail]').forEach((el) => {
      const on = el.dataset.detail === state.task;
      el.hidden = !on;
      found = found || on;
    });
    $('[data-detail-empty]').hidden = found;
    split.toggleAttribute('data-has-detail', found);
  };

  const render = () => {
    const r = parse();
    state.view = r.view;
    state.task = r.task;
    if (r.page !== undefined) state.page = r.page;
    else if (r.view !== 'tasks') state.page = null;
    $$('[data-view]').forEach((v) => (v.hidden = v.dataset.view !== r.view));
    $$('[data-nav]').forEach((a) => (a.dataset.nav === r.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    $('#view-name').textContent = NAMES[r.view];
    document.title = NAMES[r.view] + ' · ' + conf.project + ' · Ayna';
    if (r.view === 'tasks') applyTasks();
  };

  window.addEventListener('hashchange', () => {
    const was = state.view;
    render();
    if (state.view !== was || !wide()) window.scrollTo(0, 0);
  });
  $$('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      state.task = null;
      applyTasks();
    }),
  );
  if (input) {
    input.addEventListener('input', () => {
      state.query = input.value;
      applyTasks();
    });
  }
  const clear = $('[data-clear-page]');
  if (clear) {
    clear.addEventListener('click', () => {
      state.page = null;
      location.hash = '#tasks' + (state.task ? '/' + encodeURIComponent(state.task) : '');
    });
  }

  // ── folded steps and older boxes ──
  const toggleSteps = (btn, open) => {
    const box = btn.closest('.box');
    box.classList.toggle('show-all', open);
    btn.setAttribute('aria-expanded', String(open));
    const n = box.querySelectorAll('.step.early').length;
    btn.lastChild.textContent = open ? 'Hide earlier steps' : 'Show ' + n + (n === 1 ? ' earlier step' : ' earlier steps');
  };
  $$('[data-more-steps]').forEach((btn) => btn.addEventListener('click', () => toggleSteps(btn, !btn.closest('.box').classList.contains('show-all'))));
  const feed = $('[data-feed]');
  const moreBoxes = $('[data-more-boxes]');
  const toggleBoxes = (open) => {
    feed.classList.toggle('show-older', open);
    moreBoxes.setAttribute('aria-expanded', String(open));
    moreBoxes.lastChild.textContent = open ? 'Show fewer' : 'Show ' + feed.querySelectorAll('.box[data-older]').length + ' older';
  };
  if (moreBoxes) moreBoxes.addEventListener('click', () => toggleBoxes(!feed.classList.contains('show-older')));

  // ── a refresh comes back to where you were ──
  const KEY = 'ayna.dashboard.restore';
  try {
    const saved = JSON.parse(session.get(KEY) || 'null');
    session.del(KEY);
    if (saved) {
      state.filter = saved.filter || state.filter;
      state.query = saved.query || '';
      if (input) input.value = state.query;
      (saved.open || []).forEach((key) => {
        const btn = $('.box[data-box="' + CSS.escape(key) + '"] [data-more-steps]');
        if (btn) toggleSteps(btn, true);
      });
      if (saved.older && moreBoxes) toggleBoxes(true);
      requestAnimationFrame(() => window.scrollTo(0, saved.y || 0));
    }
  } catch {
    // A state we cannot read is a state we start without.
  }
  render();

  /*
    Live, when a review window opened this page: it handed over a way to ask
    whether anything changed and a way to rewrite the page. Without them this is
    a snapshot, and the button that could not do anything is not shown.
  */
  const live = typeof window.__aynaDashboardVersion === 'function' && typeof window.__aynaDashboardRefresh === 'function';
  if (!live) return;
  root.setAttribute('data-live', '');
  $('[data-stamp-label]').textContent = 'Live · updated';
  const note = $('[data-side-note]');
  if (note) note.textContent = 'Live while the review window is open — it refreshes itself when anything changes.';
  const button = $('#refresh');
  let pending = false;
  let busy = false;
  const save = () =>
    session.set(
      KEY,
      JSON.stringify({
        filter: state.filter,
        query: state.query,
        y: window.scrollY,
        open: $$('.box.show-all').map((b) => b.dataset.box),
        older: Boolean(feed && feed.classList.contains('show-older')),
      }),
    );
  const refresh = async () => {
    if (busy) return;
    busy = true;
    button.setAttribute('aria-busy', 'true');
    save();
    try {
      await window.__aynaDashboardRefresh();
    } catch {
      // The window went away; reloading still shows the last file written.
    }
    location.reload();
  };
  // Never pull the page out from under someone typing, or from a hidden tab.
  const maybe = () => {
    if (!pending || busy) return;
    const typing = document.activeElement && document.activeElement.matches('input, textarea');
    if (document.hidden || typing) {
      button.setAttribute('data-new', '');
      return;
    }
    refresh();
  };
  button.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', maybe);
  if (input) input.addEventListener('blur', () => setTimeout(maybe, 150));
  setInterval(async () => {
    if (busy) return;
    let v;
    try {
      v = await window.__aynaDashboardVersion();
    } catch {
      return;
    }
    if (v && v !== conf.version) {
      pending = true;
      maybe();
    }
  }, 3000);
}

/*
  The review window's material: type and hairlines first, colour only for status
  and the one accent. Every control is at least 44px where it can be pressed —
  the size ayna flags on everyone else's page — and drawn smaller inside that
  with a ::before, the way the window's own mode switcher is, so the page stays
  light without failing the audit it ships with.
*/
const CSS = `
*{box-sizing:border-box}
:root{--sans:-apple-system,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--top-h:52px;--side-w:232px;--rc:10px}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
[hidden]{display:none!important}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.muted{color:var(--muted)}.dim{color:var(--dim)}.mono{font-family:var(--mono)}.num{font-variant-numeric:tabular-nums}
code{font:12.5px/1.4 var(--mono)}
.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dot)}

.app{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr);grid-template-rows:var(--top-h) auto;min-height:100vh;background:linear-gradient(to right,var(--side) calc(var(--side-w) - 1px),var(--line) calc(var(--side-w) - 1px) var(--side-w),transparent var(--side-w))}
.top{grid-column:1/-1;position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;height:var(--top-h);padding:0 10px 0 18px;background:var(--top);border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:8px;flex:none;padding-right:14px;border-right:1px solid var(--line);font-weight:700;letter-spacing:.01em}
.brand::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--accent)}
.crumb{display:flex;align-items:baseline;gap:8px;min-width:0}
.crumb b{font-weight:600;overflow-wrap:anywhere}
.crumb .sep{color:var(--dim)}
#view-name{color:var(--muted)}
.top-end{display:flex;align-items:center;gap:2px;margin-left:auto}
.stamp{display:inline-flex;align-items:center;gap:6px;margin-right:8px;font-size:12px;color:var(--muted);white-space:nowrap}
.live-dot{display:none;width:7px;height:7px;border-radius:50%;background:var(--good-dot);box-shadow:0 0 0 3px var(--good-soft)}
[data-live] .live-dot{display:inline-block}
.icon-btn{position:relative;isolation:isolate;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;background:none;color:var(--muted);cursor:pointer}
.icon-btn::before{content:"";position:absolute;inset:6px;z-index:-1;border-radius:8px;transition:background-color .15s}
.icon-btn:hover{color:var(--text)}.icon-btn:hover::before{background:var(--raised-2)}
#refresh{display:none}
[data-live] #refresh{display:inline-flex}
#refresh[data-new]::after{content:"";position:absolute;top:10px;right:10px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
#refresh[aria-busy="true"] .i{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#refresh[aria-busy="true"] .i{animation:none}}
.seg{position:relative;isolation:isolate;display:flex;padding:0 2px}
.seg::before{content:"";position:absolute;inset:6px 0;z-index:-1;border:1px solid var(--line-2);border-radius:10px;background:var(--seg-track)}
.seg button{position:relative;isolation:isolate;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;height:44px;padding:0 12px;border:0;background:none;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer}
.seg button::before{content:"";position:absolute;inset:9px 2px;z-index:-1;border-radius:7px;transition:background-color .15s}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"]{color:var(--text)}
.seg button[aria-pressed="true"]::before{background:var(--sel);box-shadow:inset 0 0 0 1px var(--line-2)}
.seg button[aria-pressed="true"] .i{color:var(--accent-text)}

.side{position:sticky;top:var(--top-h);align-self:start;display:flex;flex-direction:column;gap:2px;height:calc(100vh - var(--top-h));overflow-y:auto;padding:14px 10px;background:var(--side);border-right:1px solid var(--line)}
.side a{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;border-radius:8px;color:var(--muted);font-weight:500}
.side a:hover{background:var(--raised-2);color:var(--text)}
.side a[aria-current="page"]{background:var(--sel);color:var(--text);box-shadow:inset 0 0 0 1px var(--line-2)}
.side a[aria-current="page"] .i{color:var(--accent-text)}
.side .count{margin-left:auto;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.side-note{margin:auto 0 0;padding:12px;font-size:12px;line-height:1.6;color:var(--dim)}
.side-note code{font-size:12px}

.main{min-width:0;padding:28px 36px 72px}
.view{max-width:1200px;margin:0 auto}
.view-head{margin-bottom:20px}
.view-head h1{margin:0;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.view-head p{margin:4px 0 0;font-size:13px;color:var(--muted)}

.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.tile{padding:14px 16px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--rc)}
.tile .k{font-size:12px;font-weight:500;color:var(--muted)}
.tile .v{margin-top:6px;font-size:26px;line-height:1.1;font-weight:600;font-variant-numeric:tabular-nums}
.tile .s{margin-top:6px;font-size:12px;color:var(--dim)}
.dist{margin-top:18px}
.bar{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--raised-2)}
.bar span,.mini span{background:var(--dot)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 0;padding:0;list-style:none;font-size:12px;color:var(--muted)}
.legend li{display:inline-flex;align-items:center;gap:6px}
.legend b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:24px;align-items:start}
.card{min-width:0;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--rc)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:0 6px 0 16px;border-bottom:1px solid var(--line)}
.card-head h2{margin:0;font-size:13px;font-weight:600}
.link{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 10px;color:var(--accent-text);font-size:12.5px;font-weight:600}
.link:hover{text-decoration:underline}
.row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;min-height:56px;padding:8px 16px;border-top:1px solid var(--line)}
.card-head + .row{border-top:0}
a.row:hover{background:var(--raised-2)}
.row .title{display:block;font-size:13.5px;font-weight:500;overflow-wrap:anywhere}
.row .meta{display:block;margin-top:2px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.row .when{font-size:12px;color:var(--dim);white-space:nowrap;text-align:right}
.empty{margin:0;padding:22px 16px;font-size:13px;color:var(--muted)}

.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border:1px solid var(--pline);border-radius:999px;background:var(--pbg);color:var(--pfg);font-size:12px;font-weight:600;line-height:1;white-space:nowrap}
.pill .dot{width:6px;height:6px}
.badge{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:999px;background:var(--solid);color:var(--on);font-size:12.5px;font-weight:600;white-space:nowrap}
.badge .dot{width:6px;height:6px;background:currentColor}
.chip{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border-radius:6px;background:var(--chip-bg);color:var(--chip-fg);font:12.5px/1.5 var(--mono);overflow-wrap:anywhere}
.tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;background:var(--bad-soft);color:var(--bad-softfg);font-size:12px;font-weight:600;white-space:nowrap}
.chip.code{background:var(--code-bg);color:var(--code-fg)}
.status{font-weight:600;color:var(--fg)}
.row > .dot{align-self:start;margin-top:8px}
.sep{color:var(--dim)}

.split{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);min-height:560px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--rc)}
.list-pane{min-width:0;border-right:1px solid var(--line)}
.list-tools{position:sticky;top:var(--top-h);z-index:2;background:var(--raised);border-bottom:1px solid var(--line);border-radius:var(--rc) 0 0 0}
.tabs{display:flex;gap:2px;padding:0 8px}
.tabs button{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:44px;height:44px;padding:0 10px;border:0;background:none;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer}
.tabs button:hover{color:var(--text)}
.tabs button[aria-selected="true"]{color:var(--text)}
.tabs button[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--accent)}
.tabs .n{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.search{display:flex;align-items:center;gap:8px;margin:8px 12px 12px;padding:0 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--bg);color:var(--muted)}
.search:focus-within{border-color:var(--focus)}
.search input{flex:1;min-width:0;height:44px;border:0;background:none;color:var(--text);font:inherit;font-size:13.5px;outline:none}
.search input::placeholder{color:var(--dim)}
.page-filter{display:flex;align-items:center;gap:8px;margin:-6px 6px 6px 12px;font-size:12px;color:var(--muted)}
.page-filter .icon-btn{margin-left:auto}
.task-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;min-height:64px;padding:12px 16px;border-bottom:1px solid var(--line)}
.task-row:hover{background:var(--raised-2)}
.task-row[aria-current="true"]{background:var(--sel);box-shadow:inset 2px 0 0 var(--accent)}
.task-row > .dot{margin-top:7px}
.task-row .title{display:block;font-size:13.5px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}
.task-row .meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:4px;font-size:12px;color:var(--muted)}
.detail-pane{min-width:0;padding:22px 26px 32px}
.detail-empty{display:grid;place-items:center;min-height:320px;padding:24px;font-size:13px;color:var(--muted);text-align:center}
.detail .back{display:none;align-items:center;gap:6px;min-height:44px;margin:-10px 0 6px -6px;padding:0 6px;color:var(--accent-text);font-size:13px;font-weight:600}
.detail .eyebrow{font:12px/1.4 var(--mono);color:var(--dim)}
.detail h2{margin:6px 0 12px;font-size:20px;line-height:1.35;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.detail h3{margin:26px 0 10px;font-size:12px;font-weight:600;color:var(--muted)}
.shot{margin:0 0 10px;padding:14px;background:var(--well);border:1px solid var(--line);border-radius:var(--rc)}
.shot img{display:block;max-width:100%;max-height:300px;margin:0 auto;border-radius:6px}
.props{display:grid;grid-template-columns:120px minmax(0,1fr);margin:0;font-size:13.5px}
.props dt{padding:9px 0;color:var(--muted);border-top:1px solid var(--line)}
.props dd{min-width:0;margin:0;padding:9px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.props dt:first-of-type,.props dd:first-of-type{border-top:0}
.stack{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.timeline{margin:0;padding:0;list-style:none}
.timeline li{position:relative;display:grid;grid-template-columns:14px minmax(0,1fr);gap:10px;padding-bottom:14px}
.timeline li::before{content:"";position:absolute;left:3px;top:14px;bottom:0;width:1px;background:var(--line-2)}
.timeline li:last-child::before{display:none}
.timeline .dot{margin-top:7px}
.timeline .what{display:inline-block;max-width:100%;margin-right:8px;font-size:13.5px;font-weight:500}
.timeline time{display:inline-block;font-size:12px;color:var(--dim)}
.timeline .note{margin-top:2px;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}

.day-label{margin:24px 0 10px;font-size:12px;font-weight:600;color:var(--muted)}
.feed > .day-label:first-child{margin-top:0}
.box{margin-bottom:12px;background:var(--raised);border:1px solid var(--line-2);border-radius:var(--rc)}
.box-head{display:flex;align-items:center;gap:12px;min-height:52px;padding:6px 16px;border-bottom:1px solid var(--line)}
.box-title{display:flex;flex-direction:column;justify-content:center;min-width:0;min-height:44px}
a.box-title:hover .title{text-decoration:underline}
.box-title .title{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.box-title .sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.box-head .when{margin-left:auto;padding-left:8px;font-size:12px;color:var(--dim);white-space:nowrap}
.kind{flex:none;padding:2px 8px;border:1px solid var(--line-2);border-radius:6px;font-size:12px;font-weight:600;color:var(--muted)}
.steps{margin:0;padding:6px 0;list-style:none}
.step{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;padding:7px 16px;font-size:13px}
.box:not(.show-all) .step.early{display:none}
.step time{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.step .what{display:grid;grid-template-columns:14px minmax(0,1fr);align-items:start}
.step .dot{margin-top:6px}
.who{margin-right:6px;font-weight:600;color:var(--fg)}
.detail-text{display:block;margin-top:1px;font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.more-btn{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 16px;border:0;border-bottom:1px solid var(--line);background:none;color:var(--muted);font-size:12.5px;font-weight:600;text-align:left;cursor:pointer}
.more-btn:hover{color:var(--text);background:var(--raised-2)}
.more-btn .i{width:14px;height:14px;transition:transform .15s}
.more-btn[aria-expanded="true"] .i{transform:rotate(90deg)}
.more-boxes{border:1px dashed var(--line-2);border-radius:var(--rc)}
.feed:not(.show-older) [data-older]{display:none}

.list{background:var(--raised);border:1px solid var(--line-2);border-radius:var(--rc)}
.list-head{display:grid;align-items:center;gap:16px;min-height:40px;padding:0 16px;border-bottom:1px solid var(--line);font-size:12px;font-weight:600;color:var(--muted)}
.page-cols,.page-row{grid-template-columns:minmax(0,1fr) 150px 170px 130px}
.page-row{display:grid;align-items:center;gap:16px;min-height:56px;padding:8px 16px;border-top:1px solid var(--line)}
.list-head + .page-row{border-top:0}
.page-row:hover{background:var(--raised-2)}
.page-row .path{font:13px/1.4 var(--mono);overflow-wrap:anywhere}
.page-row .count{font-size:12.5px;color:var(--muted)}
.page-row .count b{color:var(--text);font-weight:600}
.page-row .when{font-size:12px;color:var(--dim)}
.mini{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--raised-2)}
.agent-cols,.agent-row{grid-template-columns:36px minmax(0,1fr) 110px 150px 150px 80px}
.agent-row{display:grid;align-items:center;gap:16px;min-height:60px;padding:8px 16px;border-top:1px solid var(--line);font-size:13px}
.list-head + .agent-row{border-top:0}
.agent-row .title{display:block;font-weight:600}
.agent-row .meta{display:block;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.agent-row time{color:var(--muted);font-size:12.5px}
.avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:var(--sel);font-size:13px;font-weight:700}

@media (max-width:900px){
  .app{grid-template-columns:minmax(0,1fr);background:none}
  .top{gap:10px;padding:0 4px 0 14px}
  .stamp,#view-name,.crumb .sep{display:none}
  .seg button span{display:none}
  .side{position:static;flex-direction:row;flex-wrap:wrap;height:auto;padding:6px 8px;border-right:0;border-bottom:1px solid var(--line)}
  .side a{padding:0 10px}
  .side .count{margin-left:2px}
  .side-note{display:none}
  .main{padding:20px 16px 56px}
  .tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cols{grid-template-columns:minmax(0,1fr)}
  .row{grid-template-columns:auto minmax(0,1fr)}
  .row .when{grid-column:2;text-align:left}
  .split{grid-template-columns:minmax(0,1fr)}
  .list-pane{border-right:0}
  .split[data-has-detail] .list-pane{display:none}
  .split:not([data-has-detail]) .detail-pane{display:none}
  .detail .back{display:inline-flex}
  .detail-pane{padding:18px 16px 24px}
  .props{grid-template-columns:96px minmax(0,1fr)}
  .step{grid-template-columns:minmax(0,1fr);gap:2px}
  .box-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:10px 16px}
  .box-head > .pill,.box-head > .kind{justify-self:start}
  .box-head .box-title{grid-column:1/-1;grid-row:2}
  .box-head .when{grid-column:2;grid-row:1;padding-left:0}
  .list-head{display:none}
  .page-row{grid-template-columns:minmax(0,1fr) auto}
  .page-row .mini,.page-row .when{display:none}
  .agent-row{grid-template-columns:36px minmax(0,1fr) auto}
  .agent-row .c-start,.agent-row .c-seen,.agent-row .c-claims{display:none}
}
`;
