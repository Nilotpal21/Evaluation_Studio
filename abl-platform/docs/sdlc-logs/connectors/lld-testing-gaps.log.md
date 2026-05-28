# SDLC Log: Connectors Testing Gaps LLD

**Phase**: LLD (Low-Level Design)
**Feature**: Connectors Testing Gaps
**Date**: 2026-03-22
**Artifact**: `docs/plans/2026-03-22-connectors-testing-gaps-impl-plan.md`

---

## Prerequisites Read

- Feature spec: `docs/features/connectors.md` (BETA, 613 lines)
- HLD: `docs/specs/connectors.hld.md` (DRAFT, 371 lines)
- Test spec: `docs/testing/connectors.md` (IN PROGRESS, 576 lines)
- Existing LLD: `docs/plans/2026-03-22-connectors-impl-plan.md` (architecture convergence)

## Product Oracle Decisions

All 15 clarifying questions answered autonomously (0 AMBIGUOUS):

| #   | Question                  | Classification | Decision                                            |
| --- | ------------------------- | -------------- | --------------------------------------------------- |
| Q1  | Implementation order      | DECIDED        | Integration tests first, then E2E                   |
| Q2  | E2E bootstrap reuse       | INFERRED       | Reuse RuntimeApiHarness + channel-e2e-bootstrap     |
| Q3  | E2E file grouping         | INFERRED       | 5 files per test spec section 8                     |
| Q4  | Fixture placement         | DECIDED        | Shared in packages/connectors/**tests**/fixtures/   |
| Q5  | Skipped test fixes        | DECIDED        | Include as final phase (lower priority)             |
| Q6  | Studio routes testing     | ANSWERED       | Can't use supertest with Next.js App Router         |
| Q7  | E2E-2 agent setup         | INFERRED       | Use deployment API via RuntimeApiHarness            |
| Q8  | Redis for INT-5           | ANSWERED       | Real Redis via redis-server-harness.ts              |
| Q9  | MongoMemoryServer         | ANSWERED       | Already set up in multiple locations                |
| Q10 | DI injection point        | ANSWERED       | RestateIngressClient interface in triggers/types.ts |
| Q11 | Conflicting changes       | ANSWERED       | Architecture convergence LLD modifies same files    |
| Q12 | Wait for Phase 2 refactor | DECIDED        | No — test current API                               |
| Q13 | Biggest risk              | DECIDED        | Infrastructure complexity > scenario completeness   |
| Q14 | SearchAI testability      | ANSWERED       | Mount only connector routes, avoid ClickHouse       |
| Q15 | CI config                 | DECIDED        | Include as Phase 0                                  |

## Audit Rounds

| Round | Focus                   | Auditor       | Verdict       | Findings                            |
| ----- | ----------------------- | ------------- | ------------- | ----------------------------------- |
| 1     | Architecture compliance | lld-reviewer  | NEEDS_CHANGES | 2 CRITICAL, 5 HIGH, 4 MEDIUM, 2 LOW |
| 2     | Pattern consistency     | lld-reviewer  | NEEDS_CHANGES | 4 HIGH, 5 MEDIUM, 1 LOW             |
| 3     | Completeness            | lld-reviewer  | NEEDS_CHANGES | 1 CRITICAL, 5 HIGH, 4 MEDIUM        |
| 4     | Cross-phase consistency | phase-auditor | APPROVED      | 3 HIGH, 2 MEDIUM                    |
| 5     | Final sweep             | lld-reviewer  | NEEDS_CHANGES | 5 HIGH, 2 MEDIUM, 2 LOW             |

### Key Findings Resolved

- **C-1**: File placement — E2E tests placed in runtime (not studio) because Studio uses Next.js App Router
- **C-2**: ConnectionService API signatures — positional params, not object params
- **C3-1**: Permission strings — singular `connection:read/write/delete` per permissions.ts
- **C3-2**: Route registration in server.ts, not routes/index.ts (doesn't exist)
- **P2-1**: E2E tests flat in **tests**/, not in e2e/ subdirectory (per convention)
- **P2-5**: Harness naming convention (*Harness, start*Harness())
- **R5-3**: handleWebhook() is standalone function, not WebhookHandler.handle() class method
- **R5-4**: vitest integration config must exclude from default config

## LLD Summary

8 phases (0-7b):

- Phase 0: CI infrastructure + shared test fixtures (5 new files)
- Phase 1: Integration tests — data layer (INT-1, INT-6, PERF-2)
- Phase 2: Integration tests — service chain + concurrency (INT-2, INT-5, INT-9)
- Phase 3: Integration tests — triggers + webhooks (INT-3, INT-4, INT-7, INT-8, PERF-3) + production fix
- Phase 4: E2E tests — connection CRUD + OAuth (E2E-1, E2E-4, E2E-6) + runtime routes
- Phase 5: E2E tests — triggers + tool execution (E2E-2, E2E-3, E2E-7, E2E-8)
- Phase 6: E2E tests — SearchAI enterprise sync (E2E-5)
- Phase 7: Fix ~47 skipped tests across 5 files
- Phase 7b: Test spec + doc sync

Total new files: 18 test files + 1 production file (runtime connection routes)
