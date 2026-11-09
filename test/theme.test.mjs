/*
  The colours a theme implies.

  This arithmetic used to run inside the review window as a page.evaluate body,
  which nothing else could call and no unit test could reach. It moved to Node so
  the dashboard could paint from the same answers; these pin what the window has
  always drawn, so the move cannot have changed a colour.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { themeTokens, contrast, flatten, mix, parseColor } from '../src/theme.mjs';
import { DEFAULT_THEME } from '../src/config.mjs';

describe('theme tokens', () => {
  test('ayna’s own theme: near-black ink on the accent, the accent readable as text', () => {
    const t = themeTokens(DEFAULT_THEME);
    assert.equal(t['on-accent'], '#0a0a0a', 'white on #de9446 is 2.5:1; near-black is 7.9:1');
    assert.equal(t['accent-text'], DEFAULT_THEME.accent, 'already readable on the dark rail, so left alone');
    assert.equal(t.well, 'rgba(0,0,0,.32)');
    for (const lane of ['you', 'agent', 'ayna', 'good', 'warn', 'bad', 'live']) {
      assert.equal(t[lane], DEFAULT_THEME[lane], `${lane} reads on near-black as given`);
    }
  });

  test('a white surface walks every lane and the accent text until it reads', () => {
    const light = { ...DEFAULT_THEME, surface: '#ffffff', text: '#1a1a1a' };
    const t = themeTokens(light);
    for (const key of ['you', 'agent', 'ayna', 'good', 'warn', 'bad', 'live', 'accent-text']) {
      assert.ok(contrast(t[key], '#ffffff') >= 4.5, `${key} ${t[key]} measures ${contrast(t[key], '#ffffff')?.toFixed(2)}:1`);
    }
    assert.equal(t.accent, DEFAULT_THEME.accent, 'fills keep the accent itself');
    assert.equal(t.well, 'rgba(0,0,0,.045)');
  });

  test('a bright accent gets dark ink, whatever the luminance cut-off used to say', () => {
    assert.equal(themeTokens({ ...DEFAULT_THEME, accent: '#ccfe05' })['on-accent'], '#0a0a0a');
    assert.equal(themeTokens({ ...DEFAULT_THEME, accent: '#1f4fd8' })['on-accent'], '#ffffff');
  });

  test('no theme, no tokens; a translucent surface is not guessed at', () => {
    assert.deepEqual(themeTokens(null), {});
    const t = themeTokens({ ...DEFAULT_THEME, surface: 'rgba(0,0,0,.5)' });
    assert.equal(t.well, undefined, 'no ground to measure against');
    assert.equal(t['accent-text'], DEFAULT_THEME.accent);
  });
});

describe('colour helpers', () => {
  test('flatten composites translucent ink onto what is under it', () => {
    assert.equal(flatten('rgba(255,255,255,0.62)', '#0a0a0b'), '#a2a2a2');
    assert.equal(flatten('#123456', '#ffffff'), '#123456', 'an opaque colour is itself');
    assert.equal(flatten('not a colour', '#ffffff'), 'not a colour');
  });

  test('mix and parse', () => {
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.deepEqual(parseColor('#abc'), { c: [170, 187, 204], a: 1 });
    assert.deepEqual(parseColor('rgba(1, 2, 3, .5)'), { c: [1, 2, 3], a: 0.5 });
    assert.equal(parseColor('teal'), null);
  });
});
