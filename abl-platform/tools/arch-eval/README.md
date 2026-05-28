# Arch-AI Eval Harness

Headless harness that drives the Arch AI ONBOARDING and IN_PROJECT flows
through Studio's existing `/api/arch-ai/*` HTTP+SSE routes (the same path the
browser and `kore-platform-cli` use). Captures every SSE event, the final
project, agent ABL, compile diagnostics, health report, and project summary,
then scores quality across multiple axes.

## Files

| File                     | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `scenarios.ts`           | 10 diverse scenario definitions (domains, channels, complexity)    |
| `auto-reply.ts`          | Auto-reply policy for ask_user / collect_file widgets              |
| `run-scenario.ts`        | Single-scenario runner — captures events + artifacts               |
| `index.ts`               | Orchestrator — loops scenarios, refreshes auth between runs        |
| `score-projects.ts`      | Post-run quality scoring (5 axes), writes scoring.md + findings.md |
| `in-project-playbook.ts` | IN_PROJECT modification scenarios + reasoning-quality scoring      |

## Prereqs

- Studio running at `http://localhost:5173` with `/api/auth/dev-login` enabled
- Workspace-level Arch model configured via `PUT /api/arch/config` (use one of
  the OpenAI 5.2-family or Claude models — set as `provider`+`modelId`)
- Tenant-member record for `test@example.com` (created on first dev-login)

## Run an evaluation

```bash
# All 10 scenarios (~25-35 min wall-clock)
pnpm exec tsx tools/arch-eval/index.ts

# Subset
pnpm exec tsx tools/arch-eval/index.ts --only s01-bookstore-support,s05-restaurant-reservation

# Limit to first N scenarios
pnpm exec tsx tools/arch-eval/index.ts --max 3

# Override studio URL / email / output
pnpm exec tsx tools/arch-eval/index.ts \
  --studio http://localhost:5173 \
  --email test@example.com \
  --run-id my-run \
  --output-root docs/testing/arch-eval/my-run
```

After the run completes, score it:

```bash
pnpm exec tsx tools/arch-eval/score-projects.ts docs/testing/arch-eval/<run-id>
```

Then run the IN_PROJECT modification playbook on best/median/worst:

```bash
pnpm exec tsx tools/arch-eval/in-project-playbook.ts \
  --run-dir docs/testing/arch-eval/<run-id> \
  --pick all
```

## Output structure

```
docs/testing/arch-eval/<run-id>/
  scenarios.json                    # The 10 scenarios used
  summary.json                      # Per-scenario RunResult array
  summary.md                        # Human-readable scoreboard
  scoring.json                      # 5-axis scoring (after score-projects)
  scoring.md                        # Scored leaderboard
  findings.md                       # Issues clustered across scenarios
  s01-bookstore-support/
    events.ndjson                   # Every SSE event in order
    final.json                      # Status, timings, tool counts
    session.json                    # Final session metadata snapshot
    topology.json                   # Locked topology (agents+edges+entryPoint)
    project.json                    # Full project document
    agents.json                     # All ProjectAgent docs (with dslContent)
    abl/<AgentName>.abl             # Per-agent ABL DSL
    compile/<AgentName>.json        # dslDiagnostics + warnings/errors
    summary.json                    # /api/arch-ai/project-summary response
    health.json                     # /api/arch-ai/project-health response
    errors.json                     # Stage-tagged error log
  s02-retail-banking/...
  ...
  in-project/                       # Created by in-project-playbook
    in-project-summary.json
    in-project-summary.md
    s01-bookstore-support/
      context_read/{events.ndjson, turn.json}
      propose_only/...
      tool_add/...
      fix_warning/...
      handoff_edit/...
      health_recheck/...
```

## Scoring axes (0–5 each)

- **topology_quality** — entryPoint set (+2), agent count within ±1 of expected (+1),
  edges present (+1), expectReturn semantics used (+1).
- **abl_structure** — per-agent average across {FLOW or GATHER, TOOLS, HANDOFF or
  COMPLETE, catch-all WHEN: true, no static analyzer warnings}.
- **compile_health** — `5 × passing/total + 2.5 × warnings/total − 5 × errors/total`,
  clamped to [0, 5].
- **spec_fidelity** — half on agents mentioning the requested channels, half on
  agents matching capability keywords (length > 4) from the seed message.
- **diagnostic_signal** — 5 if `topIssue` references a concrete construct (agent /
  step / tool / gather / handoff / zone), 3 if generic, 0 if missing.

Heuristic. Use the per-agent breakdowns and cluster findings rollup for real
conclusions.

## In-Project playbook turns

Each playbook turn carries a rubric for what the architect SHOULD do; the
heuristic reasoning score (0–5) is bumped/penalized based on:

- correct tool calls (`platform_context`, `diagnose_project`, `health_check`,
  `propose_modification`)
- whether `propose_modification` fired when expected
- whether `apply_modification` fired only when expected
- error-event count

These are noise-tolerant defaults. Real assessment comes from reading the
captured events + diff text per turn.

## Adding a scenario

Add to `SCENARIOS` in `scenarios.ts`. Required fields: `id` (must start with
`s`), `domain`, `projectName`, `seedMessage`, `channels`, `language`,
`capabilities`, `complexity`, `expectedAgents`. The auto-reply policy in
`auto-reply.ts` is permissive — it should handle most new scenarios without
changes, but add a question-keyword match if a new widget appears.

## Limitations / known gaps

- Auto-reply ignores `agent_review` per-agent BUILD widgets (architect approves
  build collectively via `build-complete-*`). If a future build flow surfaces
  per-agent gates, extend `decideReply` to handle them.
- Loop-detection breaks (e.g. specialist looping on `platform_context`) currently
  end the harness for that scenario with `errorCount=1`. Investigate via
  `events.ndjson` if a scenario shows that signature.
- Scoring is heuristic. The cluster of warnings in `findings.md` is the more
  trustworthy signal.
