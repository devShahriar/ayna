---
description: "When you are working in a live shared ROOM with other sessions and your edit would remove or overwrite code another member added, DO NOT blindly overwrite it. Use this skill to pull both sides — their exact change and their intent — from n2 and produce a SEMANTIC merge that keeps both, or surface the choice to the user. Triggered by a check-edit \"block\" verdict or an edit_collision brain signal. n2 is the merge assistant (it holds both intents on the graph); you are the merge engine."
---

# resolve-edit-collision

Confidence: 0% (0 runs)


# Resolve an edit collision in a live shared room

## When to use this skill

Use this the moment either of these happens while you are a member of a room
(`N2_ROOM` set, or you called `join_room`):

- A **pre-write guard** returned `verdict: "block"` when you were about to
  Edit/Write a file — meaning your change removes content another member added.
- You saw an **`edit_collision`** brain signal for a file you are about to touch.

**Do NOT use this skill** when you are not in a room, or when the user has
explicitly told you to overwrite the other change. In those cases proceed
normally.

## The one rule

**Never silently delete another session's work.** Their change and its reasoning
are on the graph and are recoverable — a collision is a decision to make, not a
race to win. Your job is to keep both intents whenever they can coexist, and to
escalate to the user when they genuinely conflict.

## Steps

1. **Read both sides.** The block verdict already carries the conflict: the other
   member's `session_id`, their exact `their_edit` (the code they added), their
   `their_intent`, and `when`. If you need more, call `room_context(room_id)` for
   what that session has been doing, or `room_feed(room_id)` for their recent
   edits to this file. n2 kept their added content even if it is no longer on
   disk — nothing is lost.

2. **Classify the collision.**
   - **Additive (the common case):** their change and yours touch the same file
     but different concerns (they added `computeVat()`, you are refactoring the
     handler). → You can KEEP BOTH.
   - **Contradictory:** you both changed the *same* lines toward incompatible
     goals. → This needs the user.

3. **If additive — produce a semantic merge.** Re-apply your change on top of
   theirs so both survive: keep their added function/feature AND your edit. You
   have the code graph (call it via `get_entity`/`review_code` if the function's
   callers matter) so you can weave them correctly rather than leaving conflict
   markers. Then make your edit against the merged version.

4. **If contradictory — surface the choice to the user.** Present, plainly:
   *"Session <them> added <their feature> because <their intent>. My change
   removes it to <your goal>."* Offer: **keep both / keep mine / keep theirs /
   cancel**. Do the option the user picks. Do not decide for them.

5. **Tell the room what you did.** Call `room_say(room_id, "...")` so the other
   session and any human watching the canvas see the resolution — e.g.
   *"Merged: kept your computeVat() and layered my checkout refactor on top."*
   This closes the loop and records the reconciliation.

## What n2 gives you that git does not

git would hand you `<<<<<<<` conflict markers with no idea *why* either side
made its change. n2 hands you the other side's **exact content plus their
intent** (their decision/plan, or their recent reasoning), and the code graph
around the function — so the merge you produce is semantic and correct, and the
teammate's feature never disappears without a deliberate, recorded choice.

---
After executing: record_skill_run(skill_name="resolve-edit-collision", outcome="success/failure")
