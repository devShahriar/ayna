---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && git merge --no-edit {no_edit}` → `cd {path_2} && export PATH=$HOME/.orbstack/bin:$PATH && go build ./...`. In the agents' own words: merge, merged. Parameters: {no_edit} (e.g. wire-refill, wire-capture, wire-distill; given by the asker); {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/n37final; given by the asker); {path_2} (e.g. ~/tracewit/n2-wt/integration, ~/tracewit/n2-wt/final, ~/tracewit/n2-wt/n37final; given by the asker)."
---

# routine-git-merge-go-build-dcb4d9

Confidence: 0% (0 runs)


# Routine Git Merge Go Build Dcb4d9

A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && git merge --no-edit {no_edit}` → `cd {path_2} && export PATH=$HOME/.orbstack/bin:$PATH && go build ./...`. In the agents' own words: merge, merged. Parameters: {no_edit} (e.g. wire-refill, wire-capture, wire-distill; given by the asker); {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/n37final; given by the asker); {path_2} (e.g. ~/tracewit/n2-wt/integration, ~/tracewit/n2-wt/final, ~/tracewit/n2-wt/n37final; given by the asker).

## When to use

the work is to merge, merged — or the next command is `cd {path} && git merge --no-edit {no_edit}`

## Steps

1. Run `cd {path} && git merge --no-edit {no_edit}`
2. Run `cd {path_2} && export PATH=$HOME/.orbstack/bin:$PATH && go build ./...`

## Done when

- the last step (go build) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-git-merge-go-build-dcb4d9", outcome="success/failure")
