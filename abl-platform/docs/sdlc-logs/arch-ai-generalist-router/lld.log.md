# SDLC Log: Arch AI Generalist Router — LLD

**Phase**: LLD (Phase 4)
**Date**: 2026-04-15
**Status**: COMPLETE

---

## Oracle Decisions

All 15 clarifying questions answered without user escalation.

### Implementation Strategy

| Q#            | Classification | Decision                                                              |
| ------------- | -------------- | --------------------------------------------------------------------- |
| Order         | DECIDED        | Data layer (cards) first, then prompt composition, then route handler |
| Patterns      | ANSWERED       | Follow existing card file pattern (26 existing cards as template)     |
| Feature flag  | DECIDED        | Not needed — internal architecture change                             |
| Phase 1 scope | DECIDED        | All 8 cards + registration + golden corpus tests                      |
| Deadlines     | ANSWERED       | No hard deadline — quality over speed                                 |

### Technical Details

| Q#            | Classification | Decision                                                                             |
| ------------- | -------------- | ------------------------------------------------------------------------------------ |
| Files         | ANSWERED       | 9 new files, 8 modified files. Exact paths from codebase analysis.                   |
| Test strategy | DECIDED        | Test-after for cards (extend golden corpus). Update existing tests for prompt/route. |
| Type changes  | DECIDED        | No type changes. Keep specialist parameter for backward compat (D-3).                |
| Migration     | ANSWERED       | None — activeSpecialist field reused                                                 |
| Performance   | ANSWERED       | Net zero latency. +200-600 tokens per turn from domain cards.                        |

### Risk & Dependencies

| Q#                 | Classification | Decision                                                                     |
| ------------------ | -------------- | ---------------------------------------------------------------------------- |
| Conflicts          | ANSWERED       | No conflicting changes on current branch                                     |
| Biggest risk       | DECIDED        | Knowledge regression — specialist content not fully captured in cards        |
| Review             | ANSWERED       | Standard PR review process                                                   |
| Monitoring         | DECIDED        | Log card selection (selectedIds, skippedIds) in route handler                |
| Definition of done | DECIDED        | All golden corpus tests pass + ONBOARDING regression passes + build succeeds |

## Files Created

- `docs/plans/2026-04-15-arch-ai-generalist-router-impl-plan.md`

## Audit Rounds (5 rounds)

### Round 1 (architecture compliance — isolation, auth, stateless, traceability)

- Pure function changes — no isolation, auth, or statelessness concerns
- Traceability preserved via SSE events and card selection logging
- **Result**: APPROVED — no findings

### Round 2 (pattern consistency)

- Card files follow existing 26-card pattern
- CARD_REGISTRY entries match existing structure
- **MEDIUM**: D-3 (keep specialist param) contradicts feature spec task 3.3 (remove param). Added explicit override note.
- **Result**: APPROVED with clarification

### Round 3 (completeness)

- All 10 FRs mapped to specific phases and tasks
- File paths verified from codebase reads
- Exit criteria are measurable (not "it works")
- **Result**: APPROVED — no findings

### Round 4 (cross-phase consistency — phase-auditor)

- Feature spec 5 tasks → LLD 4 phases: justified grouping
- Test spec scenarios map to LLD exit criteria
- HLD chosen alternative matches LLD approach
- **Result**: APPROVED — no findings

### Round 5 (final sweep — task independence, wiring, domain rules)

- Each phase independently deployable and rollbackable
- Wiring checklist complete (cards → registry → prompt → route)
- No domain-specific rule violations
- **Result**: APPROVED — no findings
