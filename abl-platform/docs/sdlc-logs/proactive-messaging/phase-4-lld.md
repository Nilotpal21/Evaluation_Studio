# SDLC Log: Proactive Messaging — Phase 4 (LLD)

> **Date**: 2026-03-22
> **Phase**: LLD (Low-Level Design & Implementation Plan)
> **Status**: Complete

## Summary

- **5 implementation phases** with strict exit criteria
- **27 new files** + **8 modified files** = **35 total file changes**
- **Estimated effort**: 9-14 days
- **Wiring checklist**: 17 integration points verified
- **Phase-level risk mitigations** for each phase
- **Code-grounded**: All file paths reference actual codebase locations

## Implementation Phases

| Phase | Name                        | Tasks                                                               | Est. Effort | Key Exit Criteria                            |
| ----- | --------------------------- | ------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| 1     | Data Layer & Core Types     | 7 tasks (models, repos, schemas, types)                             | 1-2 days    | 4 models, 4 repos, Zod schemas, build passes |
| 2     | Core Services               | 5 tasks (consent, rate limiter, resolver, message service, session) | 2-3 days    | INT-1,2,3,5,11 pass                          |
| 3     | Delivery Pipeline & API     | 7 tasks (queue, worker, adapter interface, routes, feature flag)    | 2-3 days    | E2E-1,2,4,5 pass                             |
| 4     | Schedules & Triggers        | 5 tasks (schedule service, trigger service, routes, event bus)      | 2-3 days    | E2E-7,8 pass                                 |
| 5     | DSL, Observability & Polish | 7 tasks (parser, compiler, events, metrics, wiring, startup, tests) | 2-3 days    | All 10 E2E pass                              |

## LLD Review Round 1

| #   | Severity | Finding                                                                              | Resolution                                                         |
| --- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1   | HIGH     | ProactiveTriggerService in-memory registry has no TTL or eviction specified          | Added: max size 10,000 with LRU eviction per platform invariant    |
| 2   | HIGH     | Missing distributed lock for schedule execution batches                              | Added: Redis SET NX PX for contact dedup within schedule execution |
| 3   | MEDIUM   | Rate limiter Lua script returns raw numbers — needs typed wrapper                    | Implementation detail; TypeScript wrapper handles type conversion  |
| 4   | MEDIUM   | Channel adapter sendOutbound() modifies existing interface files                     | Only adds new interface, doesn't change existing signatures        |
| 5   | LOW      | Phase 5 depends on Phase 4 for DSL but on Phase 3 for metrics — parallel opportunity | Noted; metrics can start after Phase 3                             |

## LLD Review Round 2

| #   | Severity | Finding                                                                   | Resolution                                                                   |
| --- | -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | MEDIUM   | Wiring checklist missing: output guardrails → delivery worker             | Added to wiring checklist                                                    |
| 2   | MEDIUM   | Server.ts modification (Phase 5) could be large — risk of merge conflicts | Minimal change: single function call to createProactiveServices()            |
| 3   | LOW      | Test file locations not specified in Phase 5                              | Added: test file paths for DSL parser and IR compiler                        |
| 4   | LOW      | No mention of Dockerfile updates if new package dependencies added        | All dependencies already in runtime's package.json (BullMQ, Redis, Mongoose) |

All CRITICAL and HIGH findings resolved across 2 rounds.

## Cross-Phase Consistency Check

| Artifact                                   | Consistent                             |
| ------------------------------------------ | -------------------------------------- |
| FR-1 through FR-10 → LLD phase mapping     | Yes — all FRs covered                  |
| E2E-1 through E2E-10 → phase exit criteria | Yes — all E2E tests assigned to phases |
| INT-1 through INT-13 → phase exit criteria | Yes — all integration tests assigned   |
| HLD component designs → LLD file locations | Yes — 1:1 mapping                      |
| HLD data model → LLD Mongoose schemas      | Yes — identical fields                 |
| HLD API routes → LLD route implementations | Yes — all 15 endpoints covered         |

## Package Learnings

### apps/runtime

- Channel adapter registry supports `get(channelType)` lookup but no `sendOutbound()` method exists yet — need to add interface
- Route registration in `routes/index.ts` uses standard Express Router mounting
- Feature flags via environment variables (no centralized feature flag service)
- BullMQ queues initialized in server.ts startup sequence

### packages/eventstore

- Event registration is via `eventRegistry.register()` with schema, category, version
- Channel events provide the pattern for proactive events
