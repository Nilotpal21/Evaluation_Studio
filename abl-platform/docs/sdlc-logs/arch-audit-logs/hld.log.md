# SDLC Log: B62 Arch AI Audit Logs — HLD

**Phase**: HLD (Phase 3)
**Date**: 2026-04-12
**Feature Spec**: `docs/features/arch-audit-logs.md`
**Test Spec**: `docs/testing/arch-audit-logs.md`

## Oracle Decisions

### Architecture & Data Flow

| #   | Question              | Classification | Answer                                                                                                |
| --- | --------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Architecture pattern? | ANSWERED       | Route handler pattern (Next.js API routes). Same as existing Arch AI routes.                          |
| 2   | Data flow?            | ANSWERED       | Request-path write (emitter in SSE hot path), request-path read (API queries). No event-driven async. |
| 3   | Expected scale?       | INFERRED       | ~5K-50K events/day writes, ~10-50 admin page loads/day reads.                                         |
| 4   | Existing patterns?    | ANSWERED       | Follow ArchJournal pattern (MongoDB collection, tenantIsolationPlugin, API route style).              |
| 5   | Deployment topology?  | ANSWERED       | Single service (Studio Next.js). No workers, no queues.                                               |

### Integration & Dependencies

| #   | Question               | Classification | Answer                                                                                                     |
| --- | ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| 6   | Dependencies?          | ANSWERED       | database (Mongoose), shared-kernel (estimateCost), auth (requireTenantAuth), Vercel AI SDK (onStepFinish). |
| 7   | New external deps?     | ANSWERED       | None. All packages in monorepo.                                                                            |
| 8   | API contract?          | DECIDED        | Standard Studio envelope: { success, entries?, total?, page?, hasMore?, error? }.                          |
| 9   | Breaking changes?      | ANSWERED       | None. New collection, new endpoints, new callbacks.                                                        |
| 10  | Lifecycle interaction? | ANSWERED       | None. Arch AI is design-time only.                                                                         |

### Risk & Migration

| #   | Question       | Classification | Answer                                                                                               |
| --- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| 11  | Biggest risk?  | DECIDED        | SSE regression from onStepFinish callback. Mitigated: callback is non-blocking (array push).         |
| 12  | Migration?     | ANSWERED       | None. New collection from scratch.                                                                   |
| 13  | Rollback?      | DECIDED        | ARCH_AUDIT_LOG_ENABLED=false kills all emission. API routes return empty. Collection can be dropped. |
| 14  | Feature flags? | DECIDED        | Kill switch env var only. Admin-only feature, low blast radius.                                      |
| 15  | Blast radius?  | DECIDED        | Minimal. Worst case: emitter bug blocks SSE. Mitigated: try/catch on every emit/flush.               |

## Self-Audit Checklist

- [x] All 12 architectural concerns addressed with genuine design decisions
- [x] 3 alternatives considered with real trade-offs (A recommended, B over-engineered, C insufficient)
- [x] Architecture diagrams: system context + component + data flow (ASCII)
- [x] Data model: full schema with 6 indexes, TTL, plugins, detail payload types
- [x] API design: 4 endpoints with query params, error responses
- [x] Cross-cutting concerns: audit, rate limiting, caching, encryption, PII, GDPR
- [x] Dependencies: upstream (5) and downstream (3 future consumers)
- [x] 3 open questions
- [x] Problem statement matches feature spec
- [x] Test strategy references real MongoDB, no vi.mock

## Files Created

- `docs/specs/arch-audit-logs.hld.md` — HLD document
- `docs/sdlc-logs/arch-audit-logs/hld.log.md` — this file
