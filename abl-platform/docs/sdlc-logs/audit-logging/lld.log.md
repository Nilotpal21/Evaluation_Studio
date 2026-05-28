# LLD Log: audit-logging

**Phase**: LLD (Phase 4)
**Date**: 2026-03-22
**Status**: COMPLETED

## Changes from Previous Version

- Expanded from 10 tasks to 16 tasks to document all implemented components
- Added complete function signatures for all audit helpers (20+ functions)
- Added wiring checklist with 12 wiring points (all verified DONE)
- Added remediation plan for all 11 gaps with severity and phase classification
- Added rollback plan with 5 incremental rollback options
- Documented Studio audit service (T-11) with 50+ AuditActions
- Documented audit trail Mongoose plugin (T-10) with AsyncLocalStorage details
- Documented contact audit DDD port (T-13) and auth profile audit events (T-14)
- Documented ClickHouse schema DDL (T-15) and crawl audit events (T-16)

## Architecture Observations

1. **Three independent audit write paths**: Studio, Runtime, and Admin each have their own audit service/logger, but all converge on the same MongoDB `audit_logs` collection. This is a pragmatic decision (different app contexts) but creates maintenance burden.
2. **Dual Mongoose audit schemas**: The `auditTrailPlugin` creates its own `audit_log` model (with `collectionName`, `documentId`, `operation`, `changes`) that writes to the same `audit_logs` collection as the `AuditLog` model (with `userId`, `tenantId`, `action`, `metadata`). These have different document shapes in the same collection.
3. **ClickHouse `tenantId` coupling**: The `ClickHouseAuditStore` constructor binds to a single `tenantId`, making multi-tenant queries require store re-instantiation. This is the root cause of GAP-005.
4. **Fire-and-forget is consistent**: Every single audit write path (22 helpers, 2 store implementations, 3 specialized loggers, 1 Mongoose plugin) uses try-catch with error suppression. This is a well-enforced architectural invariant.

## Priority Remediation Recommendation

| Priority      | Gaps                                                                   | Effort     | Impact                                                 |
| ------------- | ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| P0 (Critical) | GAP-003 (E2E tests)                                                    | 3-5 days   | Validates entire audit pipeline works end-to-end       |
| P1 (High)     | GAP-005 (CH tenant scoping), GAP-006 (env hardcode)                    | 1 day each | Correctness for multi-tenant and multi-env deployments |
| P2 (Medium)   | GAP-004 (alert tests), GAP-007 (IP validation), GAP-011 (CH retention) | 1 day each | Security and compliance gaps                           |
| P3 (Low)      | GAP-001, GAP-002, GAP-008, GAP-010                                     | Hours each | Code quality and consistency                           |
