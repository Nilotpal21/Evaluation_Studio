# SDLC Log: Constraint Design Coaching — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-04-05
**Status**: COMPLETE

## Oracle Decisions

All questions answered internally — no AMBIGUOUS items escalated.

| Classification | Key Decisions                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| ANSWERED       | Governance specialist S2-F13 exists as checker, needs enhancement to designer                                    |
| ANSWERED       | Constraint IR types fully defined: `Constraint`, `ConstraintAction`, `Guardrail`, `ConstraintCheckpoint`         |
| ANSWERED       | 3-tier guardrail cascade exists: local (regex), model (NLI), LLM (semantic)                                      |
| ANSWERED       | ON_FAIL actions support 8 types: respond, escalate, handoff, block, redact, retry_step, goto_step, collect_field |
| DECIDED        | Data sensitivity classification is new — tool name + parameter + description pattern matching                    |
| DECIDED        | 4 regulations supported initially: PCI-DSS, HIPAA, GDPR, SOC2 (no custom regulation support)                     |
| DECIDED        | Constraints are advisory during BUILD — shown in activity feed, applied to ABL                                   |
| INFERRED       | IN_PROJECT mode exposes `analyze_constraints` tool for on-demand analysis                                        |

## Files Created

- `docs/features/constraint-design-coaching.md` — Feature spec (18/18 sections)
- `docs/testing/constraint-design-coaching.md` — Testing guide placeholder
- `docs/sdlc-logs/constraint-design-coaching/feature-spec.log.md` — This log

## Audit Results

- Round 1: All quality gates PASS. 5 user stories, 10 FRs, 6 integrations, isolation addressed.
- Round 2: Cross-phase consistency verified against guardrails.md and schema.ts IR types.

## Next Phase

Run `/test-spec constraint-design-coaching`
