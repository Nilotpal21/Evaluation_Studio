# SDLC Log: Project Canvas — Phase 3 (HLD)

> **Date**: 2026-03-22
> **Phase**: High-Level Design
> **Artifact**: `docs/specs/project-canvas.hld.md`

## Architecture Summary

- **Client-side only feature**: No new API endpoints, no backend changes
- **5 new components**: ProjectCanvasPage, CanvasKpiBar, ViewModeToggle, AgentContextMenu, CanvasEmptyState
- **1 new store**: canvas-page-store (viewMode + kpiBarCollapsed preferences)
- **3 modified files**: AppShell (routing), ProjectSidebar (nav item), navigation-store (type extension)
- **8+ existing components reused**: ProjectCanvas, AgentNode, MetricCard, AgentEditorSlider, etc.
- **7 new files total** (5 components + 1 store + 1 i18n namespace)

## 12 Concerns Addressed

| Concern                  | Impact | Key Decision                                            |
| ------------------------ | ------ | ------------------------------------------------------- |
| Security                 | LOW    | Reuses existing authenticated SWR fetchers              |
| Tenant/Project Isolation | LOW    | Canvas state keyed by projectId (existing pattern)      |
| Performance              | MEDIUM | Parallel SWR, onlyRenderVisibleElements, instant toggle |
| Scalability              | LOW    | SWR deduplication, bounded viewport state               |
| Reliability              | MEDIUM | Independent SWR error handling per data source          |
| Observability            | LOW    | Performance marks, analytics events                     |
| Data Model               | NONE   | No DB changes, client-side preferences only             |
| API Design               | NONE   | No new endpoints, 7 existing endpoints reused           |
| Accessibility            | HIGH   | ARIA labels, keyboard nav, screen reader announcements  |
| Internationalization     | MEDIUM | ~20 new translation keys in 'canvas' namespace          |
| Testing                  | HIGH   | 7 E2E + 7 integration + 4 unit suites (from test spec)  |
| Deployment               | LOW    | Additive change, no feature flag, zero-risk rollback    |

## Alternatives Evaluated

| Alternative                   | Verdict  | Key Reason                                              |
| ----------------------------- | -------- | ------------------------------------------------------- |
| A: Replace overview entirely  | REJECTED | Breaks existing metrics-focused workflows               |
| B: Embed canvas in overview   | REJECTED | Canvas needs full viewport dedication                   |
| C: Tab-based in AgentListPage | REJECTED | Increases already-complex component, unclear navigation |

## Audit Notes

- All 12 architectural concerns addressed
- 3 alternatives evaluated with clear rationale
- Component hierarchy and data flow documented
- State management approach justified (new store vs extending existing)
- Migration path: zero breaking changes, zero-risk rollback
- Dependency graph shows 7 new files, 3 modified, 8+ reused
