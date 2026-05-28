# SDLC Log: Proactive Messaging — Phase 3 (HLD)

> **Date**: 2026-03-22
> **Phase**: HLD (High-Level Design)
> **Status**: Complete

## Summary

- **All 12 architectural concerns** addressed (resource isolation, auth, stateless, traceability, compliance, performance, error handling, scalability, backwards compatibility, observability, testing, migration)
- **3 alternatives considered** (ExecutionCoordinator reuse, separate microservice, webhook-only)
- **DSL grammar extension** fully specified
- **IR schema extension** (`ProactiveConfigIR`) defined
- **6 component designs** (MessageService, DeliveryWorker, ScheduleService, TriggerService, ConsentService, RateLimiter)
- **Security threat model** with 8 threats and mitigations
- **Capacity planning** for MongoDB, Redis, and BullMQ
- **11 failure modes** with detection and recovery strategies

## Key Architecture Decisions

| #   | Decision                               | Rationale                             |
| --- | -------------------------------------- | ------------------------------------- |
| 1   | Template-only delivery in Phase 1      | Reduces latency, cost, and complexity |
| 2   | BullMQ for delivery pipeline           | Platform-standard, proven reliability |
| 3   | Consent as hard block (no override)    | GDPR/TCPA compliance                  |
| 4   | Feature flag for rollout               | Zero-risk deployment                  |
| 5   | Proactive sessions share session store | Consistent lifecycle                  |

## Audit Round 1

| #   | Severity | Finding                                            | Resolution                                                                        |
| --- | -------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | HIGH     | Circuit breaker pattern mentioned but not detailed | Added circuit breaker spec: Redis counters, 50% failure threshold, 60s open state |
| 2   | HIGH     | Event trigger hot reload across pods not specified | Added Redis Pub/Sub propagation for trigger registry changes                      |
| 3   | MEDIUM   | Rate limiter Lua script not shown                  | Added sorted set sliding window algorithm with ZADD/ZREMRANGEBYSCORE/ZCARD        |
| 4   | MEDIUM   | Channel adapter outbound compatibility not mapped  | Added adapter compatibility matrix (10 channel types)                             |
| 5   | LOW      | Capacity planning could include cost estimates     | Out of scope for HLD — operational concern                                        |

## Audit Round 2

| #   | Severity | Finding                                                                          | Resolution                                                                                                       |
| --- | -------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | MEDIUM   | Eventstore missed events during disconnection — accepted trade-off not justified | Added to failure modes: "accepted trade-off" — event-driven proactive is best-effort, schedule-based is reliable |
| 2   | MEDIUM   | BullMQ concurrency tuning guidance missing                                       | Added limiter config (100 jobs/min/worker)                                                                       |
| 3   | LOW      | Data flow diagrams use ASCII — could be clearer                                  | ASCII is portable, consistent with other HLDs in repo                                                            |

## Audit Round 3

| #   | Severity | Finding                                                                        | Resolution                                                                           |
| --- | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | MEDIUM   | No mention of message deduplication for schedule execution                     | Added distributed lock (Redis SET NX PX) for contact dedup within schedule execution |
| 2   | LOW      | ProactiveTriggerIR `template` is a string reference — validate at compile time | Already covered in FR-10 validation spec                                             |
| 3   | LOW      | Rollback procedure could mention data cleanup                                  | Feature flag disable is sufficient — data remains but is harmless                    |

All CRITICAL and HIGH findings resolved across 3 rounds. Proceeding to Phase 4.
