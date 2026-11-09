/**
 * What a theme's colours become once somebody has to read them.
 *
 * A theme is what a project asks for; these are what ayna can actually draw
 * with it. The review window and the dashboard both paint from this, so the two
 * cannot drift apart — and the arithmetic lives in Node, where it can be tested,
 * rather than inside a page.evaluate string nothing else could call.
 */

/** WCAG relative luminance of a #rrggbb colour, or null for anything else. */
export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const ch = [0, 2, 4]
    .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Contrast ratio between two luminances. */
export const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Contrast ratio between two #rrggbb colours, or null when either is not one. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return la === null || lb === null ? null : ratio(la, lb);
}

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
const hexOf = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** `a` moved toward `b` by `t` (0 is a, 1 is b). Both #rrggbb. */
export function mix(a, b, t) {
  const from = rgb(a);
  const to = rgb(b);
  if (!from || !to) return a;
  return hexOf(from.map((v, i) => v + (to[i] - v) * t));
}

/** Any of #rgb, #rrggbb, rgb() or rgba() as { c: [r, g, b], a }, or null. */
export function parseColor(value) {
  const s = String(value ?? '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short) return { c: short.slice(1).map((h) => parseInt(h + h, 16)), a: 1 };
  const long = rgb(s);
  if (long) return { c: long, a: 1 };
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { c: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
}

/**
 * A colour as it lands on `over`: translucent ink composited down to one solid
 * value. ayna's audit will not guess the contrast of translucent text, so a page
 * that wants its contrast checked has to say what colour its text really is.
 */
export function flatten(value, over) {
  const p = parseColor(value);
  const base = rgb(over);
  if (!p) return value;
  if (p.a >= 1 || !base) return hexOf(p.c);
  return hexOf(p.c.map((v, i) => v * p.a + base[i] * (1 - p.a)));
}

/** The lane and state colours: names that sign lines, and the colours of a verdict. */
const READ_AS_TEXT = ['you', 'agent', 'ayna', 'good', 'warn', 'bad', 'live'];
const INK_DARK = luminance('#0a0a0a');

/**
 * Every token a theme sets, plus the ones it implies, keyed without the
 * `--ayna-` prefix.
 *
 * Work out what colour text belongs on each of those, rather than assuming
 * white. A brand colour is often bright — kormoOS's is #ccfe05, where white text
 * measures 1.18:1 and is simply not readable. Hardcoding white meant any light
 * accent produced invisible buttons, so the theme would look "applied" and be
 * unusable. The luminance decides, the same arithmetic ayna uses to judge
 * everyone else's contrast.
 */
export function themeTokens(theme) {
  if (!theme) return {};
  const out = {};
  for (const [k, v] of Object.entries(theme)) if (typeof v === 'string') out[k] = v;
  const t = { ...out };

  /*
    A light surface, and what has to follow it.

    The defaults were tuned for a near-black rail, so a white one turned the lane
    colours — the names that sign each line, the green of a clean check — into
    pastels at under 2:1, and the accent, used for labels as well as for the one
    call to action, into orange text at 2.4:1. Any of them that cannot be read on
    the surface is walked toward the text colour until it can; one that already
    reads is left exactly as given. The accent keeps its own value for fills and
    gets a separate one for text. And a recessed well — the message box, a diff —
    is a shade below the surface, which over white is a whisper rather than the
    .32 black it is over the dark rail.
  */
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
  for (const key of READ_AS_TEXT) {
    if (typeof t[key] !== 'string') continue;
    const fixed = readable(t[key]);
    if (fixed !== t[key]) {
      t[key] = fixed;
      out[key] = fixed;
    }
  }
  if (typeof t.accent === 'string') out['accent-text'] = readable(t.accent);
  if (ground !== null) out.well = ground > 0.5 ? 'rgba(0,0,0,.045)' : 'rgba(0,0,0,.32)';

  /*
    Whichever ink actually reads better, measured, not a luminance cut-off.

    The cut-off was 0.4, on the belief that black overtakes white there. It
    overtakes at about 0.18 — where (L+0.05)/0.05 meets 1.05/(L+0.05). ayna's own
    accent sits at 0.37, between the two, so every install got white on orange at
    2.5:1 for its one call to action, and the active mode, which borrows this
    ink, went white on ivory and disappeared.
  */
  for (const key of ['accent', 'good', 'bad', 'warn', 'live']) {
    const l = luminance(t[key]);
    if (l === null) continue;
    out['on-' + key] = ratio(l, INK_DARK) >= ratio(l, 1) ? '#0a0a0a' : '#ffffff';
  }
  return out;
}
