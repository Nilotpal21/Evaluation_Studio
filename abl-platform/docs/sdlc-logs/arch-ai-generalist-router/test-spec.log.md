# SDLC Log: Arch AI Generalist Router — Test Spec

**Phase**: Test Spec (Phase 2)
**Date**: 2026-04-15
**Status**: COMPLETE

---

## Oracle Decisions

All 15 clarifying questions answered without user escalation.

### Test Scope & Priorities

| Q#               | Classification | Decision                                                                                    |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------- |
| Highest-risk FRs | INFERRED       | FR-1 (prompt composition), FR-4 (card completeness), FR-8 (tool_answer resume)              |
| Known edge cases | INFERRED       | Multi-intent near budget, empty messages, boolean tool answers                              |
| Current coverage | ANSWERED       | 40 content-router tests, 30+ golden corpus, 12 prompt tests — all pure function             |
| External deps    | DECIDED        | Only LLM client needs DI mocking. Card selection and prompt composition are pure functions. |
| Test environment | ANSWERED       | vitest, no Docker for unit/integration. E2E needs Studio dev server.                        |

### E2E Scenarios

| Q#                | Classification | Decision                                                                 |
| ----------------- | -------------- | ------------------------------------------------------------------------ |
| Critical journeys | INFERRED       | Cross-domain workflow, tool_answer resume, multi-intent, backward compat |
| Auth combos       | ANSWERED       | Tenant + user only. No project-level permissions for Arch chat.          |
| Cross-feature     | DECIDED        | ONBOARDING regression test (E2E-4)                                       |
| Data seeding      | DECIDED        | Via API calls; legacy session seeding is open question                   |
| Performance       | DECIDED        | Not applicable — pure function changes, marginal token cost increase     |

### Integration Boundaries

| Q#                 | Classification | Decision                                                                 |
| ------------------ | -------------- | ------------------------------------------------------------------------ |
| Service boundaries | ANSWERED       | card-router, prompts/index, route.ts — all pure function or HTTP handler |
| Webhooks/events    | ANSWERED       | N/A — synchronous SSE only                                               |
| Isolation          | ANSWERED       | N/A — card selection is stateless. Session isolation unchanged.          |
| Concurrency        | ANSWERED       | N/A — stateless pure functions                                           |
| Error paths        | DECIDED        | Token budget exhaustion, empty message, boolean tool answer              |

## Test Count Summary

- **E2E scenarios**: 6 (E2E-1 through E2E-6)
- **Integration scenarios**: 7 (INT-1 through INT-7)
- **Unit scenarios**: 8 (UT-1 through UT-8)
- **Security checks**: 6 (all covered by existing parent feature tests)
- **Total FR coverage**: 10/10 FRs mapped in coverage matrix

## Files Created/Updated

- `docs/testing/sub-features/arch-ai-generalist-router.md` — full test spec (replaces placeholder)
- `docs/features/sub-features/arch-ai-generalist-router.md` — §17 updated with test spec references

## Audit Rounds

### Round 1 (quality gates)

- 6 E2E, 7 integration, 8 unit — exceeds minimums
- All 10 FRs in coverage matrix with specific test IDs
- All E2E scenarios specify auth context, no mocks, real HTTP API
- **MEDIUM**: INT-2 references post-implementation API signature — added clarification note
- **Result**: APPROVED with minor fix

### Round 2 (cross-phase consistency)

- All FRs from feature spec covered
- All user stories mapped to test scenarios
- Test files align with feature spec §10
- **Result**: APPROVED
