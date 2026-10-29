---
description: "A routine agents here run again and again, learned from its repeated successful runs: `psql \"postgres://n2:n2@localhost:{localhost}/{value_2}?sslmode=disable\" -X -q -f $S/{value}.sql`. In the agents' own words: explain. Parameters: {value} (e.g. live_stats, live_explain_new, explain_qa; given by the asker); {localhost} (e.g. 5433, 5434; given by the asker); {value_2} (e.g. n2, n2_healthfix_test; given by the asker)."
---

# routine-psql-15fbbe

Confidence: 0% (0 runs)


# Routine Psql 15fbbe

A routine agents here run again and again, learned from its repeated successful runs: `psql "postgres://n2:n2@localhost:{localhost}/{value_2}?sslmode=disable" -X -q -f $S/{value}.sql`. In the agents' own words: explain. Parameters: {value} (e.g. live_stats, live_explain_new, explain_qa; given by the asker); {localhost} (e.g. 5433, 5434; given by the asker); {value_2} (e.g. n2, n2_healthfix_test; given by the asker).

## When to use

the work is to explain — or the next command is `psql "postgres://n2:n2@localhost:{localhost}/{value_2}?sslmode=disable" -X -q -f $S/{value}.sql`

## Steps

1. Run `psql "postgres://n2:n2@localhost:{localhost}/{value_2}?sslmode=disable" -X -q -f $S/{value}.sql`

## Done when

- the last step (psql) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-psql-15fbbe", outcome="success/failure")
