# SDLC Log: Workflow Function Node -- Post-Implementation Sync

**Feature**: workflow-function-node
**Phase**: POST-IMPL-SYNC
**Date**: 2026-04-07

---

## Documents Updated

- [x] Feature spec: `docs/features/sub-features/workflow-function-node.md`
  - Status: PLANNED -> ALPHA
  - S10: Added persistence, constants, infrastructure, and integration test file sections
  - S11: Corrected "Environment Variables" -> "Constants" per D-6 decision
  - S16: GAP-006 marked Mitigated (Dockerfile switched to node:22-slim, isolated-vm v6.1.2)
  - S17: All 21 test rows updated NOT TESTED -> TESTED with test IDs
  - Fixed duplicate entry in sub-features README
- [x] Test spec: `docs/testing/sub-features/workflow-function-node.md`
  - Status: PLANNED -> IN PROGRESS
  - Coverage matrix: All 15 FRs marked with checkmarks and TESTED status
- [x] Testing index: `docs/testing/README.md`
  - Added row B04 for Workflow Function Node (7 E2E, 8 integration, ALPHA 04-07)
  - Updated summary counts (83 -> 84)
  - Updated Last Updated date
- [x] HLD: `docs/specs/workflow-function-node.hld.md`
  - Status: DRAFT -> APPROVED
- [x] LLD: `docs/plans/2026-04-07-workflow-function-node-impl-plan.md`
  - Status: APPROVED -> DONE

## Coverage Delta

| Type              | Before | After |
| ----------------- | ------ | ----- |
| Unit tests        | 0      | 20    |
| Integration tests | 0      | 8     |
| E2E tests         | 0      | 7     |

## Remaining Gaps

- GAP-001: No Python support (Phase 2)
- GAP-002: No custom_script mode (Phase 2)
- GAP-003: No Monaco editor
- GAP-004: No isolate pooling
- GAP-005: No context-aware autocomplete
- E2E tests require real services (not yet verified in CI)

## Deviations from Plan

- `isolated-vm` pinned to v6.1.2 (not v5.0.1) -- v5 does not compile on Node 24
- Dockerfile builder switched from Alpine to `node:22-slim` for native module compatibility
- `ExternalCopy.copyInto()` does not preserve host-side `Object.freeze` -- deep-freeze applied inside isolate script
- V8 sloppy mode silently ignores writes to frozen objects (no TypeError)
- V8 completion value unreliable for object literals -- `setOutput()` is the recommended pattern
- OOM disposes isolate before catch block -- error is "Isolate is already disposed"
- Constants are compile-time (constants.ts), not environment variables per D-6
