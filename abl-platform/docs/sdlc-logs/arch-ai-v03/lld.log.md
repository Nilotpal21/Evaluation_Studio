# LLD Log: Arch AI v0.3

**Date**: 2026-04-06
**Phase**: LLD (retroactive hybrid — documenting what exists + remaining work)
**HLD**: `docs/specs/arch-ai-v03.hld.md` (APPROVED)
**Artifact**: `docs/plans/2026-04-06-arch-ai-v03-impl-plan.md`

## Oracle Decisions

13 clarifying questions asked, 0 escalated to user.

| #   | Question                           | Classification | Key Finding                                                 |
| --- | ---------------------------------- | -------------- | ----------------------------------------------------------- |
| Q1  | HLD open question priority         | DECIDED        | OQ-5 (stuck sessions) P0, OQ-4 (rate limit) P1              |
| Q2  | Code review items: PR vs follow-up | DECIDED        | All 4 deferred items are follow-up PRs                      |
| Q3  | Route extraction boundaries        | INFERRED       | 6 blocks, LLM adapter + journal helpers first               |
| Q4  | Retroactive vs forward LLD         | DECIDED        | Hybrid: document existing + plan remaining                  |
| Q5  | Additional test coverage needed    | INFERRED       | 3 more streaming E2E + IN_PROJECT workaround                |
| Q6  | Module boundaries                  | ANSWERED       | 9 subdirectories, each with single responsibility           |
| Q7  | Tool count and groups              | ANSWERED       | 16 tools in 4 groups (Interview/Blueprint/Build/IN_PROJECT) |
| Q8  | Specialist status                  | ANSWERED       | 4 wired, 2 partial, 3 prompt-only, 5 defined-only           |
| Q9  | Mixed-type migration path          | INFERRED       | Add typed fields + backfill, low risk                       |
| Q10 | Testing gap                        | ANSWERED       | DynamicTabRenderer + ArtifactPanel untested                 |
| Q11 | Breaking change risks              | INFERRED       | LOW-MEDIUM, mainly pnpm-lock + Dockerfile sync              |
| Q12 | Performance concerns               | INFERRED       | Aggregate timeout missing, client disconnect detection      |
| Q13 | Production monitoring              | DECIDED        | 3-tier: Tier 1 for ALPHA, Tier 2 for BETA                   |

## Audit Rounds

- Round 1: NEEDS_CHANGES — 2C (buildSubPhase enum, phantom rate limiter) + 3H + 4M → fixed
- Round 2: NEEDS_CHANGES — 3H (rate limiter, buildSubPhase, LLM resolution) + 4M + 1L → fixed
- Round 3: NEEDS_CHANGES — 2H (JournalService signature, IArchSession interface) + 3M + 1L → fixed
- Round 4: NEEDS_REVISION — 1C (OQ-2 saga missing) + 3H (FR traceability, error count, test mapping) + 3M → fixed
- Round 5: **APPROVED** — 2 MEDIUM + 2 LOW (informational, for post-impl-sync)
