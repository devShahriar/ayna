---
description: "A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ \"$s\" = 200 ] && break; sleep 3; done` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy. Parameters: {number} (e.g. 40, 60; given by the asker)."
---

# routine-docker-compose-build-curl-image-prune-bu-8052b3

Confidence: 0% (0 runs)


# Routine Docker Compose Build Curl Image Prune Bu 8052b3

A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy. Parameters: {number} (e.g. 40, 60; given by the asker).

## When to use

the work is to deploy — or the next command is `docker compose build n2`

## Steps

1. Run `docker compose build n2`
2. shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done`
3. Run `docker image prune -f`
4. Run `docker builder prune -f`

## Done when

- the last step (docker builder prune) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-compose-build-curl-image-prune-bu-8052b3", outcome="success/failure")
