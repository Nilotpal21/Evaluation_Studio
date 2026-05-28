# Feature: Tags & Eval Tags

**Status**: PLANNED
**Feature Area(s)**: `analytics`, `session management`, `eval framework`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/pipeline-engine`, `packages/database`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/tags.md](../testing/tags.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform has partial infrastructure for conversation tagging -- a `TagRuleModel` in pipeline-engine for defining tag rules, a `tags: string[]` field on the Session model, a `conversation_tags` ClickHouse table for analytics, and runtime API routes for CRUD operations on tag rules and manual tag application. However, critical pieces are missing:

1. **No Studio UI**: Project admins and operators have no visual interface to manage tag rules, apply tags to sessions, or filter sessions/eval scenarios by tags.
2. **No auto-apply engine**: Tag rules can be created with `autoApply: true`, but no background processor evaluates these rules against active or completed sessions.
3. **No tag removal**: The runtime API supports applying tags (`POST /apply`) but has no endpoint to remove tags from a session.
4. **No bulk operations**: Operators cannot apply or remove tags across multiple sessions at once.
5. **No tag analytics**: Beyond a basic `GET /conversations?tag=X` query, there are no aggregation or distribution endpoints.
6. **No eval scenario tag UI**: `EvalScenario.tags` exists as a `string[]` field but the Studio evals UI does not expose tag filtering or management.

### Goal Statement

Close all gaps in the tagging subsystem to deliver a complete tag management experience: Studio UI for tag rules CRUD, inline tag management on sessions, auto-apply engine for rule-based tagging, tag removal and bulk operations APIs, tag distribution analytics, and eval scenario tag filtering in the Studio evals UI.

### Summary

Tags are lightweight string labels applied to conversation sessions and eval scenarios for categorization, filtering, and analytics. Tag rules define conditions under which tags are automatically applied. This feature completes the existing backend infrastructure (MongoDB models, ClickHouse tables, runtime routes) by adding: a Studio tag management UI, an auto-apply evaluation engine, tag removal/bulk APIs, tag analytics endpoints, and eval scenario tag filtering.

---

## 2. Scope

### Goals

- **G1**: Studio UI for tag rule CRUD (create, read, update, delete tag rules per project)
- **G2**: Inline tag management on session detail view (apply/remove tags)
- **G3**: Session list filtering by tags in Studio
- **G4**: Auto-apply engine that evaluates tag rules against session events
- **G5**: Tag removal API endpoint (`DELETE` or `POST /remove`)
- **G6**: Bulk tag operations API (apply/remove tags across multiple sessions)
- **G7**: Tag distribution analytics endpoint (tag counts, trends)
- **G8**: Eval scenario tag filtering in Studio evals UI
- **G9**: Tag color support in UI (leveraging existing `color` field on TagRuleModel)

### Non-Goals (Out of Scope)

- **NG1**: ML-based auto-tagging (LLM-generated tags based on conversation content)
- **NG2**: Tag inheritance across tenant/project hierarchy (tags are project-scoped only)
- **NG3**: Tag-based routing or escalation in the runtime execution engine
- **NG4**: Tag permissions beyond existing project:write / session:write RBAC
- **NG5**: Tag versioning or audit trail (who changed a tag rule when)
- **NG6**: Cross-project tag search or tag taxonomy management
- **NG7**: DSL/IR integration for tag definitions (tags are a runtime/analytics concern, not a compile-time concern)

---

## 3. User Stories

1. As a **project admin**, I want to create tag rules with conditions (e.g., "if channel = voice AND status = escalated, apply tag 'voice-escalation'") so that conversations are automatically categorized.
2. As a **project admin**, I want to edit and delete tag rules from the Studio UI so that I can refine tagging criteria without making raw API calls.
3. As an **operator**, I want to manually apply tags to a conversation session from the session detail view so that I can categorize conversations that don't match any rule.
4. As an **operator**, I want to remove a tag from a conversation session so that I can correct mis-tagged conversations.
5. As an **operator**, I want to filter the session list by one or more tags so that I can quickly find conversations of a specific category.
6. As an **operator**, I want to see tag distribution analytics (how many conversations per tag, trends over time) so that I can monitor conversation categories.
7. As an **eval engineer**, I want to filter eval scenarios by tags so that I can run targeted eval sets on specific scenario categories (e.g., "hard", "voice-only", "regression").
8. As a **project admin**, I want tag rules to auto-apply when sessions match conditions so that I don't have to manually tag every conversation.
9. As an **operator**, I want to bulk-apply or bulk-remove a tag across selected sessions so that I can efficiently categorize batches of conversations.

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       | Priority |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-1  | The system shall provide CRUD APIs for tag rules scoped to `{tenantId, projectId}` with fields: tagName, description, color, conditions[], conditionLogic (AND/OR), autoApply.                    | P0       |
| FR-2  | The system shall enforce unique tag names per project (`{tenantId, projectId, tagName}` unique index already exists).                                                                             | P0       |
| FR-3  | The system shall provide an API to manually apply one or more tags to a session, recording the application in both the Session.tags array (MongoDB) and the conversation_tags table (ClickHouse). | P0       |
| FR-4  | The system shall provide an API to remove one or more tags from a session, removing from both Session.tags (MongoDB) and inserting a removal record in ClickHouse (or deleting the row).          | P0       |
| FR-5  | The system shall provide a tag distribution analytics endpoint returning tag counts and optional time-series data from ClickHouse.                                                                | P1       |
| FR-6  | The system shall provide a bulk tag apply/remove API accepting an array of session IDs and tag names.                                                                                             | P1       |
| FR-7  | The system shall evaluate auto-apply tag rules against session lifecycle events (session created, session ended, session status changed) and apply matching tags.                                 | P1       |
| FR-8  | The Studio shall display a tag rules management page under project settings with create/edit/delete capabilities.                                                                                 | P0       |
| FR-9  | The Studio session detail view shall display current tags and allow inline add/remove of tags.                                                                                                    | P0       |
| FR-10 | The Studio session list shall support filtering by one or more tags.                                                                                                                              | P0       |
| FR-11 | The Studio evals page shall support filtering eval scenarios by tags.                                                                                                                             | P1       |
| FR-12 | All tag operations shall enforce tenant and project isolation: every query must include `tenantId` and `projectId` in the filter. Cross-tenant access returns 404.                                | P0       |
| FR-13 | Tag rule conditions shall support operators: eq, neq, gt, lt, contains, in -- matching the existing schema.                                                                                       | P0       |
| FR-14 | Tag rule conditions shall evaluate against session fields: status, channel, disposition, outcome, currentAgent, environment, messageCount, tokenCount, errorCount, handoffCount, isTest.          | P1       |

---

## 5. Feature Classification & Integration Matrix

### Classification

| Dimension          | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| Type               | Enhancement (completing existing partial implementation)   |
| Scope              | Multi-package (runtime, studio, pipeline-engine, database) |
| User-facing        | Yes (Studio UI + API)                                      |
| Data model changes | None (all models exist)                                    |
| Breaking changes   | None                                                       |

### Integration Matrix

| Related Feature    | Integration Point                                                       |
| ------------------ | ----------------------------------------------------------------------- |
| Sessions           | Session.tags field, session list filtering, session detail view         |
| Evals              | EvalScenario.tags field, eval scenario filtering                        |
| Analytics Pipeline | conversation_tags ClickHouse table, semantic layer                      |
| Observatory        | Tag distribution analytics, natural language queries via semantic layer |
| Project I/O        | Export/import of tag rules (future -- not in scope)                     |
| Guardrails         | No direct integration                                                   |

---

## 6. How to Consume

### Studio UI

- **Tag Rules Page**: Project Settings > Tags -- CRUD for tag rules with condition builder
- **Session Detail**: Tags chip display with inline add/remove
- **Session List**: Tag filter chips in the filter bar
- **Evals Page**: Tag filter dropdown for eval scenario list

### API (Runtime)

All routes under `/api/projects/:projectId/tags` (already mounted):

| Method | Path             | Permission    | Description                      |
| ------ | ---------------- | ------------- | -------------------------------- |
| GET    | `/rules`         | session:read  | List tag rules                   |
| POST   | `/rules`         | project:write | Create tag rule                  |
| PUT    | `/rules/:ruleId` | project:write | Update tag rule                  |
| DELETE | `/rules/:ruleId` | project:write | Delete tag rule                  |
| POST   | `/apply`         | session:write | Apply tags to a session (exists) |
| POST   | `/remove`        | session:write | Remove tags from a session (new) |
| POST   | `/bulk-apply`    | session:write | Bulk apply tags (new)            |
| POST   | `/bulk-remove`   | session:write | Bulk remove tags (new)           |
| GET    | `/conversations` | session:read  | List sessions by tag (exists)    |
| GET    | `/stats`         | session:read  | Tag distribution analytics (new) |

### API (Studio Proxy)

Studio Next.js API routes proxy to runtime:

| Studio Route                     | Proxies To                                     |
| -------------------------------- | ---------------------------------------------- |
| `/api/projects/[id]/tags/rules`  | Runtime `/api/projects/:projectId/tags/rules`  |
| `/api/projects/[id]/tags/apply`  | Runtime `/api/projects/:projectId/tags/apply`  |
| `/api/projects/[id]/tags/remove` | Runtime `/api/projects/:projectId/tags/remove` |
| `/api/projects/[id]/tags/stats`  | Runtime `/api/projects/:projectId/tags/stats`  |

### Admin

No admin-specific tag routes. Tag rules are project-scoped, managed via Studio.

### Channels

No channel-specific integration. Tags are applied post-conversation via rules or manual action.

---

## 7. Data Model

### MongoDB Collections

#### `tag_rules` (existing -- `packages/pipeline-engine/src/schemas/tag-rule.schema.ts`)

| Field          | Type                            | Required | Description                    |
| -------------- | ------------------------------- | -------- | ------------------------------ |
| \_id           | ObjectId                        | auto     | Document ID                    |
| tenantId       | String                          | yes      | Tenant scope                   |
| projectId      | String                          | yes      | Project scope                  |
| tagName        | String                          | yes      | Tag label (unique per project) |
| description    | String                          | no       | Human-readable description     |
| color          | String                          | no       | Hex color for UI display       |
| conditions     | Array<{field, operator, value}> | yes      | Match conditions               |
| conditionLogic | 'AND' \| 'OR'                   | yes      | How conditions combine         |
| autoApply      | Boolean                         | yes      | Whether rule auto-applies      |
| createdBy      | String                          | yes      | User who created the rule      |
| createdAt      | Date                            | auto     | Timestamp                      |
| updatedAt      | Date                            | auto     | Timestamp                      |

**Indexes** (existing):

- `{ tenantId: 1, projectId: 1, tagName: 1 }` (unique)
- `{ tenantId: 1, projectId: 1, autoApply: 1 }`

#### `sessions` (existing -- `packages/database/src/models/session.model.ts`)

Relevant field:

- `tags: string[]` -- Array of tag names applied to the session

#### `eval_scenarios` (existing -- `packages/database/src/models/eval-scenario.model.ts`)

Relevant field:

- `tags: string[]` -- Array of tag names for categorization

### ClickHouse Tables

#### `abl_platform.conversation_tags` (existing -- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`)

| Column     | Type          | Description                              |
| ---------- | ------------- | ---------------------------------------- |
| tenant_id  | String        | Tenant identifier                        |
| project_id | String        | Project identifier                       |
| session_id | String        | Conversation session ID                  |
| tag_name   | String        | Name of the tag applied                  |
| applied_at | DateTime64(3) | When the tag was applied (default: now)  |
| applied_by | String        | User ID or 'system' for auto-applied     |
| rule_id    | String        | Rule ID or 'manual' for manually applied |

**Engine**: ReplacingMergeTree(applied_at)
**Partition**: (tenant_id, toYYYYMM(applied_at))
**Order**: (tenant_id, project_id, session_id, tag_name)
**TTL**: 730 days

---

## 8. Key Implementation Files

### Existing (Backend)

| File                                                                     | Description                           |
| ------------------------------------------------------------------------ | ------------------------------------- |
| `packages/pipeline-engine/src/schemas/tag-rule.schema.ts`                | TagRuleModel Mongoose schema          |
| `packages/database/src/models/session.model.ts`                          | Session model with tags field         |
| `packages/database/src/models/eval-scenario.model.ts`                    | EvalScenario model with tags field    |
| `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` | conversation_tags ClickHouse DDL      |
| `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts`       | Semantic layer with conversation_tags |
| `apps/runtime/src/routes/tags.ts`                                        | Runtime tags API routes               |
| `apps/runtime/src/server.ts`                                             | Tags router mounted at line 473       |

### Existing (Studio)

| File                                                             | Description                        |
| ---------------------------------------------------------------- | ---------------------------------- |
| `apps/studio/src/app/api/projects/[id]/evals/scenarios/route.ts` | Eval scenarios API with tags field |
| `apps/studio/src/repos/eval-repo.ts`                             | Eval data access layer             |
| `apps/studio/src/repos/session-repo.ts`                          | Session data access layer          |
| `packages/database/src/constants/eval-limits.ts`                 | EVAL_TAG_MAX_LENGTH = 100          |

### To Be Created

| File                                                         | Description                         |
| ------------------------------------------------------------ | ----------------------------------- |
| `apps/studio/src/app/api/projects/[id]/tags/rules/route.ts`  | Studio proxy for tag rules CRUD     |
| `apps/studio/src/app/api/projects/[id]/tags/apply/route.ts`  | Studio proxy for tag apply          |
| `apps/studio/src/app/api/projects/[id]/tags/remove/route.ts` | Studio proxy for tag remove         |
| `apps/studio/src/app/api/projects/[id]/tags/stats/route.ts`  | Studio proxy for tag stats          |
| `apps/studio/src/components/tags/TagRulesPage.tsx`           | Tag rules management UI             |
| `apps/studio/src/components/tags/TagRuleDialog.tsx`          | Create/edit tag rule dialog         |
| `apps/studio/src/components/tags/TagChips.tsx`               | Reusable tag display/edit component |
| `apps/studio/src/components/tags/TagFilter.tsx`              | Tag filter component for lists      |
| `apps/runtime/src/services/tag-auto-apply.ts`                | Auto-apply engine service           |

---

## 9. Configuration

### Environment Variables

None required. Tags use existing MongoDB and ClickHouse connections.

### Runtime Config

| Config                     | Default | Description                              |
| -------------------------- | ------- | ---------------------------------------- |
| `tags.maxPerSession`       | 50      | Maximum tags per session                 |
| `tags.maxRulesPerProject`  | 100     | Maximum tag rules per project            |
| `tags.autoApply.enabled`   | true    | Enable/disable auto-apply engine         |
| `tags.autoApply.batchSize` | 100     | Sessions per auto-apply evaluation batch |

### DSL / IR

No DSL or IR integration. Tags are a runtime/analytics concern.

---

## 10. Non-Functional Concerns

### Tenant Isolation

- Every tag rule query includes `tenantId` in the filter (existing: `Model.find({ tenantId, projectId })`)
- Every ClickHouse query includes `WHERE tenant_id = {tenantId:String}` (existing)
- Cross-tenant access returns 404 (existing: `findOneAndUpdate({ _id: ruleId, tenantId, projectId })`)
- Session.tags modifications verify `tenantId` ownership before update

### Project Isolation

- Tag rules are scoped to `{tenantId, projectId}` with a unique compound index
- Runtime routes use `requireProjectScope('projectId')` and `requireProjectPermission()` (existing)
- Studio proxy routes verify project access via `requireProjectAccess()`

### User Isolation

- `createdBy` field on TagRuleModel tracks rule ownership
- `applied_by` field in conversation_tags tracks who applied each tag
- Manual tag operations require `session:write` permission
- Rule management requires `project:write` permission

### Security

- Tag names are validated as strings (no code injection risk -- stored as plain strings)
- Tag rule conditions validate operator enum (`eq`, `neq`, `gt`, `lt`, `contains`, `in`)
- ClickHouse queries use parameterized queries (existing: `{tenantId:String}` syntax)
- No sensitive data in tags (tags are categorization labels, not PII)

### Performance

- Tag rule evaluation: O(n) where n = number of auto-apply rules per project (expected <100)
- ClickHouse tag queries: Partitioned by (tenant_id, month), ORDER BY includes session_id -- efficient for tag lookups
- Session.tags array: Capped at 50 entries -- negligible storage overhead
- Bulk operations: Batch size limited to prevent memory issues

### Reliability

- Tag application is dual-write (MongoDB Session.tags + ClickHouse conversation_tags) -- eventual consistency acceptable
- Auto-apply engine failures should not block session lifecycle -- fire-and-forget with error logging
- ClickHouse ReplacingMergeTree deduplicates on (tenant_id, project_id, session_id, tag_name)

### Observability

- Existing logger: `createLogger('tags-route')` in runtime routes
- Auto-apply engine should log: rules evaluated, tags applied, evaluation duration
- Tag operations should emit trace events for audit trail

### Data Lifecycle

- Tag rules: No TTL -- persist until manually deleted
- conversation_tags ClickHouse: 730-day TTL (existing)
- Session.tags: Follow session retention policy (existing TTL index on sessions)

---

## 11. Delivery Plan / Work Breakdown

### Phase 1: API Completion (P0)

1.1. Add `POST /remove` endpoint to runtime tags route
1.2. Sync tag removal to both MongoDB `Session.tags` and ClickHouse `conversation_tags`
1.3. Add `POST /bulk-apply` endpoint with array of session IDs
1.4. Add `POST /bulk-remove` endpoint with array of session IDs
1.5. Add `GET /stats` endpoint returning tag distribution from ClickHouse
1.6. Add Zod validation schemas for all new endpoints
1.7. Sync `POST /apply` to also update MongoDB `Session.tags` array (currently only writes to ClickHouse)

### Phase 2: Studio API Proxy (P0)

2.1. Create Studio proxy route for tag rules CRUD
2.2. Create Studio proxy route for tag apply/remove
2.3. Create Studio proxy route for tag stats
2.4. Add auth + project access checks to all proxy routes

### Phase 3: Studio Tag Rules UI (P0)

3.1. Create TagRulesPage component with list view
3.2. Create TagRuleDialog for create/edit with condition builder
3.3. Wire into project settings navigation
3.4. Add i18n keys for all labels

### Phase 4: Studio Session Tags UI (P0)

4.1. Create TagChips component for displaying/editing tags
4.2. Integrate TagChips into session detail view
4.3. Create TagFilter component for session list filtering
4.4. Integrate TagFilter into session list filter bar

### Phase 5: Auto-Apply Engine (P1)

5.1. Create tag-auto-apply service with rule evaluation logic
5.2. Hook into session lifecycle events (status change, session end)
5.3. Implement condition evaluator for all supported operators
5.4. Add batch processing for backfill of existing sessions

### Phase 6: Eval Tags UI (P1)

6.1. Add tag filter to eval scenarios list in Studio
6.2. Add tag editor to eval scenario create/edit dialog
6.3. Ensure EvalScenario CRUD routes handle tags field

### Phase 7: Analytics & Polish (P2)

7.1. Tag distribution dashboard component
7.2. Tag trend over time chart
7.3. Tag-based session grouping in analytics views

---

## 12. Success Metrics

| Metric                               | Target                                     | Measurement                    |
| ------------------------------------ | ------------------------------------------ | ------------------------------ |
| Tag rules per project                | >5 average within 30 days of launch        | MongoDB query                  |
| Manually tagged sessions             | >10% of active sessions tagged             | ClickHouse query               |
| Auto-apply coverage                  | >50% of tags applied via rules (vs manual) | ClickHouse applied_by analysis |
| Tag filter usage                     | >20% of session list views use tag filter  | Studio analytics               |
| API latency (tag operations)         | p99 < 500ms                                | Runtime metrics                |
| ClickHouse query latency (tag stats) | p99 < 2s                                   | ClickHouse query_log           |

---

## 13. Open Questions

| #    | Question                                                                                                                                               | Status | Notes                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| OQ-1 | Should the auto-apply engine run synchronously during session lifecycle events or asynchronously via BullMQ?                                           | OPEN   | Sync is simpler but blocks session response; async adds latency but is non-blocking     |
| OQ-2 | Should tag removal from ClickHouse be a hard delete or a soft delete (insert a 'removed' record)?                                                      | OPEN   | Hard delete is cleaner; soft delete preserves audit trail                               |
| OQ-3 | Should the `POST /apply` endpoint (existing) be updated to also write to MongoDB `Session.tags`, or should the dual-write only apply to new endpoints? | OPEN   | Currently only writes to ClickHouse -- Session.tags field is never populated by the API |
| OQ-4 | Should tag colors be freeform hex strings or a predefined palette?                                                                                     | OPEN   | Freeform is flexible; palette ensures visual consistency                                |
| OQ-5 | Should bulk operations have a max batch size, and if so, what?                                                                                         | OPEN   | Suggested: 500 sessions per bulk operation                                              |

---

## 14. Gaps, Known Issues & Limitations

| #     | Description                                                                      | Severity | Workaround                                           |
| ----- | -------------------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| GAP-1 | `POST /apply` only writes to ClickHouse, does not update Session.tags in MongoDB | HIGH     | Query ClickHouse directly for tag data               |
| GAP-2 | No tag removal endpoint exists                                                   | HIGH     | Direct ClickHouse deletion (requires admin access)   |
| GAP-3 | Auto-apply rules can be created but are never evaluated                          | MEDIUM   | Manually apply tags that match rule criteria         |
| GAP-4 | No Studio UI for tag management                                                  | HIGH     | Use runtime API directly                             |
| GAP-5 | TagRuleModel is in pipeline-engine package, not database package                 | LOW      | Works but breaks package responsibility pattern      |
| GAP-6 | PUT /rules/:ruleId passes `req.body` directly to `$set` without validation       | MEDIUM   | Could allow injection of arbitrary fields            |
| GAP-7 | No tag count limit per session                                                   | LOW      | Unbounded Session.tags array could grow indefinitely |

---

## 15. Testing & Validation

See [docs/testing/tags.md](../testing/tags.md) for the full test spec.

### Summary

- **E2E Tests**: Real HTTP API calls through runtime with auth, testing CRUD, apply/remove, bulk ops, filtering, and tenant/project isolation
- **Integration Tests**: Tag rule evaluation engine with real MongoDB, ClickHouse dual-write consistency, session lifecycle hooks
- **Unit Tests**: Condition evaluator logic, Zod validation schemas, tag name normalization

### Key Test Scenarios

1. Create tag rule, verify unique constraint on `{tenantId, projectId, tagName}`
2. Apply tag via API, verify both MongoDB `Session.tags` and ClickHouse `conversation_tags` are updated
3. Remove tag via API, verify removal from both stores
4. Cross-tenant tag rule access returns 404 (not 403)
5. Auto-apply engine evaluates rules on session status change and applies matching tags
6. Bulk apply/remove across multiple sessions
7. Tag distribution stats endpoint returns correct counts from ClickHouse
8. Studio UI proxy routes forward correctly with auth
