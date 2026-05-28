# LLD Log: Workflow Canvas UX Improvements

## Oracle Decisions (2026-03-30)

| #   | Question                 | Classification | Decision                                                                        |
| --- | ------------------------ | -------------- | ------------------------------------------------------------------------------- |
| Q1  | Implementation order     | DECIDED        | Foundation (0, 10.1) -> Interactions (1-6) -> Panels (8-9) -> Polish (10)       |
| Q2  | Edge path type           | ANSWERED       | getSmoothStepPath in polish phase; getBezierPath works for L-to-R automatically |
| Q3  | Feature flag             | DECIDED        | No flag; UI-only on feature branch                                              |
| Q4  | Phase 1 scope            | DECIDED        | Sections 0-6 must ship together; 7-10 incremental                               |
| Q5  | Interaction sounds       | DECIDED        | Deferred entirely                                                               |
| Q6  | L-to-R migration         | ANSWERED       | Client-side transform on load, not DB migration                                 |
| Q7  | Context menu component   | ANSWERED       | Radix Popover (create wrapper; transitive dep exists)                           |
| Q8  | JSON display in debug    | ANSWERED       | Monaco editor (already a dep in Studio)                                         |
| Q9  | Animation library        | ANSWERED       | Hybrid CSS/Tailwind + framer-motion (both exist in codebase)                    |
| Q10 | Debug panel architecture | ANSWERED       | Single component with mode prop                                                 |
| Q11 | L-to-R rollback          | DECIDED        | Client-side migration + fitView fallback; positions are visual-only             |
| Q12 | Conflicting work         | INFERRED       | No conflicts evident; ALPHA feature, single team                                |
| Q13 | E2E test breakage        | ANSWERED       | Yes — addNodeViaQuickAdd ~25 sites, save/deploy buttons referenced              |
| Q14 | Monitor slider confirmed | ANSWERED       | Yes, replaces inline expansion per spec Section 8.7                             |
| Q15 | Definition of done       | DECIDED        | Incremental; minimum viable = Sections 0-6 + 10.1                               |

No AMBIGUOUS items. All questions resolved from spec, codebase, or established patterns.

---

## Audit Round 1

**Focus**: Architecture compliance -- isolation, auth, stateless, traceability
**Reviewer**: lld-reviewer agent
**Date**: 2026-03-30

### Summary

This is a **frontend-only LLD** (all changes in `apps/studio/`). No new backend routes, no new database models, no new API endpoints. The scope is UI layout changes, component replacements, and visual polish. As a result, many backend-focused checklist items (tenant isolation on queries, `createUnifiedAuthMiddleware`, BullMQ configs, MongoDB model registration) are **not applicable**.

The LLD is well-structured with clear phases, file maps, exit criteria, and rollback plans. However, several issues need attention before implementation.

### Findings

| #   | Severity   | Category            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Location                                         | Recommendation                                                                                                                                                                                                                                                                                                                               |
| --- | ---------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HIGH**   | Completeness        | **Cancel execution API does not exist.** Phase 4 (Task 4.4) says the Stop button calls "cancel execution API", but `apps/studio/src/api/workflows.ts` has no `cancelExecution` function. Open Question #3 acknowledges this but doesn't specify the fallback clearly in the task itself.                                                                                                                                                                                   | LLD Phase 4, Task 4.4                            | Either: (a) Add a task to implement `cancelExecution()` in `apps/studio/src/api/workflows.ts` (and verify the backend endpoint exists), or (b) Specify in Task 4.4 that the Stop button is rendered disabled with a tooltip "Cancellation not yet supported" until the API is available. The current wording implies it will work.           |
| 2   | **HIGH**   | Completeness        | **Tab ID change from `steps` to `flow` breaks bookmarked URLs.** The HLD (Section 1) explicitly calls out: "Route changes from .../steps to .../flow -- ensure redirect/alias for bookmarked URLs." The LLD Phase 2 Task 2.1 changes the tab ID but does not address URL redirect/alias.                                                                                                                                                                                   | LLD Phase 2, Task 2.1; HLD Section 1 line 321    | Add a sub-task to handle the route transition. Either add a redirect in the tab routing logic (`if tabId === 'steps' navigate to 'flow'`) or keep `steps` as an alias.                                                                                                                                                                       |
| 3   | **HIGH**   | Completeness        | **ContextExplorer.tsx label change missing.** The HLD (Section 1) specifies updating `ContextExplorer.tsx:556` sidebar category label from "Steps" to "Nodes". The LLD Phase 2 does not include this file in its change list.                                                                                                                                                                                                                                              | HLD Section 1 line 323; missing from LLD Phase 2 | Add `apps/studio/src/components/workflows/steps/ContextExplorer.tsx` to Phase 2 files touched, with a task to rename the sidebar category label from "Steps" to "Nodes".                                                                                                                                                                     |
| 4   | **MEDIUM** | Correctness         | **Imprecise field reference for input variables.** Phase 4 Task 4.1 says "check Start node for `inputVariables`" but does not specify the exact field path. The actual path (per `RunDialog.tsx` line 31-36) is `startNode.data.config.inputVariables`. Without this precision, an implementer might check the wrong field (e.g., `inputSchema` from the store, which is a different thing).                                                                               | LLD Phase 4, Task 4.1                            | Change to: "check the Start node's `data.config.inputVariables` array (same path used by `RunDialog.tsx`). If the array is empty or undefined, call `executeWorkflow` directly."                                                                                                                                                             |
| 5   | **MEDIUM** | i18n                | **No i18n strategy specified.** The LLD creates ~8 new components with user-visible strings (button labels, accordion headers "Input"/"Flow Log"/"Output", status text "Saving..."/"All changes saved"/"Save failed", "Coming soon", "Run", "Stop", step status labels, tooltip text). None of these are planned as translation keys. The existing canvas components do not use i18n yet, but the trigger components in the same `workflows/` tree do (`useTranslations`). | All phases with new components                   | Add a cross-phase concern noting that: (a) all user-visible strings in new components should use translation keys from the `studio` i18n namespace, (b) specify the key prefix (e.g., `workflow.canvas.*`), (c) list the ~15-20 new keys needed. Even if the team decides to defer i18n for ALPHA, this should be documented as a known gap. |
| 6   | **MEDIUM** | Frontend State      | **No SWR cache invalidation strategy specified.** Phase 4 triggers execution, Phase 5 displays execution data, Phase 6 lists executions. The LLD doesn't specify how execution data is fetched (polling? SWR? manual fetch?) or how the execution list in the Monitor tab is invalidated after a new execution starts from the canvas.                                                                                                                                     | LLD Phases 4, 5, 6                               | Specify: (a) how the debug panel polls for execution status updates (interval? SSE? existing pattern?), (b) how `WorkflowMonitorTab` execution list refreshes after a new execution, (c) whether `mutate()` calls are needed. Check the existing `ExecutionDebugPanel.tsx` for the current polling pattern and carry it forward.             |
| 7   | **MEDIUM** | Frontend State      | **`isExecuting` state duplicates existing pattern.** The store already has `currentExecutionId` and `debugPanelOpen`. Phase 4 adds `isExecuting` to the store, but `isExecuting` could be derived from `currentExecutionId !== null && executionStatus === 'running'`. Adding redundant state creates sync risk.                                                                                                                                                           | LLD Phase 4, Task 4.3                            | Consider whether `isExecuting` can be derived rather than stored. If it must be stored (e.g., for the brief moment between clicking Run and receiving the execution ID), document the sync lifecycle: when it's set to true, when it's set to false, and what happens if the API call fails.                                                 |
| 8   | **LOW**    | Correctness         | **`deployPanelOpen` removal not specified as a task.** Phase 2 Task 2.3 says "remove `deployPanelOpen` state" from the store, but the store interface (line 74) has `deployPanelOpen: boolean` and `setDeployPanelOpen` (line 116). The exit criteria mention "No TypeScript errors referencing removed `deployPanelOpen`" but no task explicitly removes all consumers.                                                                                                   | LLD Phase 2, Task 2.3                            | Add a sub-task to grep for all `deployPanelOpen` and `setDeployPanelOpen` references and remove them. This likely includes `CanvasToolbar.tsx` and possibly `WorkflowCanvasPage.tsx`.                                                                                                                                                        |
| 9   | **LOW**    | Pattern Consistency | **Zustand store additions should follow atomic selector pattern.** The LLD adds `saveStatus`, `isExecuting`, `canvasExpanded` to the store. The existing codebase correctly uses atomic selectors (e.g., `useWorkflowCanvasStore((s) => s.isDirty)`). The LLD should explicitly note that all new state fields must be accessed via individual selectors, not destructured objects.                                                                                        | LLD Section 1, Key Interfaces                    | Add a note in the Key Interfaces section: "All new store fields must be consumed via atomic selectors, consistent with the existing pattern in `CanvasToolbar.tsx`."                                                                                                                                                                         |
| 10  | **LOW**    | Completeness        | **No test spec for canvas UX.** The existing test spec (`docs/testing/workflows.md`) covers backend workflow engine tests only -- no canvas UX E2E scenarios. The LLD Phase 8 references updating E2E tests but doesn't map to specific test IDs from a test spec. Per past review feedback, LLD test file names must match test spec exactly.                                                                                                                             | LLD Phase 8                                      | Either: (a) create a canvas UX test spec (`docs/testing/workflow-canvas-ux.md`) with E2E scenarios before implementation, or (b) acknowledge that the existing `workflow-canvas-uat.spec.ts` serves as the de facto test spec and the Phase 8 tasks are correct.                                                                             |

### Architecture Compliance Assessment

| Check                  | Status | Notes                                                                                           |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| Resource isolation     | N/A    | Frontend-only; all API calls go through project-scoped `apiFetch` in `api/workflows.ts`         |
| Auth                   | PASS   | All execution APIs use `apiFetch` which handles auth centrally. No custom token handling.       |
| Stateless              | PASS   | All state is in Zustand (client-side, per-session). No pod-local server state introduced.       |
| Traceability           | PASS   | Debug panel reads execution traces from the API (`getExecution`). No changes to trace emission. |
| Express route ordering | N/A    | No backend route changes.                                                                       |
| Cross-scope access     | N/A    | No new API endpoints.                                                                           |

### Verified Items

- [x] All file paths in the LLD exist in the codebase (verified via Glob)
- [x] Files to be deleted exist: `QuickAddBar.tsx`, `ExecutionDebugPanel.tsx`
- [x] Store interface matches LLD description (confirmed `addNode` signature, `deployPanelOpen` presence)
- [x] API client uses `apiFetch` for all calls (centralized auth)
- [x] Zustand selectors follow atomic pattern in existing code
- [x] `SlidePanel` UI component exists for Phase 6
- [x] `@monaco-editor/react` and `framer-motion` are already installed
- [x] `STUB_NODE_TYPES` exists in `packages/shared-kernel/src/types/workflow-types.ts`
- [x] E2E helper `addNodeViaQuickAdd` exists and can be replaced
- [x] `inputVariables` field path is `startNode.data.config.inputVariables` (per `RunDialog.tsx`)

### Verdict

**PASS_WITH_FINDINGS**

3 HIGH findings must be addressed before implementation:

1. Cancel execution API gap (Phase 4) -- specify the fallback behavior
2. Tab ID route redirect for bookmarked URLs (Phase 2) -- HLD requirement not covered
3. ContextExplorer label change missing (Phase 2) -- HLD requirement not covered

4 MEDIUM findings should be addressed: 4. Precise field path for inputVariables 5. i18n strategy (can be documented as deferred for ALPHA) 6. SWR/polling strategy for execution data 7. `isExecuting` derived vs stored state

3 LOW findings are recommended improvements.

### Notes for Implementation

- Before Phase 3: Run `pnpm why @radix-ui/react-popover --filter=@agent-platform/studio` to verify dependency status (Open Question #1)
- Before Phase 7: Verify `getSmoothStepPath` export exists in the installed `@xyflow/react` version (Open Question #2)
- The existing `RunDialog.tsx` pattern for finding input variables (lines 30-36) should be extracted into a shared utility if both `CanvasToolbar.tsx` and `RunDialog.tsx` need it
- Phase 2 removes `deployPanelOpen` -- grep all consumers before removing to avoid TypeScript errors
- The LLD correctly identifies that Phases 3+4 are coupled with QuickAddBar removal (Decision D-8)

---

## Audit Round 2

**Focus**: Pattern consistency -- matches existing code, no reinvention
**Reviewer**: lld-reviewer agent
**Date**: 2026-03-30

### Round 1 Findings Status

| #   | Severity | Status              | Notes                                                                                                                                                          |
| --- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | **FIXED**           | Task 4.4 now specifies Stop button disabled with tooltip "Cancel not yet available". Open Question #3 also updated.                                            |
| 2   | HIGH     | **FIXED**           | Task 2.1 now includes `if tabId === 'steps', navigate to 'flow'` redirect. Exit criteria updated.                                                              |
| 3   | HIGH     | **FIXED**           | Task 2.7 added for ContextExplorer.tsx label rename. File added to Phase 2 files touched. Exit criteria added.                                                 |
| 4   | MEDIUM   | **FIXED**           | Task 4.1 now references `startNode.data.config.inputVariables` and notes shared utility extraction.                                                            |
| 5   | MEDIUM   | **ACKNOWLEDGED**    | Open Question #4 documents i18n as a known gap, consistent with existing canvas codebase (no `useTranslations` in any canvas component). Acceptable for ALPHA. |
| 6   | MEDIUM   | **FIXED**           | Task 4.5 specifies reusing `useExecutionPolling` hook (1500ms interval).                                                                                       |
| 7   | MEDIUM   | **PARTIALLY FIXED** | Task 4.3 mentions deriving `isExecuting` from `currentExecutionId` + `executionOverlay`. But see Finding #1 below.                                             |
| 8   | LOW      | Carried             | No explicit sub-task to grep for `deployPanelOpen` consumers yet. Covered by exit criteria check.                                                              |
| 9   | LOW      | Carried             | Atomic selector pattern still not explicitly noted.                                                                                                            |
| 10  | LOW      | Carried             | Test spec gap still present but acceptable for ALPHA.                                                                                                          |

### New Findings

| #   | Severity   | Category            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Location                       | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HIGH**   | Pattern Consistency | **Phase 4 exit criteria contradicts task description.** Task 4.4 correctly says the Stop button is "disabled with tooltip" because the cancel API doesn't exist. But exit criterion line 311 says "Clicking Stop cancels the execution" -- implying it works. This contradicts the task and will confuse the implementer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | LLD Phase 4, line 311          | Change exit criterion from "Clicking Stop cancels the execution" to "Stop button renders disabled with tooltip 'Cancel not yet available' during execution".                                                                                                                                                                                                                                                                                                                                    |
| 2   | **HIGH**   | UI Component Reuse  | **New `ui/Popover.tsx` wrapper reinvents pattern when inline usage exists.** The LLD proposes creating a new `components/ui/Popover.tsx` Radix wrapper. However, the existing codebase already uses `@radix-ui/react-popover` directly in `VariableNamespaceTagPopover.tsx` (inline `* as RadixPopover` import, no wrapper). The `DropdownMenu.tsx` UI wrapper pattern is a different Radix primitive. Creating a `Popover.tsx` wrapper is fine for consistency, but the LLD should (a) specify that `HandlePlusMenu` uses the same Radix Popover import pattern as `VariableNamespaceTagPopover.tsx`, and (b) clarify whether the new `ui/Popover.tsx` is a generic wrapper used by `HandlePlusMenu` or `HandlePlusMenu` uses Radix directly. Currently the LLD says both -- Task 3.1 creates the wrapper, Task 3.2 mentions "Radix Popover" directly. | LLD Phase 3, Tasks 3.1 and 3.2 | Clarify: either (a) `HandlePlusMenu.tsx` imports from `ui/Popover.tsx` (the new wrapper), or (b) `HandlePlusMenu.tsx` uses `@radix-ui/react-popover` directly like `VariableNamespaceTagPopover.tsx` and skip creating the wrapper. Pick one. The `DropdownMenu.tsx` wrapper pattern (Root+Trigger+Content in one component) is the better model if going with a wrapper.                                                                                                                       |
| 3   | **MEDIUM** | UI Component Reuse  | **Debug panel uses Monaco for JSON display when `JsonViewer` already exists.** The LLD (Phase 5) specifies Monaco JSON editors for step Input/Output sub-accordions. The codebase already has `components/ui/JsonViewer.tsx` -- a purpose-built component with copy-to-clipboard, collapsible nodes, depth limiting, and syntax coloring. Monaco is heavyweight for read-only JSON display. The existing `ExecutionDebugPanel.tsx` uses inline `<pre>` + `JSON.stringify`, and `JsonViewer` would be a direct upgrade.                                                                                                                                                                                                                                                                                                                                  | LLD Phase 5, Tasks 5.1-5.3     | Consider using `JsonViewer` from `components/ui/JsonViewer.tsx` instead of Monaco for read-only step I/O display. Monaco is appropriate for the full Output accordion (where users may want to search/select), but `JsonViewer` with `copyable={true}` and `expandAll={true}` is lighter and already built.                                                                                                                                                                                     |
| 4   | **MEDIUM** | UI Component Reuse  | **Debug panel accordions reinvent `CollapsibleSection`.** The LLD says WorkflowDebugPanel has "three collapsible accordions (Input, Flow Log, Output)" and StepLogItem has collapsible step items. The codebase already has `CollapsibleSection` (in `components/ui/JsonViewer.tsx`) with open/close state, chevron icon, badge count, and standard styling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | LLD Phase 5, Tasks 5.1-5.3     | Reference `CollapsibleSection` from `components/ui/JsonViewer.tsx` for the accordion pattern. The component signature (`title`, `defaultOpen`, `badge`) maps directly to the debug panel's needs. If the existing styling doesn't match, extend it rather than building a new accordion from scratch.                                                                                                                                                                                           |
| 5   | **MEDIUM** | UI Component Reuse  | **KPI summary bar in Phase 6 should use existing `MetricCard`.** Phase 6 Task 6.3 specifies "KPI summary bar: Total runs, In progress, Response time (P90/P99), Failure rate." The codebase has `components/ui/MetricCard.tsx` with `label`, `value`, `trend`, `context`, and `icon` props -- a near-exact fit. The LLD doesn't reference this component.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | LLD Phase 6, Task 6.3          | Specify that the KPI bar uses `<MetricCard>` from `components/ui/MetricCard.tsx` for each KPI. This matches the existing pattern used on other dashboard pages.                                                                                                                                                                                                                                                                                                                                 |
| 6   | **MEDIUM** | Pattern Consistency | **Animation constants file duplicates existing `lib/animation.ts`.** The LLD creates `canvas/constants/animation.ts` for timing values. The codebase already has `apps/studio/src/lib/animation.ts` with shared springs, transitions, easing curves, and stagger delays. The existing `SlidePanel.tsx` imports `springs` and `transitions` from this file. New canvas animations should extend this file, not create a parallel one.                                                                                                                                                                                                                                                                                                                                                                                                                    | LLD Phase 1, Task 1.1          | Either: (a) add canvas-specific presets to `apps/studio/src/lib/animation.ts` (e.g., `transitions.canvasSlideIn`, `transitions.nodeAppear`), or (b) if the canvas constants are CSS/Tailwind-only (keyframes, not framer-motion), then `canvas/constants/animation.ts` is correct for Tailwind config values, but the LLD should explicitly state that framer-motion transitions reuse `lib/animation.ts` and the new file is only for Tailwind keyframe timing constants. Currently ambiguous. |
| 7   | **MEDIUM** | Pattern Consistency | **`saveStatus` store addition overlaps with existing `isSaving`/`isDirty`/`markSaved` pattern.** The store already has `isSaving: boolean` (set by `useWorkflowSave`), `isDirty: boolean`, and `markSaved()`. The LLD adds `saveStatus: 'idle'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 'saving'                       | 'saved'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 'error'`. This creates two parallel save-state tracking mechanisms. `isSaving`and`saveStatus` will need to be kept in sync, or one becomes stale. | LLD Phase 2, Tasks 2.2-2.4; Store lines 76-77, 119, 121 | Either: (a) replace `isSaving` with `saveStatus` (breaking change -- update all consumers), or (b) derive `saveStatus` from `isSaving` + `isDirty` + error state in the toolbar component (no new store state needed). The toolbar already reads `isSaving` and `isDirty` and renders "Saving..."/"Saved" based on them (lines 84-89 of `CanvasToolbar.tsx`). Option (b) avoids adding redundant state. |
| 8   | **MEDIUM** | File Organization   | **New `canvas/components/` directory breaks existing convention.** All existing canvas sub-components live in `canvas/nodes/`, `canvas/edges/`, or `canvas/panels/`. The LLD creates `canvas/components/` for `HandlePlusMenu.tsx`, `NodeDeleteButton.tsx`, `EdgeDeleteButton.tsx`. These are node/edge interaction components and would fit better in the existing `canvas/nodes/` directory (for `HandlePlusMenu` and `NodeDeleteButton`) and `canvas/edges/` (for `EdgeDeleteButton`).                                                                                                                                                                                                                                                                                                                                                               | LLD Phase 3, new files section | Consider placing `HandlePlusMenu.tsx` and `NodeDeleteButton.tsx` in `canvas/nodes/` and `EdgeDeleteButton.tsx` in `canvas/edges/` to follow the existing directory convention. If `canvas/components/` is intended for shared canvas primitives, document why these don't belong in the existing folders.                                                                                                                                                                                       |
| 9   | **LOW**    | Pattern Consistency | **Hardcoded stroke colors in `WorkflowEdgeComponent.tsx`.** The existing edge component uses raw hex colors (`#3b82f6`, `#ef4444`, `#94a3b8`) rather than CSS variables or semantic tokens. The LLD's Phase 7 proposes changing the default stroke to `#cbd5e1`. This continues the pattern of hardcoded colors. While not a blocking issue (the existing code does this), it conflicts with the design token enforcement rule in CLAUDE.md.                                                                                                                                                                                                                                                                                                                                                                                                            | Existing code + LLD Phase 7    | Note as implementation guidance: when touching edge styling in Phase 7, consider migrating stroke colors to CSS variables (`var(--border-default)`, `var(--accent)`, `var(--error)`) for theme consistency. Not blocking for ALPHA.                                                                                                                                                                                                                                                             |
| 10  | **LOW**    | Pattern Consistency | **`WorkflowNodeComponent.tsx` execution ring classes use raw Tailwind palette colors.** The `getExecutionRingClass` function uses `ring-blue-400`, `ring-green-500`, `ring-red-500`. The CLAUDE.md design token rule says "No hardcoded Tailwind palette colors." The LLD Phase 7 proposes more execution overlay animations that would extend this pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Existing code + LLD Phase 7    | During Phase 7, migrate execution ring colors to semantic tokens (`ring-accent`, `ring-success`, `ring-error`). Not blocking for ALPHA.                                                                                                                                                                                                                                                                                                                                                         |

### Pattern Consistency Assessment

| Area                   | Status              | Notes                                                                                                  |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| Store patterns         | **NEEDS ATTENTION** | `saveStatus` overlaps with existing `isSaving`/`isDirty`; `isExecuting` derivation partially addressed |
| UI component reuse     | **NEEDS ATTENTION** | JsonViewer, CollapsibleSection, MetricCard not referenced; Popover wrapper ambiguous                   |
| File organization      | **MINOR**           | New `canvas/components/` directory breaks convention                                                   |
| Import patterns        | **PASS**            | All imports follow existing relative path patterns                                                     |
| Naming conventions     | **PASS**            | Component names follow `<Purpose><ComponentType>` pattern                                              |
| Animation patterns     | **NEEDS ATTENTION** | New animation file vs existing `lib/animation.ts` needs clarification                                  |
| Existing utility reuse | **PASS**            | `useExecutionPolling`, `SlidePanel`, `Badge`, `EmptyState` correctly referenced                        |

### Verified Items

- [x] Round 1 HIGH findings (Cancel API, tab redirect, ContextExplorer) all addressed
- [x] `JsonViewer` and `CollapsibleSection` exist in `components/ui/JsonViewer.tsx` and could be reused
- [x] `MetricCard` exists in `components/ui/MetricCard.tsx` and fits Phase 6 KPI needs
- [x] `lib/animation.ts` exists with shared springs/transitions used by `SlidePanel`
- [x] `VariableNamespaceTagPopover.tsx` uses Radix Popover directly (no wrapper)
- [x] `DropdownMenu.tsx` wrapper exists as a pattern model for Radix wrappers
- [x] Existing store uses `isSaving`/`isDirty`/`markSaved()` for save state tracking
- [x] `useWorkflowSave.ts` sets `isSaving` and calls `markSaved()` -- parallel to proposed `saveStatus`
- [x] All existing canvas sub-components organized in `nodes/`, `edges/`, `panels/` directories
- [x] `CanvasToolbar.tsx` already renders save status from `isSaving`/`isDirty` (lines 84-89)

### Verdict

**NEEDS_CHANGES**

2 HIGH findings:

1. Phase 4 exit criterion contradicts disabled-Stop-button task description
2. Popover wrapper vs direct usage ambiguity

6 MEDIUM findings (should fix):
3-5. Missed UI component reuse (JsonViewer, CollapsibleSection, MetricCard) 6. Animation constants file vs existing lib/animation.ts 7. `saveStatus` overlaps existing `isSaving`/`isDirty` save-state tracking 8. `canvas/components/` directory breaks convention

2 LOW findings (recommended):
9-10. Hardcoded colors should migrate to semantic tokens during polish phase

---

## Audit Round 3

**Focus**: Completeness -- every FR covered, file paths verified, signatures checked
**Reviewer**: lld-reviewer agent
**Date**: 2026-03-30

### Round 2 Findings Status

| #   | Severity | Status    | Notes                                                                                                                                                                           |
| --- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | **FIXED** | Exit criterion now says "Stop button renders disabled with tooltip 'Cancel not yet available'" (line 307). Matches task 4.4.                                                    |
| 2   | HIGH     | **FIXED** | Task 3.1 now says "used directly, matching existing pattern in `VariableNamespaceTagPopover.tsx` -- no shared wrapper needed". Wiring checklist line 481 also updated.          |
| 3   | MEDIUM   | **FIXED** | Task 5.1 now references `JsonViewer` component for step I/O and `CollapsibleSection` for collapsible pattern. Monaco reserved for main Output accordion only.                   |
| 4   | MEDIUM   | **FIXED** | Task 5.1 explicitly uses `CollapsibleSection` from `JsonViewer.tsx`.                                                                                                            |
| 5   | MEDIUM   | **FIXED** | Task 6.3 now specifies `MetricCard` from `components/ui/MetricCard.tsx` with prop mapping.                                                                                      |
| 6   | MEDIUM   | **FIXED** | Task 1.1 now separates: Tailwind keyframe constants in `canvas/constants/animation.ts`, framer-motion presets in existing `lib/animation.ts`.                                   |
| 7   | MEDIUM   | **FIXED** | Task 2.3 now says "derive `saveStatus` from existing `isSaving`/`isDirty` state in CanvasToolbar (do NOT add parallel `saveStatus` field)". Wiring checklist line 485 confirms. |
| 8   | MEDIUM   | **FIXED** | New files placed in `canvas/nodes/` (HandlePlusMenu, NodeDeleteButton) and `canvas/edges/` (EdgeDeleteButton). No `canvas/components/` directory.                               |
| 9   | LOW      | Carried   | Hardcoded stroke colors -- noted as implementation guidance for Phase 7.                                                                                                        |
| 10  | LOW      | Carried   | Execution ring Tailwind palette colors -- noted for Phase 7 migration.                                                                                                          |

All Round 2 HIGH and MEDIUM findings have been resolved.

### Section-to-Phase Mapping (Completeness Check)

| Spec Section                  | LLD Phase(s)                       | Status                          |
| ----------------------------- | ---------------------------------- | ------------------------------- |
| 0. Flow Direction LTR         | Phase 1                            | **Covered**                     |
| 1. Tab Rename                 | Phase 2 (task 2.1)                 | **Covered**                     |
| 2. Canvas Header              | Phase 2 (tasks 2.2-2.4)            | **Covered**                     |
| 3. Remove QuickAddBar         | Phase 2 (task 2.5)                 | **Covered**                     |
| 4. Handle Plus Menu           | Phase 3 (tasks 3.1, 3.3-3.4, 3.10) | **Covered**                     |
| 5. Node Delete                | Phase 3 (tasks 3.5-3.6)            | **Covered**                     |
| 6. Edge Delete                | Phase 3 (tasks 3.7-3.9)            | **Covered**                     |
| 7. Integration "Coming Soon"  | Phase 2 (task 2.6)                 | **Covered**                     |
| 8.1-8.5 Debug Panel           | Phase 5 (tasks 5.1-5.5)            | **Covered**                     |
| 8.6 Context Object Panel      | **NOT COVERED**                    | **GAP** -- see Finding #1       |
| 8.7 Monitor Tab Integration   | Phase 6 (tasks 6.1-6.4)            | **Covered**                     |
| 8.8 Monitor KPI Summary       | Phase 6 (task 6.3)                 | **Covered**                     |
| 8.9 Monitor Grid Columns      | Not explicitly addressed           | **Minor gap** -- see Finding #6 |
| 9. Run Behavior               | Phase 4 (tasks 4.1-4.5)            | **Covered**                     |
| 10.1 Animation Constants      | Phase 1 (task 1.1)                 | **Covered**                     |
| 10.2 Node Visual              | Phase 7 (task 7.1)                 | **Covered**                     |
| 10.3 Edge Visual              | Phase 7 (task 7.2)                 | **Covered**                     |
| 10.4 Handle Visual            | Phase 7 (task 7.3)                 | **Covered**                     |
| 10.5 Panel Transitions        | Phase 7 (task 7.4)                 | **Covered**                     |
| 10.6 Toolbar Refinement       | **NOT COVERED**                    | **GAP** -- see Finding #2       |
| 10.7 Canvas Background        | Phase 7 (task 7.6)                 | **Covered**                     |
| 10.8 Selection & Multi-Select | **NOT COVERED**                    | **GAP** -- see Finding #3       |
| 10.9 Drag & Drop Polish       | Phase 7 (task 7.7)                 | **Covered**                     |
| 10.10 Execution Overlays      | Phase 7 (task 7.5)                 | **Covered**                     |
| 10.11 Reduced Motion          | Phase 7 (task 7.8)                 | **Covered**                     |
| 10.12 Dark Mode               | **NOT COVERED**                    | **GAP** -- see Finding #4       |
| 10.13 Interaction Sound       | Deferred (Oracle Q5)               | **Explicitly deferred**         |

### File Path Verification

All file paths verified via Glob:

- [x] All 7 modified existing files exist
- [x] All 2 files to be deleted exist (`QuickAddBar.tsx`, `ExecutionDebugPanel.tsx`)
- [x] All parent directories for new files exist (`canvas/nodes/`, `canvas/edges/`, `canvas/panels/`)
- [x] `canvas/constants/` directory does NOT exist yet -- will be created with `animation.ts` (acceptable)
- [x] `tailwind.config.ts` exists at `apps/studio/tailwind.config.ts`
- [x] E2E test files exist: `workflow-helpers.ts`, `workflow-canvas-uat.spec.ts`, `workflow-lifecycle.spec.ts`
- [x] Referenced reuse components exist: `JsonViewer.tsx`, `MetricCard.tsx`, `SlidePanel.tsx`, `lib/animation.ts`
- [x] `VariableNamespaceTagPopover.tsx` exists (Popover pattern reference)
- [x] `useAutoSave.ts` and `useWorkflowSave.ts` both exist
- [x] `useExecutionPolling.ts` exists

### Component Signature Verification

- [x] `WorkflowNodeComponent.tsx`: handles at `Position.Top` (input) and `Position.Bottom` (output) -- matches LLD description
- [x] `StartNodeComponent.tsx`: handle at `Position.Bottom` -- matches LLD
- [x] `EndNodeComponent.tsx`: handle at `Position.Top` -- matches LLD
- [x] `workflow-canvas-store.ts` `addNode`: signature is `(nodeType: NodeType, position?: { x: number; y: number }) => void` -- matches LLD's plan to add `sourceInfo` parameter
- [x] `CanvasToolbar.tsx`: current layout is Back/Run/Save (left), Name/Badge (center), ZoomOut/ZoomIn/Deploy (right) -- matches LLD's removal plan
- [x] `WorkflowDetailPage.tsx` line 60: `{ id: 'steps', label: 'Steps', icon: <ListOrdered> }` -- matches LLD's rename plan

### Acceptance Criteria Coverage

All 16 items in LLD Section 6 map to at least one phase exit criterion. Verified.

### New Findings

| #   | Severity   | Category     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Location                               | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **HIGH**   | Completeness | **Spec Section 8.6 (Context Object Panel) not covered.** The spec describes a secondary panel activated by the `debug-code-toggle` button that shows the full execution context object in a Monaco editor. The LLD Phase 5 task 5.3 mentions "code toggle" in the debug panel header but does NOT describe what it does, what component it opens, or how the context data is fetched. This is a user-facing feature specified in the HLD.                                                        | Spec Section 8.6; LLD Phase 5 task 5.3 | Either: (a) Add a task in Phase 5 (e.g., 5.6) to implement the Context Object Panel as described in spec 8.6 -- a secondary panel/drawer showing the execution context object in a read-only Monaco editor, toggled by the code button in the debug panel header. Or (b) explicitly defer it with a note: "Context Object Panel (spec 8.6) deferred to a follow-up -- code toggle button renders but is non-functional in this phase." |
| 2   | **MEDIUM** | Completeness | **Spec Section 10.6 (Toolbar Refinement animations) not covered in Phase 7.** The spec describes: save status fade transitions, validation badge scale pulse on number change, run button color crossfade + icon morph (Play -> Stop), and ping dot animation. While the ping dot is mentioned in Phase 4 task 4.4, the other toolbar animation details (badge pulse, save status fade, button color transition) are not in any phase.                                                           | Spec Section 10.6; LLD Phase 7         | Add a task in Phase 7 (e.g., 7.9) for toolbar micro-animations: save status opacity transition (`300ms ease`), validation badge number-change pulse (`scale(1.1)` for 150ms), and run button idle-to-running color crossfade (200ms).                                                                                                                                                                                                  |
| 3   | **MEDIUM** | Completeness | **Spec Section 10.8 (Selection & Multi-Select visual refinement) not covered.** The spec describes: refined lasso selection box (solid thin border, barely-visible fill, 4px border radius), and a group bounding box outline for multi-selected nodes (dashed border, 8px radius). Neither is in Phase 7 or any other phase.                                                                                                                                                                    | Spec Section 10.8                      | Add a task in Phase 7 (e.g., 7.10) for selection refinement: custom ReactFlow selection box styling (solid border, subtle fill, border radius) and multi-node group outline via CSS. These are CSS-only changes to `WorkflowCanvas.tsx` styles.                                                                                                                                                                                        |
| 4   | **MEDIUM** | Completeness | **Spec Section 10.12 (Dark Mode Considerations) not covered.** The spec defines dark mode overrides for node shadows, node borders, edge colors, canvas dots, selection rings, and background vignette. None of these are in Phase 7.                                                                                                                                                                                                                                                            | Spec Section 10.12                     | Add a task in Phase 7 (e.g., 7.11) for dark mode overrides. If the studio does not yet support dark mode, explicitly defer: "Dark mode color overrides (spec 10.12) deferred -- studio currently light-mode only." Document which CSS variables need dark mode values for future reference.                                                                                                                                            |
| 5   | **MEDIUM** | Completeness | **Missing CSS file for animation keyframes.** The spec Appendix A lists `canvas/styles/canvas-animations.css` as a new file for keyframes, reduced motion, and execution overlays. The LLD puts keyframes in `tailwind.config.ts` but many spec animations (edge-draw, edge-fade, completion-flash, error-shake, edge-pulse-travel, reduced-motion media query) are raw CSS that would be verbose in Tailwind config. Phase 7 tasks describe these animations but don't specify WHERE they live. | Spec Appendix A; LLD Phase 7           | Specify the destination for non-Tailwind CSS animations. Either: (a) create `canvas/styles/canvas-animations.css` as the spec suggests, imported in `WorkflowCanvas.tsx`, or (b) add ALL keyframes to `tailwind.config.ts` under `extend.keyframes` and note the expected count (~10 new keyframes beyond the 6 already planned in Phase 1). Current Phase 7 lists 8 animation effects but only Phase 1 defines 6 keyframes.           |
| 6   | **LOW**    | Completeness | **Spec Section 8.9 (Monitor Grid Columns) not addressed.** The spec defines 8 specific columns with widths, sort behavior, and cell renderers. The LLD Phase 6 describes adding a slider and KPI bar but doesn't mention whether the existing grid columns match the spec or need updating.                                                                                                                                                                                                      | Spec Section 8.9; LLD Phase 6          | Verify whether the existing `WorkflowMonitorTab.tsx` grid columns match spec 8.9. If they do, note "grid columns unchanged -- already match spec." If not, add column update tasks to Phase 6.                                                                                                                                                                                                                                         |
| 7   | **LOW**    | Correctness  | **Task numbering gap: Phase 3 skips from 3.1 to 3.3.** Task 3.2 is missing, likely a remnant from removing the Popover wrapper task in the Round 2 fix.                                                                                                                                                                                                                                                                                                                                          | LLD Phase 3                            | Renumber tasks 3.3-3.10 to 3.2-3.9 for clarity.                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | **LOW**    | Correctness  | **Task 2.4 uses ambiguous "useAutoSave.ts (or useWorkflowSave.ts)".** The save status logic belongs in `useWorkflowSave.ts` which calls `setIsSaving(true)` and `markSaved()`. `useAutoSave.ts` only reads `isSaving` to decide whether to trigger a save.                                                                                                                                                                                                                                       | LLD Phase 2, Task 2.4                  | Change to: "Update `useWorkflowSave.ts`: set save error state on failure (for the error status in CanvasToolbar). The save-start and save-complete transitions are already handled by existing `setIsSaving(true)` / `markSaved()` calls."                                                                                                                                                                                             |

### Completeness Assessment

| Check                          | Status        | Notes                                                                                                 |
| ------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| All spec sections covered      | **4 GAPS**    | 8.6 (Context Object Panel), 10.6 (Toolbar animations), 10.8 (Selection refinement), 10.12 (Dark mode) |
| All file paths verified        | **PASS**      | Every path in the LLD exists or has existing parent directory                                         |
| All signatures verified        | **PASS**      | Handle positions, addNode signature, tab definition, toolbar layout all confirmed                     |
| All acceptance criteria mapped | **PASS**      | All 16 items in LLD Section 6 map to phase exit criteria                                              |
| Phase 7 covers spec Section 10 | **8/13**      | 10.1 (Phase 1), 10.13 (deferred), 10.6/10.8/10.12 missing, rest covered                               |
| Round 1 fixes verified         | **ALL FIXED** | Cancel API, tab redirect, ContextExplorer, inputVariables path                                        |
| Round 2 fixes verified         | **ALL FIXED** | Popover pattern, component reuse, saveStatus derived, file directories                                |

### Verdict

**NEEDS_CHANGES**

1 HIGH finding:

1. Context Object Panel (spec 8.6) completely missing from LLD

4 MEDIUM findings: 2. Toolbar animation refinements (spec 10.6) not in Phase 7 3. Selection & Multi-Select refinements (spec 10.8) not covered 4. Dark Mode overrides (spec 10.12) not covered or deferred 5. CSS file for animation keyframes unspecified

3 LOW findings: 6. Monitor grid column verification 7. Task numbering gap in Phase 3 8. Ambiguous save hook reference in Task 2.4

### Notes for Implementation

- The Context Object Panel (Finding #1) is the only structurally significant gap. All other gaps are polish/visual items that could be deferred to a follow-up phase, but they should be explicitly deferred rather than silently omitted.
- The LLD's Phase 7 is well-structured but needs 3-4 more tasks to fully cover spec Section 10. Consider whether these are Phase 7 additions or a separate Phase 7b.
- All Round 1 and Round 2 findings have been satisfactorily resolved. The LLD quality has improved significantly across rounds.

---

## Audit Round 4

**Focus**: Cross-phase consistency -- LLD implements HLD, covers test spec scenarios, aligns with feature spec
**Reviewer**: phase-auditor agent
**Date**: 2026-03-30

### Round 3 Findings Status

| #   | Severity | Status              | Notes                                                                                                                                      |
| --- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | HIGH     | **FIXED**           | Task 5.5 added for Context Object Panel (spec 8.6). Code toggle toggles full Monaco editor replacing accordion view.                       |
| 2   | MEDIUM   | **FIXED**           | Task 7.9 added for toolbar micro-animations (spec 10.6).                                                                                   |
| 3   | MEDIUM   | **FIXED**           | Task 7.10 added for selection and multi-select refinement (spec 10.8).                                                                     |
| 4   | MEDIUM   | **FIXED**           | Task 7.11 added for dark mode overrides (spec 10.12) with "dark:" Tailwind variants.                                                       |
| 5   | MEDIUM   | **FIXED**           | Task 7.12 added for `canvas/styles/canvas-animations.css` with complex CSS keyframes. File listed in Phase 7 files touched.                |
| 6   | LOW      | Not addressed       | Monitor grid column verification still not explicitly noted. See Finding #5 below.                                                         |
| 7   | LOW      | **FIXED**           | Phase 3 task numbering is now sequential (3.1-3.9, no gaps).                                                                               |
| 8   | LOW      | **PARTIALLY FIXED** | Task 2.4 now references `useWorkflowSave.ts` only (no ambiguous "or useAutoSave"), but content contradicts Task 2.3. See Finding #1 below. |

All Round 3 HIGH and MEDIUM findings have been resolved.

### Cross-Phase Consistency Checks

#### 1. LLD <-> HLD Alignment (Section-to-Phase Mapping)

| HLD Section                      | LLD Phase                    | Status                |
| -------------------------------- | ---------------------------- | --------------------- |
| 0. Flow Direction LTR (0.1-0.11) | Phase 1 (tasks 1.1-1.6)      | COVERED               |
| 1. Tab Rename                    | Phase 2 (task 2.1)           | COVERED               |
| 2. Canvas Header (2.1-2.6)       | Phase 2 (tasks 2.2-2.4)      | COVERED               |
| 3. Remove QuickAddBar            | Phase 2 (task 2.5)           | COVERED               |
| 4. Handle Plus Menu (4.1-4.3)    | Phase 3 (tasks 3.1-3.3, 3.9) | COVERED               |
| 5. Node Delete                   | Phase 3 (tasks 3.4-3.5)      | COVERED               |
| 6. Edge Delete                   | Phase 3 (tasks 3.6-3.8)      | COVERED               |
| 7. Integration "Coming Soon"     | Phase 2 (task 2.6)           | COVERED               |
| 8.1-8.5 Debug Panel              | Phase 5 (tasks 5.1-5.4)      | COVERED               |
| 8.6 Context Object Panel         | Phase 5 (task 5.5)           | COVERED               |
| 8.7 Monitor Tab Integration      | Phase 6 (tasks 6.1-6.2)      | COVERED               |
| 8.8 Monitor KPI Summary          | Phase 6 (task 6.3)           | COVERED               |
| 8.9 Monitor Grid Columns         | Not explicitly addressed     | MINOR GAP             |
| 9. Run Behavior (9.1-9.5)        | Phase 4 (tasks 4.1-4.5)      | COVERED               |
| 10.1 Animation Constants         | Phase 1 (task 1.1)           | COVERED               |
| 10.2 Node Visual                 | Phase 7 (task 7.1)           | COVERED               |
| 10.3 Edge Visual                 | Phase 7 (task 7.2)           | COVERED               |
| 10.4 Handle Visual               | Phase 7 (task 7.3)           | COVERED               |
| 10.5 Panel Transitions           | Phase 7 (task 7.4)           | COVERED               |
| 10.6 Toolbar Refinement          | Phase 7 (task 7.9)           | COVERED               |
| 10.7 Canvas Background           | Phase 7 (task 7.6)           | COVERED               |
| 10.8 Selection & Multi-Select    | Phase 7 (task 7.10)          | COVERED               |
| 10.9 Drag & Drop Polish          | Phase 7 (task 7.7)           | COVERED               |
| 10.10 Execution Overlays         | Phase 7 (task 7.5)           | COVERED               |
| 10.11 Reduced Motion             | Phase 7 (task 7.8)           | COVERED               |
| 10.12 Dark Mode                  | Phase 7 (task 7.11)          | COVERED               |
| 10.13 Interaction Sound          | Deferred (Oracle Q5)         | DEFERRED (acceptable) |

**Result**: All HLD sections are covered except 8.9 (Monitor Grid Columns) and 10.13 (explicitly deferred). 8.9 is a minor gap -- the LLD should verify existing columns match spec or note them as unchanged.

#### 2. LLD <-> Test Spec Alignment

The test spec (`docs/testing/workflows.md`) covers backend workflow engine scenarios only (E2E-01 through E2E-10, INT-01 through INT-08). It has **zero canvas UX test scenarios**. The LLD Phase 8 references updating `workflow-canvas-uat.spec.ts` and `workflow-lifecycle.spec.ts`, which are existing E2E test files not tracked in the test spec.

**Key concern**: The LLD references ~34 `addNodeViaQuickAdd` call sites across 3 test files (29 in `workflow-canvas-uat.spec.ts`, 5 in `workflow-lifecycle.spec.ts`). These all need updating to `addNodeViaHandleMenu`. The LLD estimated "~25" -- the actual count is 34. This is not a blocking issue but the implementer should be aware.

**Test scenarios that reference removed components**: No test scenarios in the formal test spec reference QuickAddBar or the old toolbar buttons. The existing E2E files (`workflow-canvas-uat.spec.ts`) do reference `quick-add-bar`, `toolbar-save-btn`, `toolbar-deploy-btn` -- and the LLD Phase 8 correctly addresses removing these references.

**Result**: No formal test spec covers canvas UX. This was flagged in Round 1 (Finding #10) as LOW and acknowledged. The LLD Phase 8 is the de facto test plan. Acceptable for ALPHA.

#### 3. LLD <-> Feature Spec Alignment

The feature spec lists 30 FRs (FR-01 through FR-30). The canvas UX LLD does not introduce new FRs -- it enhances the Studio UI for existing capabilities. The relevant FRs are:

| FR                                      | Relevance to Canvas UX LLD            | LLD Coverage       |
| --------------------------------------- | ------------------------------------- | ------------------ |
| FR-20 (Execution status tracking)       | Debug panel displays execution status | Phase 5            |
| FR-21 (Redis Pub/Sub for status events) | Debug panel uses execution polling    | Phase 4 (task 4.5) |
| FR-24 (Studio human task inbox)         | Not directly affected by canvas UX    | N/A                |
| FR-25 (Studio task API client)          | Not directly affected                 | N/A                |

The feature spec's Out of Scope includes "Visual workflow builder/designer UI" -- but the canvas UX improvements are enhancements to the _existing_ canvas (which already ships), not a new visual builder. No scope violation.

**Result**: No feature spec alignment issues. The LLD is an enhancement to existing UI, not a new feature requiring new FRs.

#### 4. Phase Ordering & Dependencies

| Phase                  | Depends On                                                                          | Circular?                   |
| ---------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| Phase 1 (Foundation)   | None                                                                                | No                          |
| Phase 2 (Chrome)       | None (parallel-safe with Phase 1, but shares `workflow-canvas-store.ts`)            | No, but note shared file    |
| Phase 3 (Interactions) | Phase 1 (handles must be on Right side for plus menu positioning)                   | No                          |
| Phase 4 (Run)          | Phase 2 (toolbar refactored), Phase 5 partially (debug panel needed for direct run) | **ISSUE** -- see Finding #2 |
| Phase 5 (Debug Panel)  | Phase 1 (L-to-R node rendering for flow log icons)                                  | No                          |
| Phase 6 (Monitor Tab)  | Phase 5 (WorkflowDebugPanel must exist for slider)                                  | No                          |
| Phase 7 (Polish)       | Phases 1-6 (polishes all prior components)                                          | No                          |
| Phase 8 (E2E)          | Phases 1-3 (interaction patterns changed)                                           | No                          |

**Issue**: Phase 4 Task 4.1 says "clicking Run opens debug panel" -- but the new `WorkflowDebugPanel` is created in Phase 5. Phase 4 either needs to use the existing `ExecutionDebugPanel` (which Phase 5 later deletes) or Phase 5 must come before Phase 4. See Finding #2.

#### 5. Exit Criteria Consistency

Exit criteria in later phases correctly reference artifacts from earlier phases:

- Phase 3 assumes Phase 1's L-to-R handles (correct)
- Phase 5 assumes QuickAddBar removed (Phase 2) -- only implicitly
- Phase 6 assumes WorkflowDebugPanel exists (Phase 5) -- correct
- Phase 8 assumes all new interaction patterns exist -- correct

**One inconsistency**: Phase 4's exit criteria say "debug panel opens" but the _new_ debug panel doesn't exist until Phase 5. Phase 4 should clarify it opens the _existing_ `ExecutionDebugPanel`, which Phase 5 then replaces.

#### 6. Wiring Checklist Completeness

The wiring checklist (Section 4) covers all new components. Verified against the file change map:

- [x] HandlePlusMenu -> WorkflowNodeComponent, StartNodeComponent
- [x] NodeDeleteButton -> WorkflowNodeComponent, EndNodeComponent
- [x] EdgeDeleteButton -> WorkflowEdgeComponent
- [x] WorkflowDebugPanel -> WorkflowCanvasPage, WorkflowMonitorTab
- [x] DebugFlowLog -> WorkflowDebugPanel
- [x] StepLogItem -> DebugFlowLog
- [x] Store additions (removeEdge, canvasExpanded, addNode sourceInfo)
- [x] QuickAddBar removal, ExecutionDebugPanel removal
- [x] E2E helper replacement

**Missing from wiring checklist**: `canvas/styles/canvas-animations.css` import in `WorkflowCanvas.tsx` (added in task 7.12 but not in the wiring checklist).

### Findings

| #   | Severity   | Category             | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Location                                                                                               | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **HIGH**   | Internal Consistency | **Key Interfaces section contradicts task decisions on derived state.** The `WorkflowCanvasStore` interface (LLD lines 34-40) shows `saveStatus: 'idle' \| 'saving' \| 'saved' \| 'error'` with `setSaveStatus`, and `isExecuting: boolean` with `setIsExecuting` as new store fields. But Task 2.3 says "derive `saveStatus` from existing `isSaving`/`isDirty` state (do NOT add parallel `saveStatus` field)" and Task 4.3 says "derive `isExecuting` from `currentExecutionId`". The wiring checklist (line 502) also says both are derived. An implementer reading Section 1 will add store fields; an implementer reading the tasks will derive them. | LLD Section 1 (Key Interfaces, lines 34-40); contradicts Tasks 2.3, 4.3, and wiring checklist line 502 | Update the Key Interfaces section to remove `saveStatus`, `setSaveStatus`, `isExecuting`, and `setIsExecuting` from the `WorkflowCanvasStore` interface. Replace with a comment: `// saveStatus derived from isSaving/isDirty in CanvasToolbar` and `// isExecuting derived from currentExecutionId in CanvasToolbar`. This aligns the interface with the task descriptions.                                                         |
| 2   | **HIGH**   | Phase Dependency     | **Phase 4 depends on Phase 5 artifact.** Phase 4 Task 4.1 says clicking Run "opens debug panel" and Task 4.5 wires execution polling to "the debug panel." But `WorkflowDebugPanel` is created in Phase 5. If Phase 4 is implemented before Phase 5, the Run button must open the _existing_ `ExecutionDebugPanel` -- which Phase 5 then replaces. The current wording implies the new panel already exists.                                                                                                                                                                                                                                                | LLD Phase 4, Tasks 4.1 and 4.5                                                                         | Either: (a) Reorder so Phase 5 comes before Phase 4 (then Phase 4 opens the new panel), or (b) Clarify in Phase 4 that it opens the _existing_ `ExecutionDebugPanel` (via `setDebugPanelOpen(true)`) and Phase 5 replaces it. Option (b) is simpler -- add a note: "Phase 4 opens the existing debug panel. Phase 5 replaces the panel component; the store actions (`setDebugPanelOpen`, `setCurrentExecutionId`) remain the same." |
| 3   | **MEDIUM** | Internal Consistency | **Task 2.4 contradicts Task 2.3 on save status implementation.** Task 2.3 says to derive `saveStatus` from existing state (no new store field). Task 2.4 says "Update `useWorkflowSave.ts`: set `saveStatus` to `'saving'` on save start, `'saved'` on success, `'error'` on failure" -- implying `saveStatus` is a settable store field. If `saveStatus` is derived in the toolbar, `useWorkflowSave.ts` only needs to set `isSaving` and handle errors (which it mostly already does).                                                                                                                                                                    | LLD Phase 2, Task 2.4 vs Task 2.3                                                                      | Rewrite Task 2.4: "Update `useWorkflowSave.ts`: add save error state tracking (e.g., `saveError: boolean` in store or local state in the hook). The toolbar derives display status from `isSaving` (showing), `isDirty` (unsaved), `saveError` (failed), and a 3-second timer after `markSaved()` (for 'All changes saved' fade). No `saveStatus` field needed."                                                                     |
| 4   | **MEDIUM** | Completeness         | **E2E call site count underestimated.** Phase 8 says "replace all ~25 `addNodeViaQuickAdd` calls" but actual count is 34 (29 in `workflow-canvas-uat.spec.ts` + 5 in `workflow-lifecycle.spec.ts`). While not blocking, underestimating mechanical replacement work leads to incomplete Phase 8 execution.                                                                                                                                                                                                                                                                                                                                                  | LLD Phase 8, Task 8.2                                                                                  | Update to "replace all ~34 `addNodeViaQuickAdd` calls (29 in `workflow-canvas-uat.spec.ts`, 5 in `workflow-lifecycle.spec.ts`)" for accuracy.                                                                                                                                                                                                                                                                                        |
| 5   | **LOW**    | Completeness         | **HLD Section 8.9 (Monitor Grid Columns) still not addressed.** Round 3 Finding #6 noted this and it remains unresolved. The spec defines 8 specific columns with widths, sort behavior, and cell renderers. The LLD should verify whether the existing grid matches or note it as unchanged.                                                                                                                                                                                                                                                                                                                                                               | LLD Phase 6                                                                                            | Add a brief note to Phase 6: "Monitor grid columns are verified against spec 8.9 -- existing columns [match/require updates]. If updates are needed, list them; if they match, state 'grid columns unchanged, match spec.'"                                                                                                                                                                                                          |
| 6   | **LOW**    | Completeness         | **Wiring checklist missing `canvas-animations.css` import.** Task 7.12 creates `canvas/styles/canvas-animations.css` and says "Import in `WorkflowCanvas.tsx`." But the wiring checklist (Section 4) does not include this import.                                                                                                                                                                                                                                                                                                                                                                                                                          | LLD Section 4 (Wiring Checklist)                                                                       | Add to wiring checklist: "`canvas-animations.css` imported in `WorkflowCanvas.tsx`"                                                                                                                                                                                                                                                                                                                                                  |

### Cross-Phase Consistency Summary

| Check                        | Status | Notes                                                                                                                                       |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| XP-1 Backward traceability   | PASS   | Every LLD phase traces to specific HLD sections. All HLD sections covered (except 8.9 minor gap and 10.13 deferred).                        |
| XP-2 Forward compatibility   | PASS   | LLD enables E2E test updates (Phase 8) and post-impl sync. Exit criteria are testable.                                                      |
| XP-3 Scope lock              | PASS   | No new scope beyond what's in the HLD spec. Decision D-5 (interaction sounds) explicitly deferred.                                          |
| XP-4 Terminology consistency | PASS   | Consistent naming: "debug panel" (not "execution panel"), "handle plus menu" (not "context menu"), "flow" (not "steps") throughout.         |
| XP-5 Package agents.md       | PASS   | Studio `agents.md` read. Relevant gotchas (package name `@agent-platform/studio`, vitest force-exit, aria-labels) do not conflict with LLD. |

### Verified

- [x] All Round 3 HIGH and MEDIUM findings resolved (Context Object Panel, toolbar animations, selection/multi-select, dark mode, CSS animations file, task numbering)
- [x] HLD Section 0-10 all have corresponding LLD phases (except 8.9 minor, 10.13 deferred)
- [x] No circular phase dependencies
- [x] Phase exit criteria reference artifacts from prior phases correctly (with Phase 4/5 ordering caveat)
- [x] Wiring checklist covers all new components (missing CSS import noted)
- [x] Feature spec FRs not violated -- LLD is an enhancement, not a new feature
- [x] No scope creep beyond HLD spec
- [x] Terminology consistent across LLD, HLD, and feature spec

### Verdict

**NEEDS_REVISION**

2 HIGH findings must be fixed:

1. Key Interfaces section contradicts derived-state decisions from Tasks 2.3 and 4.3 -- implementer will get conflicting instructions
2. Phase 4 depends on Phase 5's WorkflowDebugPanel -- ordering or clarification needed

2 MEDIUM findings should be fixed: 3. Task 2.4 contradicts Task 2.3 on save status implementation 4. E2E call site count underestimated (34 actual vs ~25 stated)

2 LOW findings recommended: 5. Monitor grid column verification (carried from Round 3) 6. Wiring checklist missing CSS import

### Notes for Next Round

- Focus area for re-audit: Section 1 (Key Interfaces), Phase 4 dependency on Phase 5, Task 2.4 rewrite
- Remaining LOW findings from prior rounds (hardcoded colors, execution ring Tailwind palette) are acknowledged and deferred to implementation guidance -- no need to re-audit
- If HIGH findings are resolved, this LLD should be ready for APPROVED status in Round 5

---

## Audit Round 5 (Final)

**Focus**: Final sweep -- task independence, wiring checklist, domain rules, rollback safety, exit criteria measurability
**Reviewer**: lld-reviewer agent
**Date**: 2026-03-30

### Round 4 Findings Status

| #   | Severity | Status              | Notes                                                                                                                                                                                                                |
| --- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | **FIXED**           | Key Interfaces section now shows `saveStatus` and `isExecuting` as comments ("Derived, not stored") instead of store fields. No `setSaveStatus` or `setIsExecuting` in the interface. Aligns with Tasks 2.3 and 4.3. |
| 2   | HIGH     | **FIXED**           | Phase 4 Task 4.1 now has explicit note: "Phase 4 uses the existing `ExecutionDebugPanel` -- it will be replaced by `WorkflowDebugPanel` in Phase 5. The run behavior logic is independent of which panel renders."   |
| 3   | MEDIUM   | **FIXED**           | Task 2.4 rewritten to add `saveError` boolean tracking in `useWorkflowSave.ts`. Toolbar derives display status from `isSaving`, `isDirty`, and `saveError`. No conflicting `saveStatus` field.                       |
| 4   | MEDIUM   | **PARTIALLY FIXED** | Task 8.2 body text updated to "~34" but Files Touched comment still says "~25+ call sites". Minor inconsistency.                                                                                                     |
| 5   | LOW      | **NOT ADDRESSED**   | HLD Section 8.9 (Monitor Grid Columns) still has no mention in the LLD. Carried forward.                                                                                                                             |
| 6   | LOW      | **FIXED**           | Wiring checklist line 501 now includes `canvas/styles/canvas-animations.css` imported in `WorkflowCanvas.tsx`.                                                                                                       |

All Round 4 HIGH findings resolved. All MEDIUM findings resolved or partially resolved.

### Final Sweep Checks

#### 1. Task Independence & Size

All 8 phases are sequential (no parallel phases). Within each phase, tasks operate on distinct files or non-overlapping sections of the same file.

- **Largest new file**: `WorkflowDebugPanel.tsx` at ~350 LOC. This is a new file (not a rewrite), and it delegates to `DebugFlowLog.tsx` (~200) and `StepLogItem.tsx` (~180). The decomposition is appropriate.
- **Largest modification scope**: Phase 7 (Visual Polish) touches 9 files across 12 tasks. Each task is a focused visual change (shadows, edges, handles, etc.). This is the correct granularity -- attempting to split Phase 7 into sub-phases would create artificial dependencies.
- **Phase 8 mechanical work**: ~34 call site replacements in E2E tests. Mechanical but well-scoped to 3 files.

No task exceeds the "single session" threshold.

#### 2. Wiring Checklist Completeness

All 8 new files verified against the wiring checklist:

| New File                 | Wiring Entry                                                       | Status  |
| ------------------------ | ------------------------------------------------------------------ | ------- |
| `HandlePlusMenu.tsx`     | Line 486: imported in WorkflowNodeComponent + StartNodeComponent   | COVERED |
| `NodeDeleteButton.tsx`   | Line 487: imported in WorkflowNodeComponent + EndNodeComponent     | COVERED |
| `EdgeDeleteButton.tsx`   | Line 488: imported in WorkflowEdgeComponent                        | COVERED |
| `WorkflowDebugPanel.tsx` | Lines 489-490: imported in WorkflowCanvasPage + WorkflowMonitorTab | COVERED |
| `DebugFlowLog.tsx`       | Line 491: imported in WorkflowDebugPanel                           | COVERED |
| `StepLogItem.tsx`        | Line 492: imported in DebugFlowLog                                 | COVERED |
| `animation.ts`           | Line 494: constants imported in components                         | COVERED |
| `canvas-animations.css`  | Line 501: imported in WorkflowCanvas.tsx                           | COVERED |

Deleted files verified:

- `QuickAddBar.tsx` removal: Line 498 (import removed from WorkflowCanvasPage) COVERED
- `ExecutionDebugPanel.tsx` removal: Line 499 (import removed from WorkflowCanvasPage) COVERED

Store changes verified:

- `removeEdge`: Line 496 COVERED
- `canvasExpanded`: Line 497 COVERED
- `addNode` sourceInfo: Implied by HandlePlusMenu wiring COVERED

#### 3. Phase Rollback Safety

| Phase            | Rollback                                          | Cross-Phase Impact                                                           |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1 (Foundation)   | Revert handle positions; fitView fallback         | None -- later phases not yet committed                                       |
| 2 (Chrome)       | Revert toolbar; restore QuickAddBar from git      | Must re-add QuickAddBar before rolling back Phase 3                          |
| 3 (Interactions) | Delete new files; revert integrations             | QuickAddBar already removed in Phase 2 -- rollback restores handle menu only |
| 4 (Run)          | Revert to always-open RunDialog                   | Independent of panel choice (Phase 4/5 decoupled)                            |
| 5 (Debug Panel)  | Restore ExecutionDebugPanel from git              | Phase 6 depends on WorkflowDebugPanel -- must roll back Phase 6 first        |
| 6 (Monitor Tab)  | Revert to inline expansion                        | Independent                                                                  |
| 7 (Polish)       | Animations are additive; revert individual styles | No functional breakage                                                       |
| 8 (E2E)          | Test-only changes                                 | No production impact                                                         |

**Note**: Phase 5 rollback requires Phase 6 rollback first (Phase 6 imports WorkflowDebugPanel). This is inherent in the sequential dependency and acceptable.

#### 4. TODO/TBD Stubs

No deferred items without phase assignment. The only "stub" references are:

- `STUB_NODE_TYPES` -- existing codebase concept for "Coming soon" nodes
- Cancel API stub -- explicitly documented as disabled button with tooltip (Task 4.4)
- i18n -- documented as Open Question #4, acknowledged gap consistent with codebase patterns

#### 5. Domain Rules Compliance

| Rule                    | Status    | Notes                                                                                                                                                         |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No console.log          | N/A       | Frontend-only; no server logging                                                                                                                              |
| No `any`                | PASS      | All interfaces use typed fields                                                                                                                               |
| Structured errors       | N/A       | No backend routes                                                                                                                                             |
| Error handling pattern  | N/A       | No try/catch patterns specified                                                                                                                               |
| No inline magic numbers | **MINOR** | `#cbd5e1` hex color in Task 7.2 should be a named constant (e.g., `EDGE_DEFAULT_STROKE`). Noted in prior rounds, deferred to implementation.                  |
| Design tokens           | **MINOR** | Same hex color issue. ReactFlow style props don't use Tailwind classes, so the design-token-lint hook won't catch it. Implementation should define constants. |
| Zod validation          | N/A       | No API routes                                                                                                                                                 |
| Express route ordering  | N/A       | No backend routes                                                                                                                                             |

#### 6. Exit Criteria Measurability

All 60+ exit criteria across 8 phases are measurable:

- **Build success**: Every phase includes `pnpm build --filter=...` (automated, binary pass/fail)
- **UI behaviors**: Specific interactions described ("hovering shows X", "clicking does Y") -- verifiable via dev server
- **Absence checks**: "No references to X" -- verifiable via grep
- **Timing values**: "150ms transition", "350ms animation" -- verifiable via browser devtools
- **Visual polish** (Phase 7): Inherently subjective ("smooth", "subtle vignette") but appropriate for a polish phase; verified via manual inspection with `prefers-reduced-motion` toggle

No vague "it works" criteria found.

### Findings

| #   | Severity | Category             | Finding                                                                                                                                                           | Location                                      | Recommendation                                                                                                                                                |
| --- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **LOW**  | Internal Consistency | **E2E Files Touched comment still says "~25+"** while Task 8.2 body says "~34". Minor inconsistency carried from Round 4.                                         | LLD Phase 8, Files Touched section (line 468) | Update to "~34 call sites" for consistency.                                                                                                                   |
| 2   | **LOW**  | Completeness         | **HLD Section 8.9 (Monitor Grid Columns) unaddressed.** Carried from Rounds 3 and 4. The LLD should verify existing columns match spec or note them as unchanged. | LLD Phase 6                                   | Add a brief note: "Monitor grid columns verified against spec 8.9 -- [match existing / require updates]."                                                     |
| 3   | **LOW**  | Completeness         | **`getWorkflowInputVariables` utility location unspecified.** Task 4.1 says to extract this utility but does not specify which file it goes in.                   | LLD Phase 4, Task 4.1                         | Add target file: e.g., `canvas/utils/workflow-helpers.ts` or inline in `CanvasToolbar.tsx` if only used there. Implementation can decide, but noting the gap. |
| 4   | **LOW**  | Domain Rules         | **Hardcoded hex color `#cbd5e1` in Task 7.2.** Should be a named constant per "no inline magic numbers" rule.                                                     | LLD Phase 7, Task 7.2                         | Implementation note: define as `EDGE_DEFAULT_STROKE` constant in `canvas/constants/animation.ts` or a new `canvas/constants/colors.ts`.                       |

### Verified

- [x] **Round 4 fixes confirmed** -- both HIGH findings (Key Interfaces, Phase 4/5 dependency) fully resolved; MEDIUM findings resolved or partially resolved
- [x] **Task independence** -- all 8 phases sequential, no parallel file conflicts, tasks within phases operate on distinct files
- [x] **Task size** -- no task exceeds single-session scope; largest new file (350 LOC) properly decomposed across 3 components
- [x] **Wiring checklist complete** -- all 8 new files, 2 deleted files, and 3 store changes verified in wiring checklist
- [x] **Phase rollback safe** -- each phase has viable rollback; sequential dependencies (5->6) inherent and acceptable
- [x] **No TODO stubs** -- cancel API explicitly disabled; i18n gap documented; no deferred items without assignment
- [x] **Domain rules** -- frontend-only LLD, backend rules N/A; minor constant naming gap noted
- [x] **Exit criteria measurable** -- 60+ criteria all binary or visually verifiable; build commands in every phase
- [x] **File paths verified** -- all 16 modified files and 3 E2E test files confirmed to exist in codebase
- [x] **Shared component references verified** -- SlidePanel, MetricCard, JsonViewer, CollapsibleSection, VariableNamespaceTagPopover all exist with expected APIs
- [x] **HLD coverage** -- all 36 HLD sections mapped to LLD phases (except 8.9 minor, 10.13 deferred)

### Verdict

**APPROVED**

All CRITICAL and HIGH findings from Rounds 1-4 have been resolved. The 4 remaining findings are LOW severity -- minor consistency and completeness gaps that can be addressed during implementation without blocking.

### Implementation Notes

1. **Phase 2/3 coupling**: QuickAddBar deletion (Phase 2) removes the primary node-add mechanism. HandlePlusMenu (Phase 3) restores it. Implement these back-to-back or in the same session to avoid a broken intermediate state on the feature branch.
2. **Radix Popover dependency**: Run `pnpm why @radix-ui/react-popover --filter=@agent-platform/studio` before Phase 3. If not found, `pnpm add @radix-ui/react-popover --filter=@agent-platform/studio`.
3. **`getSmoothStepPath` availability**: Run `grep -r 'getSmoothStepPath' node_modules/@xyflow/` before Phase 7 Task 7.2. If unavailable, stick with `getBezierPath`.
4. **E2E count**: Actual `addNodeViaQuickAdd` call sites are 30 across 3 files (24 in UAT spec, 5 in lifecycle spec, 1 in helpers). Plan accordingly for Phase 8.
5. **Named constants**: Define `EDGE_DEFAULT_STROKE`, animation timing values, and other magic numbers as named constants during implementation.
6. **Monitor grid columns**: Verify existing `WorkflowMonitorTab` grid columns match HLD Section 8.9 during Phase 6 implementation. If they already match, no additional work needed.
