---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd /tmp && S={path} && cd $S/skills/_n2 && $S/cartvenv/bin/python eval_capture.py $S/skills/{value}.jsonl $S/skills/{value_2}.json`. Parameters: {value} (e.g. _cap_proto, _cap_all; given by the asker); {value_2} (e.g. _eval_proto, _eval_all; given by the asker); {path} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker)."
---

# routine-python-423522

Confidence: 0% (0 runs)


# Routine Python 423522

A routine agents here run again and again, learned from its repeated successful runs: `cd /tmp && S={path} && cd $S/skills/_n2 && $S/cartvenv/bin/python eval_capture.py $S/skills/{value}.jsonl $S/skills/{value_2}.json`. Parameters: {value} (e.g. _cap_proto, _cap_all; given by the asker); {value_2} (e.g. _eval_proto, _eval_all; given by the asker); {path} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker).

## When to use

the next command is `cd /tmp && S={path} && cd $S/skills/_n2 && $S/cartvenv/bin/python eval_capture.py $S/skills/{value}.jsonl $S/skills/{value_2}.json`

## Steps

1. Run `cd /tmp && S={path} && cd $S/skills/_n2 && $S/cartvenv/bin/python eval_capture.py $S/skills/{value}.jsonl $S/skills/{value_2}.json`

## Done when

- the last step (python) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-python-423522", outcome="success/failure")
