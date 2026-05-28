# SDLC Log: Workflow Function Node -- LLD

**Phase**: LLD
**Date**: 2026-04-07
**Feature**: Workflow Function Node with Context Injection

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items.

### Key Decisions

| #   | Classification | Decision                                                                                                       |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Q1  | DECIDED        | Sandbox infra first, then engine integration, then tests (matches feature spec delivery plan)                  |
| Q3  | DECIDED        | Dockerfile change as separate commit before isolated-vm addition                                               |
| Q7  | ANSWERED       | canvas-to-steps transform case does raw config passthrough -- new function case must explicitly extract fields |
| Q8  | ANSWERED       | FunctionNodeConfigSchema has no inputExpression/outputVariable -- schema gap with TransformStep                |
| Q12 | ANSWERED       | Docker Alpine/Debian mismatch is biggest risk                                                                  |
| Q15 | ANSWERED       | No existing canvas-to-steps tests exist; no breakage risk from mapping change                                  |

## Implementation Summary

- 7 phases: Infrastructure, Core executor, Engine wiring, Studio UI, Unit tests, Integration tests, E2E tests
- 4 new files, 8 modified files, 0 deleted files
- ~200 LOC production code, ~900 LOC test code
- Key risk: Node.js version mismatch (24 builder vs 22 production)

## Audit Rounds

### Round 1 (lld-reviewer) — NEEDS_REVISION

**CRITICAL findings (fixed):**

- Node version mismatch: builder node:24-slim compiled native modules incompatible with production nodejs22. Fixed by changing to node:22-slim.
- StepError interface lacks line/column fields. Fixed with D-7 decision to embed in message string.

**HIGH findings (fixed):**

- Missing atomicity note for canvas-to-steps mapping + convertNodeToStep case (must be same commit).

### Round 2 (lld-reviewer) — NEEDS_REVISION

**HIGH findings (fixed):**

- Console logs captured by executor but lost in dispatchStep. Fixed by adding consoleLogs field to StepDispatchResult and specifying full persistence path through workflow-handler.ts.

### Round 3 (lld-reviewer) — NEEDS_REVISION

**CRITICAL findings (fixed):**

- consoleLogs persistence incomplete: ExecutionPersistence interface and ExecutionStore not in modified files. Fixed by adding both to modified files table and wiring checklist.
- HLD error response showed line/column as separate JSON fields, contradicting D-7. Fixed by updating HLD Section 6.

### Round 4 (phase-auditor) — NEEDS_REVISION

**CRITICAL findings (fixed):**

- Feature spec FR-10 still specified line/column as separate StepError fields, contradicting D-7. Fixed by updating FR-10 to explicitly state embedded in message string.

**HIGH findings (fixed):**

- canvas-to-steps atomicity requirement not cross-referenced in wiring checklist.

### Round 5 (lld-reviewer) — APPROVED

**Remaining MEDIUM findings (logged, not blocking):**

- consoleLogs persistence implementation detail (exact field name in ExecutionStore)
- Logging pattern for function-executor.ts (createLogger vs console)
- Feature spec env vars header vs constants in code

**Verdict**: APPROVED — no CRITICAL or HIGH findings remaining.
