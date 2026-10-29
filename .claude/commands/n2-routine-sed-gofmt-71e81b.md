---
description: "A routine agents here run again and again, learned from its repeated successful runs: shell `cd {path} && sed -i '' {path_2}` → `gofmt -l {path_3}`. In the agents' own words: test. Parameters: {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/next, ~/tracewit/n2-wt/onedecider; given by the asker); {path_2} (e.g. 's/0xde9059c16ef19eb8+i)/0x5e9059c16ef19eb8+i)/' internal/meaning/arrive_pg_test.go, 's/^\\t\"log\\/slog\"\\n\\t\"strings\"/&/' internal/store/postgres/graph.go, 's/decision.ModeAnswered/decision.ModeDerived/' internal/decidenet/decidenet_test.go; given by the asker); {path_3} (e.g. internal/contextgraph, api/http/, internal/skilllearn; given by the asker)."
---

# routine-sed-gofmt-71e81b

Confidence: 0% (0 runs)


# Routine Sed Gofmt 71e81b

A routine agents here run again and again, learned from its repeated successful runs: shell `cd {path} && sed -i '' {path_2}` → `gofmt -l {path_3}`. In the agents' own words: test. Parameters: {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/next, ~/tracewit/n2-wt/onedecider; given by the asker); {path_2} (e.g. 's/0xde9059c16ef19eb8+i)/0x5e9059c16ef19eb8+i)/' internal/meaning/arrive_pg_test.go, 's/^\t"log\/slog"\n\t"strings"/&/' internal/store/postgres/graph.go, 's/decision.ModeAnswered/decision.ModeDerived/' internal/decidenet/decidenet_test.go; given by the asker); {path_3} (e.g. internal/contextgraph, api/http/, internal/skilllearn; given by the asker).

## When to use

the work is to test — or the next command is shell `cd {path} && sed -i '' {path_2}`

## Steps

1. shell `cd {path} && sed -i '' {path_2}`
2. Run `gofmt -l {path_3}`

## Done when

- the last step (gofmt) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-sed-gofmt-71e81b", outcome="success/failure")
