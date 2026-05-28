# SDLC Log: Structured Error Framework — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-03-25
**Skill**: `/feature-spec`

---

## Oracle Decisions

| #   | Question                               | Classification  | Decision                                                                                                                                                 |
| --- | -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What specific problem does this solve? | ANSWERED        | 668 inline error responses across 64 route files, 5 different shapes, zero AppError usage in routes, generic "I encountered an error" messages           |
| 2   | What is explicitly out of scope?       | DECIDED         | Client-side standardization, SearchAI migration, custom error pages, error analytics dashboards, i18n beyond English                                     |
| 3   | Is this new capability or enhancement? | ANSWERED        | Enhancement — AppError/ErrorCodes exist but are unused in routes; classifyLlmError already implemented                                                   |
| 4   | Priority/timeline driver?              | ANSWERED (user) | Customer-blocking — full route migration with dedicated sprint allocation (Option B)                                                                     |
| 5   | Primary personas?                      | INFERRED        | Agent developers, AI agents (self-recovery), support engineers, platform operators, platform developers                                                  |
| 6   | Critical user journeys?                | INFERRED        | Developer sees actionable error in Studio → AI agent retries on transient error → Support filters traces by error code                                   |
| 7   | Must-have vs nice-to-have?             | DECIDED         | Must-have: registry, standard shape, asyncHandler, fitness tests, hooks, security fixes. Nice-to-have: error docs endpoint, Prometheus counter           |
| 8   | Performance requirements?              | INFERRED        | Zero overhead on happy path — classification only in error paths, registry is compile-time constant                                                      |
| 9   | Which packages affected?               | ANSWERED        | shared-kernel (core), runtime (routes/WS/middleware), i18n (message templates), database (MongoAppError alignment)                                       |
| 10  | Data model changes?                    | DECIDED         | No new collections. TraceEvent enriched with errorCode/errorCategory/errorRetryable/errorSource fields                                                   |
| 11  | Security implications?                 | ANSWERED        | 6 information leaks identified (kms-admin, clickhouse-diagnostics, channel-oauth, chat.ts, etc.)                                                         |
| 12  | Deployment strategy?                   | DECIDED         | Incremental ratchet migration — build infra first, migrate routes file-by-file, tighten ceilings to 0                                                    |
| 13  | External dependencies?                 | ANSWERED        | None — pure internal error handling infrastructure                                                                                                       |
| 14  | SDK backwards compatibility?           | DECIDED         | HTTP API migrates immediately (internal consumers). WS adds code field alongside existing message (additive). HTTP async channel documents shape change. |
| 15  | Migration approach for 668 responses?  | ANSWERED (user) | Full migration with dedicated sprint (Option B: customer-blocking priority)                                                                              |

---

## Files Created

| File                                                            | Purpose                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| `docs/features/structured-error-framework.md`                   | Feature spec (18 FRs, 7 user stories, 11-phase delivery)   |
| `docs/testing/structured-error-framework.md`                    | Testing guide placeholder (7 E2E, 6 integration scenarios) |
| `docs/sdlc-logs/structured-error-framework/feature-spec.log.md` | This log file                                              |

## Index Updates

- `docs/features/README.md` — added #85 to NFR section
- `docs/testing/README.md` — added NFR section with #85

## Audit Rounds

| Round | Status         | Findings                                                                                                                    |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1     | NEEDS_REVISION | 1 HIGH (route count 64→94), 2 MEDIUM (FR-5 line ref, error-handler-router.ts desc). All fixed.                              |
| 2     | APPROVED       | 3 MEDIUM (non-blocking, deferred to HLD/LLD): task 1.3/2.2 overlap, Shape A+B arithmetic gap, console.\* count discrepancy. |

## Open Items

- 5 open questions in feature spec (registry format, versioning, docs URL, auth for error endpoint, SDK deprecation period)
- 7 known gaps documented (GAP-001 through GAP-007)

## Next Steps

- Run phase-auditor rounds 1 and 2
- Commit all artifacts
- User runs `/test-spec structured-error-framework` next
