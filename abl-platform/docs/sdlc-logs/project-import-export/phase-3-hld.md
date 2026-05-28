# Phase 3: HLD — project-import-export

> **Date:** 2026-03-23
> **Status:** COMPLETE

## Summary

Generated High-Level Design document covering all 12 architectural concerns, 3 design alternatives with rationale, and complete data model / API documentation based on full source code analysis.

## Key Findings

- **Architecture is sound**: 7-module decomposition (export, import, dependencies, diff, ownership, git, types) provides clean separation of concerns.
- **Two-wave export assembly** is well-designed: core+connections first (dependency order), then optional layers in parallel.
- **Staged import with per-layer rollback** is the correct pattern for multi-entity imports.
- **Tenant isolation gap**: ProjectAgent lacks direct `tenantId` -- relies on `projectId -> Project.tenantId` join. The `requireProjectScope` middleware mitigates this but it is an implicit coupling.
- **Route layer is v1-only**: REST API currently uses v1 orchestrators; v2 (layered) is library-only. Upgrading routes to v2 is a P1 gap.
- **Observability gap**: No TraceEvent emission for import/export operations.

## Twelve Concerns Coverage

| #   | Concern                        | Status                                                                  |
| --- | ------------------------------ | ----------------------------------------------------------------------- |
| 1   | Tenant Isolation               | ADDRESSED (with noted gap on ProjectAgent)                              |
| 2   | Authentication & Authorization | ADDRESSED                                                               |
| 3   | Data Integrity                 | ADDRESSED (lockfile hashes + staged import)                             |
| 4   | Performance & Scalability      | ADDRESSED (size guards + benchmarks)                                    |
| 5   | Concurrency Control            | ADDRESSED (Redis distributed lock)                                      |
| 6   | Error Handling                 | ADDRESSED (standard envelope + rollback)                                |
| 7   | Observability                  | PARTIAL (logging yes, trace events no)                                  |
| 8   | Backward Compatibility         | ADDRESSED (v1/v2 coexistence + migration)                               |
| 9   | Security                       | ADDRESSED (path traversal, credential protection, webhook verification) |
| 10  | Deployment & Operations        | ADDRESSED (library dependency, no separate service)                     |
| 11  | Extensibility                  | ADDRESSED (layer system, provider interface)                            |
| 12  | Testing Strategy               | ADDRESSED (3-layer with noted E2E gap)                                  |

## Alternatives Evaluated

1. ZIP/tar.gz as primary format -- REJECTED (API ergonomics)
2. Database dump instead of DSL -- REJECTED (human-readability, Git compatibility)
3. Event sourcing for import -- REJECTED (complexity vs. current scale)

## Files Changed

- Created: `docs/specs/project-import-export.hld.md`
- Created: `docs/sdlc-logs/project-import-export/phase-3-hld.md`
