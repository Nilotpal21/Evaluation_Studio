# Test Spec Log — Workflow Canvas Context Suggestions

**Date**: 2026-05-04
**Phase**: TEST-SPEC
**Artifact**: `docs/testing/sub-features/workflow-canvas-context-suggestions.md`
**Status**: APPROVED (round 2)

---

## Oracle Decisions

All 15 clarifying questions were answered autonomously (ANSWERED or INFERRED). No AMBIGUOUS items — no user escalation required.

| #   | Decision                                                                                             | Classification | Rationale                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| D-1 | No form validation error E2E scenarios needed                                                        | DECIDED        | Expression authoring is insert-only; no save-time validation by design                          |
| D-2 | Integration boundaries: Hook+Store, ExpressionInput+ContextExplorer, NodeConfig+ExpressionInput+Hook | DECIDED        | Three compositional layers where bugs can hide; pure functions already extracted                |
| D-3 | Race conditions are low-risk; one rapid-typing unit test covers it                                   | DECIDED        | All state updates synchronous in onChange handler; no async/debounce in `{{` detection          |
| D-4 | E2E execution-tier tests (E2E-2, 3, 6) use Function nodes, not TextToText/Agent                      | DECIDED        | Function nodes are deterministic; TextToText requires LLM credentials (non-deterministic in CI) |
| D-5 | Zustand store populated via `store.setState()` in unit/integration tests (no vi.mock)                | INFERRED       | Zustand testing pattern; CLAUDE.md forbids mocking platform components                          |

---

## Audit Summary

### Round 1 — NEEDS_REVISION

**CRITICAL fixed:**

- INT-4 expected result: added all agentContext leaves (invocation.tool, invocation.args, messageMetadata, attachments sub-fields)

**HIGH fixed:**

- E2E-2: replaced "mock agent" with Function node `FnUrl0001` (deterministic, no LLM)
- E2E-3: replaced TextToText node with Function node `FnStatus0001`
- E2E-6: replaced "API node" with Function node `FnList0001` with rationale
- Coverage matrix: relabelled "FR-4 error" → "FR-5 error path"
- E2E-1: added step 9 asserting `{{{{` does NOT appear (brace-doubling regression guard)
- File mapping: updated to "E2E-1 through E2E-6, E2E-ERR-1, E2E-ERR-2"
- Data seeding: added Zustand store pattern reference + `__tests__/` directory creation prerequisite

### Round 2 — APPROVED

No CRITICAL, HIGH, or MEDIUM findings. All round-1 fixes verified.

---

## Files Created/Updated

- `docs/testing/sub-features/workflow-canvas-context-suggestions.md` — full test spec (8 E2E, 8 integration, 8 unit scenarios)
- `docs/testing/README.md` — added row 96b
- `docs/features/sub-features/README.md` — added entry
- `docs/testing/sub-features/workflow-canvas-context-suggestions.md` — status PLANNED → IN PROGRESS
- `apps/studio/src/components/workflows/agents.md` — 4 learnings appended

---

## Open Testing Questions

1. data-testids missing from ExpressionInput and ContextExplorer — must add before E2E tests
2. `useWorkflowCanvasStore.setState()` pattern not yet demonstrated in any existing unit test
3. E2E-2/3/6 require Runtime (3112) + workflow-engine; tag `@requires-engine` in spec
4. happy-dom cursor simulation reliability for `selectionStart`/`selectionEnd` tests
5. GAP-006 rename-cascade test — BLOCKED until cascade feature implemented
