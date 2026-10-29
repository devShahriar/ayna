---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd ~/tracewit/n2 && scripts/understand/remote.sh {value}.compute-1.amazonaws.com {path} --full --epochs 2` → shell `echo \"exit=$?\" >> $L`. In the agents' own words: train, fixed, judged, training. Parameters: {value} (e.g. ec2-44-197-131-208, ec2-184-195-158-39; given by the asker); {path} (e.g. ~/Tekton/n2.pem n2-understand-xsmall-v3 n2-understand-xsmall-v5, ~/Tekton/n2.pem n2-understand-xsmall-v5 n2-understand-xsmall-v6, ~/Tekton/n2.pem n2-understand-xsmall-v5 n2-understand-xsmall-v6b; given by the asker)."
---

# routine-remote-sh-echo-0591f4

Confidence: 0% (0 runs)


# Routine Remote Sh Echo 0591f4

A routine agents here run again and again, learned from its repeated successful runs: `cd ~/tracewit/n2 && scripts/understand/remote.sh {value}.compute-1.amazonaws.com {path} --full --epochs 2` → shell `echo "exit=$?" >> $L`. In the agents' own words: train, fixed, judged, training. Parameters: {value} (e.g. ec2-44-197-131-208, ec2-184-195-158-39; given by the asker); {path} (e.g. ~/Tekton/n2.pem n2-understand-xsmall-v3 n2-understand-xsmall-v5, ~/Tekton/n2.pem n2-understand-xsmall-v5 n2-understand-xsmall-v6, ~/Tekton/n2.pem n2-understand-xsmall-v5 n2-understand-xsmall-v6b; given by the asker).

## When to use

the work is to train, fixed, judged, training — or the next command is `cd ~/tracewit/n2 && scripts/understand/remote.sh {value}.compute-1.amazonaws.com {path} --full --epochs 2`

## Steps

1. Run `cd ~/tracewit/n2 && scripts/understand/remote.sh {value}.compute-1.amazonaws.com {path} --full --epochs 2`
2. shell `echo "exit=$?" >> $L`

## Done when

- the last step (echo) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-remote-sh-echo-0591f4", outcome="success/failure")
