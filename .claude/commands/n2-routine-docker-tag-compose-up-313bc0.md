---
description: "A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}` → `cd ~/tracewit/n2 && docker compose up -d --no-deps n2`. In the agents' own words: image, local, restart, rollback. Parameters: {value} (e.g. before-fast-door, before-pull-turns, before-pending-keys; given by the asker)."
---

# routine-docker-tag-compose-up-313bc0

Confidence: 0% (0 runs)


# Routine Docker Tag Compose Up 313bc0

A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}` → `cd ~/tracewit/n2 && docker compose up -d --no-deps n2`. In the agents' own words: image, local, restart, rollback. Parameters: {value} (e.g. before-fast-door, before-pull-turns, before-pending-keys; given by the asker).

## When to use

the work is to image, local, restart, rollback — or the next command is `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}`

## Steps

1. Run `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}`
2. Run `cd ~/tracewit/n2 && docker compose up -d --no-deps n2`

## Done when

- the last step (docker compose up) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-tag-compose-up-313bc0", outcome="success/failure")
