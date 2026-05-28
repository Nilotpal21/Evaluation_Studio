# LLD Log: Attachments Gap Closure

**Date**: 2026-03-23
**Phase**: LLD
**Feature**: attachments-gap-closure (BETA → STABLE)

## Oracle Decisions

All 15 clarifying questions answered — 0 AMBIGUOUS.

| #   | Classification | Decision                                                                                                  |
| --- | -------------- | --------------------------------------------------------------------------------------------------------- |
| Q1  | DECIDED        | 2-track parallel structure: Track A (GAP-002/006/T1), Track B (GAP-005 sequential phases), GAP-003 hybrid |
| Q2  | ANSWERED       | GAP-005 split into 3 sub-phases: parser+compiler → runtime executor → tests (per HLD)                     |
| Q3  | DECIDED        | GAP-006 before GAP-T1 (7 console spies in existing tests break after migration)                           |
| Q4  | ANSWERED       | Mount project-level attachmentConfigRouter (not multimodal admin route) in PII test harness               |
| Q5  | DECIDED        | Bundle admin router mounting as Task 1 within GAP-003 (1-line change, logically inseparable)              |
| Q6  | ANSWERED       | New `pendingAwaitAttachment` field on AgentThread (structured data, not string sentinel)                  |
| Q7  | ANSWERED       | Add `await_attachment` check just before `respond` in step type ternary (not first, not last)             |
| Q8  | DECIDED        | New file `platform-admin-attachment-config.ts` (matches 10-file pattern for platform-admin routes)        |
| Q9  | DECIDED        | Test doubles in `apps/multimodal-service/src/__tests__/helpers/` (interfaces are local, not shared)       |
| Q10 | ANSWERED       | Inline flow step property within FLOW steps (like GATHER), not top-level section                          |
| Q11 | INFERRED       | Run all runtime tests (8,861 tests) + all compiler tests for full regression coverage                     |
| Q12 | ANSWERED       | Yes — 7 console spies in 3 test files must be updated as part of GAP-006 scope                            |
| Q13 | DECIDED        | Integration test required for admin router mounting (auth verification, 3 test cases)                     |
| Q14 | DECIDED        | Include S-effort contingency for PII bug fixes if unskipped tests reveal issues                           |
| Q15 | ANSWERED       | All 5 gaps closed + tests pass + post-impl-sync + STABLE promotion (per pipeline.md criteria)             |

## Audit Rounds

| Round | Auditor       | Verdict       | CRITICAL | HIGH | MEDIUM | Key Fixes                                                                                                  |
| ----- | ------------- | ------------- | -------- | ---- | ------ | ---------------------------------------------------------------------------------------------------------- |
| 1     | lld-reviewer  | NEEDS_CHANGES | 1        | 4    | 5      | Session serialization (thread-only), 4-layer auth, TenantConfigService instantiation, TraceEvent, Zod body |
| 2     | lld-reviewer  | NEEDS_CHANGES | 0        | 4    | 6      | Parser inline switch, FlowStep property, DecisionKind union, compiler AST→IR naming convention             |
| 3     | lld-reviewer  | NEEDS_CHANGES | 0        | 3    | 5      | Attachment data access (currentAttachmentIds), MIME utility, GATHER test preservation                      |
| 4     | phase-auditor | APPROVED      | 0        | 2    | 1      | Cross-phase consistency passes — all 8 checks OK. SESSION_JSON_FIELDS divergence noted (LLD correct)       |
| 5     | lld-reviewer  | APPROVED      | 0        | 0    | 4      | try/finally for currentAttachmentIds cleanup, buildStepSummary ordering, implementation notes              |

## Key Design Discoveries (from audit rounds)

1. `SESSION_JSON_FIELDS` controls top-level `SessionData` — thread-level fields like `pendingAwaitAttachment` serialize via the `threads` JSON blob automatically
2. `executeFlowStep()` receives `userMessage: string` — no attachment data. Fixed by adding transient `currentAttachmentIds` to `RuntimeSession`
3. Parser uses inline `case` handling in switch, not separate functions per step type
4. `DecisionKind` is the active union in `trace-helpers.ts` (not the dead `DecisionType` in `types.ts`)
5. `stepPropertyKeywords` array must include AWAIT_ATTACHMENT to prevent misparse as step name
