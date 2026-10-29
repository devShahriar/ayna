---
description: "How to build something that PLAYS on kormo's canvas — an explainer with a timeline, a looping visual, a 3D scene — as a self-contained `emit_code` document. Covers loading d3 and three.js inside the sandbox, the timeline pattern, what to do when a CDN does not answer, the performance budget of a board holding twenty of these, and the three ways an animation card comes out BLANK with zero console errors. Load it whenever the ask is \"make it move\", and NOT when the ask is slides someone clicks through — that is build-a-deck."
---

# build-an-animation

Confidence: 0% (0 runs)


# Build an animation

Something that **plays by itself** is `emit_code`: ONE self-contained HTML
document, rendered in a sandboxed iframe as a node on the canvas.

## The boundary with build-a-deck, restated identically

`build-a-deck` owns slides someone clicks through. It draws the line on the same
word this skill does, and the discriminator is not "animated" — a deck can
animate its elements in. It is whether the thing **must play by itself**.

| the person says | build |
|---|---|
| deck · slides · presentation · one page per slide | `emit_app` with `slides` |
| video · animation · explainer that plays · motion graphic · 3D · "show me how X works" | `emit_code` — this skill |

Both skills are found by retrieval, and the word *animated* matches both. If it
plays on its own, you are in the right one. Keep reading.

## THE SANDBOX IS THE FIRST CONSTRAINT, NOT A DETAIL

`sandbox="allow-scripts allow-popups allow-forms allow-modals"` — no
`allow-same-origin`, deliberately and permanently (`LiveCodeFrame.tsx`). The
document has an **opaque origin**, so:

- It **cannot fetch from kormo.** Not the API, not `/api/infra/upload/…` — those
  answer 401 from in there, always, by construction. Every number you show must
  be baked into the markup (ground it from `read_canvas_node` / `query_records`
  first) or arrive through the declared `dataset` push, which you read with
  `window.kormo.onData(rows => …)`.
- **A CDN over https still works.** Only kormo's own upload URLs are rewritten
  for you; a third-party `https://` URL is left alone because it already
  resolves from inside the frame (`sandboxAssets.ts`).
- **The document is mounted twice.** Once at card size in the preview, and again
  at 1:1 when a person hits ⛶. The second mount is a cold start: your scripts run
  from the top, in a different viewport, with none of the state the preview
  built. Your animation must be correct starting from zero, at any size, every
  time.

## THE THREE WAYS AN ANIMATION CARD COMES OUT BLANK

All three are silent. No console error, no failed tool call, no line in the run.
The card paints its background and nothing else, which on screen is
indistinguishable from "the product is broken". These are rules, not tips.

### R1 · Give the full-bleed chain its own height. Do not inherit it.

The card contract requires every `emit_code` document to declare its regions
with `data-kormo-part`, and says a single wrapper around everything satisfies it
in one line. That line is a `<section>`, **and a section with no height rule
computes to `auto`** — which breaks the percentage chain every full-bleed
animation is built on:

    html, body { height: 100% }                  720px
    <section data-kormo-part="stage">            auto → 0     ← the wrapper
    #stage { height: 100%; overflow: hidden }    100% of 0 = 0

and every absolutely-positioned scene inside is clipped by a box 0px tall.

MEASURED 15 Sep 2026 on the card that exposed it: scene 1 carried the `active`
class at `opacity: 1`, all five scenes existed in the DOM, **zero console
errors, zero page errors, 2,084 characters of text** — and the card painted its
background and nothing else. It reads as *"animations come out blank"* because
only animations are shaped this way; a dashboard or a deck lays out in flow and
never resolves a percentage against the wrapper.

Kormo now injects `body > [data-kormo-part]{height:100%}` (`PART_LAYOUT_FIX` in
`LiveCodeFrame.tsx`) and that is a real backstop. **Write the height anyway**, in
your own `<style>`, for reasons the backstop cannot cover:

- It only binds a part wrapper that is a **direct child of `body`**. The moment
  your layout nests — a header outside the stage, two parts side by side — you
  are past it and back to `auto → 0`.
- A document that depends on an injected rule is a document that is wrong the
  first time it is opened anywhere else.

```css
html, body { height: 100%; margin: 0; }
#stage     { height: 100%; position: relative; overflow: hidden; }
```

### R2 · The first frame must already be legible.

A scene that starts at `opacity: 0` and is revealed by script is **invisible
forever** if the script never runs — and the script not running is exactly what
R3 and a plain typo both look like. The stage is empty, nothing throws, and the
document is technically correct.

It also fails a check you cannot see from inside the run. The QA gate opens the
card in a real headless browser and looks at it before the run is allowed to
report success (`internal/api/qa_gate.go` — the visual pass publishes the card
as a page, in the canvas's own sandbox, and sends the browser in with
`--frame`). **A screenshot is one moment.** If your first legible frame is two
seconds in, the gate photographs a dark rectangle and sends the run back to fix
a card that was never broken.

So: **draw scene 1 synchronously, before the first `requestAnimationFrame`.**
Paint the stage, set the first scene's class, put the title on screen — then
start the clock. Everything after frame 0 may fade in; frame 0 may not be empty.

### R3 · The library that never loaded must degrade to something visible.

A `<script src>` that 404s is reported — `sandboxErrors.ts` listens for `error`
in the capture phase and posts kind `resource`, *"Failed to load script: …"*,
which raises a ⚠ chip on the card and is written to the node so the next agent
reading it sees the cause. That is diagnosis, not rescue: **the chip is a badge
in the corner and the card body is still whatever you left there.** If that is
an empty stage, the person sees an empty stage.

Every document that loads a library therefore boots through a check:

```html
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>
  if (window.d3) { start(); } else { still("Charting library unavailable — the figures are below."); }
</script>
```

`still()` is not an apology screen. It is the **same content without motion**:
the headline, the real numbers, the takeaway — everything the animation was
going to say, laid out in flow. A card that loses its library should read like a
plain, slightly dull version of itself, never like a failure.

## Loading the libraries — pin the version, and pin THESE

MEASURED 15 Sep 2026, HTTP status and byte count, straight from the CDNs:

| url | result |
|---|---|
| `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js` | **200**, 669,884 B, defines global `THREE` |
| `https://unpkg.com/three@0.161.0/build/three.min.js` | **404** |
| `…three@0.165.0` / `0.170.0` / `0.180.0` `/build/three.min.js` | **404** |
| `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` | **200**, 279,706 B, defines global `d3` |
| `https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js` | **200**, byte-identical |

**three.js r160 is the last release with a UMD build.** From `0.161.0` onward
`build/three.min.js` does not exist — so "load the latest three.js" is a 404, a
`THREE is not defined`, and a blank card. **Pin `three@0.160.0`.** Never write a
CDN URL without an exact version; a floating tag turns a card that works today
into a blank one on a release you will never hear about.

Two consequences worth stating because both look like bugs:

- **r160's UMD file logs a deprecation `console.warn` on load.** It is noise, not
  a break. The error bridge wraps `console.error` only (`sandboxErrors.ts`), so
  that warning does not raise the card's badge and is not a reason to change
  version.
- **Do not use `<script type="module">` with an import map.** The error
  instrumenter cannot wrap a module script — its own comment lists exactly what
  it cannot reach, and `<script type="module">` is first on the list. A throw
  inside one arrives censored as the literal string `"Script error."` with an
  empty filename and line 0, which names nothing to fix. A throw in a **classic**
  script arrives with its real message and the line number **in your card**. That
  difference is worth more than a newer three.js.

## The timeline pattern

A thing that plays needs: scenes with durations, one clock, a progress bar so a
person knows how long they are committing to, and a replay control so the ending
is not the end. This is the whole skeleton — adapt it, don't reinvent it.

```html
<section id="stage" data-kormo-part="stage" data-kormo-label="The explainer">
  <div class="scene on" id="sc-open"  data-kormo-part="sc-open"  data-kormo-label="Opening">…</div>
  <div class="scene"    id="sc-grow"  data-kormo-part="sc-grow"  data-kormo-label="The growth">…</div>
  <div class="scene"    id="sc-close" data-kormo-part="sc-close" data-kormo-label="The takeaway">…</div>
  <div id="rail"><i id="bar"></i></div>
  <button id="replay" hidden>↻ replay</button>
</section>
```

```css
html, body { height: 100%; margin: 0; background: #06070c; color: #e9e6f2; }
#stage { height: 100%; position: relative; overflow: hidden; }   /* R1 */
.scene { position: absolute; inset: 0; display: grid; place-content: center;
         opacity: 0; pointer-events: none; transition: opacity .45s ease; }
/* .on is set on the FIRST scene in the markup, so frame 0 is legible (R2). */
.scene.on { opacity: 1; pointer-events: auto; }
#rail { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #ffffff14; }
#bar  { display: block; height: 100%; width: 100%; background: #7dd3fc;
        transform: scaleX(0); transform-origin: 0 50%; }
```

```js
var SCENES = [
  { el: 'sc-open',  ms: 2200 },
  { el: 'sc-grow',  ms: 3200 },
  { el: 'sc-close', ms: 2400 }
];
var TOTAL = SCENES.reduce(function (a, s) { return a + s.ms; }, 0);
var els   = SCENES.map(function (s) { return document.getElementById(s.el); });
var bar   = document.getElementById('bar');
var replay = document.getElementById('replay');

var t0 = null, elapsed = 0, raf = 0, playing = true;

// Where the play head is: which scene, and how far through it (0..1).
function at(ms) {
  var acc = 0;
  for (var i = 0; i < SCENES.length; i++) {
    if (ms < acc + SCENES[i].ms) return { i: i, k: (ms - acc) / SCENES[i].ms };
    acc += SCENES[i].ms;
  }
  return { i: SCENES.length - 1, k: 1 };
}

function draw(ms) {
  var p = at(ms);
  for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', i === p.i);
  bar.style.transform = 'scaleX(' + (ms / TOTAL) + ')';
  paint(p.i, p.k);        // your per-scene work: three.js camera, a d3 tick, a counter
}

// THE CLOCK IS rAF'S TIMESTAMP, NEVER A FRAME COUNTER.
// A counter assumes 60fps. The browser throttles this frame — offscreen, a busy
// board, a laptop on battery — and a counted timeline then runs at the wrong
// speed with no way to notice. `now` is wall-clock and is always right.
function frame(now) {
  if (t0 === null) t0 = now - elapsed;     // resume without a jump
  elapsed = Math.min(now - t0, TOTAL);
  draw(elapsed);
  if (elapsed < TOTAL && playing) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;                                // FINISHED MEANS STOPPED — see below
    replay.hidden = false;
  }
}

replay.onclick = function () {
  elapsed = 0; t0 = null; playing = true; replay.hidden = true;
  if (typeof d3 !== 'undefined') d3.selectAll('.scene *').interrupt();  // see d3, below
  if (!raf) raf = requestAnimationFrame(frame);
};

// PAUSE WHEN NOBODY IS LOOKING. rAF already stops when the tab is hidden; this
// also releases the loop when the frame itself is throttled, and t0 = null makes
// the resume seamless because elapsed survives.
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; t0 = null; }
  else if (playing && elapsed < TOTAL && !raf) raf = requestAnimationFrame(frame);
});

draw(0);                                    // R2: frame 0 before the clock starts
if (!reduced()) raf = requestAnimationFrame(frame);
```

**Every scene gets its own `data-kormo-part`.** One part satisfies the contract,
but the whole reason parts exist is so a person can click one region and say
"this bit is too fast" and have your edit land exactly there. Keep the ids
**identical when you re-emit** — a changed id loses every edit aimed at it.

The `pointer-events` rule in the CSS above is load-bearing and easy to miss: an
element at `opacity: 0` **still receives clicks**. A stack of absolutely
positioned scenes means the LAST one in DOM order sits on top and swallows every
click, so a person clicking the visible scene 1 reports scene 5. `pointer-events:
none` on inactive scenes is the fix.

## d3 for data-driven motion · three.js for actual 3D · CSS for the rest

**Reach for CSS first.** `@keyframes` on `transform` and `opacity` are
GPU-composited and cost essentially nothing. A title sliding in, a glow pulsing,
a card flipping — none of that needs a library, and 280KB of d3 to slide a
heading is a worse card, not a fancier one.

**d3 when the motion IS the data changing.** Bars growing to their real values, a
line drawing itself, a number counting up, points entering and leaving as a
filter changes. That is what d3's three pieces are for — scales (`scaleLinear`,
`scaleBand`, `scaleTime`), shape generators (`line`, `arc`, `area`), and the
join:

```js
svg.selectAll('rect').data(rows, function (d) { return d.label; })
  .join('rect')
    .attr('x', function (d) { return x(d.label); })
    .attr('width', x.bandwidth())
    .attr('y', y(0)).attr('height', 0)                 // start at the baseline
  .transition().duration(900).delay(function (d, i) { return i * 90; })
    .ease(d3.easeCubicOut)
    .attr('y', function (d) { return y(d.v); })
    .attr('height', function (d) { return y(0) - y(d.v); });
```

```js
// a line that draws itself
var L = path.node().getTotalLength();
path.attr('stroke-dasharray', L + ' ' + L).attr('stroke-dashoffset', L)
  .transition().duration(1400).ease(d3.easeSinInOut).attr('stroke-dashoffset', 0);

// a number counting up to a REAL value you read from the material
d3.select(kpi).transition().duration(1200).tween('n', function () {
  var i = d3.interpolateNumber(0, value), el = this;
  return function (t) { el.textContent = fmt(i(t)); };
});
```

Two things about d3 transitions on a timeline. They run on d3's own timer, so
they interleave with your rAF loop rather than fight it — but **they do not know
where your play head is.** On replay, `selection.interrupt()` first or you get
two transitions animating one node in opposite directions. And `d3.select` needs
the element to exist: if you build the SVG from script, the part wrapper must
already be in the markup.

**three.js only when the answer genuinely has a third dimension** — a rotating
globe, a graph you fly through, a particle field, an extruded solid, a shader.
Do not load 670KB of WebGL to make a bar chart tilt; a CSS 3D transform does that
for free and can never lose a graphics context.

```html
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
```
```js
if (!window.THREE) { still("3D unavailable — showing the diagram instead."); }
else {
  var cv = document.getElementById('gl');
  var renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));   // see budget
  var scene  = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 4;

  // ONE Points object for thousands of particles — not thousands of Meshes.
  var N = 2000, pos = new Float32Array(N * 3);
  for (var i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * 6;
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.02, color: 0x7dd3fc, transparent: true, opacity: 0.9
  })));

  function size() {
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);      // false: CSS owns the canvas box
  }
  window.addEventListener('resize', size);
  size();

  // A LOST CONTEXT IS A BLACK CARD. Say so instead of showing nothing.
  cv.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); still("3D context was released by the browser.");
  });
}
```

Both libraries in one card (a d3 HUD over a three.js scene) is allowed, but that
is ~950KB and two independent ways to fail. Justify it to yourself first.

## The performance budget: this board may hold twenty of these

An `emit_code` card is a whole browser context. The canvas is an infinite plane
and people collect cards on it, so assume yours is not alone — and the canvas
itself runs an rAF loop to position every node, so frames you waste come
straight out of the budget that keeps panning smooth.

- **Animate `transform` and `opacity`. Nothing else.** Animating `width`,
  `top`, `left`, `box-shadow` or `filter` forces layout or paint every frame. One
  card doing that is fine; a board of them is a canvas that stutters when you
  drag it.
- **Never drive motion from `setInterval` / `setTimeout`.** `requestAnimationFrame`
  stops when the tab is hidden and is throttled when the frame is offscreen;
  `setInterval` keeps firing forever, on every card, in a background tab.
- **When the timeline ends, STOP.** `raf = 0` and no further request. A finished
  explainer that keeps asking for frames costs the board an idle loop per card
  for the rest of the session. The skeleton above does this; keep it.
- **A loop that never ends needs a reason.** Ambient motion is fine, but keep it
  cheap: a handful of transforms, not a full re-layout, and still pause on
  `visibilitychange`.
- **Cap the particles.** A few thousand points in ONE `THREE.Points` with a
  `BufferGeometry` is one draw call. A few thousand `Mesh`es is a few thousand
  draw calls and will drop a card to single-digit fps on its own.
- **`setPixelRatio(Math.min(devicePixelRatio, 2))`.** On a retina display the
  default is a 4× fill-rate cost for a difference nobody sees on a card.
- **One WebGL context per card, ever.** Browsers cap the number of live contexts
  (Chrome discards the least-recently-used past roughly sixteen), and the card
  that gets discarded is not the one you just opened — it is somebody's earlier
  card, which goes black. Two renderers in one document doubles your share of
  that budget for nothing.
- **Size to the viewport, not to a fixed stage.** Use `window.innerWidth/Height`
  or `clientWidth/Height` and handle `resize`. The preview frame is the CARD's
  size (default 1100×700, often smaller), and `AUTO_FIT` in
  `CodeArtifactNode.tsx` measures the document and CSS-scales `body` down if it
  overflows — so a hardcoded 1920px stage renders as a blurry scaled-down
  thumbnail, and then again at a different size in the full-screen view.

## Respect `prefers-reduced-motion`

Motion is not a preference everybody can opt out of afterwards — for some people
it causes nausea or a migraine, and a card that plays the moment it appears gives
them no chance to look away.

```js
function reduced() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}
```

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  #stage { height: auto; overflow: visible; }
  .scene { position: static; opacity: 1; pointer-events: auto; }
}
```

**Give them the whole thing, not the last frame.** Jumping the timeline to `TOTAL`
is the lazy version and it usually leaves a logo on screen, because the last
scene of an explainer is a sign-off. Un-stacking the scenes into flow — which is
what the CSS above does, and note it relaxes the R1 height chain in the same
breath, correctly, because nothing is absolutely positioned any more — hands them
a readable document containing every point the animation was going to make.

Then leave the replay control **visible and working**, so someone who wants the
motion can ask for it deliberately.

## The look

The reference the person named is **threeui.com/browse**, and what to take from
it is discipline rather than effects: a near-black ground, **one** accent colour
carrying the whole piece, depth from gradient and glow rather than from a second
hue, large confident type with real negative space around it, and easing
(`cubic-bezier`, `easeCubicOut`) instead of linear on everything that moves.

This also happens to be kormo's own palette — dark surfaces, a neon accent — so a
card built this way sits on the canvas as though it belongs there instead of
looking like a page somebody pasted in.

**One idea per scene.** A scene that has to say three things is three scenes, and
2–3 seconds each is the range where a person can read the line and still feel the
thing is moving.

## Ground it, then say what you built

Every figure on screen comes from the material — the selected document, the
records, the connector read. Read the source first (`read_canvas_node`,
`query_records`). Never invent a number to fill a beat; if the material does not
support a scene, cut the scene.

When you finish, say how long the piece runs, how many scenes it has, and which
libraries it loads. If the card also has a still fallback, say that too — it is
the part nobody discovers on their own.

---
After executing: record_skill_run(skill_name="build-an-animation", outcome="success/failure")
