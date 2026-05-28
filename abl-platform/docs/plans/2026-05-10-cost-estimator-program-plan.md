# Cost Estimator Program — Design & Implementation Plan

**Author:** Prasanna Arikala
**Date:** 2026-05-10
**Status:** DRAFT — pending eng review
**Jira:** ABLP-XXXX (program parent ticket — to create)

---

## 1. Goal

Enable Kore.ai sales to produce **defensible LLM + Professional Services cost estimates** for any prospect in <5 minutes, backed by real synthetic eval traces rather than spreadsheet guesses. Ship as an importable agent bundle on AP 2.0.

**Driver:** A $500k+ deal was lost because the team could not credibly explain LLM cost. Making this answer crisp and evidence-backed is enterprise table-stakes.

**Strategic story** (the win condition for sales conversations):

> _"We didn't build a cost calculator. We configured one — on the same platform we'll build yours on. Every dollar in the estimate is backed by a real synthetic eval run with timestamps, token counts, and model IDs. Exportable. Reproducible. Defendable."_

## 2. Success Criteria

| Metric                                                     | Target                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Time from "SOP + brief in hand" to "estimate produced"     | < 5 min                                          |
| Estimate range accuracy at 90 days post-deployment         | within ±25% of actual                            |
| Used in enterprise pursuits within 60 days of v1 launch    | ≥ 3                                              |
| Sales-engineer effort per estimate (vs. spreadsheet today) | -75%                                             |
| Customer-perceived credibility (survey)                    | "high evidence" in ≥80% of post-meeting feedback |

## 3. Scope

**In scope (v1):**

- Cost Estimator agent bundle (importable via `platform_import_export`)
- Platform PRs that unblock the agent (one-shot Arch RPC, eval token rollup, Arch as internal agent, Session.source extensibility)
- Cache-hit telemetry (defends the optimistic/pessimistic range)
- FLOWS PARALLEL primitive (latency improvement)
- Customer-facing PDF + internal Excel worksheet output

**Post-MVP:**

- Cost dashboard in Studio (live runtime cost views)
- Cost guardrails / budgets (per-session, per-project)
- Eval-as-tool kind (`type: eval` to trigger eval runs from FLOWS without HTTP plumbing)
- SSE program (4 streaming surfaces)
- Workflow text DSL

**Out of scope:**

- Replacing PS pricing models (we surface ranges; PS team owns final pricing)
- Real-time cost optimization advice during agent execution
- Cross-cloud / cross-tenant cost attribution

## 4. Architecture

### 4.1 The Cost Estimator agent (one bundle)

```
cost-estimator/
├── orchestrator.agent.abl              # stateless FLOW
├── workflows/
│   └── eval-run-and-wait.workflow.json # durable wait (Restate)
├── tools/
│   ├── arch_generate.tool.abl          # type: http (after one-shot Arch RPC)
│   ├── run_eval.tool.abl               # type: workflow → eval-run-and-wait
│   ├── cost_calc.tool.abl              # type: sandbox runtime: javascript
│   ├── ps_estimate.tool.abl            # type: searchai
│   └── render.tool.abl                 # type: sandbox runtime: javascript
├── eval-templates/
│   ├── personas/                       # JSON, importable
│   └── scenarios/                      # JSON, importable
└── searchai-corpus/
    └── ps-calibration/                 # ~10 anonymized past engagements
```

### 4.2 Architectural invariants enforced

- **Stateless agent runtime:** The orchestrator's FLOW holds no state across waits. The eval polling loop lives in the workflow (Restate-backed, durably suspendable). Any pod can pick up any session. (See CLAUDE.md Core Invariant #4.)
- **Two-layer split:** Agent runtime = stateless step execution. Workflow engine = durable async. Tools wrap platform APIs.
- **Evidence-backed estimates:** Every dollar traces back to a `llm_call` trace event from a real eval run.
- **Importable as one bundle:** No sidecar containers, no separate sidecar deployment, no install step beyond `platform_import_export`.

### 4.3 Orchestrator FLOW (sketch)

```
FLOW:
  step ingest:
    GATHER spec, volume, projectId
    THEN generate

  step generate:
    CALL arch_generate(spec=spec, projectId=projectId)
    SET topology = result.topology
    ON_SUCCESS -> evaluate
    ON_FAIL    -> abort_with_reason

  step evaluate:
    CALL run_eval(topology=topology)        # workflow tool: durable wait
    SET evalResults = result
    THEN compute

  step compute:
    PARALLEL [mode=all_succeed]:
      CALL cost_calc(tokens=evalResults.tokens, volume=volume) -> costs
      CALL ps_estimate(topology=topology)                      -> psCost
    THEN deliver

  step deliver:
    CALL render(costs=costs, psCost=psCost, eval=evalResults)
    PRESENT result
```

### 4.4 The eval-run-and-wait workflow

Six nodes, canvas-authored once, exported as JSON, shipped in bundle:

```
[start]
  → [api: start_eval_run]                      # POST /api/projects/:id/evals/runs/:runId/start
  → [loop: max=180 iterations]
       └─ [api: poll_status]                   # GET .../status
          → [condition: status == complete]
              yes → exit loop
              no  → [delay 10s] → back
  → [api: fetch_results]                       # GET .../runs/:runId
  → [end: { tokens, perAgentBreakdown, costs }]
```

Hard cap at 30 minutes (180 × 10s). Beyond that, eval has likely failed; surface explicitly.

## 5. Workstreams

### W1 — Platform Foundation (CRITICAL PATH, parallelizable)

Four independent platform PRs. Land them in parallel.

#### W1.1 — One-shot Arch RPC

**Ticket:** ABLP-XXXX (`feat(arch-ai): add one-shot generate endpoint`)
**Surface:** `POST /api/arch-ai/generate { spec, projectId? } → { projectId, agents[], topology }`
**Where:** `apps/studio/src/app/api/arch-ai/generate/route.ts` (new)
**Approach:** Drives the existing INTERVIEW → BLUEPRINT → BUILD pipeline server-side with sensible defaults from the spec. No SSE, no client-side conversation. Same compiler + topology generator the multi-turn flow uses.
**Acceptance:**

- Given a complete spec, returns topology synchronously in <2 min for typical SOPs
- 4xx with structured error if spec is incomplete (lists missing fields)
- E2E test: feed MS_SOPs.md → returns ≥6 agents matching expected use cases
  **Effort:** 2 days
  **Dependency:** none

#### W1.2 — Eval Token Rollup Fix

**Ticket:** ABLP-XXXX (`fix(eval): roll up agent-under-test token cost into RunSummary`)
**Where:** `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts:232` (currently inits `totalEstimatedCost = 0` and never increments)
**Approach:** Sum `llm_call` events from `agentResult.traceEvents` using `estimateCost()` from `packages/shared-kernel/src/model-pricing.ts`. Apply `classifyLlmTraceVisibility()` to distinguish `internal_only` from `customer_visible`. Populate per-conversation cost; aggregate to `RunSummary.estimatedCost` and `RunSummary.estimatedCostByModel`.
**Acceptance:**

- After eval run, `GET /api/projects/:id/evals/runs/:runId` returns non-zero `estimatedCost`
- Studio `CostEstimate.tsx` UI shows live numbers
- Unit test: synthetic trace with known token counts produces expected cost
  **Effort:** 2 days
  **Dependency:** none. Independently shippable; benefits every eval user platform-wide.

#### W1.3 — Arch as Internal Agent

**Ticket:** ABLP-XXXX (`feat(arch-ai): expose Arch as in-platform invokable agent`)
**Where:** Register Arch's existing service as an agent definition callable via `type: agent` node and FLOW DELEGATE.
**Approach:** Wrap Arch's session+message pipeline in an agent definition (or expose via the agent dispatcher). The one-shot RPC (W1.1) is the underlying mechanism; this work makes it consumable inside FLOWS and workflows without going through Studio HTTP routes.
**Acceptance:**

- A FLOW can `DELEGATE` to Arch and receive a topology
- A workflow `agent` node can target Arch
- E2E: an agent calls Arch, gets topology back, continues
  **Effort:** ~1 week
  **Dependency:** W1.1 (uses the same RPC underneath)

#### W1.4 — Session.source Extensibility

**Ticket:** ABLP-XXXX (`feat(runtime): extend Session.source enum with synthetic and eval values`)
**Where:** Session model + ClickHouse schema + analytics rollups + billing exclusion logic
**Approach:** Add `synthetic` and `eval` to the `Session.source` enum. Make it extensible per-tenant (config-driven additions allowed; defaults remain). Eval runs auto-tag with `source: 'eval'`. Cost-estimator synthetic traffic auto-tags with `source: 'synthetic'`. Filter both out of customer billing rollups by default.
**Acceptance:**

- Eval runs produce sessions with `source: 'eval'`
- ClickHouse `platform_events.source` propagates correctly
- Billing rollup excludes `eval` and `synthetic` sources by default
- Analytics dashboards have a source filter (default: production-only)
  **Effort:** 1 week
  **Dependency:** none

### W2 — Cost Estimator Agent (depends on W1)

#### W2.1 — orchestrator.agent.abl

The conversational entry point + FLOW from §4.3.

- `.agent.abl` file with intents (`estimate_cost`, `refine_estimate`)
- FLOW with steps: ingest, generate, evaluate, compute, deliver
- Error handling for each step (Arch fail, eval fail, render fail)
- DELEGATE to Arch internal agent when available; fall back to HTTP tool otherwise

**Effort:** 3 days

#### W2.2 — eval-run-and-wait workflow (canvas)

Six-node workflow per §4.4. Authored in Studio canvas, exported as JSON, shipped in bundle.
**Effort:** 1 day to author + 1 day to test

#### W2.3 — Tool definitions (5 files)

| Tool            | Type         | Notes                                                                    |
| --------------- | ------------ | ------------------------------------------------------------------------ |
| `arch_generate` | `http`       | `POST /api/arch-ai/generate` (after W1.1)                                |
| `run_eval`      | `workflow`   | invokes `eval-run-and-wait` workflow                                     |
| `cost_calc`     | `sandbox` JS | wraps `shared-kernel/model-pricing.ts` `estimateCost()`; computes ranges |
| `ps_estimate`   | `searchai`   | queries calibration corpus for hour estimates                            |
| `render`        | `sandbox` JS | produces markdown / HTML / Excel from estimate object                    |

**Effort:** 3 days total

#### W2.4 — Eval scenario library

The long-lived asset. Per use-case archetype, define 3-5 scenarios + 3 personas (low/typical/heavy user). Goal: ~30 reusable scenarios covering common patterns (research, summarization, multi-turn negotiation, escalation, error paths).

**Initial coverage** (matches MS_SOPs.md and JPMC_SOPs.md):

- Pre-meeting research (3 personas × 5 scenarios)
- Post-meeting summarization (3 × 4)
- Trade idea research (3 × 5)
- Internal knowledge lookup (3 × 4)
- Trade order capture (3 × 4)
- Servicing FAQ (3 × 4)

**Effort:** 1 week (the team's time + product input)

#### W2.5 — PS calibration corpus

Anonymize 8-10 past engagements. Store in SearchAI as the calibration knowledge base.
Required fields per record: topology shape, tool count, integration count, channel mix, hours-by-phase, total $.

**Effort:** 1 week (mostly waiting on PS team to anonymize)

### W3 — FLOWS PARALLEL (parallelizable with W2)

**Ticket:** ABLP-XXXX (`feat(flows): add PARALLEL step kind`)
**Surface:** New FLOW step kind:

```
PARALLEL [max=5, mode=all_succeed | any_succeeds | best_effort]:
  CALL t1(...) -> r1
  CALL t2(...) -> r2
  ...
THEN <next-step>
```

**Where:** FLOW IR (`packages/compiler/src/platform/ir/schema.ts` ~L2167+ for `FlowStep`), executor in `apps/runtime`, validator
**Approach:**

- IR addition: discriminated union arm for parallel step
- Executor: bounded fan-out (default max 5, hard cap 10), Promise.all-style join with mode semantics
- Reuses existing tool dispatch — inherits rate limits, circuit breakers, traces
- Stateless: each branch runs to completion synchronously, no state across time
  **Acceptance:**
- E2E test: FLOW with 4 parallel CALLs completes in max(individual) latency, not sum
- Mode semantics: `all_succeed` fails on any branch fail; `any_succeeds` returns first success; `best_effort` returns partial results with per-branch status
- Trace events show concurrent execution
- Hard cap enforced (refuses configs >10 branches at compile time)
  **Effort:** 3-4 days
  **Dependency:** none

### W4 — Cache-Hit Telemetry (parallelizable)

**Ticket:** ABLP-XXXX (`feat(observatory): capture cache-hit metadata in LLM trace events`)
**Where:**

- `packages/observatory/src/schema/trace-events.ts` `LLMCallData` — add `cacheReadInputTokens`, `cacheCreationInputTokens`, `cachedPromptTokens` (provider-neutral)
- LLM client adapters (Anthropic, OpenAI, Google) — extract these from provider responses
- `packages/shared-kernel/src/response-provenance.ts` `extractLlmTraceMetrics` — pass through new fields
- `packages/shared-kernel/src/model-pricing.ts` `estimateCost()` — apply cached-token rates (typically 10% of input rate)

**Acceptance:**

- Anthropic responses with `cache_read_input_tokens` flow into trace events
- OpenAI cached prompt tokens captured
- Eval `RunSummary` shows aggregated cache-hit ratio per model
- Cost estimator's optimistic/pessimistic range derives from cache-hit model

**Effort:** 4-5 days. **Defends the credibility of the cost estimate range** — without this, optimistic vs pessimistic is hand-waving.

### W5 — Cost Dashboard in Studio (post-MVP)

Per-project view: cost by agent / by tool / by model / by source / time series. Cache-hit ratio panel. Spend trajectory vs budget (depends on W6).
**Effort:** 1-2 weeks
**Dependency:** W1.2, W4

### W6 — Cost Guardrails (post-MVP)

Budget objects (scope: project | agent | session). Threshold actions: alert | throttle | block. Runtime middleware enforces against rolled-up cost. Studio UI for managing budgets.
**Effort:** 2-3 weeks
**Dependency:** W1.2 (need rollup before you can guardrail it)

### W7 — Eval-as-Tool Kind (post-MVP)

`type: eval` tool kind. Lets a FLOW or workflow node trigger an eval run natively. Cleanup over the HTTP-tool plumbing v1 uses.
**Effort:** 1 week
**Dependency:** none. Quality-of-life improvement; not deal-blocking.

### W8 — SSE Program (post-MVP, multi-PR)

Four streaming surfaces (LLM-internal already works; the four below are net-new):

- W8.1 — Tool → agent output streaming (~1 week)
- W8.2 — Tool ← external SSE input (~1 week)
- W8.3 — Workflow `streaming_api` node (~1 week)
- W8.4 — Stream-capable MCP tool client (~3 days)

**Effort:** ~3-4 weeks total
**Dependency:** none. Big lever, not blocking the cost estimator (after W1.1 lands).

## 6. Sequencing & Critical Path

```
Week 1-2 ──── W1.1 ─┐  W1.2 ─┐  W1.3 ─┐  W1.4 ─┐  W3 (PARALLEL) ─┐  W4 (cache-hit) ─┐
                    │        │        │        │                  │                  │
                    └────────┴────────┴────────┴──────────────────┴──────────────────┘
                                                │
Week 3-4 ────────────────────────────────────── W2 (Cost Estimator MVP)
                                                │
                                                ▼
Week 5 ─────────────────────────── Internal pilot with 3 sales reps
                                                │
                                                ▼
Week 6+ ─────────────────────────── W5 / W6 / W7 / W8 (post-MVP roll-out)
```

**Critical path for the deal:** W1.1 + W1.2 + W2 = **~3 weeks** with 1 platform engineer + 1 agent engineer.

**Parallelizable:** W1.3, W1.4, W3, W4 all run alongside without blocking.

**With 2 engineers full-time:** MVP shippable end of week 3. Public pilot week 4.
**With 1 engineer:** MVP shippable end of week 5.

## 7. Risks & Mitigations

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                             |
| ----------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Arch one-shot RPC takes >2 min for complex SOPs             | Medium     | High   | Profile early; if needed, switch to `mode: async` workflow tool with progress streaming after W8 lands |
| Eval cost rollup edge cases (cancelled runs, partial fills) | Medium     | Medium | Comprehensive unit tests on the aggregation logic; mark partial runs explicitly in summary             |
| Cache-hit ratios vary wildly run-to-run, blowing range      | High       | Medium | Run N=20-50 synthetic interactions per scenario; report range with explicit cache-hit assumption       |
| PS calibration corpus too thin (<5 deals)                   | High       | High   | Block v1 release until ≥5 anonymized deals available; PS team prerequisite                             |
| Customer asks "what about voice / multimodal cost?"         | Medium     | Medium | v1 scope = text-only; add voice (STT/TTS) cost model in v1.1                                           |
| Pricing tables go stale                                     | High       | High   | Auto-refresh weekly via scheduled workflow; version every estimate with `pricedAt` timestamp           |
| Sales misuses tool (assumes ranges are guarantees)          | Medium     | High   | Output template includes prominent "estimate, not commitment" language; sales enablement session       |
| Customers want their own scenarios reflected                | Medium     | Medium | Allow custom-scenario-injection in v1.1; v1 uses the standard library                                  |

## 8. Definition of Done (v1)

**Code/build:**

- [ ] Cost-estimator bundle imports cleanly into a fresh AP 2.0 project via `platform_import_export`
- [ ] No new sidecar containers; all execution on existing platform infra
- [ ] All four W1 platform PRs landed and stable in `develop`
- [ ] FLOWS PARALLEL primitive landed with executor + IR + tests

**Quality:**

- [ ] E2E test: feed MS_SOPs.md → estimate produced in <5 min
- [ ] E2E test: feed JPMC_SOPs.md → estimate produced in <5 min
- [ ] Unit tests for cost_calc cover all model rates + cache-hit scenarios
- [ ] Eval scenario library covers ≥30 archetypes
- [ ] PS calibration corpus has ≥5 anonymized deals
- [ ] Cache-hit ratio surfaced in trace events and eval results

**Documentation:**

- [ ] `docs/features/cost-estimator.md` feature spec
- [ ] `docs/testing/cost-estimator-test-spec.md` test spec
- [ ] `docs/specs/cost-estimator-hld.md` HLD
- [ ] `docs/plans/cost-estimator-lld.md` LLD (this is the program plan; per-workstream LLDs to follow)
- [ ] Sales enablement deck (separate, owned by GTM)
- [ ] Customer-facing one-pager template

**Process:**

- [ ] All four mandatory audits run per workstream (`phase-auditor`, `lld-reviewer`, `pr-reviewer`, `data-flow-audit` where triggered)
- [ ] CRITICAL findings resolved before merge
- [ ] Internal pilot completed with 3 sales reps + retro

## 9. Open Questions for Product / Eng Leadership

1. **PS pricing model ownership** — does PS team own the calibration corpus, or is it eng-maintained? (Recommend PS team; eng provides the SearchAI surface.)
2. **Pricing-table freshness SLA** — weekly auto-refresh acceptable, or daily required? (Models rarely change daily; weekly seems fine.)
3. **Async mode UX** — for high-volume future use cases, do we want a "kick off estimate, get notification" pattern in v1.1?
4. **Customer self-service?** — should customers run the cost estimator themselves on their own AP 2.0 instance, or is it sales-team-internal? (Recommend internal-only for v1; consider customer self-service in v2 once scenario library proves robust.)
5. **Voice cost modeling** — STT/TTS rates vary by provider; do we ship v1 text-only and add voice in v1.1, or block v1 on voice support? (Recommend text-only for v1.)

## 10. Next Steps (immediate)

1. **Create parent Jira epic** ABLP-XXXX "Cost Estimator Program" linking all workstream tickets
2. **File W1 platform tickets** (W1.1 / W1.2 / W1.3 / W1.4) — these are independent, can start same day
3. **Run `/feature-spec`** for Cost Estimator agent → `docs/features/cost-estimator.md`
4. **Schedule 30-min eng review** of this plan; iterate before kicking off W1
5. **Confirm PS team will deliver ≥5 anonymized engagements** in 2 weeks (blocking input for W2.5)
6. **Identify pilot sales reps** for week-5 pilot

## 11. Appendix — Strategic Story After This Program

After this program, the answer to a $500k-class customer asking "how much will this cost?" stops being a spreadsheet and becomes:

> _"We ran the actual agents we'd build for you against 50 synthetic scenarios. Here's the trace bundle: every token, every model call, every dollar — captured by the same eval system that will run your production regression suite. Cache-hit ratio assumption: 55%. Optimistic case (75% cache hit, Sonnet-heavy): $X. Pessimistic case (30% cache hit, Opus on hard reasoning): $Y. The estimate isn't a guess — it's a measurement."_
>
> _"We didn't build a cost calculator for you. We configured one — on the same platform we'll build your agents on. Two layers: stateless agent runtime for conversation, durable workflow engine for async. Each doing what it's best at. That's the platform you'll own."_

That's the story that wins enterprise deals. Cost estimation is the proof point; the architectural shape is the actual product.

---

_End of plan — v1 draft, 2026-05-10_
