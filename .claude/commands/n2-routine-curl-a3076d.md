---
description: "A routine agents here run again and again, learned from its repeated successful runs: shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`. In the agents' own words: restart. Parameters: {number} (e.g. 60, 90, 30; given by the asker)."
---

# routine-curl-a3076d

Confidence: 0% (0 runs)


# Routine Curl A3076d

A routine agents here run again and again, learned from its repeated successful runs: shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`. In the agents' own words: restart. Parameters: {number} (e.g. 60, 90, 30; given by the asker).

## When to use

the work is to restart — or the next command is shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`

## Steps

1. shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`

## Done when

- the last step (loop[curl]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-curl-a3076d", outcome="success/failure")
