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
      background: #111418; color: #f2f4f8; padding: 10px 14px; border-radius: 999px;
      font: 13px/1.4 -apple-system, system-ui, sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
    }
    .${NS}-bar button {
      font: inherit; font-weight: 600; border: 0; border-radius: 999px;
      padding: 6px 14px; cursor: pointer; background: #3b82f6; color: #fff;
    }
    .${NS}-count { opacity: .7; }
    .${NS}-tag {
      position: absolute; z-index: 2147483641; pointer-events: none;
      background: #3b82f6; color: #fff; border-radius: 4px; padding: 2px 7px;
      font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,.2);
    }
    .${NS}-tag b { font-weight: 700; }
    .${NS}-tag i { font-style: normal; opacity: .75; margin-left: 8px; }
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
      position: absolute; z-index: 2147483646; width: 320px;
      background: #fff; color: #111; border-radius: 12px; padding: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid #dfe3ea;
      font: 13px/1.5 -apple-system, system-ui, sans-serif;
    }
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
    .${NS}-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    .${NS}-thumbs img {
      width: 48px; height: 48px; object-fit: cover;
      border-radius: 6px; border: 1px solid #dfe3ea;
    }
    .${NS}-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .${NS}-row button {
      font: inherit; font-weight: 600; border-radius: 8px; padding: 7px 13px; cursor: pointer;
    }
    .${NS}-save { background: #3b82f6; color: #fff; border: 1px solid #3b82f6; }
    .${NS}-cancel { background: #fff; color: #374151; border: 1px solid #dfe3ea; }
    .${NS}-pin {
      position: absolute; z-index: 2147483645; width: 24px; height: 24px;
      border-radius: 999px 999px 999px 2px; background: #f59e0b; color: #111;
      font: 700 12px/24px -apple-system, system-ui, sans-serif; text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.3);
    }
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
  setPhase('comment');

  // A navigation rebuilds this overlay from scratch, but the comments already
  // sent live in Node. Ask for the real total so the counter doesn't reset to 0
  // and make the user think their earlier notes were lost.
  if (window.__aynaCount) {
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
    state.phase = phase;
    state.picking = phase === 'comment';

    if (phase === 'comment') {
      // comment → move → browse → comment
      const NEXT = { comment: 'move', move: 'browse', browse: 'comment' };
      const HINT = {
        comment: 'Click anything to comment',
        move: 'Drag an element to reorder it',
        browse: 'Browsing — click links freely, nothing is captured',
      };
      const NEXT_LABEL = { comment: 'Move mode', move: 'Browse mode', browse: 'Comment mode' };

      bar.innerHTML =
        '<span>' + HINT[state.mode] + '</span>' +
        '<button data-act="mode" class="' + NS + '-ghost">' + NEXT_LABEL[state.mode] + '</button>' +
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
      bar.querySelector('[data-act=send]').addEventListener('click', () => {
        if (!state.seq) return;
        setPhase('waiting');
        window.__aynaDone();
      });
      return;
    }

    if (phase === 'waiting') {
      bar.innerHTML =
        '<span class="' + NS + '-spin" aria-hidden="true"></span>' +
        '<span>Claude is making your changes — this page will refresh itself</span>';
      return;
    }

    // review
    bar.innerHTML =
      '<span>Changes are live. Look them over.</span>' +
      '<button data-act="more" class="' + NS + '-ghost">Comment more</button>' +
      '<button data-act="approve">Approve &amp; close</button>';
    bar.querySelector('[data-act=more]').addEventListener('click', () => {
      state.seq = 0;
      setPhase('comment');
      window.__aynaMore();
    });
    bar.querySelector('[data-act=approve]').addEventListener('click', () => {
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

  function countLabel() {
    return state.seq + (state.seq === 1 ? ' comment' : ' comments');
  }

  // Node flips the overlay into review mode after it has reloaded the page.
  window.__aynaReview = () => setPhase('review');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  const isOurs = (el) => !el || !el.closest || !!el.closest('[data-ayna]');

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
    tag.innerHTML =
      '<b></b>' + (canClimb || state.climb ? '<i>↑ ↓ resize · ⇧click adds</i>' : '');
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

      /*
        Browse mode lets the page work as a page. Without it every link is dead
        while the overlay is up, so a multi-page review is impossible — you could
        only ever comment on the first screen.

        Deliberately not ⌘/ctrl/middle-click: those open a new tab in every
        browser, and the overlay is bound to this page, so you would land
        somewhere ayna isn't watching.
      */
      if (state.mode === 'browse') return;

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
        closePopover();
        clearSelection();
        return;
      }
      if (!state.picking || !state.hoverBase) return;

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
      refreshCount();

      await window.__aynaSubmit({
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
    },
    true,
  );

  let pop = null;

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

  function openPopover(el) {
    closePopover();
    state.picking = false;
    state.target = el;
    place(el);

    // A shift-click set takes precedence: one comment, several elements.
    const targets = state.selection.length ? state.selection.map((s) => s.el) : [el];
    const described = targets.map(describeElement);
    const r = unionRect(described.map((d) => d.rect));
    const images = [];

    pop = document.createElement('div');
    pop.className = NS + '-pop';
    pop.setAttribute('data-ayna', '1');
    pop.innerHTML =
      '<div class="' + NS + '-sel"></div>' +
      '<textarea placeholder="What should change about this?"></textarea>' +
      '<div class="' + NS + '-hint">Paste an image to attach a reference · Esc to cancel</div>' +
      '<div class="' + NS + '-thumbs"></div>' +
      '<div class="' + NS + '-row">' +
      '<button class="' + NS + '-cancel">Cancel</button>' +
      '<button class="' + NS + '-save">Add comment</button>' +
      '</div>';

    const sel = described[0].selector;
    pop.querySelector('.' + NS + '-sel').textContent =
      described.length > 1
        ? described.length + ' elements: ' + described.map((d) => d.selector.split(' > ').pop()).join(', ')
        : sel;

    const docEl = document.documentElement;
    pop.style.top = Math.max(8, Math.min(r.y + r.height + 8, docEl.scrollHeight - 260)) + 'px';
    pop.style.left = Math.min(Math.max(r.x, 8), Math.max(8, docEl.clientWidth - 336)) + 'px';
    docEl.appendChild(pop);

    const ta = pop.querySelector('textarea');
    ta.focus();

    const thumbs = pop.querySelector('.' + NS + '-thumbs');
    ta.addEventListener('paste', (ev) => {
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (const item of items) {
        if (item.type.indexOf('image/') !== 0) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          images.push(reader.result);
          const img = document.createElement('img');
          img.src = reader.result;
          thumbs.appendChild(img);
        };
        reader.readAsDataURL(file);
      }
    });

    pop.querySelector('.' + NS + '-cancel').addEventListener('click', closePopover);
    pop.querySelector('.' + NS + '-save').addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text && !images.length) {
        ta.focus();
        return;
      }

      const first = described[0];
      const payload = {
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
      const pin = document.createElement('div');
      pin.className = NS + '-pin';
      pin.setAttribute('data-ayna', '1');
      pin.textContent = String(n);
      pin.style.left = r.x + 'px';
      pin.style.top = r.y + 'px';
      document.documentElement.appendChild(pin);
      state.pins.push(pin);
      refreshCount();

      await window.__aynaSubmit(payload);
    });
  }

  function cleanup() {
    if (hl) hl.remove();
    if (bar) bar.remove();
    for (const p of state.pins) p.remove();
    closePopover();
  }
})();
