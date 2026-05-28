# SDLC Log: Integration Auth Profiles — Test Spec

**Date**: 2026-04-03
**Phase**: TEST-SPEC
**Feature**: Integration Auth Profiles (sub-feature of Auth Profiles)

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Classification breakdown:

| Classification | Count | Questions                                                                        |
| -------------- | ----- | -------------------------------------------------------------------------------- |
| ANSWERED       | 8     | Q3, Q4, Q5, Q6, Q11, Q12, Q13, Q15                                               |
| INFERRED       | 4     | Q1, Q2, Q9, Q15                                                                  |
| DECIDED        | 3     | Q8 (cross-feature E2E excluded), Q10 (no perf suite), Q14 (one concurrency test) |
| AMBIGUOUS      | 0     | —                                                                                |

No user escalation needed.

## Key Decisions

| #   | Decision                                   | Rationale                                                                                          |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| D-1 | Cross-feature E2E tests excluded           | Feature spec non-goals: no runtime changes. Bridge contract tests sufficient.                      |
| D-2 | No performance test suite                  | Static catalog of 26 connectors + in-memory Nango lookup. Inline response-time assertion only.     |
| D-3 | 12 E2E scenarios, 12 integration scenarios | Covers all 11 FRs. Highest risk: FR-4 (bridge atomicity), FR-3 (visibility), FR-5 (URL templates). |

## Files Created/Updated

| File                                                        | Purpose                                        |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `docs/testing/sub-features/integration-auth-profiles.md`    | Full test specification (replaces placeholder) |
| `docs/sdlc-logs/integration-auth-profiles/test-spec.log.md` | This log                                       |

## Test Count Summary

| Type        | Count        | Key Focus                                                                                     |
| ----------- | ------------ | --------------------------------------------------------------------------------------------- |
| E2E         | 14           | Profile lifecycle, visibility, inheritance, OAuth params, cross-tenant/project isolation, 401 |
| Integration | 12           | Provider endpoint, bridge CRUD + rollback, OAuth URL construction, schema strict mode         |
| Unit        | 8            | UI components (catalog grid, card expand, slide-over pre-fill, usage mode disabling)          |
| Security    | 2 additional | Personal profile name leakage, bridge tenant isolation                                        |

## Audit Rounds

### Round 1 — NEEDS_REVISION (2 CRITICAL, 5 HIGH, 2 MEDIUM)

**Findings and resolutions:**

| Severity | Finding                                                  | Resolution                                                         |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| CRITICAL | No cross-project isolation E2E test                      | **Fixed**: Added E2E-13 (same-tenant user, wrong project → 404)    |
| CRITICAL | No unauthenticated 401 E2E test                          | **Fixed**: Added E2E-14 (no auth header → 401 on all endpoints)    |
| HIGH     | E2E-8 through E2E-12 missing project in auth context     | **Fixed**: All now specify "project P1"                            |
| HIGH     | E2E-8 FR attribution wrong (FR-5 → usageMode validation) | **Fixed**: Corrected to "inherited usageMode validation"           |
| HIGH     | SEC-3 contradicts feature spec GAP-004 (deferred)        | **Fixed**: Removed SEC-3; added note about UI-only restriction     |
| HIGH     | INT-5 mocks DB model without preamble acknowledgment     | **Fixed**: Updated preamble to acknowledge DB mocking for rollback |
| HIGH     | auth-type-metadata test placed outside `__tests__/`      | **Fixed**: Moved to `__tests__/components/`                        |
| MEDIUM   | Test file names differ between feature and test spec     | **Deferred**: Will align during post-impl-sync                     |
| MEDIUM   | No 403 (insufficient permissions) E2E test               | **Accepted**: Complex to seed; covered by middleware integration   |

### Round 2 — APPROVED (0 CRITICAL, 0 HIGH, 1 MEDIUM)

| Severity | Finding                                                          | Resolution                              |
| -------- | ---------------------------------------------------------------- | --------------------------------------- |
| MEDIUM   | Component test file names differ from feature spec section 10/17 | **Deferred**: post-impl-sync will align |

**Result**: APPROVED — all CRITICAL and HIGH findings resolved. Test spec ready for implementation.
