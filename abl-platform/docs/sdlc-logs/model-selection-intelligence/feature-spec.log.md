# SDLC Log: Model Selection Intelligence — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-04-05
**Status**: COMPLETE

## Oracle Decisions

All 15 clarifying questions answered — no AMBIGUOUS items escalated to user.

| #   | Question                       | Classification          | Decision                                                              |
| --- | ------------------------------ | ----------------------- | --------------------------------------------------------------------- |
| Q1  | New vs enhancement             | ANSWERED                | Enhancement — static helper exists, needs dynamic registry            |
| Q2  | BUILD only or IN_PROJECT too   | ANSWERED (IP-F03)       | Both phases                                                           |
| Q3  | Out of scope                   | INFERRED                | Fine-tuning, hosting, migration, benchmarking                         |
| Q4  | Static registry vs runtime API | DECIDED                 | Static MODEL_REGISTRY for capabilities; runtime API for tenant models |
| Q5  | Full registry vs curated       | DECIDED                 | Curated primary, full registry as "see all"                           |
| Q6  | Primary persona                | INFERRED                | Agent developer, secondary: project owner                             |
| Q7  | Proactive suggestions          | ANSWERED (backlog)      | Yes, in IN_PROJECT mode                                               |
| Q8  | Cost format                    | ANSWERED (IP-F03)       | Relative primary, absolute optional                                   |
| Q9  | Tenant-provisioned only        | DECIDED                 | Tenant-provisioned first, note unprovisioned alternatives             |
| Q10 | Widget vs markdown             | INFERRED                | Widget for IN_PROJECT, inline for BUILD                               |
| Q11 | Packages affected              | ANSWERED                | apps/studio (primary), packages/compiler (read)                       |
| Q12 | Persist recommendations        | DECIDED                 | Yes, in session journal                                               |
| Q13 | Internal + specialist-visible  | ANSWERED (staging spec) | Both — internal for BUILD, visible tool for IN_PROJECT                |
| Q14 | Tenant policy interaction      | INFERRED                | Must respect provider allowlists and budgets                          |
| Q15 | Token budget                   | DECIDED                 | Server-side filtering, LLM sees ~500 tokens of candidates             |

## Files Created

- `docs/features/model-selection-intelligence.md` — Feature spec (18/18 sections)
- `docs/testing/model-selection-intelligence.md` — Testing guide placeholder
- `docs/sdlc-logs/model-selection-intelligence/feature-spec.log.md` — This log

## Index Updates

- `docs/features/README.md` — Added row #87
- `docs/testing/README.md` — Added row #87

## Audit Results

- Round 1: All quality gates PASS. 6 user stories, 11 FRs, 6 integrations, isolation addressed.
- Round 2: Cross-phase consistency verified. No CRITICAL/HIGH findings.

## Key Discoveries

- `getModelRecommendation()` already exists at `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` with static logic
- `MODEL_REGISTRY` has 147+ models with full capabilities at `packages/compiler/src/platform/llm/model-registry.ts`
- `ModelCapabilities` type at `packages/compiler/src/platform/llm/model-capabilities.ts` includes vision, streaming, parallel tools, reasoning
- IP-F03 spec at `docs/arch/features/IP-F03-model-recommendation.md` defines the IN_PROJECT tool requirements
- Staging pipeline spec at `docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md` defines `get_model_recommendation` as internal helper

## Next Phase

Run `/test-spec model-selection-intelligence`
