---
description: "A routine agents here run again and again, learned from its repeated successful runs: `SP={sp} && cd $SP/link/laya && nice -n 10 $SP/n33venv/bin/python laya_rulepick.py ../live_raw.jsonl ../live/live_test.jsonl rulepick_live.json` → `python3 -I link_live.py $S/live_raw.jsonl ~/Tekton/kormo/backend/internal/correlate/rules_aws.go $S/live`. In the agents' own words: rule, laya, model, pick. Parameters: {sp} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker)."
---

# routine-10-python3-639e29

Confidence: 0% (0 runs)


# Routine 10 Python3 639e29

A routine agents here run again and again, learned from its repeated successful runs: `SP={sp} && cd $SP/link/laya && nice -n 10 $SP/n33venv/bin/python laya_rulepick.py ../live_raw.jsonl ../live/live_test.jsonl rulepick_live.json` → `python3 -I link_live.py $S/live_raw.jsonl ~/Tekton/kormo/backend/internal/correlate/rules_aws.go $S/live`. In the agents' own words: rule, laya, model, pick. Parameters: {sp} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker).

## When to use

the work is to rule, laya, model, pick — or the next command is `SP={sp} && cd $SP/link/laya && nice -n 10 $SP/n33venv/bin/python laya_rulepick.py ../live_raw.jsonl ../live/live_test.jsonl rulepick_live.json`

## Steps

1. Run `SP={sp} && cd $SP/link/laya && nice -n 10 $SP/n33venv/bin/python laya_rulepick.py ../live_raw.jsonl ../live/live_test.jsonl rulepick_live.json`
2. Run `python3 -I link_live.py $S/live_raw.jsonl ~/Tekton/kormo/backend/internal/correlate/rules_aws.go $S/live`

## Done when

- the last step (python3) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-10-python3-639e29", outcome="success/failure")
