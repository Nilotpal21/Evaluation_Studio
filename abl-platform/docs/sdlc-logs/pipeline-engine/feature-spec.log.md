# Feature Spec Log: Pipeline Engine

**Phase**: 1 - Feature Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: How many built-in pipeline definitions exist?

**Classification**: ANSWERED
**Source**: `packages/pipeline-engine/src/pipeline/definitions/index.ts` -- `BUILTIN_DEFINITIONS` exports exactly 10 definitions: sentiment, intent, quality, hallucination, knowledge-gap, guardrail, friction, anomaly, drift, eval.

### Q2: What execution model does the pipeline engine use?

**Classification**: ANSWERED
**Source**: `pipeline-run.workflow.ts` -- Restate durable workflows with two modes: legacy step-array and graph-node mode. `walkGraph()` in `graph-walker.ts` is a pure function. `PipelineScheduler` is a Restate virtual object.

### Q3: How does configuration resolution work?

**Classification**: ANSWERED
**Source**: `pipeline-config.service.ts` -- `PipelineConfigService.resolveConfig()` implements project > tenant > null chain. Zod schema `.default()` values provide platform defaults.

### Q4: What triggers are supported?

**Classification**: ANSWERED
**Source**: `pipeline-trigger.service.ts` -- Three trigger types: `kafka` (event-driven via Kafka topics), `schedule` (cron via `PipelineScheduler`), and `manual` (programmatic via `triggerManual`). Supports multi-trigger definitions with per-trigger strategies and sampling rates.

### Q5: What expression evaluation is supported?

**Classification**: ANSWERED
**Source**: `expression-evaluator.ts` -- Custom recursive-descent parser. Supports comparisons (`==`, `!=`, `>`, `<`, `>=`, `<=`), logical operators (`&&`, `||`, `!`), dot-path access (`steps.<id>.output.<path>`), `pipelineInput.*` access. Safety: banned keywords, no eval/Function, no bracket access, no arithmetic.

### Q6: What analytics storage is used?

**Classification**: ANSWERED
**Source**: `init-analytics-tables.ts`, `pipeline-analytics.ts` routes -- ClickHouse tables partitioned by tenant. Tables: `message_sentiment`, `conversation_sentiment`, `intent_classifications`, `quality_evaluations`, `hallucination_evaluations`, `knowledge_gap_evaluations`, `guardrail_evaluations`, `friction_detections`, `anomaly_detections`, `drift_detections`, `llm_evaluate`, `insight_results`. Materialized views for daily aggregation.

### Q7: What is the eval pipeline architecture?

**Classification**: ANSWERED
**Source**: `eval-run.workflow.ts`, `eval-types.ts` -- Fan-out persona x scenario x variant matrix. Batched concurrency (`maxConcurrency`). Pipeline: load eval set -> preflight -> build matrix -> fan-out conversations -> fan-out judging -> aggregate. Supports LLM-as-judge, code scorers, trajectory scorers. Statistical aggregation with pass@k, confidence intervals, regression detection.

### Q8: What API routes exist?

**Classification**: ANSWERED
**Source**: `pipeline-config.ts` (9 endpoints), `pipeline-analytics.ts` (4 endpoints) -- Total 13 runtime API endpoints. Config: list, get, put, history, toggle, backfill, backfill/status, triggers, schema. Analytics: summary, breakdown, conversations, conversation/:sid.

### Q9: What Studio UI components exist?

**Classification**: ANSWERED
**Source**: `apps/studio/src/components/pipelines/` -- 18 components: PipelinesListPage, BuiltinPipelinesList, CustomPipelinesList, PipelineCard, PipelineConfigPage, PipelineEditorPage, PipelineGraphCanvas, PipelineEditorToolbar, NodePalette, NodeConfigPanel, TriggerManager, TriggerConfigPanel, ConfigSchemaForm, SchemaFieldBuilder, PipelineNodeComponent, PipelineGroupNode, PipelineTriggerNode, PipelineEdgeComponent.

### Q10: What test coverage exists?

**Classification**: ANSWERED
**Source**: Glob of `__tests__/*.test.ts` -- 50+ test files covering graph walker, graph validation, expression evaluator, config schemas, pipeline config, pipeline triggers, node registry, cron, all compute services, analytics cache, experiment results, eval preflight, circuit breakers, integration tests. 450+ tests passing. No E2E tests.

### Q11: What caching strategy is used?

**Classification**: ANSWERED
**Source**: `analytics-cache.ts` -- Redis-backed `AnalyticsCache` with TTLs: summary=300s, timeseries=600s, breakdown=300s, conversation=3600s, conversations=300s. Fail-open on Redis error. Definition cache in `definition-cache.ts` for Kafka topic -> definitions lookup.

### Q12: What node type system is used?

**Classification**: ANSWERED
**Source**: `node-registry.ts`, `types.ts` -- Dual system: static `ACTIVITY_TYPES` and DB-backed `NodeTypeDefinitionDoc`. NodeRegistry is a bounded Map (max 200). `loadFromDocs()` loads from MongoDB with trait-based field merging (`trait-merger.ts`). Categories: data, logic, integration, compute, action. Traits: compute, llm, storage.

## Key Findings

1. **Comprehensive implementation**: 10 built-in pipelines, 20+ compute/activity services, 13 API endpoints, 18 Studio UI components, 50+ test files.
2. **Dual execution mode**: Both legacy step-array and graph-node modes coexist in the same workflow, with automatic detection based on `nodes[]` + `entryNodeId` presence.
3. **Strong type system**: Extensive TypeScript interfaces (PipelineDefinition, PipelineNode, StepOutput, NodeTypeDefinition, etc.) with Zod validation at API boundaries.
4. **E2E gap**: No E2E tests exist for the full pipeline lifecycle through HTTP APIs. This is the primary testing gap.
5. **Observability gap**: Some files still use `console.log` instead of `createLogger` (pipeline-run.workflow.ts, pipeline-trigger.service.ts).
6. **Data lifecycle gap**: No TTL/cleanup for pipeline run records in MongoDB.

## Changes Made

- Rewrote `docs/features/pipeline-engine.md` with all 18 template sections grounded in code evidence
- Added comprehensive API endpoint listing (13 runtime endpoints vs. original 8)
- Added eval pipeline coverage (FR-10, user stories 5-6, detailed eval types and services)
- Added backfill coverage (FR-13, API endpoints)
- Added 4 new gaps (GAP-005 through GAP-010)
- Added complete test inventory (50+ files vs. original 15)
- Added node type system documentation
- Added trigger registry documentation
