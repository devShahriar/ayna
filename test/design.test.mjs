/*
  Two kinds of truth, kept apart.

  `audit` reports what the page can PROVE, and those decide whether a run is
  clean because a loop needs a condition it can reach. Taste cannot be a gate:
  feed "this looks generic" into a termination test and the loop never
  terminates.

  But not-a-gate is not the same as not-actionable, and that is where the line
  had been drawn wrong. `ayna taste` printed opinions into a terminal and stopped
  there, so an agent reviewing a page got measurements it could act on and design
  findings it could only read aloud.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { recommend, designBrief, summarizeDesign } from '../src/design.mjs';

const audit = (viewports) => ({ findings: viewports });

const taste = {
  available: true,
  findings: [
    {
      rule: 'icon-tile-stack',
      title: 'Icon tile stacked above heading',
      note: 'Try a side-by-side icon and heading.',
      severity: 'warning',
      where: ['40x40px icon tile above h3 "Ask"', 'above h3 "Alerts"'],
      sites: [{ file: '/p/demo/index.html', line: 42 }],
    },
  ],
};

describe('merging a measurement and an opinion', () => {
  test('a measured fault is acted on; a judged one is only offered', () => {
    const r = recommend({
      audit: audit([{ viewport: 'desktop', covered: [{ element: 'button.zoom', label: '+', coveredBy: 'div.bar' }] }]),
      taste,
    });

    const measured = r.recommendations.find((x) => x.confidence === 'measured');
    const judged = r.recommendations.find((x) => x.confidence === 'judged');

    assert.equal(measured.act, 'fix');
    assert.equal(judged.act, 'propose', 'taste must never be promoted to something an agent applies');
  });

  test('taste never decides whether a review is clean', () => {
    const r = recommend({ audit: audit([{ viewport: 'desktop' }]), taste });
    assert.equal(r.counts.judged, 1, 'the opinion is still reported');
    assert.equal(r.clean, true, 'a loop waiting for taste to reach zero never stops');
  });

  test('a minor measurement does not fail a review either', () => {
    const r = recommend({
      audit: audit([{ viewport: 'desktop', tinyText: [{ element: 'span', size: '10px', label: 'SQL' }] }]),
    });
    assert.equal(r.clean, true, 'minor matches the audit’s own definition of clean');
  });

  test('a serious measurement does', () => {
    const r = recommend({
      audit: audit([{ viewport: 'mobile', offscreen: [{ element: 'button', label: 'Run', cut: 'right', by: 12 }] }]),
    });
    assert.equal(r.clean, false);
  });

  /*
    The same fault appears once per viewport. Reported twice, an agent fixes it
    twice — and the second fix is applied to a page the first one already changed.
  */
  test('one fault seen at two sizes is one recommendation', () => {
    const same = { element: 'span.sql', size: '10px', label: 'SQL' };
    const r = recommend({
      audit: audit([
        { viewport: 'desktop', tinyText: [same] },
        { viewport: 'mobile', tinyText: [same] },
      ]),
    });
    assert.equal(r.counts.measured, 1, 'deduplicated across viewports');
    assert.equal(r.recommendations[0].viewport, 'desktop', 'and keeps where it was first seen');
  });

  /*
    Severity first, then confidence. Deliberately in that order: a warning-level
    design finding IS more worth reading than a 10px label, so severity has to
    dominate. Confidence only breaks ties — which is where it matters, because a
    thing the page proved and a thing a detector believes look identical in a
    list until you sort them.
  */
  test('worst first, and at equal severity a proof outranks an opinion', () => {
    const r = recommend({
      audit: audit([
        {
          viewport: 'desktop',
          tinyText: [{ element: 'span', label: 'x' }],
          covered: [{ element: 'button', label: 'Go', coveredBy: 'div' }],
          // major, the same severity a taste `error` maps to
          lowContrast: [{ element: 'p.bio', label: 'hello' }],
        },
      ]),
      taste: {
        available: true,
        findings: [
          { rule: 'gradient-text', title: 'Gradient text', note: 'Use weight.', severity: 'error', where: ['h1'] },
          ...taste.findings,
        ],
      },
    });

    assert.equal(r.recommendations[0].rule, 'covered', 'critical leads');

    const majors = r.recommendations.filter((x) => x.severity === 'major');
    assert.equal(majors[0].confidence, 'measured', 'at equal severity the measurement comes first');
    assert.equal(majors.at(-1).confidence, 'judged');

    // And the minor measurement still sits below the warning-level opinion.
    const order = r.recommendations.map((x) => x.severity);
    assert.deepEqual(
      [...order].sort((a, b) => ({ critical: 4, major: 3, warning: 2, minor: 1 }[b] - { critical: 4, major: 3, warning: 2, minor: 1 }[a])),
      order,
      'severity must be non-increasing down the list',
    );
  });

  test('every recommendation says what to do, not just what is wrong', () => {
    const r = recommend({
      audit: audit([
        {
          viewport: 'desktop',
          covered: [{ element: 'b', label: 'x', coveredBy: 'd' }],
          lowContrast: [{ element: 'p', label: 'hi' }],
          smallTargets: [{ element: 'a', size: '20x20', label: 'FAQ' }],
        },
      ]),
      taste,
    });
    for (const rec of r.recommendations) {
      assert.ok(rec.fix && rec.fix.length > 20, `${rec.rule} has no usable fix: ${JSON.stringify(rec.fix)}`);
      assert.ok(rec.title, `${rec.rule} has no title`);
    }
  });

  test('each check spells its element differently, and the detail still reads', () => {
    const r = recommend({
      audit: audit([
        {
          viewport: 'desktop',
          overlaps: [{ a: 'div.one', labelA: 'One', b: 'div.two', labelB: 'Two' }],
          clipped: [{ element: 'p.bio', label: 'Long', by: 37 }],
        },
      ]),
    });
    const overlap = r.recommendations.find((x) => x.rule === 'overlaps');
    assert.match(overlap.detail, /div\.one .* over div\.two/);
    assert.equal(overlap.selector, 'div.one', 'overlaps has no `element` field; `a` is the selector');
    assert.match(r.recommendations.find((x) => x.rule === 'clipped').detail, /37px/);
  });
});

describe('the brief an agent acts on', () => {
  test('it separates the two lists rather than making the agent re-derive them', () => {
    const r = recommend({
      audit: audit([{ viewport: 'desktop', covered: [{ element: 'b', label: 'x', coveredBy: 'd' }] }]),
      taste,
    });
    const brief = designBrief(r, { url: 'http://localhost:3000/', screenshots: ['/tmp/a.png'] });

    assert.equal(brief.fix.length, 1);
    assert.equal(brief.propose.length, 1);
    assert.deepEqual(brief.screenshots, ['/tmp/a.png']);
    assert.ok(brief.rules.some((x) => /Never apply a `propose` item without asking/.test(x)));
    assert.ok(brief.rules.some((x) => /Read the screenshots/.test(x)));
  });

  /*
    A review with no impeccable is a review with no design opinions in it — not
    a page that turned out to have none. Reporting the second would be a lie
    that reads exactly like good news.
  */
  test('a missing taste tool is said out loud, not reported as a clean design', () => {
    const r = recommend({
      audit: audit([{ viewport: 'desktop' }]),
      taste: { available: false, findings: [], hint: 'impeccable is not installed' },
    });
    assert.equal(r.tasteAvailable, false);
    assert.match(r.tasteHint, /not installed/);
    assert.match(designBrief(r, { url: 'x' }).note, /not installed/);
    assert.match(summarizeDesign(r), /not installed/);
  });

  test('a URL site is left alone instead of being run through path.relative', () => {
    const r = recommend({
      audit: audit([{ viewport: 'desktop' }]),
      taste: {
        available: true,
        findings: [{ rule: 'x', title: 'X', note: 'n', severity: 'warning', where: ['snippet here'], sites: [{ file: 'http://127.0.0.1:4173', line: 0 }] }],
      },
    });
    const text = summarizeDesign(r, { relativeTo: '/Users/x/proj' });
    assert.ok(!/http:\/[^/]/.test(text), `a URL was mangled into a path:\n${text}`);
    assert.match(text, /snippet here/, 'with no real file, the snippet is the useful half');
  });

  test('a real file path is shown relative to the project', () => {
    const r = recommend({ audit: audit([]), taste });
    assert.match(summarizeDesign(r, { relativeTo: '/p' }), /demo\/index\.html:42/);
  });
});
