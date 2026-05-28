# Phase 4: LLD — Voice Analytics

> Date: 2026-03-22 | Phase: LLD | Reviewer: lld-reviewer (2 rounds)

## Summary

Generated phased implementation plan for Voice Analytics (#34) with 4 phases and clear exit criteria.

## Phase Breakdown

| Phase | Name                              | Duration | Key Deliverables                                           |
| ----- | --------------------------------- | -------- | ---------------------------------------------------------- |
| 1     | Test Coverage + Trend Computation | 3-5 days | Unit tests (10), E2E tests (9), period-over-period trends  |
| 2     | Drill-Down + Agent Comparison     | 5-7 days | Per-agent API, session list, cascade summary, active calls |
| 3     | Language Segmentation + Alerting  | 5-7 days | Metric 208, alert thresholds, language breakdown widget    |
| 4     | Export + Custom Date Range        | 2-3 days | CSV/JSON export, date picker                               |

**Total estimated duration**: 15-22 days

## Codebase Findings

- `agent_name` is in `platform_events` table but NOT in voice hourly MV GROUP BY
- Voice hourly MV definition at `packages/database/src/clickhouse-schemas/init.ts` line 822
- MV dest table at line 532
- MV must be dropped/recreated to add agent_name (ClickHouse limitation)

## Audit Round 1 Findings

| #   | Severity | Finding                                                         | Resolution                                                                             |
| --- | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | HIGH     | Summary API response shape change breaks backward compatibility | Changed to additive approach: add `trends` as optional field alongside existing fields |
| 2   | MEDIUM   | agent_name availability in MV not confirmed                     | Confirmed: NOT in voice MV, IS in platform_events. Added MV migration notes            |
| 3   | MEDIUM   | Session list endpoint missing pagination                        | Added limit/offset params (default 50, max 200) with total_count                       |
| 4   | LOW      | Export endpoint missing PII exclusion note                      | Added PII exclusion requirement                                                        |

## Audit Round 2 Findings

No new findings. All concerns addressed.

## Outcome

- **Artifact**: `docs/plans/2026-03-22-voice-analytics-impl-plan.md`
- **Phases**: 4
- **Exit criteria**: Per-phase checkboxes + ALPHA->BETA and BETA->STABLE promotion criteria
- **Wiring checklist**: 12 items (endpoints, widgets, UI integrations)
- **Risks**: 5 with mitigations
