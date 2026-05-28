# SDLC Log: Workflow Copilot Feature Spec

> **Phase**: Feature Spec | **Date**: 2026-03-25 | **Feature**: Workflow Copilot

## Oracle Decisions

| #   | Question                                              | Classification | Decision                                                                                                                                     |
| --- | ----------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should copilot be a separate panel or extend Arch AI? | DECIDED        | Extend Arch AI — reuses infrastructure, avoids UI fragmentation                                                                              |
| 2   | What NL operations are in scope?                      | ANSWERED       | Add/remove/update/rename nodes, add/remove edges, update env vars, update input/output schemas                                               |
| 3   | How does conversation persistence work per-workflow?  | DECIDED        | Extend `arch_conversations` model with optional `contextKey` field, change unique index to `(userId, projectId, contextKey)`                 |
| 4   | What checkpoint strategy?                             | DECIDED        | Snapshot-based stack in Zustand store — simpler than command pattern, handles cascading mutations                                            |
| 5   | How are copilot tools activated?                      | ANSWERED       | Via `PAGE_TO_STAGE` mapping to a workflow-enabled lifecycle stage, `stageUsesWorkflow()` returns true, tools gated by workflow state machine |
| 6   | How does auto-layout work for batch node creation?    | DECIDED        | Create or share auto-layout utility based on existing ELK-based `useAutoLayout` pattern from project canvas                                  |
| 7   | LLM credential resolution?                            | ANSWERED       | Uses Arch's `resolveArchLLMClient()` with 3-tier resolution (Model Hub, Tenant key, Platform env)                                            |

## Phase-Auditor Results

### Round 1

- **Verdict**: NEEDS_REVISION
- **CRITICAL (2)**:
  1. Conversation persistence fabricated — claimed `{projectId}/workflow-{workflowId}` key pattern but actual model uses `(userId, projectId)` unique index. Fixed: designed `contextKey` field extension with index migration.
  2. Tool dispatch incorrectly described — claimed `context.page === 'workflows'` but actual dispatch uses lifecycle stages via `PAGE_TO_STAGE`. Fixed: FR-1 rewritten with correct `PAGE_TO_STAGE` → `stageUsesWorkflow()` → workflow state machine gating.
- **HIGH (5)**: FR-2/FR-5 mixed implementation details, data model missing index impact, canvas-to-steps compatibility not noted, parent ALPHA risk not documented, stale node count comment. All fixed.

### Round 2

- **Verdict**: APPROVED
- **HIGH (2)**:
  1. `useWorkflowAutoLayout` doesn't exist (sibling feature is PLANNED). Fixed: updated all references to "create or share auto-layout utility based on existing ELK-based `useAutoLayout` pattern."
  2. FR-1 incorrectly described adding a new lifecycle stage vs PAGE_TO_STAGE mapping. Fixed in round 1 resolution.

## Files Created

- `docs/features/sub-features/workflow-copilot.md` — Feature spec
- `docs/testing/sub-features/workflow-copilot.md` — Testing guide placeholder
- `docs/sdlc-logs/workflow-copilot/feature-spec.log.md` — This log

## Files Updated

- `docs/features/README.md` — Added to Focused Sub-Feature Modules table
- `docs/features/sub-features/README.md` — Added to Current Sub-Features table
- `docs/testing/README.md` — Added #78 to P3 section
- `docs/testing/sub-features/README.md` — Added to Current Sub-Feature Guides table

## Open Questions

1. How should the system prompt be structured to include all 17 node config schemas concisely (~2-3KB)?
2. Should checkpoint history persist across page navigations in V2?
3. How to handle copilot suggestions that conflict with workflow validation rules?
