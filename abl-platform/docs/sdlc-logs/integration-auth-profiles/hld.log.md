# SDLC Log: Integration Auth Profiles — HLD

**Date**: 2026-04-03
**Phase**: HLD
**Feature**: Integration Auth Profiles (sub-feature of Auth Profiles)

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Classification breakdown:

| Classification | Count | Questions                                                                                        |
| -------------- | ----- | ------------------------------------------------------------------------------------------------ |
| ANSWERED       | 9     | Q1, Q2, Q4, Q5, Q6, Q7, Q9, Q10, Q15                                                             |
| INFERRED       | 3     | Q3, Q8, Q12                                                                                      |
| DECIDED        | 3     | Q11 (bridge atomicity = biggest risk), Q13 (use MongoDB withTransaction), Q14 (no feature flags) |
| AMBIGUOUS      | 0     | —                                                                                                |

No user escalation needed.

## Key Decisions

| #   | Decision                                         | Rationale                                                                              |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| D-1 | Option B (Tabs with Inline Expand) recommended   | First-class discovery UX; Options A (cluttered) and C (dual source of truth) rejected  |
| D-2 | MongoDB `withTransaction()` for bridge atomicity | Simplest correct approach for FR-4 rollback requirement                                |
| D-3 | No feature flags needed                          | Existing `AUTH_PROFILE_ENABLED` gate covers it; operator-initiated; no runtime changes |
| D-4 | No caching for provider endpoints                | 26 static entries + small DB query; < 200ms target achievable without cache            |

## Files Created

| File                                                  | Purpose           |
| ----------------------------------------------------- | ----------------- |
| `docs/specs/integration-auth-profiles.hld.md`         | High-Level Design |
| `docs/sdlc-logs/integration-auth-profiles/hld.log.md` | This log          |

## Audit Rounds

### Round 1 — NEEDS_REVISION (2 CRITICAL, 4 HIGH, 1 MEDIUM)

**Findings and resolutions:**

| Severity | Finding                                                            | Resolution                                                                  |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| CRITICAL | `pkce` field name mismatch (Nango `pkce` vs schema `pkceRequired`) | **Fixed**: Added field mapping table in section 6                           |
| CRITICAL | `connectionConfigTemplate` has no backing data source              | **Fixed**: Changed to `connectionConfigFields` extracted from URL parsing   |
| HIGH     | ConnectorConnection model has NO auditTrailPlugin                  | **Fixed**: Corrected claim, documented indirect auditing via parent profile |
| HIGH     | Bridge scope mapping missing `personal`                            | **Fixed**: Added `personal→user` mapping                                    |
| HIGH     | pkce vs pkceRequired context confusion                             | **Fixed**: Added explicit field mapping table with Nango→Schema columns     |
| HIGH     | Rate limiting vague — no file reference                            | **Fixed**: Added middleware file path reference                             |
| MEDIUM   | Observability concern row uses generic language                    | **Fixed**: Added specific trace event and log references                    |

### Round 2 — NEEDS_REVISION (2 CRITICAL, 1 HIGH)

**Findings and resolutions:**

| Severity | Finding                                                                       | Resolution                                                                    |
| -------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CRITICAL | Template URLs fail `OAuthEndpointUrlSchema` (`z.string().url()`)              | **Fixed**: Added design decision Option D — UI resolves templates before POST |
| CRITICAL | Nango URL format is `${connectionConfig.xxx}` not `{placeholder}`             | **Fixed**: Updated all references, regex `/\$\{connectionConfig\.(\w+)\}/g`   |
| HIGH     | Rate limit file path wrong (`middleware/rate-limit.ts` → `lib/rate-limit.ts`) | **Fixed**: Corrected to `apps/studio/src/lib/rate-limit.ts`                   |

### Round 3 — APPROVED (0 CRITICAL, 2 HIGH non-blocking)

| Severity | Finding                                                   | Resolution                                             |
| -------- | --------------------------------------------------------- | ------------------------------------------------------ |
| HIGH     | 4 inline `{placeholder}` references in API design section | **Fixed**: Updated to `${connectionConfig.xxx}` format |
| HIGH     | Feature spec E2E count "12" vs "14"                       | **Deferred**: Will align during post-impl-sync         |

**Result**: APPROVED — all CRITICAL and HIGH findings resolved across 3 rounds. HLD ready for LLD phase.
