# SDLC Log: Arch Intelligent File Processing — Feature Spec

**Date**: 2026-04-12
**Phase**: FEATURE-SPEC
**Status**: APPROVED (round 2)

## Oracle Decisions

All 15 questions answered — 0 AMBIGUOUS (no user escalation needed).

| #   | Classification | Key Decision                                                                             |
| --- | -------------- | ---------------------------------------------------------------------------------------- |
| Q1  | ANSWERED       | Enhancement to B03, not new capability. Adds intelligence layer on top of plumbing.      |
| Q2  | ANSWERED       | v1 out of scope: auto-compile ABL, auto-import OpenAPI, persistent KB, SSE emission      |
| Q3  | ANSWERED       | Primary persona: solution designer (same as B03)                                         |
| Q4  | ANSWERED       | No competing approaches. Zero file instructions in current prompts.                      |
| Q5  | INFERRED       | Not a hard blocker; quality multiplier for Arch UX                                       |
| Q6  | INFERRED       | Top 3: upload specs at start, drop reference YAML mid-build, paste screenshot            |
| Q7  | DECIDED        | Must-have: acknowledgment, extraction, phase-aware. Nice-to-have: category, artifact tab |
| Q8  | DECIDED        | No new performance requirements; existing guards sufficient                              |
| Q9  | ANSWERED       | Affects Interview widget flow, Blueprint topology-first, Build quality                   |
| Q10 | DECIDED        | User data wins over file data, discrepancy noted                                         |
| Q11 | ANSWERED       | Primarily arch-ai prompts + content-block-resolver. No UI changes.                       |
| Q12 | DECIDED        | No DB schema change — export existing classifyFileType() instead                         |
| Q13 | ANSWERED       | No new security surface — prompt-only changes                                            |
| Q14 | DECIDED        | Export existing classifyFileType(), use in buildFilePreamble()                           |
| Q15 | ANSWERED       | No backward compat constraint — internal function, 2 call sites                          |

## Audit Results

### Round 1: NEEDS_REVISION

- 2 CRITICAL: phantom file refs (on different branch), CREATE phase omitted
- 5 HIGH: classifyFileType gap, parent back-ref, exit criteria, FR-11 testability, README indexes
- 2 MEDIUM: coverage expectations, FR-3 tool constraint
- All CRITICAL and HIGH fixed

### Round 2: APPROVED

- 3 MEDIUM (non-blocking): IN_PROJECT mode vs phase terminology, INT-1 test expectation, scenario count mismatch
- INT-1 fixed; other 2 deferred to downstream phases (HLD, test-spec)

## Files Created/Modified

- `docs/features/sub-features/arch-intelligent-file-processing.md` — NEW
- `docs/testing/sub-features/arch-intelligent-file-processing.md` — NEW
- `docs/features/sub-features/README.md` — UPDATED (added row)
- `docs/testing/sub-features/README.md` — UPDATED (added row)
- `docs/features/README.md` — UPDATED (added row to sub-features table)
- `docs/testing/README.md` — UPDATED (added row to P3 table)
- `docs/features/arch-multimodality.md` — UPDATED (added back-reference in integration matrix)

## Next Phase

Run `/test-spec arch-intelligent-file-processing` to generate comprehensive test scenarios.
