---
description: "A routine agents here run again and again, learned from its repeated successful runs: `T=$(date +%s) && until c=$(docker stats --no-stream --format '{{.CPUPerc}}' n2-postgres-1 | tr -d '%'); [ \"${c%.*}\" -lt 150 ] || [ $(( $(date +%s)-T )) -ge 600 ]; do sleep 15; done`. In the agents' own words: measure, deploy, postgres, settle."
---

# routine-commands-378fe5

Confidence: 0% (0 runs)


# Routine Commands 378fe5

A routine agents here run again and again, learned from its repeated successful runs: `T=$(date +%s) && until c=$(docker stats --no-stream --format '{{.CPUPerc}}' n2-postgres-1 | tr -d '%'); [ "${c%.*}" -lt 150 ] || [ $(( $(date +%s)-T )) -ge 600 ]; do sleep 15; done`. In the agents' own words: measure, deploy, postgres, settle.

## When to use

the work is to measure, deploy, postgres, settle — or the next command is `T=$(date +%s) && until c=$(docker stats --no-stream --format '{{.CPUPerc}}' n2-postgres-1 | tr -d '%'); [ "${c%.*}" -lt 150 ] || [ $(( $(date +%s)-T )) -ge 600 ]; do sleep 15; done`

## Steps

1. Run `T=$(date +%s) && until c=$(docker stats --no-stream --format '{{.CPUPerc}}' n2-postgres-1 | tr -d '%'); [ "${c%.*}" -lt 150 ] || [ $(( $(date +%s)-T )) -ge 600 ]; do sleep 15; done`

## Done when

- the last step (loop[[]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-commands-378fe5", outcome="success/failure")
