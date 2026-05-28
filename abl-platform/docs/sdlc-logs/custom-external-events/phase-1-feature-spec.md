# SDLC Log: Custom External Events -- Phase 1 (Feature Spec)

**Date:** 2026-03-23
**Phase:** Feature Spec
**Artifact:** `docs/features/custom-external-events.md`

## Decisions

| ID  | Classification | Decision                                                                                                                             |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | DECIDED        | Custom events use `custom:` namespace prefix to avoid collision with built-in lifecycle events (`session:`, `agent:`, `tool:`, etc.) |
| D2  | DECIDED        | Event type registry stored in MongoDB (consistent with all other project-scoped config)                                              |
| D3  | DECIDED        | Event persistence in ClickHouse `custom_events` table (consistent with analytics pattern)                                            |
| D4  | DECIDED        | Webhook delivery via BullMQ (async, retryable, existing pattern)                                                                     |
| D5  | DECIDED        | Event name pattern: lowercase dot-separated (`order.shipped`), Kafka topic: `abl.custom.order.shipped`                               |
| D6  | DECIDED        | Max payload size: 64KB (consistent with API boundary validation practices)                                                           |

## Grounding

- Existing external-events route: `apps/runtime/src/routes/external-events.ts` (ClickHouse analytics overlay)
- Event bus: `apps/runtime/src/services/event-bus/` (RuntimeEventBus, EventSubscriptionRegistry)
- Event detector: `apps/runtime/src/services/execution/event-detector.ts` (lifecycle event patterns)
- Event matching: `apps/runtime/src/services/execution/event-matching.ts` (wildcard matching)
- RECALL validation: `packages/compiler/src/platform/ir/recall-validation.ts`
- Pipeline triggers: `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`
- Trigger definitions: `packages/pipeline-engine/src/pipeline/seed-data/trigger-definitions.json`
- Platform event types: `apps/runtime/src/services/event-bus/types.ts` (8 built-in event types)

## Phase Audit

### Self-Review Findings

| #   | Severity | Finding                                                                                                                      | Resolution                                                             |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | HIGH     | US-2 mentions broadcast to all active sessions when sessionId omitted -- this is complex and could cause unintended behavior | Deferred broadcast to P1; MVP drops events without sessionId targeting |
| 2   | MEDIUM   | No explicit mention of API key authentication for external systems                                                           | Added NFR for API key with `events:write` scope in auth section        |
| 3   | MEDIUM   | Success metrics are aspirational without measurement infrastructure                                                          | Metrics tracked via existing ClickHouse analytics + Observatory        |
| 4   | LOW      | Missing explicit version/changelog for event type schema evolution                                                           | Documented in risks; schema versioning deferred                        |
