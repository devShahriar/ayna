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
  const state = { picking: true, target: null, pins: [], seq: 0, phase: 'comment' };

  // addInitScript runs at document-start, before <html> exists — build the UI only
  // once there is a document to attach it to.
  let hl = null;
  let bar = null;

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

  bar = document.createElement('div');
  bar.className = NS + '-bar';
  bar.setAttribute('data-ayna', '1');
  document.documentElement.appendChild(bar);
  setPhase('comment');
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
      bar.innerHTML =
        '<span>Click anything to comment</span>' +
        '<span class="' + NS + '-count">' + countLabel() + '</span>' +
        '<button data-act="send">Send to Claude</button>';
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
      if (!state.picking) return;
      if (isOurs(e.target)) {
        hl.style.display = 'none';
        return;
      }
      place(e.target);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!state.picking || isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      openPopover(e.target);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') closePopover();
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

  function openPopover(el) {
    closePopover();
    state.picking = false;
    state.target = el;
    place(el);

    const r = rectOf(el);
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

    const sel = selectorFor(el);
    pop.querySelector('.' + NS + '-sel').textContent = sel;

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

      const payload = {
        comment: text,
        selector: sel,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: [...el.classList].filter((c) => c.indexOf(NS) !== 0),
        text: (el.innerText || '').trim().slice(0, 400),
        outerHTML: el.outerHTML.slice(0, 1500),
        rect: r,
        styles: styleDigest(el),
        images,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        url: location.href,
      };

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
      const counter = bar && bar.querySelector('.' + NS + '-count');
      if (counter) counter.textContent = countLabel();

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
