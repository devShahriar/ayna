---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd ~/tracewit/n2 && $TMPDIR/be killtest -tenant org_418dfae0d3bdc1ac -kind alert -rule {rule} -check testdata/killtest/host_alerted_again.check.json` → shell `echo \"exit=$?\" >> $TMPDIR/{value}.txt`. In the agents' own words: test. Parameters: {rule} (e.g. testdata/killtest/will_this_host_alert_again.rule.json, testdata/killtest/will_this_host_alert_again_recent.rule.json; given by the asker); {value} (e.g. killtest_host, killtest_recent, killtest_v3; given by the asker)."
---

# routine-be-killtest-echo-f7b7a3

Confidence: 0% (0 runs)


# Routine Be Killtest Echo F7b7a3

A routine agents here run again and again, learned from its repeated successful runs: `cd ~/tracewit/n2 && $TMPDIR/be killtest -tenant org_418dfae0d3bdc1ac -kind alert -rule {rule} -check testdata/killtest/host_alerted_again.check.json` → shell `echo "exit=$?" >> $TMPDIR/{value}.txt`. In the agents' own words: test. Parameters: {rule} (e.g. testdata/killtest/will_this_host_alert_again.rule.json, testdata/killtest/will_this_host_alert_again_recent.rule.json; given by the asker); {value} (e.g. killtest_host, killtest_recent, killtest_v3; given by the asker).

## When to use

the work is to test — or the next command is `cd ~/tracewit/n2 && $TMPDIR/be killtest -tenant org_418dfae0d3bdc1ac -kind alert -rule {rule} -check testdata/killtest/host_alerted_again.check.json`

## Steps

1. Run `cd ~/tracewit/n2 && $TMPDIR/be killtest -tenant org_418dfae0d3bdc1ac -kind alert -rule {rule} -check testdata/killtest/host_alerted_again.check.json`
2. shell `echo "exit=$?" >> $TMPDIR/{value}.txt`

## Done when

- the last step (echo) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-be-killtest-echo-f7b7a3", outcome="success/failure")
