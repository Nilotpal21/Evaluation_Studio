# SDLC Log: ROI Tracking -- Phase 1: Feature Spec

**Date**: 2026-03-23
**Phase**: Feature Spec
**Artifact**: `docs/features/roi-tracking.md`

## Decisions Log

| ID  | Question                                                  | Classification | Decision                                                                                    |
| --- | --------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| D1  | Should ROI be computed per-project or per-tenant?         | DECIDED        | Per-project -- matches existing `ProjectCostConfig` unique index on `(tenantId, projectId)` |
| D2  | Should containment rate be auto-computed or manual?       | DECIDED        | Phase 1: manual config. Phase 2: auto-compute from session outcome events                   |
| D3  | Should simulation be server-side or client-side?          | DECIDED        | Client-side for instant feedback; same formula as `ROICalculator`                           |
| D4  | Where to add budget alert thresholds?                     | DECIDED        | Extend existing `ProjectCostConfig` schema with optional `budgetAlertThresholds` array      |
| D5  | Should cost config be per-environment (dev/staging/prod)? | DECIDED        | No -- cost config is business-level, not environment-level. Single config per project       |
| D6  | What time granularity for cost trends?                    | DECIDED        | Day/week/month selectable. Default: day for < 30d, week for 30-90d, month for > 90d         |
| D7  | Which permissions gate ROI endpoints?                     | DECIDED        | `analytics:read` for viewing, `analytics:write` for cost config changes                     |

## Codebase Grounding

- **Existing ROICalculator**: `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts` -- full savings/FTE/budget computation
- **Existing ProjectCostConfig**: `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts` -- Mongoose model with tenant+project index
- **Existing model pricing**: `packages/shared-kernel/src/model-pricing.ts` -- `estimateCost()` function
- **Existing LLM events**: `packages/eventstore/src/schema/events/llm-events.ts` -- `llm.call.completed` with `estimated_cost`
- **Existing analytics hooks**: `apps/studio/src/hooks/useAnalytics.ts` -- SWR hooks for analytics API
- **Existing insights dashboard**: `apps/studio/src/hooks/useInsightsDashboard.ts` -- combines session-metrics + cost-breakdown
- **Existing tenant usage**: `apps/runtime/src/routes/tenant-usage.ts` -- ClickHouse LLM metrics queries
- **Existing llm-cost util**: `apps/studio/src/utils/llm-cost.ts` -- `formatCost()`, `estimateLLMCost()`

## Audit Round 1

- Verified all existing code references are accurate
- Scope is well-bounded: uses existing calculator + model + pricing, adds API routes + UI
- 5 user stories cover the core use cases
- Risks properly identified; containment rate auto-computation deferred to Phase 2
