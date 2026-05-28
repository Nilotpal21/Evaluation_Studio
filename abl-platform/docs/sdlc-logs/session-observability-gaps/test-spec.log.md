# Test Spec Log — Session Observability Gaps

**Date**: 2026-03-26
**Phase**: TEST-SPEC
**Feature**: session-observability-gaps

## Oracle Decisions

All 15 clarifying questions were answered autonomously (0 AMBIGUOUS).

| #   | Question                   | Classification | Key Decision                                                                                                        |
| --- | -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Q1  | Highest risk items         | ANSWERED       | Item 1 (lifecycle centralization, 14 call sites), Item 2 (circuit breaker), Item 5 (per-turn synthesis)             |
| Q2  | Known edge cases           | INFERRED       | 7 silent failure points, double lifecycle on WS/zero on others, false dedup, swallowed catch                        |
| Q3  | Current coverage baseline  | ANSWERED       | 6 ordering tests for persistence queue, 0 for lifecycle/synthesis/span-synthesis                                    |
| Q4  | Mock vs real               | INFERRED       | Mock MongoDB/Redis/BullMQ for unit; real for E2E via MongoMemoryServer + server harness                             |
| Q5  | Test environment           | ANSWERED       | Vitest with forks pool; MongoMemoryServer; random-port Express for E2E                                              |
| Q6  | Critical E2E journeys      | INFERRED       | REST lifecycle traces, multi-turn, MongoDB outage recovery, synthetic messages, partial lifecycle                   |
| Q7  | Auth combinations          | DECIDED        | Reuse existing `devLogin`/`bootstrapProject` — no new auth surfaces                                                 |
| Q8  | Cross-feature interactions | INFERRED       | Handoff lifecycle, SDK embed, flow vs reasoning mode, encryption + retry, CH dual-write                             |
| Q9  | Data seeding               | INFERRED       | `bootstrapProject()` helper; echo agent; sequential POST for multi-turn                                             |
| Q10 | Performance scenarios      | DECIDED        | Targeted unit assertions only — algorithmic complexity is low                                                       |
| Q11 | Integration boundaries     | ANSWERED       | 5 boundaries from LLD (executor→TraceStore, persist→BullMQ, worker→MongoDB, handler→executor, WS→no-dupes)          |
| Q12 | Event-driven flows         | INFERRED       | BullMQ persistence queue, trace event pipeline, webhook channel handlers                                            |
| Q13 | Tenant isolation           | INFERRED       | Circuit breaker is cross-tenant ('system'), trace events include tenantId, synthesis is session-scoped              |
| Q14 | Race conditions            | INFERRED       | Concurrent persistMessage, CB state transitions under load, handoff recursion, buffer flush atomic swap             |
| Q15 | Error/failure paths        | INFERRED       | MongoDB down, Redis down, onTraceEvent throws, half-open probe fails, max attempts exceeded, encryption unavailable |

## Decisions Made

| #   | Decision                                   | Rationale                       |
| --- | ------------------------------------------ | ------------------------------- |
| D-1 | Auth scope: reuse existing patterns        | No new auth surfaces introduced |
| D-2 | Performance: targeted unit assertions only | Low algorithmic complexity      |
