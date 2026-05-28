# Feature Spec: Alerts

**Slug:** `alerts`
**Status:** ALPHA
**Author:** SDLC Pipeline
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## 1. Problem Statement

Platform operators need proactive notification when analytics metrics (error rates, latency, sentiment scores, session volumes) breach configurable thresholds. Without an alerting system, degraded agent behavior goes undetected until end-users report issues, increasing MTTR and damaging trust.

Currently the ABL platform collects rich analytics data in ClickHouse (via the pipeline-engine and eventstore packages), but there is no built-in mechanism to define threshold-based rules, evaluate them periodically, and deliver notifications through webhook or email channels.

## 2. Scope

### In Scope

- **Alert Rule CRUD** -- REST API for creating, reading, updating, and deleting alert rules scoped to tenant + project
- **Tenant-level Alert Config** -- Separate CRUD for tenant-wide alert configurations (usage thresholds, credit-low, health-degraded, feature-limit)
- **Threshold Evaluation Engine** -- Periodic evaluation of alert rules against ClickHouse metric aggregates
- **Notification Delivery** -- Webhook delivery with HMAC-SHA256 signing, email delivery (placeholder)
- **Cooldown Management** -- Prevention of notification storms via configurable cooldown periods
- **State Machine** -- Alert state transitions: ok -> firing -> resolved -> ok
- **Test-fire Endpoint** -- On-demand evaluation for a single rule to preview whether it would fire
- **Audit Trail** -- All alert config changes and deliveries logged via `writeAuditLog`

### Out of Scope

- Studio UI for alert management (no Studio components exist yet)
- Slack channel integration (schema supports it, but no delivery implementation)
- PagerDuty / OpsGenie integrations
- Alert rule templates or presets
- Alert history dashboard / timeline visualization
- Alert grouping / deduplication across rules
- Escalation policies (multi-tier notification chains)

## 3. User Stories

### US-1: Platform admin creates an alert rule

**As a** project admin,
**I want to** create an alert rule that monitors a specific metric,
**So that** I am notified when the metric breaches a threshold.

**Acceptance criteria:**

- POST `/api/projects/:projectId/alerts` creates a rule with name, metric, sourceTable, aggregation, windowMinutes, condition, threshold, channels
- Rule is persisted in MongoDB with tenant + project isolation
- Rule defaults to `enabled: true` and `status: ok`
- Duplicate rule names within the same tenant+project are rejected (unique index)

### US-2: Platform admin receives webhook notification

**As a** platform admin with a webhook-configured alert rule,
**I want to** receive a structured JSON payload at my webhook URL when the metric breaches,
**So that** I can integrate with my incident management workflow.

**Acceptance criteria:**

- Webhook payload includes rule_id, rule_name, severity, metric value, threshold, state, and timestamps
- Payload is signed with HMAC-SHA256 via the `X-Alert-Signature` header when `ALERT_WEBHOOK_SIGNING_SECRET` is set
- Delivery respects a 10-second timeout
- Failed deliveries are recorded in audit log

### US-3: Platform admin manages alert lifecycle

**As a** platform admin,
**I want to** enable, disable, update thresholds, and delete alert rules,
**So that** I can tune alerting to match changing operational needs.

**Acceptance criteria:**

- PUT `/api/projects/:projectId/alerts/:alertId` updates rule fields
- DELETE removes rule permanently
- PATCH on tenant-scoped `/api/tenants/:tenantId/alerts/:id` updates config
- All mutations are tenant-isolated and audit-logged

### US-4: Platform admin test-fires an alert

**As a** platform admin,
**I want to** test-fire an alert rule against live metric data,
**So that** I can verify my rule configuration before relying on it.

**Acceptance criteria:**

- POST `/api/projects/:projectId/alerts/:alertId/test` queries ClickHouse for the current metric value
- Response includes `currentValue`, `threshold`, `condition`, and `wouldFire` boolean
- No side effects (no state change, no notification delivery)

### US-5: Cooldown prevents notification storms

**As a** platform operator,
**I want** alert rules to respect cooldown periods,
**So that** I am not overwhelmed with repeated notifications for the same condition.

**Acceptance criteria:**

- After firing, a rule enters cooldown for the configured duration
- During cooldown, the rule is still evaluated but notifications are suppressed
- Cooldown clears automatically after the configured period
- Cooldown clears immediately on resolution (metric drops below threshold)

## 4. Requirements

### Functional Requirements

| ID    | Requirement                                                        | Priority |
| ----- | ------------------------------------------------------------------ | -------- |
| FR-1  | Alert rule CRUD with tenant + project isolation                    | P0       |
| FR-2  | Threshold evaluation against ClickHouse metric aggregates          | P0       |
| FR-3  | Webhook notification delivery with HMAC signing                    | P0       |
| FR-4  | Cooldown period enforcement                                        | P0       |
| FR-5  | Alert state machine (ok/firing/resolved/cooldown)                  | P0       |
| FR-6  | Test-fire endpoint for on-demand evaluation                        | P1       |
| FR-7  | Tenant-level alert config CRUD (usage_threshold, credit_low, etc.) | P1       |
| FR-8  | Alert fire history endpoint                                        | P1       |
| FR-9  | Email notification channel                                         | P2       |
| FR-10 | Slack notification channel                                         | P2       |

### Non-Functional Requirements

| ID    | Requirement                                       | Target            |
| ----- | ------------------------------------------------- | ----------------- |
| NFR-1 | Evaluation latency for a single rule              | < 500ms           |
| NFR-2 | Webhook delivery timeout                          | 10 seconds        |
| NFR-3 | Maximum concurrent rule evaluations per cycle     | 10 (configurable) |
| NFR-4 | Alert rule creation response time                 | < 200ms           |
| NFR-5 | Tenant isolation: cross-tenant access returns 404 | 100% enforcement  |
| NFR-6 | SSRF protection on webhook URLs                   | All create/update |

## 5. Architecture Overview

The alerts feature spans three packages:

### Runtime Layer (`apps/runtime/`)

- **`routes/alerts.ts`** -- Project-scoped alert rule CRUD + test-fire + history endpoints. Uses OpenAPI router pattern. Mounts at `/api/projects/:projectId/alerts`.
- **`routes/alert-config.ts`** -- Tenant-scoped alert config CRUD. Mounts at `/api/tenants/:tenantId/alerts`.
- **`services/alert-delivery.ts`** -- Evaluates tenant alert configs and delivers webhook/email notifications with HMAC signing and SSRF protection.

### EventStore Layer (`packages/eventstore/`)

- **`alerting/interfaces.ts`** -- Core type contracts: AlertRule, AlertState, ThresholdOperator, IAlertRuleStore, ICooldownStore, IMetricsReader, IAlertNotifier, IAlertScheduler.
- **`alerting/threshold-evaluator.ts`** -- Pure functions for threshold comparison, state resolution, notification decision logic.
- **`alerting/alert-scheduler.ts`** -- Periodic evaluation loop with configurable poll interval, concurrency limiting, cooldown tracking, and event emission.
- **`alerting/alert-notifier.ts`** -- Webhook notification delivery with injected delivery function for testability.
- **`alerting/memory-stores.ts`** -- In-memory implementations of IAlertRuleStore, ICooldownStore, IMetricsReader for testing.

### Pipeline Engine Layer (`packages/pipeline-engine/`)

- **`schemas/alert-rule.schema.ts`** -- Mongoose schema/model for AlertRule with tenant+project+name unique index.
- **`pipeline/services/alert-evaluator.service.ts`** -- Restate activity service that loads rules from MongoDB, queries ClickHouse, evaluates conditions, and updates rule status.

## 6. Data Model

### AlertRule (MongoDB: `alert_rules` collection)

| Field           | Type                                | Required | Description                       |
| --------------- | ----------------------------------- | -------- | --------------------------------- |
| tenantId        | String                              | Yes      | Tenant scope                      |
| projectId       | String                              | Yes      | Project scope                     |
| name            | String                              | Yes      | Human-readable rule name          |
| enabled         | Boolean                             | No       | Default: true                     |
| metric          | String                              | Yes      | ClickHouse column to aggregate    |
| sourceTable     | String                              | Yes      | ClickHouse table to query         |
| aggregation     | Enum(avg,sum,count,min,max,p95,p99) | Yes      | Aggregation function              |
| windowMinutes   | Number (min: 1)                     | Yes      | Time window for aggregation       |
| condition       | Enum(gt,lt,gte,lte)                 | Yes      | Comparison operator               |
| threshold       | Number                              | Yes      | Threshold value                   |
| cooldownMinutes | Number (default: 60)                | No       | Cooldown period after firing      |
| channels        | Array({type, config})               | Yes      | Notification channels             |
| lastEvaluatedAt | Date                                | No       | Last evaluation timestamp         |
| lastFiredAt     | Date                                | No       | Last firing timestamp             |
| status          | Enum(ok, firing, cooldown)          | No       | Current alert state (default: ok) |
| createdBy       | String                              | Yes      | User who created the rule         |
| createdAt       | Date                                | Auto     | Mongoose timestamp                |
| updatedAt       | Date                                | Auto     | Mongoose timestamp                |

**Indexes:**

- `{ tenantId: 1, projectId: 1, enabled: 1 }` -- for scheduler queries
- `{ tenantId: 1, projectId: 1, name: 1 }` (unique) -- prevent duplicate names

### AlertConfig (MongoDB -- tenant-scoped, used by `alert-config.ts`)

| Field           | Type                                    | Description          |
| --------------- | --------------------------------------- | -------------------- |
| tenantId        | String                                  | Tenant scope         |
| type            | Enum(usage_threshold, credit_low, etc.) | Alert category       |
| threshold       | Number (0-100)                          | Trigger percentage   |
| channel         | Enum(webhook, email)                    | Delivery channel     |
| target          | String                                  | Webhook URL or email |
| enabled         | Boolean                                 | Active flag          |
| cooldownMinutes | Number                                  | Cooldown period      |

## 7. API Endpoints

### Project-Scoped (`/api/projects/:projectId/alerts`)

| Method | Path                | Permission    | Description            |
| ------ | ------------------- | ------------- | ---------------------- |
| GET    | `/`                 | session:read  | List alert rules       |
| POST   | `/`                 | project:write | Create alert rule      |
| PUT    | `/:alertId`         | project:write | Update alert rule      |
| DELETE | `/:alertId`         | project:write | Delete alert rule      |
| GET    | `/:alertId/history` | session:read  | Get alert fire history |
| POST   | `/:alertId/test`    | project:write | Test-fire an alert     |

### Tenant-Scoped (`/api/tenants/:tenantId/alerts`)

| Method | Path   | Permission        | Description         |
| ------ | ------ | ----------------- | ------------------- |
| GET    | `/`    | credential:read   | List alert configs  |
| POST   | `/`    | credential:manage | Create alert config |
| PATCH  | `/:id` | credential:manage | Update alert config |
| DELETE | `/:id` | credential:manage | Delete alert config |

## 8. Security Considerations

### CRITICAL: SQL Injection Vulnerability

The `alerts.ts` test-fire endpoint and `alert-evaluator.service.ts` interpolate `rule.metric` and `rule.sourceTable` directly into ClickHouse SQL queries:

```typescript
// alerts.ts line 452 - SQL INJECTION
const query = `SELECT ${aggFn}(${rule.metric}) AS metric_value FROM ${rule.sourceTable} WHERE ...`;

// alert-evaluator.service.ts line 145 - SQL INJECTION
const aggExpr = buildAggregationExpr(rule.aggregation, rule.metric);
// ...
query: `SELECT ${aggExpr} as value FROM ${rule.sourceTable} WHERE ...`;
```

These values are user-controlled (stored in MongoDB from POST /alerts body). An attacker with project:write permission could craft a malicious `metric` or `sourceTable` value to execute arbitrary ClickHouse SQL.

**Required remediation:**

1. Validate `metric` against an allowlist of known column names
2. Validate `sourceTable` against an allowlist of known ClickHouse tables
3. Use ClickHouse parameterized identifiers where supported, or strict regex validation

### SSRF Protection

- Webhook URLs are validated via `assertAllowedCallbackUrl` at both creation and delivery time (defense-in-depth)
- Private IPs, cloud metadata endpoints, and localhost are blocked

### Authentication & Authorization

- All routes use `authMiddleware` + rate limiting
- Project-scoped routes use `requireProjectPermission` with appropriate permissions
- Tenant-scoped routes use `requirePermission` with `credential:read`/`credential:manage`
- Cross-tenant access returns 404 (not 403)

### Audit Logging

- All CRUD operations on alert configs are audit-logged
- Successful and failed deliveries are audit-logged

## 9. Observability

- All modules use `createLogger` (not console.log)
- Alert evaluation results are emitted as `alert.firing` / `alert.resolved` events via the event emitter
- Scheduler stats tracked: evaluationsRun, alertsFired, alertsResolved, alertsSkippedCooldown, notificationsSent, notificationsFailed

## 10. Error Handling

- All route handlers use try/catch with proper error type checking (`err instanceof Error ? err.message : String(err)`)
- Error responses follow the standard envelope: `{ success: false, error: { code, message } }`
- Alert notification failures are non-blocking (logged and counted, but don't prevent evaluation of other rules)
- The scheduler's `evaluateRuleSafe` method catches and swallows per-rule errors to prevent cascade failures

## 11. Performance Considerations

- Scheduler uses concurrency-limited fan-out (`maxConcurrency` config, default 10)
- ClickHouse queries use parameterized `tenant_id` and `project_id` for WHERE clause efficiency
- Cooldown checks are done before metric queries to avoid unnecessary ClickHouse load
- `Promise.allSettled` used for parallel notification delivery to prevent single-channel failures from blocking others

## 12. Testing Strategy

- **Unit tests:** Pure threshold evaluation logic in `alerting-threshold.test.ts` (22 tests)
- **Unit tests:** Alert evaluator service in `alert-evaluator.test.ts` (7 tests)
- **Unit tests:** Scheduler + Notifier + Memory stores in `alerting-scheduler.test.ts` (~25 tests)
- **Unit tests:** SSRF prevention in `alert-config-ssrf.test.ts` (3 tests)
- **E2E tests:** MISSING -- no end-to-end tests via HTTP API
- **Integration tests:** MISSING -- no tests with real MongoDB/ClickHouse

## 13. Migration & Rollout

- Feature is currently ALPHA status
- No database migration required (schema creates collection on first use)
- No feature flags in place
- Deployment: standard Turbo build + container deploy

## 14. Dependencies

| Dependency                            | Type     | Purpose                              |
| ------------------------------------- | -------- | ------------------------------------ |
| `@agent-platform/database/models`     | Internal | AlertConfig Mongoose model           |
| `@agent-platform/database/clickhouse` | Internal | ClickHouse client for metric queries |
| `@agent-platform/pipeline-engine`     | Internal | AlertRuleModel Mongoose model        |
| `@agent-platform/shared-auth`         | Internal | Permission middleware                |
| `@agent-platform/openapi/express`     | Internal | OpenAPI router factory               |
| `@abl/compiler/platform`              | Internal | Logger                               |
| `@restatedev/restate-sdk`             | External | Durable execution for evaluator      |
| `zod`                                 | External | Schema validation in OpenAPI routes  |

## 15. Open Questions

| ID   | Question                                                                      | Status    | Decision                                    |
| ---- | ----------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| OQ-1 | Should metric/sourceTable be validated against an allowlist at rule creation? | CRITICAL  | YES -- SQL injection vulnerability          |
| OQ-2 | Should there be a maximum number of alert rules per project?                  | DECIDED   | Yes, recommend 100 per project              |
| OQ-3 | Should alert history be persisted (ClickHouse or MongoDB)?                    | AMBIGUOUS | Currently only last-fired timestamp tracked |
| OQ-4 | Should the eventstore alerting engine replace the pipeline-engine evaluator?  | AMBIGUOUS | Two parallel implementations exist          |

## 16. Risks

| Risk                                                | Severity | Mitigation                                           |
| --------------------------------------------------- | -------- | ---------------------------------------------------- |
| SQL injection via metric/sourceTable interpolation  | CRITICAL | Allowlist validation at creation and evaluation time |
| Two parallel evaluation implementations may drift   | HIGH     | Consolidate into eventstore engine                   |
| Email delivery is placeholder only                  | MEDIUM   | Document as unsupported; add SMTP integration later  |
| No Studio UI limits discoverability                 | MEDIUM   | API-first approach; UI planned for future phase      |
| Memory stores used in tests may mask real DB issues | MEDIUM   | Add integration tests with real MongoDB              |

## 17. Future Enhancements

- Studio UI for alert rule management (list, create, edit, toggle)
- Slack notification channel with Slack API integration
- Alert history timeline with ClickHouse-backed storage
- Alert rule templates (pre-configured rules for common metrics)
- Escalation policies (multi-tier: webhook -> email -> PagerDuty)
- Alert grouping / deduplication across related rules
- Anomaly detection (ML-based threshold auto-adjustment)

## 18. Glossary

| Term             | Definition                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Alert Rule       | A configuration that defines what metric to monitor, the threshold, and notification channels |
| Alert Config     | Tenant-level alert configuration for platform-wide thresholds (usage, credit, health)         |
| Firing           | Alert state when the metric has breached the threshold                                        |
| Resolved         | Alert state when a previously-firing metric returns below threshold                           |
| Cooldown         | Period after firing during which re-notifications are suppressed                              |
| Evaluation Cycle | One pass through all active alert rules by the scheduler                                      |
| HMAC Signing     | Cryptographic signature on webhook payloads for authenticity verification                     |
| SSRF             | Server-Side Request Forgery -- blocked by URL validation                                      |
