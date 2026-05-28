# HLD: Tags & Eval Tags

**Feature Spec**: `docs/features/tags.md`
**Test Spec**: `docs/testing/tags.md`
**Status**: DRAFT
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

The ABL platform has partial tagging infrastructure spread across three packages:

- **MongoDB TagRuleModel** (`packages/pipeline-engine/src/schemas/tag-rule.schema.ts`): Per-project tag rules with conditions, operators, color, auto-apply flag
- **Session.tags field** (`packages/database/src/models/session.model.ts`): `string[]` on sessions, never written by the API
- **ClickHouse conversation_tags** (`packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`): Analytics store with applied_at, applied_by, rule_id
- **Runtime API** (`apps/runtime/src/routes/tags.ts`): CRUD for rules, manual apply (ClickHouse-only), conversation query

Six critical gaps prevent production use: no Studio UI (GAP-4), no auto-apply engine (GAP-3), no tag removal endpoint (GAP-2), `POST /apply` only writes to ClickHouse not MongoDB (GAP-1), no input validation on `PUT /rules/:ruleId` (GAP-6), and no tag count cap per session (GAP-7).

This HLD designs the completion of the tagging subsystem: new API endpoints, a tag service layer, an auto-apply engine, Studio proxy routes, and Studio UI components.

---

## 2. Alternatives Considered

### Option A: In-Route Tag Service (Stateless, Synchronous)

- **Description**: Add new endpoints (`/remove`, `/bulk-apply`, `/bulk-remove`, `/stats`) directly in the existing `tags.ts` route file. Extract a `TagService` class into `apps/runtime/src/services/tag-service.ts` that handles dual-write (MongoDB + ClickHouse), condition evaluation, and auto-apply logic. Auto-apply is triggered synchronously by calling `TagService.evaluateAutoApplyRules()` from the session status update path.
- **Pros**: Follows existing route-handler pattern (all tags routes are already in one file). No new infrastructure (no BullMQ queues). Simple request-response flow. Easy to test -- service class with injectable dependencies. Low blast radius -- changes are localized to one route file and one service.
- **Cons**: Synchronous auto-apply adds latency to session lifecycle operations (though rule evaluation is O(n) with n < 100, so < 10ms expected). All logic in the runtime process -- no separation of concerns for compute-heavy backfill operations.
- **Effort**: S (Small)

### Option B: BullMQ Worker-Based Auto-Apply

- **Description**: Same as Option A for CRUD/apply/remove/bulk/stats, but auto-apply is decoupled into a BullMQ job. When a session status changes, the runtime enqueues a `tag-auto-apply` job. A dedicated worker picks it up, evaluates rules, and applies matching tags.
- **Pros**: Non-blocking -- session lifecycle is never delayed by tag evaluation. Can handle backfill of historical sessions via job batching. Retry semantics built into BullMQ. Worker can be scaled independently.
- **Cons**: Added infrastructure complexity (new BullMQ queue, worker registration, Redis dependency). More moving parts to test and monitor. Introduces eventual consistency delay between session change and tag application. The existing auto-apply rule set is expected to be < 100 rules per project -- the overhead of BullMQ is disproportionate for sub-10ms evaluation time.
- **Effort**: M (Medium)

### Option C: Event-Driven via Custom Events Table

- **Description**: Instead of direct function calls or job queues, use the existing ClickHouse `custom_events` table to emit tag-related events. A ClickHouse materialized view automatically aggregates tags. Auto-apply rules are evaluated via a ClickHouse query that joins sessions against rules.
- **Pros**: Leverages existing ClickHouse infrastructure. Materialized views handle aggregation automatically. No new runtime code for stats.
- **Cons**: ClickHouse is not a transactional database -- no rollback on partial failures. Complex SQL for condition evaluation with dynamic operators. Cannot update MongoDB Session.tags from ClickHouse. Loses the simple CRUD model. Debugging is harder (MV execution is opaque).
- **Effort**: L (Large)

### Recommendation: Option A (In-Route Tag Service, Synchronous)

**Rationale**: Option A provides the simplest path to closing all gaps with minimal infrastructure changes. The auto-apply evaluation is O(n) where n < 100, completing in < 10ms -- BullMQ overhead (Option B) is unjustified. ClickHouse-native evaluation (Option C) cannot update MongoDB and adds significant complexity. The TagService class provides testable separation of concerns without architectural overhead. If auto-apply latency becomes a concern at scale, it can be migrated to BullMQ later (the service interface would be unchanged).

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Browser (Project Admin / Operator)          │
│                                                                │
│  ┌───────────────────────┐  ┌─────────────────────────────┐  │
│  │  Tag Rules Page        │  │  Session Detail (Tag Chips) │  │
│  │  (CRUD tag rules)      │  │  (Apply/Remove tags)        │  │
│  └────────┬───────────────┘  └──────────┬──────────────────┘  │
│           │ apiFetch                     │ apiFetch             │
└───────────┼──────────────────────────────┼─────────────────────┘
            │                              │
            ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Studio (Next.js)                                             │
│  /api/projects/[id]/tags/rules     (proxy)                    │
│  /api/projects/[id]/tags/apply     (proxy)                    │
│  /api/projects/[id]/tags/remove    (proxy)                    │
│  /api/projects/[id]/tags/stats     (proxy)                    │
│  Auth: requireTenantAuth + requireProjectAccess               │
└─────────────────────┬────────────────────────────────────────┘
                      │ HTTP (internal)
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  Runtime (Express)                                            │
│  /api/projects/:projectId/tags/*                              │
│  Auth: authMiddleware + requireProjectScope + tenantRateLimit │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  TagService                                               │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │ │
│  │  │ Rule CRUD   │  │ Apply/Remove │  │ Auto-Apply     │  │ │
│  │  │ (MongoDB)   │  │ (dual-write) │  │ Engine         │  │ │
│  │  └──────┬──────┘  └──┬─────┬─────┘  └──────┬─────────┘  │ │
│  └─────────┼────────────┼─────┼────────────────┼────────────┘ │
│            │            │     │                │               │
└────────────┼────────────┼─────┼────────────────┼───────────────┘
             │            │     │                │
     ┌───────▼───────┐   │     │     ┌──────────▼──────────┐
     │  MongoDB       │   │     │     │  Session Lifecycle   │
     │  - tag_rules   │◄──┘     │     │  (status changes)    │
     │  - sessions    │         │     └─────────────────────┘
     │    (.tags[])   │         │
     └───────────────┘         │
                                │
                    ┌───────────▼───────────┐
                    │  ClickHouse            │
                    │  - conversation_tags   │
                    └───────────────────────┘
```

### Component Diagram

```
apps/runtime/src/
├── routes/
│   └── tags.ts                    # Route handlers (thin — delegates to TagService)
├── services/
│   └── tag-service.ts             # TagService class
│       ├── createRule()           # → MongoDB TagRuleModel
│       ├── updateRule()           # → MongoDB (with Zod validation)
│       ├── deleteRule()           # → MongoDB
│       ├── listRules()            # → MongoDB
│       ├── applyTags()            # → MongoDB Session.$addToSet + ClickHouse INSERT
│       ├── removeTags()           # → MongoDB Session.$pull + ClickHouse DELETE
│       ├── bulkApplyTags()        # → Loop over applyTags() with error collection
│       ├── bulkRemoveTags()       # → Loop over removeTags() with error collection
│       ├── getStats()             # → ClickHouse aggregation query
│       └── evaluateAutoApply()    # → Load rules, evaluate conditions, apply matches
└── services/
    └── tag-condition-evaluator.ts # Pure function: (session, conditions, logic) → boolean

apps/studio/src/
├── app/api/projects/[id]/tags/
│   ├── rules/route.ts             # Proxy: GET/POST → runtime /tags/rules
│   ├── rules/[ruleId]/route.ts    # Proxy: PUT/DELETE → runtime /tags/rules/:ruleId
│   ├── apply/route.ts             # Proxy: POST → runtime /tags/apply
│   ├── remove/route.ts            # Proxy: POST → runtime /tags/remove
│   └── stats/route.ts             # Proxy: GET → runtime /tags/stats
└── components/tags/
    ├── TagRulesPage.tsx            # Settings page: list + create/edit/delete
    ├── TagRuleDialog.tsx           # Modal: condition builder for tag rules
    ├── TagChips.tsx                # Inline tag display with add/remove
    └── TagFilter.tsx               # Multi-select filter for session/eval lists
```

### Data Flow

#### Manual Tag Apply

```
1. Operator clicks "Add Tag" on session detail → Studio UI
2. Studio UI: POST /api/projects/[id]/tags/apply { sessionId, tags: ['vip'] }
3. Studio proxy: requireTenantAuth + requireProjectAccess → forward to runtime
4. Runtime: authMiddleware + requireProjectScope + requireProjectPermission('session:write')
5. TagService.applyTags(tenantId, projectId, sessionId, tags, userId):
   a. MongoDB: Session.updateOne({ _id: sessionId, tenantId }, { $addToSet: { tags: { $each: ['vip'] } } })
   b. ClickHouse: INSERT INTO conversation_tags (tenant_id, project_id, session_id, tag_name, applied_by, rule_id)
      VALUES ('t1', 'p1', 's1', 'vip', 'user-1', 'manual')
6. Return { success: true, data: { applied: 1 } }
```

#### Auto-Apply on Session End

```
1. Session lifecycle: session.status changes to 'completed'
2. SessionRepository.updateStatus() calls TagService.evaluateAutoApply(tenantId, projectId, sessionId)
3. TagService loads auto-apply rules: TagRuleModel.find({ tenantId, projectId, autoApply: true })
4. For each rule, evaluateConditions(session, rule.conditions, rule.conditionLogic):
   - Reads session fields (status, channel, messageCount, etc.)
   - Evaluates each condition using the condition evaluator
   - Applies AND/OR logic
5. For matching rules: TagService.applyTags(tenantId, projectId, sessionId, [rule.tagName], 'system')
6. Failures logged but do not block session lifecycle
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All MongoDB queries include `{ tenantId }` in the filter. All ClickHouse queries use `WHERE tenant_id = {tenantId:String}` with parameterized values. Tag rules have a unique compound index on `{ tenantId, projectId, tagName }`. Cross-tenant access returns 404 via `findOneAndUpdate({ _id, tenantId, projectId })`.                                                                                         |
| 2   | **Data Access Pattern** | New `TagService` class in `apps/runtime/src/services/tag-service.ts` encapsulates all data access. Lazy-loads TagRuleModel from `@agent-platform/pipeline-engine` and Session from `@agent-platform/database/models` (matching existing pattern in `tags.ts`). No direct model access in route handlers.                                                                                                          |
| 3   | **API Contract**        | Standard envelope: `{ success: true, data: ... }` on success, `{ success: false, error: { code, message } }` on failure. New endpoints: `POST /remove`, `POST /bulk-apply`, `POST /bulk-remove`, `GET /stats`. All use Zod validation on request body. Existing `POST /apply` enhanced with dual-write.                                                                                                           |
| 4   | **Security Surface**    | Auth: `authMiddleware` + `requireProjectScope` + `requireProjectPermission`. Input: Zod schemas validate tag names (string, max 100 chars), conditions (operator enum), session IDs (string, min 1). No SQL injection risk -- ClickHouse uses parameterized queries. No sensitive data in tags. `PUT /rules/:ruleId` will be fixed to validate `$set` payload via Zod (currently passes raw `req.body` -- GAP-6). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **User errors** (400): Invalid tag name, empty conditions, duplicate tagName (409). **Auth errors**: 401 (missing), 403 (insufficient perms). **Not found** (404): Cross-tenant/project access, non-existent rule/session. **Server errors** (500): MongoDB/ClickHouse connectivity, caught with try/catch and logged. Bulk operations return partial results: `{ success: true, data: { applied: N, errors: [...] } }`.                    |
| 6   | **Failure Modes** | **ClickHouse down**: Apply/remove still writes to MongoDB Session.tags; ClickHouse write failure is logged and the operation returns success with a warning (eventual consistency). **MongoDB down**: All operations fail with 500 (MongoDB is the source of truth for rules and session state). **Auto-apply failure**: Caught and logged; does not block session lifecycle. No circuit breaker needed -- tag operations are non-critical. |
| 7   | **Idempotency**   | **Apply**: Uses MongoDB `$addToSet` (idempotent). ClickHouse `ReplacingMergeTree` deduplicates on `(tenant_id, project_id, session_id, tag_name)` by latest `applied_at`. **Remove**: MongoDB `$pull` is idempotent. ClickHouse removal is idempotent (DELETE WHERE). **Bulk**: Each session processed independently; partial failures do not affect other sessions.                                                                        |
| 8   | **Observability** | Logger: `createLogger('tag-service')` for all TagService operations. Log events: rule created/updated/deleted, tags applied/removed (with count), auto-apply evaluated (rules count, matches count, duration_ms), bulk operation completed (total, succeeded, failed). Error logging includes tenantId, projectId, and specific error message.                                                                                              |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Tag rule list**: < 100ms p99 (simple MongoDB find, < 100 docs). **Tag apply/remove**: < 200ms p99 (one MongoDB update + one ClickHouse insert). **Bulk operations**: < 2s p99 for 500 sessions (sequential with configurable batch size). **Stats query**: < 2s p99 (ClickHouse partitioned by tenant+month, ORDER BY includes session_id). **Auto-apply**: < 50ms (rule evaluation is O(n) with n < 100, pure in-memory). **Tag cap**: 50 tags per session enforced at TagService level before write.                                     |
| 10  | **Migration Path**     | **No schema migrations needed** -- all MongoDB models and ClickHouse tables exist. **Code migration**: (1) Extract TagService from route handlers, (2) add new endpoints, (3) fix existing `POST /apply` to dual-write, (4) fix `PUT /rules/:ruleId` to validate body, (5) add Studio proxy + UI. Each step is independently deployable.                                                                                                                                                                                                     |
| 11  | **Rollback Plan**      | All changes are additive (new endpoints, new service, new UI components). No existing API contracts change (except `POST /apply` gaining MongoDB write, which is backward-compatible). If auto-apply causes issues, disable via `tags.autoApply.enabled` runtime config flag. Studio UI can be removed by reverting the navigation addition without affecting the backend.                                                                                                                                                                   |
| 12  | **Test Strategy**      | **E2E (10 scenarios)**: Real HTTP against runtime on random port, covering CRUD lifecycle, apply/remove dual-write, cross-tenant 404, cross-project isolation, bulk ops, stats, validation, permissions, eval filtering. **Integration (7 scenarios)**: Condition evaluator, dual-write consistency, auto-apply engine, ClickHouse stats, lifecycle hooks, bulk partial failure, rule update non-retroactivity. **Unit (4 scenarios)**: Edge cases, normalization, Zod schemas, query builders. See `docs/testing/tags.md` for full details. |

---

## 5. Data Model

### Existing Collections (No Changes Needed)

#### `tag_rules` (MongoDB -- `packages/pipeline-engine/src/schemas/tag-rule.schema.ts`)

No schema changes. Existing fields: `tenantId`, `projectId`, `tagName`, `description`, `color`, `conditions[]`, `conditionLogic`, `autoApply`, `createdBy`, `createdAt`, `updatedAt`.

Indexes: `{ tenantId: 1, projectId: 1, tagName: 1 }` (unique), `{ tenantId: 1, projectId: 1, autoApply: 1 }`.

#### `sessions` (MongoDB -- `packages/database/src/models/session.model.ts`)

No schema changes. Existing field: `tags: string[]` (default: `[]`).

**New index recommended**: `{ tenantId: 1, projectId: 1, tags: 1 }` for tag-based session filtering. This is a multikey index that supports `{ tags: { $in: ['vip'] } }` queries efficiently.

#### `eval_scenarios` (MongoDB -- `packages/database/src/models/eval-scenario.model.ts`)

No schema changes. Existing field: `tags: string[]` (default: `[]`).

#### `abl_platform.conversation_tags` (ClickHouse)

No schema changes. Columns: `tenant_id`, `project_id`, `session_id`, `tag_name`, `applied_at`, `applied_by`, `rule_id`.

### Key Relationships

```
tag_rules (MongoDB)  ──defines rules for──►  sessions.tags (MongoDB)
                                                    │
                                                    │ mirrored in
                                                    ▼
                                         conversation_tags (ClickHouse)
                                                    │
                                                    │ aggregated by
                                                    ▼
                                         GET /stats endpoint

eval_scenarios.tags (MongoDB)  ──independent──  (no rule-based auto-apply)
```

---

## 6. API Design

### New Endpoints

| Method | Path                                        | Purpose                    | Auth          | Request Body                               |
| ------ | ------------------------------------------- | -------------------------- | ------------- | ------------------------------------------ |
| POST   | `/api/projects/:projectId/tags/remove`      | Remove tags from session   | session:write | `{ sessionId: string, tags: string[] }`    |
| POST   | `/api/projects/:projectId/tags/bulk-apply`  | Bulk apply tags            | session:write | `{ sessionIds: string[], tags: string[] }` |
| POST   | `/api/projects/:projectId/tags/bulk-remove` | Bulk remove tags           | session:write | `{ sessionIds: string[], tags: string[] }` |
| GET    | `/api/projects/:projectId/tags/stats`       | Tag distribution analytics | session:read  | Query: `?from=&to=&limit=` (optional)      |

### Modified Endpoints

| Endpoint                  | Change Description                                                                |
| ------------------------- | --------------------------------------------------------------------------------- |
| `POST /tags/apply`        | Add MongoDB `Session.updateOne($addToSet)` dual-write (currently ClickHouse-only) |
| `PUT /tags/rules/:ruleId` | Add Zod validation on request body (currently passes raw `req.body` to `$set`)    |

### Zod Validation Schemas

```typescript
// Tag rule create/update validation
const tagRuleBodySchema = z.object({
  tagName: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  conditions: z
    .array(
      z.object({
        field: z.string().min(1),
        operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'in']),
        value: z.unknown(),
      }),
    )
    .min(1),
  conditionLogic: z.enum(['AND', 'OR']).default('AND'),
  autoApply: z.boolean().default(false),
});

// Tag apply/remove validation
const tagApplySchema = z.object({
  sessionId: z.string().min(1),
  tags: z.array(z.string().min(1).max(100)).min(1).max(50),
});

// Bulk tag validation
const tagBulkSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(500),
  tags: z.array(z.string().min(1).max(100)).min(1).max(50),
});
```

### Error Responses

| Code | Error Code       | When                                                    |
| ---- | ---------------- | ------------------------------------------------------- |
| 400  | `INVALID_INPUT`  | Missing/invalid fields, empty conditions, bad operator  |
| 401  | `UNAUTHORIZED`   | Missing or invalid auth token                           |
| 403  | `FORBIDDEN`      | Insufficient permissions for the operation              |
| 404  | `NOT_FOUND`      | Rule/session not found (or cross-tenant/project access) |
| 409  | `DUPLICATE`      | Tag rule with same tagName already exists in project    |
| 500  | `INTERNAL_ERROR` | MongoDB/ClickHouse connectivity or unexpected error     |

### Stats Response Format

```json
{
  "success": true,
  "data": {
    "tags": [
      { "tag_name": "vip", "count": 42, "last_applied": "2026-03-23T10:00:00Z" },
      { "tag_name": "escalated", "count": 15, "last_applied": "2026-03-23T09:30:00Z" }
    ],
    "total_tagged_sessions": 57,
    "period": { "from": "2026-02-23T00:00:00Z", "to": "2026-03-23T23:59:59Z" }
  }
}
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Tag apply/remove operations log `tenantId`, `projectId`, `sessionId`, `tags`, `userId`, `source` (manual/rule/bulk). Rule CRUD logs `ruleId`, `tagName`, `userId`. Uses existing `createLogger('tag-service')` pattern, not audit-log model (tag operations are not compliance-sensitive).

- **Rate Limiting**: Uses existing `tenantRateLimit('request')` middleware (already applied to all tags routes). No additional tag-specific rate limits needed -- bulk operations are naturally bounded by batch size (max 500).

- **Caching**: No caching for tag operations. Tag rules are queried on each auto-apply evaluation (< 100 docs, indexed). If auto-apply frequency becomes high (> 100/sec per project), add a 30s in-memory TTL cache for auto-apply rules keyed by `{tenantId, projectId}` with max 1000 entries.

- **Encryption**: Tags are plain string labels -- no encryption at rest beyond MongoDB's existing disk encryption. ClickHouse conversation_tags uses the standard table encryption settings. No PII in tag names (this is enforced by documentation, not by code -- tags are categorization labels like 'vip', 'escalated', not user data).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                          | Type     | Risk |
| --------------------------------------------------- | -------- | ---- |
| MongoDB                                             | Database | LOW  |
| ClickHouse                                          | Database | LOW  |
| `@agent-platform/pipeline-engine` (TagRuleModel)    | Package  | LOW  |
| `@agent-platform/database` (Session model)          | Package  | LOW  |
| `@agent-platform/shared-auth` (requireProjectScope) | Package  | LOW  |
| Runtime auth middleware                             | Service  | LOW  |

### Downstream (depends on this feature)

| Consumer                     | Impact                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| Studio Tag Rules UI          | Direct consumer of proxy routes                                  |
| Studio Session Detail        | Uses TagChips component with apply/remove APIs                   |
| Studio Session List          | Uses TagFilter for session filtering                             |
| Studio Evals Page            | Uses tag filtering on eval scenarios                             |
| Observatory / Semantic Layer | Existing -- already includes conversation_tags in semantic layer |
| Project I/O (future)         | Will need tag rules export/import assembler                      |

---

## 9. Open Questions & Decisions Needed

| #   | Question                                                                      | Status   | Recommendation                                                                                                                                      |
| --- | ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should tag removal from ClickHouse use DELETE or INSERT a 'removed' record?   | DECIDED  | Use `ALTER TABLE DELETE` for simplicity. ClickHouse handles async mutation. Audit trail is preserved in logs.                                       |
| 2   | Should auto-apply run synchronously from session lifecycle or asynchronously? | DECIDED  | Synchronous via TagService method call. O(n) with n < 100 is < 10ms. Migrate to BullMQ only if latency becomes measurable.                          |
| 3   | Should the existing `POST /apply` be updated to dual-write or left as-is?     | DECIDED  | Update to dual-write. Session.tags should reflect reality. Backward-compatible -- callers don't depend on MongoDB not being written.                |
| 4   | Should tag colors be freeform hex or predefined palette?                      | DECIDED  | Freeform hex with regex validation (`/^#[0-9A-Fa-f]{6}$/`). UI can suggest a palette but not restrict.                                              |
| 5   | Should bulk operations cap at what batch size?                                | DECIDED  | 500 session IDs per request (Zod schema enforced). Larger batches should be split client-side.                                                      |
| 6   | Should the `tags` index be added to the sessions collection?                  | OPEN     | Recommended: `{ tenantId: 1, projectId: 1, tags: 1 }` multikey index. Needs assessment of index count on sessions collection (already 15+ indexes). |
| 7   | Should TagRuleModel be moved from pipeline-engine to database package?        | DEFERRED | GAP-5 identified but not blocking. Moving it is a separate refactoring task.                                                                        |

---

## 10. References

- Feature spec: `docs/features/tags.md`
- Test spec: `docs/testing/tags.md`
- Existing route: `apps/runtime/src/routes/tags.ts`
- TagRuleModel: `packages/pipeline-engine/src/schemas/tag-rule.schema.ts`
- Session model: `packages/database/src/models/session.model.ts`
- EvalScenario model: `packages/database/src/models/eval-scenario.model.ts`
- ClickHouse DDL: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`
- Semantic layer: `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts`
- Session repository: `apps/runtime/src/repos/session.repository.ts`
- Attachment settings HLD (pattern reference): `docs/specs/attachment-settings-ui.hld.md`
