# SDLC Log: Arch AI Generalist Router — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-04-15
**Status**: IN PROGRESS

---

## Oracle Decisions

All 15 clarifying questions answered without user escalation.

### Scope & Problem

| Q#  | Question                      | Classification | Decision                                                                          |
| --- | ----------------------------- | -------------- | --------------------------------------------------------------------------------- |
| Q1  | Empirical misrouting rate     | INFERRED       | ~60% is engineering estimate from regex overlap analysis. No production logs.     |
| Q2  | Primary goal                  | INFERRED       | Both: cross-turn stability (primary) + first-turn knowledge injection (secondary) |
| Q3  | Specialist badge              | DECIDED        | Preserve badge, change to "Arch AI" constant for all IN_PROJECT turns             |
| Q4  | save_tool_dsl inclusion       | ANSWERED       | Intentionally excluded from IN_PROJECT_TOOLS. No change.                          |
| Q5  | IN_PROJECT_SPECIALIST_DISPLAY | ANSWERED       | Only used for badge display. Simplify to generalist entry.                        |

### User Stories & Requirements

| Q#  | Question                         | Classification | Decision                                                                    |
| --- | -------------------------------- | -------------- | --------------------------------------------------------------------------- |
| Q6  | Primary users                    | ANSWERED       | Studio only. No MCP/API consumers.                                          |
| Q7  | Multi-intent behavior            | DECIDED        | Multiple cards load simultaneously (existing selectKnowledgeCards behavior) |
| Q8  | activeSpecialist backward compat | DECIDED        | Preserve field, set to 'abl-construct-expert' for new turns                 |
| Q9  | Specialist pinning on resume     | DECIDED        | No longer needed. Re-select cards from conversation context.                |
| Q10 | Feature flag / A/B testing       | DECIDED        | No. Internal architecture change, no user-facing toggle needed.             |

### Technical & Architecture

| Q#  | Question                        | Classification | Decision                                                              |
| --- | ------------------------------- | -------------- | --------------------------------------------------------------------- |
| Q11 | Token budget                    | DECIDED        | Increase from 4000 to 6000 tokens                                     |
| Q12 | Tool-preference hints           | DECIDED        | Preserve in domain knowledge cards                                    |
| Q13 | Pattern unification             | DECIDED        | Merge specialist patterns into card-router registry                   |
| Q14 | IN_PROJECT_SPECIALIST_IDS usage | ANSWERED       | Referenced in display maps and tests. Soft-deprecate, preserve types. |
| Q15 | Test migration                  | DECIDED        | Migrate to test card selection, not delete                            |

## Files Created

- `docs/features/sub-features/arch-ai-generalist-router.md`
- `docs/testing/sub-features/arch-ai-generalist-router.md`
- `docs/sdlc-logs/arch-ai-generalist-router/feature-spec.log.md`

## Index Updates

- `docs/features/sub-features/README.md` — added row
- `docs/features/README.md` — added to Focused Sub-Feature Modules table
- `docs/testing/sub-features/README.md` — added row
- `docs/testing/README.md` — added row #94

## Audit Rounds

### Round 1 (self-audit against TEMPLATE.md quality gates)

- **MEDIUM**: Inconsistent specialist count — "7" in scope/FR but listed 8 names. Fixed to "8".
- **LOW**: Section 10 said "7 new domain cards" — aligned with delivery plan's 8. Fixed.
- All 18 template sections addressed. 5 user stories, 10 FRs, 3 open questions, 3 integration matrix entries.
- **Result**: APPROVED with minor fixes applied.

### Round 2 (cross-phase consistency)

- Parent feature spec alignment: OK
- HLD alignment: OK (simplifies specialist layer for IN_PROJECT, preserves for ONBOARDING)
- CLAUDE.md compliance: OK (additive, no auth changes, no tool filtering changes)
- Test architecture: 5 E2E + 5 integration scenarios, no mocking codebase components
- **Result**: APPROVED. No CRITICAL/HIGH findings.
