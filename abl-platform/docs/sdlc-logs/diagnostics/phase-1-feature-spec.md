# SDLC Log: Diagnostics -- Phase 1 (Feature Spec)

> **Date:** 2026-03-22
> **Phase:** Feature Spec
> **Artifact:** `docs/features/diagnostics.md`

## Codebase Analysis

### Existing Diagnostics Infrastructure

Reviewed the following source files:

- `apps/runtime/src/services/diagnostics/engine.ts` -- DiagnosticEngine with pluggable analyzers, depth filtering, singleton pattern
- `apps/runtime/src/services/diagnostics/types.ts` -- Core types: DiagnosticFinding, DiagnosticReport, Analyzer interface
- `apps/runtime/src/services/diagnostics/diagnostic-patterns.ts` -- 8 trace-event pattern detectors
- `apps/runtime/src/services/diagnostics/analyzers/` -- 7 analyzers (model-resolution, credential-chain, tool-binding, encryption-availability, execution-status, empty-response, flow-state)
- `apps/runtime/src/routes/diagnostics.ts` -- 2 endpoints: agent diagnostic, session diagnostic
- `apps/runtime/src/routes/platform-admin-health.ts` -- 18-service health check registry
- `apps/runtime/src/health/service-registry.ts` -- Service definitions with groups and check methods
- `packages/mcp-debug/src/tools/diagnose.ts` -- MCP debug_diagnose tool
- `apps/admin/src/app/api/system-health/route.ts` -- Admin health proxy

### Key Findings

1. **7 analyzers already exist** across 3 categories (infra: 4, execution: 2, behavioral: 1)
2. **8 pattern detectors** for trace-event behavioral analysis
3. **No persistence**: Reports are ephemeral (returned from API, never stored)
4. **No scheduling**: Purely reactive diagnostics
5. **No Studio UI**: Only CLI/MCP/raw API access
6. **Auth/isolation properly implemented**: tenantId filtering, project permissions, rate limiting

## Decisions Made

| ID  | Decision                                                  | Classification                                         |
| --- | --------------------------------------------------------- | ------------------------------------------------------ |
| D1  | Separate panel in Studio (not inline in editor)           | DECIDED                                                |
| D2  | TTL-based cleanup at 30 days, no per-agent cap            | DECIDED                                                |
| D3  | Defer notification integration to Phase 4                 | DECIDED                                                |
| D4  | BullMQ for scheduling (consistent with existing patterns) | INFERRED (from codebase patterns)                      |
| D5  | MongoDB for report persistence (not ClickHouse)           | DECIDED (reports are small documents, not time-series) |

## Artifact Quality

- **18 sections** completed (all template sections)
- **20 functional requirements** (8 P0, 8 P1, 4 P2)
- **7 non-functional requirements**
- **9 user stories** with acceptance criteria
- **3 data models** defined (StoredDiagnosticReport, DiagnosticSchedule, RemediationAction)
- **6 API endpoints** designed (4 new, 2 modified)
- **5 risks** identified with mitigations

## Audit Findings

Self-audit:

- All 18 sections populated
- FR IDs are sequential and traceable to user stories
- Data models include proper tenant/project isolation
- Security section addresses SSRF, credential exposure, audit logging
- Performance section addresses compression, pagination, staggering
