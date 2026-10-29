---
description: "How to find out what a kormo canvas can actually DO, and how to act on a source you were never told about. Use this whenever you are asked to do something with a calendar, a drive, a spreadsheet, a CRM or any other connected source — before you reach for a connector verb — and whenever you put a source on the canvas yourself."
---

# operate-canvas-cards

Confidence: 0% (0 runs)


# Operating cards on the canvas

## Ask the canvas, do not assume

You were written before most of the sources you will meet. A canvas can hold a
connector published last week by someone you have never heard of, and guessing
its verb names is how you fail confidently.

So when you are asked to act on a source:

1. **`list_cards`** — what is here, and what can each one do.
2. **`describe_card`** — the full contract for the one you picked, plus the
   skill that teaches you to drive it.
3. **`invoke_card`** — call the capability.

Reach for a raw connector verb only when no card offers what you need. A card
knows *which* calendar, *which* account, *which* spreadsheet; a bare verb does
not, and you would have to guess.

## What a capability call is

The card's own state is merged in for you. If a card is bound to
`team@acme.com`, you do not pass that — you pass what the capability asks for.
Pass an account or an id yourself only to deliberately override.

**A write is a proposal.** A capability marked `write` never executes when you
call it; it becomes a change a human approves. Say it is pending. Reporting a
booking as made when it is waiting for approval is the worst thing you can do
here, because the person stops watching for it.

## When you put a source on the canvas, declare a contract

A card without a contract can be looked at and nothing else. Declaring one is
what lets a dashboard agent, a WhatsApp router, or an agent written next year
use the source you just connected.

Pass `contract` to `emit_app` / `emit_card`:

```json
{ "kind": "google.calendar",
  "skill": "connector-google-calendar",
  "state": { "calendarId": "team@acme.com" },
  "capabilities": [
    { "name": "add_event", "write": true,
      "args": { "summary": "string", "start": "rfc3339", "end": "rfc3339" },
      "impl": { "verb": "calendar.create_event" } },
    { "name": "refresh", "impl": { "agent": "calendar" } }
  ] }
```

Four rules, and each is enforced — a contract that breaks one is rejected:

- **`kind` is namespaced.** `google.calendar`, never `calendar`. Two authors
  will publish a calendar and the collision has to be impossible.
- **Exactly one of `verb`, `agent` or `tool`** per capability. Zero does
  nothing; two means nobody can say what it does.
- **Mark writes `write: true`.** That is what routes them through approval.
  Leaving it off does not make the action quiet, it makes it ungoverned.
- **Never put a credential in `state`.** State is readable by every agent that
  can see the card. Credentials live in the connection.

## Capability names are an API

People and other agents will call them by name for as long as the card exists,
so name them for what they do to the source — `add_event`, `find_slot`,
`refresh`, `file_here` — not after your implementation. Renaming one later
breaks every caller, including ones you cannot see.

## When it does not work

- **No card offers it.** Say which cards are on the canvas and what they do
  offer. Do not silently substitute a different capability.
- **The capability failed.** Report the source's own error. An agent that
  swallows a provider's message leaves the person with nothing to act on.
- **Several cards match.** Ask which. Acting on the wrong calendar is worse
  than one extra question.

---
After executing: record_skill_run(skill_name="operate-canvas-cards", outcome="success/failure")
