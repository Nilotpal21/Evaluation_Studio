# SDLC Log: LLD — Analytics Insights Dashboard

**Date**: 2026-03-23
**Phase**: 4 — LLD
**Status**: DONE

## Decisions

| #   | Classification | Decision                                                                                                                  |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| D-1 | DECIDED        | 10-phase implementation: proxy -> store -> hooks -> widgets -> dashboard -> agent -> quality -> customer -> i18n -> tests |
| D-2 | DECIDED        | Must add `pipeline-analytics` to `RUNTIME_PROJECT_SUBPATH_RE` in proxy.ts — currently missing                             |
| D-3 | DECIDED        | 22 new files + 4 modified files across Studio and i18n packages                                                           |
| D-4 | DECIDED        | Agent detail as expandable panel (not separate page) for context preservation                                             |
| D-5 | DECIDED        | ChurnRiskWidget may need fallback to NL query or "Coming Soon" if no direct endpoint exists                               |

## Key Findings

- **CRITICAL**: `pipeline-analytics` is NOT in Studio's proxy regex (`RUNTIME_PROJECT_SUBPATH_RE`). Requests to `/api/projects/:projectId/pipeline-analytics/*` from the browser will 404 at the Studio middleware layer. This MUST be fixed in Phase 1.
- **Proxy gap extends to other routes**: `analytics`, `nl-analytics`, `alerts`, `custom-events`, `tags` are also runtime-only routes not in the proxy regex. The existing Studio workaround uses a dedicated proxy route at `/api/runtime/analytics` that manually constructs the runtime URL. The pipeline-analytics API needs similar treatment OR the regex must be expanded.
- **Predictive features (churn risk)**: The `compute-predictive-features` service writes to a ClickHouse table but there's no pipeline-analytics summary query for it. The ChurnRiskWidget may need a custom ClickHouse query via the NL query service or a direct analytics endpoint.
- **AppShell lazy loading**: The existing pattern uses `next/dynamic` for heavy chart components. The 3 new page components should follow this pattern to avoid loading Recharts eagerly.

## Audit Summary

- 10 implementation phases with clear exit criteria per phase
- 7-item wiring checklist covering proxy, AppShell, i18n, and store connections
- 22 new files, 4 modified files identified
- Risk mitigations for proxy, empty data, bundle size, N+1 queries, and missing endpoints
- File inventory with phase assignments for all deliverables
