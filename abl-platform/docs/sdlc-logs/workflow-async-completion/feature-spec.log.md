# SDLC Log: workflow-async-completion — Feature Spec Phase

**Feature**: workflow-async-completion
**Phase**: FEATURE-SPEC
**Date**: 2026-04-14

---

## Oracle Session

**Questions asked**: 15 (5 per section: Scope, User Stories, Technical)
**Classification breakdown**: 0 ANSWERED, 0 INFERRED, 15 DECIDED, 0 AMBIGUOUS
**User escalations**: None required

### Key Decisions

| #    | Decision                                             | Rationale                                                                    |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| D-1  | Auto-register companion `check_workflow_status` tool | Follows `buildTools()` dynamic system tool pattern in prompt-builder.ts      |
| D-2  | Push result injected as new turn (system message)    | Async tool already returned; no pending tool_use slot; stateless-distributed |
| D-3  | Store result in Redis with 24h TTL if session ended  | Prevents data loss; polling can retrieve later                               |
| D-4  | Both mechanisms always available for async tools     | No per-tool config complexity                                                |
| D-5  | Push primary, polling fallback                       | Event-driven is lower latency                                                |
| D-6  | Polling tool is read-only (no cancel in v1)          | Security: LLM-initiated cancellation needs guardrails                        |
| D-7  | Push result as system message, not tool_result       | No orphan tool_results in conversation history                               |
| D-8  | Async response includes polling instructions         | Gives LLM actionable context                                                 |
| D-9  | Rely on existing CallbackDeliveryWorker retry config | 3 attempts + exponential backoff already configured                          |
| D-10 | Session-scoped polling                               | User-isolation invariant                                                     |
| D-11 | Use BullMQ CallbackDeliveryWorker, not Redis pub/sub | Durable delivery with retries                                                |
| D-12 | REST endpoint + optional WebSocket notification      | REST is durable; WS is real-time UX                                          |
| D-13 | Well-known internal URL for callback                 | Simpler than dynamic URL registry                                            |
| D-14 | Separate internal-service signing key                | Isolates internal from external secret                                       |
| D-15 | Agent-driven single-call polling, no backoff         | Each poll is an LLM tool call; agent controls timing                         |

---

## Audit Round 1

**Verdict**: NEEDS_REVISION
**Findings**: 2 CRITICAL, 5 HIGH, 2 MEDIUM

### Fixes Applied

- CRITICAL: FR-9 — specified `webhookSecret(tenantId, source?)` interface widening and `CallbackJobData.source` field
- CRITICAL: §7 — specified exact injection mechanism (`StoreFactory.addMessage()`, passive append, no auto-LLM-turn)
- HIGH: FR-3 — removed pod-local cache, two-tier fallback (Redis → GET) per stateless-distributed invariant
- HIGH: FR-5 — added response contract (200/401/500 with bodies)
- HIGH: FR-6/§9 — Redis key includes `projectId`; value includes `sessionId` and `projectId`
- HIGH: §1 — acknowledged this implements deferred non-goal from parent spec
- MEDIUM: §13 — added task 6 for tests committed separately
- MEDIUM: §17 — promoted scenario 5 to e2e (5 e2e scenarios)

## Audit Round 2

**Verdict**: NEEDS_REVISION (minor)
**Findings**: 1 CRITICAL, 1 HIGH, 2 MEDIUM

### Fixes Applied

- CRITICAL: FR-6/§7 — corrected store class from `MongoConversationStore.addMessages()` to `StoreFactory.addMessage({ sessionId, role: 'system', ... })`
- HIGH: §7 — corrected `WebSocketManager.emitToSession()` to acknowledge this is NEW functionality (not existing pattern), added note about `broadcastToSession` helper
- HIGH: §17 — added cross-tenant E2E scenario (row 6), now 6 e2e scenarios
- MEDIUM: Remaining — `startedAt` in Redis value deferred (non-blocking)
