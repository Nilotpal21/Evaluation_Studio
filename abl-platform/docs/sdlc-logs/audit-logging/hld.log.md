# HLD Log: audit-logging

**Phase**: HLD (Phase 3)
**Date**: 2026-03-22
**Status**: COMPLETED

## Changes from Previous Version

- Added system context diagram showing all three apps (Studio, Runtime, Admin) and their audit write paths
- Added comprehensive data flow diagram including Mongoose plugin path, Studio audit service, and specialized subsystems
- Expanded task decomposition from 10 to 16 tasks to reflect actual implementation scope
- Added all 12 architectural concerns with code evidence
- Added decisions & tradeoffs table with 10 decisions (up from 6)
- Documented the Mongoose `auditTrailPlugin` as a distinct architectural component
- Documented Studio audit service as a distinct component (50+ AuditActions, metadata sanitization)
- Added contact audit DDD port, auth profile audit events, and crawl audit events as tracked tasks
- Added ClickHouse schema DDL as a tracked task
- All tasks marked as DONE (feature is fully implemented)

## Architecture Key Points

1. **Five-layer architecture**: Type layer (compiler) -> Storage layer (store implementations) -> Domain helper layer (fire-and-forget functions) -> Specialized subsystems (KMS, PII, tool, crawl, Mongoose plugin) -> Consumer layer (Studio, Admin APIs/UI)
2. **Three independent audit write paths**: Studio (`logAuditEvent`), Runtime (`auditXxx` helpers + AuditStore), Admin (`logAdminAction`). All converge on the same MongoDB `audit_logs` collection.
3. **Specialized storage per compliance domain**: General audit in both ClickHouse and MongoDB. KMS in ClickHouse only (3yr). PII in MongoDB only (90d TTL). Crawl in MongoDB (no TTL).
4. **Actor context propagation**: `AsyncLocalStorage<AuditActorContext>` for Mongoose plugin; explicit parameters for audit helpers.

## Open Questions from HLD

1. Should audit_events ClickHouse table have a DELETE TTL? Currently only moves to cold storage at 90 days, never deleted.
2. Should the crawl_audit_events collection have a retention policy?
3. Should the three audit write paths (Studio, Runtime, Admin) be unified into a shared service?
