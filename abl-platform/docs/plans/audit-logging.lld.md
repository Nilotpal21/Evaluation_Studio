# Audit Logging -- Low-Level Design

**Status**: Implemented (BETA, hardening completed on current branch)
**Feature Spec**: [docs/features/audit-logging.md](../features/audit-logging.md)
**HLD**: [docs/specs/audit-logging.hld.md](../specs/audit-logging.hld.md)
**Testing Guide**: [docs/testing/audit-logging.md](../testing/audit-logging.md)

---

## Implementation Overview

The audit logging system is fully implemented across 5 packages with 16 tasks. This LLD documents the implemented architecture as a reference for maintenance, gap remediation, and future enhancements.

---

## Task T-1: AuditStore Base Class

### Files Modified

- `packages/compiler/src/platform/stores/audit-store.ts` -- Abstract base, InMemoryAuditStore, factory

### Function Signatures

```typescript
// Abstract base class
abstract class AuditStore {
  constructor(config: AuditStoreConfig, alertConfig?: AlertConfig);
  async log(params: LogAuditParams): Promise<AuditLog>;
  async logAgentCreated(agentName, version, createdBy, environment): Promise<AuditLog>;
  async logAgentPromoted(agentName, version, fromEnv, toEnv, promotedBy): Promise<AuditLog>;
  async logAgentRolledBack(
    agentName,
    fromVersion,
    toVersion,
    reason,
    rolledBackBy,
    environment,
  ): Promise<AuditLog>;
  async logSessionStarted(
    sessionId,
    customerId,
    channel,
    agentName,
    environment,
  ): Promise<AuditLog>;
  async logSessionEnded(
    sessionId,
    customerId,
    disposition,
    durationMs,
    environment,
  ): Promise<AuditLog>;
  async logEscalationTriggered(
    sessionId,
    agentName,
    reason,
    priority,
    environment,
    traceId?,
  ): Promise<AuditLog>;
  async logHumanIntervention(
    sessionId,
    humanAgentId,
    action,
    environment,
    traceId?,
  ): Promise<AuditLog>;
  protected abstract append(log: AuditLog): Promise<void>;
  abstract query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }>;
  abstract getSummary(scope, environment, startTime, endTime): Promise<AuditSummary>;
  abstract getByTraceId(scope, traceId): Promise<AuditLog[]>;
  protected async checkAlerts(auditLog: AuditLog): Promise<void>;
  protected async sendAlert(payload: AlertPayload): Promise<void>;
}

// Interfaces
interface LogAuditParams {
  tenantId?: string;
  projectId?: string;
  eventType: AuditEventType;
  actor: string;
  actorType: 'user' | 'admin' | 'agent' | 'system';
  resourceType:
    | 'agent'
    | 'session'
    | 'customer'
    | 'contact'
    | 'workflow_definition'
    | 'deployment'
    | 'tool';
  resourceId: string;
  environment: Environment;
  action: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  traceId?: string;
}

interface QueryAuditParams {
  eventTypes?: AuditEventType[];
  actor?: string;
  actorType?: string;
  resourceType?: string;
  resourceId?: string;
  environment?: Environment;
  startTime: Date;
  endTime: Date;
  limit?: number;
  offset?: number;
}

interface AuditSummary {
  totalEvents: number;
  eventsByType: Record<AuditEventType, number>;
  eventsByActor: Record<string, number>;
  eventsByResource: Record<string, number>;
}

interface AlertConfig {
  enabled: boolean;
  webhookUrl?: string;
  slackWebhook?: string;
  criticalEvents: AuditEventType[];
}
```

### Key Implementation Details

- **LogAuditParams**: 14 fields including tenantId (defaults to `'unscoped'`), projectId, ipAddress, traceId
- **AuditLog**: Same 14 fields plus `id` (UUID via `randomUUID()`) and `timestamp` (auto `new Date()`)
- **Alert system**: `checkAlerts()` runs after every append. Matches `eventType` against `AlertConfig.criticalEvents` or error-containing event names.
- **Slack formatting**: Uses Block Kit with severity header and context sections (environment, actor).
- **InMemoryAuditStore**: Array-based storage, full query/filter/summary support for testing.

---

## Task T-2: AuditEventType Union

### Files Modified

- `packages/compiler/src/platform/core/types.ts` -- AuditEventType, AuditLog interface

### Key Implementation Details

- **Routine session telemetry policy**: `session.started`, `session.ended`, `session.accessed`, and `trace.queried` are not emitted as new audit rows. They are analytics/EventStore/trace signals; historical audit rows may still decode for compatibility.
- **Operational telemetry exclusions**: prompt test runs, deployment cache/status probes, OAuth initiation attempts, scheduled auth-profile token refresh/validation checks, webhook batch queue receipts, and local/test tool executions are not emitted as new audit rows.
- **31 audit-worthy event types** across 7 categories:
  - Agent lifecycle (7): `agent.created`, `agent.updated`, `agent.promoted`, `agent.rolled_back`, `agent.deprecated`, `agent.version_created`, `agent.dsl_updated`
  - Tool events (4): credentialed/external `tool.executed`, `tool.created`, `tool.updated`, `tool.deleted`
  - Runtime interventions (4): `handoff.executed`, `escalation.triggered`, `human.intervention`, `human.completed`
  - Contact (4): `contact.created`, `contact.updated`, `contact.deleted`, `contact.linked`
  - Workflow (3): `workflow.created`, `workflow.updated`, `workflow.archived`
  - Session mutation/test context (4): `session.modified`, `session.context_injected`, `session.tool_mock_set`, `session.test_created`
  - Security (3): `pii.accessed`, `permission.denied`, `rate_limit.hit`
- **Resource types**: `agent`, `session`, `customer`, `contact`, `workflow_definition`, `deployment`, `tool`
- **Actor types**: `user`, `admin`, `agent`, `system`

---

## Task T-3: Legacy MongoAuditStore (Historical)

### Files Modified

- Historical note: the original runtime shared path included a dedicated Mongo-backed implementation, but the current shared runtime steady state no longer routes through MongoDB.
- `packages/database/src/models/audit-log.model.ts` -- Mongoose model

### Key Implementation Details

- **append()**: Uses `AuditLog.create()` with field mapping: `userId` <- `auditLog.actor`, `tenantId` <- `auditLog.metadata?.tenantId`, metadata packed into single `Mixed` field containing eventType, actorType, resourceType, resourceId, environment, oldValue, newValue, traceId
- **query()**: Mongoose `find()` with filter construction: `action` for eventTypes, `userId` for actor, `metadata.resourceType` for resourceType, `metadata.resourceId` for resourceId, `createdAt` range. Sorted by `createdAt: -1`. Pagination via `skip(offset).limit(limit)`.
- **getSummary()**: MongoDB aggregation pipeline: `$match` by `createdAt` range -> `$group` by `{action, userId, 'metadata.resourceType'}` -> count
- **getByTraceId()**: `find({ 'metadata.traceId': traceId })` sorted `createdAt: 1`
- **Model**: UUIDv7 `_id`, 6 indexes, `ModelRegistry.registerModelDefinition('AuditLog', schema, 'platform')` for dual-database support. NOT tenant-scoped (allows cross-tenant admin queries).

---

## Task T-4: ClickHouseAuditStore

### Files Modified

- `apps/runtime/src/services/stores/clickhouse-audit-store.ts` -- ClickHouse backend

### Key Implementation Details

- **append()**: Uses `BufferedClickHouseWriter` with 10K row / 5s flush. Maps `AuditLog` to 17-column `ClickHouseAuditRow`. Immediate flush after each insert (fire-and-forget).
- **query()**: Builds WHERE clause from params with parameterized queries (`{param:Type}` syntax). `max_execution_time = 15`. Pagination via `LIMIT {limit:UInt32} OFFSET {offset:UInt32}`.
- **getSummary()**: `GROUP BY action, actor_id, resource_type` with `COUNT()`. Time-range filtered.
- **getByTraceId()**: Filter by `session_id = traceId` (session_id column stores trace correlation).
- **Timestamp format**: ISO to ClickHouse DateTime: remove `T`, remove `.{ms}Z` suffix.
- **Encryption**: metadata, old_value, new_value fields encrypted via ClickHouse encryption manifest (`_enc` column).
- **Current state**: Shared queries now use explicit per-query tenant filters through the ClickHouse reader contract; the old fixed-tenant query gap is resolved.

---

## Task T-5: Audit Store Singleton

### Files Modified

- `apps/runtime/src/services/audit-store-singleton.ts`

### Key Implementation Details

- **Backend selection** in the current shared runtime path:
  1. `auditPipelineEnabled === true` and `clickhouseReady === true` -> create Kafka -> ClickHouse pipeline store
  2. `auditPipelineEnabled === true` and `clickhouseReady === false` -> fail closed during initialization
  3. `clickhouseReady === true` and pipeline disabled -> fail closed (shared direct ClickHouse writes are not permitted)
  4. Neither -> import + instantiate `InMemoryAuditStore` from compiler package
- **Single initialization**: `_initialized` flag prevents re-initialization
- **Lazy imports**: ClickHouse and pipeline-backed stores imported dynamically to avoid startup dependencies
- **getAuditStore()**: Returns null if not initialized (callers must handle)
- **\_resetAuditStore()**: Test helper to reset singleton state

---

## Task T-6: Domain Audit Helpers

### Files Modified

- `apps/runtime/src/services/audit-helpers.ts` -- 20+ fire-and-forget helper functions

### Function Signatures

```typescript
// Internal
async function writeAuditLog(params: LogAuditParams): Promise<void>;

// Contact helpers
async function auditContactCreated(contact: Contact, actor: string): Promise<void>;
async function auditContactUpdated(contactId, oldValue, newValue, actor, tenantId?): Promise<void>;
async function auditContactDeleted(contactId, actor, tenantId?): Promise<void>;
async function auditContactLinked(sessionId, contactId, actor, tenantId?): Promise<void>;

// Workflow helpers
async function auditWorkflowCreated(workflow: WorkflowDefinition, actor): Promise<void>;
async function auditWorkflowUpdated(
  workflowId,
  oldValue,
  newValue,
  actor,
  tenantId?,
): Promise<void>;
async function auditWorkflowArchived(workflowId, actor, tenantId?): Promise<void>;

// Session helpers
async function auditSessionCreated(params, actor, tenantId?): Promise<void>;
async function auditSessionEnded(params, actor, tenantId?): Promise<void>;
async function auditSessionAccessed(sessionId, actor, tenantId?): Promise<void>;
async function auditTraceQueried(sessionId, actor, tenantId?): Promise<void>;
async function auditSessionModified(sessionId, action, actor, tenantId?): Promise<void>;

// Version helpers
async function auditVersionCreated(params, actor, tenantId?): Promise<void>;
async function auditVersionPromoted(params, actor, tenantId?): Promise<void>;
async function auditVersionDeprecated(params, actor, tenantId?): Promise<void>;
async function auditDslUpdated(params, actor, tenantId?): Promise<void>;

// Subscription helpers
async function auditSubscriptionCreated(params, actor, tenantId?): Promise<void>;
async function auditSubscriptionUpdated(params, actor, tenantId?): Promise<void>;
async function auditSubscriptionDeleted(params, actor, tenantId?): Promise<void>;

// Test context helpers
async function auditContextInjected(
  sessionId,
  actor,
  tenantId?,
  injectedKeys?,
  source?,
): Promise<void>;
async function auditToolMockSet(sessionId, actor, tenantId?, mockCount?, toolNames?): Promise<void>;
async function auditTestSessionCreated(sessionId, actor, tenantId?, injectedKeys?): Promise<void>;
```

### Key Implementation Details

- **writeAuditLog(params)**: Gets singleton store via `getAuditStore()`, calls `store.log()`, catches all errors with `log.error()`.
- **All helpers hardcode `environment: 'dev'`** (GAP-006). Should be dynamically resolved from runtime config.
- **No IP address or userAgent capture** in domain helpers (only in Mongoose plugin and Studio service).

---

## Task T-7: Tool Audit Logger

### Files Modified

- `apps/runtime/src/services/tool-audit-logger.ts`

### Key Implementation Details

- **ToolAuditLoggerImpl**: Routes through `AuditStore.log()` with `eventType: 'tool.executed'` and action format `tool:<toolName>` only for credentialed, external-endpoint, or failed tool calls. Metadata includes toolType, success, latencyMs, inputHash, authType, sessionId, tenantId, endpoint (redacted), errorMessage.
- **Tool execution audit**: Routes through `AuditStore.log()` only; the legacy direct-to-Mongoose runtime path has been removed from the current steady state.
- **Endpoint redaction**: `redactEndpoint()` imported from compiler package.
- **Error handling**: Catches all errors with `log.error()`, never throws.

---

## Task T-8: KMS Audit Logger

### Files Modified

- `apps/runtime/src/services/kms/kms-audit-logger.ts`

### Key Implementation Details

- **Separate from general audit**: Writes to `abl_platform.kms_audit_log` (not `audit_events`).
- **Fire-and-forget**: `logKMSAuditEvent()` catches all errors. Returns `void` (not `Promise<void>`).
- **Batch support**: `logKMSAuditEvents(events)` for rotation jobs.
- **Fallback**: When ClickHouse unavailable (`clickhouseAvailable === false`), emits structured log with `_audit: true` flag via `log.warn()`.
- **Availability flag**: `setKMSAuditClickHouseAvailable(available)` called at server startup.
- **Fields**: 18 columns including operation, key_id, key_version, key_purpose, provider_type, epoch, success, latency_ms.
- **Timestamp**: ISO -> ClickHouse DateTime64(3) format.

---

## Task T-9: PII Audit Logger

### Files Modified

- `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` -- Runtime Kafka/ClickHouse adapter
- `apps/runtime/src/services/execution/pii-audit-singleton.ts` -- Singleton
- `packages/database/src/models/pii-audit-log.model.ts` -- Historical Mongoose model retained for compatibility/tests

### Key Implementation Details

- **90-day retention**: Production retention for `stream: 'pii'` is enforced by ClickHouse DDL on `abl_platform.pii_audit_log`, with deployment-environment overrides available for non-production.
- **Consumer types**: `llm`, `user`, `logs`, `tools` -- tracks who accessed the PII.
- **Actions**: `tokenize`, `detokenize`, `render`, `clear`.
- **RuntimePIIAuditStore**: Implements `PIIAuditStore` interface from compiler. Builds canonical `stream: 'pii'` events and routes them through `writeAuditEvent(...)`. Fire-and-forget with `log.warn()` on failure.
- **Singleton**: `getPIIAuditLogger()` lazily creates `PIIAuditLogger` backed by `RuntimePIIAuditStore`. `resetPIIAuditLogger()` for testing.
- **Materialized schema**: `tenant_id`, `project_id`, `timestamp`, `event_id`, `action`, `actor_id`, `actor_type`, `token_id`, `pii_type`, `session_id`, `metadata`, `expires_at`.

---

## Task T-10: Audit Trail Mongoose Plugin

### Files Modified

- `packages/database/src/mongo/plugins/audit-trail.plugin.ts`

### Key Implementation Details

- **Auto-audit on three hooks**: `post('save')` (create/update), `post('findOneAndUpdate')`, `post('findOneAndDelete')`
- **Actor context**: `AsyncLocalStorage<AuditActorContext>` with `withAuditActor(actor, fn)` wrapper. `getCurrentAuditActor()` retrieves context.
- **Pre-save tracking**: `pre('save')` captures `isNew` and `modifiedPaths()` before Mongoose resets them in post hook.
- **Operations**: `'create'`, `'update'`, `'delete'`, `'softDelete'`, `'restore'`
- **Ciphertext masking**: `getModifiedFields()` reads `fieldsToEncrypt` from schema metadata. If a modified field is in the encrypted set, its value is replaced with `[ENCRYPTED]`. Fallback masked fields: `encryptedSecrets`, `previousEncryptedSecrets`.
- **Custom handler**: `setAuditHandler(handler)` allows test or external integrations to intercept audit entries.
- **Error handling**: `writeAuditEntry()` catches all errors with `console.error` (note: should use `createLogger`).
- **Separate schema**: The plugin creates its own `audit_log` model writing to the `audit_logs` collection (same collection as the `AuditLog` model, but different document shape with `collectionName`, `documentId`, `operation`, `changes`, `previousValues`).

---

## Task T-11: Studio Audit Service

### Files Modified

- `apps/studio/src/services/audit-service.ts` -- Service with 50+ action constants
- `apps/studio/src/repos/archive-repo.ts` -- archive manifest repository
- `apps/studio/src/app/api/audit/route.ts` -- User-scoped query API

### Key Implementation Details

- **50+ AuditActions**: Authentication (login, logout, login_failed, account_locked, token_refresh/revoke), Device Auth (started, approved, denied, completed), Debug (token created/revoked, subscribed, access_denied, tool_executed), Projects (created, updated, deleted), Agents (added, removed), Credentials (CRUD), Model Configs (CRUD), Service Nodes (CRUD), MFA (setup_confirmed, verified, failed, locked, disabled, recovery_code_used), Email Auth (signup, email_verified, password_reset), Workspace (created), Invitations (sent, accepted, revoked), Organizations (created, workspace linked), SSO (login, login_failed, config_created, domain_verified, assertion_replay_detected), Archives (created, downloaded, deleted), Retention (sweep_completed, sweep_failed), GDPR (deletion_completed, deletion_failed, sla_escalated), Tools (created, updated, deleted).
- **sanitizeAuditMetadata()**: Matches keys against `SENSITIVE_PATTERNS` (`password`, `hash`, `token`, `secret`, `apikey`, `authorization`, `cookie`, `credential`). Replaces values with `[REDACTED]`.
- **logAuditEvent()**: Auto-populates tenantId/requestId from context stubs, sanitizes sensitive metadata, builds a canonical shared audit envelope, and publishes it into the shared pipeline. Falls back to `process.stderr.write()` with `type: 'audit_fallback'` JSON if publish setup fails synchronously.
- **GET /api/audit**: User-scoped ClickHouse query path via the shared reader bridge. Filters: action, from, to, limit (max 200), offset.

---

## Task T-12: Admin Audit API + UI

### Files Modified

- `apps/admin/src/app/api/audit/route.ts` -- GET endpoint
- `apps/admin/src/lib/audit-logger.ts` -- Logger + query helpers
- `apps/admin/src/app/(dashboard)/audit/page.tsx` -- Audit log viewer

### Key Implementation Details

- **GET /api/audit**: Protected by `getAuthContext()` + `requireRole(auth, 'VIEWER')`. Accepts actor, action, from, to, limit.
- **logAdminAction()**: Writes structured stdout/stderr fallback logs and publishes canonical shared audit events into the pipeline.
- **queryAuditLog()**: ClickHouse-backed query with optional filters, sorted by timestamp descending, limit default 50.
- **Admin UI**: Table with Timestamp, Actor, Action (badge), Target, IP columns. Text input (actor, debounced 300ms), select (action), date pickers (from/to). CSV export via `formatCSV()` + Blob download. "Load more" pagination (+50 per click).
- **Action options**: `config_view`, `secret_list` (limited scope -- admin is read-only dashboard).

---

## Task T-13: Contact Audit DDD Port

### Files Modified

- `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`

### Key Implementation Details

- **Port pattern**: `ContactAuditEmitter = (event: ContactAuditEvent) => Promise<void>` -- decoupled from store implementation.
- **7 contact audit actions**: `contact.created`, `contact.resolved`, `contact.merged`, `contact.self_merged`, `contact.identity_added`, `contact.session_linked`, `contact.gdpr_erased`.
- **ContactAuditEvent**: `{ action, tenantId, contactId, metadata?, timestamp }`.
- **Usage**: Use cases accept optional `ContactAuditEmitter`, call fire-and-forget with `.catch()`.

---

## Task T-14: Auth Profile Audit Events

### Files Modified

- `packages/database/src/auth-profile/audit-events.ts`

### Key Implementation Details

- **Event constants include legacy/operational values**: `AUTH_PROFILE_VALIDATED`, `AUTH_PROFILE_TOKEN_REFRESHED`, and `AUTH_PROFILE_OAUTH_INITIATED` remain defined for compatibility, but they are not part of the default Studio audit explorer catalog and should not be emitted as new audit rows unless product promotes a specific failure/security case.
- **Type**: `AuthProfileAuditEvent = typeof AUTH_PROFILE_AUDIT_EVENTS[keyof typeof AUTH_PROFILE_AUDIT_EVENTS]`.

---

## Task T-15: ClickHouse Schema DDL

### Files Modified

- `packages/database/src/clickhouse-schemas/init.ts`

### Key Implementation Details

- **audit_events table**: ReplicatedMergeTree, partitioned by `toYYYYMM(timestamp)`, ordered by `(tenant_id, timestamp, action)`. Indexes: `idx_action` (set 100), `idx_actor` (bloom), `idx_session` (bloom), `idx_resource` (set 20). TTL: deployment-env-specific DDL with production default 90d to cold + 730d DELETE. `_enc` column for encryption manifest.
- **kms_audit_log table**: ReplicatedMergeTree, partitioned by `toYYYYMM(timestamp)`, ordered by `(tenant_id, timestamp, operation)`. Indexes: `idx_operation` (set 20), `idx_key_id` (bloom), `idx_actor` (bloom), `idx_success` (set 2). TTL: 1yr warm, 3yr DELETE.
- **Migration**: `ALTER TABLE ADD COLUMN IF NOT EXISTS _enc` applied to `audit_events` for existing deployments.

---

## Task T-16: Crawl Audit Events Model

### Files Modified

- `packages/database/src/models/crawl-audit-event.model.ts`

### Key Implementation Details

- **11 event types**: `crawl.started`, `crawl.paused`, `crawl.resumed`, `crawl.completed`, `crawl.failed`, `crawl.cancelled`, `crawl.strategy_changed`, `crawl.retry`, `strategy.selected`, `strategy.auto_applied`, `strategy.user_overridden`.
- **Context fields**: strategy, urls, estimatedDocuments, userAgent, ipAddress.
- **Severity levels**: `info`, `warning`, `error`.
- **No TTL**: Retention undefined (GAP-008).

---

## Wiring Checklist

| #   | Wiring Point                                             | File                                                         | Status |
| --- | -------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| 1   | Audit singleton initialized at server startup            | `apps/runtime/src/server.ts`                                 | DONE   |
| 2   | KMS audit availability set at startup                    | `apps/runtime/src/server.ts`                                 | DONE   |
| 3   | Tool audit logger wired into execution engine            | `apps/runtime/src/services/execution/llm-wiring.ts`          | DONE   |
| 4   | PII audit logger singleton initialized                   | `apps/runtime/src/services/execution/pii-audit-singleton.ts` | DONE   |
| 5   | Audit helpers called from route handlers                 | Various route files in `apps/runtime/src/routes/`            | DONE   |
| 6   | Studio audit service called from 39 route files          | Various route files in `apps/studio/src/app/api/`            | DONE   |
| 7   | Admin audit logger called from admin routes              | `apps/admin/src/app/api/`                                    | DONE   |
| 8   | Audit trail plugin applied to sensitive Mongoose schemas | Various model files                                          | DONE   |
| 9   | ClickHouse audit_events table created at schema init     | `packages/database/src/clickhouse-schemas/init.ts`           | DONE   |
| 10  | ClickHouse kms_audit_log table created at schema init    | `packages/database/src/clickhouse-schemas/init.ts`           | DONE   |
| 11  | AuditLog model registered in ModelRegistry               | `packages/database/src/models/audit-log.model.ts`            | DONE   |
| 12  | PIIAuditLog model registered in ModelRegistry            | `packages/database/src/models/pii-audit-log.model.ts`        | DONE   |

---

## Historical Hardening Gaps (Resolved / Classified)

| ID      | Description                                   | Severity | Current State                                                         |
| ------- | --------------------------------------------- | -------- | --------------------------------------------------------------------- |
| GAP-001 | ClickHouseAuditStore writer logging alignment | Low      | Resolved                                                              |
| GAP-002 | Admin audit metadata canonicalization         | Low      | Resolved                                                              |
| GAP-003 | Dedicated audit HTTP E2E coverage             | High     | Resolved via Studio/Admin public-API E2E coverage                     |
| GAP-004 | Alert dispatch tests                          | Medium   | Resolved                                                              |
| GAP-005 | ClickHouse tenant-safe query behavior         | Medium   | Resolved                                                              |
| GAP-006 | Runtime `environment` hardcoding              | Medium   | Resolved via runtime environment resolver                             |
| GAP-007 | Studio shared audit IP normalization          | Medium   | Resolved within the audit path                                        |
| GAP-008 | Crawl retention ambiguity                     | Low      | Classified as operational history, explicitly non-blocking            |
| GAP-009 | Studio personal/workspace audit viewer        | Medium   | Resolved via SecurityPage audit tab                                   |
| GAP-010 | Admin structured logging cleanup              | Low      | Resolved                                                              |
| GAP-011 | ClickHouse `audit_events` delete TTL          | Medium   | Resolved with 90-day cold-storage + 730-day delete retention contract |

---

## Rollback Plan

The audit logging system is a write-only, non-critical-path feature. Rollback options:

1. **Disable pipeline mode**: Not a production rollback path anymore. In ClickHouse-ready environments the shared runtime lane now fails closed if `AUDIT_PIPELINE_ENABLED` is off.
2. **Disable ClickHouse-backed shared audit**: Set `clickhouseReady: false` in server startup -> shared runtime path falls back to in-memory only; there is no shared Mongo fallback anymore
3. **Disable all audit**: Reset singleton to null -> `getAuditStore()` returns null -> all helpers no-op
4. **Disable KMS audit**: `setKMSAuditClickHouseAvailable(false)` -> falls back to structured logging
5. **Disable audit trail plugin**: Remove `schema.plugin(auditTrailPlugin)` from model definitions
6. **Disable Studio audit**: Remove `logAuditEvent()` calls from route handlers (39 files)

None of these rollbacks affect the primary request flow due to fire-and-forget semantics.
