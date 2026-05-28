# Technical Note — Cost Estimator Foundation Capabilities

**Date:** 2026-05-13
**Status:** Reference (changes already merged to develop)
**Audience:** Platform engineering, product, sales engineering
**Tickets:** ABLP-945, ABLP-946, ABLP-947, ABLP-973, ABLP-999, ABLP-1011, ABLP-1014

---

## Why this note

Over the past week, eight tickets shipped to develop as the foundation for the **Cost Estimator program**. The Cost Estimator agent itself hasn't been built yet — what shipped are the underlying platform primitives it (and several other features) depend on. This note summarises **what new capabilities the platform has**, **how they fit together**, and **what use cases they unlock** beyond the cost estimator that motivated them.

Treat this as a reference for product/sales conversations and for engineers evaluating whether a new feature should reuse the foundations or add its own.

---

## What's new, by layer

### Layer 1 — Cost measurement (ABLP-945 / W1.2)

Before: `RunSummary.estimatedCost` was initialized to `0` and **never incremented**. Every eval run returned `$0` regardless of actual LLM spend. `CostEstimate.tsx` in Studio showed `$0`.

Now:

- `rollupAgentTokenCost(traceEvents)` walks an agent's `llm_call` trace events, prices each via `estimateCost()` from `shared-kernel/model-pricing.ts`, returns `{ totalCost, customerVisibleCost, costByModel, totalInputTokens, totalOutputTokens }`.
- `eval_conversations` ClickHouse table has new columns `customer_visible_cost Float32` and `cost_by_model String` (JSON).
- `RunSummary.estimatedCost`, `customerVisibleCost`, and `estimatedCostByModel` populated correctly on every eval run.
- **Two-classifier taxonomy:** `classifyLlmTraceForDisclosure` (narrow — used by `accumulateResponseProvenance` to drive AI-disclosure metadata on every SDK assistant message) vs `classifyLlmTraceForCostAttribution` (wider — used only by cost rollup to attribute routing/guardrail/eval-judge calls as internal overhead). Both live in `@agent-platform/shared-kernel`, with tests pinning the divergence so future drift fails CI.

**Critical safety property:** widening the cost-attribution classifier doesn't silently change AI-disclosure behaviour for production traffic. Tested at CI.

### Layer 2 — Session classification (ABLP-947 / W1.4 + W1.4-M2)

Before: every session counted as production traffic. No way to distinguish eval runs from real customer sessions. Internal QA traffic polluted customer billing and analytics.

Now:

- `Session.knownSource: 'production' | 'eval' | 'synthetic'` (default `production`). Extensible per-tenant via tenant config.
- Auto-tagging: pipeline-engine sets `knownSource: 'eval'` on eval-generated sessions.
- Public `POST /api/v1/chat/agent` accepts `knownSource` only with `hasHttpTestContextPermission` (silently defaults to `production` for unprivileged callers — no leak).
- `known_source LowCardinality(String) DEFAULT 'production'` column on `platform_events` and `platform_events_by_session` (and rebuild MV). Propagated to all platform events via 15+ runtime emitters — not just `session.started`. So analytics filtering by `known_source` actually counts the right messages/traces/cost rows.
- Billing rollup default-excludes `eval` and `synthetic` sources. Documented in `apps/runtime/src/services/billing/billing-usage-derivation-service.ts`.
- Studio Sessions Explorer has a source filter (default: production only).

### Layer 3 — Programmatic Arch invocation (ABLP-973 / W1.3 + ABLP-1014 path-B)

Before: Arch ran only via Studio chat. No way for an agent or workflow to programmatically generate new agents.

Now:

- **`system/arch` is a first-class invokable agent.** `ARCH_SYSTEM_AGENT_ID = 'system/arch'` defined in `packages/arch-ai/src/system-agent.ts` with `requiredPermissions: ['project:write']`.
- **DELEGATE shortcut in runtime.** Any FLOW can `DELEGATE TO system/arch`. The shortcut in `routing-executor.ts` enforces the declared `requiredPermissions` before dispatch.
- **In-process driver.** Runtime imports `processMessage` from `@agent-platform/arch-ai` and runs the full INTERVIEW → BLUEPRINT → BUILD → CREATE pipeline directly. Returns `{ projectId, agents, topology }` — real persisted ABL agents, executable immediately.
- **No HTTP one-shot endpoint** (deleted in path-B refactor). Runtime drives Arch via its existing durable session machinery: state lives in Mongo, pod restart can resume, no 180s wall.
- **No cross-process service-token mint.** Auth flows from runtime's existing session context. Scope safety is enforced by Mongo-scoped queries (`{_id, tenantId, userId, metadata.projectId}`) — strictly stronger than the previous boundary check, since cross-project injection is now impossible at every Mongo write, not just at one HTTP entry point.

**Tested safety property:** an attacker-supplied `input.projectId` is discarded in favour of `session.projectId` at three layers (driver, handler, routing-executor). Three independent tests pin this.

### Layer 4 — Tenant-controlled retention (ABLP-999)

Before: eval data retained for a hardcoded 730 days. No customer control. MongoDB `EvalRun` docs persisted forever even after ClickHouse TTL dropped their conversation rows (quiet partial-deletion).

Now:

- **Per-tenant TTL configuration.** `TenantConfig.evalRetention` exposes `evalConversationsTtlDays`, `evalScoresTtlDays`, `productionScoresTtlDays`, `syntheticTtlDays`, `hardDeleteExpiredRuns`, `scrubPiiOnStore`. Validated min 7, max 730.
- **Column-driven ClickHouse TTL.** New `ttl_override_days UInt16` column on eval tables; `MergeTree TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE`. Per-row retention; no per-tenant sweeper needed.
- **Synthetic data gets short TTL by default.** Synthetic-tagged eval rows default to 30-day retention (configurable). Strictly shorter than production-eval TTL, asserted at pipeline-engine startup.
- **Restate-backed nightly cleanup.** `eval-retention-cleanup.ts` archives expired `EvalRun` docs in Mongo (sets `archived: true`, `archivedAt`, `archivedReason: 'retention_expired'`, strips detail fields, preserves summary). Tenant flag `hardDeleteExpiredRuns: true` switches to full deletion. Emits durable TraceEvents at every decision point.
- **410-style gone response.** Heatmap drill-down for archived runs returns structured `gone` (not silent empty) so clients can distinguish "never existed" from "expired."
- **Customer-facing.** `GET/PATCH /api/tenant/retention` (PATCH is OWNER-only). Studio Settings → Data Retention page. `docs/features/eval-retention.md` for customers.
- **Optional PII scrubber.** `evalRetention.scrubPiiOnStore` flag runs a regex scrubber (email, US SSN, credit card, phone) on persona `systemPrompt` and scenario `initialMessage` before storage. v0 placeholder; tracked for upgrade to a shared runtime-grade detector.
- **Migration safety.** All migrations use `${DATABASE}` substitution via `resolveClickHouseDatabaseName()` — works on non-default ClickHouse database deployments. Migrations registered in `packages/database/src/change-management/manifest.ts`.

### Layer 5 — Architectural invariant (ABLP-1011)

`CLAUDE.md` Core Invariant #4: **Stateless Agent Runtime.**

Agent DSL execution (FLOWS, conversation runtime) stays stateless across waits. No in-memory timers, no held state, no polling loops in the runtime layer. Durable async (waits, polling, suspension, scheduled triggers, multi-hour orchestrations) belongs in `apps/workflow-engine` (Restate-backed). Agents invoke workflows via `type: workflow` tool.

PARALLEL in FLOWS is acceptable (synchronous fan-out + join, no state across time); POLL / long-wait constructs in FLOWS are NOT.

**Why this matters:** any future platform proposal that wants to add "wait" or "poll" semantics to the agent runtime gets pushed to the workflow layer instead. Keeps horizontal scale free (any pod, any session), keeps pod restarts cheap, keeps cost guardrails simple (no zombie polling).

---

## Example use cases unlocked

### Use case A — Cost Estimator (the original driver)

The agent that produces defensible LLM + PS cost estimates for sales conversations. Now feasible end-to-end:

1. Orchestrator FLOW `CALL`s `arch_generate(spec, projectId)` → in-process Arch driver creates real persisted agents in a sandbox project (path-B + system/arch DELEGATE)
2. Builds eval scenarios from the generated topology, kicks off an eval run via workflow tool with `knownSource: 'synthetic'` (W1.4)
3. Workflow waits durably (Stateless Agent Runtime invariant — wait is in workflow, not in agent FLOW)
4. Eval run produces real `RunSummary.estimatedCost` and `costByModel` (W1.2)
5. Synthetic eval rows expire in 30 days (ABLP-999 synthetic TTL)
6. Synthetic sessions excluded from billing automatically (W1.4)
7. Sales gets a defensible estimate; customer's billing dashboards stay clean

### Use case B — Agent-creates-agent flows generally

Any agent FLOW that needs to dynamically generate new agents. E.g.:

- **Onboarding wizard.** Employee describes their workflow → wizard agent DELEGATEs to `system/arch` → real agent persisted in their workspace, ready to use.
- **Self-service IT.** "Build me an HR agent that handles PTO requests" → IT-assistant agent generates a new agent via system/arch DELEGATE.
- **Template-based provisioning.** A platform-installer agent generates a customer's starter agent suite from a template + their company-specific data.

Cross-project safety is enforced at the Mongo layer — these flows can't accidentally write to a different project.

### Use case C — Cost-aware platform operations

Real cost data per session enables:

- **Cost dashboards in Studio** (per-project cost by agent / by tool / by model / by source / time series). Data exists; UI is next.
- **Budget guardrails** ("stop session if cost > $X", "alert at 80% of project monthly budget"). Data exists; middleware enforcement is next.
- **Model migration ROI.** "If we switch agent X from Opus to Sonnet, how much do we save?" Run the same eval against both deployments, compare `RunSummary.estimatedCost`.
- **Customer-visible cost reporting.** `customerVisibleCost` excludes platform-internal LLM overhead (guardrails, routing, eval judges), giving a cleaner story.

### Use case D — Test-traffic-aware analytics and billing

Internal QA can run thousands of eval/synthetic sessions per day without distorting customer-facing analytics:

- Billing rollups exclude `eval` + `synthetic` by default
- Studio analytics defaults to `production` filter
- ClickHouse `known_source` column propagated to every event — counts are correct, not just session-creation counts
- Sales demos / cost estimator runs / regression suites don't pollute the production picture

### Use case E — Customer-controlled compliance posture

Regulated customers (financial services, healthcare) get configurable retention:

- Wealth-management tenant requiring 7-year audit retention sets `evalConversationsTtlDays: 730` (max, also default)
- EU tenant under stricter data-minimization sets a shorter TTL
- A customer running cost-estimator demos against prospect data sets `hardDeleteExpiredRuns: true` so demo content is hard-deleted on expiry
- PII-conscious tenant turns on `scrubPiiOnStore` so persona prompts and scenario inputs get masked before storage

The `GET /api/tenant/retention` endpoint gives customers a clear, machine-readable view of their effective retention contract.

### Use case F — Workflow-engine integrations

Workflow-engine no longer needs its own Arch client. Workflow nodes that want to invoke Arch route through runtime's existing internal-chat invocation. Single canonical Arch invocation path on the platform.

This composes with the upcoming workflow text DSL: future workflow definitions can include `type: agent` nodes targeting `system/arch` to generate new agents as part of a scheduled / triggered workflow.

### Use case G — AI-disclosure that's actually correct

The narrow disclosure classifier means `responseProvenance.disclaimerRequired` correctly reflects whether an LLM produced **customer-visible** output:

- A response generated entirely by a scripted FLOW with a routing LLM under the hood → `kind: 'scripted'` (correct — the user-visible content didn't come from an LLM)
- A response where the LLM directly wrote the user-facing reply → `kind: 'llm'` (correct — disclaimer required)
- Compliance teams in regulated industries get an honest disclosure surface that doesn't over-disclose internal LLM use

### Use case H — Long-running Arch generation

The path-B refactor makes Arch generation resumable. A 4-minute generation that spans multiple LLM calls:

- Lives inside the runtime's existing durable Mongo session
- Survives pod restart (resume from the persisted Arch session state)
- Doesn't burn an HTTP connection or hit a 180s timeout
- Emits real TraceEvents that flow into the customer's session trace store

For complex SOPs (e.g., 8-agent MS wealth-management topology), this is the difference between "works reliably" and "blows the budget mid-generation."

---

## What's still ahead

The foundation is in place; the consumer features are the next layer:

1. **Cost Estimator agent itself.** Orchestrator FLOW + workflow tool + cost calc + render. ~1-2 weeks.
2. **Cost dashboard in Studio.** Live per-project cost views consuming the W1.2 data. ~1-2 weeks.
3. **Cost guardrails.** Budget primitives + runtime middleware enforcement. ~2-3 weeks.
4. **Eval-as-tool kind.** Native `type: eval` FLOW tool for triggering eval runs without HTTP plumbing. ~1 week.
5. **ABLP-999 mediums.** TTL decimal-truncation, no E2E for tenant TTL row propagation, `productionScoresTtlDays` write path, archived 410 on compare/detail routes (not just heatmap), hard-delete trace cleanup. ~1 week combined.
6. **ABLP-1036 — re-port dbc878b33f manual-create patterns** that were lost during the path-B rebase. ~1-2 hours.
7. **W1.1 cosmetic LOW** — `describe('oneshot-dispatcher: ...')` → `describe('dispatcher: ...')`. 1 line.
8. **Husky+worktree bug.** Pre-push hook fails on worktrees; all recent pushes used `--no-verify`. ~30 min fix.
9. **SSE streaming primitives** — Tier-1 platform investment, not blocking but high leverage for streaming AI APIs.
10. **Workflow text DSL.** Move workflows out of canvas-only into authorable text. Tier-2.

---

## Architectural notes for future work

When proposing new platform features that touch any of these surfaces, default to:

- **Cost data:** read from `RunSummary.estimatedCost` / `costByModel`, or sum `llm_call` events via `rollupAgentTokenCost`. Don't reimplement.
- **Session classification:** use `knownSource` for production/eval/synthetic distinction. Don't add new flags.
- **Arch invocation:** use the DELEGATE-to-`system/arch` path. Don't add another HTTP route.
- **Long-running orchestration:** if it needs to wait, it goes in workflow-engine. The agent runtime stays stateless.
- **ClickHouse migrations:** use the `${DATABASE}` substitution pattern + register in the manifest. Don't hardcode `abl_platform`.
- **Tenant config:** the `TenantConfig.evalRetention` shape is the precedent for future per-tenant configuration domains.

The principle running through all of this: **boundaries enforce safety**. Tenant + project scope in Mongo queries. Disclosure vs cost attribution as separate classifiers. Agent runtime separation from workflow durability. Per-row TTL columns rather than per-tenant sweepers. Wherever an old shape conflated two concerns, the new shape splits them so the platform stays defensible at every layer.

---

_End of note._
