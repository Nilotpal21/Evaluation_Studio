# Audit Log Consolidated Review

> Historical snapshot: this review reflects the codebase state on 2026-04-16, before the shared audit migration settled on the current Kafka -> ClickHouse architecture. Some conclusions in this document no longer match the live implementation. For current state, use [docs/audit/audit-log-system-deep-dive.md](./audit-log-system-deep-dive.md), [docs/features/audit-logging.md](../features/audit-logging.md), [docs/specs/audit-logging.hld.md](../specs/audit-logging.hld.md), and [docs/testing/audit-logging.md](../testing/audit-logging.md).

Date: 2026-04-16

Scope: one consolidated source-level review of the audit logging system across the `abl-platform` monorepo.

This document combines:

- intended design
- actual implementation behavior
- architectural assessment
- feature coverage
- external integration audit coverage
- product surface visibility
- known conflicts and gaps

This document is based on code inspection plus the existing audit docs. It is not based on docs alone.

Related references:

- `docs/features/audit-logging.md`
- `docs/specs/audit-logging.hld.md`
- `docs/testing/audit-logging.md`
- `docs/audit/audit-log-system-deep-dive.md`
- `docs/audit/audit-log-feature-coverage-matrix.md`

## 1. Direct Answers

### Do we have audit logging in the codebase?

Yes.

The platform clearly has real audit logging infrastructure and many real audit write paths.

### Is it implemented properly?

Partially.

Some subsystems are implemented well. The shared generic layer is not implemented cleanly enough yet to be trusted as a unified audit backbone.

### Is this the correct solution?

The architectural direction is correct.

The codebase is aiming for:

- structured append-only audit events
- shared audit abstractions
- fire-and-forget writes
- retention by compliance domain
- dedicated audit stores where appropriate

That is the right direction. The implementation has drifted and is now uneven.

### Is it architecturally sound and future-ready?

Not yet as one unified platform-wide audit system.

It is architecturally promising, but only partially future-ready. The strongest parts are the dedicated domain-owned audit systems. The weakest part is the shared generic layer.

### Will this conflict with existing design assumptions in the code?

The document does not create new conflict. It surfaces conflict that already exists in the implementation.

Current tensions include:

- canonical audit contract exists, but backends do not preserve it consistently
- some things called "audit" are logger-only or memory-only
- some audit flows are domain-owned and strong, while shared generic flows are weaker
- some operational history is intentionally externalized to Git or ArgoCD rather than stored in the shared audit system
- current shared-model assumptions lean toward indefinite retention, while a newer TTL design direction would introduce per-document expiry for some shared audit classes

## 2. What The Codebase Is Designed For

The intended design is documented in:

- `docs/features/audit-logging.md`
- `docs/specs/audit-logging.hld.md`

At a high level, the system is designed for:

1. A shared audit contract
   - structured events with tenant, project, actor, resource, action, environment, metadata, and trace context
2. Shared runtime audit infrastructure
   - one `AuditStore` abstraction with multiple backends
3. Dual-backend storage
   - ClickHouse for high-volume analytics
   - MongoDB for durability and fallback
4. Fire-and-forget writes
   - audit should not block or fail business operations
5. Dedicated audit subsystems for special compliance domains
   - KMS
   - PII
   - connector audit
   - crawl audit
   - Arch AI audit
6. Audit consumers
   - Studio API and UI
   - Admin API and UI
   - dedicated query/export APIs for some domains

This means the codebase was clearly designed to treat audit logging as a platform concern, not as ad hoc logging.

## 3. What The Codebase Actually Has Today

The current implementation is not one audit system. It is a family of audit systems.

### Shared / generic audit pieces

- `packages/compiler/src/platform/stores/audit-store.ts`
- `packages/compiler/src/platform/core/types.ts`
- `apps/runtime/src/services/audit-store-singleton.ts`
- `apps/runtime/src/services/audit-helpers.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `packages/database/src/models/audit-log.model.ts`

### Dedicated audit subsystems

- KMS audit
- PII audit
- connector audit
- crawl audit
- Arch AI audit
- omnichannel event history
- Mongoose audit trail plugin

### Shared sink

The main shared Mongo sink is `audit_logs`, but it is not one clean normalized schema.

## 4. High-Level Architecture Assessment

### What is strong

These areas look architecturally solid or at least directionally strong:

- KMS audit
- PII audit
- connector audit
- Arch AI audit
- the existence of a shared `AuditStore` abstraction
- broad Studio audit instrumentation
- broad runtime route-level audit instrumentation

### What is weak

These are the main structural weaknesses:

- shared Mongo `audit_logs` is heterogeneous
- generic runtime ClickHouse behavior does not preserve the contract cleanly
- some feature areas use durable audit while others only use logs or memory
- plugin actor attribution looks incompletely wired
- export/query story is fragmented
- not all features that look intended for audit have a clear production write path

### Bottom-line architecture judgment

This is not a bad architecture choice.

It is an incomplete design convergence.

The repo did not make the wrong bet. It made a good bet and then accumulated implementation drift.

## 5. Why The Shared Generic Layer Is Not Yet Unified

When I say the shared generic audit layer is not fully unified or future-ready, I mean:

### 5.1 Schema inconsistency

Different writers use the same shared sink differently.

Examples:

- Studio writes `metadata` as a JSON string
- Admin writes `metadata` as a JSON string
- runtime auth writes `metadata` as an object
- runtime Mongo audit store writes `metadata` as an object
- SearchAI generic audit writes `metadata` as an object
- the Mongoose plugin writes a different row shape entirely into the same `audit_logs` collection

So the shared collection is not one stable audit schema.

### 5.2 Backend inconsistency

Mongo and ClickHouse do not behave like interchangeable implementations of the same contract.

Examples:

- top-level fields are not always preserved the same way
- `eventType` and `action` are not handled consistently
- generic ClickHouse trace lookup is not aligned with how rows are written
- tenant scoping in some generic read paths is fragile

### 5.3 Audit versus operational logging confusion

Some paths are true audit records.

Some paths are only:

- `logger.info(...)`
- `console.log(...)`
- in-memory ring buffers

Those are useful operationally, but they are not the same as durable compliance-grade audit records.

### 5.4 Future-readiness problem

If new features keep plugging into the current shared layer without cleanup, the likely outcome is:

- more schema drift
- more custom readers
- more audit ambiguity
- harder export and compliance work
- harder incident investigation

## 6. Storage And Sink Map

If someone asks "where do audit logs actually go?", the right answer is: it depends on the feature.

Common sinks include:

- Mongo `audit_logs`
- ClickHouse `abl_platform.audit_events`
- Mongo `pii_audit_logs`
- ClickHouse `abl_platform.kms_audit_log`
- Mongo `arch_audit_logs`
- Mongo `connector_audit_entries`
- Mongo `crawl_audit_events`
- memory only
- application logs only

### TTL And Retention Design Input

A separate TTL design note was also reviewed during this pass.

Its main idea is:

- control `audit_logs` growth through per-document TTL
- classify shared audit rows into retention classes such as `auth`, `crud`, and `default`
- add `expiresAt` to shared audit rows
- use a sparse TTL index on `expiresAt`
- keep TTL numbers configurable per environment with sensible default fallbacks
- roll out writers first, then the TTL index, then observe before any historical backfill

The strongest motivation in that note is the runtime auth path, especially high-volume authenticated execution flows such as `/api/v1/chat/agent`, where:

- the chat router is mounted under `/api/v1/chat`
- the chat router uses `authMiddleware`
- unified auth emits auth events inline
- runtime writes those auth events through the buffered `auth-repo` path

That means the request path does not wait for Mongo, but auth audit volume can still dominate long-term storage growth.

What I verified in the current repo:

- the shared `AuditLog` model in `packages/database/src/models/audit-log.model.ts` does not currently include `expiresAt`
- I did not find shared audit TTL env vars such as `AUDIT_LOG_AUTH_TTL_DAYS`
- I did not find the shared `audit_logs` TTL migration described in the external design note
- runtime auth audit is still buffered best-effort with hardcoded values:
  - 250ms flush interval
  - batch size 100
  - max buffer size 5,000
  - lossy overflow behavior when the buffer is full

Those auth-audit buffering controls should not stay hardcoded long-term. They should be configurable per environment, with default fallback values, so the platform can tune:

- flush interval
- max batch size
- max buffer size
- overflow posture

without code changes across dev, staging, and production.

Architectural assessment of the TTL direction:

- it is a sensible design direction for storage control
- it is especially relevant for high-volume auth success events
- it is not implemented yet in the shared audit path
- it would conflict with some current assumptions that shared audit logs are indefinite-retention or anonymize-only

So if the team adopts TTL for shared audit logs, that should be treated as an explicit policy decision, not just a technical optimization.

The key question it forces is:

- which shared audit classes are true compliance-grade records
- and which are really operational/forensic records with finite retention

If the team adopts TTL, the retention values should not be hardcoded in code paths. They should stay configurable per environment, with default fallback values so:

- dev can use shorter retention
- staging can use medium retention
- production can use longer retention
- new writers still get a safe default when no explicit override is provided

The same principle should apply to runtime auth-audit buffering controls:

- shorter/lower values in dev if desired
- more production-safe values in higher environments
- safe defaults when environment-specific overrides are absent

## 7. Product Surfaces: Where Audit Information Appears

### Studio

Studio exposes generic audit logs through:

- `apps/studio/src/app/api/audit/route.ts`
- `apps/studio/src/components/admin/SecurityPage.tsx`

Arch AI has its own Studio audit UI and APIs.

### Admin

Admin exposes its own audit history through:

- `apps/admin/src/app/api/audit/route.ts`
- `apps/admin/src/app/(dashboard)/audit/page.tsx`

Important product note:

The admin UI explicitly frames itself as admin UI access history and points config/secret mutation history to Bitbucket and ArgoCD.

- some audit-related fallback logs or logger-only paths may appear in Coroot if application logs are ingested there
- Coroot should not be treated as the authoritative audit ledger

## 8. Feature Coverage Overview

The detailed per-feature matrix is documented separately in:

- `docs/audit/audit-log-feature-coverage-matrix.md`

The summary is below.

### Strongly covered feature areas

- Studio login / password / email verification / MFA flows
- Studio workspace, project, membership, invitation, organization, tool, credential, model, and service-node operations
- runtime contacts CRUD routes
- runtime sessions, workflows, versions, DSL updates, and async subscription lifecycle
- runtime OAuth and channel OAuth
- runtime tool execution
- runtime KMS and PII
- SearchAI connectors
- connector sync lifecycle
- connector proposal/config lifecycle
- Arch AI

### Partially covered feature areas

- contact lifecycle via the DDD contact context
- crawl audit
- admin UI audit
- shared `AuditStore` layer
- shared `audit_logs` sink
- generic ClickHouse audit path
- export/archive story
- alerting hooks
- Mongoose plugin actor/context behavior

### Operational-only or weakly covered feature areas

- omnichannel audit
- SearchAI field mappings
- inbound SharePoint webhook handling
- Git integration create/update/delete
- Git webhook receiver
- admin config/secret mutation history inside the admin audit UI

### Missing or unclear feature areas

- Studio logout
- Studio token lifecycle actions
- Studio device auth actions
- Studio SSO actions
- Studio archive actions
- MFA disable
- module delete blocked
- connector notification preference / test-webhook actions
- SearchAI custom-domain / taxonomy helper callsites

## 9. External Integration Logs

External integration logging is mixed.

### Stronger external integration audit

- SearchAI connector audit
  - dedicated model
  - dedicated service
  - dedicated query/export routes
- connector sync lifecycle
- connector setup and config management
- runtime OAuth
- runtime channel OAuth
- Studio service-node integration config changes

### Weaker external integration audit

- inbound SharePoint webhooks are mostly app logs
- connector notification preference and webhook test flows do not have a clear dedicated audit write path
- SearchAI field mappings are logger-only
- Git integration config in Studio uses app logging rather than clear durable audit writes
- Git webhook handling is app logging, not first-class audit

So for integrations, the strongest story is around connectors and OAuth. The weakest story is around webhook receivers, field mapping review flows, and Git integration handling.

## 10. Dedicated Audit Systems

These are the most trustworthy audit subsystems in the codebase today.

### KMS audit

Strengths:

- dedicated ClickHouse table
- strong compliance purpose
- explicit retention
- dedicated route surfaces

### PII audit

Strengths:

- dedicated model
- dedicated logger
- explicit sensitive-access semantics

Caveat:

- buffered shutdown behavior still matters

### Connector audit

Strengths:

- dedicated collection
- dedicated service
- clear categories
- dedicated query/export path

### Arch AI audit

Strengths:

- dedicated subsystem
- dedicated APIs
- dedicated UI
- clearly queryable

## 11. Key Architectural Tensions With Existing Design Assumptions

These tensions already exist in the code.

### Canonical contract versus actual storage

The repo has a shared audit contract, but storage backends and writers do not consistently preserve it.

### Compliance-grade audit versus operational history

Some features are clearly designed as audit.

Some are clearly only:

- observability
- operational event history
- externalized history

The naming does not always make that distinction clear.

### Traceability assumption

The platform wants strong traceability, but generic shared paths do not always preserve trace identity cleanly.

### Isolation assumption

The broader platform values strong tenant and project isolation. Some shared audit query paths are weaker than that ideal.

### Externalized history assumption

Some areas intentionally rely on external systems such as:

- Git
- Bitbucket
- ArgoCD

That is not necessarily wrong, but it means "the audit system" is not one self-contained internal platform component.

### Retention assumption

Some current shared-layer comments and behavior imply long-lived or indefinite retention for shared audit logs.

The separate TTL design note points in a different direction:

- short-to-medium retention for high-volume auth events
- longer retention for CRUD plugin rows
- medium retention for default shared rows
- configurable values per environment with fallback defaults rather than fixed numbers baked into code

That is a valid design direction, but it is not neutral. It changes the platform's current retention assumptions and should be adopted deliberately.

## 12. Is This Really Future-Ready?

Not yet as one platform-wide audit solution.

The most future-ready parts are the domain-owned dedicated systems:

- KMS
- PII
- connector audit
- Arch AI audit

The least future-ready part is the shared generic layer.

To become future-ready, the platform likely needs:

1. one canonical audit event contract enforced consistently
2. clear separation between compliance audit and operational logging
3. normalized or clearly partitioned shared sinks
4. explicit actor attribution, scoping, traceability, retention, and export rules
5. platform-level contract tests

It also likely needs an explicit answer on shared audit retention:

- indefinite retention for all shared rows
- or policy-based TTL by audit class

If TTL is adopted, the better version is:

- policy-based TTL by audit class
- configurable per environment
- with safe fallback defaults when env-specific overrides are not set

## 13. Recommended Direction

The best path forward is not a rewrite.

It is consolidation and hardening.

### Keep

- KMS audit
- PII audit
- connector audit
- Arch AI audit
- the shared `AuditStore` concept

### Fix

- shared Mongo `audit_logs`
- generic runtime ClickHouse contract behavior
- actor propagation in plugin/shared paths
- export and archive story
- contact-domain audit wiring
- audit classification for integration-heavy paths
- shared audit retention policy and TTL classification

TTL policy should be expressed as configuration, not as fixed constants spread across writers.

Runtime auth-audit buffering policy should also be expressed as configuration, not hardcoded constants.

### Reclassify clearly

These should either become durable audit or be explicitly documented as operational-only:

- omnichannel audit
- SearchAI field mapping "audit"
- inbound webhook processing logs
- some Git integration history

## 14. Highest-Value Gaps To Address First

1. Normalize or split the shared `audit_logs` sink
2. Fix generic ClickHouse contract drift
3. Make actor attribution reliable in plugin-generated rows
4. Finish contact-domain audit wiring
5. Decide which paths are truly audit versus operational only
6. Decide whether shared `audit_logs` remains indefinite-retention or adopts policy-based TTL
7. Close integration audit gaps
   - Git integration
   - webhook handling
   - connector notification test flows
   - field mappings
8. Build tenant-safe export/query behavior
9. Add contract-level tests

## 15. Confidence And Limitations

Confidence level: medium-high.

Why:

- high confidence in the broad architecture and the major mismatches
- high confidence in the stronger dedicated subsystems
- medium confidence on total edge-case feature coverage without runtime validation

Limitations:

- this review is based on source inspection, not full live-system verification
- `Missing / unclear` means no strong write path was found in this pass
- it should not be read as proof that no audit exists anywhere for a feature

## 16. Final Bottom Line

The audit system in this repo is real, broad, and important.

But it is not yet one clean, unified, future-ready platform audit solution.

The right way to describe it is:

- broad audit coverage
- uneven audit quality
- strong dedicated subsystems
- weaker shared generic layer
- clear path to improvement without a rewrite
