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
      border: 2px solid #3b82f6; background: rgba(59,130,246,.12);
      border-radius: 3px;
    }
    .${NS}-bar {
      position: fixed; z-index: 2147483647; left: 50%; transform: translateX(-50%);
      bottom: 20px; display: flex; align-items: center; gap: 12px;
      flex-wrap: wrap; justify-content: center; max-width: calc(100vw - 24px);
      background: #111418; color: #f2f4f8; padding: 10px 14px; border-radius: 999px;
      font: 13px/1.4 -apple-system, system-ui, sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
    }
    .${NS}-bar button {
      font: inherit; font-weight: 600; border: 0; border-radius: 999px;
      padding: 6px 14px; cursor: pointer; background: #3b82f6; color: #fff;
    }
    .${NS}-count { opacity: .7; }
    .${NS}-warn { color: #fbbf24; }
    .${NS}-tag {
      position: absolute; z-index: 2147483641; pointer-events: none;
      background: #3b82f6; color: #fff; border-radius: 4px; padding: 2px 7px;
      font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,.2);
    }
    .${NS}-tag b { font-weight: 700; }
    .${NS}-tag i { font-style: normal; opacity: .75; margin-left: 8px; }
    .${NS}-marquee {
      position: absolute; z-index: 2147483641; pointer-events: none;
      border: 2px dashed #3b82f6; background: rgba(59,130,246,.10); border-radius: 3px;
    }
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
      box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid #dfe3ea;
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
    .${NS}-pop textarea:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
    .${NS}-sel {
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #5b6070;
      background: #f4f5f8; padding: 5px 7px; border-radius: 6px; margin-bottom: 9px;
      word-break: break-all; max-height: 46px; overflow: auto;
    }
    .${NS}-hint { color: #6b7280; font-size: 11px; margin: 8px 0; }
    .${NS}-attach { color: #3b82f6; text-decoration: underline; cursor: pointer; }
    .${NS}-pop.${NS}-dragover { outline: 2px dashed #3b82f6; outline-offset: 3px; }
    .${NS}-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    .${NS}-auto { position: relative; display: inline-flex; }
    .${NS}-auto b {
      position: absolute; left: 2px; bottom: 2px; font-size: 8px; font-weight: 700;
      letter-spacing: .06em; text-transform: uppercase; color: #fff;
      background: #16a34a; border-radius: 3px; padding: 1px 3px;
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
    .${NS}-save { background: #3b82f6; color: #fff; border: 1px solid #3b82f6; }
    .${NS}-cancel { background: #fff; color: #374151; border: 1px solid #dfe3ea; }
    .${NS}-pin {
      position: absolute; z-index: 2147483645; width: 24px; height: 24px;
      border-radius: 999px 999px 999px 2px; background: #f59e0b; color: #111;
      font: 700 12px/24px -apple-system, system-ui, sans-serif; text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; user-select: none;
    }
    .${NS}-pin:hover { background: #ef4444; color: #fff; }
    .${NS}-rev {
      position: absolute; z-index: 2147483638; pointer-events: none;
      border: 2px solid #f59e0b; background: rgba(245,158,11,.10);
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
      background: #f59e0b; color: #111; display: flex; align-items: center;
      justify-content: center; cursor: pointer; white-space: nowrap;
    }
    .${NS}-revpin[data-status=resolved] { background: #16a34a; color: #fff; }
    .${NS}-revpin[data-status=rejected] { background: #ef4444; color: #fff; }
    .${NS}-revbar button {
      border: 0; border-radius: 999px; height: 20px; padding: 0 9px; cursor: pointer;
      font: inherit; white-space: nowrap;
    }
    .${NS}-ok { background: #16a34a; color: #fff; }
    .${NS}-no { background: #2b313d; color: #e5e7eb; }
    .${NS}-ok:hover { background: #15803d; }
    .${NS}-no:hover { background: #ef4444; color: #fff; }
    .${NS}-panel {
      position: fixed; z-index: 2147483646; right: 16px; top: 16px; width: 330px;
      max-width: calc(100vw - 32px);
      background: #111418; color: #e8eaf0; border: 1px solid #2a3140; border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,.45); display: flex; flex-direction: column;
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
      padding: 8px 14px 4px; font-size: 11px; letter-spacing: .04em; color: #6f7889;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .${NS}-task {
      padding: 9px 14px; border-top: 1px solid #1d2330; cursor: pointer;
      display: flex; gap: 9px; align-items: flex-start;
    }
    .${NS}-task:hover { background: #171b22; }
    .${NS}-dot {
      width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: none; background: #f59e0b;
    }
    .${NS}-task[data-status=approved] .${NS}-dot { background: #16a34a; }
    .${NS}-task[data-status=in_progress] .${NS}-dot { background: #38bdf8; }
    .${NS}-task[data-status=proposed] .${NS}-dot { background: #a78bfa; }
    .${NS}-task[data-status=rejected] .${NS}-dot { background: #ef4444; }
    .${NS}-task[data-status=approved] .${NS}-task-text { color: #6f7889; text-decoration: line-through; }
    .${NS}-task-text { flex: 1; min-width: 0; }
    .${NS}-task-meta { font-size: 11px; color: #6f7889; margin-top: 2px; }
    .${NS}-task-acts { display: flex; gap: 4px; flex: none; }
    .${NS}-task-acts button {
      border: 0; border-radius: 6px; padding: 2px 7px; font: 600 11px/1.6 inherit; cursor: pointer;
      background: #232a36; color: #cdd3e0;
    }
    .${NS}-task-acts button:hover { background: #16a34a; color: #fff; }
    .${NS}-task-acts button.${NS}-no:hover { background: #ef4444; }
    .${NS}-empty { padding: 18px 14px; color: #6f7889; }
    .${NS}-flash { animation: ${NS}-flash 1.1s ease-out 2; }
    @keyframes ${NS}-flash {
      0%, 100% { box-shadow: none; }
      40% { box-shadow: 0 0 0 3px #f59e0b, 0 0 22px rgba(245,158,11,.6); }
    }
    .${NS}-card {
      position: fixed; z-index: 2147483646; width: 300px; max-width: calc(100vw - 16px);
      background: #fff; color: #111; border-radius: 12px; padding: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid #dfe3ea;
      font: 13px/1.55 -apple-system, system-ui, sans-serif;
      display: flex; flex-direction: column;
    }
    .${NS}-card .${NS}-badge {
      display: inline-block; font-size: 10px; text-transform: uppercase;
      letter-spacing: .08em; font-weight: 700; padding: 2px 8px; border-radius: 999px;
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
    .${NS}-card .${NS}-when { color: #6b7280; font-size: 11px; margin-bottom: 10px; }
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
    const leavingReview = state.phase === 'review' && phase !== 'review';
    if (phase !== 'waiting') clearTimeout(state.waitWarn);
    state.phase = phase;
    state.picking = phase === 'comment';
    if (leavingReview) clearReview();

    if (phase === 'comment') {
      // comment → move → browse → comment
      const NEXT = { comment: 'move', move: 'browse', browse: 'comment' };
      const HINT = {
        comment: 'Click anything to comment',
        move: 'Drag an element to reorder it',
        browse: state.signIn
          ? 'Sign in first — nothing is captured while you do'
          : 'Browsing — click links freely, nothing is captured',
      };
      const NEXT_LABEL = { comment: 'Move mode', move: 'Browse mode', browse: 'Comment mode' };

      bar.innerHTML =
        '<span>' + HINT[state.mode] + '</span>' +
        '<button data-act="mode" class="' + NS + '-ghost">' + NEXT_LABEL[state.mode] + '</button>' +
        '<button data-act="tasks" class="' + NS + '-ghost">Tasks</button>' +
        '<span class="' + NS + '-count">' + countLabel() + '</span>' +
        '<button data-act="send"' + (state.seq ? '' : ' disabled') + '>Send to Claude</button>';

      bar.querySelector('[data-act=mode]').addEventListener('click', () => {
        state.mode = NEXT[state.mode];
        try {
          sessionStorage.setItem('ayna-mode', state.mode);
        } catch {
          // Private mode or a blocked origin — the mode just won't persist.
        }
        clearSelection();
        hide();
        setPhase('comment');
      });
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

    // review — three separate actions, none of which is a side effect of another
    bar.innerHTML =
      '<span>Changes are live — judge each one</span>' +
      '<span class="' + NS + '-progress ' + NS + '-count"></span>' +
      '<button data-act="tasks" class="' + NS + '-ghost">Tasks</button>' +
      '<button data-act="more" class="' + NS + '-ghost">Comment more</button>' +
      '<button data-act="approve-all" class="' + NS + '-ghost" ' +
      'title="Marks every pending change approved">Approve all</button>' +
      '<button data-act="close" title="Ends the review — anything unjudged stays pending">Close</button>';

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
    bar.querySelector('[data-act=close]').addEventListener('click', () => {
      cleanup();
      window.__aynaApprove();
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
        ? '<i>drag a box — this is one canvas</i>'
        : operable
          ? '<i>⌥click to comment</i>'
          : canClimb || state.climb
            ? '<i>↑ ↓ resize · ⇧click adds</i>'
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

  function barSafeZone() {
    if (!bar) return 0;
    const b = bar.getBoundingClientRect();
    return b.height ? b.height + 28 : 0;
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
    el.style.maxHeight = Math.max(160, vh - safe - 16) + 'px';

    const box = el.getBoundingClientRect();
    const w = box.width || 320;
    const h = box.height || 240;

    const x = r.x - window.scrollX;
    const y = r.y - window.scrollY;

    let top = y + r.height + 10;
    if (top + h > vh - safe) top = y - h - 10; // no room below — flip above
    if (top < 8) top = Math.max(8, vh - safe - h); // nor above — sit above the bar

    // Last resort: if it fits nowhere, keep the bottom on screen rather than the
    // top. The buttons are at the bottom, and a panel whose buttons you cannot
    // reach is the same as no panel.
    if (top + h > vh - safe) top = Math.max(8, vh - safe - h);

    el.style.position = 'fixed';
    el.style.left = Math.min(Math.max(x, 8), Math.max(8, vw - w - 8)) + 'px';
    el.style.top = Math.max(8, top) + 'px';

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

  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      hide(); // the hover highlight is stale the moment anything moves
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
    pop.innerHTML =
      '<div class="' + NS + '-body">' +
      '<div class="' + NS + '-sel"></div>' +
      '<textarea placeholder="What should change about this?"></textarea>' +
      (region ? '<div class="' + NS + '-hint">The framed region is attached automatically.</div>' : '') +
      '<div class="' + NS + '-hint">Paste, drop, or ' +
      '<label class="' + NS + '-attach">choose an image<input type="file" accept="image/*" multiple hidden></label>' +
      ' · Esc to cancel</div>' +
      '<div class="' + NS + '-thumbs"></div>' +
      '</div>' +
      '<div class="' + NS + '-row">' +
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
      window.__aynaPreview(r)
        .then((dataUrl) => {
          if (!dataUrl || !pop) return;
          const thumbs = pop.querySelector('.' + NS + '-thumbs');
          const wrap = document.createElement('span');
          wrap.className = NS + '-auto';
          const img = document.createElement('img');
          img.src = dataUrl;
          img.title = 'The region you framed — attached automatically';
          wrap.appendChild(img);
          const tagEl = document.createElement('b');
          tagEl.textContent = 'auto';
          wrap.appendChild(tagEl);
          thumbs.prepend(wrap);
        })
        .catch(() => {});
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
  function repositionReview() {
    for (const n of reviewNodes) {
      const c = n.__aynaFor;
      if (!c) continue;
      const r = anchorFor(c);
      if (!r || !r.width) continue;
      n.style.left = r.x + 'px';
      if (n.__aynaKind === 'bar') {
        n.style.top = Math.max(0, r.y - 28) + 'px';
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
      barEl.style.top = Math.max(0, r.y - 28) + 'px';

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
          : '<button class="' + NS + '-cancel" data-act="reject">Needs work</button>' +
            '<button class="' + NS + '-save" data-act="resolve">Looks right</button>') +
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
    if (label) label.textContent = resolved + ' of ' + comments.length + ' resolved';
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
    panel.style.maxHeight = Math.max(200, viewportH() - barSafeZone() - 32) + 'px';

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
      head.textContent = samePage(key) ? label + '  · this page' : label;
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
              '<button data-act="ok" title="Looks right">✓</button>' +
              '<button data-act="no" class="' + NS + '-no" title="Needs work">↺</button></span>');
        row.querySelector('.' + NS + '-t').textContent = t.comment || '(no text)';
        row.querySelector('.' + NS + '-task-meta').textContent =
          t.status + (t.kind && t.kind !== 'comment' ? ' · ' + t.kind : '');
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

  function cleanup() {
    closePanel();
    clearReview();
    if (hl) hl.remove();
    if (bar) bar.remove();
    for (const p of state.pins) p.remove();
    closePopover();
  }
})();
