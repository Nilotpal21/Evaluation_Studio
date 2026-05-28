# High-Level Design: ROI Tracking

**Feature**: ROI Tracking (#67)
**Status**: PLANNED
**Created**: 2026-03-23
**Last updated**: 2026-03-23

---

## 1. Overview

ROI Tracking provides project owners with a unified view of the business value delivered by AI agents. It combines real-time operational cost data from ClickHouse (LLM token costs, session counts) with configurable business assumptions (human agent costs, FTE capacity, budget) to compute savings, ROI percentages, and budget utilization. The feature exposes this through REST APIs and a Studio dashboard with KPI cards, trend charts, and what-if simulation.

### Architecture Principle

This design follows the "thin API route + service layer + existing calculator" pattern. The `ROICalculator` and `ProjectCostConfig` model already exist in `pipeline-engine`. The new work is:

1. A thin Express route layer in `runtime` that wires auth, isolation, and validation.
2. A service layer that orchestrates ClickHouse queries + calculator calls + Redis caching.
3. A Studio UI page that consumes the API via SWR hooks.
4. New platform event types for budget alerting.

---

## 2. Architecture

### Component Diagram

```
Studio (Next.js)                    Runtime (Express)                  Data Layer
+------------------+     HTTP      +------------------------+
| ROI Dashboard    |  --------->   | cost-config route      | ----> MongoDB (ProjectCostConfig)
| - KPI Cards      |               | roi route              | ----> ClickHouse (llm_metrics)
| - Cost Trend     |               |   /summary             | ----> Redis (cache)
| - Agent Breakdown|               |   /cost-trend          |
| - Simulation     |               |   /agent-breakdown     |
| Cost Config Panel|               |   /simulate            |
+------------------+               +------------------------+
                                          |
                                   +------v-------+
                                   | ROI Service  |
                                   | - getROISummary()
                                   | - getCostTrend()
                                   | - getAgentBreakdown()
                                   | - checkBudgetThresholds()
                                   +------+-------+
                                          |
                                   +------v-------+
                                   | ROICalculator| (existing, pipeline-engine)
                                   | ProjectCostConfig | (existing, pipeline-engine)
                                   | estimateCost() | (existing, shared-kernel)
                                   +--------------+
                                          |
                                   +------v-------+
                                   | EventStore   | (existing)
                                   | roi.budget.exceeded event
                                   +--------------+
```

### Data Flow

1. **Cost Config Write**: Studio -> PUT `/cost-config` -> validate (Zod) -> upsert MongoDB -> invalidate Redis cache.
2. **ROI Summary Read**: Studio -> GET `/roi/summary` -> check Redis cache -> if miss: query ClickHouse for actual AI cost in period -> load ProjectCostConfig from MongoDB -> combine with ROICalculator -> cache result (5 min TTL) -> return.
3. **Cost Trend Read**: Studio -> GET `/roi/cost-trend` -> query ClickHouse with time bucketing (GROUP BY date trunc) -> return time series.
4. **Agent Breakdown Read**: Studio -> GET `/roi/agent-breakdown` -> query ClickHouse GROUP BY agent_name -> return sorted by cost desc.
5. **What-If Simulation**: Studio -> POST `/roi/simulate` -> load config -> call `ROICalculator.simulateContainmentChange()` -> return.
6. **Budget Alert**: After ROI summary computation, if `actualAICost / monthlyBudget >= threshold` and not already alerted, emit `roi.budget.exceeded` platform event.

---

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

- All routes use `requireProjectScope('projectId')` middleware.
- All MongoDB queries include `{ tenantId, projectId }` in the filter -- never `findById`.
- All ClickHouse queries include `tenant_id` and `project_id` in the WHERE clause.
- Cross-tenant/cross-project access returns 404.
- Redis cache keys include `tenantId:projectId` prefix.

### 3.2 Authentication & Authorization

- All routes protected by `authMiddleware` (unified auth).
- Cost config read: `requireProjectPermission(req, res, 'analytics:read')`.
- Cost config write: `requireProjectPermission(req, res, 'analytics:write')`.
- ROI read endpoints: `requireProjectPermission(req, res, 'analytics:read')`.
- No custom token verification.

### 3.3 Data Model & Persistence

**MongoDB (ProjectCostConfig)**:

- Existing model at `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts`.
- New fields: `budgetAlertThresholds: number[]`, `lastAlertedThreshold: number`, `lastAlertedAt: Date`.
- Unique index on `(tenantId, projectId)` already exists.

**ClickHouse (llm_metrics / platform_events)**:

- Read-only queries. No schema changes needed.
- Queries aggregate `estimated_cost`, `input_tokens`, `output_tokens` from `llm.call.completed` events.

**Redis (cache)**:

- Key pattern: `roi:summary:{tenantId}:{projectId}:{dateHash}`.
- TTL: 300 seconds (5 minutes).
- Invalidated on cost config update.

### 3.4 API Design

All endpoints follow the standard envelope: `{ success: boolean, data?: T, error?: { code: string, message: string } }`.

**Cost Config Routes** (mount at `/api/projects/:projectId/cost-config`):

```
GET  /                   -> Read cost config
PUT  /                   -> Upsert cost config
```

**ROI Routes** (mount at `/api/projects/:projectId/roi`):

```
GET  /summary            -> ROI summary (savings, ROI%, FTE, budget)
GET  /cost-trend         -> Time-series cost data
GET  /agent-breakdown    -> Per-agent cost breakdown
POST /simulate           -> What-if simulation
```

**Zod Validation Schemas**:

Cost config body:

```typescript
z.object({
  costPerHumanInteraction: z.number().positive(),
  costPerAIInteraction: z.number().nonnegative(),
  fteCapacityPerDay: z.number().positive().int(),
  fteCostPerYear: z.number().positive(),
  monthlyBudget: z.number().positive(),
  containmentRate: z.number().min(0).max(1),
  totalConversationsPerMonth: z.number().nonnegative().int(),
  budgetAlertThresholds: z.array(z.number().min(0).max(2)).optional(),
});
```

Simulation body:

```typescript
z.object({
  containmentRate: z.number().min(0).max(1),
});
```

Time range query params:

```typescript
z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
});
```

### 3.5 Error Handling

| Error Condition            | Status | Response                                                                       |
| -------------------------- | ------ | ------------------------------------------------------------------------------ |
| No cost config for project | 404    | `{ success: false, error: { code: 'COST_CONFIG_NOT_FOUND', message: '...' } }` |
| ClickHouse unavailable     | 503    | `{ success: false, error: { code: 'ANALYTICS_UNAVAILABLE', message: '...' } }` |
| Invalid request body       | 400    | `{ success: false, error: { code: 'VALIDATION_ERROR', message: '...' } }`      |
| Unauthorized               | 401    | Standard auth error                                                            |
| Forbidden                  | 403    | Standard RBAC error                                                            |
| Cross-tenant/project       | 404    | Not found (no existence leakage)                                               |

Graceful degradation: If ClickHouse is down, the summary endpoint returns cached data if available, or a 503 with clear messaging. The UI shows a "data unavailable" banner rather than crashing.

### 3.6 Performance

- **ROI Summary**: Single ClickHouse aggregate query + MongoDB read + calculator computation. Cached in Redis (5 min TTL). Target: < 500ms P95.
- **Cost Trend**: Single ClickHouse query with date truncation. No caching (data changes frequently). Target: < 1s P95 for 90-day range.
- **Agent Breakdown**: Single ClickHouse query with GROUP BY. No caching. Target: < 500ms P95.
- **Simulation**: MongoDB read + in-memory computation. No ClickHouse needed. Target: < 100ms.
- **Cost Config CRUD**: MongoDB upsert with unique index. Target: < 200ms.

### 3.7 Observability & Traceability

- All service methods emit structured logs via `createLogger('roi-service')`.
- ROI summary computations emit `roi.summary.computed` platform event (for audit trail, not alerting).
- Budget threshold crossings emit `roi.budget.exceeded` platform event.
- ClickHouse query latency logged at `debug` level.
- Redis cache hits/misses logged at `debug` level.

### 3.8 Compliance & Data Privacy

- Cost configuration data is not PII. No encryption at rest beyond standard MongoDB encryption.
- No user-identifying data in ROI computations (aggregated metrics only).
- `roi.summary.computed` and `roi.budget.exceeded` events marked `containsPII: false`.
- TTL on Redis cache ensures stale data does not persist indefinitely.
- Cost config audit trail via `createdBy`, `createdAt`, `updatedAt` fields.

### 3.9 Scalability

- All queries are project-scoped with indexed fields.
- ClickHouse handles analytics workloads natively (columnar storage, predicate pushdown).
- Redis cache reduces ClickHouse query volume for frequently-accessed summaries.
- No in-memory state in the service layer (stateless design).
- Budget alert deduplication uses MongoDB `lastAlertedThreshold` + `lastAlertedAt` (not in-memory).

### 3.10 Backward Compatibility

- No breaking changes to existing APIs.
- New routes are additive (new mount points).
- `ProjectCostConfig` schema extension adds optional fields only -- existing documents unaffected.
- Existing `ROICalculator` API unchanged; new service wraps it.

### 3.11 Testing Strategy

- **59 new tests** (30 E2E, 13 integration, 16 unit) plus 7 existing.
- E2E tests exercise full middleware chain (auth, RBAC, isolation, validation).
- Integration tests verify service boundaries (calculator + ClickHouse + Redis + MongoDB).
- Unit tests cover formulas, validation schemas, and UI components.
- See `docs/testing/roi-tracking.md` for full test matrix.

### 3.12 Deployment & Migration

- **Zero-downtime deployment**: New routes are additive. No data migration needed.
- **Feature flag**: `FEATURE_ROI_TRACKING=true` (default `false`). Routes registered only when flag is true.
- **Rollback**: Disable feature flag. No data corruption risk.
- **MongoDB migration**: None (optional fields added to existing schema).
- **ClickHouse migration**: None (reads existing `llm_metrics` data).

---

## 4. Alternatives Considered

### Alternative 1: Compute ROI in Pipeline Engine (BullMQ Job)

**Description**: Run ROI computation as a scheduled BullMQ job that writes results to MongoDB.

**Pros**: Decouples computation from request path; always fresh; can handle complex computations.

**Cons**: Adds operational complexity (job scheduling, failure handling); results are stale between runs; overkill for the simple computations involved.

**Decision**: Rejected. Real-time computation with Redis caching is simpler and provides fresher data.

### Alternative 2: Client-Side ROI Computation

**Description**: Fetch raw cost data and compute ROI entirely in the browser.

**Pros**: Zero backend work for computation; instant updates.

**Cons**: Exposes raw cost data to client; computation duplicated if multiple consumers; no server-side caching; no budget alerting possible.

**Decision**: Rejected for summary (server computes and caches). Accepted for simulation slider (client-side for instant feedback).

### Alternative 3: Extend Existing `tenant-usage` Route

**Description**: Add ROI fields to the existing `/api/tenants/:tenantId/usage` endpoint.

**Pros**: Reuses existing infrastructure; fewer new routes.

**Cons**: Mixes tenant-level and project-level concerns; tenant-usage is ClickHouse-only while ROI needs MongoDB config; different permission models.

**Decision**: Rejected. Clean separation of concerns is worth the additional routes.

---

## 5. Packages Affected

| Package                    | Changes                                                                         | Scope    |
| -------------------------- | ------------------------------------------------------------------------------- | -------- |
| `packages/pipeline-engine` | Extend `ProjectCostConfig` schema (optional fields), export `ROICalculator`     | Minimal  |
| `apps/runtime`             | New route files: `cost-config.ts`, `roi.ts`. New service: `roi-service.ts`      | Moderate |
| `apps/studio`              | New page: ROI Dashboard. New settings panel: Cost Config. New hook: `useROI.ts` | Moderate |
| `packages/eventstore`      | New event schemas: `roi.summary.computed`, `roi.budget.exceeded`                | Minimal  |
| `packages/shared-kernel`   | No changes (existing `estimateCost` reused)                                     | None     |
| `packages/database`        | No changes (existing ClickHouse client reused)                                  | None     |

---

## 6. Sequence Diagrams

### ROI Summary Flow

```
Studio           Runtime Route        ROI Service         Redis       ClickHouse      MongoDB
  |  GET /roi/summary  |                  |                 |              |              |
  |-------------------->|                  |                 |              |              |
  |                     | getROISummary()  |                 |              |              |
  |                     |----------------->|                 |              |              |
  |                     |                  | GET cache       |              |              |
  |                     |                  |---------------->|              |              |
  |                     |                  |   cache miss    |              |              |
  |                     |                  |<----------------|              |              |
  |                     |                  | query cost      |              |              |
  |                     |                  |-------------------------------->|              |
  |                     |                  |   { totalCost } |              |              |
  |                     |                  |<--------------------------------|              |
  |                     |                  | load config     |              |              |
  |                     |                  |---------------------------------------------->|
  |                     |                  |   ProjectCostConfig            |              |
  |                     |                  |<----------------------------------------------|
  |                     |                  | ROICalculator.computeSummary() |              |
  |                     |                  | SET cache (5min)|              |              |
  |                     |                  |---------------->|              |              |
  |                     |                  | checkBudgetThresholds()        |              |
  |                     |  { ROISummary }  |                 |              |              |
  |                     |<-----------------|                 |              |              |
  | { success, data }   |                  |                 |              |              |
  |<--------------------|                  |                 |              |              |
```

### Budget Alert Flow

```
ROI Service               MongoDB                EventStore
  |                          |                      |
  | actualCost / budget >= threshold?               |
  | load lastAlertedThreshold                       |
  |------------------------->|                      |
  |   { lastAlertedThreshold, lastAlertedAt }       |
  |<-------------------------|                      |
  | threshold > lastAlertedThreshold?               |
  |   YES: emit roi.budget.exceeded                 |
  |-------------------------------------------->    |
  |   update lastAlertedThreshold                   |
  |------------------------->|                      |
  |                          |                      |
```

---

## 7. Open Questions

| #   | Question                                                                            | Status                                                                          | Owner       |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------- |
| 1   | Should the ROI dashboard be a top-level nav item or nested under Analytics?         | DECIDED: Top-level under "Insights" section                                     | Product     |
| 2   | Should cost config have per-agent overrides (different cost assumptions per agent)? | DEFERRED: Phase 2 enhancement                                                   | Product     |
| 3   | Should we auto-compute containment rate from session outcome data?                  | DEFERRED: Phase 2 when outcome classification is implemented                    | Engineering |
| 4   | Should budget alerts integrate with Slack/email notifications?                      | DEFERRED: Use existing alerting infrastructure when it supports custom channels | Engineering |
