# SDLC Log: B62 Arch AI Audit Logs — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-04-11
**Backlog**: `docs/arch/backlogs/B62-arch-audit-logs.md`

## Oracle Decisions

### Scope & Problem

| #   | Question                                     | Classification | Answer                                                                                                                                                                                      |
| --- | -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Relationship to platform audit-logging?      | DECIDED        | Completely separate. Platform audit uses ClickHouse + AuditStore for compliance (SOC2/HIPAA). B62 is Studio-only operational telemetry in MongoDB. Future bridge possible but not in scope. |
| 2   | Scope limited to admin page or also chat UI? | ANSWERED       | Admin settings page only. User decided "workspace-level admin only."                                                                                                                        |
| 3   | Capture ONBOARDING + IN_PROJECT or just one? | INFERRED       | Both modes. Same `message/route.ts` hot path, same `streamText()` calls. No reason to exclude either.                                                                                       |
| 4   | Export scoped to filter view or all data?    | DECIDED        | Scoped to current filter view with date range. All-time export risks large payloads.                                                                                                        |
| 5   | Privacy concern with userId in logs?         | INFERRED       | No additional concern. userId (not PII like email) already stored in ArchSession/ArchJournal. tenantIsolationPlugin scopes queries.                                                         |

### User Stories & Requirements

| #   | Question                                     | Classification | Answer                                                                                       |
| --- | -------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| 6   | Primary persona?                             | ANSWERED       | Workspace admin (tenant admin). `/admin/arch` is workspace-scoped, uses `requireTenantAuth`. |
| 7   | Cost breakdown per-workspace or per-project? | DECIDED        | Both. Top-level is per-workspace. Drill into per-project when projectId available.           |
| 8   | Session ID click behavior?                   | DECIDED        | Inline timeline expansion. Navigating away loses filter context.                             |
| 9   | Full-text search needed?                     | DECIDED        | Not for v1. Category + phase + severity + date range filtering is sufficient.                |
| 10  | Trends over time?                            | DECIDED        | Current-period totals only for v1. KPI cards with single numbers.                            |

### Technical & Architecture

| #   | Question                        | Classification | Answer                                                                                                                          |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Emitter passing strategy?       | DECIDED        | Pass as parameter (like existing `emit` SSE function). AsyncLocalStorage adds unnecessary complexity for Studio Next.js routes. |
| 12  | onFinish reliability on abort?  | INFERRED       | `onFinish` does NOT fire on abort. Use `onStepFinish` for per-step capture as safety net. Accumulate totals in emitter.         |
| 13  | Use tenantIsolationPlugin?      | ANSWERED       | Yes. Both ArchSession and ArchJournal use it. Platform invariant.                                                               |
| 14  | Separate Zustand store?         | DECIDED        | Yes — `useArchAuditStore`. Different state shape (filters, pagination, entries) from config store.                              |
| 15  | Auth pattern for API endpoints? | ANSWERED       | Use `requireTenantAuth` from `@/lib/auth`. Same as existing Arch AI routes.                                                     |

### User Decisions (explicit)

- Retention: 90 days default
- Access: Workspace-level admin only
- Real-time: Manual refresh button, no WebSocket/polling
- Token budget alerts: Not included

## Files Created

- `docs/features/arch-audit-logs.md` — feature spec
- `docs/testing/arch-audit-logs.md` — testing guide placeholder
- `docs/sdlc-logs/arch-audit-logs/feature-spec.log.md` — this file
