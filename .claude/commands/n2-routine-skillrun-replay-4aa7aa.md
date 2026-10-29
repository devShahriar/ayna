---
description: "A routine agents here run again and again, learned from its repeated successful runs: `/tmp/skillrun-replay -capture $C/dataset/{value}.jsonl -skills $C/skills/cartography -out $S/{value_2}.jsonl`. In the agents' own words: replay, record, test. Parameters: {value} (e.g. capture_full, capture_full2; given by the asker); {value_2} (e.g. replay_full, replay_full2; given by the asker)."
---

# routine-skillrun-replay-4aa7aa

Confidence: 0% (0 runs)


# Routine Skillrun Replay 4aa7aa

A routine agents here run again and again, learned from its repeated successful runs: `/tmp/skillrun-replay -capture $C/dataset/{value}.jsonl -skills $C/skills/cartography -out $S/{value_2}.jsonl`. In the agents' own words: replay, record, test. Parameters: {value} (e.g. capture_full, capture_full2; given by the asker); {value_2} (e.g. replay_full, replay_full2; given by the asker).

## When to use

the work is to replay, record, test — or the next command is `/tmp/skillrun-replay -capture $C/dataset/{value}.jsonl -skills $C/skills/cartography -out $S/{value_2}.jsonl`

## Steps

1. Run `/tmp/skillrun-replay -capture $C/dataset/{value}.jsonl -skills $C/skills/cartography -out $S/{value_2}.jsonl`

## Done when

- the last step (skillrun-replay) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-skillrun-replay-4aa7aa", outcome="success/failure")
