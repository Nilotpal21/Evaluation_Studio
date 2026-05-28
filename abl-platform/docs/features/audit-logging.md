# Feature: Audit Logging

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `governance`, `enterprise`, `observability`
**Package(s)**: `packages/compiler` (AuditStore base, shared pipeline contracts), `apps/runtime` (stores, helpers, singleton, Kafka pipeline), `apps/studio` (audit service, readers, archive APIs), `apps/admin` (audit dashboard API, readers, pipeline writer), `packages/database` (models, plugins, ClickHouse DDL), `packages/eventstore` (Kafka publisher helpers)
**Owner(s)**: Platform team
**Testing Guide**: [../testing/audit-logging.md](../testing/audit-logging.md)
**Last Updated**: 2026-05-08

---

## 1. Introduction / Overview

### Problem Statement

Enterprise agent platforms require an immutable audit trail for compliance (SOC2, HIPAA, GDPR, PCI DSS). Without structured audit logging, tracking who performed what action, when, and on which resource requires manually correlating application logs across multiple services (Runtime, Studio, Admin). This process is slow, unreliable, and fails compliance audits. Furthermore, different compliance frameworks impose different retention requirements (e.g., PCI DSS 3.6 mandates 3-year key management audit trails) that cannot be met by undifferentiated application logs.

### Goal Statement

Provide a platform-wide, append-only audit logging system that captures structured events for every sensitive operation -- agent lifecycle, session management, contact operations, tool execution, KMS operations, PII access, authentication events, and admin actions -- with a versioned shared audit envelope, reader-first compatibility for legacy rows, Kafka-backed asynchronous materialization into ClickHouse for the shared audit stream, fire-and-forget write semantics, specialized retention policies per compliance domain, and alerting for critical events.

### Summary

The audit logging system consists of five layers:

1. **Contract layer** (`packages/compiler`): Abstract `AuditStore` base class plus the shared audit codec, defining the versioned structured audit envelope, compatibility decoding for legacy rows, `AuditEventType`, `AuditLog`, retention defaults, and critical-event alert dispatch.
2. **Storage layer** (`apps/runtime`): The shared runtime audit path now materializes into ClickHouse through the strict Kafka -> ClickHouse pipeline. `audit-store-singleton.ts` requires `AUDIT_PIPELINE_ENABLED=true` whenever ClickHouse is available; otherwise the shared runtime path uses InMemory only for dev/test or ClickHouse-unavailable scenarios. MongoDB remains only for legacy compatibility rows in `audit_logs` and historical models that are no longer part of the active steady-state path.
3. **Application writer layer** (`apps/runtime`, `apps/studio`, `apps/admin`): Runtime domain helpers, Studio audit service, Admin audit logger, and the runtime auth audit adapter all now emit canonical shared fields while preserving compatibility with historical rows.
4. **Specialized subsystems**: KMS audit logger (ClickHouse `kms_audit_log` table with 3-year retention), PII audit logger (Kafka -> ClickHouse `pii_audit_log`), connector audit (`connector_audit_log`), crawl audit (`crawl_audit_events` in ClickHouse), Arch AI audit (`arch_audit_log`), omnichannel audit (`omnichannel_audit_log`), tool execution audit (`ToolAuditLoggerImpl`), and the audit trail Mongoose plugin (`auditTrailPlugin`) that now requires a registered Kafka/ClickHouse handler instead of silently writing to Mongo.
5. **Consumer layer**: Studio audit API, Admin audit query API and CSV export, archive export flow, and contract/compatibility readers that safely decode both legacy and canonical rows.

---

## 2. Scope

### Goals

- Structured audit events with 14+ fields: id, tenantId, projectId, timestamp, eventType, actor, actorType, resourceType, resourceId, environment, action, oldValue/newValue, metadata, ipAddress, traceId
- 44 audit event types in the compiler's `AuditEventType` union covering agent lifecycle, sessions, contacts, workflows, tools, deployments, prompts, and security
- 94 audit action constants in Studio's `AuditActions` covering authentication, device auth, debug, projects, agents, credentials, model configs, service nodes, MFA, email auth, workspace, invitations, organizations, SSO, archives, Git, retention, GDPR, tools, and modules
- Shared audit codec with reader-first compatibility for legacy string-metadata, object-metadata, canonical V2, and plugin rows
- Shared audit stored in ClickHouse, with MongoDB retained only for legacy compatibility outside the active runtime/shared path
- Fire-and-forget semantics: audit writes never block or fail the calling request
- Automatic audit trail via Mongoose plugin (`auditTrailPlugin`) on sensitive collections using `AsyncLocalStorage` for actor context
- PII-specific audit log with 90-day TTL auto-expiry (GDPR compliance)
- KMS-specific audit log with 3-year retention (PCI DSS 3.6)
- Alert system for critical events (webhook + Slack integrations) with env-driven runtime wiring
- Admin dashboard with audit log viewer, filtering, and CSV export
- Metadata sanitization: sensitive fields (password, token, secret, etc.) are auto-redacted before logging
- Tenant-scoped archive export and canonical CSV serialization for compatibility-decoded audit rows

### Non-Goals (Out of Scope)

- Real-time audit streaming via WebSocket (events are batch-written to ClickHouse)
- Client-side audit event generation (all events are server-side)
- Audit log tamper-proofing via hash-chain or blockchain verification
- Cross-tenant audit queries outside the platform admin API
- A separate cross-user audit product beyond the existing Studio SecurityPage and Admin portal surfaces

---

## 3. User Stories

1. As a **compliance officer**, I want an immutable audit trail of all agent operations so that I can demonstrate SOC2 compliance during audits.
2. As a **security engineer**, I want alerts on critical events (escalation, permission denied, PII access) so that I can respond to security incidents quickly.
3. As a **platform admin**, I want to query audit logs by actor, action, resource, and time range so that I can investigate incidents using the admin dashboard.
4. As a **data protection officer**, I want PII access events tracked with auto-expiry so that I can audit data access while respecting GDPR retention limits.
5. As a **tenant admin**, I want to see who modified my agents, contacts, and workflows so that I can track accountability within my workspace.
6. As a **DevOps engineer**, I want KMS key operations audited with 3-year retention so that I meet PCI DSS key management requirements.
7. As a **developer**, I want audit events generated automatically via Mongoose plugin so that I don't need to manually add audit calls to every write operation.
8. As a **Studio user**, I want my authentication events (login, MFA, SSO) audited so that suspicious account activity can be detected and investigated.

---

## 4. Functional Requirements

1. **FR-1**: The system must log a structured audit event for every operation in the `AuditEventType` union (44 event types across 10 categories).
2. **FR-2**: Every audit event must include at minimum: id, tenantId, timestamp, eventType, actor, actorType, resourceType, resourceId, environment, and action.
3. **FR-3**: Audit writes must be fire-and-forget: errors are caught, logged (via `createLogger`), and never propagated to the caller. A fallback to `process.stderr.write()` is used if the primary logging also fails.
4. **FR-4**: The shared runtime audit path must support ClickHouse (default) and InMemory (dev/test) backends, selected via singleton initialization; MongoDB is no longer a shared runtime fallback.
5. **FR-5**: The audit store singleton must initialize in one of two explicit modes: strict Kafka -> ClickHouse pipeline (when ClickHouse is ready and `AUDIT_PIPELINE_ENABLED=true`) or InMemory (when ClickHouse is unavailable in dev/test contexts). Direct shared ClickHouse writes are not permitted.
6. **FR-6**: PII audit logs must materialize into a dedicated ClickHouse `pii_audit_log` table with deployment-env-specific retention, preserving the 90-day production policy.
7. **FR-7**: KMS audit events must be stored in a dedicated ClickHouse table (`kms_audit_log`) with 3-year retention enforced by ClickHouse TTL.
8. **FR-8**: The system must support querying by eventTypes, actor, resourceType, resourceId, and time range with offset/limit pagination.
9. **FR-9**: The system must support summary aggregation by event type, actor, and resource for dashboard views.
10. **FR-10**: Critical events must trigger alerts via webhook and/or Slack when alert configuration is provided.
11. **FR-11**: The Mongoose `auditTrailPlugin` must automatically record create, update, and delete operations on all enabled collections, capturing the actor via `AsyncLocalStorage`.
12. **FR-12**: Sensitive metadata fields (password, hash, token, secret, apikey, authorization, cookie, credential) must be redacted to `[REDACTED]` before being stored in audit logs.
13. **FR-13**: The admin audit dashboard must support filtering by actor, action, date range, and limit, with CSV export capability.
14. **FR-14**: Encrypted fields in audit diffs must be masked as `[ENCRYPTED]` rather than exposing ciphertext.
15. **FR-15**: The feature spec must include an audit event coverage matrix that enumerates every canonical audit catalog and calls out open-string event families separately from finite enums.
16. **FR-16**: Any change to a finite audit catalog (`AuditEventType`, `AuditActions`, `AUTH_PROFILE_AUDIT_EVENTS`, `ContactAuditAction`, crawl audit events, omnichannel audit events, or Arch AI audit categories) must update the matrix in this feature spec and, when coverage changes, the matching table in the testing guide.

### Audit Event Coverage Matrix

This matrix is the canonical feature-spec inventory of audit event families. Finite catalogs are listed exhaustively. Open-string catalogs, such as KMS and connector audit, list the current observed production/test values and must be treated as extensible unless the source type is later narrowed.

| Catalog / source of truth                                                                  | Event values                                                                                                                                                                                                                                                                     | Producer / storage path                                                                                        | Coverage expectation                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared `AuditEventType` - agent lifecycle (`packages/compiler/src/platform/core/types.ts`) | `agent.created`, `agent.updated`, `agent.promoted`, `agent.rolled_back`, `agent.deprecated`, `agent.version_created`, `agent.dsl_updated`                                                                                                                                        | Runtime helpers and `AuditStore` shared Kafka -> ClickHouse stream                                             | Every value has route/helper coverage or an explicit gap row in `docs/testing/audit-logging.md`.                                                                          |
| Shared `AuditEventType` - tools and runtime interventions                                  | `tool.executed`, `tool.created`, `tool.updated`, `tool.deleted`, `handoff.executed`, `escalation.triggered`, `human.intervention`, `human.completed`                                                                                                                             | Runtime tool audit logger and escalation/handoff/intervention handlers                                         | Routine session lifecycle, deployment cache/status, and local/test tool execution events are analytics/EventStore/trace signals and must not be duplicated as audit rows. |
| Shared `AuditEventType` - contacts and workflows                                           | `contact.created`, `contact.updated`, `contact.deleted`, `contact.linked`, `workflow.created`, `workflow.updated`, `workflow.archived`, `workflow.deleted`, `workflow.version_activated`, `workflow.version_deactivated`, `workflow.version_created`, `workflow.version_deleted` | Runtime contact/workflow helpers and contact DDD audit adapter                                                 | Tenant/project/user isolation must be verified through public route tests where HTTP surfaces exist.                                                                      |
| Shared `AuditEventType` - session mutation, test context, security, prompts                | `session.modified`, `session.context_injected`, `session.tool_mock_set`, `session.test_created`, `pii.accessed`, `permission.denied`, `rate_limit.hit`, `prompt.created`, `prompt.version_created`, `prompt.version_promoted`, `prompt.version_archived`                         | Runtime session mutation/test-context handlers, PII logger, permission/rate-limit paths, prompt-library routes | Prompt test runs are execution telemetry; only prompt creation/version lifecycle is audit-worthy.                                                                         |

Routine lifecycle/read telemetry such as `session.started`, `session.ended`, `session.accessed`, and `trace.queried` is intentionally excluded from new audit writes. Those signals remain available through EventStore, traces, analytics, or legacy audit-row decoding where historical data exists.
| Studio `AuditActions` - auth, device auth, debug (`apps/studio/src/services/audit-service.ts`) | `login`, `logout`, `login_failed`, `account_locked`, `token_refresh`, `token_revoked`, `all_tokens_revoked`, `device_auth_started`, `device_auth_approved`, `device_auth_denied`, `device_auth_completed`, `debug_token_created`, `debug_token_revoked`, `debug_subscribed`, `debug_access_denied`, `debug_tool_executed` | Studio `logAuditEvent()` -> shared audit pipeline | Auth and device/debug actions require actor, IP, user agent, tenant, and failure-path coverage. |
| Studio `AuditActions` - project, agent, credentials, model config, service nodes | `project_created`, `project_updated`, `project_deleted`, `project_archived`, `project_restored`, `project_member_added`, `project_member_removed`, `project_member_role_changed`, `agent_added`, `agent_removed`, `credential_created`, `credential_updated`, `credential_deleted`, `model_config_created`, `model_config_updated`, `model_config_deleted`, `service_node_created`, `service_node_updated`, `service_node_deleted` | Studio route handlers and services -> shared audit pipeline | Mutating project-scoped routes must prove `tenantId` and `projectId` are present in the emitted row. |
| Studio `AuditActions` - MFA, email auth, workspace, members, invitations, orgs, SSO | `mfa_setup_confirmed`, `mfa_verified`, `mfa_failed`, `mfa_locked`, `mfa_disabled`, `recovery_code_used`, `signup`, `email_verified`, `password_reset_requested`, `password_reset_completed`, `workspace_created`, `workspace_archived`, `workspace_restored`, `member_role_changed`, `member_removed`, `member_deactivated`, `member_locked`, `member_reactivated`, `member_suspended`, `member_unlocked`, `sessions_revoked`, `invitation_sent`, `invitation_accepted`, `invitation_revoked`, `invitation_resent`, `organization_created`, `workspace_linked_to_org`, `sso_login`, `sso_login_failed`, `sso_config_created`, `sso_domain_verified`, `sso_assertion_replay_detected` | Studio auth, workspace, invitation, organization, MFA, SAML, and OIDC routes | Security-sensitive flows require success and failure rows, plus sanitized metadata checks. |
| Studio `AuditActions` - archives, Git, retention, GDPR, tools, modules | `archive_created`, `archive_downloaded`, `archive_deleted`, `audit_export_downloaded`, `git_integration_created`, `git_integration_updated`, `git_integration_deleted`, `git_pull_completed`, `git_push_completed`, `git_promotion_completed`, `git_webhook_accepted`, `retention_sweep_completed`, `retention_sweep_failed`, `gdpr_deletion_completed`, `gdpr_deletion_failed`, `gdpr_sla_escalated`, `tool_created`, `tool_updated`, `tool_deleted`, `module_enabled`, `module_disabled`, `module_published`, `module_promoted`, `module_imported`, `module_removed`, `module_release_archived`, `module_delete_blocked`, `module_upgraded` | Studio archive, audit export, Git, retention, project tool, and module routes/services | Data lifecycle, audit export, and Git events require explicit tenant scoping and non-leaky failure metadata. |
| Auth profile lifecycle (`packages/database/src/auth-profile/audit-events.ts`) | `AUTH_PROFILE_CREATED`, `AUTH_PROFILE_UPDATED`, `AUTH_PROFILE_DELETED`, `AUTH_PROFILE_REVOKED`, `AUTH_PROFILE_SECRET_ROTATED`, `AUTH_PROFILE_SECRETS_ROTATED`, `AUTH_PROFILE_OAUTH_COMPLETED`, `AUTH_PROFILE_OAUTH_FAILED`, `AUTH_PROFILE_OAUTH_REVOKED`, `AUTH_PROFILE_CONSUMER_LINKED`, `AUTH_PROFILE_CONSUMER_UNLINKED`, `AUTH_PROFILE_ACCESS_DENIED`, `AUTH_PROFILE_DECRYPTION_FAILED`, `AUTH_PROFILE_ADMIN_VIEWED`, `AUTH_PROFILE_SECRETS_ACCESSED`, `AUTH_PROFILE_STATUS_CHANGED` | Auth-profile services, audit trail plugin, and OAuth callback flows | Validation checks, scheduled token refresh, and OAuth initiation are operational unless they fail or expose/modify sensitive state. |
| Contact DDD lifecycle (`apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`) | `contact.created`, `contact.resolved`, `contact.merged`, `contact.self_merged`, `contact.identity_added`, `contact.session_linked`, `contact.gdpr_erased` | Contact use-case `ContactAuditEmitter` -> runtime shared audit helper | DDD use cases must prove audit failure never blocks contact mutation. |
| Crawl audit (`packages/database/src/types/crawl-audit-event.ts`) | `crawl.started`, `crawl.paused`, `crawl.resumed`, `crawl.completed`, `crawl.failed`, `crawl.cancelled`, `crawl.strategy_changed`, `crawl.retry`, `strategy.selected`, `strategy.auto_applied`, `strategy.user_overridden` | SearchAI crawl audit service -> `abl.audit.crawl.v1` / ClickHouse crawl audit table | Crawl audit is operational history; deletion/retention policy must stay explicit. |
| Omnichannel audit (`apps/runtime/src/services/omnichannel/types.ts`) | `omnichannel_recall_requested`, `omnichannel_recall_returned`, `session_linked_to_contact`, `identity_verified`, `live_session_discovered`, `live_session_joined`, `transcript_item_persisted`, `typed_input_interrupted_tts`, `live_session_detached`, `consent_granted`, `consent_revoked` | Runtime omnichannel audit -> `abl.audit.omnichannel.v1` / ClickHouse plus bounded in-memory fallback | Classified as operational-only unless product explicitly promotes it to compliance-grade audit. |
| Arch AI audit categories (`packages/arch-ai/src/audit/types.ts`) | Generated event types are `arch.llm_call`, `arch.tool_execution`, `arch.phase_transition`, `arch.user_action`, `arch.build_event`, `arch.error`, `arch.system_event` | Studio Arch AI audit writer -> `abl.audit.arch.v1` / ClickHouse Arch audit reader | Project-scoped Arch audit reads require RBAC and tenant/project filtering. |
| KMS audit operations (`apps/runtime/src/services/kms/kms-audit-logger.ts`) | Open-string operation catalog. Current observed values: `encrypt`, `decrypt`, `rotate`, `config_update`, `tenant_environment_config_update`, `tenant_environment_config_delete`, `external_kms_validation`, `force_rotate`, `project_config_update`, `project_config_delete`, `environment_config_update`, `environment_config_delete`, `batch_reencryption`, `dek_expiry_transition`, `dek_usage_transition`, `dek_destruction` | Runtime KMS audit logger -> `abl.audit.kms.v1` / `kms_audit_log` ClickHouse table | KMS rows require 3-year retention and fallback logging when the audit backend is unavailable. |
| PII audit (`packages/compiler/src/platform/security/pii-audit.ts`) | Open-string `action` plus typed context fields: `tenantId`, `projectId`, `sessionId`, `tokenId`, `piiType`, `consumer` | Runtime PII audit logger -> `abl.audit.pii.v1` / `pii_audit_log` | PII rows require deployment-env-specific retention and buffered shutdown durability. |
| Connector audit (`packages/database/src/types/connector-audit-entry.ts`, `apps/search-ai/src/services/connector-audit.service.ts`) | Open-string event catalog. Current observed values: `sync.started`, `sync.completed`, `sync.failed`, `security.emergency_revoke`, `notification.updated`, `notification.webhook_tested`, `proposal.approved`, `proposal.abandoned`, `permissions.disabled`, `content.purge_initiated`, `config.reapply_template`, `config.update_template`, `config.import`, `mapping.update`, `mapping.batch_confirm`, `mapping.batch_needs_review`, `mapping.confirm`, `mapping.reject`, `mapping.manual_create` | SearchAI connector audit service -> `abl.audit.connector.v1` / connector audit storage | Connector route and worker coverage must distinguish durable connector audit from ordinary app logging. Webhook batch queue receipts are queue telemetry, not audit evidence. |
| Mongoose audit trail plugin (`packages/database/src/mongo/plugins/audit-trail.plugin.ts`) | Dynamic event type shape: `<collectionName>.create`, `<collectionName>.update`, `<collectionName>.delete`; action values are `create`, `update`, `delete` | Database audit handler registered by runtime/SearchAI -> shared audit pipeline | Any collection using the plugin must document whether actor context is available and whether encrypted fields are masked. |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Agent version and DSL update events audited                |
| Agent lifecycle            | PRIMARY      | All lifecycle events: create, promote, rollback, deprecate |
| Customer experience        | NONE         | Transparent to end users                                   |
| Integrations / channels    | SECONDARY    | Channel configuration events audited                       |
| Observability / tracing    | PRIMARY      | Core observability and compliance feature                  |
| Governance / controls      | PRIMARY      | SOC2, HIPAA, PCI DSS compliance requirement                |
| Enterprise / compliance    | PRIMARY      | Immutable audit trail for enterprise customers             |
| Admin / operator workflows | PRIMARY      | Admin audit dashboard API and UI with CSV export           |

### Related Feature Integration Matrix

| Related Feature       | Relationship Type | Why It Matters                                    | Key Touchpoints                        | Current State |
| --------------------- | ----------------- | ------------------------------------------------- | -------------------------------------- | ------------- |
| Encryption at Rest    | depends on        | Audit event metadata encrypted in ClickHouse      | `audit_events._enc` column             | STABLE        |
| Session Management    | emits into        | Session lifecycle events audited                  | `audit-helpers.ts`                     | STABLE        |
| Contact Management    | emits into        | Contact CRUD events audited                       | `audit-helpers.ts`, `contact-audit.ts` | STABLE        |
| Workflows             | emits into        | Workflow lifecycle events audited                 | `audit-helpers.ts`                     | STABLE        |
| Identity Verification | emits into        | PII access events tracked                         | `pii-audit-log.model.ts`               | BETA          |
| KMS/Key Management    | emits into        | Key operations audited (3yr retention)            | `kms-audit-logger.ts`                  | STABLE        |
| Tool Execution        | emits into        | Tool calls audited with latency/errors            | `tool-audit-logger.ts`                 | STABLE        |
| Web Crawling          | emits into        | Crawl lifecycle events audited                    | `crawl-audit-event.model.ts`           | STABLE        |
| SSO/Enterprise Auth   | emits into        | SSO login, assertion replay detected              | `AuditActions.SSO_*`                   | STABLE        |
| MFA                   | emits into        | MFA setup, verify, fail, lock, disable events     | `AuditActions.MFA_*`                   | STABLE        |
| Auth Profiles         | emits into        | 13 lifecycle events (create, rotate, revoke, etc) | `AUTH_PROFILE_AUDIT_EVENTS`            | STABLE        |
| Archives / Retention  | shares data with  | Audit logs can be exported as archives            | `audit-export/route.ts`                | BETA          |
| GDPR / Data Deletion  | emits into        | GDPR sweep events logged                          | `AuditActions.GDPR_*`                  | STABLE        |

---

## 6. Design Considerations (Optional)

The admin audit dashboard (`apps/admin/src/app/(dashboard)/audit/page.tsx`) provides:

- Table view with columns: Timestamp, Actor, Action, Target, IP Address
- Filters: actor (text input with debounce), action (select dropdown), date range (from/to date pickers)
- CSV export of visible audit entries plus a dedicated export route
- Pagination via "Load more" button

Studio also exposes a personal/workspace audit viewer in `apps/studio/src/components/admin/SecurityPage.tsx`:

- Audit tab inside Security settings
- User-scoped audit query backed by `GET /api/audit`
- Filters for action, date range, and pagination
- Compatibility-safe rendering of legacy and canonical shared audit rows

---

## 7. Technical Considerations (Optional)

- **Fire-and-forget pattern**: All audit writes are wrapped in try-catch. The `writeAuditLog()` internal helper, specialized Kafka publishers, and `RuntimePIIAuditStore.insert()` all swallow exceptions with warning-level logging.
- **Shared runtime strategy**: The shared runtime path uses a strict Kafka -> ClickHouse pipeline whenever ClickHouse is available. If `AUDIT_PIPELINE_ENABLED` is missing in a ClickHouse-ready environment, startup fails closed instead of silently downgrading. Only ClickHouse-unavailable dev/test contexts use InMemory.
- **Runtime environment resolution**: Shared runtime writers resolve `environment` from `DEPLOYMENT_ENVIRONMENT`, `RUNTIME_ENV`, `APP_ENV`, then `NODE_ENV` instead of hardcoding `'dev'`.
- **Metadata encryption**: ClickHouse audit event fields (`metadata`, `old_value`, `new_value`) are encrypted at rest via the field-interceptor encryption manifest (column `_enc`).
- **PII audit TTL**: 90-day production retention enforced by ClickHouse DDL on `abl_platform.pii_audit_log`, with deployment-environment overrides available for non-production.
- **KMS audit retention**: 3-year retention enforced by ClickHouse table TTL (PCI DSS 3.6 requirement). Warm tier after 1 year, DELETE after 3 years.
- **AsyncLocalStorage for actor context**: The `auditTrailPlugin` uses `AsyncLocalStorage<AuditActorContext>` to propagate userId, email, and IP through the call stack without explicit parameter passing.
- **Ciphertext masking in diffs**: The `getModifiedFields()` function in the audit trail plugin reads `fieldsToEncrypt` metadata from the schema and replaces their values with `[ENCRYPTED]` in audit diffs.
- **Studio metadata sanitization**: The `sanitizeAuditMetadata()` function matches keys against `SENSITIVE_PATTERNS` and replaces values with `[REDACTED]`.
- **Studio IP normalization**: Studio audit writes normalize forwarded chains through `getClientIp()` / `normalizeForwardedIp()`, using the same trusted-rightmost proxy convention as the broader Studio auth and rate-limit path.

---

## 8. How to Consume

### Studio UI

Security settings expose an audit tab backed by `apps/studio/src/components/admin/SecurityPage.tsx`. Audit events from Studio operations (SSO config, credential management, project CRUD, workspace lifecycle, MFA) are logged server-side via `logAuditEvent()` from `apps/studio/src/services/audit-service.ts`.

Studio API route: `GET /api/audit` returns user-scoped audit logs (filtered by `userId`) with pagination.

### API (Runtime)

Audit events are written automatically by route handlers and service methods. No direct audit REST API is exposed to tenants from the runtime.

Internal audit write API (not HTTP-exposed):

- `getAuditStore().log(params)` -- structured audit event via singleton
- `auditSessionCreated()`, `auditContactUpdated()`, etc. -- domain helpers
- `logKMSAuditEvent()` -- KMS-specific ClickHouse writes
- `getPIIAuditLogger().log()` -- PII access audit writes

### API (Studio)

| Method | Path         | Purpose                                        |
| ------ | ------------ | ---------------------------------------------- |
| GET    | `/api/audit` | User-scoped audit logs with filters/pagination |

Query parameters: `action`, `from`, `to`, `limit`, `offset`

### Admin Portal

| Method | Path                | Purpose                                        |
| ------ | ------------------- | ---------------------------------------------- |
| GET    | `/api/audit`        | Query audit logs with filters (admin only)     |
| GET    | `/api/audit/export` | Export filtered audit logs as CSV (admin only) |

Query parameters: `actor`, `action`, `from`, `to`, `limit`

Admin UI page: `/audit` -- table view with filtering, pagination, CSV export.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. All audit events are generated server-side regardless of channel.

---

## 9. Data Model

### MongoDB: audit_logs Collection

```text
Collection: audit_logs
Fields:
  - _id: string (UUIDv7)
  - userId: string | null (actor)
  - tenantId: string | null
  - action: string (audit event type / action label)
  - ip: string | null (actor IP)
  - userAgent: string | null
  - metadata: Mixed (legacy string/object metadata or canonical compatibility metadata)
  - eventType: string | null
  - actorType: string | null
  - projectId: string | null
  - resourceType: string | null
  - resourceId: string | null
  - environment: string | null
  - traceId: string | null
  - source: string | null
  - schemaVersion: number | null
  - metadataEncoding: 'object' | 'json-string' | null
  - retentionClass: 'default' | 'auth' | 'crud' | 'indefinite' | null
  - expiresAt: Date | null
  - _v: number (schema version, default 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1, createdAt: -1 }
  - { userId: 1 }
  - { action: 1 }
  - { createdAt: -1 }
  - { tenantId: 1, action: 1, createdAt: -1 }
  - { tenantId: 1, eventType: 1, createdAt: -1 }
  - { tenantId: 1, resourceType: 1, resourceId: 1, createdAt: -1 } (sparse)
  - { tenantId: 1, projectId: 1, createdAt: -1 } (sparse)
  - { traceId: 1, createdAt: -1 } (sparse)
  - { schemaVersion: 1, source: 1, createdAt: -1 } (sparse)
  - { tenantId: 1, 'metadata.resourceType': 1, 'metadata.resourceId': 1 } (sparse, legacy compatibility)
  - { expiresAt: 1 } (sparse TTL index, disabled by default until policy rollout)
Note: NOT tenant-scoped (allows cross-tenant admin queries). Registered in ModelRegistry as 'platform' database.
```

### ClickHouse: abl_platform.audit_events Table

```text
Table: abl_platform.audit_events
Engine: ReplicatedMergeTree
Partition: toYYYYMM(timestamp)
Order: (tenant_id, timestamp, action)
Columns:
  - tenant_id: String (ZSTD)
  - timestamp: DateTime (Delta + ZSTD)
  - action: LowCardinality(String)
  - event_id: String (NONE -- UUID)
  - actor_id, actor_type, actor_ip, actor_user_agent: String
  - resource_type: LowCardinality(String), resource_id: String
  - session_id, project_id: String
  - old_value, new_value: String (ZSTD3, encrypted via field-interceptor)
  - metadata: String (ZSTD3, encrypted)
  - success: UInt8, failure_reason: String
  - _enc: String (encryption manifest)
Indexes: idx_action (set), idx_actor (bloom), idx_session (bloom), idx_resource (set)
TTL: 90 days to cold volume, 730 days DELETE
```

### ClickHouse: abl_platform.pii_audit_log Table

```text
Table: abl_platform.pii_audit_log
Engine: ReplicatedMergeTree
Partition: toYYYYMM(timestamp)
Order: (tenant_id, timestamp, action)
Columns:
  - tenant_id, project_id, timestamp, event_id
  - action, actor_id, actor_type
  - token_id, pii_type, session_id
  - metadata (JSON string)
  - expires_at
TTL: deployment-env-specific DDL; production default preserves 90-day retention
```

### ClickHouse: abl_platform.kms_audit_log Table

```text
Table: abl_platform.kms_audit_log
Engine: ReplicatedMergeTree
Partition: toYYYYMM(timestamp)
Order: (tenant_id, timestamp, operation)
Columns:
  - tenant_id, timestamp (DateTime64(3)), event_id
  - operation (LowCardinality), key_id, key_version (UInt32), key_purpose (LowCardinality)
  - provider_type (LowCardinality), project_id, environment, epoch
  - actor_id, actor_type, actor_ip
  - success (UInt8), error_message, latency_ms (UInt32)
  - metadata (JSON string)
Indexes: idx_operation (set), idx_key_id (bloom), idx_actor (bloom), idx_success (set)
TTL: 1 year to warm, 3 years DELETE
```

### ClickHouse: abl_platform.crawl_audit_events Table

```text
Table: abl_platform.crawl_audit_events
Engine: ReplicatedMergeTree
Partition: toYYYYMM(timestamp)
Order: (tenant_id, crawl_job_id, timestamp)
Columns:
  - tenant_id, timestamp, event_id
  - crawl_job_id, user_id, event_type
  - description, changes_before, changes_after
  - context, severity, metadata
Retention: deployment-env-specific DDL
```

### Key Relationships

- `audit_logs.userId` -> User who performed the action
- `audit_logs.tenantId` -> Tenant scope for the action
- `audit_logs.resourceId` -> The resource (agent, session, contact, etc.) affected
- `audit_logs.source` + `schemaVersion` -> Shared envelope lineage and compatibility classification
- `pii_audit_log.session_id` -> Session in which PII was accessed
- `pii_audit_log.token_id` -> PII vault token that was accessed
- `kms_audit_log.key_id` -> KMS key that was operated on
- `crawl_audit_events.crawl_job_id` -> Crawl job associated with the event
- Audit trail plugin records link back to the source collection via `collectionName` + `documentId`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                      | Purpose                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/compiler/src/platform/stores/audit-store.ts`                    | Abstract `AuditStore` base class, `LogAuditParams`, `QueryAuditParams`, `AuditSummary`, `AlertConfig`, `InMemoryAuditStore`, factory |
| `packages/compiler/src/platform/core/types.ts`                            | `AuditEventType` union (44 types), `AuditLog` interface (14+ fields)                                                                 |
| `packages/compiler/src/platform/stores/shared-audit-codec.ts`             | Canonical shared audit envelope, retention defaults, compatibility decode/encode helpers                                             |
| `packages/compiler/src/platform/constructs/executors/audit-middleware.ts` | Tool call audit middleware with SHA-256 input hashing, `ToolAuditEntry`, `ToolAuditLogger` interface                                 |

### Routes / Handlers

| File                                                     | Purpose                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/admin/src/app/api/audit/route.ts`                  | Admin audit query API (GET /api/audit)                         |
| `apps/admin/src/app/api/audit/export/route.ts`           | Admin audit CSV export API (GET /api/audit/export)             |
| `apps/admin/src/lib/audit-logger.ts`                     | Admin action logging + audit query helpers                     |
| `apps/admin/src/lib/with-admin-route.ts`                 | Admin route wrapper that now propagates audit actor context    |
| `apps/admin/src/app/(dashboard)/audit/page.tsx`          | Admin audit log viewer UI with filters, pagination, CSV export |
| `apps/studio/src/app/api/audit/route.ts`                 | Studio user-scoped audit query API                             |
| `apps/studio/src/app/api/archives/audit-export/route.ts` | Audit log archive export endpoint                              |
| `apps/studio/src/components/admin/SecurityPage.tsx`      | Studio security page with personal/workspace audit viewer      |
| `apps/studio/src/lib/get-client-ip.ts`                   | Studio forwarded-IP normalization used by audit and auth paths |
| `apps/studio/src/lib/route-handler.ts`                   | Studio route wrapper that now propagates audit actor context   |

### Stores

| File                                                             | Purpose                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/runtime/src/services/stores/clickhouse-audit-store.ts`     | ClickHouse backend: buffered writes, query, summary, trace lookup |
| `apps/runtime/src/services/audit-store-singleton.ts`             | Singleton with strict Kafka pipeline or InMemory fallback         |
| `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` | Runtime PII audit adapter that emits Kafka/ClickHouse events      |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts`     | PII audit logger singleton                                        |

### Audit Helpers & Loggers

| File                                                | Purpose                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/audit-helpers.ts`        | 20+ fire-and-forget domain helpers: contact, workflow, session, version, subscription, test context |
| `apps/runtime/src/services/audit-environment.ts`    | Runtime environment resolver for shared audit writers                                               |
| `apps/runtime/src/services/tool-audit-logger.ts`    | Tool execution audit logger routed through the shared `AuditStore`                                  |
| `apps/runtime/src/services/kms/kms-audit-logger.ts` | KMS operation audit to ClickHouse `kms_audit_log` table                                             |
| `apps/studio/src/services/audit-service.ts`         | Studio audit service with 50+ action constants, metadata sanitization, fallback to stderr           |
| `apps/studio/src/repos/archive-repo.ts`             | Studio archive manifest repository                                                                  |

### Models & Plugins

| File                                                        | Purpose                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/database/src/models/audit-log.model.ts`           | MongoDB `audit_logs` collection schema                          |
| `packages/database/src/models/pii-audit-log.model.ts`       | Historical PII Mongo model retained for compatibility/tests     |
| `packages/database/src/models/crawl-audit-event.model.ts`   | Historical crawl audit model retained for compatibility/tests   |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts` | Auto-audit Mongoose plugin with AsyncLocalStorage actor context |
| `packages/database/src/auth-profile/audit-events.ts`        | 13 auth profile audit event constants                           |

### UI Components

| File                                            | Purpose                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `apps/admin/src/app/(dashboard)/audit/page.tsx` | Admin audit log viewer with table, filters, CSV export |

### Jobs / Workers / Background Processes

| File                                                             | Purpose                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/runtime/src/services/stores/clickhouse-audit-store.ts`     | ClickHouse `BufferedClickHouseWriter` (10K rows / 5s flush interval) |
| `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` | PII audit adapter that emits Kafka/ClickHouse `pii` stream           |

### Tests

| File                                                                     | Type | Coverage Focus                              |
| ------------------------------------------------------------------------ | ---- | ------------------------------------------- |
| `apps/runtime/src/services/kms/__tests__/kms-audit-logger.test.ts`       | unit | KMS audit event logging to ClickHouse       |
| `apps/runtime/src/__tests__/tool-audit-logger.test.ts`                   | unit | Tool audit logger implementations           |
| `apps/runtime/src/__tests__/audit-store-singleton.test.ts`               | unit | Singleton backend selection                 |
| Various `*-authz.test.ts` files                                          | unit | Verify audit helper calls in route handlers |
| `packages/database/src/__tests__/audit-trail-ciphertext-masking.test.ts` | unit | Ciphertext masking in audit diffs           |
| `packages/database/src/__tests__/auth-profile-audit-events.test.ts`      | unit | Auth profile audit event constants          |

---

## 11. Configuration

### Environment Variables

| Variable                                                          | Default | Description                                                   |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| `AUDIT_LOG_ALERTS_ENABLED`                                        | `false` | Enable critical-event alert dispatch at runtime startup       |
| `AUDIT_LOG_ALERT_WEBHOOK_URL`                                     | -       | Webhook target for critical-event alerts                      |
| `AUDIT_LOG_ALERT_SLACK_WEBHOOK`                                   | -       | Slack webhook target for critical-event alerts                |
| `AUDIT_LOG_ALERT_CRITICAL_EVENTS`                                 | -       | Comma-separated event types that should trigger alerts        |
| `AUDIT_LOG_TTL_ENABLED`                                           | `false` | Enable shared-path TTL calculation for canonical audit rows   |
| `AUDIT_LOG_DEFAULT_TTL_DAYS`                                      | `180`   | Default shared TTL window when TTL is enabled                 |
| `AUDIT_LOG_AUTH_TTL_DAYS`                                         | `90`    | Auth retention class TTL when shared TTL is enabled           |
| `AUDIT_LOG_CRUD_TTL_DAYS`                                         | `365`   | CRUD retention class TTL when shared TTL is enabled           |
| `AUDIT_LOG_TTL_INDEX_ENABLED`                                     | `false` | Create the sparse MongoDB TTL index on `audit_logs.expiresAt` |
| `AUDIT_AUTH_BUFFER_FLUSH_INTERVAL_MS`                             | `250`   | Shared runtime auth-audit buffer flush cadence                |
| `AUDIT_AUTH_BUFFER_MAX_BATCH_SIZE`                                | `100`   | Shared runtime auth-audit flush batch size                    |
| `AUDIT_AUTH_BUFFER_MAX_BUFFER_SIZE`                               | `5000`  | Shared runtime auth-audit in-memory queue limit               |
| `AUDIT_AUTH_BUFFER_DROP_OLDEST_ON_OVERFLOW`                       | `true`  | Auth-audit overflow policy                                    |
| `DEPLOYMENT_ENVIRONMENT` / `RUNTIME_ENV` / `APP_ENV` / `NODE_ENV` | varies  | Runtime audit environment resolver precedence                 |

### Runtime Configuration

- `AuditStoreConfig.type`: `'clickhouse'` | `'mongodb'` | `'memory'` -- retained in the base contract, though the active shared runtime path now uses strict pipeline or InMemory only
- `AlertConfig.enabled`: Enable/disable alert dispatch on critical events
- `AlertConfig.webhookUrl`: Webhook URL for critical event alerts
- `AlertConfig.slackWebhook`: Slack webhook URL for critical event alerts
- `AlertConfig.criticalEvents`: List of `AuditEventType` values that trigger alerts
- PII audit retention: deployment-env-specific ClickHouse TTL on `abl_platform.pii_audit_log` (production default preserves 90 days)
- KMS audit retention: 3 years (ClickHouse table TTL in `clickhouse-schemas/init.ts`)
- ClickHouse query timeout: 15 seconds (`max_execution_time = 15` in all CH queries)

### DSL / Agent IR / Schema

N/A -- Audit logging is not configurable via DSL or IR. Configuration is infrastructure-level.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | ClickHouse queries always include `tenant_id` filter. MongoDB `audit_logs` remains indexed by `tenantId` for legacy/plugin compatibility rows. Specialized ClickHouse streams remain tenant-scoped. |
| Project isolation | `projectId` stored in audit events when available. Not enforced as query filter (audit is tenant-scoped).                                                                                           |
| User isolation    | Studio audit API filters by `userId`. Admin API allows cross-user queries within a tenant for investigation.                                                                                        |

### Security & Compliance

- **Append-only**: No update or delete operations on audit records
- **Metadata encryption**: ClickHouse audit event fields (`metadata`, `old_value`, `new_value`) encrypted at rest via field-interceptor manifest
- **Ciphertext masking**: Audit trail plugin masks encrypted field values as `[ENCRYPTED]` in diffs
- **Sensitive metadata redaction**: Studio service redacts keys matching `SENSITIVE_PATTERNS` (password, token, secret, etc.) to `[REDACTED]`
- **PII auto-expiry**: production 90-day ClickHouse retention on `pii_audit_log` (GDPR right to erasure compliance)
- **KMS 3-year retention**: PCI DSS 3.6 compliance for key management audit trails
- **Admin API auth**: Protected by `requireRole(auth, 'VIEWER')` in admin and `requireAuth()` in Studio
- **Tool endpoint redaction**: `redactEndpoint()` strips sensitive URL components before audit storage
- **IP address handling**: Studio shared audit writes normalize forwarded IP chains with the same trusted-rightmost convention used by Studio request handling

### Performance & Scalability

- ClickHouse `BufferedClickHouseWriter`: batches up to 10K rows with 5-second flush interval
- Fire-and-forget: audit writes are async, never block the request path
- MongoDB indexes: 6 indexes on `audit_logs` for efficient querying by tenant, user, action, time, and resource
- ClickHouse `max_execution_time = 15` prevents runaway analytical queries
- ClickHouse storage: ZSTD compression on all columns, LowCardinality on enum-like fields

### Reliability & Failure Modes

- **Singleton mode selection**: `AUDIT_PIPELINE_ENABLED=true` requires ClickHouse readiness and disables shared fallback. If ClickHouse is available without pipeline mode, startup fails closed; otherwise the shared runtime path uses InMemory only in ClickHouse-unavailable dev/test contexts.
- **KMS audit fallback**: ClickHouse unavailable -> structured log output with `_audit: true` flag for log aggregator pickup
- **PII audit**: fire-and-forget with `log.warn()` on failure
- **Studio audit**: fallback to `process.stderr.write()` with `type: 'audit_fallback'` for structured log aggregation when primary logging fails
- **All helpers**: wrapped in try-catch; errors logged but never propagated

### Observability

- Logger namespaces: `audit-helpers`, `audit-store-singleton`, `tool-audit-logger`, `kms-audit`, `pii-audit-store`
- `[Audit]` console prefix for admin action logging
- `_audit: true` flag on KMS fallback log entries for structured log aggregation
- Alert system dispatches to webhook and Slack on critical audit event types

### Data Lifecycle

- `audit_logs` (MongoDB): No TTL -- retained indefinitely for compliance
- `pii_audit_log` (ClickHouse): deployment-env-specific TTL; production default preserves 90-day retention
- `audit_events` (ClickHouse): 90 days to cold storage volume, 730-day DELETE TTL
- `kms_audit_log` (ClickHouse): 1 year warm, 3 years DELETE
- `crawl_audit_events` (ClickHouse): operational-history classification with deployment-env-specific retention
- Archive export: `POST /api/archives/audit-export` creates archive manifests for audit log export

---

## 13. Delivery Plan / Work Breakdown

Feature is fully implemented. Implementation phases were:

1. Core AuditStore abstraction
   1.1 Abstract base class with `log()`, `query()`, `getSummary()`, `getByTraceId()`
   1.2 InMemoryAuditStore for testing
   1.3 Alert system (webhook + Slack)
2. Type definitions
   2.1 `AuditEventType` union (44 types)
   2.2 `AuditLog` interface (14+ fields)
   2.3 `LogAuditParams`, `QueryAuditParams`, `AuditSummary` interfaces
3. Storage backends
   3.1 ClickHouseAuditStore with BufferedWriter
   3.2 Audit store singleton with strict pipeline mode and backend selection
   3.3 In-memory shared audit backend for test-only pipeline E2E coverage
4. Mongoose audit trail plugin
   4.1 Auto-audit on save, findOneAndUpdate, findOneAndDelete
   4.2 AsyncLocalStorage for actor context propagation
   4.3 Ciphertext masking for encrypted fields
5. Domain helpers (Runtime)
   5.1 Contact audit helpers (created, updated, deleted, linked)
   5.2 Workflow audit helpers (created, updated, archived)
   5.3 Session audit helpers (created, ended, accessed, modified, test context)
   5.4 Version audit helpers (created, promoted, deprecated, DSL updated)
   5.5 Subscription audit helpers (created, updated, deleted)
6. Studio audit service
   6.1 50+ `AuditActions` constants covering auth, projects, agents, credentials, MFA, SSO, GDPR
   6.2 Metadata sanitization (`sanitizeAuditMetadata`)
   6.3 User-scoped audit query API
7. Specialized audit subsystems
   7.1 Tool execution audit logger (`ToolAuditLoggerImpl`)
   7.2 KMS operation audit logger (ClickHouse direct writes)
   7.3 PII access audit logger (Kafka -> ClickHouse with 90-day production retention)
   7.4 Crawl audit events
   7.5 Auth profile audit events (13 event types)
8. Contact context audit
   8.1 `ContactAuditEmitter` port pattern for DDD audit integration
   8.2 7 contact audit action types
9. Admin API and UI
   9.1 GET /api/audit with filters (admin portal)
   9.2 Admin action logging
   9.3 Admin audit page with table, filters, CSV export

---

## 14. Success Metrics

| Metric                | Baseline      | Target                                 | How Measured                                             |
| --------------------- | ------------- | -------------------------------------- | -------------------------------------------------------- |
| Audit event coverage  | 0 event types | 36+ compiler types, 50+ Studio actions | AuditEventType union count + AuditActions constant count |
| Audit write latency   | N/A           | < 5ms (fire-and-forget)                | No blocking impact on request latency                    |
| KMS audit retention   | N/A           | 3 years                                | ClickHouse table TTL verification                        |
| PII audit auto-expiry | N/A           | 90 days                                | ClickHouse DDL retention verification                    |
| Audit never blocks    | N/A           | 0 request failures from audit errors   | Error monitoring for audit-related exceptions            |

---

## 15. Open Questions

1. Should audit event tamper-proofing (hash chain) be added for SOC2 Level II?
2. Should a unified runtime audit API be added beyond the existing Studio and Admin surfaces?

---

## 16. Gaps, Known Issues & Limitations

No active implementation blockers remain in the current hardening scope. Historical hardening gaps now sit in one of three states: resolved, mitigated by explicit product classification, or deferred as future enhancements rather than blockers.

| ID      | Description                                              | Severity | Status    |
| ------- | -------------------------------------------------------- | -------- | --------- |
| GAP-001 | ClickHouseAuditStore writer logging alignment            | Low      | Resolved  |
| GAP-002 | Admin audit metadata canonicalization                    | Low      | Resolved  |
| GAP-003 | Dedicated HTTP audit E2E coverage                        | High     | Resolved  |
| GAP-004 | Alert dispatch coverage                                  | Medium   | Resolved  |
| GAP-005 | ClickHouse tenant-safe query behavior                    | Medium   | Resolved  |
| GAP-006 | Runtime `environment` hardcoding in shared audit helpers | Medium   | Resolved  |
| GAP-007 | Studio shared audit IP normalization                     | Medium   | Resolved  |
| GAP-008 | Crawl audit retention/classification ambiguity           | Low      | Mitigated |
| GAP-009 | Tenant-facing Studio audit viewer                        | Medium   | Resolved  |
| GAP-010 | Admin structured logging cleanup                         | Low      | Resolved  |
| GAP-011 | ClickHouse `audit_events` delete TTL                     | Medium   | Resolved  |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                          | Coverage Type | Status | Test File / Note                                              |
| --- | ------------------------------------------------- | ------------- | ------ | ------------------------------------------------------------- |
| 1   | KMS audit event write to ClickHouse               | unit          | PASS   | `kms-audit-logger.test.ts`                                    |
| 2   | KMS audit fallback to console on CH unavailable   | unit          | PASS   | `kms-audit-logger.test.ts`                                    |
| 3   | Audit helper calls verified in route tests        | unit          | PASS   | Various `*-authz.test.ts`                                     |
| 4   | Audit trail ciphertext masking                    | unit          | PASS   | `audit-trail-ciphertext-masking.test.ts`                      |
| 5   | Auth profile audit event constants                | unit          | PASS   | `auth-profile-audit-events.test.ts`                           |
| 6   | ClickHouseAuditStore query/summary                | unit          | PASS   | `clickhouse-audit-store.test.ts`                              |
| 7   | Audit store singleton backend selection behavior  | integration   | PASS   | `audit-store-singleton.test.ts`                               |
| 8   | In-memory shared audit backend for E2E harnesses  | unit          | PASS   | `in-memory-audit-test-backend.test.ts`                        |
| 9   | PII audit shutdown durability                     | integration   | PASS   | `pii-audit-shutdown.test.ts`                                  |
| 10  | Alert dispatch (webhook/Slack)                    | unit          | PASS   | `audit-store-alerting.test.ts`                                |
| 11  | Admin audit API compatibility                     | integration   | PASS   | `audit-route.test.ts`, `audit-page-export.test.ts`            |
| 12  | Full audit roundtrip contract coverage            | integration   | PASS   | `audit-contract.integration.test.ts`                          |
| 13  | Studio audit service metadata sanitization        | unit          | PASS   | `audit-service.test.ts`                                       |
| 14  | Tenant isolation in audit queries                 | integration   | PASS   | `audit-contract.integration.test.ts`, `audit-api.e2e.test.ts` |
| 15  | PII audit TTL auto-expiry                         | integration   | PASS   | `pii-audit-log.ttl.test.ts`                                   |
| 16  | Shared + KMS ClickHouse retention DDL             | unit          | PASS   | `clickhouse-audit-retention.test.ts`                          |
| 17  | Studio audit HTTP roundtrip and failure isolation | e2e           | PASS   | `apps/studio/src/__tests__/audit-api.e2e.test.ts`             |
| 18  | Admin audit HTTP filters and CSV export           | e2e           | PASS   | `apps/admin/src/__tests__/audit-api.e2e.test.ts`              |

### Testing Notes

Audit logging now has dedicated coverage across the shared codec, legacy Mongo compatibility, ClickHouse reader/writer behavior, singleton backend selection, plugin actor propagation, alert dispatch, retention gating, runtime environment resolution, Studio/Admin readers, real HTTP audit roundtrips, and shared-contract regression checks. No remaining implementation blocker is currently documented for the hardening scope on this branch.

> Full testing details: [../testing/audit-logging.md](../testing/audit-logging.md)

---

## 18. References

- AuditStore base class: `packages/compiler/src/platform/stores/audit-store.ts`
- Audit event types: `packages/compiler/src/platform/core/types.ts` (line 333)
- Audit trail plugin: `packages/database/src/mongo/plugins/audit-trail.plugin.ts`
- Studio audit service: `apps/studio/src/services/audit-service.ts`
- ClickHouse schema: `packages/database/src/clickhouse-schemas/init.ts`
- Encryption manifest: `packages/shared-encryption/src/encryption-manifest.ts` (audit_events table)
