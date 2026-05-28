# Tags & Evaluation Tags -- Low-Level Design

**Status**: STABLE
**Feature Spec**: [../features/tags.md](../features/tags.md)
**HLD**: [../specs/tags.hld.md](../specs/tags.hld.md)
**Testing Guide**: [../testing/tags.md](../testing/tags.md)
**Last Updated**: 2026-03-22

---

## Task T-1: TagRule Mongoose Schema

### Files

- `packages/pipeline-engine/src/schemas/tag-rule.schema.ts` -- 71 lines

### Interface: `ITagRule`

```typescript
interface ITagRule extends Document {
  tenantId: string;
  projectId: string;
  tagName: string;
  description?: string;
  color?: string;
  conditions: Array<{
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'in';
    value: unknown;
  }>;
  conditionLogic: 'AND' | 'OR';
  autoApply: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Indexes

- `{ tenantId: 1, projectId: 1, tagName: 1 }` -- unique (prevents duplicate tag names per project)
- `{ tenantId: 1, projectId: 1, autoApply: 1 }` -- for future auto-apply queries

### Export

- Exported via `packages/pipeline-engine/src/index.ts` as `TagRuleModel` and `ITagRule`

---

## Task T-2: ClickHouse DDL

### Files

- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` -- conversation_tags DDL

### Table: `abl_platform.conversation_tags`

- Columns: `tenant_id`, `project_id`, `session_id`, `tag_name`, `applied_at` (DateTime64(3) DEFAULT now64(3)), `applied_by`, `rule_id`
- Engine: ReplacingMergeTree(applied_at)
- Partition: (tenant_id, toYYYYMM(applied_at))
- Order: (tenant_id, project_id, session_id, tag_name)
- TTL: 730 days

---

## Task T-3: Tags Route

### Files

- `apps/runtime/src/routes/tags.ts` -- 389 lines, 6 endpoints

### Endpoints

**GET /rules** -- List tag rules

- Permission: `session:read`
- Query: `TagRuleModel.find({ tenantId, projectId }).lean()`
- Returns: `{ success: true, data: rules[] }`

**POST /rules** -- Create a tag rule

- Permission: `project:write`
- Validation: `tagName` (string required), `conditions` (non-empty array required)
- Defaults: `conditionLogic: 'AND'`, `autoApply: false`
- Records `createdBy` from `req.tenantContext.userId`
- Returns: `{ success: true, data: rule }`

**PUT /rules/:ruleId** -- Update a tag rule

- Permission: `project:write`
- Query: `TagRuleModel.findOneAndUpdate({ _id: ruleId, tenantId, projectId }, { $set: req.body })`
- Returns 404 if not found (correct isolation pattern)
- Note: Accepts arbitrary `$set` from body -- no field-level validation

**DELETE /rules/:ruleId** -- Delete a tag rule

- Permission: `project:write`
- Query: `TagRuleModel.findOneAndDelete({ _id: ruleId, tenantId, projectId })`
- Returns 404 if not found

**POST /apply** -- Apply tags to a session

- Permission: `session:write`
- Validation: `sessionId` (string required), `tags` (non-empty string array required)
- Inserts rows into `abl_platform.conversation_tags` via ClickHouse JSONEachRow
- Each row: `{ tenant_id, project_id, session_id, tag_name, applied_by: userId, rule_id: 'manual' }`
- Returns: `{ success: true, data: { applied: count } }`

**GET /conversations** -- List sessions by tag

- Permission: `session:read`
- Query params: `tag` (required), `limit` (default 50, max 200)
- Parameterized ClickHouse query with `{tenantId:String}`, `{projectId:String}`, `{tag:String}`, `{limit:UInt32}`
- Returns: `{ success: true, data: sessions[] }`

---

## Task T-4: EvaluationTagConfig Model

### Files

- `apps/runtime/src/models/EvaluationTagConfig.ts` -- 35 lines

### Interface: `IEvaluationTagConfig`

```typescript
interface IEvaluationTagConfig extends Document {
  tenantId: string;
  projectId: string;
  tag: string;
  direction: 'higher_is_better' | 'lower_is_better';
  threshold: number;
  displayName?: string;
  description?: string;
}
```

### Indexes

- `{ tenantId: 1, projectId: 1, tag: 1 }` -- unique

---

## Task T-5: Evaluation Tags Route

### Files

- `apps/runtime/src/routes/evaluation-tags.ts` -- 162 lines, 2 endpoints

### Endpoints

**GET /** -- List evaluation tag configs

- Permission: `session:read`
- Query: `EvaluationTagConfig.find({ tenantId, projectId }).lean()`
- Returns: `{ success: true, data: configs[] }`

**PUT /:tag** -- Upsert evaluation tag config

- Permission: `project:write`
- Validation: `direction` must be `'higher_is_better'` or `'lower_is_better'`, `threshold` must be a number
- Upsert: `EvaluationTagConfig.findOneAndUpdate({ tenantId, projectId, tag }, { $set, $setOnInsert }, { upsert: true })`
- Returns: `{ success: true, data: config }`

---

## Task T-6: Server Wiring

### Files

- `apps/runtime/src/server.ts` -- imports at lines 101, 105; mounts at lines 521, 525

### Mount Points

```typescript
app.use('/api/projects/:projectId/evaluation-tags', evaluationTagsRouter);
app.use('/api/projects/:projectId/tags', tagsRouter);
```

---

## Task T-7: Semantic Layer Metadata

### Files

- `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts` -- conversation_tags table metadata for NL analytics

### Registered Metadata

Table `abl_platform.conversation_tags` with columns and common queries for tag distribution analytics.

---

## Known Gaps

| ID      | Description                                                                      | Severity |
| ------- | -------------------------------------------------------------------------------- | -------- |
| GAP-001 | No test files for tags or evaluation-tags routes                                 | Critical |
| GAP-002 | autoApply flag stored but no runtime engine evaluates conditions                 | Medium   |
| GAP-003 | PUT /rules/:ruleId accepts arbitrary $set from req.body without field validation | Medium   |
| GAP-004 | No DELETE endpoint for evaluation tag configs                                    | Low      |
| GAP-005 | EvaluationTagConfig model in apps/runtime, not packages/pipeline-engine          | Low      |

---

## Dependencies

- `@agent-platform/pipeline-engine` -- TagRuleModel export
- `@agent-platform/database/clickhouse` -- ClickHouse client for applied tags
- `@agent-platform/openapi/express` -- OpenAPI router creation
- `@agent-platform/shared-auth` -- `requireProjectScope`
- `@abl/compiler/platform` -- `createLogger`

---

## Exit Criteria

- Tag rule CRUD operations work with correct tenant/project isolation
- Manual tag application inserts rows into ClickHouse with correct user attribution
- Session-by-tag queries return correctly filtered results with configurable limit
- Evaluation tag upsert creates or updates config with validation
- All 404 responses returned for cross-tenant/cross-project access attempts
- Unique indexes prevent duplicate tagName per project and duplicate tag per project
