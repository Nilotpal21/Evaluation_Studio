# Bruce Wilcox Feedback Review — Consolidated Report

**Date:** 2026-03-10
**Source:** Bruce Wilcox emails, March 3–10, 2026
**Reviewed by:** 7 parallel code-explorer agents validating claims against codebase
**Scope:** 43 items across 15 sections

---

## Executive Summary

- **33 of 43 claims confirmed** against actual codebase
- **5 partially confirmed** (real issue but narrower than claimed)
- **5 not confirmed** (code already handles the scenario correctly)
- **2 one-liner critical fixes** identified (goto_step field mismatch, IndexRegistry plugin)
- **ON_ERROR system is almost entirely non-functional** at runtime despite compiling correctly
- **Guardrails pipeline has 2 silent correctness bugs** that would bite in production

---

## CRITICAL & HIGH — Fix Before Production

### 4.1 goto_step Target Field Mismatch (CRITICAL)

**Status:** Confirmed Bug
**Impact:** All DSL-compiled goto_step constraints silently broken in production.

The compiler writes the step target to `then_step` (`compiler.ts:1476, 1512`), but the runtime reads `action.target` (`constraint-checker.ts:257`). These fields never overlap. The step name always resolves to `''`, making backtrack limits meaningless and jump targets empty.

Masked in tests because unit tests inject `{ type: 'goto_step', target: 'step_name' }` directly, bypassing the compiler.

**Fix:** In `constraint-checker.ts:257`, change `action.target` to `action.then_step ?? action.target`.

---

### 9.2 IndexRegistry Missing tenantIsolationPlugin (CRITICAL — Security)

**Status:** Confirmed
**Impact:** Queries on IndexRegistry run unscoped across all tenants. Controls write routing to OpenSearch indices — cross-tenant data injection possible.

`SearchDocument`, `SearchChunk`, `DocumentPage` all have `.plugin(tenantIsolationPlugin)`. IndexRegistry does not, despite having a `tenantId` field and compound indexes.

**Fix:** Add `IndexRegistrySchema.plugin(tenantIsolationPlugin)` before model export in `packages/database/src/models/index-registry.model.ts`.

---

### 2.1 RESPOND in ON_ERROR Never Reaches User (HIGH)

**Status:** Confirmed Bug
**Impact:** Users wait in silence during error retries. RESPOND message only emitted as `error_handler_response` trace event, not via `onChunk`.

- `flow-step-executor.ts:524-529` — only trace event, no onChunk call
- `executeToolWithErrorHandling()` has no `onChunk` parameter — structurally impossible to push messages

**Fix:** Pass `onChunk` into `executeToolWithErrorHandling` and call `onChunk(resolution.respond)` after logging the trace event.

---

### 2.3 HANDOFF Action in Error Handlers is Dead Code (HIGH)

**Status:** Confirmed Bug
**Impact:** `THEN: HANDOFF SomeAgent` in ON_ERROR compiles and stores the action string, but no code reads it to trigger routing.

- `reasoning-executor.ts:2314-2317` — `handlerAction` stored in `toolResult` but never consumed
- `ErrorResolution.action` has `'handoff'` as valid value but no caller checks it

**Fix:** After resolving `ErrorResolution`, check `resolution.action === 'handoff'` and call routing engine directly.

---

### 2.4 Error Type System is Tool-Error-Only (HIGH)

**Status:** Confirmed Bug
**Impact:** Only `tool_error` and `DEFAULT` ever fire at runtime. `rate_limit`, `auth_failure`, `network_error`, `tool_timeout` all compile but never match.

- `flow-step-executor.ts:482` and `reasoning-executor.ts:2294` both hardcode `type: 'tool_error'`
- Zero occurrences of other error type strings in runtime execution code

**Fix:** Add `classifyToolError(err)` helper — check timeout, HTTP status codes, socket errors. Map to appropriate error types.

---

### 5.1 Reask Action Defined But Never Executed (HIGH)

**Status:** Confirmed Bug
**Impact:** `reask` is terminal in type system (precedence 4, causes early pipeline exit) but no runtime path regenerates.

- `action-applier.ts:25` — `CONTENT_MODIFYING_ACTIONS` excludes reask
- `reasoning-executor.ts:763` handles `block` and `escalate` but has no `reask` branch

**Fix:** Implement retry loop in reasoning-executor for `action === 'reask'` (re-invoke LLM with regeneration prompt up to `maxReasks` attempts), or remove from type system.

---

### 5.4 Action Applier Uses Default Action, Not Severity-Resolved (HIGH)

**Status:** Confirmed Bug
**Impact:** Severity-specific content-modifying actions (redact/fix/filter) silently do nothing. Only works by accident when severity action is also terminal.

- `pipeline.ts:275` builds action map from guardrail default action
- `tier2-evaluator.ts:154-171` correctly resolves severity-specific action
- `action-applier.ts:51` reads the default, not the resolved one

**Fix:** Store resolved action per violation in the result, or re-resolve at apply time using the violation's severity.

---

### 1.2 Tool Confirmation is Opt-In Only (HIGH)

**Status:** Partially Confirmed
**Impact:** Parameter tampering protection exists and is well-implemented, but only activates with explicit `CONFIRM:` DSL block. High-risk tools (financial, PII-writing) unprotected by default.

- `reasoning-executor.ts:2161` — entire protection gated on `toolDef?.confirmation`
- Hash-based immutability validation, 5-minute TTL, snapshot comparison all work correctly

**Fix:** (1) Compiler lint warning when `side_effects: true` but no `confirmation` block. (2) Default `confirmation.require` to `when_side_effects` for tools with `side_effects: true`.

---

### 3.2 No tool:before or turn:before Recall Events (HIGH)

**Status:** Confirmed Gap
**Impact:** Recalled context only available after extraction/tool call. Agents that need pre-tool context injection (e.g., inject user preferences before search) are silently broken.

- `event-detector.ts:4-8` — taxonomy has no `before` events for tools/turns
- `event-detector.test.ts:80` — test explicitly rejects `tool:search:before`

**Fix:** Add `tool:<name>:before` and `tool:*:before` to taxonomy. Call `executeRecallForEvents` before tool dispatch.

---

### 10.1 Handoff Missing ON_FAILURE (HIGH — Spec Gap)

**Status:** Confirmed
**Impact:** DELEGATE has `on_failure: 'continue' | 'escalate' | 'respond'`. HANDOFF has nothing. Handoff failures are unrecoverable at DSL level.

- `schema.ts:1137-1148` (DelegateConfig has on_failure)
- `schema.ts:1170-1188` (HandoffConfig does not)

**Fix:** Add `on_failure` field to `HandoffConfig` with same semantics as DelegateConfig.

---

## MEDIUM — Plan to Fix

### 5.2 Input Guardrails Evaluated Twice

**Status:** Confirmed | **Severity:** Medium
Input guardrails fire through both the pipeline path and the `checkConstraints` path. Double evaluation, double trace events.
**Fix:** Skip guardrail-only violations in `checkConstraints` after pipeline has run.

### 5.3 result.passed Semantics Inconsistent

**Status:** Confirmed | **Severity:** Medium
`result.passed` stays `true` for redact/fix/filter. Callers using `passed` as proxy for "no rules fired" miss non-terminal violations.
**Fix:** Add `result.modified` boolean. Emit trace events for non-terminal actions regardless.

### 5.5 Streaming Evaluator Checks Chunks in Isolation

**Status:** Confirmed | **Severity:** Medium
Only new content since last check is evaluated. Cross-chunk violations (e.g., phone number split across chunks) missed.
**Fix:** Pass full `this.buffer` to `pipeline.execute` in `evaluateChunk`, not just the new slice.

### 5.6 Provider Registry TTL Drops Providers Mid-Session

**Status:** Confirmed | **Severity:** Medium
Custom providers expire after 5 minutes. Tier-2 evaluator treats missing providers as pass (fail-open).
**Fix:** LRU refresh on access, or make DB-loaded providers permanent (evict only on explicit invalidation).

### 3.1 Remember Triggers Fire Repeatedly (No Dedup)

**Status:** Confirmed | **Severity:** Medium
`evaluateRememberAfterStateChange` called at 4 sites in reasoning-executor, 7 in flow-step-executor. No read-before-write guard. 2-4 redundant DB writes per turn.
**Fix:** Batch-read current values before writing; skip `set()` when value unchanged.

### 3.3 Escalate context_for_human References Undefined Variables

**Status:** Confirmed | **Severity:** Medium
Spec examples use `suggested_resolution` and `relevant_policies` but these are not system variables — they must be manually populated by ABL author. No warning when missing.
**Fix:** Runtime warning trace when `context_for_human` field missing from session at escalation time.

### 4.3 retry_step Has No Backtrack Limit

**Status:** Confirmed | **Severity:** Medium
`goto_step` has `MAX_BACKTRACKS_PER_STEP = 3`. `retry_step` has no limit — infinite loop risk.
**Fix:** Add parallel retry count with same limit.

### 4.6 Backtrack Counts Never Reset

**Status:** Confirmed | **Severity:** Medium
`session.backtrackCounts` persisted in Redis, never cleared. Legitimate revisits to a step hit limits from earlier visits.
**Fix:** Reset counts when session successfully transitions away from the step.

### 9.1 SearchDocument Query Missing Explicit tenantId

**Status:** Confirmed | **Severity:** Medium (High if AsyncLocalStorage fails)
`documents.ts:39` queries by `indexId` only. Plugin injects tenantId via AsyncLocalStorage in normal paths, but not guaranteed in workers/migrations.
**Fix:** Change to `SearchDocument.find({ indexId, tenantId })`.

### 2.2 LOG Directive Not Implemented

**Status:** Confirmed | **Severity:** Medium
LOG does not exist anywhere: no AST field, no parser case, no compiler mapping, no runtime handler.
**Fix:** Add `log?: string` to AST, parse `LOG:` key, emit via `createLogger('error-handler')` at runtime.

### 6.4 Spec Examples Use Invalid FlowStep Fields

**Status:** Confirmed Bug | **Severity:** P1
`COLLECT` and `PROMPT` are not valid top-level FlowStep fields. Compiler silently drops them.
**Fix:** Correct spec examples to use `gather:` with nested fields.

### 10.2 Compiler Downgrades Error Diagnostics to Warnings

**Status:** Confirmed Bug | **Severity:** P2
`compiler.ts:337-344` pushes all diagnostics to `compilationWarnings` regardless of `severity: 'error'`.
**Fix:** Route `severity: 'error'` diagnostics to `compilationErrors` and fail compilation.

### 8.1 PII Redaction Blocks Non-Canonical Field Names

**Status:** Confirmed Bug | **Severity:** P2
PII exemption only works for canonical names (`phone`, `email`, `ssn`). A field named `contact_info` collecting email will be redacted.
**Fix:** Support field-to-PII-type hints in GATHER config, or infer from field validation patterns.

### 6.2 Digression Uses Substring Matching (False Positives)

**Status:** Confirmed Bug | **Severity:** P2
`detectIntentFallback` uses `messageLower.includes(patternLower)` — "help" matches "helpful".
**Fix:** Add word boundary regex: `new RegExp('\\b' + pattern + '\\b', 'i')`.

### 15 Language Fallback Defaults to English

**Status:** Confirmed Bug | **Severity:** P2
When LLM unavailable, language detector defaults to `'en'` — wrong for Spanish-primary deployments like Saludsa.
**Fix:** Make default language configurable per agent/project.

---

## LOW / BY DESIGN

| #   | Issue                                                   | Notes                                                            |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 4.2 | Phase info discarded at compile time                    | Intentional — auto-adds IS NOT SET guards                        |
| 4.4 | Short-circuit defaults to true                          | Known tradeoff — option exists, callers don't use it             |
| 4.5 | Variable extraction regex false positives               | Trace-only impact                                                |
| 5.7 | Cost tracking records data but budget enforcement inert | Recording works; need budget config injection path               |
| 5.8 | Spec action naming (reask vs REGENERATE)                | Update spec table to match IR types                              |
| 9.3 | SharedIndexTracker no tenantId                          | By design — platform-level administrative model                  |
| 9.4 | findById pattern fragile in background jobs             | Broader AsyncLocalStorage concern; auth-repo usage is acceptable |

---

## NOT CONFIRMED

| #             | Claim                                        | Finding                                                                                          |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1.1           | "No tool call parameter validation"          | **Robust validation exists** in `validateToolInputs()` — required fields, types, enums, coercion |
| 9.5           | "WebSocket tenantId from client query param" | **JWT-derived** — tenantId extracted from decoded token                                          |
| 5.8 (partial) | "'both' kind missing from spec"              | Already documented in GUARDRAILS_SPEC.md                                                         |

---

## Competitive Gap Themes

| Theme                     | Cognigy                          | Rasa                                       | Priority |
| ------------------------- | -------------------------------- | ------------------------------------------ | -------- |
| **Testing & Simulation**  | Playbooks, intent simulator      | Story testing, 11 assertion types          | P1       |
| **Versioning & Rollback** | Agent snapshots, A/B deploy      | Model versioning, training data versioning | P1       |
| **Human Handoff Tooling** | Copilot workspace, queue mgmt    | Context-preserving handoff                 | P1       |
| **NLU Training**          | Training UI, confusion matrix    | NLU pipeline, entity annotation            | P2       |
| **Voice & Telephony**     | DTMF/IVR nodes, voice config     | Custom TTS/ASR                             | P2       |
| **Analytics & Debugging** | Conversation analytics dashboard | Story debugging, flow viz                  | P2       |
| **Form/Entity**           | Form nodes with validation UI    | Custom entity extractors                   | P2       |
| **Knowledge**             | Knowledge base integration       | FAQ integration                            | P2       |
| **Multi-channel**         | Channel-specific variants        | Channel connectors                         | P3       |
| **Localization**          | Multi-language UI                | Multi-language NLU                         | P3       |

**ABL advantages acknowledged by Bruce:** multi-agent orchestration, tiered guardrails, behavior profiles, constraint system, DSL-first authoring, contact identity resolution, multi-tenant architecture, real-time voice.

---

## Feature Requests

| #    | Request                                                                  | Priority |
| ---- | ------------------------------------------------------------------------ | -------- |
| 7.1  | Custom extractors in scripted GATHER                                     | P2       |
| 7.2  | Custom regex entities for XO11 migration                                 | P2       |
| 11.1 | Pluggable classifier strategy (LLM/NLU/embedding) for supervisor routing | P2       |
| 12.2 | Chunking strategy comparison tool for Search.AI                          | P3       |

## Documentation Issues

| #   | Issue                                         | Priority |
| --- | --------------------------------------------- | -------- |
| 6.1 | ON_INPUT not documented as deterministic-only | P2       |
| 6.3 | CALL syntax modes undocumented                | P3       |
| 6.5 | ON\_ label interactions undocumented          | P3       |
| 6.6 | Implicit global variables undocumented        | P2       |
| 6.7 | EXECUTION section undocumented                | P2       |
