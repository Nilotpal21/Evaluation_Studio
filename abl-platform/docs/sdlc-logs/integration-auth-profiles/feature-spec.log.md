# SDLC Log: Integration Auth Profiles — Feature Spec

**Date**: 2026-04-03
**Phase**: FEATURE-SPEC
**Feature**: Integration Auth Profiles (sub-feature of Auth Profiles)

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Classification breakdown:

| Classification | Count | Questions                                                                                    |
| -------------- | ----- | -------------------------------------------------------------------------------------------- |
| ANSWERED       | 12    | Q1, Q2, Q3, Q5, Q6, Q7, Q10, Q11, Q12, Q13, Q14, Q15                                         |
| INFERRED       | 2     | Q4 (priority/timeline), Q8 (must-have vs nice-to-have)                                       |
| DECIDED        | 1     | Q9 (performance — no special requirements needed given 26 connectors + small profile counts) |
| AMBIGUOUS      | 0     | —                                                                                            |

No user escalation was needed — all questions resolved from design doc, impl plan, and codebase.

## Key Decisions

| #   | Decision                                              | Rationale                                                                                                     |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| D-1 | Sub-feature placement (`docs/features/sub-features/`) | Narrower than parent Auth Profiles (STABLE major feature); adds integration catalog + Nango pre-fill          |
| D-2 | No performance requirements                           | Static catalog of 26 connectors + small profile counts per tenant; existing `CredentialCache` handles runtime |
| D-3 | 11 functional requirements                            | Maps to 6 impl phases + existing `usageMode` (no new FRs for persistence/runtime)                             |

## Files Created

| File                                                           | Purpose                   |
| -------------------------------------------------------------- | ------------------------- |
| `docs/features/sub-features/integration-auth-profiles.md`      | Feature spec              |
| `docs/testing/sub-features/integration-auth-profiles.md`       | Testing guide placeholder |
| `docs/sdlc-logs/integration-auth-profiles/feature-spec.log.md` | This log                  |

## Open Questions (3)

1. Should `providers.json` population run in CI or stay manual?
2. Custom auth connectors with Nango match — show both auth types or only Nango-resolved?
3. Should bridge `ConnectorConnection` unique index allow multiple integration auth profiles per connector?

## Audit Rounds

### Round 1 — NEEDS_REVISION (1 CRITICAL, 4 HIGH, 2 MEDIUM)

**Findings and resolutions:**

| Severity | Finding                                                                                                              | Resolution                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CRITICAL | FR-2 (`scopes`→`defaultScopes` mismatch) factually incorrect — `oauth2_app` already uses `defaultScopes` at line 198 | **Fixed**: Removed FR-2 entirely. Removed GAP-005. Updated design doc and impl plan to correct the same error. |
| HIGH     | FR-5 needs testable atomicity decision for bridge creation failures                                                  | **Fixed**: FR-4 (renumbered) now mandates rollback. Reliability section updated. Open question #2 resolved.    |
| HIGH     | FR-6 needs error path for missing `connectionConfig` template variables                                              | **Fixed**: FR-5 (renumbered) now specifies 400 error with descriptive message for unresolved templates.        |
| HIGH     | Testing §17 had only 1 E2E row vs 12 planned                                                                         | **Fixed**: Expanded to 18 rows including 5 explicit E2E scenarios.                                             |
| HIGH     | FR-6 extends parent OAuth flow in undocumented ways                                                                  | **Accepted**: FR-5 (renumbered) now documents the extension explicitly. Design doc §6.3 provides the source.   |
| MEDIUM   | (noted but not blocking)                                                                                             | —                                                                                                              |

### Round 2 — APPROVED (1 HIGH resolved, 1 HIGH cross-phase deferred)

**Findings and resolutions:**

| Severity | Finding                                                                                                  | Resolution                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| HIGH     | UI Components table (line 158) still referenced `scopes`→`defaultScopes` fix for `auth-type-metadata.ts` | **Fixed**: Updated to describe `getIntegrationTypeMetadata()` helper only.               |
| HIGH     | FR-4 rollback not reflected in design doc §6.6 or impl plan Phase 3 test count                           | **Deferred**: Cross-phase finding — will be addressed in `/test-spec` and `/hld` phases. |
| MEDIUM   | Minor wording improvements suggested                                                                     | **Accepted**: No action needed.                                                          |

**Result**: APPROVED — all CRITICAL and HIGH findings within feature spec scope resolved. Cross-phase items logged for downstream phases.
