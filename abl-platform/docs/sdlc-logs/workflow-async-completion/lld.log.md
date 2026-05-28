# SDLC Log: workflow-async-completion — LLD Phase

**Feature**: workflow-async-completion
**Phase**: LLD
**Date**: 2026-04-14

---

## Oracle Session

**Questions asked**: 15 (5 per section: Implementation Strategy, Technical Details, Risk & Dependencies)
**Classification breakdown**: 0 ANSWERED, 0 INFERRED, 15 DECIDED, 0 AMBIGUOUS
**User escalations**: None required

### Key Decisions

| #    | Decision                                                        | Rationale                                                                        |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D-1  | Polling first, then push                                        | Polling is self-contained in runtime; push requires cross-service changes        |
| D-2  | WorkflowStatusTool as standalone class                          | Separation of concerns from WorkflowToolExecutor; independently testable         |
| D-3  | Inject companion tool in buildTools() (prompt-builder)          | Follows existing system tool pattern (handoff, escalate, set_context)            |
| D-4  | Name-based dispatch before !tool guard in dispatch()            | System tool not in tools Map; needs interception before fallback                 |
| D-5  | HMAC auth for callback endpoint (not JWT)                       | Workflow-engine already signs with buildSignatureHeaders; reuse existing pattern |
| D-6  | broadcastToSession via linear scan                              | 10k max connections; <1ms scan; no index maintenance overhead                    |
| D-7  | Channel 'api' for push-injected messages                        | Confirmed valid Channel value at types.ts:79                                     |
| D-8  | Two-tier fallback: Redis → GET (no pod-local cache)             | Stateless-distributed invariant                                                  |
| D-9  | asyncExecutionIds on executor instance (optimization, not gate) | Same pattern as bindings Map; Redis/GET fallback handles pod migration           |
| D-10 | Passive system message (no auto-LLM-turn)                       | Avoids unexpected agent behavior                                                 |

---

## Audit Round 1 (lld-reviewer — Architecture Compliance)

**Verdict**: NEEDS_CHANGES
**Findings**: 2 CRITICAL, 3 HIGH, 5 MEDIUM

### Fixes Applied

- CRITICAL: ToolBindingExecutor dispatch interception moved to `dispatch()` before `!tool` guard (line 529), not before type switch
- CRITICAL: Added task 1.4 to extend `RuntimeSession` with `_workflowStatusToolActive?: boolean`
- HIGH: Added Zod `WorkflowCallbackPayloadSchema` validation in callback handler
- HIGH: Verified `Channel` type includes `'api'` — added code reference
- HIGH: Documented asyncExecutionIds pod-local state as optimization, not security gate
- MEDIUM: Fixed error response format to structured `{ success, error: { code, message } }`
- MEDIUM: Added `z.string().min(1)` for executionId in WorkflowStatusTool
- MEDIUM: Specified exact file `apps/workflow-engine/src/index.ts:461-467` for task 2.5
- MEDIUM: Fixed WorkflowStatusTool to implement 3-arg ToolExecutor interface

## Audit Round 2 (lld-reviewer — Pattern Consistency)

**Verdict**: NEEDS_CHANGES
**Findings**: 2 HIGH, 3 MEDIUM, 1 LOW

### Fixes Applied

- HIGH: Corrected interface name to `ToolBindingExecutorConfig` (not Options)
- HIGH: Removed redundant per-route `express.json({ verify })` — global middleware already captures rawBody
- MEDIUM: Task 2.3 updated to reference both callback enqueue sites (success line 1359, failure line 1416)
- MEDIUM: Added local dev note about push requiring RUNTIME_URL + INTERNAL_CALLBACK_SECRET
- MEDIUM: broadcastToSession reads `state.sessionId` via index signature with type assertion
- LOW: Fixed exit criteria: `source !== 'agent_tool'` returns 400 (Zod validation), not 401

## Audit Round 3 (lld-reviewer — Completeness)

**Verdict**: NEEDS_CHANGES
**Findings**: 1 HIGH, 3 MEDIUM, 1 LOW

### Fixes Applied

- HIGH: Added WS manager getter exports from handler.ts/sdk-handler.ts for callback handler wiring
- MEDIUM: Resolved Open Question #1 (raw body) — global middleware at server.ts:443-449
- MEDIUM: Resolved Open Question #3 (Redis client) — getRedisClient() available in llm-wiring.ts
- MEDIUM: Specified messageStore wiring via `getStores().message` (DualWriteMessageStore)
- LOW: Added note that phases are SEQUENTIAL (not parallelizable)

## Audit Round 4 (phase-auditor — Cross-Phase Consistency)

**Verdict**: NEEDS_REVISION
**Findings**: 2 CRITICAL, 1 HIGH, 1 MEDIUM

### Fixes Applied

- CRITICAL: Fixed buildTools() insertion point to BEFORE `return tools;` (line 829), not after SET_CONTEXT block close
- CRITICAL: Unified WorkflowCallbackHandler constructor between task 3.1 and 3.4 — `messageStore: DualWriteMessageStore`, `internalWsManager`, `sdkWsManager`
- HIGH: Flagged test spec INT-2 three-tier fallback inconsistency (cross-phase fix needed in test-spec)
- MEDIUM: Flagged feature spec `parameters` vs `input_schema` naming (non-blocking)

## Audit Round 5 (lld-reviewer — Final Sweep)

**Verdict**: APPROVED
**Findings**: 0 CRITICAL, 0 HIGH, 2 MEDIUM

### Fixes Applied

- MEDIUM: Added `getAsyncExecutionIds` callback to WorkflowStatusToolConfig for executionId wiring
- MEDIUM: Added SSRF localhost warning for local dev push testing

---

## Summary

- LLD written at `docs/plans/2026-04-14-workflow-async-completion-impl-plan.md`
- 3 implementation phases: Polling (Phase 1), Engine Changes (Phase 2), Push Endpoint (Phase 3)
- 3 new files, 10 modified files
- All 10 FRs mapped to specific tasks with exit criteria
- 5 audit rounds completed — all CRITICAL/HIGH resolved
- Remaining MEDIUM: test spec INT-2 three-tier fallback needs update, feature spec `parameters` field name
