---
description: "A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && docker tag n2-n2 n2-n2:rollback-20261016` → `docker build -q -t n2-n2 -f $W/Dockerfile $W`. In the agents' own words: image, rollback, clean, copy."
---

# routine-docker-tag-build-4bd468

Confidence: 0% (0 runs)


# Routine Docker Tag Build 4bd468

A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && docker tag n2-n2 n2-n2:rollback-20261016` → `docker build -q -t n2-n2 -f $W/Dockerfile $W`. In the agents' own words: image, rollback, clean, copy.

## When to use

the work is to image, rollback, clean, copy — or the next command is `export PATH=$HOME/.orbstack/bin:$PATH && docker tag n2-n2 n2-n2:rollback-20261016`

## Steps

1. Run `export PATH=$HOME/.orbstack/bin:$PATH && docker tag n2-n2 n2-n2:rollback-20261016`
2. Run `docker build -q -t n2-n2 -f $W/Dockerfile $W`

## Done when

- the last step (docker build) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-tag-build-4bd468", outcome="success/failure")
