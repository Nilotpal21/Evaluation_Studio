# Audit Log System Deep Dive

Date: 2026-04-23

Scope: source-level audit of how audit logs are written, stored, queried, retained, and exposed across the `abl-platform` monorepo.

## Executive Summary

The audit story in this repo is not one system. It is a family of audit subsystems with different schemas, storage engines, durability guarantees, retention policies, and read APIs.

The most important practical conclusion is this:

1. There is no single "audit log" source of truth today.
2. `audit_logs` in MongoDB still exists as a mixed legacy/plugin compatibility collection with incompatible document shapes.
3. The strongest audit paths are the shared Kafka -> ClickHouse lane plus the dedicated subsystems: KMS audit, connector audit, Arch AI audit, and PII audit.
4. The weakest paths are now mostly legacy/plugin `audit_logs` compatibility and any code that would register no handler for the Mongoose plugin.

If someone asks, "Where does this feature audit to?", the right answer is usually one of these:

- `audit_logs` in MongoDB
- `abl_platform.audit_events` in ClickHouse
- `abl_platform.pii_audit_log` in ClickHouse
- `abl_platform.kms_audit_log` in ClickHouse
- `abl_platform.arch_audit_log` in ClickHouse
- `abl_platform.connector_audit_log` in ClickHouse
- `abl_platform.crawl_audit_events` in ClickHouse
- `abl_platform.omnichannel_audit_log` in ClickHouse
- legacy compatibility rows in MongoDB `audit_logs`

## Core Mental Model

There are three broad categories of audit in this codebase:

1. Generic audit abstractions
   - Shared contracts and store interfaces intended to provide a reusable runtime audit model.
2. Legacy/shared compatibility sink usage
   - Legacy and plugin-style producers still write into the same MongoDB `audit_logs` collection, but not with a single normalized schema.
3. Dedicated audit subsystems
   - Security- or domain-specific stores such as KMS, PII, Arch AI, connector audit, crawl audit, and omnichannel audit.

The biggest source of confusion is that these categories overlap in naming, but they do not behave the same way.

## System Inventory

| Subsystem                             | Main write path                                                                                                                               | Storage                                                             | Retention                    | Read/export surface                                    | Current confidence                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ | --------------------------------- |
| Runtime generic `AuditStore`          | `apps/runtime/src/services/audit-store-singleton.ts`                                                                                          | Kafka -> ClickHouse pipeline or in-memory fallback                  | Depends on backend           | Generic store APIs exist, but bespoke routes dominate  | High for writes, medium for reads |
| Runtime helper events                 | `apps/runtime/src/services/audit-helpers.ts`                                                                                                  | Via `AuditStore` backend                                            | Depends on backend           | Mostly indirect                                        | Medium                            |
| Tool execution audit                  | `packages/compiler/src/platform/constructs/executors/audit-middleware.ts`, `apps/runtime/src/services/tool-audit-logger.ts`                   | Via `AuditStore` backend                                            | Depends on backend           | Mostly indirect                                        | Medium                            |
| Runtime OAuth and channel OAuth audit | `apps/runtime/src/repos/auth-repo.ts`                                                                                                         | Shared singleton path -> Kafka/ClickHouse or active runtime backend | Shared backend policy        | Read through shared ClickHouse readers or generic APIs | Medium to high                    |
| Studio generic audit                  | `apps/studio/src/services/audit-service.ts`                                                                                                   | Shared Kafka -> ClickHouse pipeline / ClickHouse reader             | Shared ClickHouse TTL policy | `apps/studio/src/app/api/audit/route.ts`               | Medium                            |
| Admin generic audit                   | `apps/admin/src/lib/audit-logger.ts`                                                                                                          | Shared Kafka -> ClickHouse pipeline / ClickHouse reader             | Shared ClickHouse TTL policy | `apps/admin/src/app/api/audit/route.ts`, admin UI page | Medium                            |
| SearchAI generic audit                | `apps/search-ai/src/services/audit-helpers.ts`, `apps/search-ai/src/services/audit-logger.ts`, `apps/search-ai/src/routes/knowledge-bases.ts` | Shared Kafka -> ClickHouse `audit_events`                           | Shared ClickHouse TTL policy | KB activity feed plus service-level ClickHouse readers | Medium                            |
| Mongoose audit plugin                 | `packages/database/src/mongo/plugins/audit-trail.plugin.ts`                                                                                   | Mongo `audit_logs`                                                  | No TTL found                 | No dedicated API                                       | Low to medium                     |
| Connector audit                       | `apps/search-ai/src/services/connector-audit.service.ts`                                                                                      | Kafka -> ClickHouse `connector_audit_log`                           | Deployment-env-specific DDL  | Dedicated route and export                             | High                              |
| Crawl audit                           | `apps/search-ai/src/services/crawl-audit.service.ts`                                                                                          | Kafka -> ClickHouse `crawl_audit_events`                            | Deployment-env-specific DDL  | Dedicated crawl history routes                         | High                              |
| KMS audit                             | `apps/runtime/src/services/kms/kms-audit-logger.ts`                                                                                           | ClickHouse `kms_audit_log`                                          | 3-year delete TTL            | Dedicated runtime route                                | High                              |
| PII audit                             | `packages/compiler/src/platform/security/pii-audit.ts`                                                                                        | Kafka -> ClickHouse `pii_audit_log`                                 | Deployment-env-specific DDL  | Indirect; dedicated store and adapter                  | High                              |
| Arch AI audit                         | `packages/arch-ai/src/audit/audit-log-emitter.ts`                                                                                             | Kafka -> ClickHouse `arch_audit_log`                                | Deployment-env-specific DDL  | Dedicated Studio APIs and UI state                     | High                              |
| Omnichannel audit                     | `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`                                                                                  | Kafka -> ClickHouse `omnichannel_audit_log`                         | Deployment-env-specific DDL  | Dedicated runtime and Studio proxy routes              | Medium to high                    |
| Contact-domain audit port             | `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`                                                                           | Wired runtime callback -> shared runtime backend                    | Shared backend policy        | N/A                                                    | Medium                            |

## Canonical Runtime Contract

The shared runtime contract is defined in:

- `packages/compiler/src/platform/core/types.ts`
- `packages/compiler/src/platform/stores/audit-store.ts`

This is the cleanest conceptual model in the repo. It supports fields such as:

- `tenantId`
- `projectId`
- `eventType`
- `action`
- actor identity
- resource identity
- `environment`
- `oldValue`
- `newValue`
- `metadata`
- `traceId`

The problem is no longer the main shared runtime path. The remaining variance now lives mostly in legacy Mongo/plugin compatibility rows and in the dedicated subsystems that intentionally use their own schemas.

## Generic Runtime Audit Flow

### Store selection

Runtime initializes a singleton audit backend in:

- `apps/runtime/src/services/audit-store-singleton.ts`

Startup wiring happens in:

- `apps/runtime/src/server.ts`

Backend selection order is:

1. strict Kafka -> ClickHouse pipeline when `AUDIT_PIPELINE_ENABLED=true`
2. in-memory fallback when ClickHouse is unavailable in dev/test contexts

MongoDB and direct shared ClickHouse writes are no longer part of the shared runtime steady-state chain.

### Helper-driven events

Domain helper functions live in:

- `apps/runtime/src/services/audit-helpers.ts`

These helpers emit events for things like:

- contacts
- workflows
- deployments and versions
- sessions
- traces and related runtime actions

### Tool audit

Tool execution audit is introduced by middleware in:

- `packages/compiler/src/platform/constructs/executors/audit-middleware.ts`

and persisted by:

- `apps/runtime/src/services/tool-audit-logger.ts`

This is a real audit path, and it now inherits the same Kafka -> ClickHouse or in-memory backend behavior as the generic runtime store.

## Shared Mongo `audit_logs` Collection

The shared collection model is defined in:

- `packages/database/src/models/audit-log.model.ts`

Many independent producers write into this collection:

- Studio generic audit
- Admin generic audit
- runtime auth/OAuth audit
- runtime Mongo audit store
- Mongoose audit trail plugin

This is the most important collection to understand, and also the least uniform one.

### Why `audit_logs` is hard to trust as a single source of truth

Different writers persist different metadata shapes:

- Studio writes `metadata` as a JSON string.
- Admin writes `metadata` as a JSON string.
- runtime auth writes `metadata` as a raw object.
- legacy runtime `MongoAuditStore` wrote `metadata` as a raw object.

At the same time, readers in Studio and Admin parse metadata with `JSON.parse(...)` as if it is always a string.

That creates a real compatibility risk:

1. a writer stores `metadata` as an object
2. a reader assumes it is a string
3. the reader can fail or behave unpredictably on those rows

### Multiple document schemas in one collection

The shared `AuditLog` model expects a generic shape with fields like:

- `userId`
- `tenantId`
- `action`
- `ip`
- `userAgent`
- `metadata`

But the Mongoose audit trail plugin also writes into the same `audit_logs` collection using a different shape with fields like:

- `collectionName`
- `documentId`
- `operation`
- `changes`
- `previousValues`

So even within a single collection, document shape is not normalized.

## Mongoose Audit Trail Plugin

The plugin is implemented in:

- `packages/database/src/mongo/plugins/audit-trail.plugin.ts`

This plugin is more than just infrastructure. It is actually attached to multiple sensitive models, including:

- `user.model.ts`
- `tenant.model.ts`
- `organization.model.ts`
- `api-key.model.ts`
- `llm-credential.model.ts`
- `tool-secret.model.ts`
- `tenant-kms-config.model.ts`
- `environment-variable.model.ts`
- `project-config-variable.model.ts`
- `auth-profile.model.ts`
- `role-definition.model.ts`
- `tenant-transfer.model.ts`
- `arch-workspace-config.model.ts`
- `user-preferences.model.ts`

### Important caveat

The plugin supports actor attribution through `withAuditActor(...)`, but repo scan did not find non-test call sites for that wrapper. That implies a likely gap:

- plugin-generated records may exist
- but `userId`, `email`, or request identity may often be missing

This makes the plugin useful for change detection, but weaker for accountability.

## Runtime OAuth and Auth Audit

Runtime OAuth and channel OAuth now funnel through the shared runtime singleton path via:

- `apps/runtime/src/repos/auth-repo.ts`

Called from:

- `apps/runtime/src/routes/oauth.ts`
- `apps/runtime/src/routes/channel-oauth.ts`

### Durability characteristics

This path no longer owns a separate Mongo buffer. It shapes canonical shared audit events and hands them to the active runtime audit backend:

- pipeline mode: emit into the Kafka -> ClickHouse transport
- non-pipeline ClickHouse mode: write through the ClickHouse sink directly
- dev/test fallback: use the in-memory shared audit store

There is still shutdown drain wiring in:

- `apps/runtime/src/services/runtime-shutdown-flush.ts`
- `apps/runtime/src/server.ts`

So this path now inherits the runtime backend guarantees instead of maintaining its own parallel best-effort buffer.

## Studio Generic Audit

Studio generic audit is implemented in:

- `apps/studio/src/services/audit-service.ts`
- `apps/studio/src/repos/archive-repo.ts`
- `apps/studio/src/app/api/audit/route.ts`

### Strengths

- dedicated service layer
- metadata sanitization for sensitive keys
- explicit API surface
- workspace and personal views

### Weaknesses

- `getCurrentRequestId()` returns `undefined`
- `getCurrentTenantId()` returns `undefined`
- Studio still carries some legacy compatibility surface in the shared Mongo `audit_logs` collection, even though the active read path is tenant-scoped ClickHouse

That means:

1. request correlation is mostly not auto-populated
2. current product behavior is materially stronger than the old personal-scope mode, but legacy compatibility rows still require care when reasoning about historical reads

## Admin Generic Audit

Admin audit is implemented in:

- `apps/admin/src/lib/audit-logger.ts`
- `apps/admin/src/app/api/audit/route.ts`
- `apps/admin/src/app/(dashboard)/audit/page.tsx`

### Important product boundary

The admin UI itself says this audit log is mainly for admin UI access events. It explicitly points to Git and ArgoCD history for configuration and secret mutation history.

That means the admin audit UI is intentionally incomplete. It should not be treated as the full platform mutation ledger.

### Export caveat

The admin product experience is still intentionally narrow, but CSV export now has a backend route (`/api/audit/export`) that queries the server-side audit reader and formats CSV there.

## SearchAI Generic Audit

SearchAI has generic audit writing in:

- `apps/search-ai/src/services/audit-helpers.ts`
- `apps/search-ai/src/services/audit-logger.ts`
- `apps/search-ai/src/services/search-ai-audit-pipeline-writer.ts`
- `apps/search-ai/src/services/search-ai-clickhouse-audit-reader.ts`
- `apps/search-ai/src/routes/knowledge-bases.ts`

The shared SearchAI path now emits canonical shared audit events into the Kafka-backed pipeline and reads them back from ClickHouse for the KB activity feed and service-level query helpers.

But not everything named "audit" in SearchAI is durable audit logging.

SearchAI also has route-level durable audit in connector-domain flows:

- `apps/search-ai/src/routes/mappings.ts`
- `apps/search-ai/src/routes/connector-notifications.ts`
- `apps/search-ai/src/routes/webhooks.ts`

Those routes write through `queueAuditEntry(...)` into the dedicated connector audit subsystem, not the shared generic audit path.

## Connector Audit

Connector audit is one of the cleanest dedicated systems in the repo.

Main pieces:

- model: `packages/database/src/models/connector-audit-entry.model.ts`
- service: `apps/search-ai/src/services/connector-audit.service.ts`
- routes: `apps/search-ai/src/routes/connector-audit.ts`
- Studio hook: `apps/studio/src/hooks/useAuditLog.ts`

### Why it is stronger

- dedicated collection
- dedicated service
- dedicated query/export API
- tenant and connector context are first-class

This is much easier to reason about than the legacy/shared `audit_logs` compatibility collection.

## Crawl Audit

Crawl audit uses:

- `packages/database/src/models/crawl-audit-event.model.ts`
- write sites in `apps/search-ai/src/routes/crawl.ts`
- read routes in `apps/search-ai/src/routes/crawl-history.ts`

The crawl path now writes and reads through the dedicated Kafka -> ClickHouse service, while preserving the domain-specific crawl history APIs.

## KMS Audit

KMS audit is implemented in:

- `apps/runtime/src/services/kms/kms-audit-logger.ts`
- ClickHouse schema in `packages/database/src/clickhouse-schemas/init.ts`
- read route in `apps/runtime/src/routes/kms-admin.ts`

### Why it stands out

- dedicated table
- dedicated schema
- dedicated route
- long retention
- strong security domain alignment

The KMS table has a warm-to-cold lifecycle and a 3-year delete TTL, making it one of the strongest audit paths in the system.

## PII Audit

PII audit is implemented through:

- `packages/compiler/src/platform/security/pii-audit.ts`
- `apps/runtime/src/services/execution/pii-audit-singleton.ts`
- `apps/runtime/src/services/execution/pii-audit-store-adapter.ts`
- `packages/database/src/models/pii-audit-log.model.ts`

### Strengths

- dedicated model
- dedicated interface
- explicit emit sites around sensitive operations
- TTL-based retention

The runtime adapter now emits `stream: 'pii'` into the shared audit pipeline and materializes into `abl_platform.pii_audit_log`. It still uses buffered emission semantics, so controlled shutdown is stronger than abrupt process termination.

## Arch AI Audit

Arch AI has its own complete audit subsystem:

- types: `packages/arch-ai/src/audit/types.ts`
- emitter: `packages/arch-ai/src/audit/audit-log-emitter.ts`
- model: `packages/database/src/models/arch-audit-log.model.ts`
- APIs:
  - `apps/studio/src/app/api/arch-ai/audit-logs/route.ts`
  - `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts`
  - `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts`
  - `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts`
- UI state:
  - `apps/studio/src/store/arch-audit-store.ts`

This remains a mature, dedicated, queryable audit system, but the active writer and reader path is now Kafka -> ClickHouse rather than MongoDB.

## Omnichannel "Audit"

Omnichannel audit is implemented in:

- `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`

Read surfaces:

- `apps/runtime/src/routes/omnichannel.ts`
- `apps/studio/src/app/api/projects/[id]/omnichannel/audit/route.ts`

This path now emits `stream: 'omnichannel'` and reads from `abl_platform.omnichannel_audit_log`, with only an in-process fallback used by dev/test harnesses when the shared audit store is not initialized.

## Contact-Domain Audit Port

The contact context exposes an audit port in:

- `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`
- `apps/runtime/src/contexts/contact/index.ts`

Use cases emit events such as:

- `contact.created`
- `contact.merged`
- `contact.session_linked`

### Current wiring

The runtime composition root now passes `onContactAudit: emitContactLifecycleAudit` into the contact context from `apps/runtime/src/server.ts`.

That means the contact-domain port is no longer an unwired abstraction. Its remaining limitation is that it shares the generic runtime backend rather than using a dedicated contact-only audit subsystem.

## Retention and Durability Matrix

| Store                                           | Retention                                                            | Durability notes                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Mongo `audit_logs`                              | No TTL found                                                         | Durable Mongo storage, but mixed schemas and mixed metadata encoding |
| ClickHouse `abl_platform.audit_events`          | Deployment-env-specific DDL; prod = 90 days to cold, 730 days delete | Shared system of record for the generic audit stream                 |
| ClickHouse `abl_platform.kms_audit_log`         | Delete TTL after 3 years                                             | Strong dedicated path                                                |
| ClickHouse `abl_platform.pii_audit_log`         | Deployment-env-specific DDL; prod preserves 90-day retention         | Dedicated path, buffered emission with materialization               |
| ClickHouse `abl_platform.arch_audit_log`        | Deployment-env-specific DDL                                          | Dedicated path                                                       |
| ClickHouse `abl_platform.connector_audit_log`   | Deployment-env-specific DDL                                          | Dedicated path                                                       |
| ClickHouse `abl_platform.crawl_audit_events`    | Deployment-env-specific DDL                                          | Dedicated path                                                       |
| ClickHouse `abl_platform.omnichannel_audit_log` | Deployment-env-specific DDL                                          | Dedicated path with test-only in-process fallback                    |

## Read and Export Surfaces

### Generic

- Studio generic audit: `GET /api/audit`
- Admin generic audit: `GET /api/audit`

### Dedicated

- Connector audit: `GET /api/indexes/:indexId/connectors/:connectorId/audit-log`
- Connector audit export: `GET /api/indexes/:indexId/connectors/:connectorId/audit-log/export`
- Crawl audit reads: `GET /audit/:jobId`
- Crawl audit write helper route: `POST /audit/event`
- KMS audit: `GET /api/tenants/:tenantId/kms/audit`
- Omnichannel audit: `GET /api/projects/:projectId/omnichannel/audit`
- Arch AI audit list: `GET /api/arch-ai/audit-logs`
- Arch AI summary and timeline routes under the same API family

### Export caveats

- Studio audit export now creates a tenant-scoped archive manifest backed by the shared archive service and ClickHouse audit reads.
- The archive service pages shared audit rows through ClickHouse using explicit `tenantId` filters.
- Admin CSV export is now a server-side query + CSV formatting path, not just client-side export of already loaded UI rows.
- The remaining limitation is product shape: Studio archive export and Admin CSV export are separate surfaces rather than one unified compliance-export experience.

## Critical Mismatches and Risks

### 1. `audit_logs` is not normalized

The same collection contains:

- generic app audit rows
- runtime auth rows
- runtime store rows
- plugin-generated change-trail rows

These rows do not share one schema.

### 2. Metadata encoding is inconsistent

Some producers store `metadata` as strings, others as objects.

This is a direct compatibility risk for readers that unconditionally do `JSON.parse(...)`.

### 3. Plugin actor attribution is stronger, but still depends on `withAuditActor(...)` adoption

The plugin now has real request-path adoption in Studio and Admin route handling, so actor attribution is materially stronger than it was before. The remaining risk is outside those wrappers: non-route writes still only get rich actor context if they explicitly run under `withAuditActor(...)`.

### 4. Shared Mongo `audit_logs` is now a compatibility surface, not the shared runtime source of truth

The old shared runtime Mongo store has been removed, but the collection still exists for legacy and plugin-generated rows. That means Mongo `audit_logs` remains important to understand, even though the steady-state shared runtime path is now Kafka -> ClickHouse.

### 5. Shared ClickHouse trace and event-type queries are materially stronger

Canonical ClickHouse rows now persist `traceId` into `session_id`, `getByTraceId()` falls back to `metadata.traceId`, and event-type filtering uses the canonical event type expression instead of raw `action` alone.

The remaining limitation is legacy data: older or compatibility rows can still be sparse.

### 6. Shared ClickHouse tenant scoping is now explicit, but opt-out readers still need care

`ClickHouseAuditReader` supports explicit `tenantId` filters and `requireTenantId`, and the app-facing readers now use tenant-scoped queries deliberately.

The remaining misuse risk is only in readers created with tenant checks disabled for special cases.

### 7. Plugin fallback is now explicit instead of silently reverting to Mongo

The Mongoose audit plugin no longer writes to Mongo `audit_logs` when no handler is registered. It now emits a one-time warning and drops the entry, which is safer than silently reintroducing a Mongo write path in new code.

### 8. Runtime helper environment attribution is resolved centrally, but helper literals remain misleading

`writeAuditLog()` now overwrites helper-supplied environments with `getRuntimeAuditEnvironment()`, so persisted rows use the resolved deployment environment.

The remaining problem is readability: many helpers still pass `environment: 'dev'` even though that value is no longer authoritative.

### 8. Studio personal audit is materially stronger, but legacy compatibility rows still exist

The active Studio `/api/audit` path is now ClickHouse-backed and tenant-scoped. The remaining caution is historical data compatibility, not an active cross-tenant query mode in the steady-state path.

### 9. Generic alerting support is wired into the shared runtime path

`AuditStore` alert configuration is now parsed at startup and passed into the Kafka-backed runtime pipeline store.

This is no longer an unwired feature; the remaining question is operational adoption, not code-path wiring.

### 10. Auth audit now relies on the shared runtime backend

The old auth-specific Mongo drop-buffer path is gone. Auth audit now inherits the guarantees and failure behavior of the active runtime shared audit backend.

### 11. Crawl audit is deletable

Deleting a crawl job deletes the corresponding audit history.

### 12. Archive and export are split across separate product surfaces

Studio archive export and Admin CSV export are both tenant-safe now, but they are still separate experiences rather than one unified compliance-export surface.

### 13. Admin audit is intentionally partial

It tracks admin UI access history, not the full universe of administrative mutations.

### 14. Model comment and plugin usage are in tension

`packages/database/src/models/audit-log.model.ts` describes the collection as not tenant-scoped for admin cross-tenant queries, but the same model applies tenant isolation plugin behavior. That is at minimum a documentation or intent mismatch that should be clarified.

## What Looks Strongest Today

The subsystems I would trust most today for auditability are:

1. Shared Kafka -> ClickHouse audit for the generic runtime/studio/admin path
2. KMS audit
3. Connector audit
4. Arch AI audit
5. PII audit, with normal-shutdown flush and the usual buffered-writer abrupt-crash caveat

These are stronger because they have clearer storage ownership, clearer read surfaces, and far less schema drift than the legacy Mongo compatibility path.

## What Looks Weakest Today

The subsystems or patterns I would treat as weak or non-compliance-grade are:

1. Omnichannel audit
2. Crawl audit mutability
3. Legacy/plugin `audit_logs` as a universal source of truth
4. Studio personal audit when legacy scope mode is allowed
5. Admin audit partiality

## Recommended Cleanup Plan

If this system needs to become audit-ready in a stricter sense, the highest-value fixes are:

1. Shrink or clearly label legacy `audit_logs`
   - Keep it as a compatibility/plugin collection, not an implied shared source of truth.
2. Standardize metadata encoding for the remaining Mongo compatibility rows
   - Pick one representation for `metadata`.
3. Separate change-trail plugin rows from generic compatibility rows
   - Either move plugin output to a dedicated collection or formalize a polymorphic schema with explicit type discriminators.
4. Remove misleading helper-level `environment: 'dev'` literals
   - Storage is correct today, but the call sites are confusing.
5. Make Studio personal audit permanently tenant-safe
   - remove the legacy user-only mode once rollout allows it.
6. Decide which paths are compliance-grade versus operational only
   - especially omnichannel, crawl audit, and admin audit.
7. Unify export/reporting only if a single compliance-export surface is a requirement
   - current Studio archive export and Admin CSV export are both real, but separate.
8. Keep an audit-system contract test suite
   - verify schema shape, actor attribution, tenant isolation, retention behavior, pipeline recovery, and export safety.

## Bottom Line

The repo has substantial audit infrastructure, but it is fragmented.

The dedicated audit subsystems are generally understandable and stronger.
The shared generic audit story is where most of the risk lives:

- mixed document shapes
- mixed metadata encoding
- legacy/plugin compatibility overlap in Mongo
- legacy personal-scope behavior in Studio
- split export surfaces rather than one compliance-export product

If this document is used as the baseline for follow-up work, the next best step is to turn it into a remediation matrix with columns for:

- subsystem
- store
- actor attribution
- tenant isolation
- immutability
- retention
- queryability
- exportability
- current risk
- owner

## Primary Source Files Reviewed

This deep dive was based on source inspection across these major areas:

- `packages/compiler/src/platform/stores/audit-store.ts`
- `packages/compiler/src/platform/core/types.ts`
- `packages/database/src/models/audit-log.model.ts`
- `packages/database/src/mongo/plugins/audit-trail.plugin.ts`
- `packages/database/src/models/pii-audit-log.model.ts`
- `packages/database/src/models/arch-audit-log.model.ts`
- `packages/database/src/models/connector-audit-entry.model.ts`
- `packages/database/src/models/crawl-audit-event.model.ts`
- `packages/database/src/clickhouse-schemas/init.ts`
- `apps/runtime/src/services/audit-store-singleton.ts`
- `apps/runtime/src/services/audit-helpers.ts`
- `apps/runtime/src/services/tool-audit-logger.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/repos/auth-repo.ts`
- `apps/runtime/src/services/kms/kms-audit-logger.ts`
- `apps/runtime/src/services/execution/pii-audit-singleton.ts`
- `apps/runtime/src/services/execution/pii-audit-store-adapter.ts`
- `apps/runtime/src/routes/oauth.ts`
- `apps/runtime/src/routes/channel-oauth.ts`
- `apps/runtime/src/routes/omnichannel.ts`
- `apps/runtime/src/routes/kms-admin.ts`
- `apps/runtime/src/contexts/contact/index.ts`
- `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`
- `apps/studio/src/services/audit-service.ts`
- `apps/studio/src/repos/archive-repo.ts`
- `apps/studio/src/app/api/audit/route.ts`
- `apps/studio/src/services/archive/archive-service.ts`
- `apps/studio/src/app/api/archives/audit-export/route.ts`
- `apps/studio/src/app/api/projects/[id]/omnichannel/audit/route.ts`
- `apps/studio/src/app/api/arch-ai/audit-logs/route.ts`
- `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts`
- `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts`
- `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts`
- `apps/studio/src/store/arch-audit-store.ts`
- `apps/admin/src/lib/audit-logger.ts`
- `apps/admin/src/app/api/audit/route.ts`
- `apps/admin/src/app/(dashboard)/audit/page.tsx`
- `apps/search-ai/src/services/audit-helpers.ts`
- `apps/search-ai/src/services/audit-logger.ts`
- `apps/search-ai/src/services/connector-audit.service.ts`
- `apps/search-ai/src/routes/connector-audit.ts`
- `apps/search-ai/src/routes/crawl.ts`
- `apps/search-ai/src/routes/crawl-history.ts`
- `apps/search-ai/src/routes/mappings.ts`

This document reflects repository state at the time of inspection. It does not validate runtime behavior in a live environment.
