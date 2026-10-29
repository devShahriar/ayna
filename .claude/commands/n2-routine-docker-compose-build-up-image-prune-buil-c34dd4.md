---
description: "A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → `docker compose up -d --no-deps {no_deps}` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy. Parameters: {no_deps} (e.g. n2, web; given by the asker)."
---

# routine-docker-compose-build-up-image-prune-buil-c34dd4

Confidence: 0% (0 runs)


# Routine Docker Compose Build Up Image Prune Buil C34dd4

A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → `docker compose up -d --no-deps {no_deps}` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy. Parameters: {no_deps} (e.g. n2, web; given by the asker).

## When to use

the work is to deploy — or the next command is `docker compose build n2`

## Steps

1. Run `docker compose build n2`
2. Run `docker compose up -d --no-deps {no_deps}`
3. Run `docker image prune -f`
4. Run `docker builder prune -f`

## Done when

- the last step (docker builder prune) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-compose-build-up-image-prune-buil-c34dd4", outcome="success/failure")
