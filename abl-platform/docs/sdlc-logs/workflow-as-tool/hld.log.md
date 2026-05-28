# SDLC Log — workflow-as-tool — HLD phase

**Date**: 2026-04-13
**Skill**: /hld
**Inputs**: docs/features/workflow-as-tool.md, docs/testing/workflow-as-tool.md
**Output**: docs/specs/workflow-as-tool.hld.md

## Oracle decisions (Phase 2)

All clarifying questions resolved without user escalation. Key decisions:

| Area                       | Decision                                                                                                                                      | Class    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Architecture pattern       | Peer `WorkflowToolExecutor` service in `apps/runtime`, mirroring SearchAI KB executor                                                         | DECIDED  |
| Data flow                  | Request-path only (agent turn); no event bus, no worker                                                                                       | INFERRED |
| Scale                      | Per-session executor; agent-level `executeParallel` ≤ 3 concurrent calls per turn                                                             | INFERRED |
| Existing patterns to reuse | `llm-wiring.ts:917-994` SearchAI block; `tool-binding-executor.ts:573-582` dispatcher; IR `schema.ts:881-886` already has `WorkflowBindingIR` | ANSWERED |
| Deployment topology        | No new service; runs inside `apps/runtime` pod, calls existing workflow-engine pod                                                            | DECIDED  |
| External dependencies      | None new; native fetch for engine HTTP                                                                                                        | ANSWERED |
| API contract changes       | Additive: `toolType: 'workflow'` accepted at existing tool-create endpoint; no new engine routes                                              | DECIDED  |
| Compile/deploy lifecycle   | DSL parse → IR validate → IR load → executor dispatch                                                                                         | ANSWERED |
| Technical risks            | (1) sync poll tail latency 2s, (2) mixed engine error envelope, (3) stale bindings after workflow archive                                     | INFERRED |
| Data migration             | None — additive enum value                                                                                                                    | DECIDED  |
| Rollback                   | Revert commit; WORKFLOW_ENGINE_URL is shared not exclusive; kill-switch via DB archive of workflow tools                                      | DECIDED  |
| Feature flag               | None in v1                                                                                                                                    | DECIDED  |

Full oracle output lives in conversation history (Phase 2 spawn).

## Audit rounds (Phase 4b)

### Round 1 — NEEDS_REVISION

2 CRITICAL + 3 HIGH + 2 MEDIUM findings. Resolved:

- CRITICAL: engine returns flat-string error envelope, not `{code,message}`. Added normalization strategy in Concern #5 and cross-referenced from API Contract (Concern #3) and Error Responses table.
- CRITICAL: `WorkflowBindingIR.triggerId` is a breaking interface change if declared required. Changed to optional at type level with runtime validator enforcement; documented additive-safe change policy.
- HIGH: rollback plan underspecified — expanded to cover `WORKFLOW_ENGINE_URL` sharing, in-flight session behavior, blast radius on other tool types, and data readability after revert.
- HIGH: error normalization strategy missing — enumerated engine 404 / 502 / network / terminal / timeout mappings.
- HIGH: `paramMapping` type ambiguity between DSL (`<json>`) and IR (`Record<string,string>`). Clarified as flat JSONPath map; DSL comment updated to `<json-object>`.
- MEDIUM: test spec HLD reference was `_not yet authored_` — updated to `docs/specs/workflow-as-tool.hld.md`.

### Round 2 — NEEDS_REVISION

3 HIGH + 2 MEDIUM findings. Resolved:

- HIGH: engine error envelope is **mixed** (flat strings AND structured `{code,message}` for specific cases `INVALID_EXECUTION_ID`, `INVALID_TRIGGER_TYPE`, `DUPLICATE_NODE_NAMES`, `RESTATE_START_FAILED`). Added shape-check normalization.
- HIGH: cancel-on-timeout 409 (execution already terminal) not handled — added "log debug, swallow 409, keep surfacing original timeout error".
- HIGH: `triggerId` shown as top-level POST body field, but engine ignores it — moved into `triggerMetadata` with annotation that engine does not route by it. Propagated to feature spec + test spec.
- MEDIUM: execute endpoint 202 response shape clarified as `{ success:true, executionId }`.
- MEDIUM: `RESTATE_START_FAILED` 502 now forwards engine detail instead of generic text.

### Round 3 — APPROVED

Zero CRITICAL/HIGH/MEDIUM findings. One non-blocking cross-phase consistency warning: stale `triggerId`-as-top-level-field references in feature spec (line 124) and test spec INT-1 (line 170). Both fixed in the same round to keep artifacts in sync.

## Artifact state

- Design-lint: **95%** (19 of 20 checks; 1 warning for open-questions section — intentional, 3 genuine items remain).
- All 12 architectural concerns addressed with concrete decisions (no hand-waves).
- 3 alternatives evaluated (Option A: peer executor — recommended; Option B: workflow SDK; Option C: auto-expose).
- Data model is fully additive (enum extension only; no new collections).
- API design reuses all 4 existing endpoints; no new routes.

## Next phase

- Run `/lld workflow-as-tool` → produces `docs/plans/2026-04-13-workflow-as-tool-impl-plan.md`.
- Open questions to resolve during LLD:
  1. Workflows with `auth.type === 'user_level'` on webhook trigger — block in v1 or propagate agent `userId`?
  2. Stale-binding UX when source workflow is archived/deleted.
  3. Async companion "wait-for-execution" tool — defer or include.
