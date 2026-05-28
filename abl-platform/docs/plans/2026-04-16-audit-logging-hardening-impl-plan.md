# LLD: Audit Logging Hardening And Coverage Remediation

**Feature Spec**: `docs/features/audit-logging.md`
**HLD**: `docs/specs/audit-logging.hld.md`
**Test Spec**: `docs/testing/audit-logging.md`
**Implementation Review Inputs**:

- `docs/audit/audit-log-consolidated-review.md`
- `docs/audit/audit-log-feature-coverage-matrix.md`
- `docs/audit/audit-log-system-deep-dive.md`
  **Status**: IMPLEMENTED
  **Date**: 2026-04-21

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                                                                                                  | Rationale                                                                                                                                                                                         | Alternatives Rejected                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-1  | Keep the shared audit path as the default, but preserve dedicated paths for KMS, PII, connector audit, and Arch AI, while explicitly classifying crawl and omnichannel instead of leaving them ambiguous. | Those domains already have materially different retention, access, or reporting requirements. Crawl and omnichannel currently sit in an ambiguous middle state and must be explicitly classified. | Force all events into one sink now, or leave operational-only domains informally labeled as audit forever. |
| D-2  | Introduce a versioned shared audit envelope plus compatibility readers before changing all writers.                                                                                                       | We need a safe migration path because `audit_logs` already contains mixed document shapes and mixed metadata encodings.                                                                           | Big-bang schema rewrite or backfill-first rollout.                                                         |
| D-3  | Use one shared codec for Mongo, ClickHouse, Studio, and Admin shared-path reads and writes.                                                                                                               | The current problem is contract drift. A single codec gives us one place to normalize `eventType`, `action`, metadata parsing, trace handling, and retention fields.                              | Leave every app to keep its own read/write mapping.                                                        |
| D-4  | Fix shared-path correctness before closing long-tail feature gaps.                                                                                                                                        | If we add more coverage on top of an inconsistent shared layer, we amplify drift instead of reducing it.                                                                                          | Start with every missing feature first.                                                                    |
| D-5  | Treat logger-only and memory-only paths as operational until explicitly upgraded.                                                                                                                         | This avoids over-claiming compliance-grade audit while letting us harden the most important gaps first.                                                                                           | Call every existing operational log an audit record.                                                       |
| D-6  | Make TTL and auth-buffer controls environment-configurable with defaults, and roll them out only after compatibility readers and writers are stable.                                                      | Retention and durability are operational controls, not literals to hardcode into source.                                                                                                          | Hardcode TTL and buffer values into individual writers.                                                    |
| D-7  | Use phased, independently deployable slices with explicit rollback points and locked tests per slice.                                                                                                     | The audit surface spans runtime, Studio, Admin, SearchAI, compiler, and database packages; we need controlled blast radius.                                                                       | Single large audit refactor PR.                                                                            |
| D-8  | Roll out compatibility readers before canonical writer flips, and use dual-write or writer flags when a reader-first rollout cannot be guaranteed.                                                        | Current Studio/Admin shared readers still assume legacy metadata encodings and can break if writer rollout lands first.                                                                           | Change writers first and rely on coordinated deploy timing.                                                |
| D-9  | Do not enable shared-path TTL until the retention contract is explicitly reconciled with the codebase’s current “immutable/archive-first” assumptions.                                                    | Shared TTL is a policy change, not just a storage optimization. It must be explicit in docs, operations, and rollback.                                                                            | Quietly add TTL to shared audit rows without updating the retention contract.                              |
| D-10 | Keep hot-path integration audit emission fire-and-forget or queue-backed.                                                                                                                                 | Webhooks, mapping reviews, and Git flows must not regress request latency or availability because audit persistence blocks the critical path.                                                     | Synchronous durable writes in the main request path.                                                       |
| D-11 | Choose one emission boundary per business action.                                                                                                                                                         | Contact audit in particular can double-write if domain-level and route-level emitters are both active for the same action.                                                                        | Layering route-level and domain-level audit calls without dedupe.                                          |
| D-12 | Make retention a subsystem matrix, not a shared-path-only policy.                                                                                                                                         | The repo already has different retention regimes for shared audit, KMS, PII, Arch AI, crawl, and operational-only buffers.                                                                        | Treat shared `audit_logs` TTL as if it solves all retention concerns.                                      |

### Scope Assumptions

- Shared `audit_logs` remains the default shared Mongo sink in this implementation plan.
- Dedicated audit systems remain dedicated in this implementation plan.
- Omnichannel remains explicitly operational-only unless product or compliance explicitly upgrades it later.
- Historical backfill is out of scope for the first rollout; compatibility readers must handle legacy rows.
- Git/PR history can remain an external trail for PR content itself, but Git integration entry points inside the app can still emit durable audit events.
- Shared-path TTL is gated behind explicit policy approval; until then, indefinite retention remains the default shared-path behavior.
- Studio personal-scope behavior is treated as a product decision. The stricter tenant-safe variant must not silently replace current user-wide semantics without an explicit rollout choice.

### Key Interfaces And Types

```typescript
// packages/compiler/src/platform/stores/shared-audit-codec.ts

export type SharedAuditSource =
  | 'runtime-store'
  | 'runtime-auth'
  | 'studio'
  | 'admin'
  | 'search-ai'
  | 'mongoose-plugin';

export type SharedAuditMetadataEncoding = 'object' | 'json-string';

export type SharedAuditRetentionClass = 'default' | 'auth' | 'crud' | 'indefinite';

export interface SharedAuditEnvelope {
  schemaVersion: 2;
  source: SharedAuditSource;
  eventType: string;
  action: string;
  actorId: string | null;
  actorType: 'user' | 'admin' | 'agent' | 'system' | 'unknown';
  tenantId: string | null;
  projectId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  environment: string | null;
  traceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  metadataEncoding: SharedAuditMetadataEncoding;
  retentionClass: SharedAuditRetentionClass;
  expiresAt?: Date | null;
}

export interface AuditBufferConfig {
  flushIntervalMs: number;
  maxBatchSize: number;
  maxBufferSize: number;
  dropOldestOnOverflow: boolean;
}
```

### Module Boundaries

| Module                                                         | Responsibility                                                              | Depends On                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/compiler/src/platform/stores/`                       | Canonical shared codec, contract types, shared defaults                     | No database access                               |
| `packages/database/src/models/audit-log.model.ts`              | Shared Mongo schema, indexes, retention fields                              | Mongoose, platform model registry                |
| `apps/runtime/src/services/stores/`                            | Shared runtime ClickHouse sink/reader and remaining compatibility utilities | Compiler codec, ClickHouse client                |
| `apps/runtime/src/repos/auth-repo.ts`                          | Auth-path shared event adapter using the runtime singleton audit backend    | Compiler defaults, runtime audit singleton       |
| `apps/studio/src/services` and `apps/studio/src/app/api/audit` | Studio writes, sanitization, tenant-safe reads                              | Shared codec, pipeline writer, ClickHouse reader |
| `apps/admin/src/lib` and `apps/admin/src/app/api/audit`        | Admin writes and reads through shared pipeline and ClickHouse reader        | Shared codec, pipeline writer, ClickHouse reader |
| `apps/search-ai/src/routes` and `apps/search-ai/src/services`  | Gap closure for mappings, notifications, webhooks                           | Shared audit path or connector audit service     |
| `packages/database/src/mongo/plugins`                          | Mongoose actor propagation and plugin-shape coexistence                     | AsyncLocalStorage, shared sink                   |

---

## 2. File-Level Change Map

### New Files

| File                                                                    | Purpose                                                                          | LOC Estimate |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| `packages/compiler/src/platform/stores/shared-audit-codec.ts`           | Canonical shared audit encoder/decoder and compatibility helpers                 | ~200         |
| `packages/compiler/src/__tests__/shared-audit-codec.test.ts`            | Codec round-trip and legacy compatibility tests                                  | ~180         |
| `packages/database/src/__tests__/audit-log.model.test.ts`               | Shared audit schema and index tests                                              | ~120         |
| `apps/runtime/src/scripts/audit-log-compat-report.ts`                   | Dry-run inventory of existing `audit_logs` legacy shapes and migration readiness | ~180         |
| `apps/runtime/src/scripts/audit-log-backfill-v2.ts`                     | Idempotent backfill of canonical top-level fields for existing records           | ~220         |
| `apps/runtime/src/__tests__/audit-log-compat-report.test.ts`            | Compatibility inventory script tests for existing Mongo audit records            | ~120         |
| `apps/runtime/src/__tests__/audit-log-backfill-v2.test.ts`              | Additive backfill tests for existing Mongo audit records                         | ~140         |
| `apps/runtime/src/scripts/clickhouse-audit-compat-report.ts`            | Dry-run inventory of legacy `audit_events` rows and trace-compat gaps            | ~180         |
| `apps/runtime/src/scripts/clickhouse-audit-backfill-v2.ts`              | Idempotent additive migration for legacy ClickHouse audit rows when approved     | ~220         |
| `apps/runtime/src/__tests__/clickhouse-audit-store.test.ts`             | Runtime ClickHouse shared-audit contract tests                                   | ~180         |
| `apps/runtime/src/__tests__/clickhouse-audit-migration.test.ts`         | Legacy ClickHouse compatibility and migration tests                              | ~140         |
| `apps/studio/src/__tests__/audit-service.test.ts`                       | Studio sanitization and compatibility write tests                                | ~150         |
| `apps/admin/src/__tests__/audit-route.test.ts`                          | Admin API shared-read compatibility tests                                        | ~140         |
| `apps/admin/src/__tests__/secret-rotation-history.test.ts`              | Regression coverage for secondary admin consumers of shared audit reads          | ~120         |
| `apps/admin/src/__tests__/audit-page-export.test.ts`                    | Regression coverage for admin audit CSV export UI                                | ~120         |
| `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts`                 | Flush-on-exit coverage for buffered PII audit                                    | ~120         |
| `packages/compiler/src/__tests__/audit-store-alerting.test.ts`          | Critical-event alert dispatch and failure-isolation tests                        | ~150         |
| `apps/runtime/src/__tests__/omnichannel-audit-boundary.test.ts`         | Explicit operational-only boundary tests for omnichannel audit                   | ~100         |
| `apps/search-ai/src/routes/__tests__/crawl-audit-retention.test.ts`     | Crawl audit classification and delete/retention behavior tests                   | ~160         |
| `apps/search-ai/src/routes/__tests__/connector-notifications.test.ts`   | Durable audit assertions for notification update/test flows                      | ~160         |
| `apps/search-ai/src/routes/__tests__/webhooks-audit.test.ts`            | Durable or explicit operational behavior tests for inbound webhooks              | ~180         |
| `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts` | Plugin actor propagation and sink-shape tests                                    | ~150         |

### Modified Files

| File                                                         | Change Description                                                                      | Risk |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---- |
| `packages/compiler/src/platform/core/types.ts`               | Expand query/resource enums and align shared contract fields                            | Med  |
| `packages/compiler/src/platform/stores/audit-store.ts`       | Use shared codec helpers and stricter contract defaults                                 | Med  |
| `packages/database/src/models/audit-log.model.ts`            | Add normalized shared fields, retention fields, compatibility indexes                   | High |
| Legacy runtime shared Mongo backend (historical)             | Write/read canonical top-level fields via shared codec during the dual-backend phase    | High |
| `apps/runtime/src/services/stores/clickhouse-audit-store.ts` | Fix tenant, trace, and event parity with shared codec                                   | High |
| `apps/runtime/src/services/audit-store-singleton.ts`         | Remove fixed-tenant assumptions and pass runtime config                                 | Med  |
| `apps/runtime/src/repos/auth-repo.ts`                        | Canonical shared event shaping, singleton-backed async writes, graceful shutdown drain  | High |
| `apps/runtime/src/server.ts`                                 | Wire contact lifecycle audit emitter and shared config initialization                   | Med  |
| `apps/runtime/src/services/runtime-shutdown-flush.ts`        | Flush auth and PII buffered audit safely on shutdown                                    | High |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts` | Expose production-safe PII audit shutdown lifecycle                                     | Med  |
| `apps/runtime/src/services/audit-helpers.ts`                 | Ensure helpers populate canonical fields, not metadata-only shadows                     | Med  |
| `apps/studio/src/services/audit-service.ts`                  | Stop writer-side schema drift and keep sanitization                                     | High |
| Legacy Studio shared Mongo audit repo (historical)           | Decode both legacy and canonical rows cleanly during the dual-store compatibility phase | Med  |
| `apps/studio/src/app/api/audit/route.ts`                     | Tenant-safe personal scope and compatibility decoding                                   | High |
| `apps/admin/src/lib/audit-logger.ts`                         | Replace JSON-string assumptions with codec-backed writes/reads                          | High |
| `apps/admin/src/app/api/audit/route.ts`                      | Compatibility-safe querying and response mapping                                        | Med  |
| `apps/admin/src/app/api/secrets/rotation/route.ts`           | Ensure secondary admin consumers remain compatible with shared audit reads              | Med  |
| `apps/admin/src/app/(dashboard)/audit/page.tsx`              | Keep admin CSV export/UI behavior intact across response-shape changes                  | Med  |
| `apps/search-ai/src/routes/mappings.ts`                      | Replace logger-only mapping audit with durable writes                                   | High |
| `apps/search-ai/src/routes/connector-notifications.ts`       | Add durable audit for preference changes and test-webhook calls                         | Med  |
| `apps/search-ai/src/routes/webhooks.ts`                      | Add explicit durable audit or explicit operational classification path                  | Med  |
| `apps/search-ai/src/routes/crawl.ts`                         | Classify crawl audit as immutable audit or operational history and enforce behavior     | High |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts`  | Improve actor propagation usage and plugin row compatibility                            | High |
| `apps/studio/src/app/api/archives/audit-export/route.ts`     | Ensure tenant-safe archive/export behavior                                              | High |
| `apps/studio/src/services/retention/retention-service.ts`    | Reconcile shared TTL policy with current retention assumptions before activation        | High |

### Deleted Files

None in the initial plan.

---

## 3. Per-Slice Test Gate Summary

Every phase below is blocked on its own targeted build and test gate. We do not move to the next slice on “best effort” confidence.

| Phase                                                       | Required Builds                                                                                                           | Locked Tests                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1: Shared Envelope Foundation                         | `@abl/compiler`, `@agent-platform/database`, `@agent-platform/runtime`                                                    | `packages/compiler/src/__tests__/shared-audit-codec.test.ts`, `packages/database/src/__tests__/audit-log.model.test.ts`, `apps/runtime/src/__tests__/audit-log-compat-report.test.ts`, `apps/runtime/src/__tests__/audit-log-backfill-v2.test.ts`                                                                                                                                                        |
| Phase 2: Runtime Shared Backend Parity                      | `@agent-platform/runtime`                                                                                                 | legacy Mongo parity coverage, `apps/runtime/src/__tests__/clickhouse-audit-store.test.ts`, `apps/runtime/src/__tests__/audit-store-singleton.test.ts`, `apps/runtime/src/__tests__/clickhouse-audit-migration.test.ts`, runtime backend parity integration fixture                                                                                                                                       |
| Phase 3: Studio And Admin Reader Compatibility              | `@agent-platform/studio`, `@agent-platform/admin`                                                                         | `apps/studio/src/__tests__/audit-service.test.ts`, `apps/studio/src/__tests__/api-routes/api-audit.test.ts`, `apps/admin/src/__tests__/audit-route.test.ts`, `apps/admin/src/__tests__/secret-rotation-history.test.ts`                                                                                                                                                                                  |
| Phase 4: Runtime And Studio Core Coverage Gaps              | `@agent-platform/runtime`, `@agent-platform/studio`                                                                       | `apps/runtime/src/__tests__/execution/contexts/contact/contact-audit.test.ts`, `apps/runtime/src/__tests__/auth/contacts-authz.test.ts`, `apps/runtime/src/__tests__/wiring.test.ts`, `apps/studio/src/__tests__/e2e/auth-studio-events.test.ts`, `apps/studio/src/__tests__/mfa.test.ts`                                                                                                                |
| Phase 5: SearchAI, Git, And Boundary Coverage               | `@agent-platform/search-ai`, `@agent-platform/studio`, `@agent-platform/runtime`                                          | `apps/search-ai/src/routes/__tests__/mappings-crud.test.ts`, `apps/search-ai/src/routes/__tests__/connector-notifications.test.ts`, `apps/search-ai/src/routes/__tests__/webhooks-audit.test.ts`, `apps/search-ai/src/routes/__tests__/crawl-audit-retention.test.ts`, `apps/studio/src/__tests__/api-routes/project-git-audit.test.ts`, `apps/runtime/src/__tests__/omnichannel-audit-boundary.test.ts` |
| Phase 6: Retention, Sizing, And Operational Hardening       | `@agent-platform/runtime`, `@agent-platform/database`, `@agent-platform/studio`                                           | `apps/runtime/src/__tests__/auth-repo-batching.test.ts`, `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts`, `packages/database/src/__tests__/audit-log.model.test.ts`, migration observability and retention-policy gate checks                                                                                                                                                                    |
| Phase 7: Alerting, Plugin, Export, And Governance Hardening | `@abl/compiler`, `@agent-platform/database`, `@agent-platform/studio`, `@agent-platform/runtime`, `@agent-platform/admin` | `packages/compiler/src/__tests__/audit-store-alerting.test.ts`, `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts`, `apps/studio/src/__tests__/api-routes/audit-export-route.test.ts`, `apps/runtime/src/__tests__/integration/audit-contract.integration.test.ts`, `apps/admin/src/__tests__/audit-page-export.test.ts`                                                            |

Test gate rules:

- No phase is considered complete unless every locked test for that phase passes.
- We run targeted builds before targeted tests for each phase.
- Existing tests extended in a phase become part of that phase’s locked gate, not optional regression checks.
- Phase 3 compatibility readers must be deployed before Phase 2 canonical writer changes are activated.
- Any phase that changes retention, backfill, or export behavior also requires a migration observability review before rollout.
- Final rollout still requires a full repo-level verification pass after all implemented phases are merged.

---

## 4. Implementation Phases

### Phase 1: Shared Envelope Foundation

**Goal**: Introduce a canonical shared audit envelope and compatibility decoder without changing system behavior yet.

**Tasks**:

1.1. Create `packages/compiler/src/platform/stores/shared-audit-codec.ts`.

1.2. Define canonical encode/decode helpers for:

- legacy string metadata rows
- legacy object metadata rows
- canonical V2 rows
- plugin rows that still land in `audit_logs`

  1.3. Extend `packages/compiler/src/platform/core/types.ts` and `packages/compiler/src/platform/stores/audit-store.ts` so the shared contract can represent:

- `tenantId`
- `projectId`
- `eventType`
- `resourceType`
- `resourceId`
- `environment`
- `traceId`
- retention class metadata

  1.4. Expand `packages/database/src/models/audit-log.model.ts` with explicit shared fields:

- `eventType`
- `actorType`
- `projectId`
- `resourceType`
- `resourceId`
- `environment`
- `traceId`
- `source`
- `schemaVersion`
- `metadataEncoding`
- `retentionClass`
- `expiresAt`

  1.5. Keep compatibility with legacy rows by retaining `metadata` and legacy indexes.

  1.6. Add compatibility indexes for top-level fields so later phases can query without depending on metadata dot-path lookups.

  1.7. Create `apps/runtime/src/scripts/audit-log-compat-report.ts` as a dry-run inspection tool that:

- scans existing `audit_logs`
- classifies records by shape: legacy string metadata, legacy object metadata, plugin row, canonical V2 row, unknown
- reports missing canonical fields
- reports candidate retention classes
- does not mutate data

  1.8. Create `apps/runtime/src/scripts/audit-log-backfill-v2.ts` as an idempotent migration tool that:

- reads existing shared audit records
- derives canonical top-level fields from legacy metadata when possible
- preserves original `metadata`
- never deletes or rewrites plugin-specific fields
- supports dry-run mode, batch size controls, tenant scoping, and resume-safe execution
- only writes additive fields needed for canonical readers and future TTL support

**Files Touched**:

- `packages/compiler/src/platform/stores/shared-audit-codec.ts`
- `packages/compiler/src/platform/core/types.ts`
- `packages/compiler/src/platform/stores/audit-store.ts`
- `packages/compiler/src/__tests__/shared-audit-codec.test.ts`
- `packages/database/src/models/audit-log.model.ts`
- `packages/database/src/__tests__/audit-log.model.test.ts`
- `apps/runtime/src/scripts/audit-log-compat-report.ts`
- `apps/runtime/src/scripts/audit-log-backfill-v2.ts`

**Exit Criteria**:

- [ ] Shared codec can decode legacy string-metadata rows, legacy object-metadata rows, and canonical V2 rows.
- [ ] `audit_logs` schema includes canonical top-level fields plus compatibility fields.
- [ ] No existing reader breaks when pointed at legacy rows.
- [ ] Compatibility report script can classify existing records without mutation.
- [ ] Backfill script supports dry-run and additive idempotent writes for existing records.
- [ ] Targeted builds for `@abl/compiler` and `@agent-platform/database` succeed.
- [ ] Targeted build for `@agent-platform/runtime` succeeds for the compatibility scripts.

**Test Lock**:

- Unit: `packages/compiler/src/__tests__/shared-audit-codec.test.ts`
  - canonical encode/decode round-trip
  - legacy string metadata decode
  - legacy object metadata decode
  - plugin-row decode classification
  - retention class defaulting
- Unit: `packages/database/src/__tests__/audit-log.model.test.ts`
  - schema field presence
  - legacy index preservation
  - canonical index presence
  - sparse TTL index shape on `expiresAt`
- Unit: `apps/runtime/src/__tests__/audit-log-compat-report.test.ts`
  - record-shape classification
  - unknown-row reporting
  - dry-run summary output
- Unit: `apps/runtime/src/__tests__/audit-log-backfill-v2.test.ts`
  - additive field derivation from string metadata rows
  - additive field derivation from object metadata rows
  - idempotent re-run behavior
  - plugin-row no-op behavior
  - tenant-scoped batch execution

**Rollback**: Revert codec introduction and new schema fields while leaving old readers untouched.

---

### Phase 2: Runtime Shared Backend Parity

**Goal**: Make Mongo and ClickHouse behave like two implementations of the same shared contract.

**Tasks**:

2.1. Update the legacy runtime shared Mongo backend to encode and decode with the shared codec.

2.2. Stop relying on `auditLog.metadata?.tenantId` as the source of truth for `tenantId`.

2.3. Update `apps/runtime/src/services/stores/clickhouse-audit-store.ts` to:

- write canonical tenant and project fields
- preserve `traceId`
- stop relying on constructor-time tenant defaults without first introducing an explicit tenant-scoped read contract
- stop reconstructing semantics from `action` when `eventType` is available

  2.4. Introduce an explicit tenant-scoped read strategy for ClickHouse before removing the constructor-time tenant assumption. Acceptable options are:

- add `tenantId` to read/query params in the shared contract
- or use per-tenant store instances for read paths

  2.5. Create `apps/runtime/src/scripts/clickhouse-audit-compat-report.ts` as a dry-run inspection tool that:

- classifies existing `audit_events` rows
- reports missing trace/session linkage
- reports candidate rows for additive migration
- does not mutate data

  2.6. Create either:

- an additive ClickHouse backfill script for historical rows
- or a legacy compatibility read path for trace lookup

This must be decided and implemented before canonical trace lookup is considered production-safe.

2.7. Update `apps/runtime/src/services/audit-store-singleton.ts` to remove the hardcoded `'default'` tenant only after the read strategy above is implemented, and thread alert config/runtime config through initialization.

2.8. Update `apps/runtime/src/services/audit-helpers.ts` so helper functions populate canonical top-level fields, not metadata-only shadows.

2.9. Keep canonical writer changes behind a rollout flag or dual-write guard until Phase 3 reader compatibility has shipped.

2.10. Add parity fixtures so Mongo and ClickHouse pass the same contract tests for query, summary, and trace lookup.

**Files Touched**:

- Legacy runtime shared Mongo backend implementation
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/services/audit-store-singleton.ts`
- `apps/runtime/src/services/audit-helpers.ts`
- `apps/runtime/src/scripts/clickhouse-audit-compat-report.ts`
- `apps/runtime/src/scripts/clickhouse-audit-backfill-v2.ts` or equivalent compatibility read implementation
- Legacy runtime shared Mongo backend parity coverage
- `apps/runtime/src/__tests__/clickhouse-audit-store.test.ts`
- `apps/runtime/src/__tests__/audit-store-singleton.test.ts`
- `apps/runtime/src/__tests__/clickhouse-audit-migration.test.ts`

**Exit Criteria**:

- [ ] Mongo and ClickHouse return the same logical result for the same audit fixtures.
- [ ] `getByTraceId()` works against canonical trace data in both backends.
- [ ] Historical ClickHouse rows have an explicit compatibility path for trace lookup.
- [ ] ClickHouse read paths are tenant-safe after removal of the hardcoded constructor tenant.
- [ ] Runtime helpers populate top-level canonical fields consistently.
- [ ] Canonical runtime writer activation is gated until Phase 3 readers are live.
- [ ] Targeted build for `@agent-platform/runtime` succeeds.

**Test Lock**:

- Unit: legacy runtime shared Mongo backend parity coverage
  - write canonical fields to Mongo
  - query by `eventType`
  - query by `resourceType` and `resourceId`
  - trace lookup by canonical `traceId`
- Unit: `apps/runtime/src/__tests__/clickhouse-audit-store.test.ts`
  - write canonical rows
  - query by tenant, actor, resource, and time
  - trace lookup parity
  - summary parity
- Unit: `apps/runtime/src/__tests__/clickhouse-audit-migration.test.ts`
  - legacy row trace compatibility
  - additive migration/backfill behavior
  - no data loss on idempotent re-run
- Unit: `apps/runtime/src/__tests__/audit-store-singleton.test.ts`
  - alert config wiring
  - no unsafe fixed tenant injection after the read strategy is implemented
  - strict pipeline/direct-ClickHouse/InMemory backend selection still works
- Integration: contract fixture test that runs the same logical assertions against Mongo and ClickHouse store adapters

**Rollback**: Revert runtime writer/read path changes and keep Phase 1 compatibility fields dormant.

---

### Phase 3: Studio And Admin Reader Compatibility

**Goal**: Make Studio and Admin tolerant readers first, then normalize shared-path writes without breaking existing user-facing behavior.

**Tasks**:

3.1. Update `apps/studio/src/services/audit-service.ts` to:

- keep metadata sanitization
- stop writing JSON-string metadata as the preferred shape
- attach canonical envelope fields where possible

  3.2. Update the legacy Studio shared Mongo audit repo to decode legacy and canonical rows through the shared codec.

  3.3. Update `apps/studio/src/app/api/audit/route.ts` to:

- parse both string and object metadata safely
- preserve current `scope=personal` behavior until a tenant-safe personal mode is explicitly introduced
- add an explicit tenant-safe personal mode or rollout flag for the stricter `userId + tenantId` behavior
- preserve workspace behavior for tenant admins

  3.4. Update `apps/admin/src/lib/audit-logger.ts` to write canonical shared-path rows and decode both legacy and canonical results.

  3.5. Update `apps/admin/src/app/api/audit/route.ts` to return compatibility-decoded entries.

  3.6. Ensure shared-read compatibility is centralized enough that secondary admin consumers, especially secret-rotation history, do not break when shared row shapes change.

  3.7. Do not activate Phase 2 canonical object-metadata writer changes until these reader compatibility changes are deployed.

**Files Touched**:

- `apps/studio/src/services/audit-service.ts`
- Legacy Studio shared Mongo audit repo (historical)
- `apps/studio/src/app/api/audit/route.ts`
- `apps/studio/src/__tests__/audit-service.test.ts`
- `apps/studio/src/__tests__/api-routes/api-audit.test.ts`
- `apps/admin/src/lib/audit-logger.ts`
- `apps/admin/src/app/api/audit/route.ts`
- `apps/admin/src/__tests__/audit-route.test.ts`
- `apps/admin/src/app/api/secrets/rotation/route.ts`
- `apps/admin/src/__tests__/secret-rotation-history.test.ts`

**Exit Criteria**:

- [ ] Studio can read both legacy string-metadata rows and canonical object rows.
- [ ] Admin can read both legacy string-metadata rows and canonical object rows.
- [ ] Studio personal-scope behavior is explicit and does not silently regress current semantics.
- [ ] Studio sanitization still redacts sensitive metadata keys.
- [ ] Secondary admin consumers of shared audit reads continue to work.

**Test Lock**:

- Unit: `apps/studio/src/__tests__/audit-service.test.ts`
  - metadata sanitization
  - canonical writer shape
  - legacy-safe fallback behavior
- Integration: `apps/studio/src/__tests__/api-routes/api-audit.test.ts`
  - workspace scope authorization
  - current personal scope behavior
  - tenant-safe personal mode behavior if introduced in this slice
  - legacy string metadata decode
  - canonical object metadata decode
- Integration: `apps/admin/src/__tests__/audit-route.test.ts`
  - admin query filters
  - legacy string metadata decode
  - canonical row decode
  - empty-result safety
- Integration: `apps/admin/src/__tests__/secret-rotation-history.test.ts`
  - secret-rotation history stays compatible with legacy and canonical shared rows

**Rollback**: Revert Studio/Admin writer changes while keeping Phase 1/2 compatibility readers available.

---

### Phase 4: Runtime And Studio Core Coverage Gaps

**Goal**: Close the highest-value generic coverage gaps in runtime and Studio after the shared path is stable.

**Tasks**:

4.1. Wire `onContactAudit` in `apps/runtime/src/server.ts` so contact lifecycle events from the DDD contact context are durably emitted.

4.2. Choose one emission boundary for contact lifecycle events before enabling `onContactAudit`:

- either route-level shared helpers
- or domain-level contact context emitter

Do not allow both to emit for the same action without dedupe or idempotency.

4.3. Add a runtime composition test proving `server.ts` actually wires `onContactAudit` into `createContactContext(...)`.

4.4. Add missing Studio audit writes for:

- logout
- token refresh
- token revoke
- all-token revoke
- MFA disable
- device-auth lifecycle
- SSO lifecycle
- archive actions

  4.5. Prefer route-level or service-level audit emission in the existing Studio auth/security flow instead of ad hoc helper duplication.

**Files Touched**:

- `apps/runtime/src/server.ts`
- `apps/runtime/src/contexts/contact/index.ts`
- `apps/runtime/src/__tests__/execution/contexts/contact/contact-audit.test.ts`
- `apps/runtime/src/__tests__/auth/contacts-authz.test.ts`
- `apps/runtime/src/__tests__/wiring.test.ts`
- `apps/studio/src/app/api/auth/logout/route.ts`
- `apps/studio/src/app/api/mfa/disable/route.ts`
- `apps/studio/src/app/api/auth/*` relevant token/device-auth routes
- `apps/studio/src/app/api/**/archive/**` relevant archive routes
- `apps/studio/src/__tests__/e2e/auth-studio-events.test.ts`
- `apps/studio/src/__tests__/mfa.test.ts`

**Exit Criteria**:

- [ ] Contact lifecycle events emitted through the contact context land in a durable audit path.
- [ ] Contact lifecycle actions do not double-write audit rows.
- [ ] Studio logout, token lifecycle, MFA disable, device-auth, SSO, and archive actions each produce auditable events.
- [ ] No existing Studio auth flow regresses.

**Test Lock**:

- Unit or integration: extend `apps/runtime/src/__tests__/execution/contexts/contact/contact-audit.test.ts`
  - create
  - link-session
  - merge or self-merge
  - delete path remains separate
- Integration: extend `apps/runtime/src/__tests__/auth/contacts-authz.test.ts`
  - audited create/update/delete/contact-link route behavior
- Integration: extend `apps/runtime/src/__tests__/wiring.test.ts`
  - `server.ts` wires `onContactAudit` into `createContactContext(...)`
  - no duplicate route-level plus domain-level emission for the same action
- E2E or route integration: extend `apps/studio/src/__tests__/e2e/auth-studio-events.test.ts`
  - login/logout
  - device-auth transitions
  - token lifecycle
  - SSO event path where test harness permits
- Integration: extend `apps/studio/src/__tests__/mfa.test.ts`
  - MFA disable emits audit

**Rollback**: Revert new feature-specific audit calls while keeping the shared core improvements.

---

### Phase 5: SearchAI, Git, And Boundary Coverage

**Goal**: Upgrade the most important SearchAI and external integration paths from logger-only or unclear coverage to explicit durable audit.

**Tasks**:

5.1. Replace logger-only field mapping audit in `apps/search-ai/src/routes/mappings.ts` with durable audit writes, but keep emission fire-and-forget or queue-backed so mapping operations do not regress latency.

5.2. Add durable audit for connector notification preference changes and test-webhook calls in `apps/search-ai/src/routes/connector-notifications.ts`, keeping failures isolated from the request path.

5.3. Add explicit durable audit for inbound webhooks in `apps/search-ai/src/routes/webhooks.ts` where the event materially changes integration state, or explicitly classify and isolate operational-only receipt logs. Audit persistence must not block required `202`/timeout behavior.

5.4. Decide per route whether to write through connector audit or the shared generic path. Use connector audit when the record is connector-domain history, not generic platform activity.

5.5. Expand Git audit coverage across every state-changing Studio route:

- create/update/delete config
- pull
- push
- promote
- webhook acceptance

Treat `status` and `history` as operational reporting unless product explicitly upgrades them to durable audit.

5.6. Add an explicit crawl-audit classification decision:

- immutable audit with no delete-on-job-delete
- or operational history that is intentionally deleted with crawl cleanup

Do not leave crawl in a mixed state.

5.7. Add an explicit operational-only verification for omnichannel so the boundary is tested and documented rather than assumed.

**Files Touched**:

- `apps/search-ai/src/routes/mappings.ts`
- `apps/search-ai/src/routes/connector-notifications.ts`
- `apps/search-ai/src/routes/webhooks.ts`
- `apps/search-ai/src/routes/crawl.ts`
- `apps/search-ai/src/routes/crawl-history.ts`
- `apps/search-ai/src/routes/__tests__/mappings-crud.test.ts`
- `apps/search-ai/src/routes/__tests__/connector-notifications.test.ts`
- `apps/search-ai/src/routes/__tests__/webhooks-audit.test.ts`
- `apps/search-ai/src/routes/__tests__/crawl-audit-retention.test.ts`
- `apps/studio/src/app/api/projects/[id]/git/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/push/route.ts`
- `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`
- `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`
- `apps/studio/src/__tests__/api-routes/project-git-audit.test.ts`
- `apps/runtime/src/services/omnichannel/omnichannel-audit.ts`
- `apps/runtime/src/__tests__/omnichannel-audit-boundary.test.ts`

**Exit Criteria**:

- [ ] SearchAI field mapping reviews produce durable audit records.
- [ ] Connector notification updates and test-webhook calls produce durable audit records.
- [ ] Inbound integration webhooks are no longer ambiguous: they are either durably audited or explicitly isolated as operational-only with tests proving that classification.
- [ ] State-changing Git routes are auditable, while `status` and `history` are explicitly classified.
- [ ] Crawl audit is explicitly classified and tested.
- [ ] Omnichannel is explicitly verified as operational-only.

**Test Lock**:

- Integration: extend `apps/search-ai/src/routes/__tests__/mappings-crud.test.ts`
  - confirm
  - reject
  - manual create
  - batch action audit writes
- Integration: `apps/search-ai/src/routes/__tests__/connector-notifications.test.ts`
  - notification update emits audit
  - test-webhook emits audit
  - tenant isolation holds
- Integration: `apps/search-ai/src/routes/__tests__/webhooks-audit.test.ts`
  - durable audit for state-changing webhook path
  - audit failure does not break webhook acknowledgement semantics
  - operational-only paths explicitly asserted where intended
- Integration: `apps/search-ai/src/routes/__tests__/crawl-audit-retention.test.ts`
  - crawl audit delete/retention behavior matches the explicit classification
- Integration: `apps/studio/src/__tests__/api-routes/project-git-audit.test.ts`
  - Git config create/update/delete audit
  - pull/push/promote audit
  - webhook acceptance audit
- Integration: `apps/runtime/src/__tests__/omnichannel-audit-boundary.test.ts`
  - omnichannel remains operational-only and memory-bounded

**Rollback**: Revert SearchAI and Git-specific audit additions while keeping shared-path improvements.

---

### Phase 6: Retention, Sizing, And Operational Hardening

**Goal**: Make retention, sizing, buffering, and migration operations explicit, configurable, and safe to roll out.

**Tasks**:

6.1. Publish and approve a retention matrix that covers at minimum:

- shared `audit_logs`
- shared ClickHouse `audit_events`
- KMS audit
- PII audit
- Arch AI audit
- crawl audit
- omnichannel operational buffer

  6.2. Reconcile the shared-path TTL design with the current “immutable/archive-first” assumptions in runtime and Studio. Shared TTL must not activate until this policy decision is explicitly documented.

  6.3. Add shared retention config with environment defaults for:

- `AUDIT_LOG_AUTH_TTL_DAYS`
- `AUDIT_LOG_CRUD_TTL_DAYS`
- `AUDIT_LOG_DEFAULT_TTL_DAYS`
- `AUDIT_LOG_TTL_ENABLED`

  6.4. Move auth-path shared audit onto the runtime singleton backend so it inherits the active Kafka -> ClickHouse pipeline, direct ClickHouse path, or in-memory fallback instead of maintaining a separate Mongo batch buffer.

  6.5. Keep shutdown drain tracking for in-flight auth-path writes without reintroducing a second buffering subsystem.

  6.6. Add `expiresAt` only for classes that should expire; leave indefinite classes unset.

  6.7. Add startup or migration-safe index creation for `expiresAt` without backfilling historical documents on day one.

  6.8. Make TTL activation and rollback two-step:

- writer/config activation
- index lifecycle activation/removal

Disabling TTL via env alone is not a sufficient rollback.

6.9. Ensure graceful shutdown drain covers auth-path in-flight writes and PII buffered audit.

6.10. Expose operator-visible failure accounting for auth-path singleton writes and pipeline-backed transport health, rather than a second auth-specific overflow buffer.

6.11. Add migration observability and capacity gates:

- rows/day and bytes/day
- per-tenant volume
- dropped buffered events
- unknown legacy rows
- backfill processed/skipped/failed counts
- export manifest/job size and duration

  6.12. Define checkpointing, batch limits, concurrency limits, and resumability for backfill and export jobs at production scale.

**Files Touched**:

- `apps/runtime/src/repos/auth-repo.ts`
- `packages/database/src/models/audit-log.model.ts`
- `apps/runtime/src/services/runtime-shutdown-flush.ts`
- `apps/runtime/src/services/execution/pii-audit-singleton.ts`
- `packages/compiler/src/platform/security/pii-audit.ts`
- `apps/studio/src/services/retention/retention-service.ts`
- `apps/runtime/src/__tests__/auth-repo-batching.test.ts`
- `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts`
- `packages/database/src/__tests__/audit-log.model.test.ts`

**Exit Criteria**:

- [ ] The retention matrix is explicit for shared and dedicated audit subsystems.
- [ ] Shared TTL policy is reconciled with current retention assumptions before activation.
- [ ] Auth-path buffering values are environment-configurable with safe defaults.
- [ ] Retention classes produce expected `expiresAt` behavior.
- [ ] Shared TTL rollout can be enabled and disabled safely without unintended continued expiry.
- [ ] Shutdown flush covers buffered shared auth and PII writes.
- [ ] Capacity, backpressure, and migration observability signals are emitted and reviewed before rollout.

**Test Lock**:

- Unit: `apps/runtime/src/__tests__/auth-repo-batching.test.ts`
  - default config fallback
  - env override parsing
  - buffer overflow behavior
  - repeated flush failure behavior
  - dropped-entry counting
  - flush batching
  - graceful shutdown flush
- Unit: `apps/runtime/src/__tests__/pii-audit-shutdown.test.ts`
  - PII audit flush-on-exit behavior
- Unit: extend `packages/database/src/__tests__/audit-log.model.test.ts`
  - sparse TTL index shape
  - `expiresAt` absent for indefinite class
  - `expiresAt` present for expiring classes
  - TTL activation/deactivation guard behavior
  - retention matrix alignment for shared audit schema defaults

**Rollback**: Disable the writer flag, remove or disable the TTL index explicitly, and revert buffer config parsing while leaving envelope changes intact.

---

### Phase 7: Alerting, Plugin, Export, And Governance Hardening

**Goal**: Close the remaining shared-governance gaps around alerting, plugin attribution, export safety, and operational boundary enforcement.

**Tasks**:

7.1. Thread `AlertConfig` through runtime audit-store initialization and define the supported configuration surface for critical-event alerting.

7.2. Add tests for:

- critical-event detection
- webhook alert dispatch
- Slack alert dispatch
- alert-delivery failure isolation

  7.3. Improve actor propagation usage around `withAuditActor(...)` for plugin-backed writes on sensitive models.

  7.4. Ensure plugin-written rows are explicitly classifiable by the shared codec so they no longer masquerade as canonical shared rows.

  7.5. Harden Studio archive/export paths so tenant scoping is explicit and tested end to end.

  7.6. Add admin UI regression coverage for audit CSV export and response-shape compatibility.

  7.7. Add whole-system contract tests that prove:

- append-only behavior
- tenant isolation
- actor attribution
- trace lookup
- compatibility decode for legacy rows

  7.8. Update the audit docs after implementation so architecture docs, testing guide, and consolidated review all reflect the hardened design.

**Files Touched**:

- `packages/compiler/src/platform/stores/audit-store.ts`
- `packages/compiler/src/__tests__/audit-store-alerting.test.ts`
- `packages/database/src/mongo/plugins/audit-trail.plugin.ts`
- `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts`
- `apps/runtime/src/services/audit-store-singleton.ts`
- `apps/studio/src/app/api/archives/audit-export/route.ts`
- `apps/studio/src/__tests__/api-routes/audit-export-route.test.ts`
- `apps/runtime/src/__tests__/integration/audit-contract.integration.test.ts`
- `apps/admin/src/app/(dashboard)/audit/page.tsx`
- `apps/admin/src/__tests__/audit-page-export.test.ts`
- `docs/features/audit-logging.md`
- `docs/specs/audit-logging.hld.md`
- `docs/testing/audit-logging.md`
- `docs/audit/audit-log-consolidated-review.md`

**Exit Criteria**:

- [ ] Alerting is wired, configurable, and tested for failure isolation.
- [ ] Plugin-backed writes can be attributed to the acting user in supported request paths.
- [ ] Shared export path is tenant-safe under test.
- [ ] Admin CSV export/UI survives shared response-shape changes.
- [ ] Whole-system contract tests pass for shared audit guarantees.
- [ ] Audit docs match the implementation.

**Test Lock**:

- Unit: `packages/compiler/src/__tests__/audit-store-alerting.test.ts`
  - critical event detection
  - webhook/Slack dispatch
  - failure isolation
- Unit: `packages/database/src/__tests__/audit-trail-actor-propagation.test.ts`
  - actor context captured
  - missing actor path degrades safely
  - plugin rows remain classifiable
- Integration: `apps/studio/src/__tests__/api-routes/audit-export-route.test.ts`
  - tenant-safe export
  - admin authorization
  - no cross-tenant row leakage
- Integration: `apps/runtime/src/__tests__/integration/audit-contract.integration.test.ts`
  - append-only semantics
  - tenant isolation
  - actor attribution
  - trace lookup
  - legacy compatibility decode
- Integration: `apps/admin/src/__tests__/audit-page-export.test.ts`
  - CSV export still works with compatibility-decoded rows

**Rollback**: Revert plugin/export hardening while leaving shared core and feature coverage changes intact.

---

## 5. Wiring Checklist

- [ ] Shared codec exported from the compiler package entrypoints used by runtime, Studio, and Admin.
- [ ] Shared audit schema changes registered in the database model index and safe for existing `audit_logs`.
- [ ] Runtime store singleton reads configuration without fixed-tenant assumptions.
- [ ] Runtime startup wires `onContactAudit` into the contact context.
- [ ] Contact lifecycle actions emit from one boundary only, with no duplicate route-level and domain-level writes.
- [ ] Studio and Admin routes use compatibility decoding rather than raw `JSON.parse` assumptions.
- [ ] SearchAI routes choose the correct sink: shared audit versus connector audit.
- [ ] Shutdown hooks flush buffered shared auth and PII writes.
- [ ] Alert config is threaded through runtime audit-store initialization before critical-event alerting is enabled.
- [ ] Archive/export routes use tenant-scoped queries only.
- [ ] Operational-only surfaces such as omnichannel and Git status/history are explicitly documented and regression-tested.

---

## 6. Cross-Phase Concerns

### Database Migrations

- Add new nullable fields to `audit_logs` in a backward-compatible way.
- Create indexes only after compatibility readers are in place.
- Keep TTL index sparse and disabled operationally until retention rollout is approved.
- Use the compatibility report script before any backfill to measure legacy-shape distribution.
- Run backfill as an additive migration only after canonical readers and writers are already deployed.
- Do not require full historical backfill for initial read compatibility; backfill is for query performance, TTL support, and eventual legacy-reader simplification.
- Add an explicit ClickHouse compatibility report before any trace-compat migration of `audit_events`.
- Do not remove the constructor-time ClickHouse tenant behavior until the replacement read strategy is implemented and tested.

### Retention Policy Matrix

| Subsystem                        | Policy Direction In This Plan                                        | Activation Gate                                     |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Shared Mongo `audit_logs`        | Indefinite by default; per-class TTL only after policy approval      | Retention contract update plus two-step TTL rollout |
| Shared ClickHouse `audit_events` | Maintain current retention until dedicated policy update is approved | ClickHouse compatibility and retention review       |
| KMS audit                        | Keep dedicated compliance retention                                  | No change unless compliance asks for it             |
| PII audit                        | Keep dedicated short-lived TTL with flush hardening                  | PII shutdown flush tests                            |
| Arch AI audit                    | Keep dedicated env-configurable TTL                                  | Regression-only in this plan                        |
| Crawl audit                      | Explicitly classify as immutable audit or operational history        | Phase 5 classification gate                         |
| Omnichannel buffer               | Operational-only memory buffer                                       | Explicit boundary test                              |

### Migration Observability And Capacity Gates

- Emit and review counts for legacy string rows, legacy object rows, plugin rows, canonical rows, and unknown rows before migration.
- Emit and review processed/skipped/failed counts for Mongo and ClickHouse backfills.
- Emit and review rows/day, bytes/day, per-tenant growth, dropped-buffer counters, repeated flush-failure counters, and export job size/duration before enabling TTL or widening rollout.
- Establish a go/no-go review before:
  - enabling canonical runtime writer flags
  - enabling shared TTL
  - running additive backfills in production

### Configuration Changes

- `AUDIT_LOG_TTL_ENABLED`
- `AUDIT_LOG_AUTH_TTL_DAYS`
- `AUDIT_LOG_CRUD_TTL_DAYS`
- `AUDIT_LOG_DEFAULT_TTL_DAYS`

### Rollout Notes

1. Ship Phase 1 shared codec and compatibility inventory first.
2. Ship Phase 3 reader compatibility before Phase 2 canonical writer activation.
3. Run both Mongo and ClickHouse compatibility report scripts before any additive migration.
4. Activate canonical writers behind flags or dual-write only after reader compatibility is deployed.
5. Run additive backfills only after readers and writers are stable and observability gates are green.
6. Reconcile and approve the retention matrix before any shared TTL activation.
7. Enable TTL only after observing production write shape, storage growth, and downgrade safety.
8. Close feature gaps only after shared-path correctness is stable enough to trust.
9. Keep hot-path integration audit fire-and-forget or queue-backed during all phases.

---

## 7. Acceptance Criteria

- [ ] Shared Mongo and ClickHouse backends pass parity tests for the same audit fixtures.
- [ ] Studio and Admin can read legacy and canonical shared rows safely.
- [ ] Existing historical Mongo and ClickHouse records can be classified and, when approved, additively backfilled without data loss.
- [ ] Reader-first rollout is enforced before canonical writer activation.
- [ ] Priority missing feature areas now emit durable audit records.
- [ ] Retention and alerting settings are environment-configurable, and auth-path shared audit uses the runtime singleton backend with shutdown-safe drain behavior.
- [ ] Shared TTL policy is explicit, approved, and rollback-safe before activation.
- [ ] Capacity, backpressure, and migration observability gates are defined and exercised.
- [ ] Plugin-backed writes have explicit actor-propagation coverage.
- [ ] PII buffered audit flushes on shutdown.
- [ ] Operational-only boundaries for omnichannel and similar surfaces are explicitly verified.
- [ ] Archive/export paths are tenant-safe under test.
- [ ] Admin secondary consumers and CSV export remain compatible.
- [ ] Targeted builds for affected workspaces succeed.
- [ ] `pnpm build` succeeds before final full test execution.
- [ ] The targeted audit test suite for all implemented slices passes.
- [ ] Audit docs are updated to reflect the hardened implementation.

---

## 8. Recommended Execution Order

1. Phase 1
2. Phase 3
3. Phase 2
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7

This order is intentional:

- first stabilize the shared contract and inventory legacy data
- then make readers tolerant
- then flip backend parity and canonical writers safely
- then add missing coverage
- then enable retention, sizing, and durability controls
- then close governance-level gaps

---

## 9. Policy Decisions Resolved During Implementation

The policy gates called out during planning are now reflected in the implemented system:

1. Shared-path retention remains indefinite by default in MongoDB, while shared ClickHouse `audit_events` now uses 90-day cold storage plus 730-day delete retention.
2. Studio personal-scope behavior preserves the historical user-wide default and adds an explicit `tenant-safe` mode instead of silently changing semantics.
3. Crawl audit is classified as operational history rather than compliance-grade immutable audit.
