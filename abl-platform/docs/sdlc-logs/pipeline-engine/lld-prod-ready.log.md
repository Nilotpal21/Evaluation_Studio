# LLD Log: Pipeline Engine — BETA → STABLE Gap Closure

**Phase**: 4 - LLD (production readiness)
**Date**: 2026-03-24
**Status**: Complete (APPROVED after 5 audit rounds)
**Artifact**: `docs/plans/2026-03-24-pipeline-engine-prod-ready-impl-plan.md`

## Oracle Decisions

All 15 clarifying questions answered autonomously (0 AMBIGUOUS):

| #   | Question                                 | Classification | Key Decision                                                       |
| --- | ---------------------------------------- | -------------- | ------------------------------------------------------------------ |
| Q1  | Priority: GAP-011 first or grouped?      | DECIDED        | Group GAP-011 + GAP-014 into Phase 1 (ACTIVITY_TYPES prerequisite) |
| Q2  | Alert evaluator: bind now or dormant?    | DECIDED        | Bind + activate via cron                                           |
| Q3  | Pipeline failure alerting mechanism      | DECIDED        | Extend existing alert evaluator (DRY)                              |
| Q4  | Minimum gaps for STABLE                  | ANSWERED       | GAP-011 (HIGH) must close; MEDIUMs accepted with rationale         |
| Q5  | Tag rule evaluation ownership            | ANSWERED       | Defer — external to pipeline-engine per feature spec               |
| Q6  | Wire all 7 at once or incrementally?     | INFERRED       | All 7 at once — graceful degradation via MODULE_NOT_FOUND          |
| Q7  | Alert evaluator trigger mechanism        | DECIDED        | Cron (5 min default) — matches PipelineScheduler pattern           |
| Q8  | Inline control-flow ACTIVITY_TYPES       | DECIDED        | Add entries, no executionModel field — description-based marker    |
| Q9  | ClickHouse integration test approach     | DECIDED        | Accept with rationale — CI infrastructure not available            |
| Q10 | Test coverage for newly-wired types      | INFERRED       | Unit tests + dispatch integration test per type                    |
| Q11 | Blast radius of SERVICE_HANDLERS changes | INFERRED       | Limited to pipelines using new types — try/catch isolation         |
| Q12 | External dependency handling             | INFERRED       | Dynamic imports + MODULE_NOT_FOUND = graceful degradation          |
| Q13 | Sub-pipeline recursion limits            | ANSWERED       | MAX_SUB_PIPELINE_DEPTH = 3, complementary to graph walker          |
| Q14 | Features depending on STABLE             | ANSWERED       | ROI Tracking, NLU, Tags — none hard-blocked                        |
| Q15 | Rollback plan                            | INFERRED       | Remove wiring entries — all changes additive                       |

## Audit Rounds

| Round | Auditor       | Verdict       | Findings                                                   |
| ----- | ------------- | ------------- | ---------------------------------------------------------- |
| R1    | lld-reviewer  | NEEDS_CHANGES | 1C (db-query ClickHouse tenant isolation), 3H, 5M          |
| R2    | lld-reviewer  | NEEDS_CHANGES | 3H (ActivityTypeMetadata, dual-path hook, validateSQL), 4M |
| R3    | lld-reviewer  | NEEDS_CHANGES | 1H (db-query MongoDB projectId), 2M, 3L                    |
| R4    | phase-auditor | APPROVED (1H) | 1H (test spec FR-14-19 coverage gap)                       |
| R5    | lld-reviewer  | APPROVED      | 0 issues, 1 INFO note                                      |

### Key Findings Discovered During Audit

1. **CRITICAL**: `db-query` ClickHouse path had NO tenant or project isolation — fixed by requiring parameterized `query_params` with `tenant_id` and `project_id`
2. **CRITICAL**: `db-query` MongoDB path was missing `projectId` enforcement — fixed
3. **HIGH**: 3 services already in SERVICE_HANDLERS were never `.bind()`-ed in server.ts (`computeGoalCompletion`, `httpRequest`, `readMessageWindow`) — pre-existing bug fixed
4. **HIGH**: `sub-pipeline` couldn't reference built-in definitions (tenantId `__platform__`) — fixed
5. **HIGH**: `alertEvaluatorService.execute()` required `stepContext` which is unused — made optional
6. **HIGH**: Alert cron handler was wrongly placed in PipelineScheduler — created separate AlertEvaluationScheduler
7. **HIGH**: Pipeline failure alert hook needed in BOTH legacy and graph mode paths
8. **HIGH**: `validateSQL` already existed in nl-query — reused instead of reimplemented

## Changes Made

- Created `docs/plans/2026-03-24-pipeline-engine-prod-ready-impl-plan.md` (new LLD)
- 13 design decisions (D-1 through D-13)
- 4 implementation phases with 20 tasks
- 30-item wiring checklist
- 6 deferred gaps with acceptance rationale
- 4 open questions (2 resolved during audit)

## Coverage Delta

| Type        | Before (BETA) | After (projected) |
| ----------- | ------------- | ----------------- |
| Unit tests  | 450+          | 460+ (+10 files)  |
| Integration | 6 files       | 6 files           |
| E2E         | 5 suites      | 5 suites          |
| Wired types | 27            | 34 (+7)           |
| Metadata    | 25            | 35 (+10)          |
