# SDLC Log: Custom External Events -- Phase 4 (LLD)

**Date:** 2026-03-23
**Phase:** LLD + Implementation Plan
**Artifact:** `docs/plans/2026-03-23-custom-external-events-impl-plan.md`

## Implementation Structure

- **5 phases**, ordered by priority (P0 -> P2)
- **Phase 1:** Event Type Registry + Ingestion API (P0, 3-4 days)
- **Phase 2:** Event Bus + RECALL Integration (P0, 2-3 days)
- **Phase 3:** Pipeline Trigger Extension (P1, 1-2 days)
- **Phase 4:** Studio UI (P1, 3-4 days)
- **Phase 5:** Webhook Delivery (P2, 2-3 days)
- **Total estimate:** 11-16 days

## Files Touched

### New Files (13)

- `apps/runtime/src/schemas/custom-event-type.schema.ts`
- `apps/runtime/src/services/custom-events/validation.ts`
- `apps/runtime/src/services/custom-events/schema-validator.ts`
- `apps/runtime/src/services/custom-events/session-dispatcher.ts`
- `apps/runtime/src/services/custom-events/webhook-delivery.ts`
- `apps/runtime/src/routes/custom-event-types.ts`
- `apps/runtime/src/routes/custom-events.ts`
- `apps/studio/src/hooks/useCustomEventTypes.ts`
- `apps/studio/src/hooks/useCustomEvents.ts`
- `apps/studio/src/app/(dashboard)/projects/[projectId]/events/page.tsx`
- `apps/studio/src/components/events/EventTypeList.tsx`
- `apps/studio/src/components/events/EventTypeCreateDialog.tsx`
- `apps/studio/src/components/events/EventLog.tsx`

### Modified Files (9)

- `apps/runtime/src/server.ts` (mount 2 new routes)
- `apps/runtime/src/services/event-bus/types.ts` (extend EventType)
- `apps/runtime/src/services/execution/event-detector.ts` (add resolveCustomEvents)
- `apps/runtime/src/services/execution/event-matching.ts` (verify custom pattern support)
- `packages/compiler/src/platform/constants.ts` (add LIFECYCLE_PATTERNS)
- `packages/compiler/src/platform/ir/recall-validation.ts` (recognize custom: prefix)
- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (add table)
- `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json` (add entry)
- Studio sidebar component (add Events link)

## Wiring Verification Points

16-item wiring checklist included in LLD to prevent the "write component, forget to wire" pattern.

## Phase Audit

### Self-Review Findings

| #   | Severity | Finding                                                                                                                                                                 | Resolution                                                                                                                                  |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Phase 2 Task 2.5 (Session Dispatcher) needs access to active sessions store but the mechanism for delivering events to in-flight agent execution is not fully specified | The dispatcher should use the same pattern as `inbound-worker.ts` which delivers messages to sessions via Redis pub/sub channel per session |
| 2   | MEDIUM   | No explicit migration for existing pipeline definitions that might want custom triggers                                                                                 | Not needed -- this is additive. Existing pipelines continue to use built-in triggers. New pipelines can opt into custom triggers.           |
| 3   | MEDIUM   | Phase 4 Studio UI assumes dashboard layout exists at specific path                                                                                                      | Verified: `apps/studio/src/app/(dashboard)/projects/[projectId]/` path pattern exists for other features                                    |
| 4   | LOW      | Estimated effort does not include test writing time                                                                                                                     | Test time is included in each phase estimate; exit criteria require passing tests                                                           |
