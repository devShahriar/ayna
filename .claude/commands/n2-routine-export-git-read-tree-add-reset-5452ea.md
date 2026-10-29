---
description: "A routine agents here run again and again, learned from its repeated successful runs: `export GIT_INDEX_FILE=$(mktemp -d)/idx` → `git read-tree HEAD` → `git add \"${P[@]}\"` → `unset GIT_INDEX_FILE && git reset -q -- \"${P[@]}\"`. In the agents' own words: index, fast, lane, path."
---

# routine-export-git-read-tree-add-reset-5452ea

Confidence: 0% (0 runs)


# Routine Export Git Read Tree Add Reset 5452ea

A routine agents here run again and again, learned from its repeated successful runs: `export GIT_INDEX_FILE=$(mktemp -d)/idx` → `git read-tree HEAD` → `git add "${P[@]}"` → `unset GIT_INDEX_FILE && git reset -q -- "${P[@]}"`. In the agents' own words: index, fast, lane, path.

## When to use

the work is to index, fast, lane, path — or the next command is `export GIT_INDEX_FILE=$(mktemp -d)/idx`

## Steps

1. Run `export GIT_INDEX_FILE=$(mktemp -d)/idx`
2. Run `git read-tree HEAD`
3. Run `git add "${P[@]}"`
4. Run `unset GIT_INDEX_FILE && git reset -q -- "${P[@]}"`

## Done when

- the last step (git reset) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-export-git-read-tree-add-reset-5452ea", outcome="success/failure")
