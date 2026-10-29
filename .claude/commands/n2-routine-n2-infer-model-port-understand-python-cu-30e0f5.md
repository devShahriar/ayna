---
description: "A routine agents here run again and again, learned from its repeated successful runs: `N2_UNDERSTAND_MODEL=$HOME/tracewit/n2/models/n2-understand-current N2_INFER_MODEL=$HOME/tracewit/n2/models/laya-multilingual N2_INFER_PORT=8096 nohup $V/bin/python -I services/infer/server.py` → shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`. In the agents' own words: restart, model. Parameters: {number} (e.g. 60, 90, 30; given by the asker)."
---

# routine-n2-infer-model-port-understand-python-cu-30e0f5

Confidence: 0% (0 runs)


# Routine N2 Infer Model Port Understand Python Cu 30e0f5

A routine agents here run again and again, learned from its repeated successful runs: `N2_UNDERSTAND_MODEL=$HOME/tracewit/n2/models/n2-understand-current N2_INFER_MODEL=$HOME/tracewit/n2/models/laya-multilingual N2_INFER_PORT=8096 nohup $V/bin/python -I services/infer/server.py` → shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`. In the agents' own words: restart, model. Parameters: {number} (e.g. 60, 90, 30; given by the asker).

## When to use

the work is to restart, model — or the next command is `N2_UNDERSTAND_MODEL=$HOME/tracewit/n2/models/n2-understand-current N2_INFER_MODEL=$HOME/tracewit/n2/models/laya-multilingual N2_INFER_PORT=8096 nohup $V/bin/python -I services/infer/server.py`

## Steps

1. Run `N2_UNDERSTAND_MODEL=$HOME/tracewit/n2/models/n2-understand-current N2_INFER_MODEL=$HOME/tracewit/n2/models/laya-multilingual N2_INFER_PORT=8096 nohup $V/bin/python -I services/infer/server.py`
2. shell `for i in $(seq 1 {number}); do curl -s -m 2 localhost:8096/healthz >/dev/null && break; sleep 1; done`

## Done when

- the last step (loop[curl]) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-infer-model-port-understand-python-cu-30e0f5", outcome="success/failure")
