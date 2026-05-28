# Alerts -- Low-Level Design

## Implementation Structure

### apps/runtime/src/routes/alerts.ts -- 512 lines

Mounted at `/api/projects/:projectId/alerts`.

**Middleware chain**: `authMiddleware` -> `requireProjectScope('projectId')` -> `tenantRateLimit('request')`

**Lazy imports**: `AlertRuleModel` from `@agent-platform/pipeline-engine`, `getClickHouseClient` from `@agent-platform/database/clickhouse`

**Aggregation helpers**:

- `AGGREGATION_FN` map: avg, sum, count, min, max, p95 (`quantile(0.95)`), p99 (`quantile(0.99)`)
- `CONDITION_OP` map: gt (>), lt (<), gte (>=), lte (<=)

**GET /** -- List alert rules

- Permission: `session:read`
- Query: `AlertRuleModel.find({ tenantId, projectId }).lean()`
- Returns: `{ success: true, data: rules[] }`

**POST /** -- Create alert rule

- Permission: `project:write`
- Validation: hand-written checks for name (string), metric (string), sourceTable (string), aggregation (one of 7), windowMinutes (>= 1), condition (one of 4), threshold (number), channels (non-empty array)
- Creates: `AlertRuleModel.create({ tenantId, projectId, ...body, enabled: true, cooldownMinutes: 60, createdBy: userId })`
- Returns: `{ success: true, data: rule }`

**PUT /:alertId** -- Update alert rule

- Permission: `project:write`
- Update: `AlertRuleModel.findOneAndUpdate({ _id: alertId, tenantId, projectId }, { $set: req.body }, { new: true })`
- 404 if not found (tenant+project scoped)

**DELETE /:alertId** -- Delete alert rule

- Permission: `project:write`
- Delete: `AlertRuleModel.findOneAndDelete({ _id: alertId, tenantId, projectId })`
- 404 if not found

**GET /:alertId/history** -- Get alert fire history

- Permission: `session:read`
- Query: `AlertRuleModel.findOne({ _id: alertId, tenantId, projectId }).lean()`
- Returns: alertId, name, status, lastEvaluatedAt, lastFiredAt, enabled
- Note: No separate history collection; returns rule's current state only

**POST /:alertId/test** -- Test-fire an alert

- Permission: `project:write`
- Loads rule from MongoDB, validates aggregation function
- Builds ClickHouse query: `SELECT ${aggFn}(${rule.metric}) AS metric_value FROM ${rule.sourceTable} WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} AND event_time >= now() - INTERVAL {windowMinutes:UInt32} MINUTE`
- Evaluates condition against threshold
- Returns: `{ currentValue, threshold, condition, wouldFire }`
- **GAP**: `rule.metric` and `rule.sourceTable` are string-interpolated into SQL (injection risk)

### apps/runtime/src/routes/alert-config.ts -- 371 lines

Mounted at `/api/tenants/:tenantId/alerts`.

**Middleware chain**: `authMiddleware` -> `tenantRateLimit('request')`

**Constants**:

- `VALID_TYPES`: usage_threshold, credit_low, health_degraded, feature_limit
- `VALID_CHANNELS`: webhook, email

**Helpers**:

- `getTenantId(req)`: extracts tenantId from `req.tenantContext`, validates against `req.params.tenantId` (returns null on mismatch)
- `getUserId(req)`: extracts userId from `req.user`

**GET /** -- List alert configs

- Permission: `credential:read`
- Query: `AlertConfig.find({ tenantId }).lean()`
- Returns: `{ success: true, configs }`

**POST /** -- Create alert config

- Permission: `credential:manage`
- Validation: type (one of 4), threshold (0-100), channel (one of 2), target (non-empty string)
- SSRF check: `assertAllowedCallbackUrl(target, isProduction)` for webhook channel
- Creates: `AlertConfig.create({ tenantId, type, threshold, channel, target, enabled, cooldownMinutes })`
- Audit: `writeAuditLog({ action: 'alert_config.created', ... })`

**PATCH /:id** -- Update alert config

- Permission: `credential:manage`
- Validation: picks allowed fields (type, threshold, channel, target, enabled, cooldownMinutes), validates each individually
- SSRF check: validates webhook URLs on target update
- Update: `AlertConfig.findOneAndUpdate({ _id: id, tenantId }, { $set: updates }, { new: true })`
- Audit: `writeAuditLog({ action: 'alert_config.updated', ... })`
- 404 if not found (tenant-scoped)

**DELETE /:id** -- Delete alert config

- Permission: `credential:manage`
- Delete: `AlertConfig.findOneAndDelete({ _id: id, tenantId })`
- Audit: `writeAuditLog({ action: 'alert_config.deleted', ... })`
- 404 if not found

### packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts -- 282 lines

**Restate service**: `AlertEvaluator` with single `execute` handler.

**Input**: `{ stepContext, config: { tenantId, projectId } }`

**Flow**:

1. Load enabled rules: `AlertRuleModel.find({ tenantId, projectId, enabled: true })` via `ctx.run`
2. For each rule:
   - Query ClickHouse: `SELECT ${aggExpr} as value FROM ${sourceTable} WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} AND session_started_at >= now() - INTERVAL ${windowMinutes} MINUTE`
   - Update `lastEvaluatedAt` in MongoDB via `ctx.run`
   - If null metric: count as ok, skip
   - Evaluate condition: `evaluateCondition(value, condition, threshold)`
   - If breached + in cooldown: update status to `cooldown`, skip
   - If breached + not in cooldown: update status to `firing`, set `lastFiredAt`, push to alerts array
   - If not breached: update status to `ok`
3. Return: `{ alerts: AlertInfo[], summary: { totalRules, fired, ok, cooldown } }`

**Helper functions**:

- `evaluateCondition(value, condition, threshold)`: switch on gt/lt/gte/lte, returns boolean
- `buildAggregationExpr(aggregation, metric)`: handles p95/p99 as quantile(), others as `fn(metric)`
- `isInCooldown(lastFiredAt, cooldownMinutes)`: Date arithmetic check

### packages/pipeline-engine/src/schemas/alert-rule.schema.ts -- 92 lines

Mongoose schema for project-scoped alert rules.

**Fields**: tenantId, projectId, name, enabled, metric, sourceTable, aggregation (enum 7), windowMinutes (min 1), condition (enum 4), threshold, cooldownMinutes (default 60), channels (array of `{ type: slack|email|webhook, config: Mixed }`), lastEvaluatedAt, lastFiredAt, status (ok|firing|cooldown), createdBy

**Indexes**:

- `{ tenantId: 1, projectId: 1, enabled: 1 }`
- `{ tenantId: 1, projectId: 1, name: 1 }` (unique)

### packages/database/src/models/alert-config.model.ts -- 67 lines

Mongoose schema for tenant-scoped alert configs.

**Fields**: \_id (UUIDv7), tenantId, type (enum 4), threshold, channel (enum 2), target, enabled, cooldownMinutes (default 60), lastTriggeredAt, timestamps

**Plugins**: `tenantIsolationPlugin`

**Indexes**: `{ tenantId: 1, type: 1 }`

### packages/eventstore/src/alerting/ -- Generic Engine

**interfaces.ts** -- 220 lines

- `AlertRule`: id, tenantId, projectId, name, enabled, metric, operator (6 types including eq, neq), threshold, window (value + unit), severity (info|warning|critical), cooldownSeconds, channels (webhook only), agentName, eventTypes
- `AlertState`: ok | firing | resolved | acknowledged
- Provider interfaces: `IAlertRuleStore`, `ICooldownStore`, `IMetricsReader`, `IAlertNotifier`, `IAlertScheduler`

**alert-scheduler.ts** -- 179 lines

- Configurable poll interval
- On tick: getAllActiveRules -> for each: check cooldown -> queryMetric -> checkThreshold -> resolveAlertState -> notify if state changed
- Emits events for audit trail

**threshold-evaluator.ts** -- 112 lines

- `checkThreshold(value, operator, threshold)`: 6 operators (gt, gte, lt, lte, eq, neq)
- `resolveAlertState(breached, previousState)`: ok -> firing, firing -> firing/resolved
- `shouldNotify(state, previousState)`: true on transition to firing or resolved
- `windowToMs(window)`: converts AlertWindow to milliseconds

**alert-notifier.ts** -- 116 lines

- Injected `WebhookDeliveryFn`
- `buildNotificationPayload(rule, evaluation)`: structured webhook body
- Iterates `rule.channels`, delivers to each, returns `{ sent, failed }`

### Studio UI

**AlertsPage.tsx** -- 53 lines

- Tabs: 'approvals' (InboxPage) and 'alerts' (EmptyState placeholder)
- Uses `useTranslations('alerts')` for i18n

**useAlerts.ts** -- 148 lines

- SWR hook: fetches from `/api/admin/alerts?tenantId=...`
- Methods: `createAlert(input)`, `updateAlert(id, updates)`, `deleteAlert(id)`
- Refresh interval: 60s

**Studio proxy routes**:

- `GET/POST /api/admin/alerts`: requires admin role, proxies to runtime
- `PATCH/DELETE /api/admin/alerts/:id`: requires auth (no admin role check on PATCH/DELETE -- GAP-006)

### Key Files

| File                                                                        | LOC | Purpose                                    |
| --------------------------------------------------------------------------- | --- | ------------------------------------------ |
| `apps/runtime/src/routes/alerts.ts`                                         | 512 | Project-scoped alert rule CRUD + test-fire |
| `apps/runtime/src/routes/alert-config.ts`                                   | 371 | Tenant-scoped alert config CRUD + SSRF     |
| `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts` | 282 | Restate alert evaluator                    |
| `packages/pipeline-engine/src/schemas/alert-rule.schema.ts`                 | 92  | AlertRule Mongoose model                   |
| `packages/database/src/models/alert-config.model.ts`                        | 67  | AlertConfig Mongoose model                 |
| `packages/eventstore/src/alerting/interfaces.ts`                            | 220 | Generic alerting interfaces                |
| `packages/eventstore/src/alerting/alert-scheduler.ts`                       | 179 | Generic poll-based scheduler               |
| `packages/eventstore/src/alerting/threshold-evaluator.ts`                   | 112 | Pure threshold evaluation                  |
| `packages/eventstore/src/alerting/alert-notifier.ts`                        | 116 | Webhook notification delivery              |
| `apps/studio/src/components/alerts/AlertsPage.tsx`                          | 53  | Tab UI component                           |
| `apps/studio/src/hooks/useAlerts.ts`                                        | 148 | SWR CRUD hook                              |

### Known Gaps

| ID    | Description                                                                                                                                                | Severity |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| GAP-1 | SQL injection risk: `rule.metric` and `rule.sourceTable` interpolated into ClickHouse queries in both alerts.ts (test-fire) and alert-evaluator.service.ts | High     |
| GAP-2 | Studio AlertsPage shows EmptyState for alert rules tab -- no CRUD UI                                                                                       | High     |
| GAP-3 | No E2E tests for any alert endpoint (project-scoped or tenant-scoped)                                                                                      | High     |
| GAP-4 | Studio proxy PATCH/DELETE uses `requireAuth` not `requireAdminRole` (inconsistent with GET/POST)                                                           | Medium   |
| GAP-5 | No email delivery implementation for tenant-scoped configs                                                                                                 | Medium   |
| GAP-6 | Hand-written validation in POST /alerts instead of Zod middleware                                                                                          | Low      |
| GAP-7 | Two overlapping alerting systems (alerts.ts + eventstore AlertScheduler) with different interfaces and models                                              | Medium   |
| GAP-8 | Alert fire history endpoint returns only current rule state, not historical fire events                                                                    | Medium   |
| GAP-9 | No cross-tenant isolation tests                                                                                                                            | High     |
