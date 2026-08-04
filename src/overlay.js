/*
  Injected into the page under review. Runs in the browser, not in Node.

  Kept as a plain .js file rather than a template string in annotate.mjs so that
  its own backticks and ${...} don't have to be escaped — and so it stays readable
  and editable as normal code.

  It talks to Node through two functions Playwright exposes on window:
    __aynaSubmit(payload) — one comment, with element context and pasted images
    __aynaDone()          — the user is finished
*/
(() => {
  if (window.__aynaLoaded) return;
  window.__aynaLoaded = true;

  const NS = 'ayna-ov';
  const state = {
    picking: true,
    target: null,
    pins: [],
    seq: 0,
    phase: 'comment',
    // What the mouse is over, and how many levels up from it we've walked.
    // Clicking often lands on a text node's span when you meant the card around
    // it, so ↑/↓ walk the tree the way devtools does.
    hoverBase: null,
    climb: 0,
    // Shift-click builds a set so one comment can cover several elements.
    selection: [],
    // 'comment' clicks to annotate, 'move' drags to reorder, 'browse' lets the
    // page behave normally. Persisted per-tab so walking A -> B -> C doesn't drop
    // you back into comment mode on every page and swallow your next link click.
    marquee: null,
    suppressClick: false,
    signIn: false,
    waitWarn: null,
    mode: (() => {
      try {
        return sessionStorage.getItem('ayna-mode') || 'comment';
      } catch {
        return 'comment';
      }
    })(),
    drag: null,
  };

  // addInitScript runs at document-start, before <html> exists — build the UI only
  // once there is a document to attach it to.
  let hl = null;
  let bar = null;
  let tag = null;

  function start() {
  const css = document.createElement('style');
  css.setAttribute('data-ayna', '1');
  css.textContent = `
    .${NS}-hl {
      position: absolute; pointer-events: none; z-index: 2147483640;
      border: 2px solid #2563eb; background: rgba(59,130,246,.12);
      border-radius: 3px;
    }
    /*
      Docked to the top edge, not floating over the bottom.

      This used to be a pill at bottom:20px, centred — directly on top of
      wherever the app keeps its own controls. On a canvas app that is the zoom
      and history buttons, so "I can't click anything" was literal: ayna's bar was
      covering them. It reported that exact fault in someone's UI and then
      committed it.

      Full width across the top, and the page is moved down to make room, so the
      bar covers nothing at all rather than covering something less important.
    */
    .${NS}-bar {
      position: fixed; z-index: 2147483647; left: 0; right: 0; top: 0;
      display: flex; align-items: center; gap: 12px;
      flex-wrap: wrap; justify-content: center;
      background: #111418; color: #f2f4f8; padding: 10px 16px;
      font: 13px/1.4 -apple-system, system-ui, sans-serif;
      box-shadow: 0 2px 18px rgba(0,0,0,.35);
    }
    /* Left group, mode group, actions: the bar is a layout, not a queue. */
    .${NS}-bar > .${NS}-barside { display: flex; align-items: center; gap: 10px; flex: 1 1 0; }
    .${NS}-bar > .${NS}-baractions { justify-content: flex-end; }
    .${NS}-brand {
      font-weight: 700; letter-spacing: .02em; opacity: .55; text-transform: lowercase;
    }
    .${NS}-hint { opacity: .62; }
    /* A segmented control: which mode is on is a fact, not something to infer. */
    .${NS}-modes {
      display: flex; gap: 2px; background: #23272f; border-radius: 999px; padding: 2px;
    }

    /* The crop leads the box: on a canvas it is the entire comment. */
    .${NS}-preview:empty { display: none; }
    .${NS}-preview {
      position: relative; margin-bottom: 10px; border-radius: 8px; overflow: hidden;
      background: #f1f3f7; border: 1px solid #dfe3ea; min-height: 34px;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: #5b6472;
    }
    .${NS}-preview img { display: block; width: 100%; max-height: 150px; object-fit: contain; }
    .${NS}-cap {
      position: absolute; left: 6px; bottom: 6px; background: rgba(17,20,24,.82);
      color: #fff; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    }
    .${NS}-esc { margin-right: auto; font-size: 12px; color: #6b7280; }
    /* The verdict buttons appear at two sizes; the card is the comfortable one. */
    .${NS}-card .${NS}-ok, .${NS}-card .${NS}-no {
      height: auto; padding: 7px 14px; border-radius: 8px;
      font: 600 13px/1 -apple-system, system-ui, sans-serif;
    }
    /*
      The stream, on the page instead of in a terminal.

      Following a review used to mean watching a window and a terminal at once,
      so the person who wanted to stay on the page kept having to leave it. This
      is the same event stream, docked under the app, and it reserves its own
      space for the same reason the bar does: a panel that covers the thing you
      are reviewing is not a panel, it is an obstruction.
    */
    /*
      The palette is lifted from the trace viewer in
      disler/super-simple-software-factory: a near-black canvas, hairline grid,
      and one saturated colour per actor. It reads as an instrument rather than a
      chat window, which is what this is — and it matches the terminals this sits
      next to instead of fighting them.
    */
    .${NS}-console {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
      background: #0b0f14; color: #e6e9ef; border-top: 1px solid #1b2431;
      display: flex; flex-direction: column;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      /*
        A fixed height, so arriving lines scroll instead of growing the panel.

        Sized to its content, every new line made the console taller, which took
        another slice off the app, which relaid the page out underneath the
        person reading it — a jump on every comment, every landing, every gate.
        A log that reflows the thing it is reporting on is not worth having.
      */
      height: 34vh;
      min-height: 168px;
    }
    .${NS}-console.${NS}-min { height: auto; min-height: 0; }
    .${NS}-console-head {
      display: flex; align-items: center; gap: 10px; padding: 7px 14px;
      border-bottom: 1px solid #161e29; flex: none;
      font: 600 12px/1.4 -apple-system, system-ui, sans-serif;
    }
    .${NS}-console-head .${NS}-dotlive {
      width: 7px; height: 7px; border-radius: 50%; background: #34d399; flex: none;
    }
    .${NS}-console-head button {
      background: transparent; border: 0; color: #9aa4b2; cursor: pointer;
      font: inherit; padding: 2px 8px; border-radius: 6px;
    }
    .${NS}-console-head button:hover { background: #161e29; color: #e6e9ef; }
    .${NS}-console-head .${NS}-spacer { margin-left: auto; }
    .${NS}-agents { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .${NS}-agent {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid #2a3444; border-radius: 999px; padding: 2px 9px;
      font: 500 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9aa4b2;
    }
    .${NS}-agent i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
    .${NS}-agent b { color: #cfd6e0; font-weight: 600; }
    /* Running gets the pulse; idle is just outlined. Straight from the legend:
       queued, running, done are three readable states, not one. */
    .${NS}-agent.${NS}-busy { border-color: #22d3ee; }
    .${NS}-agent.${NS}-busy i { animation: ${NS}-pulse 2.4s ease-in-out infinite; }
    @keyframes ${NS}-pulse {
      0%, 100% { box-shadow: 0 0 2px rgba(34,211,238,.30); }
      50% { box-shadow: 0 0 9px rgba(34,211,238,.75); }
    }
    .${NS}-console-lines {
      overflow-y: auto; padding: 8px 14px; flex: 1 1 auto; min-height: 0;
    }
    .${NS}-line { display: flex; gap: 10px; padding: 2px 0; align-items: baseline; }
    .${NS}-at { flex: none; color: #55606f; font-style: normal; min-width: 40px; }
    .${NS}-line b {
      flex: none; font-weight: 600; min-width: 54px; text-align: right;
    }
    .${NS}-line[data-lane=you] b { color: #38bdf8; }
    .${NS}-line[data-lane=claude] b { color: #a78bfa; }
    .${NS}-line[data-lane=ayna] b { color: #2dd4bf; }
    .${NS}-phase {
      margin: 10px 0 4px; padding-top: 8px; border-top: 1px solid #161e29;
      color: #7c8798; font: 600 11px/1.6 -apple-system, system-ui, sans-serif;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .${NS}-phase:first-child { margin-top: 0; border-top: 0; padding-top: 0; }
    .${NS}-line span { min-width: 0; word-break: break-word; }
    .${NS}-line[data-kind=message] span { color: #fff; }
    .${NS}-line[data-kind=you] b { color: #60a5fa; }
    .${NS}-line[data-kind=you] span { color: #cfd6e0; }
    .${NS}-line[data-kind=applied] span { color: #34d399; }
    .${NS}-line[data-kind=audit] span { color: #f59e0b; }
    /* The gate is the answer to "is it actually fixed?" — it gets to be loud. */
    .${NS}-line[data-kind=gate] b { color: #22d3ee; }
    .${NS}-line[data-kind=gate] span { color: #a5f3fc; }
    .${NS}-console-say { display: flex; gap: 8px; padding: 9px 12px; border-top: 1px solid #161e29; flex: none; }
    .${NS}-console-say input {
      flex: 1; background: #0f151c; border: 1px solid #2a3444; border-radius: 8px;
      color: #e6e9ef; padding: 8px 11px; font: inherit; outline: none;
    }
    .${NS}-console-say input:focus { border-color: #38bdf8; }
    .${NS}-console-say button {
      background: #1f6feb; color: #fff; border: 0; border-radius: 8px;
      padding: 8px 14px; font: 600 12px/1 -apple-system, system-ui, sans-serif; cursor: pointer;
    }
    .${NS}-console.${NS}-min .${NS}-console-lines,
    .${NS}-console.${NS}-min .${NS}-console-say { display: none; }
    .${NS}-bar button {
      font: inherit; font-weight: 600; border: 0; border-radius: 999px;
      padding: 6px 14px; cursor: pointer; background: #2563eb; color: #fff;
    }
    /*
      After the generic rule on purpose: same specificity, so source order
      decides. Written above it, every unselected mode inherited the primary blue,
      and the bar showed four buttons all claiming to be the main action.
    */
    .${NS}-modes button {
      background: transparent; color: #cbd2df; font-weight: 600;
      padding: 5px 13px; border-radius: 999px;
    }
    .${NS}-modes button:hover { background: #2d323c; color: #fff; }
    .${NS}-modes button.${NS}-on { background: #f2f4f8; color: #14171c; }
    .${NS}-count { opacity: .7; }
    .${NS}-progress { font-weight: 600; opacity: .8; }
    .${NS}-progress.${NS}-done { color: #4ade80; opacity: 1; }
    .${NS}-warn { color: #fbbf24; }
    .${NS}-tag {
      position: absolute; z-index: 2147483641; pointer-events: none;
      background: #2563eb; color: #fff; border-radius: 4px; padding: 2px 7px;
      font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,.2);
    }
    .${NS}-tag b { font-weight: 700; }
    .${NS}-tag i { font-style: normal; opacity: .75; margin-left: 8px; }
    .${NS}-marquee {
      position: absolute; z-index: 2147483641; pointer-events: none;
      border: 2px dashed #2563eb; background: rgba(59,130,246,.10); border-radius: 3px;
      display: flex; align-items: flex-end; justify-content: flex-end; padding: 4px;
      font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff;
    }
    /* The readout has to stay legible over whatever is underneath it. */
    .${NS}-marquee::first-line { color: #fff; }
    .${NS}-marquee { text-shadow: 0 1px 2px rgba(0,0,0,.6); }
    .${NS}-drop {
      position: absolute; z-index: 2147483642; pointer-events: none;
      background: #f59e0b; border-radius: 2px;
      box-shadow: 0 0 0 2px rgba(245,158,11,.25);
    }
    .${NS}-picked {
      position: absolute; pointer-events: none; z-index: 2147483639;
      border: 2px dashed #f59e0b; background: rgba(245,158,11,.10); border-radius: 3px;
    }
    .${NS}-bar button:disabled { opacity: .4; cursor: not-allowed; }
    .${NS}-bar button.${NS}-ghost {
      background: transparent; color: #cdd3e0; border: 1px solid #3a4150;
    }
    .${NS}-spin {
      width: 13px; height: 13px; border-radius: 50%; display: inline-block;
      border: 2px solid #3a4150; border-top-color: #6ea8ff;
      animation: ${NS}-rot .7s linear infinite;
    }
    @keyframes ${NS}-rot { to { transform: rotate(360deg); } }
    .${NS}-pop {
      position: fixed; z-index: 2147483646; width: 320px; max-width: calc(100vw - 16px);
      background: #fff; color: #111; border-radius: 12px; padding: 14px;
      box-shadow: 0 2px 6px rgba(17,20,24,.14); border: 1px solid #c9cfd9;
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
      display: flex; flex-direction: column; gap: 0;
    }
    /* The body scrolls; the buttons never do. A row that can be pushed out of
       reach is a row you cannot click. */
    .${NS}-body { overflow: auto; min-height: 0; }
    .${NS}-pop textarea {
      width: 100%; min-height: 78px; resize: vertical; padding: 9px; color: #111;
      border: 1px solid #dfe3ea; border-radius: 8px; font: inherit; background: #fff;
    }
    .${NS}-pop textarea:focus { outline: 2px solid #2563eb; outline-offset: -1px; }
    /*
      A footnote, not a field. Boxed and grey at the top of the panel it read as
      an input you were meant to fill in, and it occupied the line the crop should
      have had.
    */
    .${NS}-sel {
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #6b7280;
      margin-top: 8px; word-break: break-all; max-height: 30px; overflow: hidden;
    }
    .${NS}-sel:empty { display: none; }
    .${NS}-hint { color: #5b6472; font-size: 12px; margin: 8px 0; }
    .${NS}-attach { color: #2563eb; text-decoration: underline; cursor: pointer; }
    .${NS}-pop.${NS}-dragover { outline: 2px dashed #2563eb; outline-offset: 3px; }
    .${NS}-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    .${NS}-auto { position: relative; display: inline-flex; }
    .${NS}-auto b {
      position: absolute; left: 2px; bottom: 2px; font-size: 8px; font-weight: 700;
      letter-spacing: .06em; text-transform: uppercase; color: #fff;
      background: #15803d; border-radius: 3px; padding: 1px 3px;
    }
    .${NS}-thumbs img {
      width: 48px; height: 48px; object-fit: cover;
      border-radius: 6px; border: 1px solid #dfe3ea;
    }
    .${NS}-row {
      display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px;
      flex: none;  /* pinned: the action row is never scrolled away */
    }
    .${NS}-row button {
      font: inherit; font-weight: 600; border-radius: 8px; padding: 7px 13px; cursor: pointer;
    }
    .${NS}-save { background: #2563eb; color: #fff; border: 1px solid #2563eb; }
    .${NS}-cancel { background: #fff; color: #374151; border: 1px solid #dfe3ea; }
    /*
      A comment you have just filed is not a warning.

      This pin was amber, the same colour the review phase uses for work that
      still needs attention, so a page you had simply annotated looked like a page
      full of problems. Amber and red stay reserved for the states that mean
      something is wrong; recording a note is neutral.
    */
    .${NS}-pin {
      position: absolute; z-index: 2147483645; width: 24px; height: 24px;
      border-radius: 999px 999px 999px 2px; background: #2563eb; color: #fff;
      font: 700 12px/24px -apple-system, system-ui, sans-serif; text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; user-select: none;
    }
    /* Hover is where it says what clicking will do: remove it. */
    .${NS}-pin:hover { background: #dc2626; color: #fff; }
    .${NS}-rev {
      position: absolute; z-index: 2147483638; pointer-events: none;
      /*
        Awaiting a verdict is not a warning.

        Every marker was amber — border and wash — so a page where three changes
        were simply waiting to be looked at read as a page with three problems,
        and the colour carried no information because everything had it. Amber and
        red now mean what they say. Blue means "your turn".
      */
      border: 2px solid #2563eb; background: rgba(59,130,246,.07);
      border-radius: 4px; transition: border-color .2s, background-color .2s;
    }
    .${NS}-rev[data-status=approved] { border-color: #16a34a; background: rgba(22,163,74,.08); }
    .${NS}-rev[data-status=in_progress] { border-color: #38bdf8; background: rgba(56,189,248,.08); }
    .${NS}-rev[data-status=proposed] { border-color: #a78bfa; background: rgba(167,139,250,.10); border-style: dashed; }
    .${NS}-rev[data-status=rejected] { border-color: #ef4444; background: rgba(239,68,68,.10); }
    .${NS}-revbar {
      position: absolute; z-index: 2147483644; display: flex; align-items: center; gap: 4px;
      padding: 3px; border-radius: 999px; background: #111418;
      box-shadow: 0 4px 14px rgba(0,0,0,.32); user-select: none;
      font: 600 11px/1 -apple-system, system-ui, sans-serif;
    }
    .${NS}-revpin {
      min-width: 20px; height: 20px; padding: 0 7px; border-radius: 999px;
      background: #2563eb; color: #fff; display: flex; align-items: center;
      justify-content: center; cursor: pointer; white-space: nowrap;
    }
    .${NS}-revpin[data-status=resolved] { background: #15803d; color: #fff; }
    .${NS}-revpin[data-status=rejected] { background: #dc2626; color: #fff; }
    .${NS}-revbar button {
      border: 0; border-radius: 999px; height: 20px; padding: 0 9px; cursor: pointer;
      font: inherit; white-space: nowrap;
    }
    /*
      One colour per meaning. "Looks right" was green on the inline bar and blue
      in the card that opens from it — the same decision painted two ways
      depending on where you happened to click.
    */
    .${NS}-ok { background: #15803d; color: #fff; }
    .${NS}-no { background: #2b313d; color: #e5e7eb; }
    .${NS}-ok:hover { background: #166534; }
    .${NS}-no:hover { background: #dc2626; color: #fff; }
    .${NS}-panel {
      position: fixed; z-index: 2147483646; right: 16px; width: 340px;
      max-width: calc(100vw - 32px);
      background: #111418; color: #e8eaf0; border: 1px solid #2a3140; border-radius: 14px;
      box-shadow: 0 3px 8px rgba(0,0,0,.30); display: flex; flex-direction: column;
      font: 13px/1.5 -apple-system, system-ui, sans-serif; overflow: hidden;
    }
    .${NS}-panel-head {
      display: flex; align-items: center; gap: 8px; padding: 12px 14px; flex: none;
      border-bottom: 1px solid #2a3140; font-weight: 600;
    }
    .${NS}-panel-head button {
      margin-left: auto; background: transparent; border: 0; color: #8b93a7;
      font: inherit; cursor: pointer; padding: 2px 6px;
    }
    .${NS}-panel-list { overflow: auto; min-height: 0; }
    .${NS}-group {
      padding: 8px 14px 4px; font-size: 11px; letter-spacing: .04em; color: #7d8697;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .${NS}-task {
      padding: 9px 14px; border-top: 1px solid #1d2330; cursor: pointer;
      display: flex; gap: 9px; align-items: flex-start;
    }
    .${NS}-task:hover { background: #171b22; }
    .${NS}-dot {
      width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: #2563eb;
    }
    .${NS}-task[data-status=approved] .${NS}-dot { background: #15803d; }
    .${NS}-task[data-status=in_progress] .${NS}-dot { background: #38bdf8; }
    .${NS}-task[data-status=proposed] .${NS}-dot { background: #a78bfa; }
    .${NS}-task[data-status=rejected] .${NS}-dot { background: #dc2626; }
    .${NS}-task[data-status=approved] .${NS}-task-text { color: #7d8697; text-decoration: line-through; }
    .${NS}-task-text { flex: 1; min-width: 0; }
    .${NS}-task-meta { font-size: 11px; color: #7d8697; margin-top: 2px; }
    .${NS}-task-acts { display: flex; gap: 4px; flex: none; }
    .${NS}-task-acts button {
      border: 0; border-radius: 6px; padding: 2px 7px; font: 600 11px/1.6 inherit; cursor: pointer;
      background: #232a36; color: #cdd3e0;
    }
    .${NS}-task-acts button:hover { background: #15803d; color: #fff; }
    .${NS}-task-acts button.${NS}-no:hover { background: #dc2626; }
    .${NS}-empty { padding: 18px 14px; color: #7d8697; }
    .${NS}-flash { animation: ${NS}-flash 1.1s ease-out 2; }
    @keyframes ${NS}-flash {
      0%, 100% { box-shadow: none; }
      40% { box-shadow: 0 0 0 3px #f59e0b; }
    }
    .${NS}-card {
      position: fixed; z-index: 2147483646; width: 300px; max-width: calc(100vw - 16px);
      background: #fff; color: #111; border-radius: 12px; padding: 14px;
      box-shadow: 0 2px 6px rgba(17,20,24,.14); border: 1px solid #c9cfd9;
      font: 13px/1.55 -apple-system, system-ui, sans-serif;
      display: flex; flex-direction: column;
    }
    .${NS}-card .${NS}-badge {
      /* 11px is the floor for anything functional; "COMMENT 1" is a label the
         reader needs, not decoration. */
      display: inline-block; font-size: 11px; text-transform: uppercase;
      letter-spacing: .08em; font-weight: 700; padding: 3px 9px; border-radius: 999px;
      background: #fef3c7; color: #92400e; margin-bottom: 8px;
    }
    .${NS}-card[data-status=resolved] .${NS}-badge { background: #dcfce7; color: #166534; }
    .${NS}-card[data-status=rejected] .${NS}-badge { background: #fee2e2; color: #991b1b; }
    .${NS}-card[data-status=proposed] .${NS}-badge { background: #ede9fe; color: #5b21b6; }
    .${NS}-card textarea {
      width: 100%; min-height: 54px; resize: vertical; padding: 8px; margin-top: 8px;
      border: 1px solid #dfe3ea; border-radius: 8px; font: inherit; color: #111; background: #fff;
    }
    .${NS}-fix {
      background: #f4f5f8; border-radius: 8px; padding: 8px 10px; margin: 8px 0;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #374151;
    }
    .${NS}-card p { margin: 0 0 10px; }
    /* The selector under a comment is a line of prose to the reader, whatever it
       is to the machine — it gets the same floor as the rest. */
    .${NS}-card .${NS}-when { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
    .${NS}-pin i { font-style: normal; display: none; }
    .${NS}-pin:hover b { display: none; }
    .${NS}-pin:hover i { display: inline; }
  `;
  document.documentElement.appendChild(css);

  hl = document.createElement('div');
  hl.className = NS + '-hl';
  hl.setAttribute('data-ayna', '1');
  hl.style.display = 'none';
  document.documentElement.appendChild(hl);

  tag = document.createElement('div');
  tag.className = NS + '-tag';
  tag.setAttribute('data-ayna', '1');
  tag.style.display = 'none';
  document.documentElement.appendChild(tag);

  bar = document.createElement('div');
  bar.className = NS + '-bar';
  bar.setAttribute('data-ayna', '1');
  document.documentElement.appendChild(bar);

  // Start out of the way on a sign-in screen: there is nothing to review until
  // the user is through it, and every click would otherwise become a comment.
  if (looksLikeSignIn() && state.mode === 'comment') {
    state.mode = 'browse';
    try {
      sessionStorage.setItem('ayna-mode', 'browse');
    } catch {
      // Not persistable here; the mode still applies to this page.
    }
    state.signIn = true;
  }
  setPhase('comment');
  watchForSignIn();

  /*
    A reload rebuilds this overlay from nothing, but the work lives in Node. Ask
    what was going on and go back to it — otherwise pressing F5 while changes were
    waiting for your verdict dropped you into a blank comment mode and the pending
    approvals looked lost.
  */
  if (window.__aynaState) {
    window.__aynaState()
      .then((st) => {
        if (!st) return;
        if (typeof st.count === 'number' && st.count > state.seq) {
          state.seq = st.count;
          refreshCount();
        }
        if (st.phase === 'reviewing') setPhase('review');
        else if (st.phase === 'awaiting-claude') setPhase('waiting');
      })
      .catch(() => {});
  } else if (window.__aynaCount) {
    window.__aynaCount().then((n) => {
      if (typeof n === 'number' && n > state.seq) {
        state.seq = n;
        refreshCount();
      }
    }).catch(() => {});
  }
  }

  /*
    Three phases, so the window never closes out from under the user:
      comment — click things, leave notes, send them
      waiting — Claude is editing; the page will reload itself when it's done
      review  — the changes are on screen; approve, or ask for more
  */
  function setPhase(phase) {
    if (!bar) return;
    // The space the bar needs is re-measured whenever it changes; see the
    // observer in reserveForBar, which is what actually catches it.
    requestAnimationFrame(reserveForBar);
    const leavingReview = state.phase === 'review' && phase !== 'review';
    if (phase !== 'waiting') clearTimeout(state.waitWarn);
    state.phase = phase;
    state.picking = phase === 'comment';
    if (leavingReview) clearReview();

    if (phase === 'comment') {
      /*
        All three modes visible at once.

        It used to be one button showing the *next* mode in a cycle, so the label
        said "Move mode" while you were in comment mode — you had to know the
        order to work out where you were, and reaching browse meant clicking
        through move. A segmented control says which one is on.
      */
      const MODES = [
        { id: 'comment', label: 'Comment', title: 'Click anything to comment on it' },
        { id: 'move', label: 'Move', title: 'Drag an element to try it somewhere else' },
        { id: 'browse', label: 'Browse', title: 'Use the app normally — nothing is captured' },
      ];
      const HINT = {
        comment: 'Click anything to comment',
        move: 'Drag an element to reorder it',
        browse: state.signIn
          ? 'Sign in first — nothing is captured while you do'
          : 'Browsing — click links freely, nothing is captured',
      };
      const NEXT_LABEL = { comment: 'Move mode', move: 'Browse mode', browse: 'Comment mode' };

      /*
        Three groups, not one huddle in the middle.

        Everything used to be centred in a full-width strip: the hint, a mode
        toggle, a panel button, a count and the send button, all the same weight,
        with a third of the screen empty on either side. Nothing told you which of
        those changed what you were doing and which merely opened something, and
        the count appeared twice — once on the Tasks button and once beside it.

        Left says where you are, middle switches how you are working, right is the
        one action that ends the round.
      */
      bar.innerHTML =
        '<div class="' + NS + '-barside">' +
          '<span class="' + NS + '-brand">ayna</span>' +
          '<span class="' + NS + '-hint">' + HINT[state.mode] + '</span>' +
        '</div>' +
        '<div class="' + NS + '-modes" role="group" aria-label="Mode">' +
          MODES.map((m) =>
            '<button data-act="setmode" data-mode="' + m.id + '"' +
            (state.mode === m.id ? ' aria-pressed="true" class="' + NS + '-on"' : ' aria-pressed="false"') +
            ' title="' + m.title + '">' + m.label + '</button>',
          ).join('') +
        '</div>' +
        '<div class="' + NS + '-barside ' + NS + '-baractions">' +
          '<button data-act="tasks" class="' + NS + '-ghost" title="Everything still owed on this page">Tasks</button>' +
          '<button data-act="send"' + (state.seq ? '' : ' disabled') +
            (state.seq ? '' : ' title="Comment on something first"') + '>Send to Claude</button>' +
        '</div>';

      for (const b of bar.querySelectorAll('[data-act=setmode]')) {
        b.addEventListener('click', () => {
          state.mode = b.dataset.mode;
          try {
            sessionStorage.setItem('ayna-mode', state.mode);
          } catch {
            // Private mode or a blocked origin — the mode just won't persist.
          }
          clearSelection();
          hide();
          setPhase('comment');
        });
      }

      bar.querySelector('[data-act=tasks]').addEventListener('click', togglePanel);
      refreshTaskCount();
      bar.querySelector('[data-act=send]').addEventListener('click', () => {
        if (!state.seq) return;
        setPhase('waiting');
        window.__aynaDone();
      });
      return;
    }

    if (phase === 'waiting') {
      /*
        "Claude is making your changes" was a promise the page could not keep: it
        appeared the moment Send was pressed, whether or not anything was
        listening. When nothing was, the user sat watching a spinner that meant
        nothing. Say only what is true — sent — and speak up if it goes unanswered.
      */
      bar.innerHTML =
        '<span class="' + NS + '-spin" aria-hidden="true"></span>' +
        '<span class="' + NS + '-waiting">Sent — waiting for Claude to pick this up…</span>' +
        '<button data-act="applied" title="Reload and show the result now">Changes are in</button>';

      /*
        A way out that does not need anything else to be running.

        This message used to be the end of the road: it cleared only when another
        process wrote a marker file, so a session that never ran `ayna applied`
        left the user watching a spinner over work that was already finished. The
        window watches for the edits now, and this button is for when it cannot
        see them — an edit in a container, on another machine, in a file the watch
        ignores.
      */
      bar.querySelector('[data-act=applied]').addEventListener('click', () => {
        if (window.__aynaApplied) window.__aynaApplied();
      });

      clearTimeout(state.waitWarn);
      state.waitWarn = setTimeout(() => {
        const label = bar && bar.querySelector('.' + NS + '-waiting');
        if (!label || state.phase !== 'waiting') return;
        label.textContent = 'Not picked up yet — press “Changes are in” if they have landed';
        label.classList.add(NS + '-warn');
      }, 45000);
      return;
    }

    /*
      Review — three separate actions, none a side effect of another, and the same
      three-group layout as commenting so the bar does not rearrange itself under
      the user between phases.

      Close was the primary blue button, which made ending the review the most
      eye-catching thing on a screen whose entire purpose is judging what changed.
      The verdicts live out on the page, so nothing in this bar deserves primary
      until there is nothing left to judge — at which point Close is exactly what
      you want, and updateReviewBar promotes it.
    */
    bar.innerHTML =
      '<div class="' + NS + '-barside">' +
        '<span class="' + NS + '-brand">ayna</span>' +
        '<span class="' + NS + '-hint">Changes are live — judge each one</span>' +
      '</div>' +
      '<div class="' + NS + '-progress ' + NS + '-count"></div>' +
      '<div class="' + NS + '-barside ' + NS + '-baractions">' +
        '<button data-act="tasks" class="' + NS + '-ghost">Tasks</button>' +
        '<button data-act="more" class="' + NS + '-ghost" ' +
        'title="Go back to commenting without ending the review">Comment more</button>' +
        '<button data-act="approve-all" class="' + NS + '-ghost" ' +
        'title="Marks every pending change approved">Approve all</button>' +
        '<button data-act="close" class="' + NS + '-ghost" ' +
        'title="Ends the review — anything unjudged stays pending">Close</button>' +
      '</div>';

    // Re-anchor every comment on the changed page so each one can be judged
    // where it actually happened, not from memory.
    renderReview().then(updateReviewBar);

    bar.querySelector('[data-act=tasks]').addEventListener('click', togglePanel);
    refreshTaskCount();
    bar.querySelector('[data-act=more]').addEventListener('click', () => {
      clearReview();
      state.seq = 0;
      setPhase('comment');
      window.__aynaMore();
    });
    bar.querySelector('[data-act=approve-all]').addEventListener('click', async () => {
      await window.__aynaApproveAll();
      await renderReview();
      updateReviewBar();
    });
    /*
      Closing takes a moment you can take back.

      One click used to end the review and take the window with it, with nothing
      in between — and the only undo was to start again and re-judge everything.
      A second and a half of "this is about to close, unless you say otherwise"
      costs nothing and makes an accidental ending recoverable.
    */
    bar.querySelector('[data-act=close]').addEventListener('click', () => {
      if (closing) return;
      closing = true;
      bar.innerHTML =
        '<div class="' + NS + '-barside">' +
          '<span class="' + NS + '-brand">ayna</span>' +
          '<span class="' + NS + '-hint">Closing the review — anything unjudged stays waiting</span>' +
        '</div>' +
        '<div class="' + NS + '-barside ' + NS + '-baractions">' +
          '<button data-act="stay">Stay open</button>' +
        '</div>';

      const end = setTimeout(() => {
        cleanup();
        window.__aynaApprove();
      }, 1500);

      bar.querySelector('[data-act=stay]').addEventListener('click', () => {
        clearTimeout(end);
        closing = false;
        setPhase('review');
      });
    });
  }

  function refreshCount() {
    if (!bar) return;
    const counter = bar.querySelector('.' + NS + '-count');
    if (counter) counter.textContent = countLabel();
    const send = bar.querySelector('[data-act=send]');
    if (send) send.disabled = state.seq === 0;
  }

  function makePin(n, r) {
    const pin = document.createElement('div');
    pin.className = NS + '-pin';
    pin.setAttribute('data-ayna', '1');
    pin.innerHTML = '<b></b><i>×</i>';
    pin.querySelector('b').textContent = String(n);
    pin.title = 'Click to remove this comment';
    pin.style.left = r.x + 'px';
    pin.style.top = r.y + 'px';
    document.documentElement.appendChild(pin);
    state.pins.push(pin);
    return pin;
  }

  /* A mistaken pin should be one click to undo, not a reason to restart. */
  function bindPinRemoval(pin, id) {
    if (!id) return;
    pin.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const res = await window.__aynaRemove(id);
      if (!res || !res.ok) return;
      pin.remove();
      state.pins = state.pins.filter((p) => p !== pin);
      state.seq = res.count;
      refreshTaskCount();
      // Renumber what's left so the pins match the list Claude receives.
      state.pins.forEach((p, i) => {
        const label = p.querySelector('b');
        if (label) label.textContent = String(i + 1);
      });
      refreshCount();
    });
  }

  function countLabel() {
    return state.seq + (state.seq === 1 ? ' comment' : ' comments');
  }

  // Node flips the overlay into review mode after it has reloaded the page.
  window.__aynaReview = () => setPhase('review');

  /*
    A login can arrive after load — an SPA modal, a session expiring mid-review.
    Detecting it only once at startup left the user clicking a comment box onto a
    dialog they needed to fill in.
  */
  function watchForSignIn() {
    let queued = false;
    const check = () => {
      queued = false;
      if (state.phase !== 'comment' || state.mode !== 'comment') return;
      if (!looksLikeSignIn()) return;
      state.signIn = true;
      state.mode = 'browse';
      setPhase('comment');
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(check, 150);
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  const isOurs = (el) => !el || !el.closest || !!el.closest('[data-ayna]');

  const TEXT_INPUT = /^(text|email|password|search|tel|url|number|date|time|month|week|datetime-local)$/;

  /*
    Controls the user needs to actually operate — above all a login form. Clicking
    one used to open a comment box instead of focusing it, so the field stayed
    empty and there was no way to sign in without knowing to switch modes first.
  */
  function isFormField(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    if (tag === 'input') return TEXT_INPUT.test((el.type || 'text').toLowerCase());
    return false;
  }

  /*
    A control that submits the form you are standing in. Once fields are typable,
    blocking the button that sends them is a dead end: you can fill a login and
    never get past it. Scoped to inside a <form> so an ordinary page button is
    still something you comment on by clicking.
  */
  function isFormAction(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    const isButton =
      tag === 'button' || (tag === 'input' && /^(submit|button|image)$/.test((el.type || '').toLowerCase()));
    return isButton && !!el.closest('form');
  }

  /*
    A page you have to get past before there is anything to review.

    Deliberately narrow: a password field, or a URL that says so. An
    "email input + submit button" rule was tempting but matches the newsletter
    signup in the footer of half the landing pages you would want to review, and
    starting those in browse mode would be worse than the problem it solves.
    Email-only gates still work — form fields and submit controls are operable in
    comment mode regardless.
  */
  function looksLikeSignIn() {
    if (document.querySelector('input[type=password]')) return true;
    return /(^|\/)(sign-?in|log-?in|auth|sso|oauth)(\/|$)/i.test(location.pathname);
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  }

  function place(el) {
    if (!hl) return;
    const r = rectOf(el);
    hl.style.display = 'block';
    hl.style.left = r.x + 'px';
    hl.style.top = r.y + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    showTag(el, r);
  }

  function hide() {
    if (hl) hl.style.display = 'none';
    if (tag) tag.style.display = 'none';
  }

  /** Short devtools-style descriptor, so you can see what you're about to pick. */
  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const cls = [...el.classList].filter((c) => c.indexOf(NS) !== 0)[0];
    return cls ? s + '.' + cls : s;
  }

  /*
    Like describe(), but for prose aimed at Claude. Sibling elements usually share
    a class ("div.plan before div.plan" tells nobody anything), so lead with the
    element's own text — that is what actually identifies it in the source.
  */
  function label(el) {
    const base = describe(el);
    const text = (el.innerText || '').trim().split('\n')[0].slice(0, 28);
    return text ? base + ' "' + text + '"' : base;
  }

  function showTag(el, r) {
    if (!tag) return;
    const canClimb = el.parentElement && el.parentElement !== document.documentElement;
    const operable = isFormField(el) || isFormAction(el);
    // A canvas is one element however much is drawn in it — the shapes inside are
    // pixels, not nodes, so traversal has nothing finer to offer. Framing a region
    // is the only way to point at part of it, and the crop carries the meaning.
    const isCanvas = el.tagName.toLowerCase() === 'canvas';
    tag.innerHTML =
      '<b></b>' +
      (isCanvas
        ? '<i>drag a box — a canvas is one element</i>'
        : operable
          ? '<i>⌥click to comment on it</i>'
          : canClimb || state.climb
            /*
              "resize" was wrong and confusing: the arrow keys do not resize
              anything, they walk up and down the element tree to change what is
              selected. Someone reading it reasonably expects to be adjusting a
              box.
            */
            ? '<i>↑↓ select wider · ⇧click to add</i>'
            : '');
    tag.querySelector('b').textContent = describe(el);
    tag.style.display = 'block';
    // Sit above the box unless we're at the top of the page.
    const above = r.y > 24;
    tag.style.left = r.x + 'px';
    tag.style.top = (above ? r.y - 22 : r.y + r.height + 4) + 'px';
  }

  /** The element the mouse is on, walked up `climb` levels. */
  function resolveTarget() {
    let el = state.hoverBase;
    for (let i = 0; i < state.climb && el && el.parentElement; i++) {
      if (el.parentElement === document.body || el.parentElement === document.documentElement) break;
      el = el.parentElement;
    }
    return el;
  }

  function markPicked(el) {
    const r = rectOf(el);
    const box = document.createElement('div');
    box.className = NS + '-picked';
    box.setAttribute('data-ayna', '1');
    box.style.left = r.x + 'px';
    box.style.top = r.y + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    document.documentElement.appendChild(box);
    return box;
  }

  function clearSelection() {
    for (const s of state.selection) s.box.remove();
    state.selection = [];
  }

  // Precise enough to find the node again, readable enough to grep for.
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => c.indexOf(NS) !== 0).slice(0, 2);
      if (classes.length) part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((s) => s.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node === document.body) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function styleDigest(el) {
    const s = getComputedStyle(el);
    const keys = [
      'display', 'position', 'width', 'height', 'margin', 'padding', 'font-family',
      'font-size', 'font-weight', 'line-height', 'color', 'background-color',
      'border', 'border-radius', 'box-shadow', 'flex-direction', 'gap',
      'grid-template-columns', 'text-align',
    ];
    const out = {};
    for (const k of keys) {
      const v = s.getPropertyValue(k);
      if (v && v !== 'none' && v !== 'normal') out[k] = v;
    }
    return out;
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!state.picking || state.mode === 'browse') return;
      if (isOurs(e.target)) {
        hide();
        return;
      }
      // A new element under the cursor resets how far we had walked up.
      if (e.target !== state.hoverBase) {
        state.hoverBase = e.target;
        state.climb = 0;
      }
      place(resolveTarget());
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!state.picking || isOurs(e.target)) return;
      if (state.suppressClick) {
        state.suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      /*
        Browse mode lets the page work as a page. Without it every link is dead
        while the overlay is up, so a multi-page review is impossible — you could
        only ever comment on the first screen.

        Deliberately not ⌘/ctrl/middle-click: those open a new tab in every
        browser, and the overlay is bound to this page, so you would land
        somewhere ayna isn't watching.
      */
      if (state.mode === 'browse') return;

      // Filling and submitting a form must always be possible.
      // Alt-click to comment on the control itself instead.
      if ((isFormField(e.target) || isFormAction(e.target)) && !e.altKey) return;

      e.preventDefault();
      e.stopPropagation();
      // In move mode the drag handlers own the mouse.
      if (state.mode === 'move') return;
      const el = resolveTarget() || e.target;

      // Shift-click accumulates. A plain click finishes the set — and includes the
      // element you just clicked, which is what "click the third card" should mean.
      const held = state.selection.some((s) => s.el === el);
      if (!held) state.selection.push({ el, box: markPicked(el) });
      if (e.shiftKey) return;

      openPopover(el);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        // Let the page's own field handle Escape if that is where focus is.
        if (isFormField(document.activeElement) && !pop) return;
        closePopover();
        closeCard();
        clearSelection();
        return;
      }
      if (!state.picking || !state.hoverBase) return;
      // ArrowUp/Down drive DOM traversal — but not while someone is filling a field.
      if (isFormField(document.activeElement)) return;

      // Walk up/down the tree without moving the mouse.
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const before = resolveTarget();
        state.climb += 1;
        if (resolveTarget() === before) state.climb -= 1; // already at the top
        place(resolveTarget());
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.climb = Math.max(0, state.climb - 1);
        place(resolveTarget());
      }
    },
    true,
  );

  /*
    Marquee selection.

    "Comment on this bit" is often about an area, not a single node — a cramped
    header block, a row of cards, the gap between two sections. Dragging a box
    captures that region as its own crop, plus every element substantially inside
    it so Claude still gets selectors and source locations to edit.
  */
  let marqueeBox = null;

  function ensureMarquee() {
    if (marqueeBox) return marqueeBox;
    marqueeBox = document.createElement('div');
    marqueeBox.className = NS + '-marquee';
    marqueeBox.setAttribute('data-ayna', '1');
    document.documentElement.appendChild(marqueeBox);
    return marqueeBox;
  }

  function marqueeRect(m) {
    return {
      x: Math.min(m.startX, m.curX),
      y: Math.min(m.startY, m.curY),
      width: Math.abs(m.curX - m.startX),
      height: Math.abs(m.curY - m.startY),
    };
  }

  /** Elements mostly inside the box — the ones the user plausibly meant. */
  function elementsWithin(r) {
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (isOurs(el)) continue;
      const b = rectOf(el);
      if (!b.width || !b.height) continue;
      const overlapW = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x);
      const overlapH = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y);
      if (overlapW <= 0 || overlapH <= 0) continue;
      if ((overlapW * overlapH) / (b.width * b.height) < 0.75) continue;
      hits.push(el);
    }
    // Drop elements whose ancestor is already in the set — keep the outermost.
    const outermost = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
    return outermost.slice(0, 8);
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      if (state.mode !== 'comment' || state.phase !== 'comment' || isOurs(e.target) || pop) return;
      // Fields and submit controls still need real mouse events.
      if (isFormField(e.target) || isFormAction(e.target)) return;

      /*
        Swallow the press. Without this the page gets it too: on a canvas app the
        diagram pans away underneath the box you are trying to drag, and a drawing
        tool starts a stroke. Comment mode should be inert for the page.
      */
      e.preventDefault();
      e.stopPropagation();

      state.marquee = {
        startX: e.pageX,
        startY: e.pageY,
        curX: e.pageX,
        curY: e.pageY,
        active: false,
      };
    },
    true,
  );

  document.addEventListener(
    'mousemove',
    (e) => {
      const m = state.marquee;
      if (!m) return;
      m.curX = e.pageX;
      m.curY = e.pageY;
      const r = marqueeRect(m);
      // A few pixels of jitter is a click, not a drag.
      if (!m.active && Math.max(r.width, r.height) < 8) return;
      m.active = true;
      hide();
      const box = ensureMarquee();
      box.style.display = 'block';
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      /*
        Say how big it is while it is being drawn.

        The size only appeared afterwards, inside the comment box, by which point
        the choice had been made. Framing a region on a canvas is the one gesture
        where the pixels are the whole message, and it was the one gesture with no
        feedback until it was too late to adjust.
      */
      box.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    },
    true,
  );

  document.addEventListener(
    'mouseup',
    (e) => {
      const m = state.marquee;
      state.marquee = null;
      if (!m || !m.active) return;
      if (marqueeBox) marqueeBox.style.display = 'none';

      const r = marqueeRect(m);
      if (r.width < 12 || r.height < 12) return;

      // The click event that follows this mouseup would reopen a single-element
      // popover over the top of the region one.
      state.suppressClick = true;
      e.preventDefault();
      e.stopPropagation();

      const within = elementsWithin(r);
      openPopover(within[0] || document.body, { rect: r, elements: within });
    },
    true,
  );

  /*
    Drag-to-reorder.

    Deliberately limited to reordering among siblings. Freeform "drop it anywhere"
    dragging produces absolute positioning that maps back to unmaintainable CSS —
    a reorder maps to an actual source change (move this block before that one),
    which is a thing Claude can apply cleanly.
  */
  let dropLine = null;

  function ensureDropLine() {
    if (dropLine) return dropLine;
    dropLine = document.createElement('div');
    dropLine.className = NS + '-drop';
    dropLine.setAttribute('data-ayna', '1');
    document.documentElement.appendChild(dropLine);
    return dropLine;
  }

  function siblingUnder(x, y, parent, exclude) {
    const under = document.elementFromPoint(x, y);
    if (!under || isOurs(under)) return null;
    let node = under;
    while (node && node.parentElement !== parent) node = node.parentElement;
    return node && node !== exclude ? node : null;
  }

  document.addEventListener(
    'mousedown',
    (e) => {
      if (state.mode !== 'move' || state.phase !== 'comment' || isOurs(e.target)) return;
      const el = resolveTarget() || e.target;
      const parent = el.parentElement;
      if (!parent || parent === document.body || parent.children.length < 2) return;

      e.preventDefault();
      state.drag = {
        el,
        parent,
        fromIndex: [...parent.children].indexOf(el),
        ref: null,
        placeBefore: true,
      };
      el.style.opacity = '0.4';
      hide();
    },
    true,
  );

  document.addEventListener(
    'mousemove',
    (e) => {
      const d = state.drag;
      if (!d) return;
      const sib = siblingUnder(e.clientX, e.clientY, d.parent, d.el);
      const line = ensureDropLine();
      if (!sib) {
        line.style.display = 'none';
        d.ref = null;
        return;
      }
      const r = sib.getBoundingClientRect();
      // Horizontal rows get a vertical caret, stacked blocks get a horizontal one.
      const horizontal = r.height > 0 && r.width / r.height < 3;
      d.placeBefore = horizontal
        ? e.clientX < r.left + r.width / 2
        : e.clientY < r.top + r.height / 2;
      d.ref = sib;

      line.style.display = 'block';
      if (horizontal) {
        line.style.left = (d.placeBefore ? r.left : r.right) + window.scrollX - 1.5 + 'px';
        line.style.top = r.top + window.scrollY + 'px';
        line.style.width = '3px';
        line.style.height = r.height + 'px';
      } else {
        line.style.left = r.left + window.scrollX + 'px';
        line.style.top = (d.placeBefore ? r.top : r.bottom) + window.scrollY - 1.5 + 'px';
        line.style.width = r.width + 'px';
        line.style.height = '3px';
      }
    },
    true,
  );

  document.addEventListener(
    'mouseup',
    async (e) => {
      const d = state.drag;
      if (!d) return;
      state.drag = null;
      d.el.style.opacity = '';
      if (dropLine) dropLine.style.display = 'none';
      if (!d.ref) return;

      const beforeDesc = label(d.ref);
      const movedDesc = label(d.el);
      const anchor = d.placeBefore ? d.ref : d.ref.nextSibling;

      // Apply it live so the user sees the new order straight away.
      d.parent.insertBefore(d.el, anchor);
      const toIndex = [...d.parent.children].indexOf(d.el);
      if (toIndex === d.fromIndex) return;

      const n = ++state.seq;
      // A reorder deserves a marker too, and the same one-click undo.
      const pin = makePin(n, rectOf(d.el));
      refreshCount();

      const res = await window.__aynaSubmit({
        kind: 'move',
        comment:
          'Reorder: move ' + movedDesc + ' ' + (d.placeBefore ? 'before ' : 'after ') + beforeDesc +
          ' (position ' + (d.fromIndex + 1) + ' → ' + (toIndex + 1) + ' among its siblings).',
        selector: selectorFor(d.el),
        tag: d.el.tagName.toLowerCase(),
        id: d.el.id || null,
        classes: [...d.el.classList].filter((c) => c.indexOf(NS) !== 0),
        text: (d.el.innerText || '').trim().slice(0, 400),
        outerHTML: d.el.outerHTML.slice(0, 1500),
        elements: [describeElement(d.el)],
        move: {
          parentSelector: selectorFor(d.parent),
          movedSelector: selectorFor(d.el),
          referenceSelector: selectorFor(d.ref),
          placeBefore: d.placeBefore,
          fromIndex: d.fromIndex,
          toIndex,
          siblingOrder: [...d.parent.children].map((c) => label(c)),
        },
        rect: rectOf(d.el),
        styles: styleDigest(d.el),
        images: [],
        viewport: { width: window.innerWidth, height: window.innerHeight },
        url: location.href,
      });
      bindPinRemoval(pin, res && res.id);
      refreshTaskCount();
    },
    true,
  );

  let pop = null;

  /*
    Anchor a floating panel to an element without letting it fall off screen.

    Page coordinates plus position:absolute put the box wherever the element was,
    which on a centred full-viewport layout can be half outside the window — you
    end up reading a comment box that is clipped at the edge. Measure in viewport
    space, flip above the target when there is no room below, and clamp.
  */
  /** How much of the bottom the mode bar occupies right now, wrapping included. */
  /*
    Ask the window how tall it is, not the document.

    documentElement.clientHeight is the viewport only in standards mode. On a page
    with no doctype the browser is in quirks mode and it returns the height of the
    content instead — 4344 on an 800px window, in the case that found this. Every
    "is there room below?" test then passed trivially, so the comment box never
    flipped above its anchor and simply ran off the bottom of the screen, taking
    "Add comment" with it. The user could see the box and could not file the
    comment, and the dead panel swallowed the next click.

    innerHeight is the viewport in both modes.
  */
  function viewportH() {
    return Math.round(window.visualViewport?.height ?? window.innerHeight);
  }
  function viewportW() {
    return Math.round(window.visualViewport?.width ?? window.innerWidth);
  }

  /*
    Reserve the space the bar occupies instead of overlaying it.

    Two layouts need two answers. A page that flows normally moves down with
    padding on the root. An app pinned to the viewport — `position: fixed`,
    `height: 100vh`, every canvas editor — ignores that completely, because its
    root is positioned against the viewport and not against the document. A
    transform on the root element makes it the containing block for those fixed
    descendants, which is the only thing that actually moves them.

    The transform is the more invasive of the two, so it is used only where the
    cheap answer provably does not work.
  */
  let reserved = '';
  function reserveForBar() {
    if (!bar) return;

    /*
      Re-measure whenever the bar changes shape, not when we think it might have.

      This was re-run on phase change from a microtask, which is before the
      browser has laid the new bar out — so it measured the height of the bar that
      had just been replaced. Review has more buttons than commenting and wraps to
      70px where the old one was 52, and the page stayed pushed down by 52: the
      app's own fixed header sat in the 18px difference, underneath ayna's bar,
      with its buttons unclickable. An observer cannot be early.
    */
    if (!bar.__aynaRO && typeof ResizeObserver === 'function') {
      bar.__aynaRO = new ResizeObserver(() => reserveForBar());
      bar.__aynaRO.observe(bar);
    }

    const h = Math.round(bar.getBoundingClientRect().height);
    const key = h + ':' + (consoleEl ? Math.round(consoleEl.getBoundingClientRect().height) : 0);
    if (!h || key === reserved) return;
    reserved = key;

    /*
      Move the page, not the root.

      Transforming documentElement moved the bar with it — the overlay is
      appended to documentElement precisely so the app cannot style it — and the
      app's nav ended up back underneath. Body is the boundary that separates the
      two: the app lives inside it, the review chrome does not.
    */
    const root = document.body;
    document.documentElement.style.setProperty('--ayna-bar-h', h + 'px');
    /*
      Publish the insets so a measurement can correct for them without anything
      being moved. The alternative — handing the space back to measure and taking
      it again — flickered the whole app on every click.
    */
    document.documentElement.style.setProperty('--ayna-inset-top', h + 'px');

    /*
      Padding on the root was the first attempt and it only moves content that
      flows. Anything `position: fixed` — a sticky header, a canvas app, a toolbar
      pinned to an edge — is positioned against the viewport and ignores it
      entirely, so the app's own top bar stayed exactly where the review bar now
      was. Measured on a page with fixed chrome at all four edges, the app's nav
      buttons were still unclickable.

      A transform on the root makes it the containing block for its fixed
      descendants, which is the only thing that moves them. So it is the rule,
      not the exception.
    */
    /*
      The console takes space at the bottom on the same principle: whatever ayna
      draws over the app, the app gets that much less room rather than being
      covered by it.
    */
    // Minimised is smaller, not weightless: a 37px strip resting on the bottom of
    // someone's app is still ayna covering something.
    const foot = consoleEl ? Math.round(consoleEl.getBoundingClientRect().height) : 0;

    root.style.setProperty('transform', 'translateY(' + h + 'px)', 'important');
    /*
      Viewport units, not percentages.

      `calc(100% - h)` resolves against the root's height, which is `auto` on most
      pages — so body's padding box came out zero, and a `position: fixed;
      inset: 0` app sized against it collapsed to nothing. Its controls piled up
      at the top of the screen, underneath the very bar this is meant to keep
      clear of them. `100vh` is the window either way.
    */
    /*
      Real pixels, measured now — not 100vh.

      `100vh` and the window's own idea of its height disagree by a stable margin
      in some browsers and window states, and the page kept ending about twenty
      pixels below the console no matter what the arithmetic said. Measuring the
      viewport the same way everything else here measures it removes the argument.
    */
    document.documentElement.style.setProperty('--ayna-inset-bottom', foot + 'px');
    const room = Math.max(120, viewportH() - h - foot);
    root.style.setProperty('height', room + 'px', 'important');
    root.style.setProperty('min-height', room + 'px', 'important');

    /*
      Then check, because the arithmetic is not the whole story.

      A first child's top margin collapses out through body, so the box starts
      lower than the transform put it and ends that much lower too — the page
      still finished twenty-one pixels underneath the console with every number
      correct. Forcing a block formatting context would fix the collapse and
      would also overwrite whatever display the app chose for its own body, which
      is not a trade worth making for a margin. Measuring the result and taking
      the difference off costs one reflow and assumes nothing.
    */
    const overshoot = Math.round(root.getBoundingClientRect().bottom - (viewportH() - foot));
    if (overshoot > 0) {
      root.style.setProperty('height', Math.max(120, room - overshoot) + 'px', 'important');
      root.style.setProperty('min-height', Math.max(120, room - overshoot) + 'px', 'important');
    }
  }

  /** Put the page back exactly as it was; a review must leave no trace. */
  function releaseBarSpace() {
    const root = document.body;
    document.documentElement.style.removeProperty('--ayna-bar-h');
    document.documentElement.style.removeProperty('--ayna-inset-top');
    document.documentElement.style.removeProperty('--ayna-inset-bottom');
    root.style.removeProperty('padding-top');
    root.style.removeProperty('transform');
    root.style.removeProperty('height');
    root.style.removeProperty('min-height');
    reserved = '';
  }
  window.__aynaReleaseSpace = releaseBarSpace;
  /*
    Give the page its full height back for the length of a measurement.

    ayna reserves space at both edges, so a live audit was describing a page a
    couple of hundred pixels shorter than the one the user actually ships — a
    real collision could stop reproducing simply because ayna was open. The
    person cares about their app, not their app with a review panel attached.
  */
  window.__aynaReserveSpace = () => {
    reserved = '';
    reserveForBar();
  };

  /*
    The rect the bar owns, in viewport coordinates.

    It was a single number — how much of the *bottom* to keep clear — which
    stopped meaning anything the moment the bar moved to the top. Floating panels
    ask this to decide where they fit, and a stale answer put them under the bar.
  */
  function barZone() {
    if (!bar) return { top: 0, bottom: 0, height: 0 };
    const b = bar.getBoundingClientRect();
    if (!b.height) return { top: 0, bottom: 0, height: 0 };
    return { top: 0, bottom: Math.round(b.bottom) + 12, height: Math.round(b.height) };
  }

  /** Kept for callers that only care how much vertical room is gone. */
  function barSafeZone() {
    return barZone().height ? barZone().height + 28 : 0;
  }

  function placeFloating(el, r) {
    // Remember the anchor so a resize can put it back in the right place.
    el.__aynaAnchor = r;

    const vw = viewportW();
    const vh = viewportH();
    const safe = barSafeZone();

    /*
      Bound the panel to what the window can actually show, then measure it. A
      panel taller than the viewport used to run off the bottom and take its
      buttons with it — visible, unreachable. Its body scrolls instead.
    */
    el.style.maxHeight = Math.max(160, vh - barZone().bottom - 24) + 'px';

    const box = el.getBoundingClientRect();
    const w = box.width || 320;
    const h = box.height || 240;

    const x = r.x - window.scrollX;
    const y = r.y - window.scrollY;

    /*
      The bar is at the top now, so the floor is the window and the ceiling is the
      bar. When it was at the bottom those were the other way round, and a panel
      that merely swapped ends would have opened underneath it.
    */
    const zone = barZone();
    const ceiling = zone.bottom + 8;
    // The console owns the bottom now, so the floor is its top edge — not the
    // window's. Without this the comment box opened underneath it.
    const consoleTop = consoleEl ? Math.round(consoleEl.getBoundingClientRect().top) : vh;
    const floor = Math.min(vh, consoleTop) - 8;

    let top = y + r.height + 10;
    if (top + h > floor) top = y - h - 10; // no room below — flip above
    if (top < ceiling) top = ceiling; // nor above — sit under the bar

    // Last resort: if it fits nowhere, keep the bottom on screen rather than the
    // top. The buttons are at the bottom, and a panel whose buttons you cannot
    // reach is the same as no panel.
    if (top + h > floor) top = Math.max(ceiling, floor - h);

    el.style.position = 'fixed';
    el.style.left = Math.min(Math.max(x, 8), Math.max(8, vw - w - 8)) + 'px';
    el.style.top = Math.max(barZone().bottom + 8, top) + 'px';

    /*
      Place it again when it grows.

      Position was computed once, from a measurement taken the instant the panel
      was created — before the region crop had come back from Node and been added
      to it. The image then landed, the panel got taller, and everything below the
      fold went with it: "Add comment" rendered at y=823 in an 800px window, so the
      only way to file the comment was off screen. Nothing recovered from it
      either, because the stale panel stayed open and swallowed the next click.

      Anything that changes the height — the crop arriving, a pasted screenshot,
      the textarea growing — has to move it back into view.
    */
    el.__aynaPlacedH = h;
    if (!el.__aynaRO && typeof ResizeObserver === 'function') {
      el.__aynaRO = new ResizeObserver(() => {
        if (!el.isConnected || !el.__aynaAnchor) return;
        // Only react to a real size change, or re-placing would retrigger this.
        if (Math.abs(el.getBoundingClientRect().height - (el.__aynaPlacedH ?? 0)) < 2) return;
        placeFloating(el, el.__aynaAnchor);
      });
      el.__aynaRO.observe(el);
    }
  }

  /*
    Everything the overlay draws is positioned from measurements taken once. Resize
    the window — or go full screen — and the page reflows while the markers, pins
    and panels stay where the old layout put them. Recompute on any change to the
    viewport.
  */
  let relayoutQueued = false;
  let reviewSettleTimer = 0;
  // True between pressing Close and the window actually going, so the bar is not
  // rebuilt out from under the one button that can call it off.
  let closing = false;

  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      hide(); // the hover highlight is stale the moment anything moves
      reserveForBar();
      if (pop && pop.__aynaAnchor) placeFloating(pop, pop.__aynaAnchor);
      if (card && card.__aynaAnchor) placeFloating(card, card.__aynaAnchor);
      if (panel) {
        panel.style.maxHeight =
          Math.max(200, viewportH() - barSafeZone() - 32) + 'px';
      }
      // Review markers are anchored to live elements, so re-derive them —
      // cheaply now, and properly once the user stops dragging.
      if (state.phase === 'review') {
        repositionReview();
        clearTimeout(reviewSettleTimer);
        reviewSettleTimer = setTimeout(() => {
          if (state.phase === 'review') renderReview().then(updateReviewBar);
        }, 200);
      }
    });
  }

  window.addEventListener('resize', relayout, { passive: true });
  window.addEventListener('orientationchange', relayout, { passive: true });

  function closePopover() {
    if (pop) {
      pop.remove();
      pop = null;
    }
    state.picking = true;
    state.target = null;
  }

  /** Everything Node needs to find this element again and edit its source. */
  function describeElement(el) {
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].filter((c) => c.indexOf(NS) !== 0),
      text: (el.innerText || '').trim().slice(0, 400),
      outerHTML: el.outerHTML.slice(0, 1500),
      rect: rectOf(el),
      styles: styleDigest(el),
    };
  }

  function unionRect(rects) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  function openPopover(el, region) {
    closePopover();
    state.picking = false;
    state.target = el;
    if (!region) place(el);

    /*
      Three ways to aim a comment, in order of precedence:
        region        — a box the user dragged; the rect is exactly what they framed
        shift-click   — an explicit set of elements
        single click  — one element
    */
    const targets = region
      ? region.elements
      : state.selection.length
        ? state.selection.map((s) => s.el)
        : [el];
    const described = targets.map(describeElement);
    const r = region
      ? region.rect
      : unionRect(described.map((d) => d.rect));
    const images = [];

    pop = document.createElement('div');
    pop.className = NS + '-pop';
    pop.setAttribute('data-ayna', '1');
    /*
      What you are commenting on goes first, as a picture.

      The box opened with a monospace CSS path across the top — the most valuable
      line in the panel spent on a detail only Claude reads — and the crop of what
      you had framed appeared as a 48px square below the buttons with an AUTO
      badge over it, which read as a broken image rather than a preview. On a
      canvas that crop is the entire comment, so it is now the first thing in the
      box and big enough to recognise. The selector moved to the footer, where it
      belongs: useful, not important.

      The two hint lines became one. "The framed region is attached
      automatically" and "Paste, drop, or choose an image · Esc to cancel" were
      stacked, saying three different things at the same volume.
    */
    pop.innerHTML =
      '<div class="' + NS + '-body">' +
      '<div class="' + NS + '-preview"></div>' +
      '<textarea placeholder="' +
        (region ? 'What should change in this area?' : 'What should change about this?') +
      '"></textarea>' +
      '<div class="' + NS + '-thumbs"></div>' +
      '<div class="' + NS + '-hint">Paste or ' +
      '<label class="' + NS + '-attach">attach an image<input type="file" accept="image/*" multiple hidden></label>' +
      ' to show what you mean</div>' +
      '<div class="' + NS + '-sel"></div>' +
      '</div>' +
      '<div class="' + NS + '-row">' +
      '<span class="' + NS + '-esc">Esc to cancel</span>' +
      '<button class="' + NS + '-cancel">Cancel</button>' +
      '<button class="' + NS + '-save">Add comment</button>' +
      '</div>';

    const sel = described.length ? described[0].selector : 'region';
    pop.querySelector('.' + NS + '-sel').textContent = region
      ? 'region ' + Math.round(r.width) + '×' + Math.round(r.height) +
        (described.length ? ' · ' + described.map((d) => d.selector.split(' > ').pop()).join(', ') : '')
      : described.length > 1
        ? described.length + ' elements: ' + described.map((d) => d.selector.split(' > ').pop()).join(', ')
        : sel;

    document.documentElement.appendChild(pop);
    placeFloating(pop, r);

    const ta = pop.querySelector('textarea');
    ta.focus();

    /*
      Show what was framed. On a canvas this crop is the whole comment — there is
      no selector worth anything — so seeing it sit there as an attachment is the
      difference between trusting the tool and hoping.
    */
    if (region && window.__aynaPreview) {
      const preview = pop.querySelector('.' + NS + '-preview');
      // Say it is coming. A blank space that fills in silently is
      // indistinguishable from one that never will.
      preview.classList.add(NS + '-loading');
      preview.textContent = 'capturing the area…';
      window.__aynaPreview(r)
        .then((dataUrl) => {
          if (!pop) return;
          preview.classList.remove(NS + '-loading');
          if (!dataUrl) {
            preview.textContent = 'the area could not be captured — describe it instead';
            return;
          }
          preview.textContent = '';
          const img = document.createElement('img');
          img.src = dataUrl;
          img.alt = 'The area you framed, attached to this comment';
          preview.appendChild(img);
          const tag = document.createElement('span');
          tag.className = NS + '-cap';
          tag.textContent = 'attached · ' + Math.round(r.width) + '×' + Math.round(r.height);
          preview.appendChild(tag);
          // The box just grew; the observer in placeFloating moves it back into view.
        })
        .catch(() => {
          preview.classList.remove(NS + '-loading');
          preview.textContent = 'the area could not be captured — describe it instead';
        });
    }

    const thumbs = pop.querySelector('.' + NS + '-thumbs');

    // Paste, drop and file-picker all funnel through here. A reference image is
    // often the clearest way to say what you want, so make it hard to miss.
    function attach(file) {
      if (!file || file.type.indexOf('image/') !== 0) return;
      const reader = new FileReader();
      reader.onload = () => {
        images.push(reader.result);
        const img = document.createElement('img');
        img.src = reader.result;
        img.title = file.name || 'reference';
        thumbs.appendChild(img);
      };
      reader.readAsDataURL(file);
    }

    ta.addEventListener('paste', (ev) => {
      for (const item of (ev.clipboardData && ev.clipboardData.items) || []) {
        if (item.type.indexOf('image/') === 0) attach(item.getAsFile());
      }
    });

    pop.querySelector('.' + NS + '-attach input').addEventListener('change', (ev) => {
      for (const f of ev.target.files || []) attach(f);
    });

    for (const evt of ['dragenter', 'dragover']) {
      pop.addEventListener(evt, (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        pop.classList.add(NS + '-dragover');
      });
    }
    for (const evt of ['dragleave', 'drop']) {
      pop.addEventListener(evt, (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        pop.classList.remove(NS + '-dragover');
        if (evt === 'drop') {
          for (const f of (ev.dataTransfer && ev.dataTransfer.files) || []) attach(f);
        }
      });
    }

    pop.querySelector('.' + NS + '-cancel').addEventListener('click', () => {
      // Leaving the selection behind made every cancelled click accumulate, so
      // three separate attempts became one comment covering three elements.
      clearSelection();
      closePopover();
    });
    pop.querySelector('.' + NS + '-save').addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text && !images.length) {
        ta.focus();
        return;
      }

      const first = described[0] ?? { selector: 'body', tag: 'body', id: null, classes: [], text: '', outerHTML: '', styles: {} };
      const payload = {
        kind: region ? 'region' : 'comment',
        region: region ? { rect: r, elementCount: described.length } : null,
        comment: text,
        // Primary target stays flat for simple single-element comments.
        selector: first.selector,
        tag: first.tag,
        id: first.id,
        classes: first.classes,
        text: first.text,
        outerHTML: first.outerHTML,
        // Every element this comment covers (one, unless shift-click was used).
        elements: described,
        rect: r,
        styles: first.styles,
        images,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        url: location.href,
      };

      clearSelection();
      closePopover();

      const n = ++state.seq;
      const pin = makePin(n, r);
      refreshCount();

      const res = await window.__aynaSubmit(payload);
      bindPinRemoval(pin, res && res.id);
      refreshTaskCount(); // the list gained one; say so without opening it
    });
  }

  /*
    Review overlay.

    After Claude's edits land, each comment is re-anchored on the *changed* page —
    by selector where the element still exists, by its recorded rect otherwise — so
    you can see exactly which portion was touched and judge it in place. Approving
    doesn't delete the comment: it stays as a green marker you can click to read,
    which is the record of what changed across the session.
  */
  const reviewNodes = [];
  let card = null;

  function clearReview() {
    for (const n of reviewNodes) n.remove();
    reviewNodes.length = 0;
    closeCard();
  }

  function closeCard() {
    if (card) {
      card.remove();
      card = null;
    }
  }

  function anchorFor(c) {
    if (c.selector) {
      try {
        const el = document.querySelector(c.selector);
        if (el) return rectOf(el);
      } catch {
        // Selector may not survive a structural rewrite; fall back to the rect.
      }
    }
    return c.rect;
  }

  /*
    Move the review markers; do not rebuild them.

    renderReview is async — it asks Node for the comment list over the exposed
    function bridge — and it tears down and recreates every marker node. Calling it
    from the resize handler meant an IPC round-trip and a full DOM rebuild on every
    animation frame, so dragging the window to full screen fired ~60 of them a
    second. That is the stutter, and it lands precisely when the user is resizing.

    Positions are all that can change during a resize. The comments have not moved,
    only their elements have, so re-derive rects from the nodes we already built.
  */
  /*
    Where a verdict bar goes without landing on somebody else's element.

    It always sat 28px above its own element, which on a stacked layout is inside
    the element above — the bar for the sub-heading was drawn across the bottom of
    the headline, over the very text that headline's own comment was about. When
    the space above belongs to something else that is also under review, the bar
    goes inside its own element instead, where it can only cover what it refers to.
  */
  function barTopFor(c, r, others) {
    const rects = others
      .filter((o) => o !== c)
      .map(anchorFor)
      .filter((q) => q && q.width);

    const free = (y) => {
      const band = { x: r.x, y, w: r.width, h: 26 };
      return !rects.some(
        (q) =>
          band.x < q.x + q.width &&
          band.x + band.w > q.x &&
          band.y < q.y + q.height &&
          band.y + band.h > q.y,
      );
    };

    /*
      Above is the natural place, below is the fallback, and only if both are
      taken does the bar go inside — covering the very text it is asking about is
      the worst of the three, so it has to be earned.

      The ceiling is the review bar, not the top of the window. Clamping to 0 put
      the verdict buttons for anything near the top of the page underneath ayna's
      own bar, where they could be seen and not clicked: the exact fault this tool
      reports in other people's UIs, committed in the one phase whose whole
      purpose is pressing those buttons.
    */
    const ceiling = barZone().bottom + 4;
    if (r.y - 28 >= ceiling && free(r.y - 28)) return r.y - 28;
    if (free(r.y + r.height + 4)) return r.y + r.height + 4;
    return Math.max(ceiling, r.y + 4);
  }

  function repositionReview() {
    const all = reviewNodes.map((n) => n.__aynaFor).filter(Boolean);
    for (const n of reviewNodes) {
      const c = n.__aynaFor;
      if (!c) continue;
      const r = anchorFor(c);
      if (!r || !r.width) continue;
      n.style.left = r.x + 'px';
      if (n.__aynaKind === 'bar') {
        n.style.top = barTopFor(c, r, all) + 'px';
      } else {
        n.style.top = r.y + 'px';
        n.style.width = r.width + 'px';
        n.style.height = r.height + 'px';
      }
    }
  }

  async function renderReview() {
    clearReview();
    if (!window.__aynaList) return;
    const comments = await window.__aynaList().catch(() => []);
    // Only anchor comments made on this page.
    const here = comments.filter((c) => !c.url || c.url.split('#')[0] === location.href.split('#')[0]);

    for (const c of here) {
      const r = anchorFor(c);
      if (!r || !r.width) continue;

      const box = document.createElement('div');
      box.className = NS + '-rev';
      box.setAttribute('data-ayna', '1');
      box.dataset.status = c.status;
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      box.__aynaFor = c;
      box.__aynaKind = 'box';
      document.documentElement.appendChild(box);
      reviewNodes.push(box);

      /*
        The verdict lives on the element that changed. Making the user open a card
        first put a click between them and the decision, for every single comment.
      */
      const barEl = document.createElement('div');
      barEl.className = NS + '-revbar';
      barEl.setAttribute('data-ayna', '1');
      barEl.style.left = r.x + 'px';
      barEl.style.top = barTopFor(c, r, here) + 'px';

      const pin = document.createElement('div');
      pin.className = NS + '-revpin';
      pin.dataset.status = c.status;
      pin.title = c.comment + '  (click to read)';
      barEl.appendChild(pin);

      const ok = document.createElement('button');
      ok.className = NS + '-ok';
      ok.textContent = 'Looks right';
      const no = document.createElement('button');
      no.className = NS + '-no';
      no.textContent = 'Needs work';
      barEl.appendChild(ok);
      barEl.appendChild(no);

      barEl.__aynaFor = c;
      barEl.__aynaKind = 'bar';
      document.documentElement.appendChild(barEl);
      reviewNodes.push(barEl);

      const paint = () => {
        pin.dataset.status = c.status;
        box.dataset.status = c.status;
        pin.textContent =
          c.status === 'approved'
            ? '✓ ' + c.n
            : c.status === 'rejected'
              ? '↺ ' + c.n
              : c.status === 'in_progress'
                ? '⋯ ' + c.n // Claude has picked this one up
                : c.status === 'proposed'
                  ? '? ' + c.n // Claude's own suggestion, awaiting a word
                  : String(c.n);
        // Once judged, collapse to the badge — it stays as the record.
        ok.style.display = c.status === 'open' ? '' : 'none';
        no.style.display = c.status === 'open' ? '' : 'none';
      };
      paint();

      const set = async (status) => {
        const res = await window.__aynaResolve(c.id, status);
        if (!res || !res.ok) return;
        c.status = status;
        paint();
        closeCard();
        updateReviewBar();
      };

      ok.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        set('approved');
      });
      no.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        set('rejected');
      });
      pin.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openCard(c, r, box, pin, paint);
      });
    }
  }

  function openCard(c, r, box, pin, paint) {
    closeCard();
    card = document.createElement('div');
    card.className = NS + '-card';
    card.setAttribute('data-ayna', '1');
    card.dataset.status = c.status;

    const done = c.status === 'approved';
    const proposal = c.status === 'proposed';

    /*
      A proposal is answered, not judged. Claude found this one itself, so the
      choices are go ahead, leave it, or say what to do instead — and that last
      one turns the suggestion into the user's own instruction rather than making
      them dismiss the card and write a comment from scratch.
    */
    card.innerHTML =
      '<div class="' + NS + '-body">' +
      '<div class="' + NS + '-badge"></div>' +
      '<p class="' + NS + '-text"></p>' +
      (proposal && c.fix ? '<div class="' + NS + '-fix"></div>' : '') +
      '<div class="' + NS + '-when"></div>' +
      (proposal ? '<textarea placeholder="…or tell me what to do instead"></textarea>' : '') +
      '</div>' +
      '<div class="' + NS + '-row">' +
      (proposal
        ? '<button class="' + NS + '-cancel" data-act="decline">Leave it</button>' +
          '<button class="' + NS + '-save" data-act="go">Go ahead</button>'
        : done
          ? '<button class="' + NS + '-cancel" data-act="reopen">Reopen</button>'
          /*
            Same colours as the inline bar. "Looks right" was the generic blue
            primary here and green out on the page, so one decision looked like
            two different ones depending on where you happened to click it.
          */
          : '<button class="' + NS + '-no" data-act="reject">Needs work</button>' +
            '<button class="' + NS + '-ok" data-act="resolve">Looks right</button>') +
      '</div>';
    if (proposal && c.fix) card.querySelector('.' + NS + '-fix').textContent = c.fix;

    card.querySelector('.' + NS + '-badge').textContent =
      c.status === 'approved'
        ? 'approved'
        : c.status === 'rejected'
          ? 'needs work'
          : c.status === 'in_progress'
            ? 'Claude is on this'
            : c.status === 'proposed'
              ? 'Claude suggests'
              : 'comment ' + c.n;
    card.querySelector('.' + NS + '-text').textContent = c.comment;
    card.querySelector('.' + NS + '-when').textContent =
      c.kind === 'move' ? 'a reorder you made' : c.kind === 'region' ? 'a region you framed' : c.selector || '';

    document.documentElement.appendChild(card);
    placeFloating(card, r);

    const set = async (status) => {
      const res = await window.__aynaResolve(c.id, status);
      if (!res || !res.ok) return;
      c.status = status;
      if (paint) paint();
      closeCard();
      updateReviewBar();
    };

    // Typing an instruction is itself the answer — sending it means "do that".
    const respond = async (verdict) => {
      const note = card.querySelector('textarea')?.value.trim();
      const res = await window.__aynaRespond(c.id, note ? 'redirect' : verdict, note || null);
      if (!res || !res.ok) return;
      c.status = res.status;
      if (paint) paint();
      closeCard();
      renderReview().then(updateReviewBar);
      refreshTaskCount();
    };
    card.querySelector('[data-act=go]')?.addEventListener('click', () => respond('approve'));
    card.querySelector('[data-act=decline]')?.addEventListener('click', () => respond('decline'));

    card.querySelector('[data-act=resolve]')?.addEventListener('click', () => set('approved'));
    card.querySelector('[data-act=reject]')?.addEventListener('click', () => set('rejected'));
    card.querySelector('[data-act=reopen]')?.addEventListener('click', () => set('open'));
  }

  async function updateReviewBar() {
    if (!bar || state.phase !== 'review' || !window.__aynaList) return;
    const comments = await window.__aynaList().catch(() => []);
    const resolved = comments.filter((c) => c.status === 'approved').length;
    const label = bar.querySelector('.' + NS + '-progress');
    const left = comments.length - resolved;
    if (label) {
      // Say what is left to do, not what has been done. "0 of 3 resolved" makes
      // the reader do the subtraction to find out whether they can leave.
      // The sentence carries the change of state, not the button.
      label.textContent = left
        ? left + ' left to judge'
        : 'All ' + comments.length + ' judged — nothing left to do';
      label.classList.toggle(NS + '-done', left === 0);
    }

    /*
      Say what the button does, and never dress it up as an acknowledgement.

      This relabelled itself "Done" and turned primary the moment everything was
      judged. "Done" reads as "I have finished looking" — a thing you say, not a
      thing that ends the session — so the natural response to judging the last
      comment was to press it, and the window vanished. The user's report was
      exactly that: everything done, and the UI closes immediately.

      Ending a review is always the same act and always says so. What changes when
      the work is finished is the sentence on the left, not the promise on the
      button.
    */
    const close = bar.querySelector('[data-act=close]');
    if (close && !closing) close.textContent = 'Close window';
  }

  /*
    The console.

    One line per thing that happened, in the order it happened, with an input so
    an instruction can be given without leaving the page. It polls rather than
    being pushed to: the events live in a database written by another process,
    and a poll of an indexed integer column costs nothing next to inventing a
    channel to be notified over.
  */
  let consoleEl = null;
  let consoleSeq = 0;
  let consoleTimer = 0;
  let consoleMin = false;
  try {
    consoleMin = sessionStorage.getItem('ayna-console') === 'min';
  } catch {
    // Private mode; it just opens expanded each time.
  }

  const WORDING = {
    round: (e) => ['sent', e.comments ? `${e.comments} comment${e.comments === 1 ? '' : 's'} sent to Claude` : 'sent to Claude'],
    applied: (e) => ['applied', `changes landed${e.via && e.via !== 'marker' ? ` (noticed by ${e.via.replace('-', ' ')})` : ''}`],
    task: (e) => ['task', `${e.taskId ?? e.id ?? ''} ${e.status ?? ''}${e.comment ? ' — ' + e.comment : ''}`.trim()],
    rejected: (e) => ['back', `sent back: ${e.comment ?? ''}`],
    closed: (e) => ['closed', e.approved ? 'review finished' : 'window closed — pending work kept'],
    audit: (e) => ['audit', e.clean ? 'no layout faults' : `${Object.values(e.counts ?? {}).reduce((a, b) => a + b, 0)} faults found`],
    claimed: (e) => ['claimed', `${e.taskId ?? ''} taken by ${e.by ?? 'someone'}`],
    message: (e) => (e.from === 'user' ? ['you', e.text] : ['claude', e.text]),
    ready: (e) => ['owed', `${e.pending} still waiting`],
    gate: (e) => [
      'checked',
      e.unavailable
        ? `could not measure the page — ${e.unavailable}`
        : e.clean
          ? 'no measurable faults left'
          : Object.entries(e.counts ?? {})
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${n} ${k}`)
              .join(' · ') + ' still there',
    ],
  };

  /*
    Who did it, borrowed from the trace viewer in disler/super-simple-software-
    factory: lanes for each actor and blocks on a time axis, rather than a flat
    log where a machine measurement and a person's instruction look the same.

    Three lanes is the honest count here. The user, Claude, and ayna — which is
    neither of them and is the only one making claims that can be checked.
  */
  const LANE = {
    round: 'you', message: 'you', closed: 'you',
    task: 'claude', applied: 'claude', rejected: 'claude',
    gate: 'ayna', audit: 'ayna', ready: 'ayna', claimed: 'ayna',
  };

  let consoleStart = 0;
  let consoleRound = null;

  const clock = (at) => {
    if (!consoleStart) consoleStart = at;
    const secs = Math.max(0, Math.round((at - consoleStart) / 1000));
    return String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  };

  function consoleLine(e) {
    const wording = WORDING[e.event];
    if (!wording) return null;
    const [who, text] = wording(e);
    if (!text) return null;

    const lane = e.event === 'message' && e.from !== 'user' ? 'claude' : LANE[e.event] ?? 'ayna';
    const row = document.createElement('div');
    row.className = NS + '-line';
    row.dataset.kind = e.event === 'message' ? (e.from === 'user' ? 'you' : 'message') : e.event;
    row.dataset.lane = lane;

    const t = document.createElement('i');
    t.className = NS + '-at';
    t.textContent = clock(e.at ?? Date.now());

    const b = document.createElement('b');
    b.textContent = lane;
    b.title = who;

    const span = document.createElement('span');
    span.textContent = text;

    row.appendChild(t);
    row.appendChild(b);
    row.appendChild(span);
    return row;
  }

  /** A round is a phase; saying so makes the rest read as belonging to something. */
  function roundHeader(e) {
    const head = document.createElement('div');
    head.className = NS + '-phase';
    head.textContent = 'round ' + (e.round ?? '') +
      (e.comments ? ' · ' + e.comments + ' comment' + (e.comments === 1 ? '' : 's') : '');
    return head;
  }

  function setConsoleMinimised(min) {
    consoleMin = min;
    if (!consoleEl) return;
    consoleEl.classList.toggle(NS + '-min', min);
    consoleEl.querySelector('[data-act=fold]').textContent = min ? 'Show' : 'Hide';
    try {
      sessionStorage.setItem('ayna-console', min ? 'min' : 'open');
    } catch {
      // Not being able to remember the preference is not worth failing over.
    }
    reserveForBar();
  }

  /*
    Colour is how you tell one agent from another at a glance, so it has to be
    the same colour every time for the same name. Hashing the name gives that for
    free and needs no registry of who exists.
  */
  const AGENT_COLOURS = ['#a78bfa', '#4795c4', '#2dd4bf', '#f59e0b', '#38bdf8', '#f0561f'];
  const agentColour = (name) => {
    let n = 0;
    for (let i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0;
    return AGENT_COLOURS[n % AGENT_COLOURS.length];
  };

  async function pumpAgents() {
    if (!consoleEl || !window.__aynaAgents) return;
    const agents = await window.__aynaAgents().catch(() => []);
    const strip = consoleEl.querySelector('.' + NS + '-agents');
    if (!strip) return;

    if (!agents.length) {
      strip.textContent = '';
      return;
    }
    strip.textContent = '';
    for (const a of agents) {
      const chip = document.createElement('span');
      chip.className = NS + '-agent';
      if (a.working || a.tasks.length) chip.classList.add(NS + '-busy');
      const dot = document.createElement('i');
      dot.style.background = agentColour(a.agent);
      const name = document.createElement('b');
      name.textContent = a.agent;
      const what = document.createElement('span');
      what.textContent = a.tasks.length
        ? a.tasks.map((t) => t.id).join(', ')
        : 'working';
      chip.title = a.tasks.map((t) => `${t.id}: ${t.comment ?? ''}`).join('\n') || 'working on this round';
      chip.appendChild(dot);
      chip.appendChild(name);
      chip.appendChild(what);
      strip.appendChild(chip);
    }
  }

  async function pumpConsole() {
    if (!consoleEl || !window.__aynaFeed) return;
    const events = await window.__aynaFeed(consoleSeq).catch(() => []);
    if (!events || !events.length) return;

    const lines = consoleEl.querySelector('.' + NS + '-console-lines');
    // Only follow the tail when the reader is already at it; yanking someone back
    // down while they are reading further up is the reason logs get closed.
    const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
    for (const e of events) {
      consoleSeq = Math.max(consoleSeq, e.seq ?? 0);
      if (e.event === 'round' && e.round !== consoleRound) {
        consoleRound = e.round;
        lines.appendChild(roundHeader(e));
      }
      const row = consoleLine(e);
      if (row) lines.appendChild(row);
    }
    while (lines.children.length > 300) lines.removeChild(lines.firstChild);
    if (atBottom) lines.scrollTop = lines.scrollHeight;
  }

  function buildConsole() {
    if (consoleEl || !window.__aynaFeed) return;
    consoleEl = document.createElement('div');
    consoleEl.className = NS + '-console';
    consoleEl.setAttribute('data-ayna', '1');
    consoleEl.innerHTML =
      '<div class="' + NS + '-console-head">' +
        '<span class="' + NS + '-dotlive"></span><span>Activity</span>' +
        '<span class="' + NS + '-agents"></span>' +
        '<span class="' + NS + '-spacer"></span>' +
        '<button data-act="fold">Hide</button>' +
      '</div>' +
      '<div class="' + NS + '-console-lines"></div>' +
      '<div class="' + NS + '-console-say">' +
        '<input placeholder="Tell Claude something — no need for the terminal" />' +
        '<button data-act="say">Send</button>' +
      '</div>';
    document.documentElement.appendChild(consoleEl);

    consoleEl.querySelector('[data-act=fold]').addEventListener('click', () => setConsoleMinimised(!consoleMin));

    const input = consoleEl.querySelector('input');
    const send = async () => {
      const text = input.value.trim();
      if (!text || !window.__aynaSay) return;
      input.value = '';
      await window.__aynaSay(text).catch(() => {});
      pumpConsole();
    };
    consoleEl.querySelector('[data-act=say]').addEventListener('click', send);
    input.addEventListener('keydown', (ev) => {
      // Typing here must never reach the page underneath, which is in comment
      // mode and would treat every keystroke as a shortcut.
      ev.stopPropagation();
      if (ev.key === 'Enter') send();
    });

    /*
      The console grows as lines arrive, so the space kept for it has to follow.

      Reserving once at build time meant measuring an empty panel: the page was
      given back the room for a header, then the first few lines pushed the
      console up over content that had already been laid out under it.
    */
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => reserveForBar()).observe(consoleEl);
    }

    setConsoleMinimised(consoleMin);
    pumpConsole();
    clearInterval(consoleTimer);
    consoleTimer = setInterval(() => {
      pumpConsole();
      pumpAgents();
    }, 1000);
    pumpAgents();
  }

  /*
    The task list.

    Markers only exist on the page you are standing on, so work raised on another
    route was invisible — you had to remember it was there. This lists everything
    still owed across the project, says which page each belongs to, and takes you
    there.
  */
  let panel = null;

  function closePanel() {
    if (panel) {
      panel.remove();
      panel = null;
    }
  }

  const samePage = (url) => (url ?? '').split('#')[0] === location.href.split('#')[0];

  async function togglePanel() {
    if (panel) {
      closePanel();
      return;
    }
    if (!window.__aynaList) return;
    const tasks = await window.__aynaList().catch(() => []);

    panel = document.createElement('div');
    panel.className = NS + '-panel';
    panel.setAttribute('data-ayna', '1');
    /*
      Below the bar, not behind it.

      The panel opened at top:16px while the bar occupies the first 52, so its
      header — the title, the count and the only close button — was hidden
      underneath. The list appeared to start with a stray URL and to have no way
      out of it.
    */
    panel.style.top = barZone().bottom + 8 + 'px';
    panel.style.maxHeight = Math.max(200, viewportH() - barZone().bottom - 24) + 'px';

    const pending = tasks.filter((t) => t.status !== 'approved').length;
    panel.innerHTML =
      '<div class="' + NS + '-panel-head">Tasks · ' + pending + ' pending' +
      '<button data-act="close-panel" title="Close">×</button></div>' +
      '<div class="' + NS + '-panel-list"></div>';
    document.documentElement.appendChild(panel);
    panel.querySelector('[data-act=close-panel]').addEventListener('click', closePanel);

    const list = panel.querySelector('.' + NS + '-panel-list');
    if (!tasks.length) {
      list.innerHTML = '<div class="' + NS + '-empty">Nothing raised yet.</div>';
      return;
    }

    // This page first — that is what you can act on without going anywhere.
    const groups = new Map();
    for (const t of tasks) {
      const key = (t.url ?? '').split('#')[0] || '(unknown)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys = [...groups.keys()].sort((a, b) => (samePage(b) ? 1 : 0) - (samePage(a) ? 1 : 0));

    for (const key of keys) {
      const head = document.createElement('div');
      head.className = NS + '-group';
      let label;
      try {
        label = new URL(key).pathname || '/';
      } catch {
        label = key;
      }
      head.textContent = samePage(key) ? 'On this page' : label;
      head.title = key;
      list.appendChild(head);

      for (const t of groups.get(key)) {
        const row = document.createElement('div');
        row.className = NS + '-task';
        row.dataset.status = t.status;
        row.innerHTML =
          '<span class="' + NS + '-dot"></span>' +
          '<span class="' + NS + '-task-text"><span class="' + NS + '-t"></span>' +
          '<div class="' + NS + '-task-meta"></div></span>' +
          (t.status === 'approved'
            ? ''
            : '<span class="' + NS + '-task-acts">' +
              '<button data-act="ok" title="Looks right" aria-label="Looks right">✓</button>' +
              // ↺ reads as undo or reopen, which is a different thing entirely
              // from "this still needs work".
              '<button data-act="no" class="' + NS + '-no" title="Needs work" ' +
              'aria-label="Needs work">✕</button></span>');
        row.querySelector('.' + NS + '-t').textContent = t.comment || '(no text)';
        /*
          Only say the status when it is worth saying. Every row read "open"
          underneath it, which is what being in a list of outstanding work already
          means — three identical grey labels carrying nothing.
        */
        const notable = t.status !== 'open';
        row.querySelector('.' + NS + '-task-meta').textContent = [
          notable ? t.status.replace(/_/g, ' ') : '',
          t.kind && t.kind !== 'comment' ? t.kind : '',
        ].filter(Boolean).join(' · ');
        list.appendChild(row);

        row.addEventListener('click', () => {
          if (!samePage(t.url)) {
            // Go to where it was raised; the overlay comes back with it.
            location.href = t.url;
            return;
          }
          closePanel();
          revealOnPage(t);
        });

        row.querySelector('[data-act=ok]')?.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          await window.__aynaResolve(t.id, 'approved');
          closePanel();
          togglePanel();
          if (state.phase === 'review') renderReview().then(updateReviewBar);
          refreshTaskCount();
        });
        row.querySelector('[data-act=no]')?.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          await window.__aynaResolve(t.id, 'rejected');
          closePanel();
          togglePanel();
          if (state.phase === 'review') renderReview().then(updateReviewBar);
          refreshTaskCount();
        });
      }
    }
  }

  /** Scroll to a task's element and make it obvious which one it is. */
  function revealOnPage(t) {
    let el = null;
    try {
      el = t.selector ? document.querySelector(t.selector) : null;
    } catch {
      el = null;
    }
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add(NS + '-flash');
      setTimeout(() => el.classList.remove(NS + '-flash'), 2400);
      return;
    }
    // The element may be gone after an edit; fall back to where it was.
    if (t.rect) window.scrollTo({ top: Math.max(0, t.rect.y - 120), behavior: 'smooth' });
  }

  async function refreshTaskCount() {
    if (!bar || !window.__aynaList) return;
    const el = bar.querySelector('[data-act=tasks]');
    if (!el) return;
    const tasks = await window.__aynaList().catch(() => []);
    const pending = tasks.filter((t) => t.status !== 'approved').length;
    el.textContent = 'Tasks' + (pending ? ' · ' + pending : '');
  }

  /*
    Started last, on purpose.

    Calling this up with setPhase put it before its own state was declared — the
    let bindings below are in the temporal dead zone until execution reaches
    them, so the whole overlay threw on init and no chrome appeared at all. It
    needs nothing from the phases, so it goes at the end where everything exists.
  */
  buildConsole();

  function cleanup() {
    clearInterval(consoleTimer);
    consoleEl?.remove();
    consoleEl = null;
    closePanel();
    clearReview();
    if (hl) hl.remove();
    if (bar) bar.remove();
    for (const p of state.pins) p.remove();
    closePopover();
  }
})();
