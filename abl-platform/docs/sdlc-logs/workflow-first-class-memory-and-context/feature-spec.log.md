# Feature Spec Log — workflow-first-class-memory-and-context

**Date**: 2026-04-27
**Skill**: `/feature-spec`
**Artifact**: `docs/features/sub-features/workflow-first-class-memory-and-context.md`
**Testing Placeholder**: `docs/testing/sub-features/workflow-first-class-memory-and-context.md`
**Related Parents**: `workflows`, `memory-sessions`, `workflow-as-tool`, `workflow-function-node`

---

## Phase 1 — Discovery & Clarification

### Prior art consulted

- `docs/features/workflows.md`
- `docs/features/workflow-as-tool.md`
- `docs/features/memory-sessions.md`
- `docs/features/sub-features/workflow-function-node.md`
- `docs/features/sub-features/variable-resolution.md`
- `apps/workflow-engine/src/context/expression-resolver.ts`
- `apps/workflow-engine/src/executors/function-executor.ts`
- `apps/workflow-engine/src/handlers/workflow-handler.ts`
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts`
- `apps/runtime/src/services/execution/tool-memory-bridge.ts`
- `apps/runtime/src/services/execution/memory-integration.ts`
- `apps/runtime/src/services/stores/mongodb-fact-store.ts`
- `packages/database/src/models/fact.model.ts`
- `packages/compiler/src/platform/ir/schema.ts`

### Clarification pass

The user provided final requirements directly:

1. Workflows need read-only access to first-class `agentSession` and `agentContext`.
2. Workflows need first-class persistent `memory` available across all trigger types.
3. `memory`, `agentSession`, and `agentContext` must be first-class workflow objects.

An oracle-style sub-agent was invoked to classify scope, personas, and constraints. It returned repository-grounded guidance plus two important open questions:

- the exact function-node `memory` API shape remains unresolved
- the unavailable-object shape for non-agent runs remains unresolved

### Oracle classification summary

- ANSWERED: 5
- INFERRED: 2
- DECIDED: 6
- AMBIGUOUS: 2

### Oracle-guided decisions adopted in the spec

| #   | Decision                                                                                                               | Reason                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D-1 | Document as a **workflow sub-feature**                                                                                 | Primary impact is workflow authoring/runtime semantics, not a new platform-wide subsystem |
| D-2 | Keep `agentSession` and `agentContext` **read-only**                                                                   | Matches user requirement and existing code-tool mental model                              |
| D-3 | Reserve `agentSession` / `agentContext` for all workflows but materialize real data only for **agent-originated** runs | Avoids fabricating agent state for non-agent triggers                                     |
| D-4 | Keep v1 focused on **authoring/runtime object semantics**, not new admin/debug UI                                      | Bounded scope for the first feature slice                                                 |
| D-5 | Reuse existing persistent fact-store behavior, including the **90-day default TTL**                                    | Grounded in current runtime/store behavior                                                |
| D-6 | Keep isolation explicit at tenant/project/user boundaries and fail closed                                              | Required by repo invariants and fact-store ownership model                                |

### Main-thread correction to oracle guidance

One oracle suggestion was **not** adopted as-is:

| Item        | Oracle Suggestion                                                     | Final Spec Decision                                                               | Reason                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope model | Reuse `execution_tree` as the workflow-facing “workflow memory” scope | Introduce a **logical `memory.workflow.*` scope** layered on existing persistence | `execution_tree` is not a cross-invocation durable memory surface, while the user requirement explicitly asks for persistent workflow memory across triggers and invocations |

---

## Phase 2 — Generation

Created:

- `docs/features/sub-features/workflow-first-class-memory-and-context.md`
- `docs/testing/sub-features/workflow-first-class-memory-and-context.md`

Key decisions embodied in the spec:

1. Three first-class workflow objects: `memory`, `agentSession`, `agentContext`
2. `agentSession` / `agentContext` are read-only and agent-run-only
3. `memory` is trigger-agnostic and persistent
4. Expressions read first-class objects directly
5. Function nodes get direct globals and explicit writable memory operations
6. Persistent memory inherits the current 90-day default TTL with per-write TTL override
7. Workflow memory is treated as a logical workflow scope over existing fact persistence rather than inventing a second store

---

## Phase 3 — Testing Guide Placeholder

Created `docs/testing/sub-features/workflow-first-class-memory-and-context.md` with:

- feature metadata
- current state
- coverage matrix
- 4 planned E2E scenarios
- 4 planned integration scenarios
- manual validation notes

Status is intentionally **PLANNED** because implementation has not started.

---

## Phase 4 — Index Updates

Updated:

- `docs/features/README.md`
- `docs/features/sub-features/README.md`
- `docs/testing/README.md`
- `docs/testing/sub-features/README.md`

---

## Phase 4b — Manual Audit Pass

Performed a manual audit pass against `docs/features/TEMPLATE.md` and `docs/features/AUTHORING_GUIDE.md`.

### Audit fixes applied

1. Added an explicit Surface Semantics Matrix because the feature exposes new runtime objects across authoring/runtime boundaries.
2. Made the TTL contract explicit and aligned it with current fact-store behavior instead of leaving retention implicit.
3. Converted the workflow memory storage model into a logical scope layered on existing facts storage to stay grounded in repo evidence.
4. Marked the function-node `memory` API shape as an open question rather than guessing the final JS contract.
5. Kept debug-surface expansion out of v1 scope to match the bounded feature slice.

---

## Phase 5 — Commit & Logs

No commit created in this phase.

### Package agents.md updates

Not applicable. This phase creates documentation only.

### Next phase

Run `/test-spec workflow-first-class-memory-and-context` next to turn the placeholder guide into a full test specification.
