---
description: "A routine agents here run again and again, learned from its repeated successful runs: `SP={sp} && N2_ROUTINE_PROBE_FILE=$SP/live_events.jsonl N2_ROUTINE_PROBE_OUT=$SP/{value}.txt go test -run TestProbe_RoutinesFromAnExport -count=1 ./internal/skilllearn/`. In the agents' own words: probe, rerun. Parameters: {value} (e.g. probe2, probe3, probe4; given by the asker); {sp} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad/routines; given by the asker)."
---

# routine-n2-routine-probe-file-out-go-test-fbfd3f

Confidence: 0% (0 runs)


# Routine N2 Routine Probe File Out Go Test Fbfd3f

A routine agents here run again and again, learned from its repeated successful runs: `SP={sp} && N2_ROUTINE_PROBE_FILE=$SP/live_events.jsonl N2_ROUTINE_PROBE_OUT=$SP/{value}.txt go test -run TestProbe_RoutinesFromAnExport -count=1 ./internal/skilllearn/`. In the agents' own words: probe, rerun. Parameters: {value} (e.g. probe2, probe3, probe4; given by the asker); {sp} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad/routines; given by the asker).

## When to use

the work is to probe, rerun — or the next command is `SP={sp} && N2_ROUTINE_PROBE_FILE=$SP/live_events.jsonl N2_ROUTINE_PROBE_OUT=$SP/{value}.txt go test -run TestProbe_RoutinesFromAnExport -count=1 ./internal/skilllearn/`

## Steps

1. Run `SP={sp} && N2_ROUTINE_PROBE_FILE=$SP/live_events.jsonl N2_ROUTINE_PROBE_OUT=$SP/{value}.txt go test -run TestProbe_RoutinesFromAnExport -count=1 ./internal/skilllearn/`

## Done when

- the last step (N2_ROUTINE_PROBE_FILE= N2_ROUTINE_PROBE_OUT= go test) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-routine-probe-file-out-go-test-fbfd3f", outcome="success/failure")
