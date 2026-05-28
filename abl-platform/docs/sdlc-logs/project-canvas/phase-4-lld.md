# SDLC Log: Project Canvas — Phase 4 (LLD)

> **Date**: 2026-03-22
> **Phase**: Low-Level Design + Implementation Plan
> **Artifact**: `docs/plans/2026-03-22-project-canvas-impl-plan.md`

## Implementation Summary

| Aspect              | Value                                        |
| ------------------- | -------------------------------------------- |
| Total phases        | 5                                            |
| New files           | 7 (5 components + 1 store + 1 types)         |
| Modified files      | 5 (routing, sidebar, navigation, node, i18n) |
| Test files          | 1                                            |
| Estimated new lines | ~640                                         |
| Estimated effort    | 10-15 hours                                  |

## Phase Breakdown

| Phase | Name              | Files             | Key Deliverable                                 |
| ----- | ----------------- | ----------------- | ----------------------------------------------- |
| P1    | Foundation        | 2 new, 3 modified | Store, types, navigation wiring                 |
| P2    | Core Page         | 4 new             | ProjectCanvasPage, KPI bar, toggle, empty state |
| P3    | Node Enhancements | 2 modified        | Status badges, resource indicators              |
| P4    | Context Menu      | 1 new, 2 modified | Right-click actions, keyboard shortcuts         |
| P5    | Polish + Tests    | 1 new, 1 modified | i18n, responsive, unit/integration tests        |

## Exit Criteria Per Phase

- P1: 6 exit criteria (store exists, route works, sidebar item visible, type-check passes)
- P2: 10 exit criteria (data rendering, toggle, persistence, empty state, mobile fallback)
- P3: 7 exit criteria (status dots, resource badges, semantic zoom, no regression)
- P4: 8 exit criteria (context menu, keyboard shortcuts, disabled states, a11y)
- P5: 8 exit criteria (i18n, tests passing, responsive, theming)

## Wiring Checklist

12 critical integration points documented:

1. AppShell routing
2. Sidebar highlight
3. Breadcrumb
4. URL parsing
5. SWR key sharing
6. Store naming
7. Optional node data
8. Context menu portal
9. Keyboard shortcut guards
10. Mobile breakpoint
11. Import/Export dialogs
12. Deep link hash

## Key Design Decisions

| #     | Decision                                         | Rationale                                                                                                 |
| ----- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| LLD-1 | Separate canvas-page-store from canvas-store     | canvas-store manages ReactFlow state; canvas-page-store manages page preferences. Separation of concerns. |
| LLD-2 | Phase 3 parallel with Phase 2                    | AgentNode enhancements are independent of page orchestrator                                               |
| LLD-3 | Extract formatNumber to shared utility           | Currently duplicated in ProjectOverviewPage; DRY principle                                                |
| LLD-4 | Context menu via portal                          | Avoids z-index conflicts with ReactFlow SVG layers                                                        |
| LLD-5 | Optional status/resource fields on AgentNodeData | Backward compatible with existing callers that don't provide status                                       |

## Risks Identified

| Risk                        | Phase | Severity | Mitigation                          |
| --------------------------- | ----- | -------- | ----------------------------------- |
| AgentNode regression        | P3    | Medium   | Optional fields with defaults       |
| Large topology perf         | P2    | Medium   | Reuse onlyRenderVisibleElements     |
| View mode hydration flicker | P2    | Low      | Zustand persist handles this        |
| Context menu z-index        | P4    | Low      | Portal rendering                    |
| SWR cache key collision     | P2    | Low      | Same keys = cache sharing (desired) |
