# SDLC Log: ROI Tracking -- Phase 3: HLD

**Date**: 2026-03-23
**Phase**: HLD
**Artifact**: `docs/specs/roi-tracking.hld.md`

## Decisions Log

| ID  | Question                                                 | Classification | Decision                                                                                            |
| --- | -------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| D1  | Compute ROI on-demand vs. scheduled job?                 | DECIDED        | On-demand with Redis cache (5 min TTL). Simpler than BullMQ job, data fresher.                      |
| D2  | Extend existing tenant-usage route or create new routes? | DECIDED        | New routes. Clean separation of tenant-level billing vs. project-level ROI.                         |
| D3  | Where does ROI service live?                             | DECIDED        | `apps/runtime/src/services/roi-service.ts`. Close to the route layer, imports from pipeline-engine. |
| D4  | Feature flag strategy?                                   | DECIDED        | `FEATURE_ROI_TRACKING=true` env var. Routes only registered when enabled.                           |
| D5  | Cache invalidation strategy?                             | DECIDED        | Invalidate on cost config update (explicit). TTL expiry for ClickHouse data staleness (passive).    |
| D6  | Budget alert deduplication?                              | DECIDED        | Store `lastAlertedThreshold` + `lastAlertedAt` in MongoDB (not Redis). Survives pod restarts.       |

## 12 Concerns Coverage

All 12 architectural concerns addressed:

1. Tenant Isolation -- tenantId + projectId in all queries, 404 for cross-scope
2. Authentication & Authorization -- unified auth + RBAC permissions
3. Data Model & Persistence -- existing schema extended, no new collections
4. API Design -- standard envelope, Zod validation, RESTful endpoints
5. Error Handling -- graceful degradation, specific error codes
6. Performance -- Redis cache, ClickHouse queries, < 500ms targets
7. Observability -- structured logging, platform events
8. Compliance -- no PII, standard audit fields
9. Scalability -- stateless service, indexed queries, columnar analytics
10. Backward Compatibility -- additive changes only, optional schema fields
11. Testing Strategy -- 59 new tests across E2E/integration/unit
12. Deployment & Migration -- feature flag, zero-downtime, no data migration

## Audit Round 1

- Sequence diagrams accurately reflect data flow
- All ClickHouse queries include tenant_id + project_id isolation
- Redis cache key includes tenantId:projectId to prevent cross-tenant cache poisoning
- Budget alert deduplication prevents alert storms
- No in-memory Maps or state -- fully stateless service
