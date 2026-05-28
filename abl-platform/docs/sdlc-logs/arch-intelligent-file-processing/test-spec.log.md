# SDLC Log: Arch Intelligent File Processing — Test Spec

**Date**: 2026-04-12
**Phase**: TEST-SPEC
**Status**: APPROVED (round 2)

## Oracle Decisions

All 15 questions answered — 0 AMBIGUOUS.

Key decisions:

- FR-7/8/9 (code changes) are highest risk; FR-1–6 (prompts) are low risk
- `buildFilePreamble()` is a pure synchronous function — zero mocking needed
- Existing B03 tests cover current preamble behavior (4 unit, 3 integration, 7 E2E)
- Mock LLM server pattern exists for intercepting system prompts
- E2E auth uses dev-login route with `ENABLE_DEV_LOGIN=true`
- Evicted files must NOT appear in category annotations

## Audit Results

### Round 1: NEEDS_REVISION

- 2 CRITICAL: E2E-7 direct DB, FR-3–6 no integration coverage
- 5 HIGH: test file mapping, INT-5 reclassification, INT-1 is unit test, isolation checks, auth context
- 2 MEDIUM: SSE stream verification, LLM env vars

### Round 2: APPROVED

- 3 MEDIUM (non-blocking): Section 5 cross-references, file mapping drift from feature spec, UT-12 missing svg+xml
- Deferred to implementation (fix file mapping in feature spec when tests are written)

## Files Modified

- `docs/testing/sub-features/arch-intelligent-file-processing.md` — REWRITTEN (from placeholder to full test spec)
- `docs/sdlc-logs/arch-intelligent-file-processing/test-spec.log.md` — NEW

## Test Inventory

- 12 unit test scenarios (UT-1 through UT-12)
- 5 integration test scenarios (INT-1 through INT-5)
- 7 E2E test scenarios (E2E-1 through E2E-7)
- 4 manual validation scenarios (M-1 through M-4)
- 4 test files mapped

## Next Phase

Run `/hld arch-intelligent-file-processing` to generate the high-level design.
