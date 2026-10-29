---
description: "How to put a REAL PHOTOGRAPH into a card on kormo's canvas — find one with web_search, store it with capture_image, and compose type over it so it stays readable. Load it whenever a card is about a thing you can point a camera at (a product, a place, a person, a dish, a building) or whenever the ask is shaped like marketing — a hero, a poster, a reel, a story, \"make it look designed\". Also covers which pictures may legally be used, and the fade-in that renders a blank card when it is written wrongly. NOT for a data dashboard: numbers do not need a stock photo behind them."
---

# illustrate-with-photos

Confidence: 0% (0 runs)


# Illustrate with real photographs

The pipeline is complete and the agent has never used it. `web_search` has taken
`kind='images'` since it was written, `capture_image` stores a picture and hands
back something renderable, and three surfaces will draw it. Nothing ever said
"go and find a photograph", so nothing ever did.

## When a photograph earns its place

| The card is about | Photograph? |
|---|---|
| A product, a dish, a garment, a piece of hardware | **Yes** — people buy the thing, not a description of it |
| A place: a city, a venue, a route, a property | **Yes** |
| A person, where you have a legitimate picture of them | **Yes**, with a caption naming them |
| A brand, a campaign, a hero, a poster, a reel, a story | **Yes** — this IS the deliverable |
| A section opener in a deck that is otherwise all text | **Yes**, one per section, not one per slide |
| Metrics, spend, latency, a breakdown, a trend | **No.** A photo behind a number costs legibility and buys nothing |
| An architecture, a pipeline, a state machine | **No.** Draw it — there is no photograph of an abstraction |
| A table of records, a log, an inventory | **No** |

When you are unsure, ask what the picture is DOING. Carrying meaning the text
cannot (this is what the hotel looks like) → include it. Filling space → leave it
out; empty space read as design is better than a stock photo read as filler.

## The call sequence

```
web_search({ query: "…", kind: "images", limit: 8 })
  → results: [{ title, url, imageUrl, width, height }]
       imageUrl = the picture itself
       url      = the PAGE it appears on

capture_image({ url: <imageUrl>, from: <url>, label: "what it shows" })
  → { uploadId, src, mimeType, bytes, reused }
       src = "/api/infra/upload/<uploadId>/raw"

… then place `src` (or `uploadId`) on a surface, below.
```

**Always pass `from`.** It becomes the `Referer` header, and a great many sites
403 an image requested without one — hotlink protection is the norm, not the
exception. `fetchImageBytes` names this case specifically: a 403 with no `from`
comes back as *"pass `from` with the page URL the image appeared on and try
again"* (internal/agents/runtime/webindex.go). You already have the page URL in
the same search result. There is no reason to omit it.

Two refusals to expect, and neither is a bug to work around:

- **SVG is refused.** An SVG is a document that can carry `<script>`, and stored
  assets are served from the app's own origin. Capture a raster version instead.
- **Over 12 MB is refused.** Pick a different result; an image search usually
  offers a smaller one of the same subject.

`reused: true` means those exact bytes were already held and the capture cost
nothing — worth saying when you captured twenty pictures and downloaded three.

## Licensing — the rule, and why it is a rule

An image search here runs through SearXNG, which asks several upstreams in
parallel. **Measured 15 Sep 2026 against the live instance, the engines behind
an image query were: bing images, google cse images, unsplash, pexels, artic and
pinterest.**

**Only Unsplash and Pexels are licensed for commercial reuse. Use nothing else in
anything a customer publishes.**

A result from bing, google or pinterest is a search engine's *index* of somebody
else's copyrighted photograph. The engine has a licence to index it; kormo has
none to redistribute it, and neither does the customer whose campaign it lands
in. Downloading it succeeds, it looks perfect on the card, and the liability
arrives months later attached to the customer's name. That is why this is a hard
rule rather than a preference: the failure is invisible at the moment you make
it.

**The search result does not tell you which engine it came from** — `searchResult`
carries title, url, imageUrl and resolution, and no engine field
(internal/agents/runtime/internet.go). So judge by the `url` host, which is the
page the picture lives on:

- `unsplash.com` / `images.unsplash.com` → **use it**
- `pexels.com` / `images.pexels.com` → **use it**
- anything else → **do not use it** in published output

Two narrow exceptions, and say out loud which one you are using: a picture from
**the customer's own** site or connector (it is theirs), and a picture the person
explicitly pointed you at ("use the photo on this page"). Museum/archive results
such as `artic.edu` have per-work terms that vary by object — do not assume, and
do not use one without checking the object's own page.

To bias the search rather than filter afterwards, put the source in the query:
`"dhaka street food unsplash"`, `"modern office interior pexels"`. Then discard
every result whose `url` is not on those hosts, and if that leaves nothing, say
so and build the card without a photograph. Shipping an unlicensed image is
worse than shipping no image.

## Where the picture can go — three surfaces, three shapes

**`emit_image_node`** — the picture as a real canvas node, selectable and
movable. Pass `uploadId`. Batch them: `images:[{uploadId, label}]`, up to 24 per
call, never one call per picture.

**`emit_app` image component** — the picture inside an app panel:

```json
{ "type": "image", "src": "/api/infra/upload/up-…/raw", "caption": "…" }
```

It renders an `<img>` and a caption line, and that is all it renders
(ArtifactApp.tsx). **No overlay, no text on top, no full-bleed.**

**Deck slide element** — note the field name is `url`, not `src`:

```json
{ "id": "e2", "kind": "image", "url": "/api/infra/upload/up-…/raw",
  "caption": "…", "anim": { "type": "fade", "delay": 200, "dur": 600 } }
```

Capped at 72% width / 42vh and centred (DeckArtifact.tsx) — a figure on a slide,
not a background.

**So: if the design needs TEXT OVER the photograph, it is `emit_code`.** Neither
of the other two composes type over an image, and asking them to is how a run
produces a card that does not look like what was described.

## Text over a photograph, in `emit_code`

Reference the `src` from capture_image exactly as returned. You do **not** inline
base64 yourself — kormo swaps the upload path for the bytes on the way in
(internal/api/inline_uploads.go), because a card renders in a sandbox with **no
`allow-same-origin`** and can never fetch from kormo. This was measured on 14 Sep
2026: a card textured a 3D bottle from a real upload, showed FAILED TO LOAD, and
the agent — reading its own correct source — diagnosed the URL instead of the
sandbox. An earlier dossier card was rebuilt **five times** chasing the same
invisible cause, at one point replacing a real photograph with a monogram.

Budgets, so you can size the picture before you choose it: the emit door bakes an
image under **768 KB** (2 MB per card); over that it leaves the URL and warns, and
the browser-side resolver still handles up to 2 MB per asset / 16 assets / 6 MB
per card (apps/web/lib/infra/sandboxAssets.ts). Practically: prefer a result
around 1600–2000 px wide, and if a card really needs a huge photograph, place it
with `emit_image_node` instead of embedding it.

**Never put type straight onto a photograph.** A photo's luminance varies across
its own area, so white text is legible over the sky and invisible over the
building. Put a scrim between them — a gradient that is opaque where the text is
and transparent where it is not:

```html
<section data-kormo-part="hero" data-kormo-label="Hero image">
  <div class="hero">
    <img src="/api/infra/upload/up-…/raw" alt="…">
    <div class="scrim"></div>
    <div class="copy">
      <h1 class="line">Padma Bridge</h1>
      <p class="line">6.15 km · opened June 2022</p>
    </div>
  </div>
</section>
```

```css
.hero   { position:relative; aspect-ratio:16/9; overflow:hidden; border-radius:14px }
.hero img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover }
/* the scrim: dark where the words are, gone where they are not */
.scrim  { position:absolute; inset:0;
          background:linear-gradient(180deg,rgba(6,8,12,0) 32%,rgba(6,8,12,.55) 62%,rgba(6,8,12,.88) 100%) }
.copy   { position:absolute; left:6%; right:6%; bottom:7% }
.copy h1{ color:#FFF7E8; font-size:clamp(28px,4.4vw,56px); letter-spacing:-.025em; line-height:1.04 }
.copy p { color:rgba(255,247,232,.82); font-size:clamp(13px,1.4vw,17px) }
```

Rules that hold regardless of the design:

- The scrim is a **gradient**, not a flat tint over the whole picture. A flat
  overlay dulls the photograph everywhere to fix a contrast problem that exists
  in one corner.
- Aim for a contrast ratio of at least **4.5:1** between the text and the pixels
  actually behind it. If you cannot get there with a scrim, the photograph is
  wrong for text — move the type into a band beside the image.
- A hard-cased alternative that always works: a blurred panel behind the text
  only (`backdrop-filter: blur(14px)` over `rgba(6,8,12,.42)`), which keeps the
  photo readable and the text crisp.
- Caption every photograph of a person or a place. An unlabelled photograph of a
  person is worse than no photograph.
- `object-fit: cover` on a fixed `aspect-ratio`. A raw `<img>` in a flex column
  will letterbox or stretch depending on the result's resolution, and you do not
  control which resolution the search returns.

## Fading text in and out over imagery

**On a deck, do not write CSS.** The surface already animates: give the element
`anim:{type:"fade"|"rise", delay, dur}` in **milliseconds** and DeckArtifact runs
the keyframes for you.

**In `emit_code`, use pure CSS with `forwards`:**

```css
@keyframes riseIn { from { opacity:0; transform:translateY(14px) } to { opacity:1; transform:none } }
.line { opacity:0; animation:riseIn .7s cubic-bezier(.2,.7,.2,1) forwards }
.line:nth-child(2) { animation-delay:.22s }
```

For copy that cycles over a held image — fade in, dwell, fade out, next line:

```css
@keyframes cycle { 0%,4%{opacity:0} 12%,40%{opacity:1} 48%,100%{opacity:0} }
.cap { opacity:0; animation:cycle 12s infinite both }
.cap:nth-child(2){ animation-delay:4s } .cap:nth-child(3){ animation-delay:8s }
```

### The trap: anything that starts at `opacity:0` must be *driven* to visible

An element whose resting state is invisible is a blank card unless something
actually runs. The CSS above is safe because the browser runs it unconditionally
and `forwards` holds the end state. A **script**-driven reveal is not safe: one
throw anywhere before the reveal — a typo, a CDN library that did not load, an
`IntersectionObserver` on a node that is already past — and every element stays
at zero. The card is not broken-looking; it is *empty*, and from inside the run
there is no evidence at all, because the sandbox reports nothing you will read.

This is not hypothetical. **Measured 13 Sep 2026:** a five-slide deck stored
perfectly — slides, elements, real Bangla text — and rendered as a blank stage.
The renderer appended `s` to a duration meant as milliseconds, so `dur: 700`
became seven hundred *seconds*, and with fill-mode `both` every element held its
`from` state — opacity 0 — for eleven minutes. Nothing was missing. Everything
was invisible.

So:

- **Default to CSS animation.** It needs no script to have run.
- If you use JS, make the **visible** state the static one and let the script
  *add* motion. `opacity:1` in the stylesheet, script removes it to replay — not
  `opacity:0` in the stylesheet, script promises to fix it.
- Keep every duration and delay in the range a person would sit through:
  entrances **200–800 ms**, a full cycle **8–14 s**. A number outside that is
  almost always a unit mistake.
- Honour `@media (prefers-reduced-motion: reduce)` by setting `animation:none`
  and `opacity:1` — which is also a free second guarantee that the text exists.
- Every region still needs `data-kormo-part` and `data-kormo-label`, or the emit
  is refused and nothing is placed.

## Composition — where to steal from

Two references worth browsing before composing a photographic card, because both
solve the same problem this skill keeps hitting (one focal element, restrained
motion, type that stays readable):

- **threeui.com/browse** — a gallery of component and motion treatments. Take the
  *composition*: a single dominant image, a tight type stack in one corner,
  motion that happens once and then gets out of the way.
- **shadcn** — take the *system*: neutral surfaces, one accent used sparingly, a
  consistent radius (10–16 px), generous padding, a spacing scale you do not
  deviate from mid-card, and borders at low alpha rather than hard lines.

Neither is a thing to copy pixel-for-pixel. The point is that a card reads as
designed when the decisions are *few and repeated* — one radius, one accent, one
type scale, one motion curve — not when each element is individually
interesting.

## When you cannot find a usable photograph

Say so in one line and build the card anyway, with a strong type treatment on a
flat or gradient ground. Three things you must never do: use a bing / google /
pinterest result because it was the best-looking one, describe a photograph in
words where a photograph was asked for, or leave a broken `<img>` in the card and
report success. A card that says "no licensed photograph of this was available"
is finished work; a card with an empty frame is not.

## When you are done

Say what you captured and where it came from — "hero photograph from Unsplash,
stored as up-…". The source is the part the person needs in order to answer the
only question that matters later, which is whether they are allowed to publish it.

---
After executing: record_skill_run(skill_name="illustrate-with-photos", outcome="success/failure")
