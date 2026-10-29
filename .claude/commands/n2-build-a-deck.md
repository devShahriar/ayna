---
description: "How to build a DECK on kormo's canvas — SLIDES someone clicks through, editable in place and exportable to PPTX or PDF. Slides can animate their elements in, but a deck does not PLAY: it waits for a click. Load it before building anything slide-shaped, and NOT when the person asked for something that runs on its own — a video, a 10-second explainer, an animation with a timeline. That is a code card, not a deck. Also covers when a document or a Google Slides file is the right answer instead."
---

# build-a-deck

Confidence: 0% (0 runs)


# Build a deck

A deck on this canvas is **`emit_app` with `slides`**. Not `emit_code`. Not a
component tree. Not `connector_op slides.create` unless the person asked for a
file in Google.

## A VIDEO IS NOT A DECK

If the person asks for a **video**, something that **plays**, an **animation**, a
**motion explainer**, or anything that runs on its own — that is `emit_code`, not
this skill. Stop reading here and build that instead.

A deck is click-through. `DeckArtifact` has no autoplay, no play head and no
timed advance: a person presses ▸ to go to the next slide. Per-element animation
plays once as a slide appears. That is a slide build, and it is NOT a video.
`emit_code` writes self-contained HTML that genuinely runs — the canvas already
carries several (an 8-slide animated D3 deck driving itself on rAF and
setInterval, an animated marketing hero, an interactive landscape).

MEASURED 14 Sep 2026, and this skill CAUSED it. Asked for an "ANIMATED
EXPLANATION VIDEO" of a GitHub project, the run built six single-slide deck
cards, none of which play. The word *animated* matched this skill, this skill is
a baseline house rule injected into every run, and it says in as many words that
`emit_code` is the wrong tool when the ask is animated and slide-shaped. It was
written to stop the agent writing HTML when someone wanted an editable deck. It
was never meant to answer "video", and left alone it answers it every time.

The discriminator is not the word "animated" — a deck can be animated. It is
whether the thing must **play by itself**:

| the person says | build |
|---|---|
| deck · slides · presentation · one page per slide | `emit_app` with `slides` |
| video · animation · explainer that plays · motion graphic · "show me how X works" | `emit_code` |

When it is genuinely ambiguous, the editable, exportable deck is the safer
default — but say which you built and why, so they can ask for the other one in
one sentence rather than discovering it by looking.

## The one call

```
emit_app({
  title: "…",
  theme: { bg: "#0b1220", accent: "#5eead4" },     // optional
  slides: [
    { id: "s1", anim: "rise", notes: "the talk track",
      elements: [
        { id: "e1", kind: "heading", text: "…",
          style: { size: 72, color: "#5eead4", align: "center", weight: 800 },
          anim:  { type: "rise", delay: 0,   dur: 700 } },
        { id: "e2", kind: "bullets", items: ["…", "…"],
          anim:  { type: "fade", delay: 200, dur: 600 } }
      ] }
  ]
})
```

`kind` is one of `heading · text · bullets · quote · image · flow · spacer`.
`anim.type` is one of `rise · fade · zoom · slideleft · none`.

**Give every slide and every element a short stable id.** That is what lets a
person click one heading and ask you to change exactly that heading — you patch
that id with `update_node` and nothing else moves. Regenerating the whole deck to
change one line throws away every edit they made by hand.

## Why not the other surfaces

- **`emit_code`** writes one self-contained HTML document in a sandbox. It is the
  right tool for a widget, a calculator, a map, a game, anything 3D, **and for a
  video or any animation that plays by itself** (see above — that case leaves
  this skill entirely). Used for a DECK it produces a page with no
  slide navigation, nothing a person can edit, no PPTX export and no per-element
  targeting — a picture of a deck rather than a deck.
- **Components** (`emit_app` with `components`) build a live dashboard: KPIs,
  charts, tables, filters. **They never animate.** If the ask contains the word
  animated and the subject is slides, that alone rules components out.
- **`connector_op slides.create`** makes a real file in the person's Google
  account. Right when they asked for a Google Slides deck or something to share
  outside kormo; wrong when they said "on the canvas" or "here".

## One card per deck — unless they asked for one per slide

The DEFAULT is one deck holding every slide. "A dashboard for each slide" of an
18-slide document is usually eighteen cards carrying invented metrics when the
pages themselves were the ask.

**An explicit instruction outranks this default, and outranks every other
preference in this skill.** If the person says "one card per slide", "a separate
card for each slide", or "separate cards, not one deck", then build exactly that:
one `emit_app` call per slide, each with that slide's own `slides:[…]` of one.
Do not talk them out of it, do not build one deck instead, and do not stop after
the first slide — N slides means N calls.

MEASURED 13 Sep 2026: asked for "a SEPARATE animated card for EACH slide, one
emit_app call per slide, separate cards not one deck", the run emitted a single
card for slide one and finished. This paragraph is why. A default stated as a
near-prohibition is read as a prohibition, and the person's own words lose to it.

## Ground it

Every figure on a slide comes from the material — the selected document, the
records, the connector read. Read the source first with `read_canvas_node` or
`query_records`. Never invent a number to fill a slide; if the material does not
support a section, cut the section.

## When you are done

Say how many slides landed and what the deck is called. If you emitted more than
one card this run, say that too — each `emit_app` call places a NEW card and
never replaces an earlier one.

---
After executing: record_skill_run(skill_name="build-a-deck", outcome="success/failure")
