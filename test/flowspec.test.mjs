/*
  A test case in words, turned into a flow that can actually fail.

  The step vocabulary was documented only by the switch statement that ran it, so
  anything writing a flow — a QA engineer, or an agent asked to "test that a
  visitor can reach pricing" — produced {"do":"assert"} and found out after a
  browser launch. And the flows that parsed were often worse: a guessed selector
  matching nothing, or a presence-only check that could never fail.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { validateFlow, FLOW_SCHEMA, STEPS, PROBE, briefFor } from '../src/flowspec.mjs';
import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { hasBrowser } from './helpers.mjs';

const flow = (steps, rest = {}) => ({ name: 'a flow', steps, ...rest });

describe('checking a flow without opening anything', () => {
  test('a good flow passes clean', () => {
    const r = validateFlow(flow([{ do: 'click', on: '#go' }, { do: 'expect', text: 'Done' }]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  test('an invented step is named, with the real vocabulary offered', () => {
    const r = validateFlow(flow([{ do: 'assert', text: 'hi' }]));
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unknown step "assert"/);
    assert.match(r.errors[0], /goto, click, type, press, hover, scroll, wait, expect/);
  });

  /*
    The one that matters most. A flow with no assertion runs green forever and
    tells you nothing — the most expensive kind of test, because it looks like
    coverage.
  */
  test('a flow that cannot fail is rejected', () => {
    const r = validateFlow(flow([{ do: 'click', on: '#go' }, { do: 'scroll', to: 'bottom' }]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /proves nothing/.test(e)));
  });

  test('an expect with nothing to check is rejected', () => {
    const r = validateFlow(flow([{ do: 'expect', settle: 100 }]));
    assert.ok(r.errors.some((e) => /one of `text`, `selector` or `absent`/.test(e)));
  });

  test('a step missing its target says which field', () => {
    for (const [step, field] of [
      [{ do: 'click' }, 'on'],
      [{ do: 'hover' }, 'on'],
      [{ do: 'scroll' }, 'to'],
      [{ do: 'goto' }, 'url'],
      [{ do: 'press' }, 'key'],
    ]) {
      const r = validateFlow(flow([step, { do: 'expect', text: 'x' }]));
      assert.ok(r.errors.some((e) => e.includes(field)), `${step.do} should name \`${field}\`: ${r.errors}`);
    }
  });

  /* Legal, and the single most reliable way to write a test that fails in CI. */
  test('a fixed wait is allowed but warned about', () => {
    const r = validateFlow(flow([{ do: 'wait', ms: 3000 }, { do: 'expect', text: 'x' }]));
    assert.equal(r.ok, true, 'it is valid');
    assert.match(r.warnings[0], /is a guess/);
  });

  test('waiting for a selector is not warned about', () => {
    const r = validateFlow(flow([{ do: 'wait', for: '.results' }, { do: 'expect', text: 'x' }]));
    assert.deepEqual(r.warnings, []);
  });

  test('typing at the keyboard needs no target', () => {
    const r = validateFlow(flow([{ do: 'type', text: 'hello' }, { do: 'expect', text: 'hello' }]));
    assert.equal(r.ok, true, r.errors.join(', '));
  });

  test('a made-up layout fault is caught before it silently never fires', () => {
    const r = validateFlow(flow([{ do: 'expect', text: 'x' }], { assert: { noLayoutFaults: ['covred'] } }));
    assert.ok(r.errors.some((e) => /covred/.test(e)));
  });

  test('every documented step type is one the validator accepts', () => {
    for (const [name, spec] of Object.entries(STEPS)) {
      const r = validateFlow(flow([spec.example, { do: 'expect', text: 'x' }]));
      assert.equal(r.ok, true, `the documented example for "${name}" must validate: ${r.errors.join(', ')}`);
    }
  });

  test("the schema's own example validates", () => {
    const r = validateFlow(FLOW_SCHEMA.example);
    assert.equal(r.ok, true, r.errors.join(', '));
  });
});

describe('reading the page so nothing has to be guessed', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  let srv;
  let url;

  const PAGE = `
    <h1>Pricing</h1>
    <a href="#pricing" id="to-pricing">Pricing</a>
    <button data-testid="buy-team">Start trial</button>
    <button class="cta primary">Start trial</button>
    <a href="#">one</a><a href="#">two</a><a href="#">three</a>
    <input name="email" placeholder="you@example.com">
    <button style="display:none">hidden</button>`;

  before(async () => {
    browser = await openBrowser({ headless: true });
    srv = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><body>${PAGE}</body>`);
    });
    await new Promise((r) => srv.listen(0, r));
    url = `http://127.0.0.1:${srv.address().port}/`;
  });
  after(async () => {
    await browser?.close().catch(() => {});
    srv?.close();
  });

  async function probe() {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    await gotoSettled(page, url);
    const out = await page.evaluate(PROBE);
    await ctx.close();
    return out;
  }

  test('a test hook beats everything else', async () => {
    const { elements } = await probe();
    const buy = elements.find((e) => e.text === 'Start trial' && e.selector.includes('buy-team'));
    assert.equal(buy.selector, '[data-testid="buy-team"]');
    assert.ok(!buy.fragile, 'a test hook is not fragile');
  });

  test('an id is preferred over a class path', async () => {
    const { elements } = await probe();
    assert.ok(elements.some((e) => e.selector === '#to-pricing'));
  });

  test('a class-only selector is flagged fragile', async () => {
    const { elements } = await probe();
    const cta = elements.find((e) => e.selector.startsWith('button.cta'));
    assert.equal(cta.fragile, true);
  });

  /*
    Three <a href="#"> produce one selector. Handing that to an author without
    saying so is how a flow ends up clicking the wrong thing and still passing.
  */
  test('a selector matching several elements says how many', async () => {
    const { elements } = await probe();
    const repeated = elements.filter((e) => e.selector === 'a[href="#"]');
    assert.ok(repeated.length > 1);
    assert.ok(repeated.some((e) => e.ambiguous >= 2), 'the repeat must be marked');
  });

  test('an input is found by name, with its placeholder as the text', async () => {
    const { elements } = await probe();
    const email = elements.find((e) => e.selector === 'input[name="email"]');
    assert.ok(email);
    assert.equal(email.text, 'you@example.com');
  });

  test('what cannot be clicked is not offered', async () => {
    const { elements } = await probe();
    assert.ok(!elements.some((e) => e.text === 'hidden'), 'a display:none button is not actionable');
  });

  test('the brief carries the test case, the schema and the page together', async () => {
    const brief = briefFor(await probe(), 'a visitor can reach pricing');
    assert.equal(brief.testCase, 'a visitor can reach pricing');
    assert.ok(brief.schema.stepTypes.expect, 'the vocabulary travels with it');
    assert.ok(brief.page.elements.length > 0);
    assert.ok(brief.rules.some((r) => /fragile/.test(r)));
    assert.match(brief.then, /flow --check/);
  });
});
