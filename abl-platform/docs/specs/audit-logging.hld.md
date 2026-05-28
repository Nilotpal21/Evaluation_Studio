# Audit Logging -- High-Level Design

**Status**: Implemented (BETA, hardening completed on current branch)
**Feature Spec**: [docs/features/audit-logging.md](../features/audit-logging.md)
**Testing Guide**: [docs/testing/audit-logging.md](../testing/audit-logging.md)
**LLD**: [docs/plans/2026-04-16-audit-logging-hardening-impl-plan.md](../plans/2026-04-16-audit-logging-hardening-impl-plan.md)

---

## What

A platform-wide, append-only audit logging system that captures structured events for every sensitive operation across the agent platform -- agent lifecycle, session management, contact operations, tool execution, KMS operations, PII access, authentication events, and admin actions. The current implementation uses a versioned shared audit envelope plus compatibility readers so legacy Mongo rows, canonical V2 rows, and plugin-generated rows can coexist safely during rollout. The shared runtime path now uses Kafka-backed asynchronous materialization into ClickHouse, and the active specialized audit domains now materialize into dedicated ClickHouse tables as well; MongoDB remains only for legacy-compatible rows and historical models outside the steady-state path.

## Why

Enterprise customers require immutable audit trails for SOC2, HIPAA, and PCI DSS compliance. Without structured audit logging, security investigations require manual log correlation across multiple services (Runtime, Studio, Admin). The agent platform handles sensitive data (LLM credentials, PII, session history, encryption keys) and needs a comprehensive record of who accessed what, when, and from where. Different compliance frameworks impose different retention requirements: PCI DSS 3.6 mandates 3-year key management audit trails; GDPR requires PII audit auto-expiry.

## Architecture Approach

### System Context

```
+---------------------+      +-----------------------+      +-------------------+
|   Studio (Next.js)  |      |   Runtime (Express)   |      | Admin (Next.js)   |
|                     |      |                       |      |                   |
| audit-service.ts    |      | audit-helpers.ts      |      | audit-logger.ts   |
| (50+ AuditActions)  |      | (20+ domain helpers)  |      | (admin actions)   |
| logAuditEvent()     |      | tool-audit-logger.ts  |      | queryAuditLog()   |
|                     |      | kms-audit-logger.ts   |      |                   |
+--------+------------+      +---------+-------------+      +--------+----------+
         |                             |                              |
         v                             v                              v
+--------+-----------------------------+------------------------------+---------+
|                     Shared Audit Ingress / Contract Layer                    |
|  AuditStore + audit-pipeline.ts + shared-audit-codec.ts                     |
|  - emit canonical AuditEvent                                                |
|  - decode legacy/plugin rows safely                                         |
|  - query / summary / trace lookup                                           |
|  - alert dispatch                                                            |
+-----------+-------------------+-------------------+---------------------------+
            |                   |                   |
            v                   v                   v
 +----------------------+   +-------------------+  +-------------------------+
 | KafkaAuditTransport  |   | InMemoryAudit     |  | ClickHouseAuditReader   |
 | + SharedMaterializer |   | Store (dev/test)  |  | (Studio/Admin/runtime)  |
 +----------+-----------+   +-------------------+  +------------+------------+
            |                                                     |
            v                                                     |
 +------------------------+                                       |
 | ClickHouseAuditSink    |---------------------------------------+
 +-----------+------------+
             |
             v
 +------------------------+
 | ClickHouse             |
 | audit_events           |
 | (encrypted, TTL)       |
 +------------------------+

Shared compatibility layer:
+-------------------+
| shared-audit-     |
| codec.ts          |
| canonical V2 +    |
| legacy decoding   |
+-------------------+

Specialized Subsystems (independent storage):
+-------------------+  +-------------------+  +-------------------+
| KMS Audit Logger  |  | PII Audit Store   |  | Audit Trail       |
| -> kms_audit_log  |  | -> pii_audit_log  |  | Plugin            |
| (ClickHouse, 3yr) |  | (ClickHouse, TTL) |  | (handler only)    |
+-------------------+  +-------------------+  +-------------------+
```

### Packages Changed

- `packages/compiler` -- AuditStore base class, AuditEventType types, shared audit codec, alert config, audit middleware
- `packages/database` -- legacy Mongo models (`audit_logs` compatibility, historical PII/crawl/arch models), audit trail plugin, auth profile audit events, ClickHouse schema DDL
- `apps/runtime` -- Kafka transport/materializer, ClickHouse sink/reader, domain helpers, singleton, auth-path shared audit adapter, tool/KMS/PII audit loggers, compat/backfill scripts, contact audit port
- `apps/studio` -- Audit service, ClickHouse audit query API, archive export API, archive manifest repository, route-handler actor propagation
- `apps/admin` -- Admin audit query API, admin action logger, admin-route actor propagation, audit CSV export helper/UI page

### Data Flow

```
  User Action (any app: Studio, Runtime, Admin)
        |
        v
  Route Handler / Service Method
        |
        +---> Studio: logAuditEvent(AuditEvent) --> sanitizeMetadata --> publishStudioAuditPipelineEvent()
        |
        +---> Runtime: auditXxxYyy() helper --> writeAuditLog --> getAuditStore().log(params)
        |
        +---> Runtime auth / OAuth: auth-repo.writeAuditLog() --> canonical AuditEvent --> singleton backend
        |
        +---> Admin: logAdminAction() --> canonical shared event + structured fallback log
        |
        +---> Shared runtime path:
        |       canonical AuditEvent
        |            |
        |            +--- checkAlerts() --> webhook / Slack
        |            |
        |            v
        |       KafkaAuditTransport --> SharedAuditMaterializer --> ClickHouseAuditSink --> audit_events
        |            |
        |            +---> InMemoryAuditStore (dev/test when pipeline mode is disabled and CH is unavailable)
        |
        +---> Mongoose Plugin: auditTrailPlugin --> post('save'|'findOneAndUpdate'|'findOneAndDelete')
                                                        |
                                                        v
                                                  writeAuditEntry() --> customHandler || one-time drop warning
                                                        |
                                                  Actor from AsyncLocalStorage<AuditActorContext>

  Specialized Paths:
  +---> Tool Execution: ToolAuditLoggerImpl.logToolAudit() --> AuditStore.log()
  +---> KMS Operation: logKMSAuditEvent() --> ClickHouse kms_audit_log (direct)
  +---> PII Access: PIIAuditLogger.log() --> RuntimePIIAuditStore.insert() --> Kafka/ClickHouse pii_audit_log
```

### Key Integration Points

- **Server startup** (`apps/runtime/src/server.ts`): `initializeAuditStore({ clickhouseReady })` now treats the shared runtime lane as Kafka-first only. In ClickHouse-ready environments it requires `AUDIT_PIPELINE_ENABLED=true` and initializes the strict Kafka -> ClickHouse pipeline; otherwise startup fails closed instead of silently downgrading. Only ClickHouse-unavailable dev/test contexts use InMemory. `setKMSAuditClickHouseAvailable(true)` enables KMS audit
- **Route handlers**: Import and call specific helpers (e.g., `auditSessionCreated()`, `auditContactUpdated()`) from `audit-helpers.ts`
- **Studio routes**: 39 route files call `logAuditEvent()` from `audit-service.ts`
- **Tool execution engine**: `ToolAuditLoggerImpl` receives `ToolAuditEntry` from execution engine via `createAuditMiddleware()`
- **KMS operations**: `logKMSAuditEvent()` writes directly to ClickHouse `kms_audit_log`
- **PII vault access**: `PIIAuditLogger` (compiler) -> `RuntimePIIAuditStore` (runtime adapter) -> Kafka -> ClickHouse `pii_audit_log`
- **Mongoose collections**: `auditTrailPlugin` applied via `schema.plugin(auditTrailPlugin)` on sensitive models, with actor context propagated by Studio/Admin route wrappers via `withAuditActor(...)`
- **Admin queries**: `GET /api/audit` queries ClickHouse via `queryAuditLog()`
- **Studio queries**: `GET /api/audit` queries ClickHouse via `queryStudioAuditLogsFromClickHouse()` (user-scoped)

### Data Model

```
audit_logs (MongoDB) -- legacy/shared compatibility + plugin audit collection
  _id (UUIDv7), userId, tenantId, action, ip, userAgent
  metadata (legacy or canonical compatibility metadata)
  eventType, actorType, projectId, resourceType, resourceId, environment, traceId
  source, schemaVersion, metadataEncoding, retentionClass, expiresAt
  _v, createdAt, updatedAt
  Indexes: {tenantId,createdAt}, {userId}, {action}, {tenantId,action,createdAt}, {tenantId,eventType,createdAt},
           {tenantId,resourceType,resourceId,createdAt}, {tenantId,projectId,createdAt}, {traceId,createdAt},
           {schemaVersion,source,createdAt}, plus the legacy metadata-resource sparse index
  TTL index on expiresAt is rollout-gated and disabled by default.
  Note: NOT tenant-scoped (allows cross-tenant admin queries). Registered in ModelRegistry as 'platform'.

abl_platform.audit_events (ClickHouse) -- shared audit system of record
  tenant_id, timestamp, action, event_id, actor_id, actor_type, actor_ip, actor_user_agent
  resource_type, resource_id, session_id, project_id
  old_value (encrypted), new_value (encrypted), metadata (encrypted), _enc
  success, failure_reason
  Engine: ReplicatedMergeTree, Partition: toYYYYMM(timestamp), Order: (tenant_id, timestamp, action)
  TTL: 90 days to cold, 730-day DELETE (deployment-env-specific DDL may shorten non-production retention)

abl_platform.pii_audit_log (ClickHouse) -- PII access compliance
  _id (UUIDv7), tenantId, projectId, sessionId, tokenId, piiType
  consumer (llm|user|logs|tools), renderMode, action (tokenize|detokenize|render|clear)
  metadata, expireAt (TTL 90 days)
  Indexes: {tenantId,sessionId}, {tenantId,createdAt}, {tenantId,piiType,createdAt}

abl_platform.kms_audit_log (ClickHouse) -- KMS key management compliance
  tenant_id, timestamp, event_id, operation, key_id, key_version, key_purpose
  provider_type, project_id, environment, epoch
  actor_id, actor_type, actor_ip, success, error_message, latency_ms, metadata
  TTL: 1yr warm, 3yr DELETE (PCI DSS 3.6)

abl_platform.crawl_audit_events (ClickHouse) -- crawl operational history
  _id (UUIDv7), tenantId, crawlJobId, userId, eventType (11 types)
  description, changes, context, severity
  Indexes: {tenantId,createdAt}, {crawlJobId}, {eventType,createdAt}, {userId,createdAt}

audit_logs (Mongoose plugin target collection -- same as above)
  Created by auditTrailPlugin for any model it's applied to.
  Plugin rows now stamp source='mongoose-plugin' and schemaVersion=1 for compatibility decoding.
```

### API Surface

| Method | Path                         | App    | Scope          | Purpose                           |
| ------ | ---------------------------- | ------ | -------------- | --------------------------------- |
| GET    | `/api/audit`                 | Admin  | Platform admin | Query audit logs with filters     |
| GET    | `/api/audit`                 | Studio | User-scoped    | Query current user's audit logs   |
| POST   | `/api/archives/audit-export` | Studio | Tenant admin   | Create audit log archive manifest |

---

## 12 Architectural Concerns

### 1. Resource Isolation

- **Tenant**: ClickHouse queries always include `tenant_id` filter. MongoDB `audit_logs` indexed by `tenantId`. PII audit scoped by `tenantId`.
- **Project**: `projectId` stored when available but not enforced as a query filter (audit is tenant-scoped).
- **User**: Studio audit API filters by `userId`. Admin API allows cross-user queries for investigation.
- **Current state**: shared-contract runtime reads now require explicit tenant scoping unless the store instance itself is already tenant-scoped.

### 2. Auth & Authorization

- Admin API: Protected by `requireRole(auth, 'VIEWER')` via `getAuthContext()`.
- Studio API: Protected by `requireAuth()` with user-scoped queries.
- Audit archive export: Requires `OWNER` or `ADMIN` role via `TenantMember` lookup.
- Internal audit writes: No authorization (fire-and-forget from authenticated contexts).

### 3. Stateless & Distributed

- Audit store singleton is per-process (not shared across pods).
- Shared runtime writes flow through Kafka -> ClickHouse whenever ClickHouse is available. If pipeline mode is missing in a ClickHouse-ready environment, startup fails closed; only ClickHouse-unavailable dev/test contexts use in-memory fallback. Specialized subsystems keep their own dedicated stores.
- `AsyncLocalStorage` for audit actor context is request-scoped and pod-local.
- No distributed lock needed (append-only writes, no read-modify-write).

### 4. Traceability

- `traceId` field on `AuditLog` interface for execution trace correlation.
- `getByTraceId()` method on all AuditStore implementations.
- KMS audit events include `session_id` for trace correlation.
- Audit trail plugin records `collectionName` + `documentId` for source tracing.

### 5. Compliance

- **SOC2**: Immutable, append-only audit trail. No update/delete operations.
- **HIPAA**: PII access audited via `abl_platform.pii_audit_log` with consumer tracking.
- **PCI DSS 3.6**: KMS operations in dedicated `kms_audit_log` with 3-year retention.
- **GDPR**: PII audit auto-expiry (90-day TTL). `audit_logs` support anonymization (not deletion).

### 6. Performance

- ClickHouse buffered writer: 10K rows / 5s flush interval.
- Fire-and-forget: audit writes never block the request path.
- ClickHouse ZSTD compression on all columns; LowCardinality on enum-like fields.
- MongoDB indexes for efficient filtering.
- ClickHouse `max_execution_time = 15` prevents runaway queries.

### 7. Encryption

- ClickHouse `audit_events`: metadata, old_value, new_value encrypted via field-interceptor manifest (`_enc` column).
- Audit trail plugin: encrypted fields masked as `[ENCRYPTED]` in diffs.
- Studio audit service: sensitive metadata keys redacted to `[REDACTED]`.

### 8. Error Handling

- All audit writes: try-catch with error logging, never throw.
- Studio fallback: `process.stderr.write()` JSON fallback when primary audit logging fails.
- KMS audit: structured log with `_audit: true` flag when ClickHouse unavailable.
- Singleton: the shared runtime lane fails closed unless the Kafka -> ClickHouse pipeline is available; only ClickHouse-unavailable dev/test contexts use InMemory.
- Shared auth and PII buffered writers now flush on shutdown instead of dropping in-flight batches during normal process teardown.

### 9. Observability

- Logger namespaces: `audit-helpers`, `audit-store-singleton`, `tool-audit-logger`, `kms-audit`, `pii-audit-store`.
- Admin action fallback uses structured stdout/stderr JSON rather than bare `console.*` logging.
- `_audit: true` flag for structured log aggregation of fallback events.
- Alert system: webhook + Slack dispatch for critical events.

### 10. Data Lifecycle

- `audit_logs` (MongoDB): Indefinite retention by default; `expiresAt` and the sparse TTL index are rollout-gated and disabled by default until policy approval. Archive export is tenant-scoped.
- `pii_audit_log` (ClickHouse): deployment-env-specific TTL; production default preserves 90-day retention.
- `audit_events` (ClickHouse): 90 days to cold volume, 730-day DELETE TTL.
- `kms_audit_log` (ClickHouse): 1yr warm, 3yr DELETE.
- `crawl_audit_events` (ClickHouse): explicitly classified as operational history today; retention is enforced by deployment-env-specific DDL.

### 11. Migration & Backward Compatibility

- Tool execution audit now routes through the shared `AuditStore` path rather than maintaining a separate legacy Mongo writer.
- Audit trail plugin can be selectively applied to schemas (not all-or-nothing).
- ClickHouse schema DDL uses `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` for idempotent migrations.

### 12. Testing Strategy

- Unit and targeted integration coverage now exists for:
  - shared codec compatibility and backfill planning
  - legacy Mongo compatibility plus ClickHouse reader/writer behavior
  - singleton backend selection, strict pipeline behavior, and alert config wiring
  - plugin actor propagation
  - Studio/Admin compatibility readers and CSV export
  - retention gating and buffered shutdown behavior
  - shared-contract regression checks
- Dedicated public-API HTTP audit coverage now exists for Studio roundtrip writes, tenant isolation, fire-and-forget failure handling, Admin query filters, and Admin CSV export.
- See [docs/testing/audit-logging.md](../testing/audit-logging.md) for the current test inventory and remaining gaps.

---

## Decisions & Tradeoffs

| #    | Decision                                               | Rationale                                                                                | Alternatives Considered                                                                  |
| ---- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| D-1  | Fire-and-forget over synchronous writes                | Audit failures must never block business operations                                      | Synchronous with circuit breaker (rejected: too complex for audit)                       |
| D-2  | ClickHouse as shared audit backend with Kafka ingress  | ClickHouse excels at time-series analytics; Kafka decouples producers from materializers | Shared Mongo fallback (rejected), direct-only writes (rejected), single backend no queue |
| D-3  | Separate KMS audit table with 3-year retention         | PCI DSS 3.6 retention differs from general audit                                         | Single table with per-row TTL (rejected: ClickHouse TTL is table-level)                  |
| D-4  | PII audit with 90-day TTL auto-expiry                  | GDPR right to erasure without manual intervention                                        | Manual deletion jobs (rejected: operational risk)                                        |
| D-5  | Domain-specific helpers over generic middleware        | Different operations have different metadata requirements                                | Express middleware (rejected: too coarse-grained), event bus (rejected: over-engineered) |
| D-6  | Alert system in AuditStore base class                  | Every backend automatically gets alerting                                                | Separate alert service (rejected: duplication, coupling)                                 |
| D-7  | Mongoose plugin for automatic audit trail              | Reduces manual audit call burden; ensures all writes are captured                        | Manual audit calls only (rejected: error-prone, easy to miss)                            |
| D-8  | AsyncLocalStorage for actor context                    | Propagates actor without parameter threading through deep call stacks                    | Explicit parameters (rejected: impractical for Mongoose hooks)                           |
| D-9  | Canonical top-level fields plus compatibility metadata | Preserves legacy rows while enabling consistent querying, exports, and retention rollout | Metadata-only model (rejected: keeps drift and reader fragility)                         |
| D-10 | Separate Studio audit service with sanitization        | Studio handles authentication and PII-adjacent data requiring extra redaction            | Shared audit service (rejected: different app contexts, deployment boundary)             |

---

## Security

- **Append-only**: No update or delete operations on audit records. MongoDB model has no `findOneAndUpdate` or `findOneAndDelete` routes for audit logs.
- **Metadata encryption at rest**: ClickHouse `audit_events` fields (`metadata`, `old_value`, `new_value`) encrypted via field-interceptor encryption manifest.
- **Ciphertext masking**: Audit trail plugin masks encrypted field diffs as `[ENCRYPTED]` to prevent ciphertext exposure.
- **Sensitive metadata redaction**: Studio `sanitizeAuditMetadata()` redacts keys matching password, hash, token, secret, apikey, authorization, cookie, credential patterns.
- **PII auto-expiry**: 90-day MongoDB TTL auto-deletion (GDPR compliance).
- **Admin API auth**: `requireRole(auth, 'VIEWER')` with `getAuthContext()`.
- **Studio API auth**: `requireAuth()` with user-scoped query filtering.
- **Tool endpoint redaction**: `redactEndpoint()` strips sensitive URL components before audit storage.
- **ClickHouse query safety**: `max_execution_time = 15` prevents resource exhaustion; parameterized queries prevent injection.
- **IP handling**: Studio shared audit writes normalize forwarded chains through the same trusted-rightmost proxy convention used elsewhere in Studio request handling.

---

## Observability

- Logger namespaces: `audit-helpers`, `audit-store-singleton`, `tool-audit-logger`, `kms-audit`, `pii-audit-store`
- `[Audit]` console prefix for admin action logging
- `_audit: true` flag on KMS fallback log entries for structured log aggregation
- Alert system dispatches to webhook and Slack on critical audit event types
- Audit trail plugin warns on write failures: `[AUDIT] Failed to write audit entry for {collection}.{operation}`

---

## Task Decomposition

| Task                                  | Package(s)                      | Independent?  | Est. Files | Status |
| ------------------------------------- | ------------------------------- | ------------- | ---------- | ------ |
| T-1: AuditStore base class + InMemory | packages/compiler               | Yes           | 1          | DONE   |
| T-2: AuditEventType + AuditLog types  | packages/compiler               | Yes           | 1          | DONE   |
| T-3: Legacy MongoAuditStore + model   | apps/runtime, packages/database | No (T-1)      | 2          | DONE   |
| T-4: ClickHouseAuditStore             | apps/runtime                    | No (T-1)      | 1          | DONE   |
| T-5: Audit store singleton            | apps/runtime                    | No (T-3, T-4) | 1          | DONE   |
| T-6: Domain audit helpers             | apps/runtime                    | No (T-5)      | 1          | DONE   |
| T-7: Tool audit logger                | apps/runtime                    | No (T-5)      | 1          | DONE   |
| T-8: KMS audit logger                 | apps/runtime                    | Yes           | 1          | DONE   |
| T-9: PII audit logger + model         | apps/runtime, packages/database | Yes           | 3          | DONE   |
| T-10: Audit trail Mongoose plugin     | packages/database               | Yes           | 1          | DONE   |
| T-11: Studio audit service            | apps/studio                     | No (T-3)      | 3          | DONE   |
| T-12: Admin audit API + UI            | apps/admin                      | No (T-3)      | 3          | DONE   |
| T-13: Contact audit DDD port          | apps/runtime                    | Yes           | 1          | DONE   |
| T-14: Auth profile audit events       | packages/database               | Yes           | 1          | DONE   |
| T-15: ClickHouse schema DDL           | packages/database               | Yes           | 1          | DONE   |
| T-16: Crawl audit events model        | packages/database               | Yes           | 1          | DONE   |

---

## Out of Scope

- Real-time audit event streaming (WebSocket push)
- Audit log tamper-proofing (hash chain / blockchain verification)
- Client-side audit event generation
- Cross-tenant audit queries outside admin API
- Tenant-facing audit log viewer in Studio
- Audit data retention management UI
