# Feature Spec Log: Agent Governance Dashboard

**Date**: 2026-04-29
**Phase**: Feature Spec (Phase 1)
**Artifact**: `docs/features/governance.md`
**Status**: COMPLETE

---

## Oracle Decisions (ANSWERED / INFERRED / DECIDED)

| #   | Question                             | Classification | Decision                                                                                                                 |
| --- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Navigation placement                 | ANSWERED       | Existing "govern" nav group; replaces GovernancePage stub                                                                |
| Q2  | Governance vs guardrails distinction | INFERRED       | Guardrails = runtime enforcement; governance = retrospective compliance                                                  |
| Q3  | Cross-project vs per-project scope   | DECIDED        | Per-project for Phase 1; tenant-level is Phase 2                                                                         |
| Q5  | Out-of-scope items                   | DECIDED        | Real-time enforcement, HITL, fine-tuning, alert CRUD, pipeline config, custom dashboards                                 |
| Q6  | Primary persona                      | INFERRED       | Project owner / quality analyst + compliance officer                                                                     |
| Q7  | Concrete meaning of governance       | DECIDED        | Dashboard + compliance status indicators + policy thresholds. No automated actions.                                      |
| Q8  | Policy definition vs monitoring only | DECIDED        | Include lightweight policy definition (thresholds) — differentiates from analytics dashboard                             |
| Q9  | Alerts integration scope             | DECIDED        | CTAs only; no duplicate notification logic                                                                               |
| Q11 | Quality vs compliance pipeline split | DECIDED        | Quality = quality_evaluation, hallucination, knowledge_gap, context_preservation. Compliance = guardrail_analysis, drift |
| Q12 | New backend routes needed            | DECIDED        | New: policy CRUD, status aggregation, audit, report endpoints. Reuse: pipeline-analytics data                            |
| Q14 | Alerts integration depth             | DECIDED        | Navigation deep-links only; governance reads alert existence, does not write                                             |
| Q15 | GovernancePolicy vs GuardrailPolicy  | DECIDED        | New GovernancePolicy collection; different domain, schema, lifecycle                                                     |

## User Escalations (AMBIGUOUS items)

| #   | Question                | User Answer                      |
| --- | ----------------------- | -------------------------------- |
| A-1 | Primary business driver | Option B — Regulatory compliance |
| A-2 | Audit-ready exports     | CSV and PDF in MVP               |

## Files Created

- `docs/features/governance.md` — full feature spec (27 FRs, 10 user stories, 17 test scenarios)
- `docs/testing/governance.md` — testing guide (7 E2E, 6 integration scenarios)
- `docs/sdlc-logs/governance/feature-spec.log.md` — this file

## Index Updates

- `docs/features/README.md` — added row 3a (Governance Dashboard, PLANNED)
- `docs/testing/README.md` — added row 3a (Governance Dashboard, PLANNED 04-29)

## Key Design Decisions Made

1. Governance policies are NOT stored in ClickHouse — MongoDB only; evaluated at query time against ClickHouse analytics data
2. Breach/recovery events are computed on-demand (no pre-stored event stream) — GAP-001 acknowledges potential latency for large date ranges
3. PDF generation is server-side; pdf-lib vs puppeteer is deferred to LLD (Open Question #1)
4. Metric field names per pipeline type need a canonical registry — Open Question #2
5. Policy versioning (threshold history) is not in scope for Phase 1 — Open Question #4

## Open Items for Next Phase (Test Spec)

- Validate ClickHouse test data seeding utilities for breach event scenarios
- Define canonical metric field names per pipeline type (needed for governance policy rules)
- Clarify pdf-lib vs puppeteer decision before LLD
