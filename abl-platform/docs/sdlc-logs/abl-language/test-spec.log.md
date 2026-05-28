# SDLC Log: ABL Language -- Test Spec (Phase 2)

**Date**: 2026-03-22
**Phase**: Test Spec Generation
**Feature**: ABL Language
**Slug**: abl-language

---

## Decision Log

| #   | Question                                              | Classification | Answer                                                                                                                              |
| --- | ----------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which FRs are highest risk?                           | DECIDED        | FR-4 (compilation) and FR-5 (validation) are highest risk -- they are the primary value chain. FR-6 (CEL) has edge case risks.      |
| 2   | What external dependencies need mocking?              | ANSWERED       | Only LLM API calls in the travel booking E2E test need caching/mocking. All other tests are pure library functions.                 |
| 3   | What is the current test coverage baseline?           | ANSWERED       | 25 core test files, 168 compiler test files, 7 language-service test files. All passing as of 2026-03-22.                           |
| 4   | Should isolation tests cover compiler or route level? | DECIDED        | Compiler is stateless and tenant-agnostic. Isolation is enforced at route level (Studio/Runtime). Both levels should be documented. |
| 5   | Are there known edge cases from production?           | INFERRED       | CEL BigInt normalization (GAP-006) and expression length cap are known edge case areas. No production incidents documented.         |

## Files Created/Modified

- `docs/testing/abl-language.md` -- Re-generated test spec with 7 E2E + 7 integration scenarios
- `docs/sdlc-logs/abl-language/test-spec.log.md` -- This log file

## Review Summary

### Round 1 -- Coverage & Completeness

- [x] 7 E2E test scenarios (exceeds minimum 5)
- [x] 7 integration test scenarios (exceeds minimum 5)
- [x] All 15 FRs from feature spec appear in coverage matrix
- [x] E2E scenarios do NOT reference mocks or direct DB access
- [x] Integration scenarios specify service boundaries
- [x] Security & isolation section filled
- [x] Test file mapping covers actual file paths

### Round 2 -- Alignment

- [x] Scenarios cover highest-risk FRs (FR-4, FR-5, FR-6)
- [x] E2E scenarios match user stories from feature spec
- [x] Integration boundaries match data flow from feature spec
