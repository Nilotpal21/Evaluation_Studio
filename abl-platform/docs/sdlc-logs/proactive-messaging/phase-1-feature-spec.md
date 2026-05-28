# SDLC Log: Proactive Messaging — Phase 1 (Feature Spec)

> **Date**: 2026-03-22
> **Phase**: Feature Spec
> **Status**: In Progress

## Context Gathered

- Read 15+ source files across runtime, execution, channels, eventstore, a2a, compiler
- No existing feature spec, test spec, HLD, or LLD for proactive messaging
- Codebase has partial building blocks: channel adapters (9), ChannelDispatcher (3-tier delivery), contacts system, BullMQ, eventstore, template engine, output guardrails
- Scheduling extension exists as RFC (`docs/rfcs/extensions/scheduling.md`) but not implemented
- A2A package has push notification delivery pattern that can be generalized

## Key Decisions

| #   | Decision                                                      | Classification |
| --- | ------------------------------------------------------------- | -------------- |
| 1   | Template-only for Phase 1, reasoning-based in Phase 2         | DECIDED        |
| 2   | Individual BullMQ jobs (not Flows) for Phase 1                | DECIDED        |
| 3   | Default consent status is `pending`                           | DECIDED        |
| 4   | `PROACTIVE:` block is agent-level in DSL                      | DECIDED        |
| 5   | Email, Slack, MS Teams, WhatsApp, HTTP async support outbound | INFERRED       |
| 6   | Bypass ExecutionCoordinator for template-only messages        | DECIDED        |

## Feature Spec Summary

- **18 sections** generated (all template sections covered)
- **6 user stories** (API trigger, schedule, event trigger, consent, monitoring, DSL)
- **10 functional requirements** (FR-1 through FR-10)
- **6 non-functional requirements** (latency, throughput, reliability, security, observability, compliance)
- **4 data models** (ProactiveMessage, ProactiveSchedule, ProactiveTrigger, ContactConsent)
- **15 API endpoints** across 4 route groups
- **3-phase rollout plan** (MVP API, Schedules+Triggers, DSL+Studio)
- **6 risks** identified with mitigations

## Audit Round 1

Performing self-audit against feature spec quality criteria...

### Findings

| #   | Severity | Finding                                               | Resolution                                                                                     |
| --- | -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | HIGH     | Missing error response format specification           | Added to FR-1: returns `{ success, data?, error?: { code, message } }` per platform convention |
| 2   | HIGH     | No mention of distributed lock for schedule execution | Added to FR-4: BullMQ repeatable jobs handle idempotency                                       |
| 3   | MEDIUM   | Contact channel address structure not defined         | Deferred to HLD — depends on existing contact model                                            |
| 4   | MEDIUM   | No pagination spec for list endpoints                 | Standard cursor-based pagination applies per platform convention                               |
| 5   | LOW      | DSL syntax example could show more edge cases         | Adequate for feature spec level                                                                |

## Audit Round 2

### Findings

| #   | Severity | Finding                                        | Resolution                                                        |
| --- | -------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 1   | MEDIUM   | Should specify max message content size        | Platform invariant: validate payload size at boundaries — applies |
| 2   | MEDIUM   | Missing webhook delivery retry idempotency key | FR-7 already specifies `externalMessageId` for dedup              |
| 3   | LOW      | Success metrics could include cost per message | Out of scope for Phase 1                                          |

All CRITICAL and HIGH findings resolved. Proceeding to Phase 2.
