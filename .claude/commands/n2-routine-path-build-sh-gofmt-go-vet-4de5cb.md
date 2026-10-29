---
description: "A routine agents here run again and again, learned from its repeated successful runs: `S={path_4} && cd /tmp && PATH=$HOME/.orbstack/bin:$PATH ~/tracewit/n2/services/skillhost/build.sh ~/Tekton/cartography $S/cartvenv/bin/python n2-skillhost:77ebd5c` → `gofmt -w {path}` → `go build -o {path_2}` → `go vet {path_3}`. In the agents' own words: image, rebuild, sandbox, transform. Parameters: {path} (e.g. cmd/skillrun-replay, internal/skillrun cmd/skill-redraft; given by the asker); {path_2} (e.g. /tmp/skillrun-replay2 ./cmd/skillrun-replay, /tmp/skill-redraft ./cmd/skill-redraft; given by the asker); {path_3} (e.g. ./internal/skillrun, ./cmd/skillrun-replay, ./cmd/skill-redraft; given by the asker); {path_4} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker)."
---

# routine-path-build-sh-gofmt-go-vet-4de5cb

Confidence: 0% (0 runs)


# Routine Path Build Sh Gofmt Go Vet 4de5cb

A routine agents here run again and again, learned from its repeated successful runs: `S={path_4} && cd /tmp && PATH=$HOME/.orbstack/bin:$PATH ~/tracewit/n2/services/skillhost/build.sh ~/Tekton/cartography $S/cartvenv/bin/python n2-skillhost:77ebd5c` → `gofmt -w {path}` → `go build -o {path_2}` → `go vet {path_3}`. In the agents' own words: image, rebuild, sandbox, transform. Parameters: {path} (e.g. cmd/skillrun-replay, internal/skillrun cmd/skill-redraft; given by the asker); {path_2} (e.g. /tmp/skillrun-replay2 ./cmd/skillrun-replay, /tmp/skill-redraft ./cmd/skill-redraft; given by the asker); {path_3} (e.g. ./internal/skillrun, ./cmd/skillrun-replay, ./cmd/skill-redraft; given by the asker); {path_4} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker).

## When to use

the work is to image, rebuild, sandbox, transform — or the next command is `S={path_4} && cd /tmp && PATH=$HOME/.orbstack/bin:$PATH ~/tracewit/n2/services/skillhost/build.sh ~/Tekton/cartography $S/cartvenv/bin/python n2-skillhost:77ebd5c`

## Steps

1. Run `S={path_4} && cd /tmp && PATH=$HOME/.orbstack/bin:$PATH ~/tracewit/n2/services/skillhost/build.sh ~/Tekton/cartography $S/cartvenv/bin/python n2-skillhost:77ebd5c`
2. Run `gofmt -w {path}`
3. Run `go build -o {path_2}`
4. Run `go vet {path_3}`

## Done when

- the last step (go vet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-path-build-sh-gofmt-go-vet-4de5cb", outcome="success/failure")
