# High-Level Design: Alerts

**Feature:** alerts
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Overview

The Alerts subsystem provides threshold-based monitoring and notification for analytics metrics collected by the ABL platform. It enables platform operators to define rules that trigger notifications when metrics (error rates, latency, sentiment scores, session volumes) breach configurable thresholds. The system supports multiple notification channels (webhook with HMAC signing, email placeholder), cooldown periods to prevent notification storms, and a state machine for alert lifecycle management.

### Architecture Diagram

```
                         ┌─────────────────────────────────────────┐
                         │             Studio (future)             │
                         │         Alert Management UI             │
                         └──────────────┬──────────────────────────┘
                                        │ HTTP API
                         ┌──────────────▼──────────────────────────┐
                         │           Runtime (Express)             │
                         │  ┌──────────────┐  ┌─────────────────┐  │
                         │  │  alerts.ts   │  │ alert-config.ts │  │
                         │  │ (project)    │  │ (tenant)        │  │
                         │  └──────┬───────┘  └────────┬────────┘  │
                         │         │                   │           │
                         │  ┌──────▼───────────────────▼────────┐  │
                         │  │     alert-delivery.ts             │  │
                         │  │  (webhook + email delivery)       │  │
                         │  └──────────────┬────────────────────┘  │
                         └─────────────────┼───────────────────────┘
                                           │
              ┌────────────────────────────┼────────────────────────────┐
              │                            │                            │
   ┌──────────▼──────────┐    ┌───────────▼──────────┐    ┌───────────▼──────────┐
   │     EventStore      │    │   Pipeline Engine     │    │     MongoDB          │
   │  ┌────────────────┐ │    │  ┌────────────────┐   │    │  ┌────────────────┐  │
   │  │ AlertScheduler │ │    │  │AlertEvaluator  │   │    │  │ AlertRuleModel │  │
   │  │ ThresholdEval  │ │    │  │(Restate svc)   │   │    │  │ AlertConfig    │  │
   │  │ AlertNotifier  │ │    │  └───────┬────────┘   │    │  └────────────────┘  │
   │  │ Interfaces     │ │    │          │            │    │                      │
   │  └────────────────┘ │    └──────────┼────────────┘    └──────────────────────┘
   └─────────────────────┘               │
                                         │
                              ┌──────────▼──────────┐
                              │     ClickHouse      │
                              │  Metric Aggregates  │
                              └─────────────────────┘
```

## 2. Tenant Isolation

### Query-Level Isolation

All database queries include `tenantId` as a filter condition:

- **MongoDB queries:** `AlertRuleModel.find({ tenantId, projectId })`, `AlertConfig.find({ tenantId })`
- **ClickHouse queries:** `WHERE tenant_id = {tenantId:String}` (parameterized)
- **Update/Delete:** `findOneAndUpdate({ _id, tenantId })`, `findOneAndDelete({ _id, tenantId })`

### Cross-Tenant Access

- Cross-tenant access returns **404** (not 403) to avoid leaking resource existence
- Tenant ID is extracted from the authenticated context (`req.tenantContext.tenantId`), not from URL parameters alone
- URL parameter `tenantId` is validated against the auth context to prevent parameter tampering

### Project Isolation

Project-scoped routes (`/api/projects/:projectId/alerts`) use `requireProjectPermission` and include `projectId` in all queries. The update route uses `findOneAndUpdate({ _id: alertId, tenantId, projectId })` to enforce both tenant and project isolation.

### Isolation Gap: PUT Endpoint

The PUT `/:alertId` endpoint passes `req.body` directly to `$set` without field filtering. This is a mass-assignment vulnerability -- an attacker could potentially overwrite `tenantId`, `projectId`, or `createdBy` fields. The PATCH endpoint on the tenant route correctly validates and picks allowed fields.

## 3. Authentication & Authorization

### Middleware Chain

```
authMiddleware → requireProjectScope → tenantRateLimit → requireProjectPermission
```

- **authMiddleware:** Validates JWT token, extracts user/tenant context
- **requireProjectScope:** Ensures the project belongs to the authenticated tenant
- **tenantRateLimit:** Rate limits requests per tenant
- **requireProjectPermission:** Checks role-based permission for the specific operation

### Permission Model

| Operation     | Required Permission | Notes                                                       |
| ------------- | ------------------- | ----------------------------------------------------------- |
| List rules    | session:read        | Read-only access sufficient                                 |
| Create rule   | project:write       | Mutation requires write                                     |
| Update rule   | project:write       | Mutation requires write                                     |
| Delete rule   | project:write       | Mutation requires write                                     |
| View history  | session:read        | Read-only access sufficient                                 |
| Test-fire     | project:write       | Queries ClickHouse, no side effects but classified as write |
| List configs  | credential:read     | Tenant-scoped                                               |
| Create config | credential:manage   | Tenant-scoped mutation                                      |
| Update config | credential:manage   | Tenant-scoped mutation                                      |
| Delete config | credential:manage   | Tenant-scoped mutation                                      |

## 4. Stateless / Distributed Design

### Alert Scheduler (EventStore)

The eventstore `AlertScheduler` uses a configurable poll interval with `setInterval`. In a multi-pod deployment, this creates a **duplicate evaluation problem** -- each pod would independently evaluate all rules and potentially send duplicate notifications.

**Current mitigation:** None. The scheduler uses in-memory state only.

**Required for production:**

- Distributed lock via Redis `SET NX PX` before each evaluation cycle
- Or: Single scheduler pod with leader election
- Or: Migrate to the pipeline-engine Restate service which provides durable execution guarantees

### State Storage

| State                            | Storage       | Production-Ready? |
| -------------------------------- | ------------- | ----------------- |
| Alert rules                      | MongoDB       | YES               |
| Alert configs                    | MongoDB       | YES               |
| Cooldown tracking                | In-memory Map | NO -- needs Redis |
| Alert state (ok/firing/resolved) | In-memory Map | NO -- needs Redis |
| Metric aggregates                | ClickHouse    | YES               |

### Cooldown Store

The `ICooldownStore` interface is designed for Redis but only has an in-memory implementation. For production:

- Implement `RedisCooldownStore` using `SET key value EX seconds` for TTL-based expiry
- Use Redis key format: `alert:cooldown:{ruleId}` and `alert:state:{ruleId}`

## 5. Traceability

### Event Emission

The scheduler emits structured events on state transitions:

```typescript
{
  event_type: 'alert.firing' | 'alert.resolved',
  tenant_id: string,
  project_id: string,
  timestamp: Date,
  data: {
    rule_id, rule_name, severity, metric,
    current_value, threshold, operator,
    state, previous_state
  }
}
```

### Audit Logging

- Alert config CRUD: `alert_config.created`, `alert_config.updated`, `alert_config.deleted`
- Alert delivery: `alert.delivered`, `alert.delivery_failed`
- Includes userId, tenantId, and relevant metadata

### Observability Gap

- No structured TraceEvent emission from the alert routes themselves (only from the scheduler/delivery service)
- No metrics exported (Prometheus/OpenTelemetry) for alert evaluation latency, fire rate, delivery success rate

## 6. Compliance

### Data Minimization

- Alert rules have no TTL -- rules persist until explicitly deleted
- Alert history is minimal (only `lastEvaluatedAt` and `lastFiredAt` timestamps on the rule document)
- No PII is stored in alert rules (metrics are aggregate values, not individual user data)

### Right to Erasure

- Deleting a tenant should cascade to delete all alert rules and configs for that tenant
- Currently no cascade mechanism exists -- requires explicit cleanup

### Encryption

- Webhook URLs and email targets are stored in plaintext in MongoDB
- Webhook secrets are stored in plaintext in the notification channel config
- **Recommendation:** Encrypt `target` and channel `secret` fields at rest using the platform's encryption service

## 7. Performance

### ClickHouse Query Efficiency

- Queries use parameterized `tenant_id` and `project_id` in WHERE clause, leveraging ClickHouse's primary key ordering
- Time window filtering uses `now() - INTERVAL N MINUTE` for partition pruning

### Concurrency Control

- Scheduler uses `maxConcurrency` (default 10) to limit parallel rule evaluations
- Rules are processed in chunks via `Promise.allSettled` to prevent single-rule failures from blocking others

### Batch vs. Sequential

- The pipeline-engine evaluator processes rules sequentially within a Restate context (deterministic, but slower)
- The eventstore scheduler processes rules in parallel chunks (faster, but requires distributed coordination)

### Performance Risk: N+1 ClickHouse Queries

Both evaluator implementations execute one ClickHouse query per rule. For a tenant with 100 rules, this means 100 sequential or parallel ClickHouse queries per evaluation cycle.

**Mitigation options:**

1. Group rules by sourceTable and execute batch queries
2. Use materialized views that pre-aggregate common metrics
3. Cache metric values with short TTL (30 seconds)

## 8. Security

### CRITICAL: SQL Injection

The `metric` and `sourceTable` fields from alert rules are interpolated directly into ClickHouse SQL:

```sql
SELECT avg(${rule.metric}) AS metric_value FROM ${rule.sourceTable} WHERE ...
```

These values are user-controlled (created via POST /alerts). The `tenant_id`, `project_id`, and `windowMinutes` are correctly parameterized using ClickHouse's `{name:Type}` syntax, but the identifiers are not.

**Attack scenario:** A user with project:write permission creates a rule with:

```json
{ "metric": "1) AS x FROM system.query_log; --", "sourceTable": "abl_platform.conversations" }
```

This would execute: `SELECT avg(1) AS x FROM system.query_log; --) AS metric_value FROM abl_platform.conversations WHERE ...`

**Required fix:**

1. Allowlist of permitted metric column names per sourceTable
2. Allowlist of permitted sourceTable names (from a registry of known analytics tables)
3. Strict regex validation: `/^[a-zA-Z_][a-zA-Z0-9_.]*$/` for both fields
4. Apply validation at both creation time (POST) and evaluation time (defense-in-depth)

### Mass Assignment (PUT Endpoint)

The PUT `/:alertId` route uses `$set: req.body` without field filtering, allowing an attacker to overwrite any field including `tenantId`, `projectId`, `createdBy`, `status`, `lastFiredAt`.

**Required fix:** Validate and pick only allowed update fields (name, metric, sourceTable, aggregation, windowMinutes, condition, threshold, channels, enabled, cooldownMinutes).

### SSRF Protection

Webhook URLs are validated via `assertAllowedCallbackUrl` at both:

1. Alert config creation (POST) and update (PATCH)
2. Alert delivery time (defense-in-depth)

This blocks private IPs, cloud metadata endpoints, and localhost.

### Webhook Signing

- HMAC-SHA256 signature in `X-Alert-Signature` header
- Signing secret from `ALERT_WEBHOOK_SIGNING_SECRET` environment variable
- Warning logged if secret is not set (webhooks sent unsigned)

## 9. Error Handling

### Route-Level

All route handlers follow the pattern:

```typescript
try {
  // ... business logic
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.error('Description', { error: message, context });
  res.status(500).json({ success: false, error: { code, message } });
}
```

### Scheduler-Level

- `evaluateRuleSafe` wraps each rule evaluation in try/catch to prevent cascade failures
- Failed rules are silently skipped (error counted but not propagated)
- `Promise.allSettled` for parallel notification delivery

### Error Envelope

All error responses follow the standard format: `{ success: false, error: { code: string, message: string } }`

Error codes used: `NOT_FOUND`, `VALIDATION_ERROR`, `INVALID_INPUT`, `INVALID_URL`, `INVALID_AGGREGATION`, `INTERNAL_ERROR`

## 10. Data Model

### MongoDB Collections

**`alert_rules`** (pipeline-engine AlertRuleModel):

- Indexes: `{ tenantId: 1, projectId: 1, enabled: 1 }`, `{ tenantId: 1, projectId: 1, name: 1 }` (unique)
- Timestamps: `createdAt`, `updatedAt` (Mongoose-managed)
- Status tracking: `status`, `lastEvaluatedAt`, `lastFiredAt`

**`alertconfigs`** (runtime AlertConfig -- naming assumed from Mongoose default):

- No explicit index definition in the code (should add `{ tenantId: 1 }`)
- Fields: tenantId, type, threshold, channel, target, enabled, cooldownMinutes

### ClickHouse Tables (referenced, not owned)

Alert rules reference existing analytics tables via `sourceTable` field. Common tables:

- `abl_platform.conversation_sentiment`
- `abl_platform.session_metrics`
- Other materialized views from the analytics pipeline

### Type System Gap

Two separate type systems exist:

1. **EventStore interfaces** (`AlertRule`, `AlertState`, `ThresholdOperator`) -- clean, well-defined, production-quality
2. **Pipeline-engine schema** (`IAlertRule`, `IAlertChannel`) -- Mongoose-oriented, different field names (windowMinutes vs window, condition vs operator, cooldownMinutes vs cooldownSeconds)

These should be consolidated to prevent drift.

## 11. Alternatives Considered

### Single vs. Dual Evaluation Engine

**Current:** Two parallel implementations (eventstore scheduler + pipeline-engine Restate service)

| Option                     | Pros                                             | Cons                                      |
| -------------------------- | ------------------------------------------------ | ----------------------------------------- |
| Keep both                  | Restate gives durability; eventstore gives speed | Type drift, maintenance burden, confusion |
| Consolidate to eventstore  | Clean interfaces, testable, fast                 | No durable execution guarantees           |
| Consolidate to Restate     | Durable, exactly-once evaluation                 | Harder to test, Restate dependency        |
| Hybrid: eventstore + Redis | Best of both: clean code + persistence           | Requires Redis cooldown store impl        |

**Recommendation:** Consolidate to eventstore engine with Redis-backed stores for production. The Restate evaluator can be a wrapper that delegates to eventstore logic.

### Polling vs. Event-Driven Evaluation

| Option    | Pros                                  | Cons                                     |
| --------- | ------------------------------------- | ---------------------------------------- |
| Polling   | Simple, predictable, debuggable       | Wastes resources when metrics are stable |
| CDC/Event | Reactive, low latency                 | Complex, requires metric change events   |
| Hybrid    | Poll with backoff when metrics stable | More complex scheduler logic             |

**Decision:** Polling is appropriate for the current scale. Revisit when evaluation volume exceeds 1000 rules/minute.

### Alert History Storage

| Option                      | Pros                               | Cons                                 |
| --------------------------- | ---------------------------------- | ------------------------------------ |
| MongoDB embedded            | Simple, same DB                    | Document growth, query performance   |
| MongoDB separate collection | Clean separation                   | Additional collection to manage      |
| ClickHouse                  | Native time-series, fast analytics | Different query patterns, complexity |

**Recommendation:** ClickHouse for alert history -- natural fit for time-series data and aligns with existing analytics infrastructure.

## 12. Cross-Cutting Concerns

### Internationalization

- Error messages are currently hardcoded in English
- Alert names and descriptions are user-provided (no i18n needed)
- System error codes (VALIDATION_ERROR, NOT_FOUND) are machine-readable

### Rate Limiting

- All alert routes use `tenantRateLimit('request')` for per-tenant rate limiting
- No per-rule or per-evaluation rate limiting exists
- No maximum rules-per-project limit enforced (risk: resource exhaustion via many rules)

### Logging

- All modules use `createLogger` from `@abl/compiler/platform`
- Log format: `log.error('message', { context })` (not pino-style)
- Key events logged: rule created/updated/deleted, alert fired, delivery success/failure

### Configuration

| Config                       | Source            | Default    |
| ---------------------------- | ----------------- | ---------- |
| ALERT_WEBHOOK_SIGNING_SECRET | Environment var   | null       |
| Scheduler poll interval      | Constructor param | 0 (manual) |
| Max concurrency              | Constructor param | 10         |
| Webhook timeout              | Constant          | 10,000ms   |
| Default cooldown             | Schema default    | 60 min     |
