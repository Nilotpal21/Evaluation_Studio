# Test Spec Log: Module Studio Wiring

**Date**: 2026-03-25
**Phase**: TEST-SPEC
**Artifact**: `docs/testing/sub-features/module-studio-wiring.md`

## Oracle Decisions

All clarifying questions answered by product-oracle. No AMBIGUOUS items.

| #   | Classification | Decision Summary                                                                                           |
| --- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| Q1  | DECIDED        | Highest risk: FR-6 (loadDependencies lifecycle) — only path that feeds all downstream authoring surfaces   |
| Q2  | ANSWERED       | No known production edge cases — feature is unwired, so no production usage yet                            |
| Q3  | ANSWERED       | Current coverage: 27 tests across 4 files; all test individual components, none test wiring layer          |
| Q4  | DECIDED        | Mock HTTP API layer for integration tests; Zustand store and hooks are real                                |
| Q5  | ANSWERED       | Test env: Vitest (happy-dom) for unit/integration, Playwright (Chromium) for E2E, PM2 for Studio server    |
| Q6  | DECIDED        | Critical journeys: settings page nav, dependencies page nav, imported symbols appearing after project load |
| Q7  | DECIDED        | Auth via `devLogin()` helper; single user role sufficient (all nav items unconditional per FR-9)           |
| Q8  | DECIDED        | E2E-3 (imported symbols) and E2E-6 (tool picker) test cross-feature interactions                           |
| Q9  | ANSWERED       | Data seeding via API calls in `beforeAll`; cleanup in `afterAll`                                           |
| Q10 | DECIDED        | No performance/load E2E — deferred to manual ALPHA validation (lightweight API, max 5 items)               |
| Q11 | DECIDED        | Integration boundary: module-store → Zustand → useImportedSymbols hook → authoring components              |
| Q12 | ANSWERED       | No webhook/event flows — purely client-side store lifecycle                                                |
| Q13 | DECIDED        | Cross-project isolation: S5 E2E test verifies store data doesn't leak across project switch                |
| Q14 | DECIDED        | INT-4 documents race condition as regression marker (last-write-wins with no abort controller)             |
| Q15 | DECIDED        | INT-2 covers API failure degradation; INT-7 covers feature flag disabled state                             |

## Audit Rounds

### Round 1: NEEDS_REVISION

- 1 CRITICAL, 3 HIGH, 2 MEDIUM findings
- [TS-4] CRITICAL: E2E-7 `page.route()` mocking → Added convention note documenting established project pattern
- [TS-5] HIGH: No E2E isolation test → Added S5 cross-project dependency store isolation scenario
- [TS-6] HIGH: E2E-4/E2E-5 incomplete auth context → Expanded to full tenant+project+user triples
- [TS-1/TS-3] HIGH: FR-8 no E2E coverage → Extended E2E-5 to verify releases list + archive buttons
- [TS-3] MEDIUM: Coverage matrix missing PLANNED indicators → Updated all cells
- [TS-9] MEDIUM: Test file mapping unclear mock boundaries → Added describe block split documentation

### Round 2: APPROVED

- 1 MEDIUM finding: INT-4 referenced non-existent GAP-004 → Fixed to describe race condition directly
- All round 1 fixes verified
- Cross-phase consistency PASS on all 5 checks

## Test Spec Summary

| Type        | Count  | Scenarios          |
| ----------- | ------ | ------------------ |
| E2E         | 7+1    | E2E-1 to E2E-7, S5 |
| Integration | 7      | INT-1 to INT-7     |
| Unit        | 12     | UT-1 to UT-12      |
| Security    | 5      | S1 to S5           |
| **Total**   | **32** |                    |

## Files Created/Updated

- `docs/testing/sub-features/module-studio-wiring.md` — test spec (rewritten from placeholder)
