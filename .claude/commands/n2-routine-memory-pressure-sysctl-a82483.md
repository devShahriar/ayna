---
description: "A routine agents here run again and again, learned from its repeated successful runs: `memory_pressure` → `sysctl vm.swapusage`. In the agents' own words: measure, memory."
---

# routine-memory-pressure-sysctl-a82483

Confidence: 0% (0 runs)


# Routine Memory Pressure Sysctl A82483

A routine agents here run again and again, learned from its repeated successful runs: `memory_pressure` → `sysctl vm.swapusage`. In the agents' own words: measure, memory.

## When to use

the work is to measure, memory — or the next command is `memory_pressure`

## Steps

1. Run `memory_pressure`
2. Run `sysctl vm.swapusage`

## Done when

- the last step (sysctl) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-memory-pressure-sysctl-a82483", outcome="success/failure")
