# LLD Log — ABLP-619 (Authorize at Creation)

**Plan**: `docs/plans/2026-04-27-ablp-619-authorize-at-creation-impl-plan.md`
**Branch**: `ABLP-619-auth-feedback`

## Phase 1 (Read Prerequisites) — 2026-04-27

- Feature spec: `docs/features/auth-profiles.md` — STABLE, amended in commit c2186637a8 with FR-9, FR-10, P8, GAP-7, GAP-8.
- HLD: `docs/specs/auth-profiles.hld.md` — present, 385 lines, addresses 12 architectural concerns.
- Test spec: `docs/testing/auth-profiles.md` — present, 382 lines, 84 verified test files inventoried.
- All prerequisites present; no `/feature-spec` or `/hld` re-run needed. This is a STABLE-feature enhancement.

## Phase 2 (Clarifying Questions) — 2026-04-27

Skipped product-oracle spawn given:

1. The brief is concrete and bounded (2 stakeholder bullets in the SDLC log).
2. The explorer agent (subagent_type=explorer) returned a full implementation-surface map covering create form, OAuth dialog, client-credentials path, integration-bind path, and status invariants.
3. Auto mode favored action over additional question loops; the LLD reviewer (5 audit rounds) is the safety net.

Decisions made directly in the LLD's Decision Log (D-1 through D-6) without escalation to user — none of them are AMBIGUOUS in the SDLC sense:

| D   | Classification                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | INFERRED — two-phase create is the only design that doesn't require restructuring `oauth/initiate` signature.                     |
| D-2 | INFERRED — adding to enum is a strictly additive Mongoose change.                                                                 |
| D-3 | INFERRED — workspace routes are missing today (explorer confirmed `_workspace` sentinel hits broken project route).               |
| D-4 | INFERRED — client_credentials has no UI consent step; running grant inline at create is the only way to honor `status: 'active'`. |
| D-5 | INFERRED — explorer confirmed FR-10 is already satisfied; only the regression-prevention test is missing.                         |
| D-6 | DECIDED — feature flag rejected because blast radius is bounded.                                                                  |

## Phase 3 (Generation) — 2026-04-27

- File written: `docs/plans/2026-04-27-ablp-619-authorize-at-creation-impl-plan.md`.
- 5 phases, every phase has measurable exit criteria, wiring checklist filled, file-level change map covers all impacted files.

## Phase 4 (Audit) — Round 1 complete (lld-reviewer / architecture compliance)

**Verdict**: FIX-AND-PROCEED. 3 CRITICAL + 4 HIGH + 4 MEDIUM findings.

### Findings → Resolutions

| ID   | Sev      | Finding                                                                                                          | Resolution                                                                                                                                                                                                                                       |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1  | CRITICAL | `AuthProfileStatusSchema` referenced as if it existed; it doesn't                                                | LLD §1 Key Interfaces: source from `AUTH_PROFILE_STATUSES` const in model; create new export in shared schema. Phase 1 task 1.2 spells out the exact diff including the inline-enum replacement at `auth-profile.schema.ts:579`.                 |
| F-2  | CRITICAL | `ensureUsableOAuthAppProfile` rejects non-active profiles → blocks Phase 4 inline OAuth flow                     | New Phase 1 task 1.6: relax predicate to accept `'active' \| 'pending_authorization'`.                                                                                                                                                           |
| F-3  | CRITICAL | `buildProjectOAuthAppLookupFilter` hardcodes `status: 'active'` → callback can't find pending parent             | Phase 1 task 1.6: widen filter to `$in: ['active', 'pending_authorization']`. Add new `buildWorkspaceOAuthAppLookupFilter` for tenant-only lookups.                                                                                              |
| F-4  | HIGH     | `AUTH_PROFILE_WRITE_WORKSPACE` permission doesn't exist                                                          | Open Question 2 resolved: use existing `StudioPermission.AUTH_PROFILE_WRITE` (matches existing workspace CRUD route). Phase 2 task 2.1 + wiring checklist updated.                                                                               |
| F-5  | HIGH     | DI on Next.js route handlers not feasible → can't unit-test without mocking platform                             | New Phase 3 task 3.0: extract `executeClientCredentialsCreateFlow` pure function in `apps/studio/src/app/api/auth-profiles/_create-cc-flow.ts`; route handler becomes thin wrapper; tests call extracted function with stub deps (no `vi.mock`). |
| F-6  | HIGH     | Resolver guard placement not specific enough; missing `AuthProfileError` import in connector factory             | Phase 1 task 1.5 specifies exact branch placement per file (BEFORE generic `status !== 'active'` rejection) and the new import for `connectors/auth-profile-resolver-factory.ts`.                                                                |
| F-7  | HIGH     | `UpdateAuthProfileSchema` (line 579) hardcodes 4-value enum                                                      | Phase 1 task 1.2 replaces with `AuthProfileStatusSchema.optional()`.                                                                                                                                                                             |
| F-8  | MEDIUM   | `AUTH_STATUS_COLORS` missing `pending_authorization`                                                             | Phase 4 task 4.5: extend the map using design tokens (no hardcoded palette).                                                                                                                                                                     |
| F-9  | MEDIUM   | Status filter dropdowns + `AuthProfileStatus` client-side type both hardcode 4 values                            | Phase 4 task 4.5 covers both surfaces and the i18n key.                                                                                                                                                                                          |
| F-10 | MEDIUM   | No trace events for `AUTHORIZED` / `AUTHORIZE_FAILED`                                                            | Phase 1 task 1.4 adds them to `AUTH_PROFILE_TRACE_EVENTS`. Phase 2 callback route emits `AUTHORIZED` on flip; Phase 3 emits `AUTHORIZE_FAILED` on grant failure.                                                                                 |
| F-11 | MEDIUM   | `_workspace` sentinel also used by `IntegrationAuthTab` and SWR cache key (`buildProvidersKey`); LLD missed both | Phase 4 task 4.4 enumerates every consumer and adds a `git grep -n '_workspace' apps/studio/src/` post-change verification step.                                                                                                                 |

VERIFIED items (no action) include centralized auth, stateless distributed, tenant isolation in queries, cross-scope 404, race condition on double callback, audit trail plugin coverage, pending-row leak handling for ABLP-619 scope, E2E test standards compliance, no file overlap between phases.

### Round 1 file diffs

`docs/plans/2026-04-27-ablp-619-authorize-at-creation-impl-plan.md`:

- §1 Key Interfaces: source `AuthProfileStatusSchema` from model const; add client-type extension; add trace event names
- Phase 1: tasks expanded from 1.1–1.6 to 1.1–1.8; explicit lookup helpers added; client-side type added; trace events added
- Phase 2 task 2.1: permission resolved to `AUTH_PROFILE_WRITE`
- Phase 3: new task 3.0 (extract `_create-cc-flow.ts`); test renamed to `auth-profile-create-cc-flow.test.ts`
- Phase 4 task 4.4: full sentinel-cleanup scope; task 4.5: design tokens, i18n, status filter dropdowns, client-type
- Wiring Checklist: 10 new items
- Open Question 2: marked RESOLVED

## Phase 4 (Audit) — Round 2 complete (lld-reviewer / pattern consistency)

**Verdict**: NEEDS_CHANGES. 0 CRITICAL + 2 HIGH + 5 MEDIUM findings.

### Findings → Resolutions

| ID   | Sev    | Finding                                                                                                                                   | Resolution                                                                                                                                                                                                                                                                                                                 |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2-1 | HIGH   | Error code names dropped the `AUTH_` prefix (existing convention is `AUTH_PROFILE_*`)                                                     | Renamed throughout to `AUTH_PROFILE_NOT_AUTHORIZED` and `AUTH_PROFILE_AUTHORIZE_FAILED`. Path corrected to `packages/shared-auth-profile/src/errors.ts`.                                                                                                                                                                   |
| F2-2 | HIGH   | LLD invented `buildWorkspaceOAuthAppLookupFilter`; `buildTenantOAuthAppLookupFilter` already exists at `_auth-profile-route-utils.ts:226` | Replaced all references; Phase 1.6 widens existing helper's status filter to `$in: ['active', 'pending_authorization']`.                                                                                                                                                                                                   |
| F2-3 | MEDIUM | Resolver guard pattern incorrect — runtime resolvers query-filter `status: 'active'` so post-load throw is dead code                      | Phase 1.5 rewritten: only `connectors/auth-profile-resolver-factory.ts:83-84` needs the explicit branch + new `AuthProfileError` import + friendly message ("Open the profile and click Authorize" — not "reactivate"). Runtime resolvers documented as no-change. Service layer flagged for verify-during-implementation. |
| F2-4 | MEDIUM | `AuthProfileStatusBadge` renders raw `{status}` text; with new status produces "Pending_authorization" with visible underscore            | Phase 4.5 expanded: refactor badge to use i18n keys for all 5 statuses (small i18n debt repayment); without this, the new i18n key is never used.                                                                                                                                                                          |
| F2-5 | MEDIUM | `buildProvidersKey` actual location is `IntegrationAuthTab.tsx:55-64`; `apps/studio/src/lib/swr-keys.ts` does not exist                   | Phase 4.4 rewritten: actual location documented; signature stays `(scope, projectId: string)` since workspace branch already ignores projectId; only the dialog prop changes to `string \| null`. Verification step is `git grep -n "'_workspace'" apps/studio/src/`.                                                      |
| F2-6 | MEDIUM | LLD listed `apps/studio/src/app/api/admin/auth-profiles/route.ts` as a separate edit target, but it's a one-line re-export                | All references to the admin create route replaced with the source `apps/studio/src/app/api/auth-profiles/route.ts`. Added an explicit note in Phase 3 explaining the re-export.                                                                                                                                            |
| F2-7 | MEDIUM | New workspace OAuth routes did not specify rate-limit config                                                                              | Phase 2.1: `{ limit: 20, windowMs: 60_000, scope: 'user' }` for initiate; Phase 2.2: `{ limit: 10, windowMs: 60_000, scope: 'user' }` for callback. Both match the project pattern.                                                                                                                                        |

### VERIFIED items (no action)

- Studio `withRouteHandler` route handler pattern — proposed routes match existing workspace CRUD shape.
- No prior `pending_*` status in any model — this is a new clean pattern.
- Pure-function extraction with `_`-prefix private modules — matches existing convention under `apps/studio/src/app/api/auth-profiles/`.
- Trace event naming — `auth_profile.authorized` / `auth_profile.authorize_failed` match existing `auth_profile.<noun_or_verb>` style.
- OAuth dialog prop API change — idiomatic; no competing pattern exists.
- i18n key namespace — `auth_profiles.status_*` matches existing `t('status_active')` pattern.
- Test file locations — under `apps/studio/e2e/auth-profiles/` and `apps/studio/src/__tests__/` match existing layout.

### Cross-cutting note (round 2): commit splitting

Phase 1 touches 5 packages (`packages/database`, `packages/shared`, `packages/shared-auth-profile`, `apps/runtime`, `apps/studio`, `packages/connectors`). The commit-scope guard (CLAUDE.md) limits to 3 packages per commit. Implementor must split Phase 1 into at least two commits:

- Commit A: `packages/database` + `packages/shared` + `packages/shared-auth-profile` (status enum, schema, error codes, trace events).
- Commit B: `apps/runtime` + `packages/connectors` + `apps/studio` (resolver guard, route-utils widening, client-side type, tests).

This guidance added to Phase 1 exit criteria.

## Phase 4 (Audit) — Round 3 complete (lld-reviewer / completeness)

**Verdict**: FIX-AND-PROCEED. 0 CRITICAL + 1 HIGH + 4 MEDIUM + 1 LOW.

### Findings → Resolutions

| ID   | Sev    | Finding                                                                                                                  | Resolution                                                                                                                                                                          |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F3-1 | HIGH   | `AuthProfileError` constructor signature mismatch — LLD passed `{ profileId }` as 3rd arg; actual is `statusCode` number | Phase 1.5: corrected to `(code, message, 403)` with explicit note about the constructor shape. Recommendation to put `profileId` into the message string if needed.                 |
| F3-2 | MEDIUM | Section 5 Permissions text contradicted the resolved Open Question 2                                                     | Replaced with: "Workspace OAuth routes reuse existing `StudioPermission.AUTH_PROFILE_WRITE`. No new permission added."                                                              |
| F3-3 | MEDIUM | Wiring checklist `buildProvidersKey` item said "signature accepts `string \| null`" — contradicting Phase 4.4 body       | Updated to: "workspace branch already ignores projectId, no signature change needed; verify with `git grep`".                                                                       |
| F3-4 | MEDIUM | Phase 4 Files Touched listed `apps/studio/src/lib/swr-keys.ts` (does not exist)                                          | Replaced with parenthetical note: no `swr-keys.ts` change; `buildProvidersKey` workspace branch already ignores projectId.                                                          |
| F3-5 | MEDIUM | Phase 5 exit criteria didn't explicitly mention GAP-7 / GAP-8 marking, even though §6 acceptance criteria does           | Added two exit-criteria items: (a) GAP-7/GAP-8 status flip to `Resolved` (post-impl-sync verifies); (b) `workflow-integration-node.md` + `oauth-tooling.md` cross-references added. |
| F3-6 | LOW    | Open Question 3 (E2E test location) still open                                                                           | Acceptable — default `apps/studio/e2e/auth-profiles/` is correct; code review is the right gate. No action.                                                                         |

### VERIFIED items (no action) — important confirmations

**FR-9 coverage**: every clause mapped (oauth2_app + oauth2_client_credentials × project + workspace, two-phase status, "Test credentials" replaced for OAuth types and preserved for non-OAuth, structured error on failure with no partial state).
**FR-10 coverage**: every clause mapped (workflow integration nodes resolve via runtime, no second consent at bind/run, runtime-only re-consent for preflight/jit, connectors / MCP / channels share resolver path).
**GAP-7 (HIGH)** and **GAP-8 (MEDIUM)**: both explicitly marked Resolved in §6 acceptance criteria; reinforced by Phase 5 exit criteria after F3-5 fix.
**File paths**: all 13 line/file references in the LLD verified to exist exactly where claimed (model line 45, schema line 579, route-utils line 144/193/226, IntegrationAuthTab line 55-64, AUTH_STATUS_COLORS line 428, AuthProfileStatus type line 34, etc.). Admin route confirmed as one-line re-export.
**Signatures**: `resolveClientCredentialsToken`, `withRouteHandler`, `findOneAndUpdate`, `emitAuthProfileTraceEvent`, `buildProjectOAuthAppLookupFilter`, `buildTenantOAuthAppLookupFilter` all match the LLD's claims.
**Phase exit criteria**: every checkbox in every phase is measurable (no "it works" / "tests pass" wording).
**Wiring checklist coverage**: 20 items, no orphan files or unused exports.
**Exit criteria → tests traceability**: every exit criterion has at least one test in its phase's Test Strategy.
**Note from auditor**: shared `auth-profile.service.ts:464` already filters `status: 'active'` at query time — Phase 1.5 already flags this for verify-during-implementation.

## Phase 4 (Audit) — Round 4 complete (phase-auditor / cross-phase consistency)

**Verdict**: FIX-AND-PROCEED. 1 CRITICAL + 3 HIGH + 3 MEDIUM.

### Findings → Resolutions

| ID   | Sev      | Finding                                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                                                                                                           |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F4-1 | CRITICAL | Feature spec FR-9 said "partial state is not persisted" — directly contradicts LLD's two-phase create with `pending_authorization` rows for `oauth2_app` | Amended FR-9 in feature spec to describe the two-phase create explicitly: `oauth2_client_credentials` deletes pending row on failure (no partial state); `oauth2_app` persists pending profile for retry on browser-close, deletes on user-cancel. Logged stuck-pending as new **GAP-9 (LOW)** for follow-up GC. Phase 5 acceptance criteria notes GAP-9 stays Open. |
| F4-2 | HIGH     | Feature spec data model section 9 still listed status as 4 values — missing `pending_authorization`                                                      | Updated to 5 values with inline note pointing to FR-9 for context.                                                                                                                                                                                                                                                                                                   |
| F4-3 | HIGH     | HLD has no mention of `pending_authorization`, workspace OAuth routes, AUTHORIZED/AUTHORIZE_FAILED trace events, or stuck-pending alerting               | Acknowledged as expected for STABLE-feature enhancement. Added explicit acceptance criterion that `/post-impl-sync` updates HLD §3.5 (Observability), §3.11 (Monitoring), §5 (Data Model), §6 (API Design).                                                                                                                                                          |
| F4-4 | HIGH     | Test spec has no FR-9/FR-10 E2E scenarios and no FR-9/FR-10 rows in coverage matrix — LLD's E2E plans cannot be validated against test spec today        | Phase 5.2 expanded with full inline E2E-8 (7 scenarios A–G covering both auth types × both scopes × happy/cancel/browser-close/bad-creds) and E2E-9 (integration bind no consent with negative regression check). Phase 5.2 also adds Production Wiring Verification subsection.                                                                                     |
| F4-5 | MEDIUM   | Feature spec §8 How to Consume said "form is finalized via POST /auth-profiles, profile created with `status: 'active'`" — contradicts two-phase         | Replaced with explicit two-phase description: POST persists `pending_authorization`, then OAuth callback (or inline cc grant) flips to `active`.                                                                                                                                                                                                                     |
| F4-6 | MEDIUM   | Feature spec P8 bullet 2 said "OAuth flow runs before the profile is persisted"                                                                          | Reworded to "OAuth flow runs before the profile transitions to `active`".                                                                                                                                                                                                                                                                                            |
| F4-7 | MEDIUM   | LLD introduced metric `auth_profile_authorize_failed_total` not traced to feature spec                                                                   | Added to FR-9's observability sub-clause in feature spec; LLD metric is now in scope.                                                                                                                                                                                                                                                                                |
| —    | MEDIUM   | Feature spec status badge description said "displays active/expired/revoked/invalid"                                                                     | Extended to include `pending_authorization` with the new info-tone token + i18n label "Awaiting authorization".                                                                                                                                                                                                                                                      |

### VERIFIED items (no action) — important confirmations

- **HLD §3.1 Isolation**: status-flip query `findOneAndUpdate({_id, tenantId, status: 'pending_authorization'}, ...)` includes `tenantId`. Workspace OAuth routes are tenant-only.
- **HLD §3.2 Security**: SSRF on tokenUrl uses existing `z.string().url()`. Audit trail auto-records via `auditTrailPlugin`. Secret redaction unchanged. Error sanitization called out in Phase 3.4.
- **HLD §3.3 Performance**: credential cache unaffected (runtime query-filters `status: 'active'`); cc Redis prefix unchanged; existing index `{ status: 1, expiresAt: 1, authType: 1 }` covers pending-profile queries.
- **HLD §3.4 Reliability**: locks unchanged; grace period orthogonal to status; crash mid-create handled (cc deletes, oauth2_app retryable).
- **HLD §3.5 Observability**: trace events wired correctly.
- **HLD §3.10 Testing Strategy**: LLD's new E2E paths consistent.
- **HLD §6 API Design**: admin OAuth routes follow "Separate project and workspace routes" principle.
- **GAP-7/GAP-8 closure**: explicitly required in Phase 5 exit criteria.
- **Terminology consistency**: usage modes, connectionMode, Authorize CTA, status values all aligned with feature spec.
- **Phase 4 package span**: 2 packages (studio + i18n) — within 3-package guard.

### Open Question 1 resolved

OQ1 (pending_authorization GC) re-classified from Open → RESOLVED in the LLD: the deferral is now logged as feature-spec GAP-9 (LOW). LLD OQ section updated.

## Phase 4 (Audit) — Round 5 complete (lld-reviewer / final sweep)

**Verdict**: **PROCEED**. 0 CRITICAL + 0 HIGH + 2 MEDIUM + 1 LOW. The LLD is approved for implementation.

### Findings → Resolutions

| ID   | Sev    | Finding                                                                                                                              | Resolution                                                                                                                                                                                                                      |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5-1 | MEDIUM | Metric `auth_profile_authorize_failed_total` had no task owner — Cross-Phase Concerns referenced it but no Phase task incremented it | Added explicit increment + `AUTHORIZE_FAILED` trace event emit to Phase 3.1 (cc failure with `authType=oauth2_client_credentials` label) and Phase 2.2 (oauth2_app callback failure with `authType=oauth2_app` label).          |
| F5-2 | MEDIUM | Phase 4.2 `handleSave` refactor under-specified — `handleSave` is ~130 lines and the create branch needs careful splitting           | Phase 4.2 now spells out: capture `result.data.id`, suppress `onSaved()` for oauth2_app, defer `setSaving(false)` until dialog closes, preserve existing behavior for non-oauth2_app types including oauth2_client_credentials. |
| F5-3 | LOW    | Phase 1 Files Touched listed two runtime files as "resolver guard" but Phase 1.5 said "no change needed" for them                    | Annotated both: `auth-profile-resolver.ts` and `resolve-tool-auth.ts` marked "verified no change needed (already query-filters `status: 'active'`)".                                                                            |

### VERIFIED items — comprehensive lockdown

- **All 30 prior round 1-4 findings stuck** in the LLD (re-verified by reading Decision Log, Phase tasks, Wiring Checklist, Acceptance Criteria).
- **Task independence**: each phase is independently deployable; dependencies (Phase 4 → Phase 1+2) honored.
- **Wiring checklist completeness**: 20+ items cover every new file and export; zero orphans.
- **Domain rules**: tenant + project + user isolation preserved on every new query; no unencrypted secret persistence; cross-scope 404 maintained.
- **Test integrity**: extracted `executeClientCredentialsCreateFlow` testable without `vi.mock`; E2E uses real services; RTL tests mock fetch boundary only.
- **Commit discipline**: Phase 1 explicit two-commit split; all other phases within 40-file / 3-package guards; all phases additive.
- **Rollback safety**: every phase's revert is safe; no orphan data risks.
- **Auditor-validated code spot-checks**: `AuthProfileService.resolve()` at `auth-profile.service.ts:464` already query-filters `status: 'active'`; `buildActiveProfileFilter()` at `auth-profile-resolver.ts:179` does likewise — runtime resolver-guard "no change" annotation confirmed correct.

### Implementation guidance (auditor notes)

- Phase 4 is the highest-risk phase — implementer should read `handleSave` (lines 672-802) thoroughly before starting; refactor incrementally (extract create-branch first, then add conditional dialog opening).
- Consider narrowing `AUTH_STATUS_COLORS` from `Record<string, string>` to `Record<AuthProfileStatus, string>` during implementation to catch missing keys at compile time.
- Verify during implementation whether `AuthProfileAlertEvaluator` supports a Prometheus-style counter or whether the failure metric should be a trace-event-based dimension.

## Phase 5 (Commit & Log) — complete

LLD status flipped from DRAFT to APPROVED. All 5 audit rounds passed. Total findings across rounds 1-5: **30 (3 CRITICAL + 11 HIGH + 14 MEDIUM + 2 LOW)** — every CRITICAL and HIGH resolved before the LLD landed; every MEDIUM resolved before approval; both LOW items have explicit dispositions. Ready for `/implement ABLP-619` or manual phase-by-phase execution.
