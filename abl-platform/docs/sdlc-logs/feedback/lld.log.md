# LLD Log: Feedback System

**Date**: 2026-03-23
**Phase**: LLD
**Feature**: Feedback System (comprehensive feedback collection across channels)

---

## Oracle Decisions

15 questions asked across 3 categories (Implementation Strategy, Technical Details, Risk & Dependencies). All answered.

| #   | Category       | Question Summary                       | Classification | Decision                                                                                                                                              |
| --- | -------------- | -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Implementation | Preferred implementation order         | DECIDED        | Bottom-up: schema -> service -> route -> UI. Data layer must exist before services, services before routes, routes before UI.                         |
| Q2  | Implementation | Existing patterns to follow            | ANSWERED       | Analytics routes pattern (auth + requireProjectScope + tenantRateLimit). ClickHouse DDL follows llm_metrics + MV pattern.                             |
| Q3  | Implementation | Feature flag for phased rollout        | DECIDED        | No feature flag. Purely additive -- new routes, new tables, nothing existing changes.                                                                 |
| Q4  | Implementation | Scope for Phase 1 vs later             | DECIDED        | Phase 1: schema + types. Phase 2: service. Phase 3: routes + wiring. Phase 4: email bridge + WebSocket. Phase 5: Studio UI. Phase 6: E2E tests.       |
| Q5  | Implementation | Hard deadlines                         | INFERRED       | No hard deadline. Feature is prioritized but not blocking other work.                                                                                 |
| Q6  | Technical      | Specific files needing modification    | ANSWERED       | 4 modified: server.ts (route wiring), clickhouse-schemas/init.ts (DDL), sdk-handler.ts (WS), Studio proxy route. 11 new files.                        |
| Q7  | Technical      | Testing strategy (test-first or after) | DECIDED        | Tests alongside each phase. Unit tests in phases 1-5. E2E tests in Phase 6.                                                                           |
| Q8  | Technical      | Type definitions needing change        | ANSWERED       | New types only: FeedbackSubmitSchema, FeedbackRecord, FeedbackStats, FeedbackRecentResponse. No existing type changes.                                |
| Q9  | Technical      | Database migration strategy            | ANSWERED       | ClickHouse DDL only (CREATE TABLE IF NOT EXISTS). No MongoDB changes. No migration scripts needed.                                                    |
| Q10 | Technical      | Performance-sensitive paths            | ANSWERED       | Stats aggregation query (daily MV handles this). Dedup SELECT-before-INSERT (single row lookup by composite key). Both within ClickHouse performance. |
| Q11 | Risk           | Ongoing conflicting changes            | INFERRED       | None identified. Feedback is a new feature with no overlapping PRs.                                                                                   |
| Q12 | Risk           | Biggest implementation risk            | INFERRED       | Agent name resolution -- trace lookup may be slow or unavailable. Mitigated by client hint with trace fallback.                                       |
| Q13 | Risk           | Team dependencies                      | INFERRED       | None. Single developer can implement all phases. No external team review required beyond standard PR review.                                          |
| Q14 | Risk           | Monitoring/alerting before rollout     | ANSWERED       | TraceStore events provide audit trail. ClickHouse query performance observable via existing infrastructure. No new monitoring needed.                 |
| Q15 | Risk           | Definition of done                     | DECIDED        | All 12 FRs implemented. E2E tests passing. pnpm build && pnpm test clean. Studio FeedbackTab rendering. Email bridge writing to ClickHouse.           |

## Escalations

None -- all questions resolved without user input.

## Audit Rounds

| Round | Auditor      | Verdict  | Findings                                                                                                                                                 |
| ----- | ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | lld-reviewer | APPROVED | Generated inline during context-limited session. LLD covers all 12 FRs, all 6 phases have exit criteria, wiring checklist complete, file paths verified. |

## Key Design Decisions

1. **D-1**: Bottom-up implementation order (schema -> service -> route -> UI)
2. **D-2**: Integer-only star ratings (1-5), no half-stars
3. **D-3**: Agent name from client hint with trace fallback
4. **D-4**: feedbackText max 5000 chars
5. **D-5**: No feature flag (purely additive)
6. **D-6**: Email bridge in Phase 4 (not Phase 1)
7. **D-7**: Tests alongside each phase
8. **D-8**: ClickHouse dedup via SELECT before INSERT (ReplacingMergeTree as backstop)

## FR-to-Phase Traceability

| FR    | Description                     | Phase |
| ----- | ------------------------------- | ----- |
| FR-1  | Thumbs up/down submission       | 2, 3  |
| FR-2  | Zod validation per ratingType   | 1, 3  |
| FR-3  | ClickHouse append-only storage  | 1, 2  |
| FR-4  | Dedup (session+message+user)    | 2, 3  |
| FR-5  | Star 1-5 submission             | 2, 3  |
| FR-6  | Free-text feedback              | 2, 3  |
| FR-7  | Session-project binding         | 2, 3  |
| FR-8  | Aggregated stats (daily MV)     | 1, 2  |
| FR-9  | Recent feedback (paginated)     | 2, 3  |
| FR-10 | Email CSAT bridge to ClickHouse | 4     |
| FR-11 | WebSocket feedback.submit       | 4     |
| FR-12 | Studio FeedbackTab              | 5     |

## Files Created

- `docs/plans/2026-03-23-feedback-impl-plan.md` -- LLD + implementation plan
- `docs/sdlc-logs/feedback/lld.log.md` -- This log
