---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd $SP && uv venv -q --python 3.11 {value}` → `VIRTUAL_ENV=$SP/qwenv uv pip install -q torch transformers numpy psycopg2-binary`. In the agents' own words: install, torch, transformers, venv. Parameters: {value} (e.g. qwenv, uenv; given by the asker)."
---

# routine-uv-venv-virtual-env-pip-install-e851be

Confidence: 0% (0 runs)


# Routine Uv Venv Virtual Env Pip Install E851be

A routine agents here run again and again, learned from its repeated successful runs: `cd $SP && uv venv -q --python 3.11 {value}` → `VIRTUAL_ENV=$SP/qwenv uv pip install -q torch transformers numpy psycopg2-binary`. In the agents' own words: install, torch, transformers, venv. Parameters: {value} (e.g. qwenv, uenv; given by the asker).

## When to use

the work is to install, torch, transformers, venv — or the next command is `cd $SP && uv venv -q --python 3.11 {value}`

## Steps

1. Run `cd $SP && uv venv -q --python 3.11 {value}`
2. Run `VIRTUAL_ENV=$SP/qwenv uv pip install -q torch transformers numpy psycopg2-binary`
   - Pitfall: `VIRTUAL_ENV=$S/decvenv uv pip install --offline -q torch==2.8.0 transformers==4.57.6 safetensors==0.6.2 numpy==2.0.2 tokenizers` failed: Exit code 1

## Done when

- the last step (VIRTUAL_ENV= uv pip install) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-uv-venv-virtual-env-pip-install-e851be", outcome="success/failure")
