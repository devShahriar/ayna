---
description: "A routine agents here run again and again, learned from its repeated successful runs: `export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin && cd ~/tracewit/n2 && timeout 1500 docker compose build n2` → `docker compose up -d --no-deps n2` → shell `for i in $(seq 1 60); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ \"$s\" = 200 ] && break; sleep 3; done` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy."
---

# routine-docker-compose-build-up-curl-image-prune-3ec319

Confidence: 0% (0 runs)


# Routine Docker Compose Build Up Curl Image Prune 3ec319

A routine agents here run again and again, learned from its repeated successful runs: `export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin && cd ~/tracewit/n2 && timeout 1500 docker compose build n2` → `docker compose up -d --no-deps n2` → shell `for i in $(seq 1 60); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done` → `docker image prune -f` → `docker builder prune -f`. In the agents' own words: deploy.

## When to use

the work is to deploy — or the next command is `export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin && cd ~/tracewit/n2 && timeout 1500 docker compose build n2`

## Steps

1. Run `export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin && cd ~/tracewit/n2 && timeout 1500 docker compose build n2`
2. Run `docker compose up -d --no-deps n2`
3. shell `for i in $(seq 1 60); do s=$(curl -s -o /dev/null -w '%{http_code}' localhost:8090/api/v1/health/all); [ "$s" = 200 ] && break; sleep 3; done`
4. Run `docker image prune -f`
5. Run `docker builder prune -f`

## Done when

- the last step (docker builder prune) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-compose-build-up-curl-image-prune-3ec319", outcome="success/failure")
