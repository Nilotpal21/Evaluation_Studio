# SDLC Log: Workflow Function Node -- Test Spec

**Phase**: TEST-SPEC
**Date**: 2026-04-07
**Feature**: Workflow Function Node with Context Injection

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. No AMBIGUOUS items.

### Key Decisions

| #   | Classification | Decision                                                                                                                     |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Q1  | INFERRED       | FR-6/FR-7 (timeout/memory) highest risk; FR-2 (context injection) and FR-4 (atomic setVar) second                            |
| Q3  | ANSWERED       | Every executor has a unit test file. Engine-level E2E in e2e-basic.test.ts. Pattern: pure function tests with makeCtx()      |
| Q4  | INFERRED       | Use REAL isolated-vm (no mocking). Only mock ExecutionPersistence/StatusPublisher via DI for engine-level tests              |
| Q7  | DECIDED        | No additional auth combinations needed -- function nodes introduce no new permissions                                        |
| Q10 | ANSWERED       | Established helpers: loginAndSetup, createWorkflowViaUI, waitForCanvasReady, addNodeViaHandleMenu, saveWorkflow, runWorkflow |
| Q13 | DECIDED        | No additional isolation scenarios beyond spec scenario #21 -- function nodes are computation-only                            |

## Coverage Summary

- **20 unit test scenarios** (UT-1 through UT-20)
- **7 integration test scenarios** (INT-1 through INT-7)
- **7 E2E test scenarios** (E2E-1 through E2E-7)
- **All 15 FRs mapped** in coverage matrix
- **Security checklist**: 15 items verified via INT/UT cross-references, 5 N/A with justification

## Files Created/Updated

- `docs/testing/sub-features/workflow-function-node.md` -- Full test spec (overwrite of placeholder)
- `docs/sdlc-logs/workflow-function-node/test-spec.log.md` -- This log
