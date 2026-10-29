---
description: "How to compose a DASHBOARD on kormo's canvas — KPI tiles, charts, tables and filters in one live interactive panel that someone reads at a glance. Covers which numbers earn a tile, when a chart beats a table, binding a chart to a dataset so it re-queries instead of going stale, and the palette and tone rules that make it look designed. Load it before building anything dashboard-shaped. NOT for something that plays or is clicked through — a dashboard never animates."
---

# build-a-dashboard

Confidence: 0% (0 runs)


# Build a dashboard

A dashboard answers **"what is going on"** in one glance. It is read, not
navigated: no pages, no timeline, no click-through. If the person has to advance
through it, they asked for a deck. If it moves by itself, they asked for an
animation. Both are different skills and both say so.

## The shape

`emit_app` with `components` — a live interactive panel on the canvas.

    emit_app({
      title: "Payments — last 30 days",
      components: [
        { type:"kpi",   label:"Settled",        value:"৳2.4M" },
        { type:"kpi",   label:"Failed",         value:"312", tone:"danger" },
        { type:"chart", kind:"bar", title:"Failures by gateway",
                        data:[{label:"bKash", value:141}, {label:"Nagad", value:98}] },
        { type:"table", columns:["Order","Amount","Why"], rows:[[...]] }
      ]
    })

`components` is a **list**. Sending `{item:[…]}` is refused at the emit door,
with the path named — the canvas calls `.map` on it and an object draws nothing.

The component types that render: **kpi** (`label` + `value`), **chart**
(`kind: bar|line|area|pie|donut`), **table** (`columns` + `rows`, both arrays),
**tabs**. A component carrying none of those fields is an empty container and is
reported as one.

## Bind the chart to the data, don't bake it

This is the difference between a dashboard and a screenshot.

    { type:"chart", kind:"bar", title:"Spend by category",
      dataset:{ recordKind:"expense", groupBy:"category", agg:"sum", field:"amount" } }

A bound chart re-queries the brain every time it renders, so when a record
changes the card is already right. A baked `data:[…]` array is correct for
exactly as long as nothing changes, and there is no signal when it stops being
true.

So: when you have extracted structured rows, **`save_records` FIRST, then bind**.
To change what a bound chart shows later, change the query — `groupBy`, `agg`,
`filter` — not the numbers. Re-scraping to update a chart is the mistake this
avoids.

Use a literal `data:` array only for something genuinely one-off: a comparison
you computed in the reply, a handful of figures that will never change.

## What earns a place

Four to eight components. More than that is not a dashboard, it is a wall.

**Lead with the KPI tiles** — the two to four numbers someone would ask for
first. A tile is for a number that means something on its own: a total, a count,
a rate, a balance. Not every field deserves one; a tile for something nobody
would ask about is noise that pushes the real number off the top.

**Then the distribution.** A chart answers "how is it spread" — by category, by
day, by owner. If there are fewer than four data points, a chart is decoration
and a table or two more tiles say it better.

**Then the rows that matter.** A table is for the specific items someone will
act on: the failures, the overdue, the top ten. Not the whole dataset — a
dashboard that dumps 400 rows has stopped summarising.

**Then at most one short insight**, and only if it says something the numbers
do not. "Failures tripled after the 14th" earns its place. "There are 312
failures" does not — the tile already said that.

## Make it look designed

Pick **one accent** that fits the subject and derive the rest from it: commerce
reads amber, finance green, ops cyan, health teal. Vary shade across cards
rather than introducing competing hues — a dashboard with six unrelated colours
reads as six unrelated cards.

Reserve red for problems, and use it consistently: a `tone:"danger"` tile and a
red chart series must mean the same thing on the same card. Healthy is
`tone:"ok"`, everything else is neither — tone applied to every tile means
nothing.

Keep titles short enough to read at a glance. "Failed payments" beats "Total
count of payment transactions in a failed state".

## Ground every number

Every figure comes from the data you were given or a tool you called. If a
metric cannot be derived, **leave it out** — a plausible number on a dashboard
is worse than a missing one, because a dashboard is the thing people trust
without checking.

If the data is thin, say so in the reply and build the smaller honest version.
Four real tiles beat eight with four invented.

## When a dashboard is the wrong answer

- **One number.** Say it in the reply. A card for a single figure is ceremony.
- **They asked to see how things connect** — that is a graph, not a dashboard.
  `graph_around` returns `{nodes, edges}` and `emit_code` draws it with d3.
- **They asked for slides, a deck, a presentation** — `build-a-deck`.
- **They asked for a video, a reel, something that plays** — `build-an-animation`.
  A component tree cannot animate and cannot be made to.
- **They want the source itself on the canvas** — a calendar, a drive, a
  mailbox — that is `render-connected-source`.

## After you build it

Say what is on it in one sentence, naming the two or three things that stand
out — not a list of the cards you made. The person can see the cards. What they
cannot see is which number you think they should look at first.

---
After executing: record_skill_run(skill_name="build-a-dashboard", outcome="success/failure")
