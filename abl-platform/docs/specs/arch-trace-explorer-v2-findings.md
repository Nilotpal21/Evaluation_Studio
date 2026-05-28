# Arch Trace Explorer v2 — Audit Findings & Proposed Plan

**Status**: APPROVED — EXECUTING (scaffold-aware plan)
**Depends on**: [`arch-trace-explorer-v2-design.md`](./arch-trace-explorer-v2-design.md)
**Last Updated**: 2026-04-17 (refresh)

> **Refresh note (2026-04-17)**: the original §3 gap list + §4 plan were written against `arch/promptrefine`, which was discarded. We are now on `arch/slot-based-prompt` (fresh from `develop`) where a new **scaffold+fill BUILD architecture** has landed. See §6 below for the reconciled gap list and execution plan that supersedes §3 and §4.

## TL;DR

Before any v2 code: a deep audit of `packages/arch-ai/` + `apps/studio/src/lib/arch-ai/` + `apps/studio/src/app/api/arch-ai/` surfaces **two blockers** the v2 design doc didn't account for, and **six emission gaps** that make the Analytics tab meaningless until fixed.

The fix isn't one patch — it's a 3-phase plan (A/B/C below) that you need to approve before I touch code.

---

## 1. Branch divergence (blocker #1)

**v1 trace infrastructure is NOT on this branch.**

`arch/stability` has 11 feat/fix commits on `ABLP-162` that ship:

```
packages/arch-ai/src/tracing/                          (ArchTracer, ArchSpan, factory,
                                                        MongoWritePipeline, MongoTraceReader,
                                                        tracerRegistry, redaction, 8 test files)
packages/database/src/models/arch-trace-span.model.ts  (schema + TTL + tenant cascade)
apps/studio/src/components/admin/TraceExplorer.tsx
apps/studio/src/app/api/arch-ai/traces/onboarding/...  (4 route handlers)
```

`arch/promptrefine` (current) has **only the docs** that were backported. None of the code exists here. Any v2 UI work has to either:

- **Path A (recommended)**: cherry-pick the 11 commits from `arch/stability` into `arch/promptrefine`, resolve conflicts, then layer v2 on top.
- Path B: rebuild the span layer fresh. Weeks of work for zero new value.

## 2. Zero spans today — all telemetry is custom audit logs (blocker #2)

On the current branch, `packages/arch-ai/` contains zero OpenTelemetry-style spans. All telemetry is a MongoDB `arch_audit_logs` collection populated by `stream-observer.ts` mapping SSE events → audit rows.

This matters because the v2 design §5 assumes a span layer with `setAttribute()` semantics. On this branch, it doesn't exist. Path A above solves it.

## 3. Emission gaps — even after porting v1, six things must be fixed before v2 Analytics is useful

From the audit (file:line citations in `docs/sdlc-logs/arch-trace-explorer/audit-2026-04-17.md` — full report preserved):

| #   | Gap                                                                                                                                                                                                                                                                       | Impact                                                              | Fix location                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **`llm_call` audit entries are NEVER written** — the `LLMCallDetail` type is defined but no code path emits it.                                                                                                                                                           | Cost / token / model-mix analytics are **impossible** today.        | Emit inside `VercelLLMStreamClient.streamChat` (`packages/arch-ai/src/executor/llm-client.ts:158`) after `result.fullStream` completes and `result.usage` resolves.                                           |
| G2  | **`tool_execution.durationMs` is hardcoded to 0** (`stream-observer.ts:204`).                                                                                                                                                                                             | Per-tool latency analytics are wrong.                               | Emit tool timing inside `specialist-executor.ts` where `tool.execute()` actually runs; don't rely on the SSE observer.                                                                                        |
| G3  | **Retry counts are hardcoded to 0** on every tool_execution entry.                                                                                                                                                                                                        | Build-retry analytics are wrong.                                    | Increment on `multi-turn-executor.ts:198` (retriable) and `:252` (rate_limited); plumb into tool_execution detail.                                                                                            |
| G4  | **Loop detection exists but never surfaced** — `LoopDetector` (`packages/arch-ai/src/coordinator/loop-detection.ts`) fires a `guard_tripped` reason but nothing is attached to a span or audit entry.                                                                     | Loop-interrupt analytics impossible.                                | On guard trip in `multi-turn-executor.ts`, set `loop.detected = true` + `loop.cause = <hash>` on the current turn span.                                                                                       |
| G5  | **BUILD substeps are not differentiated** — agent-gen / compile / validation / topology are all the same undifferentiated SSE stream.                                                                                                                                     | Per-substep perf table (v2 §4.1) is impossible.                     | Wrap `runAgentWorker` (`build-parallel-gen.ts:~425`) with three nested spans: `arch.buildStep = 'agent_gen' \| 'compile' \| 'validation'`. Topology gets its own span in `coordinator/topology-synthesis.ts`. |
| G6  | **No error signature, no validation error category.** `classifyToolError` returns `retriable / permanent / rate_limited`; compile errors are freeform `{line, message, severity}`; cross-agent validator has a typed `type` field. None are hashed to a stable signature. | Failure-topology grouping (v2 §4 "Failure topology") is impossible. | Add a `computeErrorSignature(errorCode, source, phase, toolName?)` helper next to `redactSpanName`. Wire into span-end in the places listed in §4.                                                            |

## 4. Proposed plan

### Phase A — Port v1 infrastructure to this branch (1 commit set, bounded scope)

Cherry-pick 11 commits from `arch/stability` into `arch/promptrefine`, resolve any conflicts against recent promptrefine work, run `pnpm build` + `pnpm test`, land.

Deliverable: this branch reaches parity with stability on span infrastructure.

### Phase B — Fill the six emission gaps (additive, per-package commits)

| Step | Commit scope                                                              | Proves out                                |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------- |
| B1   | Emit `llm_call` spans from `VercelLLMStreamClient`                        | Cost + token analytics work               |
| B2   | Plumb real tool `durationMs` through `specialist-executor`                | Per-tool latency works                    |
| B3   | Plumb real `retry.cause` + `retryCount` through multi-turn executor       | Retry analytics works                     |
| B4   | Surface `loop.detected` + `loop.iterationCount` from guard                | Loop analytics works                      |
| B5   | Wrap `runAgentWorker` with agent-gen / compile / validation substep spans | Per-substep perf + failure-topology works |
| B6   | Add `computeErrorSignature` helper, wire into error/validation spans      | Failure topology grouping works           |

Each step is one small commit (max 3 packages). B1 is the highest-value single commit in the whole plan — do first.

### Phase C — v2 UI + Analytics (on top of now-rich data)

C1 Analytics API routes (summary / topology / models / funnel).
C2 Analytics tab component (per the approved HTML wireframe).
C3 Traces tab redesign (project filter, onboarding-collapsed-to-1, new substep + loop affordances in tree).
C4 Update SDLC docs to reflect v2 (feature spec, HLD, test spec, impl plan — the deltas already enumerated in `arch-trace-explorer-v2-design.md` §6).

## 5. Decisions needed from you

1. **Path A or Path B?** (strongly recommend A — cherry-pick from `arch/stability`)
2. **Is the B1→B6 emission-gap work acceptable as a prerequisite to v2 Analytics**, or do you want to ship v2 UI against the current-incomplete data and fix gaps later?
3. **Do you want B1 (the `llm_call` fix) landed as its own standalone commit first** — separable from the rest of v2 — since it unblocks _all_ cost/token analytics on its own? This is the single highest-value change in the whole plan.
4. **E2E tests for Phase B** — do you want the real MongoDB-backed E2E suite (our standard) or is the existing unit coverage on stability sufficient for B-phase commits? (My recommendation: add one E2E per B-step so regressions surface immediately.)

Once you answer these four I'll execute in order. I will not touch code on this branch until I have answers to 1 and 2.

---

## 6. 2026-04-17 Refresh — Scaffold+Fill Architecture Reconciliation

**Context:** `arch/promptrefine` was discarded. Restarted on `arch/slot-based-prompt` which has a new scaffold+fill BUILD pipeline (commits `4014e116e`, `83848e5a6`, `f54e8582e`, `45dba7442`). The design delta in `arch-trace-explorer-v2-design.md` is still valid for the UI; the emission-gap plan in §3/§4 above needs the reconciliations below.

### 6.1 New execution model (summary)

BUILD now branches at `apps/studio/src/lib/arch-ai/build-parallel-gen.ts:221-225`:

- **Scaffold path** (flag-gated `FEATURE_SCAFFOLD_GENERATION=true`, supervisor archetype only): `scaffoldAblAgent()` (pure/deterministic skeleton + Zod schema) → `fillSlots()` (Ring 1 `generateObject` + Ring 2 per-slot validators + targeted re-prompt) → `assembleAblAgent()` (manual YAML). Silent fallback to legacy on any exception (`:627-634`).
- **Legacy path** (default in prod today): single `streamText()` loop at `build-parallel-gen.ts:822` with tool-use compile-and-fix, same as before.

**Any tracing work must cover BOTH paths** until the flag flips on by default.

### 6.2 Six LLM call sites (up from 1 in the original plan)

| #   | File:line                                                                              | Phase                                                    | Context plumbed?                               |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| 1   | `apps/studio/src/lib/arch-ai/processors/process-message.ts:2343` `streamText`          | INTERVIEW / BLUEPRINT / BUILD orchestration / ONBOARDING | Yes                                            |
| 2   | `apps/studio/src/lib/arch-ai/build-parallel-gen.ts:822` `streamText`                   | BUILD legacy per-agent generator                         | Yes (workerLog)                                |
| 3   | `apps/studio/src/lib/arch-ai/scaffold/slot-fix-loop.ts:55` `generateObject` (Ring 1)   | BUILD scaffold creative fill                             | **NO** — `fillSlots` has zero context plumbing |
| 4   | `apps/studio/src/lib/arch-ai/scaffold/slot-fix-loop.ts:88` `generateObject` (Ring 2)   | BUILD scaffold per-slot retry                            | **NO**                                         |
| 5   | `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts:287` `generateText`            | BUILD compile-fix loop                                   | Partial                                        |
| 6   | `apps/studio/src/lib/arch-ai/llm-client.ts:158` `streamText` (`VercelLLMStreamClient`) | IN_PROJECT runtime specialist                            | Yes                                            |

### 6.3 Reconciled gap list (supersedes §3)

| G#  | Original scope                                    | Scaffold-aware scope                                                                                                                                                                                                                          |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `llm_call` spans in one place (`llm-client.ts`)   | `llm_call` spans at **all six** sites above. Scaffold path requires new context plumbing first (§6.5).                                                                                                                                        |
| G2  | Tool `durationMs` hardcoded 0                     | Unchanged — fix in `stream-observer.ts:202` for the legacy path. Scaffold has no tool execution to time.                                                                                                                                      |
| G3  | Retry cause via multi-turn-executor               | Two flavors now: (a) legacy `multi-turn-executor` retries (unchanged); (b) new per-slot scaffold retries in `slot-fix-loop.ts:69-116` (zero observability today).                                                                             |
| G4  | Surface `loop.detected`                           | Legacy/runtime path only. Scaffold is bounded by `maxRetriesPerSlot` with fallback — loop detector doesn't run there. Drop from scaffold scope.                                                                                               |
| G5  | BUILD substeps (agent_gen / compile / validation) | Two substep layouts now: (a) legacy path unchanged (agent_gen wraps `streamText` loop); (b) scaffold path needs four new substep spans: `scaffold.build_skeleton`, `scaffold.fill_ring1`, `scaffold.fill_ring2[slot=…]`, `scaffold.assemble`. |
| G6  | `error.signature` + validation category           | Scaffold has a natural signature primitive: `hash(slot_name, validator_code)` from `slot-validators.ts` error output `{ ok: false, error: string }`. Legacy path still needs the generic `(errorCode, source, phase, toolName?)` hash.        |

### 6.4 New emission gaps discovered by the scaffold audit

| Gap                                                                             | Why it matters                                                                                                                                                                       | Fix                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Scaffold→legacy silent fallback** (`build-parallel-gen.ts:627-634`)           | Any scaffold exception silently falls through to the legacy generator. Logged as `warn` but no SSE event, no audit entry, no analytics signal. This is a silent-failure class today. | Emit `build_scaffold_fallback` SSE + `build_event` audit entry with cause (exception message + slot, if available) + fallback reason code. |
| **Ring 1 Zod schema failures** (`slot-fix-loop.ts:97-101`)                      | Caught by outer try/catch and swallowed. No retry on Ring 1, no telemetry signal.                                                                                                    | Count Ring 1 failures as a distinct retry cause in the new `scaffold.fill_ring1` span.                                                     |
| **`FALLBACK_DEFAULTS` covers only `goal`+`persona`** (`slot-fix-loop.ts:41-45`) | Other failing slots ship the LLM's last bad attempt and are tagged in `fallbackSlots` but not surfaced outside the result object. Another silent degradation class.                  | `fallbackSlots[]` must be emitted as validation-error attributes on the owning `scaffold.fill_ring2[slot]` span.                           |

### 6.5 Prerequisite refactor (non-negotiable)

`fillSlots()` signature today (`slot-fix-loop.ts:25-29`) is `{ model, maxRetriesPerSlot }`. No `sessionId`, no `agentName`, no `tenantId`, no `auditEmitter`, no `tracer`. **None of the scaffold-path instrumentation can happen until this is threaded.**

Proposed shape: `fillSlots(scaffold, { model, maxRetriesPerSlot, telemetry?: ScaffoldTelemetryContext })` where `ScaffoldTelemetryContext = { tracer, parentSpan, sessionId, tenantId, agentName }`. Telemetry is optional — existing callers (tests, fixtures) stay green; production caller `runScaffoldWorker` (`build-parallel-gen.ts:533`) passes it.

### 6.6 Re-ordered execution plan (supersedes §4)

| #           | Step                                                             | Scope                                                                                                                                               | Deliverable                                                        |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A           | Port v1 tracing infra from `arch/stability`                      | `packages/arch-ai/src/tracing/`, `packages/database/src/models/arch-trace-span.model.ts`, `packages/observatory/` widen, HTTP routes, UI components | ArchTracer + MongoWritePipeline + TraceExplorer tab on this branch |
| B-pre       | Prerequisite: thread `ScaffoldTelemetryContext`                  | `runScaffoldWorker`, `fillSlots`, `assembleAblAgent`, slot validators                                                                               | Context available to instrument                                    |
| B1          | Emit `llm_call` spans at all 6 sites                             | One commit per major call site, ≤3 packages each                                                                                                    | Cost/token/model analytics data flows                              |
| B5-legacy   | Legacy BUILD substep spans (agent_gen wraps legacy `streamText`) | `build-parallel-gen.ts` legacy branch                                                                                                               | Per-substep perf table for legacy path                             |
| B5-scaffold | Scaffold 4-substep spans + `scaffold.validate` per slot          | `scaffold/*.ts`, `runScaffoldWorker`                                                                                                                | Per-substep perf table for scaffold path                           |
| B-new       | Surface scaffold→legacy fallback (SSE + audit)                   | `build-parallel-gen.ts:627`                                                                                                                         | Silent degradation becomes visible                                 |
| B6          | `computeErrorSignature` helper (scaffold + legacy variants)      | `packages/arch-ai/src/tracing/`                                                                                                                     | Failure topology grouping works                                    |
| B3          | Retry cause + count (legacy multi-turn + scaffold per-slot)      | `multi-turn-executor`, `slot-fix-loop`                                                                                                              | Retry analytics works                                              |
| B4          | Loop detected (legacy only)                                      | `executor-guards` → turn span                                                                                                                       | Loop analytics for legacy path                                     |
| B2          | Tool `durationMs` fix (legacy)                                   | `stream-observer.ts`                                                                                                                                | Per-tool latency works for legacy                                  |
| C1-4        | v2 UI + Analytics + doc sync                                     | Analytics routes, tab, Traces tab redesign, SDLC doc sync                                                                                           | Ship v2                                                            |

### 6.7 Items dropped from original plan

- **`synthesizePatternTopology` span** — the function isn't called at runtime on this branch. Real topology comes from the `generate_topology` tool inside BLUEPRINT `streamText`. No span needed unless/until scaffold starts calling it.
- **Loop-detected for scaffold path** — scaffold has bounded retries with fallback; `LoopDetector` never runs there.

### 6.8 Decisions needed (supersedes §5)

1. **Green-light Phase A port from `arch/stability`** — same branch-to-branch cherry-pick as before, different base (`develop` vs `promptrefine`). Likely smaller conflict surface.
2. **Confirm B-pre (context plumbing refactor) is acceptable** as a standalone commit before any scaffold-path span emission. It's a non-functional refactor but touches `fillSlots`'s public signature (still backward-compatible — `telemetry` param is optional).
3. **Coordinate with the scaffold agent**: since that work is still in flight on this branch, do you want me to (a) start A immediately in parallel, (b) wait until scaffold work merges to a stable checkpoint, or (c) ask the scaffold agent to add the telemetry context hooks directly as part of its current work?
