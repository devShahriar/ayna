---
description: "A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → `docker compose up -d --no-deps {no_deps}` → shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ \"$s\" = 200 ] && break; sleep 3; done`. In the agents' own words: deploy. Parameters: {no_deps} (e.g. n2, web; given by the asker); {number} (e.g. 40, 60; given by the asker)."
---

# routine-docker-compose-build-up-curl-2ff70d

Confidence: 0% (0 runs)


# Routine Docker Compose Build Up Curl 2ff70d

A routine agents here run again and again, learned from its repeated successful runs: `docker compose build n2` → `docker compose up -d --no-deps {no_deps}` → shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done`. In the agents' own words: deploy. Parameters: {no_deps} (e.g. n2, web; given by the asker); {number} (e.g. 40, 60; given by the asker).

## When to use

the work is to deploy — or the next command is `docker compose build n2`

## Steps

1. Run `docker compose build n2`
2. Run `docker compose up -d --no-deps {no_deps}`
3. shell `for i in $(seq 1 {number}); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done`

## Done when

- the last step (loop[curl]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-compose-build-up-curl-2ff70d", outcome="success/failure")
