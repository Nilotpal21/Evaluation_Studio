# SDLC Log: Workflow Function Node — Feature Spec

**Phase**: FEATURE-SPEC
**Date**: 2026-04-07
**Feature**: Workflow Function Node with Context Injection

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items — no user escalation needed.

### Key Decisions (DECIDED by oracle)

| #   | Decision                                      | Rationale                                                               |
| --- | --------------------------------------------- | ----------------------------------------------------------------------- |
| D-1 | Pure computation only — no network/FS/I/O     | isolated-vm enforces this; HTTP/connector steps exist for I/O           |
| D-2 | Defer custom_script mode to Phase 2           | Requires new MongoDB collection + CRUD API                              |
| D-3 | Defer per-tenant quotas                       | Workflow concurrency limit (100/tenant) already bounds script execution |
| D-4 | Expose full WorkflowContextData as read-only  | Consistent with expression resolver; no cross-tenant risk               |
| D-5 | Structured SCRIPT_ERROR + debug panel display | Reuses existing infrastructure                                          |
| D-6 | No data model changes in Phase 1              | Existing schemas support arbitrary input/output                         |

### Key Findings (ANSWERED)

- `SCRIPT_ERROR` code already exists in `step-errors.ts:L16`
- `FunctionNodeConfigSchema` already complete in `workflow-schemas.ts:L122-138`
- `FunctionNodeConfig.tsx` UI exists but uses plain textarea (no Monaco)
- `canvas-to-steps.ts:L49` maps `function` -> `transform` (the stub)
- `SandboxRunner` interface exists in compiler package but targets container/Lambda backends (too heavyweight)

## Files Created

- `docs/features/sub-features/workflow-function-node.md` — Feature spec
- `docs/testing/sub-features/workflow-function-node.md` — Testing guide placeholder
- `docs/sdlc-logs/workflow-function-node/feature-spec.log.md` — This log

## Files Updated

- `docs/features/sub-features/README.md` — Added index entry
- `docs/testing/sub-features/README.md` — Added index entry

## Open Questions

1. Return value semantics: bare `return` vs `workflow.setOutput()` only
2. Async/await support in scripts
3. Isolate pooling (Phase 1 vs deferred)
4. Console.log serialization depth
5. isolated-vm native module Dockerfile impact
