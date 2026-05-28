# Test Spec Log: Agent Governance Dashboard

**Date**: 2026-04-29
**Phase**: Test Spec (Phase 2)
**Artifact**: `docs/testing/governance.md`
**Status**: COMPLETE

---

## Scope Change Applied

User requested compliance framework checklists (SOC2, GDPR, EU AI Act) be moved from Phase 2 Non-Goals into MVP scope before the test spec was authored. Feature spec was updated with FR-32 through FR-36 prior to test spec generation.

## Coverage Summary

- **Total FRs covered**: 36 (FR-1 through FR-36)
- **E2E scenarios**: 15 (E2E-1 through E2E-15)
- **Integration scenarios**: 10 (INT-1 through INT-10)
- **Security/isolation scenarios**: 12 explicit (Section 6)

## Key Decisions

| #   | Question                               | Classification | Decision                                                                                            |
| --- | -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Q1  | ClickHouse seeding utilities           | INFERRED       | Use `packages/pipeline-engine/src/__tests__/test-utils.ts` (must be verified before implementation) |
| Q2  | Redis cache bust in E2E tests          | DECIDED        | Short TTL (`GOVERNANCE_STATUS_CACHE_TTL_SECONDS=5`) or `?nocache=true` — LLD must choose            |
| Q3  | PDF structural validation              | DECIDED        | Magic byte check in E2E; framework section content is manual-only for Phase 1                       |
| Q4  | Framework service testability          | DECIDED        | Pure functions with no external dependencies → zero mocks required for INT-9, INT-10                |
| Q5  | Override teardown in E2E-13            | DECIDED (open) | Method to delete override mid-test (DELETE endpoint vs DB teardown utility) deferred to LLD         |
| Q6  | DI pattern for GovernanceStatusService | DECIDED (open) | Constructor injection preferred; LLD must specify                                                   |

## Files Created/Updated

- `docs/testing/governance.md` — full test spec (36 FRs, 15 E2E, 10 integration, 12 security, file mapping, infrastructure, open questions)
- `docs/sdlc-logs/governance/test-spec.log.md` — this file

## Quality Gate Verification

- [x] ≥5 E2E scenarios: 15 ✓
- [x] ≥5 integration scenarios: 10 ✓
- [x] Every FR appears in coverage matrix: FR-1 through FR-36 ✓
- [x] Security & isolation section filled: Section 6, 12 scenarios ✓
- [x] E2E auth context specified on each scenario ✓
- [x] No vi.mock of platform components referenced ✓
- [x] Test file mapping complete: Section 8, 12 test files ✓
- [x] No TODO stubs: all scenarios have concrete steps and pass criteria ✓
- [x] Structured content types used (not just plain strings) ✓

## Open Items for HLD

- Redis cache invalidation strategy for E2E tests (short TTL vs nocache param)
- Override delete mechanism for test teardown in E2E-13
- DI pattern for GovernanceStatusService (constructor injection vs module-level import)
- ClickHouse test-utils path verification
