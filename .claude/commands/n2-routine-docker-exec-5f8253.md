---
description: "A routine agents here run again and again, learned from its repeated successful runs: `docker exec -i n2-postgres-1 psql -U n2 -d n2 -At < $S/{value}.sql`. Parameters: {value} (e.g. q7, q8, q9; given by the asker)."
---

# routine-docker-exec-5f8253

Confidence: 0% (0 runs)


# Routine Docker Exec 5f8253

A routine agents here run again and again, learned from its repeated successful runs: `docker exec -i n2-postgres-1 psql -U n2 -d n2 -At < $S/{value}.sql`. Parameters: {value} (e.g. q7, q8, q9; given by the asker).

## When to use

the next command is `docker exec -i n2-postgres-1 psql -U n2 -d n2 -At < $S/{value}.sql`

## Steps

1. Run `docker exec -i n2-postgres-1 psql -U n2 -d n2 -At < $S/{value}.sql`
   - Pitfall: `export PATH=$HOME/.orbstack/bin:$PATH && docker exec n2-postgres-1 pg_isready` failed

## Done when

- the last step (docker exec) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-exec-5f8253", outcome="success/failure")
