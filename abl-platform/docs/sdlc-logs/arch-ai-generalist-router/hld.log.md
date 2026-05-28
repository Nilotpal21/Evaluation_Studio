# SDLC Log: Arch AI Generalist Router — HLD

**Phase**: HLD (Phase 3)
**Date**: 2026-04-15
**Status**: COMPLETE

---

## Oracle Decisions

All 15 clarifying questions answered without user escalation.

### Architecture & Data Flow

| Q#                | Classification | Decision                                                                                     |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Pattern           | ANSWERED       | Internal refactor — no new services, no new APIs                                             |
| Data flow         | ANSWERED       | Synchronous: message → prompt composition → LLM call → SSE. Card selection is pure function. |
| Scale             | ANSWERED       | Unchanged throughput. Pure function change, no new async operations.                         |
| Existing patterns | ANSWERED       | selectKnowledgeCards() is the proven pattern. Extend, don't replace.                         |
| Deployment        | ANSWERED       | Same Studio Next.js server. No topology change.                                              |

### Integration & Dependencies

| Q#               | Classification | Decision                                                             |
| ---------------- | -------------- | -------------------------------------------------------------------- |
| Dependencies     | ANSWERED       | packages/arch-ai (card-router, prompts), apps/studio (route handler) |
| External         | ANSWERED       | None                                                                 |
| API contract     | INFERRED       | SSE specialist event name changes to constant. No breaking change.   |
| Breaking changes | ANSWERED       | None                                                                 |
| Lifecycle impact | ANSWERED       | None — AI assistant layer, not agent runtime                         |

### Risk & Migration

| Q#             | Classification | Decision                                                                       |
| -------------- | -------------- | ------------------------------------------------------------------------------ |
| Biggest risk   | DECIDED        | Domain knowledge regression — specialist content not fully captured in cards   |
| Data migration | ANSWERED       | None needed — activeSpecialist field reused                                    |
| Rollback       | DECIDED        | Revert composeInProjectPrompt + route.ts changes. New cards remain harmlessly. |
| Feature flag   | DECIDED        | Not needed — internal architecture change                                      |
| Blast radius   | ANSWERED       | IN_PROJECT Arch AI conversations only                                          |

## Files Created

- `docs/specs/arch-ai-generalist-router.hld.md`
- `docs/sdlc-logs/arch-ai-generalist-router/hld.log.md`

## Audit Rounds

### Round 1 (full audit — 12 concerns, alternatives, cross-phase)

- All 12 concerns addressed substantively
- 3 alternatives with real trade-offs
- 3 architecture diagrams (system context, component, data flow)
- **MEDIUM**: FR traceability used S4.x references that don't match concern numbering. Fixed to use C# references.
- **Result**: APPROVED with minor fix

### Round 2 (data model + API deep dive)

- No schema changes confirmed
- SSE specialist event contract validated — Studio UI handles arbitrary values
- Card registry ordering validated — construct > domain priority is correct
- **Result**: APPROVED — no findings

### Round 3 (cross-phase consistency)

- Problem statement matches feature spec
- All 10 FRs traceable
- Test strategy counts match test spec (8 unit, 7 integration, 6 E2E)
- Open questions cross-referenced with feature spec gaps
- ONBOARDING boundary consistent across all docs
- **Result**: APPROVED — no findings
