# SDLC Log: Transcripts — Test Spec Phase

**Feature**: Transcripts
**Phase**: Test Spec (Phase 2 of 6)
**Date**: 2026-03-23
**Status**: COMPLETE

---

## Product Oracle Decisions

### Test Scope & Priorities

| #   | Question                             | Answer                                                                                                                                                                    | Classification |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Highest risk FRs?                    | FR-1 (tenant isolation), FR-3 (auth), FR-10 (encryption) are highest risk -- security failures here are data breaches. FR-4 (on-demand generation) is highest complexity. | DECIDED        |
| 2   | Known edge cases from production?    | Prototype has path traversal risk (req.params.id used directly in file path). Also, large sessions (1000+ messages) may hit memory limits during compression.             | ANSWERED       |
| 3   | Current test coverage baseline?      | Existing `transcript-routes.test.ts` has 15 unit tests but all mock fs/promises and the runtime executor. Zero E2E coverage. Zero integration coverage with real MongoDB. | ANSWERED       |
| 4   | External dependencies needing mocks? | Only ClickHouse for trace enrichment (optional). MongoDB and Redis are internal and should be real in integration/E2E tests.                                              | DECIDED        |
| 5   | Test environment?                    | MongoMemoryServer for unit/integration. Docker MongoDB + Redis for E2E. CI uses GitHub Actions with service containers.                                                   | INFERRED       |

### E2E Scenarios

| #   | Question                    | Answer                                                                                                                                                               | Classification |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Critical user journeys?     | Full CRUD lifecycle, cross-tenant isolation, auth enforcement, pagination with filters, structured content round-trip.                                               | DECIDED        |
| 2   | Auth combinations?          | No auth (401), valid token (200), expired token (401), wrong tenant (404), wrong project (404), viewer role (read-only), developer role (CRUD), admin role (all).    | INFERRED       |
| 3   | Cross-feature interactions? | Session deletion cascading to transcript deletion (right-to-erasure). Pipeline engine's ConversationReader pattern reuse.                                            | ANSWERED       |
| 4   | Data seeding?               | Need sessions with encrypted messages, multiple tenants, multiple projects, multiple users with different roles. Structured content including ContentBlock[] arrays. | DECIDED        |
| 5   | Performance scenarios?      | Large session (1000 messages) creation and export. Concurrent list requests. Compression ratio verification.                                                         | INFERRED       |

---

## Audit Log

| Round | Date       | Findings                                                                                                                                                                                                                                                           | Resolution         |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 1     | 2026-03-23 | Quality gates: 8 E2E scenarios (exceeds min 5), 7 integration scenarios (exceeds min 5), all 15 FRs in coverage matrix, security section filled with concrete checks, auth context on all E2E scenarios, no mocks in E2E, structured content types tested (E2E-8). | All gates pass.    |
| 2     | 2026-03-23 | Cross-phase consistency: Test scenarios map to all FRs from feature spec. Test file mapping includes concrete file paths following existing patterns (sessions-authz.test.ts pattern). Performance targets align with success metrics in feature spec.             | No changes needed. |

---

## Files Created/Updated

- `docs/testing/transcripts.md` — Full test specification (replaced placeholder)
- `docs/sdlc-logs/transcripts/test-spec.log.md` — This file
