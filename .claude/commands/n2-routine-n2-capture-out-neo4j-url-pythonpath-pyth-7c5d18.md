---
description: "A routine agents here run again and again, learned from its repeated successful runs: `S={path} && cd ~/Tekton/cartography && NEO4J_URL=bolt://n2-capture N2_CAPTURE_OUT=$S/skills/{value}.jsonl PYTHONPATH=$S/skills/_n2 timeout 1500 $S/cartvenv/bin/python -m pytest -p capture_plugin -q --no-header -p no:cacheprovider tests/integration/cartography/intel`. Parameters: {value} (e.g. _cap_all, _cap_caller, _cap_ds; given by the asker); {path} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker)."
---

# routine-n2-capture-out-neo4j-url-pythonpath-pyth-7c5d18

Confidence: 0% (0 runs)


# Routine N2 Capture Out Neo4j Url Pythonpath Pyth 7c5d18

A routine agents here run again and again, learned from its repeated successful runs: `S={path} && cd ~/Tekton/cartography && NEO4J_URL=bolt://n2-capture N2_CAPTURE_OUT=$S/skills/{value}.jsonl PYTHONPATH=$S/skills/_n2 timeout 1500 $S/cartvenv/bin/python -m pytest -p capture_plugin -q --no-header -p no:cacheprovider tests/integration/cartography/intel`. Parameters: {value} (e.g. _cap_all, _cap_caller, _cap_ds; given by the asker); {path} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker).

## When to use

the next command is `S={path} && cd ~/Tekton/cartography && NEO4J_URL=bolt://n2-capture N2_CAPTURE_OUT=$S/skills/{value}.jsonl PYTHONPATH=$S/skills/_n2 timeout 1500 $S/cartvenv/bin/python -m pytest -p capture_plugin -q --no-header -p no:cacheprovider tests/integration/cartography/intel`

## Steps

1. Run `S={path} && cd ~/Tekton/cartography && NEO4J_URL=bolt://n2-capture N2_CAPTURE_OUT=$S/skills/{value}.jsonl PYTHONPATH=$S/skills/_n2 timeout 1500 $S/cartvenv/bin/python -m pytest -p capture_plugin -q --no-header -p no:cacheprovider tests/integration/cartography/intel`

## Done when

- the last step (N2_CAPTURE_OUT= NEO4J_URL= PYTHONPATH= python) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-capture-out-neo4j-url-pythonpath-pyth-7c5d18", outcome="success/failure")
