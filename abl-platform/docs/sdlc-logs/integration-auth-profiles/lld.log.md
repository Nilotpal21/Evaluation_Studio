# SDLC Log: Integration Auth Profiles — LLD

**Date**: 2026-04-03
**Phase**: LLD
**Feature**: Integration Auth Profiles (sub-feature of Auth Profiles)

---

## Oracle Decisions

All 15 clarifying questions answered by product-oracle. Classification breakdown:

| Classification | Count | Questions                |
| -------------- | ----- | ------------------------ |
| ANSWERED       | 6     | Q1, Q2, Q7, Q8, Q10, Q15 |
| INFERRED       | 4     | Q9, Q11, Q13, Q14        |
| DECIDED        | 5     | Q3, Q4, Q5, Q6, Q12      |
| AMBIGUOUS      | 0     | —                        |

No user escalation needed.

## Key Decisions

| #   | Decision                                                                  | Rationale                                                                             |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D-1 | Provider endpoint calls ProviderConfigRegistry directly, not CatalogEntry | CatalogEntry is static catalog format; endpoint needs raw Nango data + profile counts |
| D-2 | connectionConfigFields extraction as shared utility function              | Used in endpoint + UI; prevents regex drift                                           |
| D-3 | Bridge userId = createdBy for scope='user', null for scope='tenant'       | Matches ConnectorConnection unique index semantics                                    |
| D-4 | Bridge logic in source routes; workspace routes continue re-exporting     | DRY; both paths get bridge logic                                                      |
| D-5 | E2E tests as dedicated final phase after all implementation phases        | E2E needs full stack; each phase has own integration/unit tests                       |

## Files Created

| File                                                           | Purpose                   |
| -------------------------------------------------------------- | ------------------------- |
| `docs/plans/2026-04-03-integration-auth-profiles-impl-plan.md` | LLD + Implementation Plan |
| `docs/sdlc-logs/integration-auth-profiles/lld.log.md`          | This log                  |

## Audit Rounds

### Round 1 — NEEDS_CHANGES (2 CRITICAL, 4 HIGH)

| Severity | Finding                                                                    | Resolution                                                                     |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| CRITICAL | Bridge creation fails for tenant-scoped profiles — projectId required:true | **Fixed**: Project uses params.id, workspace uses `'_workspace'` sentinel      |
| CRITICAL | withRouteHandler signature mismatch in provider endpoint code samples      | **Fixed**: Corrected to `(options, handler)` pattern with proper destructuring |
| HIGH     | i18n completely missing for UI phases                                      | **Fixed**: Added task 5.6 with translation key inventory                       |
| HIGH     | No SWR cache invalidation strategy specified                               | **Fixed**: Added to task 6.5 with mutate() details                             |
| HIGH     | Provider endpoint missing ensureDb() and lazy model import                 | **Fixed**: Added to both provider endpoints                                    |
| HIGH     | Bridge creation missing encryptionKeyVersion field                         | **Fixed**: Added `encryptionKeyVersion: 1` + bridge pre-check for idempotency  |

### Round 2 — NEEDS_CHANGES (1 CRITICAL, 3 HIGH)

| Severity | Finding                                                   | Resolution                                                              |
| -------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| CRITICAL | Workspace endpoint uses non-existent `requireAuth` option | **Fixed**: Changed to `permissions: StudioPermission.AUTH_PROFILE_READ` |
| HIGH     | withTransaction import path wrong (subpath not exported)  | **Fixed**: Changed to `@agent-platform/shared/repos`                    |
| HIGH     | API client passes Promise to handleResponse (type error)  | **Fixed**: Added `await apiFetch()` then `handleResponse(res)`          |
| HIGH     | ListResponse requires pagination field                    | **Fixed**: Used simple `{ success, data }` response type                |

### Round 3 — NEEDS_CHANGES (1 CRITICAL, 3 HIGH)

| Severity | Finding                                                    | Resolution                                                 |
| -------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| CRITICAL | LLD drops test spec E2E-10 (connectionConfig success path) | **Fixed**: All 14 scenarios now aligned 1:1 with test spec |
| HIGH     | Client API missing encodeURIComponent for projectId        | **Fixed**: Added encodeURIComponent                        |
| HIGH     | Test file names inconsistent between LLD sections          | **Deferred**: Will align during implementation             |
| HIGH     | Phase 4 OAuth test file missing from New Files table       | **Fixed**: Added to table                                  |

### Round 4 — NEEDS_REVISION (2 CRITICAL, 3 HIGH)

| Severity | Finding                                                          | Resolution                                                              |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CRITICAL | E2E-9 (multiple profiles) not in test spec — scope violation     | **Fixed**: E2E numbering aligned 1:1 with test spec                     |
| CRITICAL | Missing E2E-10 (connectionConfig success path) from test spec    | **Fixed**: Added as E2E-10                                              |
| HIGH     | Phase 4 missing template validation for UNRESOLVED_TEMPLATE_VARS | **Fixed**: Added task 4.3 with validation code                          |
| HIGH     | Workspace bridge projectId vs provider query projectId mismatch  | **Fixed**: Added clarifying note to Phase 2                             |
| HIGH     | E2E numbering diverges from test spec                            | **Fixed**: All 14 scenarios now match test spec numbers and FR coverage |

### Round 5 — APPROVED (0 CRITICAL, 2 MEDIUM, 2 LOW)

| Severity | Finding                                             | Resolution                                      |
| -------- | --------------------------------------------------- | ----------------------------------------------- |
| MEDIUM   | Phase 4 exit criteria says "4 tests" but defines 5  | **Fixed**: Updated to "5 integration tests"     |
| MEDIUM   | Test spec E2E-10 URL format conflicts with Option D | **Noted**: Will handle during Phase 7 E2E impl  |
| LOW      | mapAuthTypeForBridge missing `basic` type           | **Deferred**: Unlikely for integration profiles |
| LOW      | Unnecessary `as ErrorCode` cast in template check   | **Deferred**: Harmless                          |

**Result**: APPROVED — all CRITICAL and HIGH findings resolved across 5 rounds. LLD ready for implementation.
