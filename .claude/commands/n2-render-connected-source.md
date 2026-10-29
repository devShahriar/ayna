---
description: "How to put a connected source — a calendar, a spreadsheet, a drive of files, a map, a mailbox — onto the kormo canvas as a card people can actually use. Use this whenever you are asked to show, import, render or display anything that came from a connector or arrived from a channel (WhatsApp, Slack, email). It fixes the SHAPE and the STYLE of the card so every render looks like the same product; only the data differs."
---

# render-connected-source

Confidence: 0% (0 runs)


# Rendering a connected source on the canvas

## The rule that matters most

**You do not invent the style.** The card's shape, component type and colours are
fixed below. Two people importing two different calendars must get cards that look
like the same product — only their events differ. If you improvise a layout, the
canvas stops looking like one thing and starts looking like a pile of one-offs.

**Always bind the data LIVE.** Pass a `dataset` so the card re-reads its source.
Never paste values you fetched once: a frozen snapshot is a lie that gets staler
every hour, and the person planning against it has no way to know.

## Pick the surface by what the thing IS

| The source | Component | Notes |
|---|---|---|
| Calendar / anything with events over time | `calendar` | month grid; click drills in |
| Spreadsheet, query result, list of rows | `table` | one row per record |
| A file store you BROWSE (Drive, Dropbox, Box) | `picker` | the provider's own browser — never build one |
| One file you are SHOWING (doc, sheet, PDF, video) | `embed` | the provider's own viewer, framed |
| A file (image, PDF, doc) that arrived | `ingest_file` | places the real bytes as a card |
| A document created in another system | `emit_document` | openable, with its URL |
| A number worth watching alone | `kpi` | only when a single figure IS the answer |

## The templates — copy these shapes exactly

**Calendar** — accent `#1a73e8`, and a window wide enough to plan against
(a default of "the next few events" reads to the user as "nothing imported"):

```json
{ "title": "Google Calendar", "subtitle": "Live · your calendar", "accent": "#1a73e8",
  "components": [{ "type": "calendar", "title": "Bookings & events",
    "dataset": { "connector": "calendar", "op": "list_events",
      "params": { "timeMin": "<30 days ago, RFC3339>", "timeMax": "<120 days ahead>", "max": 250 },
      "refreshMs": 60000 } }] }
```

**Spreadsheet** — accent `#0f9d58`. A sheet needs its `spreadsheetId`; if you were
given a share link, take the id out of `/spreadsheets/d/<ID>/`:

```json
{ "title": "<the sheet's real name>", "subtitle": "Live · Google Sheets", "accent": "#0f9d58",
  "components": [{ "type": "table", "title": "<sheet or tab name>",
    "dataset": { "connector": "sheets", "op": "read",
      "params": { "spreadsheetId": "<ID>", "range": "Sheet1" }, "refreshMs": 120000 } }] }
```

**A file store (Drive) — do NOT draw a file browser.** No table of filenames, no
row of folder buttons, no breadcrumb you maintain. Google publishes the real
thing and it is embedded with one component. Accent `#fbbc04`:

```json
{ "title": "Google Drive", "subtitle": "Live · your Drive", "accent": "#fbbc04",
  "components": [
    { "type": "picker", "provider": "google", "label": "Browse Drive", "multiple": true,
      "action": { "do": "run_agent", "target": "drive",
                  "message": "The user picked these Drive files. Render each one." } }] }
```

The picker hands your agent `{files, fileIds, fileNames}` — real ids from a real
Drive, with folder navigation and search you did not write. What a picked file
BECOMES is your decision: a sheet is worth a `table` bound to `sheets.read`, an
image or PDF is worth an `embed`.

**One file, shown** — the provider's own viewer, accent per product:

```json
{ "type": "embed", "title": "<the file's real name>", "height": 520,
  "url": "https://drive.google.com/file/d/<FILE_ID>/preview" }
```

Embeddable: `drive.google.com/file/d/<id>/preview`,
`docs.google.com/spreadsheets/d/<id>/preview`, `.../document/d/<id>/preview`.
**Not embeddable:** the Drive app page (`drive.google.com/drive/...`) — it sends
`x-frame-options` and renders as a refusal. Never point an `embed` at it.

**A workbook has TABS, so show them all.** A spreadsheet rendered as one table
hides most of the data. Call `sheets.list_tabs` first, then put one bound table
per tab inside a `tabs` component — no new component type, just the one that
already exists:

```json
{ "type": "tabs", "key": "sheet",
  "tabs": [{ "label": "<tab title>", "children": [
    { "type": "table", "dataset": { "connector": "sheets", "op": "read",
      "params": { "spreadsheetId": "<ID>", "range": "<tab title>" }, "refreshMs": 120000 } }] }] }
```

The `range` is the tab's own title — that is how one workbook becomes several
live tables without any of them being a copy.

**Mail / issues / any row source** — accent `#5eead4`, same `table` shape with that
connector's own read verb.

## Accents are per PRODUCT, not per taste

`calendar #1a73e8` · `sheets #0f9d58` · `docs #4285f4` · `drive #fbbc04` ·
`gmail #ea4335` · `slack #611f69` · `notion #e9e9e7` · anything else `#5eead4`.

Event or row colours inside a card may vary with the data — that is the data
speaking. The card's frame, accent and layout may not.

## Finding and filing things without a canvas

A request can arrive from WhatsApp or Slack, where there is no picker to click.
Use the Drive verbs directly, and they are the SAME verbs the canvas uses:

- `drive.search` — `{text, folderId?, mimeType?, max?}`. With no text it lists the
  root, so it doubles as "what's in my Drive".
- `drive.get` — `{fileId}` — resolve a link someone pasted before rendering it.
- `drive.upload` — `{name, uploadId|dataUri|url, folderId?, mimeType?}`. This is
  "save this photo to my Drive": the photo that arrived on WhatsApp already has an
  `uploadId`, so pass that — never re-download it.
- `drive.create_folder` — `{name, parentId?}`.

`upload` and `create_folder` are writes, so they become a proposal the person
approves. Say so when you use them; do not report a file as saved before it is.

**Several accounts.** A workspace can hold more than one Google sign-in. If more
than one is connected and the request does not say which, ASK. Reading the wrong
person's Drive is worse than one extra question.

## When you cannot render it

Say so, in one line, naming what you need — "which sheet?", "that calendar isn't
connected". Two things you must never do: guess an argument so the call
"succeeds", or report success when nothing was drawn. If the request came from a
channel (WhatsApp, Slack, email), the reply goes back to whoever sent it, so make
it a sentence they can act on rather than an error code.

## Declare what the card can DO

A card you render can be looked at. A card with a **contract** can be operated —
by a dashboard agent, by a WhatsApp router, by an agent written next year. Pass
`contract` to `emit_app` whenever the card is backed by a connected source, and
follow your **operate-canvas-cards** skill for its shape and rules.

Rendering without a contract is how a source ends up visible and useless.

## After you render

Say what landed and that it stays live — one short line. If the source carried
knowledge worth keeping (a document's text, rows worth querying later), also file
it with `save_records` or `ingest_file` so the brain can answer questions about it
afterwards; a card nobody can query is a picture, not knowledge.

---
After executing: record_skill_run(skill_name="render-connected-source", outcome="success/failure")
