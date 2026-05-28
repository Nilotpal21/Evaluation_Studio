# Feature Spec Log: audit-logging

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-03-22
**Status**: COMPLETED

## Clarifying Questions & Decisions

| #   | Question                                                          | Classification | Answer                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | What storage backends are used for audit logs?                    | ANSWERED       | Dual backend: ClickHouse (`abl_platform.audit_events` with `BufferedClickHouseWriter`) and MongoDB (`audit_logs` collection). InMemory for dev/test. Singleton fallback chain: CH > Mongo > InMemory. Source: `audit-store-singleton.ts`.              |
| 2   | How many audit event types exist?                                 | ANSWERED       | 36 types in `AuditEventType` union (`packages/compiler/src/platform/core/types.ts` line 333) + 50+ constants in `AuditActions` (`apps/studio/src/services/audit-service.ts`).                                                                          |
| 3   | What specialized audit subsystems exist beyond the general store? | ANSWERED       | KMS audit (`kms_audit_log` ClickHouse table, 3yr retention), PII audit (`pii_audit_logs` MongoDB, 90d TTL), tool audit (`ToolAuditLoggerImpl`), crawl audit (`crawl_audit_events` MongoDB), audit trail plugin.                                        |
| 4   | How is audit actor context propagated?                            | ANSWERED       | `AsyncLocalStorage<AuditActorContext>` in the `auditTrailPlugin` (`packages/database/src/mongo/plugins/audit-trail.plugin.ts`). Direct parameter passing in audit helpers.                                                                             |
| 5   | What compliance standards drive retention requirements?           | ANSWERED       | PCI DSS 3.6 requires 3yr KMS audit retention (ClickHouse TTL). GDPR requires PII audit auto-expiry (90d MongoDB TTL). SOC2 requires immutable append-only audit trail. Source: `kms-audit-logger.ts` header comment.                                   |
| 6   | How does the admin audit dashboard work?                          | ANSWERED       | GET `/api/audit` with filters (actor, action, from, to, limit). Admin UI page at `/audit` with table, filters, CSV export. Source: `apps/admin/src/app/(dashboard)/audit/page.tsx`.                                                                    |
| 7   | Does Studio have an audit API?                                    | ANSWERED       | Yes. `GET /api/audit` returns user-scoped logs. `POST /api/archives/audit-export` creates archive manifests. 39 route files call `logAuditEvent()`. Source: `apps/studio/src/app/api/audit/route.ts`.                                                  |
| 8   | How are encrypted fields handled in audit diffs?                  | ANSWERED       | `getModifiedFields()` in the audit trail plugin reads `fieldsToEncrypt` from schema metadata and masks values as `[ENCRYPTED]`. Source: `audit-trail.plugin.ts` line 226-244.                                                                          |
| 9   | How does metadata sanitization work?                              | ANSWERED       | Studio's `sanitizeAuditMetadata()` matches keys against `SENSITIVE_PATTERNS` (password, hash, token, secret, apikey, authorization, cookie, credential) and replaces values with `[REDACTED]`. Source: `audit-service.ts` line 147-167.                |
| 10  | What is the contact audit architecture?                           | ANSWERED       | DDD-style `ContactAuditEmitter` port in `contact-audit.ts` with 7 action types. Decoupled from audit store implementation. Source: `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`.                                                |
| 11  | Is there a dedicated audit UI in Studio for tenants?              | DECIDED        | No tenant-facing audit viewer exists in Studio. Only the platform admin dashboard has an audit UI. This is documented as GAP-009.                                                                                                                      |
| 12  | What happens when audit writes fail?                              | ANSWERED       | Fire-and-forget: all audit helpers wrapped in try-catch. Studio has stderr fallback with `type: 'audit_fallback'`. KMS logger falls back to structured log with `_audit: true`. Source: `audit-helpers.ts`, `audit-service.ts`, `kms-audit-logger.ts`. |

## Key Findings

- The existing feature spec was largely accurate but missing several components: Studio audit service (50+ actions), audit trail Mongoose plugin, contact audit DDD port, auth profile audit events, and several gaps.
- Studio is a major audit producer with 39 route files calling `logAuditEvent()` -- not documented in the original spec.
- The `auditTrailPlugin` provides automatic audit logging for any Mongoose collection it's applied to, using `AsyncLocalStorage` for actor context -- this is a significant architectural pattern not highlighted in the original spec.
- 11 gaps identified (up from 6 in original spec), including unbounded ClickHouse retention, missing Studio audit UI, and `console.log` usage in admin audit logger.

## Files Read

- `packages/compiler/src/platform/stores/audit-store.ts`
- `packages/compiler/src/platform/core/types.ts`
- `packages/compiler/src/platform/constructs/executors/audit-middleware.ts`
- `packages/database/src/models/audit-log.model.ts`
- `packages/database/src/models/pii-audit-log.model.ts`
- `packages/database/src/models/crawl-audit-event.model.ts`
- `packages/database/src/mongo/plugins/audit-trail.plugin.ts`
- `packages/database/src/auth-profile/audit-events.ts`
- `packages/database/src/clickhouse-schemas/init.ts`
- `apps/runtime/src/services/stores/mongo-audit-store.ts`
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts`
- `apps/runtime/src/services/audit-store-singleton.ts`
- `apps/runtime/src/services/audit-helpers.ts`
- `apps/runtime/src/services/tool-audit-logger.ts`
- `apps/runtime/src/services/kms/kms-audit-logger.ts`
- `apps/runtime/src/services/execution/pii-audit-store-adapter.ts`
- `apps/runtime/src/services/execution/pii-audit-singleton.ts`
- `apps/runtime/src/repos/audit-repo.ts`
- `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`
- `apps/studio/src/services/audit-service.ts`
- `apps/studio/src/repos/audit-repo.ts`
- `apps/studio/src/app/api/audit/route.ts`
- `apps/studio/src/app/api/archives/audit-export/route.ts`
- `apps/admin/src/lib/audit-logger.ts`
- `apps/admin/src/app/api/audit/route.ts`
- `apps/admin/src/app/(dashboard)/audit/page.tsx`
