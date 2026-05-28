# LLD: Studio / Arch Routing Parity Hardening

**Feature Spec**: N/A (audit-driven hardening)
**HLD**: N/A (surgical parity follow-on)
**Test Spec**: N/A (slice-locked by targeted Studio regressions)
**Related Plans**:

- `docs/plans/2026-05-02-action-handler-canonical-hardening.lld.md`
- `docs/plans/2026-05-02-action-handler-end-to-end-hardening.lld.md`

**Status**: DONE (implemented 2026-05-02; targeted Studio regressions green; root filtered build still blocked by an unrelated current-worktree `@agent-platform/web-sdk` type error)
**Date**: 2026-05-02

---

## 1. Problem Statement

The canonical runtime and compiled topology paths already understand action-handler `do[]`, but a few Studio and Arch side paths still reason from narrower legacy routing shapes:

- `in-project-tools` still derives mutation impact and `read_topology` edges from top-level `handoff` / `delegate` / `escalate` only.
- `health-check` still validates and traverses only top-level handoff targets, so delegate-only and action-handler-routed systems can be misclassified.
- `cross-agent-validator` still scans raw `TO:` tokens instead of the parsed modern routing surfaces.
- `AgentListPage` still falls back to a lightweight topology extractor that misses action-handler `HANDOFF` / `DELEGATE` edges.

This leaves a split-brain between the canonical Studio topology route and alternate Studio / Arch tooling surfaces. The hardening goal is to make every remaining routing-aware surface either consume one canonical parser-based extractor or use an explicitly mirrored lightweight fallback contract.

---

## 2. Design Decisions

| #   | Decision                                                                                                 | Rationale                                                                                                                                 | Alternatives Rejected                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| D-1 | Introduce one shared Studio routing-edge extractor for parsed documents.                                 | `in-project-tools`, `health-check`, `topology-ops`, and validators should not each hand-roll action-handler traversal.                    | Patching each caller independently would reintroduce omission drift.                                          |
| D-2 | Keep the server-side source of truth parser-based.                                                       | The parser already owns canonical `onAction` / `actionHandlers` structure and should be the authority for Studio / Arch analysis.         | Regex-only extraction on the server would stay brittle and drift from the DSL grammar.                        |
| D-3 | Keep the client fallback lightweight, but explicitly mirror inline `- HANDOFF:` / `- DELEGATE:` actions. | `AgentListPage` should not depend on the full parser bundle, but it still needs parity for the modern authored routing forms it displays. | Pulling the parser into the client fallback would be heavier and unnecessary for a best-effort mini-topology. |
| D-4 | Health and validation surfaces should reason about routing targets, not just `HANDOFF TO:` lines.        | Missing-target, cycle, and orphan checks should reflect the real execution graph that users author today.                                 | Preserving handoff-only semantics would keep false negatives and false orphan warnings live.                  |
| D-5 | Lock each consumer slice directly.                                                                       | Shared-helper tests catch traversal regressions, and consumer tests catch wiring drift.                                                   | One broad E2E would not localize which surface regressed.                                                     |

---

## 3. Module Boundaries

| Module                                                   | Responsibility                                                                             | Depends On                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `apps/studio/src/lib/arch-ai/routing-edge-extraction.ts` | Canonical routing-edge extraction from parsed AST plus lightweight DSL fallback extraction | parsed ABL AST shape, lightweight regex helpers |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`  | Proposal impact and `read_topology` consumer of the canonical routing extractor            | shared routing extractor, project agent loader  |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts`      | Routing-target validation and reachability checks                                          | shared routing extractor, parsed ABL            |
| `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`   | ABL-vs-topology consistency validation                                                     | shared routing extractor, parsed ABL            |
| `apps/studio/src/components/agents/AgentListPage.tsx`    | Lightweight client fallback topology rendering                                             | lightweight routing extractor                   |

---

## 4. File-Level Change Map

### New Files

| File                                                                  | Purpose                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `docs/plans/2026-05-02-studio-arch-routing-parity-hardening.lld.md`   | Durable plan for the remaining Studio / Arch routing parity work            |
| `apps/studio/src/lib/arch-ai/routing-edge-extraction.ts`              | Shared parsed-document and lightweight fallback routing extraction          |
| `apps/studio/src/__tests__/arch-ai/routing-edge-extraction.test.ts`   | Locks canonical parsed and fallback extraction behavior                     |
| `apps/studio/src/__tests__/arch-ai/in-project-tools-topology.test.ts` | Locks `read_topology` and proposal impact parity for action-handler routing |
| `apps/studio/src/__tests__/arch-ai/health-check.test.ts`              | Locks missing-target and reachability checks for action-handler routing     |
| `apps/studio/src/__tests__/arch-ai/cross-agent-validator.test.ts`     | Locks ABL/topology consistency for modern routing surfaces                  |

### Modified Files

| File                                                            | Change                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/topology-ops.ts`             | Replace local action-handler traversal with the shared routing extractor           |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`         | Replace local edge extraction with the shared routing extractor                    |
| `apps/studio/src/lib/arch-ai/tools/health-check.ts`             | Validate and traverse parsed routing targets instead of top-level handoffs only    |
| `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`          | Replace raw `TO:` regex mismatch detection with parsed routing extraction          |
| `apps/studio/src/components/agents/AgentListPage.tsx`           | Extend client fallback topology extraction to mirror inline action-handler routing |
| `apps/studio/src/__tests__/components/agent-list-page.test.tsx` | Lock client fallback topology parity for action-handler routes                     |

---

## 5. Implementation Phases

### Phase 1: Canonical Routing Extraction

**Goal**: Establish one shared routing-edge extractor for Studio / Arch server-side surfaces.

**Tasks**:

1. Add red tests for parsed-document routing extraction and lightweight fallback extraction.
2. Implement shared extraction for top-level `HANDOFF`, `DELEGATE`, `ESCALATE`, step `ON_ACTION DO`, and top-level `ACTION_HANDLERS DO`.
3. Migrate `topology-ops` and `in-project-tools` to the shared helper.
4. Add red/green consumer tests for `read_topology` and proposal impact.

**Exit Criteria**:

- [x] Shared parsed-document extraction covers step-level and agent-level action handlers.
- [x] `read_topology` includes action-handler routing edges.
- [x] Proposal impact detects topology changes introduced via action-handler routing.
- [x] Targeted helper + in-project tests pass.

**Test Strategy**:

- Unit: `routing-edge-extraction.test.ts`
- Integration: `in-project-tools-topology.test.ts`, `topology-ops.test.ts`

**Rollback**:

- Revert the shared helper and restore caller-local extraction if a regression appears.

### Phase 2: Health and Validation Parity

**Goal**: Make health checks and ABL/topology validation reason over real routing targets.

**Tasks**:

1. Add red health-check tests for missing action-handler targets and delegate reachability.
2. Add red cross-agent-validator tests for action-handler routing mismatches.
3. Replace handoff-only parsing with shared routing extraction in `health-check`.
4. Replace raw `TO:` mismatch scans with parsed routing extraction in `cross-agent-validator`.

**Exit Criteria**:

- [x] Health checks fail on missing delegate / handoff targets authored inside action handlers.
- [x] Delegate-only or action-handler-routed agents are not falsely reported orphaned.
- [x] Cross-agent validation flags missing modern routing targets.
- [x] Targeted health / validator tests pass.

**Test Strategy**:

- Unit: `cross-agent-validator.test.ts`
- Integration: `health-check.test.ts`

**Rollback**:

- Revert the routing-specific checks only; no schema or persistence migration is involved.

### Phase 3: Client Fallback Parity

**Goal**: Keep the client mini-topology aligned with modern authored routing forms when server topology is absent.

**Tasks**:

1. Add a red `AgentListPage` fallback test for action-handler routing.
2. Replace bespoke top-level-only fallback extraction with the shared lightweight DSL fallback helper.
3. Keep the client fallback bounded to `handoff` / `delegate` edges used by `MiniTopologyData`.

**Exit Criteria**:

- [x] Action-handler `HANDOFF` / `DELEGATE` edges appear in the fallback mini-topology.
- [x] Existing top-level fallback behavior remains green.
- [x] Targeted `AgentListPage` tests pass.

**Test Strategy**:

- Component: `agent-list-page.test.tsx`

**Rollback**:

- Revert the lightweight fallback helper usage and restore the old top-level-only extraction.

---

## 6. Wiring Checklist

- [x] Shared routing extraction is imported by every server-side routing consumer that previously hand-rolled traversal.
- [x] `read_topology` in `in-project-tools` and `topology-ops` both produce the same action-handler edge set.
- [x] Health-check route graph construction is parser-based instead of raw `TO:` regex based.
- [x] Cross-agent validator uses parsed routing extraction for ABL-vs-topology mismatch checks.
- [x] `AgentListPage` fallback uses the lightweight shared extractor and keeps client-only types compatible.

---

## 7. Acceptance Criteria

- [x] Alternate Studio / Arch topology surfaces no longer miss action-handler routing edges.
- [x] Health check target validation and reachability checks no longer ignore delegate-only or action-handler routes.
- [x] Cross-agent validation no longer relies on raw `TO:` regexes for authored routing consistency.
- [x] Client fallback mini-topology includes action-handler `handoff` / `delegate` edges.
- [x] Targeted Studio build and regression tests are green.

---

## 8. Future-Ready Guardrails

- Any new authored routing surface must be added to `routing-edge-extraction.ts` first, then consumed by Studio / Arch callers from there.
- Server-side topology or validation code should never parse routing by scanning raw `TO:` tokens when the parsed document is available.
- Client fallbacks may stay lightweight, but they must explicitly mirror canonical inline routing keywords so the degraded path is honest about what it can see.

---

## 9. Verification Notes

### Focused Green Lanes

- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/routing-edge-extraction.test.ts src/__tests__/arch-ai/in-project-tools-topology.test.ts src/__tests__/arch-ai/health-check.test.ts src/__tests__/arch-ai/cross-agent-validator.test.ts src/__tests__/components/agent-list-page.test.tsx`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/arch-ai/topology-ops.test.ts src/__tests__/arch-ai/in-project-mutation-scope.test.ts src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`
- `pnpm --filter @agent-platform/studio exec tsc --noEmit`

### Broader Build Blocker Outside This Slice

- `pnpm build --filter=@agent-platform/studio` still pulls a broader workspace build graph and is currently blocked by an unrelated `@agent-platform/web-sdk` type error in `packages/web-sdk/src/chat/ChatClient.ts`.
