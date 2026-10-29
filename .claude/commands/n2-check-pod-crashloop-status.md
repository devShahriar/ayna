---
description: "Investigate pods in CrashLoopBackOff on a specific Kubernetes service by reading their status, recent restart count, exit codes, and the last 200 lines of logs from the most recently restarted container. Use this skill whenever a service is reported as unhealthy with pod restart loops, CrashLoopBackOff events, or rapidly-incrementing restart counts — it reports which pods are affected, why they're crashing, and recommends the correct escalation without attempting auto-remediation."
---

# check-pod-crashloop-status

Confidence: 0% (0 runs)


# Check pod crashloop status on a Kubernetes service

## When to use this skill

Use this whenever you see any of the following:

- A service reported as unhealthy with pod restart loops
- `CrashLoopBackOff` status mentioned in an alert or incident description
- Restart counts climbing rapidly (e.g. a pod restart count > 10 within an hour)
- A PagerDuty or Grafana alert referencing pod health on a named Kubernetes service

**Do NOT use this skill** if the reported symptom is latency, error rate,
or a logical failure at the application layer without pod-level restart
signals — that's a different diagnostic path.

## Context to gather before deciding

1. **The affected service and namespace.** Call
   `get_entity(service:<name>)` to read the entity page. Look for the
   `infrastructure` section — it will tell you which namespace the pods
   live in, how many replicas are expected, and the current restart count
   distribution.

2. **Recent pod events.** Call `get_timeline(service:<name>, limit=100)`
   and filter for events of type `oom`, `pod_restart`, `crashloop_detected`,
   or `image_pull_backoff`. The clustering of these events in time tells
   you whether this is a single-pod glitch or a cluster-wide symptom.

3. **Recent errors.** Call `get_errors(service:<name>)` and inspect
   `error_nodes` and `recent_errors` — if the crashloop correlates with
   application-level errors, the root cause is in the application, not
   the infrastructure.

## How to check the pods with kubectl

Use the bundled `tool:kubectl` reference (loaded alongside this skill)
for full arguments, installation, and safety notes. The short form:

### Step 1 — list the pods

```
kubectl get pods -n <namespace> -l app=<service-name>
```

Look at the `STATUS` column. Any `CrashLoopBackOff`, `Error`,
`ImagePullBackOff`, or `OOMKilled` is relevant. The `RESTARTS` column
with an `(<N>s ago)` suffix tells you how recent the last restart was.

### Step 2 — describe one crashing pod

```
kubectl describe pod <pod-name> -n <namespace>
```

In the output, read the `Events:` section at the bottom — it contains the
actual reason for the last restart. Common values:

- `Back-off restarting failed container` — the container keeps exiting
- `OOMKilled` — out-of-memory killed, last exit code 137
- `Error` with exit code 1 — application crash at startup
- `Liveness probe failed` — healthcheck not responding
- `ImagePullBackOff` — image doesn't exist or registry auth broken

### Step 3 — fetch the logs of the last container

```
kubectl logs <pod-name> -n <namespace> --previous --tail 200
```

The `--previous` flag pulls logs from the **prior** container instance
(the one that crashed), not the one currently starting up. This is the
only way to see startup errors on a crashing pod.

## Diagnosis decision tree

After gathering the context above, match the symptoms to one of these:

### Pattern A — Application crash at startup

**Signals:** exit code 1, logs show an uncaught exception, stack trace,
or missing configuration.

**Root cause:** code-level bug, bad config, or missing environment variable.

**Do NOT restart the pod** — it will immediately crash again. The only
fix is a code change, config fix, or configmap update.

**Escalate to:** the service's owning backend team.

### Pattern B — OOMKilled

**Signals:** exit code 137, `OOMKilled` in the pod events, memory limit
hit. Often correlates with recent traffic spike or memory leak.

**Root cause:** memory limit too low OR actual memory leak in the
application.

**Short-term mitigation:** raise the memory limit in the deployment's
resource spec and `kubectl rollout restart` the deployment — this is
destructive and requires human approval.

**Real fix:** investigate the memory leak or right-size the limit based
on observed usage. Needs a human.

**Escalate to:** SRE team for immediate limit adjustment, backend team
for root cause.

### Pattern C — ImagePullBackOff

**Signals:** `ImagePullBackOff` or `ErrImagePull` in events. Recent
deploy visible in the timeline.

**Root cause:** the deploy referenced an image tag that doesn't exist in
the registry, OR registry auth is broken.

**Fix:** `kubectl rollout undo deployment/<name>` to roll back to the
previous working image. Destructive, requires human approval.

**Escalate to:** whoever authored the failing deploy (check the timeline
for the deploy event and its author).

### Pattern D — Liveness probe failed

**Signals:** "Liveness probe failed" in events. Application may be
running but the health endpoint is unresponsive.

**Root cause:** the app is stuck (deadlock, slow GC, blocking call on
startup), OR the probe timeout is too aggressive.

**Check:** look at the `liveness probe` definition in the deployment. If
the timeout is 1s, it's probably too tight — raise it. If the probe is
reasonable, the app genuinely hung and needs investigation.

**Escalate to:** backend team.

### None of the above

If none of the four patterns fit, the situation is outside this skill's
known cases. Return a written summary of what you found and recommend
human triage with the full `kubectl describe` output attached.

## Known failure modes of this skill

- **Multi-container pods** — this skill assumes one primary container per
  pod. If the pod has sidecars (envoy, istio-proxy, fluentd), `kubectl
  logs` without `-c <container>` will pick an arbitrary one. Add
  `-c <main-container-name>` when needed.
- **Namespace discovery** — if the service's entity page doesn't list the
  namespace, fall back to `kubectl get pods -A | grep <service-name>` —
  this is slow on large clusters so prefer the entity page.
- **Cluster context** — this skill does not handle multi-cluster routing.
  If the service runs in more than one cluster, the caller must specify
  which cluster's context to use, either via a `--context <name>` flag on
  kubectl or by switching contexts before invoking the skill.

## Why this skill does not auto-remediate

CrashLoopBackOff is almost always a symptom of something the brain
cannot safely fix alone: a bug, a bad config, a missing image, a memory
leak. Applying a knee-jerk fix (restart, rollback, scale) without
understanding which pattern is occurring can make things worse — for
example, restarting a pod that crashes on startup just resets the
backoff timer without changing anything. This skill diagnoses; a human
or a separate mutating playbook skill decides the fix.

## Evidence

This skill is hand-written as a first-pass procedural diagnostic. It has
no run history yet. Once executed against real incidents, runs will
accumulate in the graph and the induction framework will tune the
confidence score based on success rate.

---
After executing: record_skill_run(skill_name="check-pod-crashloop-status", outcome="success/failure")
