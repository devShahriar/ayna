---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && git rm {value} {path}` → `go vet {path_3}`. In the agents' own words: test. Parameters: {path} (e.g. internal/fieldconcept/dryrun_cache.go internal/fieldconcept/dryrun_cache_pg_test.go, internal/induction/procedure_miner.go internal/induction/procedure_miner_probe_test.go internal/induction/procedure_miner_tenant_pg_test.go internal/induction/procedure_miner_test.go, cmd/opensearch-worker worker/ossource; given by the asker); {path_2} (e.g. ~/tracewit/n2, ~/Tekton/kormo-gateway; given by the asker); {value} (e.g. -q, -rq; given by the asker); {path_3} (e.g. ./internal/fieldconcept, ./connectorops/ ./worker/specpoll/ ./internal/api/, ./internal/induction/; given by the asker)."
---

# routine-git-rm-go-vet-997264

Confidence: 0% (0 runs)


# Routine Git Rm Go Vet 997264

A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && git rm {value} {path}` → `go vet {path_3}`. In the agents' own words: test. Parameters: {path} (e.g. internal/fieldconcept/dryrun_cache.go internal/fieldconcept/dryrun_cache_pg_test.go, internal/induction/procedure_miner.go internal/induction/procedure_miner_probe_test.go internal/induction/procedure_miner_tenant_pg_test.go internal/induction/procedure_miner_test.go, cmd/opensearch-worker worker/ossource; given by the asker); {path_2} (e.g. ~/tracewit/n2, ~/Tekton/kormo-gateway; given by the asker); {value} (e.g. -q, -rq; given by the asker); {path_3} (e.g. ./internal/fieldconcept, ./connectorops/ ./worker/specpoll/ ./internal/api/, ./internal/induction/; given by the asker).

## When to use

the work is to test — or the next command is `cd {path_2} && git rm {value} {path}`

## Steps

1. Run `cd {path_2} && git rm {value} {path}`
2. Run `go vet {path_3}`

## Done when

- the last step (go vet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-git-rm-go-vet-997264", outcome="success/failure")
