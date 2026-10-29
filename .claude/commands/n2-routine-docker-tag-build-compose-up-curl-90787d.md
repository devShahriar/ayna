---
description: "A routine agents here run again and again, learned from its repeated successful runs: `docker tag n2-n2:latest n2-n2:{value}` → `docker build -q -t n2-n2 -f $W/Dockerfile $W` → `cd ~/tracewit/n2 && docker compose up -d --no-deps n2` → shell `for i in $(seq 1 60); do s=$(curl -s -m 5 localhost:8090/api/v1/health/all); echo \"$s\" | grep -q '\"ready\":true\\|\"status\":\"ready\"' && break; sleep 5; done`. In the agents' own words: local, image, health, redeploy. Parameters: {value} (e.g. rollback-20261016d, rollback-20261016e; given by the asker)."
---

# routine-docker-tag-build-compose-up-curl-90787d

Confidence: 0% (0 runs)


# Routine Docker Tag Build Compose Up Curl 90787d

A routine agents here run again and again, learned from its repeated successful runs: `docker tag n2-n2:latest n2-n2:{value}` → `docker build -q -t n2-n2 -f $W/Dockerfile $W` → `cd ~/tracewit/n2 && docker compose up -d --no-deps n2` → shell `for i in $(seq 1 60); do s=$(curl -s -m 5 localhost:8090/api/v1/health/all); echo "$s" | grep -q '"ready":true\|"status":"ready"' && break; sleep 5; done`. In the agents' own words: local, image, health, redeploy. Parameters: {value} (e.g. rollback-20261016d, rollback-20261016e; given by the asker).

## When to use

the work is to local, image, health, redeploy — or the next command is `docker tag n2-n2:latest n2-n2:{value}`

## Steps

1. Run `docker tag n2-n2:latest n2-n2:{value}`
2. Run `docker build -q -t n2-n2 -f $W/Dockerfile $W`
3. Run `cd ~/tracewit/n2 && docker compose up -d --no-deps n2`
4. shell `for i in $(seq 1 60); do s=$(curl -s -m 5 localhost:8090/api/v1/health/all); echo "$s" | grep -q '"ready":true\|"status":"ready"' && break; sleep 5; done`

## Done when

- the last step (loop[curl]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-tag-build-compose-up-curl-90787d", outcome="success/failure")
