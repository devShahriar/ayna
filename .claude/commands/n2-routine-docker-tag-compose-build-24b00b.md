---
description: "A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}` → `docker compose build n2`. In the agents' own words: image, rebuild. Parameters: {value} (e.g. before-value-index, before-fast-door, before-unwrap; given by the asker)."
---

# routine-docker-tag-compose-build-24b00b

Confidence: 0% (0 runs)


# Routine Docker Tag Compose Build 24b00b

A routine agents here run again and again, learned from its repeated successful runs: `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}` → `docker compose build n2`. In the agents' own words: image, rebuild. Parameters: {value} (e.g. before-value-index, before-fast-door, before-unwrap; given by the asker).

## When to use

the work is to image, rebuild — or the next command is `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}`

## Steps

1. Run `export PATH=$HOME/.orbstack/bin:$PATH && cd ~/tracewit/n2 && docker tag n2-n2:latest n2-n2:{value}`
2. Run `docker compose build n2`

## Done when

- the last step (docker compose build) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-tag-compose-build-24b00b", outcome="success/failure")
