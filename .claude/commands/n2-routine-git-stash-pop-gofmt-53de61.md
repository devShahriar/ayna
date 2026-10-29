---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && git stash -q` → `git stash pop -q` → `gofmt {value} {path_2}`. In the agents' own words: confirm, test, gofmt. Parameters: {path} (e.g. ~/tracewit/n2-wt-d-gate, ~/tracewit/n2-wt-c-skills, ~/tracewit/n2-wt-a-labels; given by the asker); {path_2} (e.g. worker/ cmd/ internal/ model/, internal/joinlearn, api/http/sessions.go pkg/step; given by the asker); {value} (e.g. -l, -w; given by the asker)."
---

# routine-git-stash-pop-gofmt-53de61

Confidence: 0% (0 runs)


# Routine Git Stash Pop Gofmt 53de61

A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && git stash -q` → `git stash pop -q` → `gofmt {value} {path_2}`. In the agents' own words: confirm, test, gofmt. Parameters: {path} (e.g. ~/tracewit/n2-wt-d-gate, ~/tracewit/n2-wt-c-skills, ~/tracewit/n2-wt-a-labels; given by the asker); {path_2} (e.g. worker/ cmd/ internal/ model/, internal/joinlearn, api/http/sessions.go pkg/step; given by the asker); {value} (e.g. -l, -w; given by the asker).

## When to use

the work is to confirm, test, gofmt — or the next command is `cd {path} && git stash -q`

## Steps

1. Run `cd {path} && git stash -q`
2. Run `git stash pop -q`
3. Run `gofmt {value} {path_2}`

## Done when

- the last step (gofmt) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-git-stash-pop-gofmt-53de61", outcome="success/failure")
