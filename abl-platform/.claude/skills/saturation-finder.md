---
name: saturation-finder
description: Find per-pod saturation point — max msg/sec at a given p95 target. Delegates execution to saturation-runner.sh; LLM only collects inputs, displays scorecard, and analyzes results.
---

# Saturation Finder

This skill is defined in `.claude/commands/saturation-finder.md`. Use the
`/saturation-finder` slash command to invoke it.

The skill follows 6 deterministic phases:

1. **Collect** — ask user for inputs (VU steps, p95 target, replicas, env)
2. **Prepare** — pin replicas via deploy repo
3. **Execute** — launch `saturation-runner.sh` in background (single invocation)
4. **Monitor** — read status.json every 45s, print scorecard rows (display only, no decisions)
5. **Revert** — restore deploy repo to user defaults
6. **Analyze** — query k6 API + Coroot, compute efficiency/bottleneck/predictions, generate report

**Key principle:** `saturation-runner.sh` handles ALL execution (k6 launch, cluster
polling, early-stop monitoring, cleanup). Claude never runs kubectl during the test,
never makes PROCEED/STOP decisions, and never launches k6 directly.
