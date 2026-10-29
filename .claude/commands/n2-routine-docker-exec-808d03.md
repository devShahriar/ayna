---
description: "A routine agents here run again and again, learned from its repeated successful runs: `for i in $(seq 1 {number_2}); do f=$(docker exec n2-postgres-1 psql -U n2 -d n2 -At -c \"SELECT finished_at IS NOT NULL FROM concept_learn_runs WHERE tenant_id='{value}'\" 2>/dev/null | tail -1); [ \"$f\" = \"t\" ] && break; sleep {number}; done`. Parameters: {number} (e.g. 10, 5; given by the asker); {number_2} (e.g. 80, 120; given by the asker); {value} (e.g. default, sbx_0c6a036682642181; given by the asker)."
---

# routine-docker-exec-808d03

Confidence: 0% (0 runs)


# Routine Docker Exec 808d03

A routine agents here run again and again, learned from its repeated successful runs: `for i in $(seq 1 {number_2}); do f=$(docker exec n2-postgres-1 psql -U n2 -d n2 -At -c "SELECT finished_at IS NOT NULL FROM concept_learn_runs WHERE tenant_id='{value}'" 2>/dev/null | tail -1); [ "$f" = "t" ] && break; sleep {number}; done`. Parameters: {number} (e.g. 10, 5; given by the asker); {number_2} (e.g. 80, 120; given by the asker); {value} (e.g. default, sbx_0c6a036682642181; given by the asker).

## When to use

the next command is `for i in $(seq 1 {number_2}); do f=$(docker exec n2-postgres-1 psql -U n2 -d n2 -At -c "SELECT finished_at IS NOT NULL FROM concept_learn_runs WHERE tenant_id='{value}'" 2>/dev/null | tail -1); [ "$f" = "t" ] && break; sleep {number}; done`

## Steps

1. Run `for i in $(seq 1 {number_2}); do f=$(docker exec n2-postgres-1 psql -U n2 -d n2 -At -c "SELECT finished_at IS NOT NULL FROM concept_learn_runs WHERE tenant_id='{value}'" 2>/dev/null | tail -1); [ "$f" = "t" ] && break; sleep {number}; done`

## Done when

- the last step (loop[docker exec]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-docker-exec-808d03", outcome="success/failure")
