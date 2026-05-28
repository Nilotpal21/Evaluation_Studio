# SDLC Log: Experiments — Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Artifact**: `docs/features/experiments.md`
**Status**: COMPLETE

## Clarifying Questions & Decisions

| #   | Question                                                              | Classification | Resolution                                                                                                                                                   |
| --- | --------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-1 | Should experiments compare deployment-pinned versions or draft DSL?   | DECIDED        | Deployment-pinned versions — ensures reproducibility and stable compiled IR                                                                                  |
| Q-2 | One active experiment per project or multiple concurrent?             | DECIDED        | One — multi-experiment requires complex multi-way splitting, deferred                                                                                        |
| Q-3 | How should session assignment work — random or deterministic hash?    | DECIDED        | Deterministic hash of (experimentId, sessionId) — reproducible, no external state                                                                            |
| Q-4 | Where to store group assignment — separate table or session document? | DECIDED        | Session document — ensures stickiness, no additional lookups                                                                                                 |
| Q-5 | Frequentist or Bayesian significance?                                 | DECIDED        | Frequentist (t-test, chi-squared) — simpler, industry standard, Bayesian deferred                                                                            |
| Q-6 | Auto-rollback on guardrail breach or just auto-stop?                  | DECIDED        | Auto-stop — auto-rollback is complex (draining, state migration); manual promotion is safer                                                                  |
| Q-7 | Where do experiment APIs live — runtime or Studio?                    | DECIDED        | Runtime (`/api/projects/:projectId/experiments`) — experiment model and results service are in pipeline-engine, runtime has session creation; Studio proxies |

## Codebase Grounding

- `ExperimentModel` exists at `packages/pipeline-engine/src/schemas/experiment.schema.ts` — scaffolded with basic fields (tenantId, projectId, status, versions, trafficSplit, metrics)
- `ExperimentResultsService` exists at `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` — has tTest, chiSquared, minSampleSizeForEffect, confidenceInterval methods
- `Session` model at `packages/database/src/models/session.model.ts` — has `deploymentId` but no experiment fields
- `Deployment` model at `packages/database/src/models/deployment.model.ts` — has `agentVersionManifest`, environment, endpointSlug
- `AgentVersion` model at `packages/database/src/models/agent-version.model.ts` — versioned DSL/IR snapshots
- ClickHouse tables at `packages/pipeline-engine/src/pipeline/schemas/init-*.ts` — no experiment_group columns yet

## Audit Summary

- Round 1: Self-review — ensured all 24 functional requirements trace to user stories; confirmed non-goals are explicit; verified risk mitigations are actionable
- Round 2: Cross-checked with platform principles (tenant isolation, centralized auth, traceability, performance)
