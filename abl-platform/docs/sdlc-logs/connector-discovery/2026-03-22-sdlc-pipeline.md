# SDLC Pipeline Log: Connector Discovery

- **Feature ID**: #39
- **Date**: 2026-03-22
- **Pipeline Run**: Full 4-phase (Feature Spec, Test Spec, HLD, LLD)

---

## Pipeline Summary

| Phase           | Artifact                                  | Location                                                 | Status   |
| --------------- | ----------------------------------------- | -------------------------------------------------------- | -------- |
| 1. Feature Spec | 18-section feature specification          | `docs/features/connector-discovery.md`                   | COMPLETE |
| 2. Test Spec    | 7 E2E + 7 integration scenarios           | `docs/testing/connector-discovery.md`                    | COMPLETE |
| 3. HLD          | 12 architectural concerns, 3 alternatives | `docs/specs/connector-discovery.hld.md`                  | COMPLETE |
| 4. LLD          | 5-phase implementation plan               | `docs/plans/2026-03-22-connector-discovery-impl-plan.md` | COMPLETE |

## Key Findings

### Existing Implementation Audit

The connector discovery feature already has substantial implementation across 7 packages:

1. **Well-designed interfaces**: `IResourceDiscovery`, `BaseResourceDiscovery`, recommendation types in `packages/connectors/base`
2. **Working SharePoint discovery**: Full implementation with Graph API integration
3. **Complete recommendation engine**: Pure deterministic scoring, 440+ LOC
4. **Full REST API**: 7 endpoints in `apps/search-ai/src/routes/connector-discovery.ts`
5. **Studio UI integration**: EnterpriseConnectorWizard with 5-step flow

### Identified Gaps (10 total)

| ID   | Gap                                       | Severity | Phase   |
| ---- | ----------------------------------------- | -------- | ------- |
| G-1  | Only SharePoint discovery implemented     | HIGH     | Phase 3 |
| G-2  | Hard-coded connector switch in worker     | MEDIUM   | Phase 1 |
| G-3  | console.error in route handlers           | MEDIUM   | Phase 1 |
| G-4  | No Zod request body validation            | MEDIUM   | Phase 1 |
| G-5  | No TraceEvent emission                    | MEDIUM   | Phase 2 |
| G-6  | No project-level isolation                | LOW      | Future  |
| G-7  | 16MB MongoDB document limit risk          | LOW      | Monitor |
| G-8  | No discovery re-run scheduling            | LOW      | Future  |
| G-9  | Polling instead of WebSocket for progress | LOW      | Future  |
| G-10 | No lock TTL renewal for long discoveries  | MEDIUM   | Phase 2 |

### Test Coverage Assessment

**Current state**: ~30% overall coverage. Existing tests are heavily mocked:

- Route tests mock DB, orchestrator, and worker
- Worker tests mock everything, only test exports
- No integration or E2E tests exist

**Target state**: 80% overall coverage with:

- 7 E2E scenarios (real HTTP server, full middleware)
- 7 integration scenarios (real MongoDB, mocked external APIs only)

### Functional Requirements Count

- **8 functional requirements** (FR-1 through FR-8)
- **5 non-functional requirements** (NFR-1 through NFR-5)
- **5 user stories** (US-1 through US-5)

### LLD Phase Count

- **5 implementation phases** with total estimated effort of 8 days
- Phase dependency chain: P1 -> P2/P3 (parallel) -> P4 -> P5

## Codebase Files Analyzed

| File                                                                            | Lines | Purpose              |
| ------------------------------------------------------------------------------- | ----- | -------------------- |
| `apps/search-ai/src/routes/connector-discovery.ts`                              | 368   | 7 REST endpoints     |
| `apps/search-ai/src/workers/connector-discovery-worker.ts`                      | 277   | BullMQ worker        |
| `apps/search-ai/src/services/setup/quick-setup-orchestrator.ts`                 | 265   | 3-step orchestrator  |
| `apps/search-ai/src/services/recommendation/recommendation-engine.service.ts`   | 443   | Scoring engine       |
| `packages/connectors/base/src/interfaces/resource-discovery.interface.ts`       | 107   | Core interface       |
| `packages/connectors/base/src/interfaces/recommendation.interface.ts`           | 109   | Recommendation types |
| `packages/connectors/base/src/interfaces/connector.interface.ts`                | 152   | Connector interface  |
| `packages/connectors/base/src/discovery/base-resource-discovery.ts`             | 177   | Base class           |
| `packages/connectors/sharepoint/src/discovery/sharepoint-resource-discovery.ts` | 193   | SharePoint impl      |
| `packages/database/src/models/connector-discovery.model.ts`                     | 146   | MongoDB model        |
| `packages/database/src/models/connector-schema.model.ts`                        | 89    | Schema model         |
| `apps/search-ai/src/services/schema-discovery/base-discovery.service.ts`        | 458   | Schema discovery     |
| `apps/studio/src/components/search-ai/EnterpriseConnectorWizard.tsx`            | 600+  | Studio wizard        |

## Design Decisions Made

1. **Deterministic scoring over LLM**: Recommendation engine uses weighted factors, not LLM
2. **BullMQ over inline execution**: Discovery runs in background worker
3. **Distributed lock over job deduplication**: Explicit lock with TTL
4. **Embedded arrays over separate collections**: Discovery results stored in single document
5. **Template Method pattern**: Matches existing BaseSyncCoordinator pattern

## Audit Notes

- Feature spec covers all 18 template sections
- Test spec has 7 E2E + 7 integration scenarios (exceeds minimum 5 + 5)
- HLD addresses all 12 architectural concerns
- LLD has 5 phases with explicit exit criteria per phase
- No CRITICAL findings; 10 gaps identified (3 HIGH, 5 MEDIUM, 2 LOW+Monitor)
