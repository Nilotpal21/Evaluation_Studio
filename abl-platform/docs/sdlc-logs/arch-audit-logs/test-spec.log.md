# SDLC Log: B62 Arch AI Audit Logs — Test Spec

**Phase**: Test Spec (Phase 2)
**Date**: 2026-04-12
**Feature Spec**: `docs/features/arch-audit-logs.md`

## Oracle Decisions

| #   | Question                     | Classification | Answer                                                                                                                                                 |
| --- | ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Highest risk FRs?            | DECIDED        | Emitter hot-path performance (FR-5) + tenant isolation (FR-10). Emitter is on the SSE streaming path; isolation is a platform invariant.               |
| 2   | Known edge cases?            | INFERRED       | Stream abort losing final step tokens (GAP-001 in feature spec). Concurrent emitters from parallel BUILD agents.                                       |
| 3   | Current test baseline?       | ANSWERED       | Zero — no existing audit log tests.                                                                                                                    |
| 4   | External deps needing mocks? | ANSWERED       | None. Only MongoDB, which is real in all tests. No LLM, no ClickHouse, no Redis.                                                                       |
| 5   | Test environment?            | ANSWERED       | Docker MongoDB or mongodb-memory-server. No special CI config.                                                                                         |
| 6   | Critical E2E journeys?       | DECIDED        | emit→store→query, tenant isolation (bidirectional), pagination+filters, session timeline, summary aggregation, cost breakdown, CSV export, date range. |
| 7   | Auth combinations?           | ANSWERED       | Single level: requireTenantAuth (workspace admin). No per-project or per-user permission variants.                                                     |
| 8   | Service boundaries?          | DECIDED        | AuditLogEmitter→MongoDB (write path), Route handler→MongoDB aggregation (read path), CSV serialization (export path).                                  |
| 9   | Race conditions?             | INFERRED       | Low risk — emitter is per-request. Parallel emitters from concurrent requests write to different buffers. No shared state.                             |
| 10  | Error paths?                 | DECIDED        | MongoDB down during flush (emitter swallows), invalid filter params (400), missing auth (401), non-existent session (empty array).                     |

## Test Counts

- **E2E scenarios**: 8
- **Integration scenarios**: 8
- **Unit scenarios**: 11
- **Security checks**: 9
- **Performance tests**: 3
- **Total planned test files**: 9

## Files Created/Updated

- `docs/testing/arch-audit-logs.md` — full test spec (replaced placeholder)
- `docs/sdlc-logs/arch-audit-logs/test-spec.log.md` — this file
