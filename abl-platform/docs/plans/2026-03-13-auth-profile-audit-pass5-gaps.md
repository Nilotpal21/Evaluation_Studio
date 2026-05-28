# Auth Profile Implementation Plans — Pass 5 Audit (Gaps & Misrepresentations)

> **Auditor:** Claude Opus 4.6
> **Date:** 2026-03-13
> **Previous audit:** `docs/plans/2026-03-13-auth-profile-audit-pass3-gaps.md` (9 findings: 2 HIGH, 4 MEDIUM, 3 LOW)
> **Plans Re-Audited:**
>
> 1. GAP-3.1: Preflight Consent Modal (pass 4 revision)
> 2. GAP-3.2: Partial Consent Handling (pass 4 revision)
> 3. GAP-3.3: Consent Persistence (pass 4 revision)
> 4. GAP-3.4: Batch Consent UI (pass 4 revision)
> 5. Infrastructure Gaps (pass 4 revision)
> 6. Deferred Types & Addons (pass 4 revision)

---

## Resolution Status of Pass 3 Findings

### HIGH Findings (2/2 RESOLVED)

**P3-4 (ConsentStateResolver spec): RESOLVED.** GAP-3.3 now has a dedicated Section 4A ("ConsentStateResolver Service Specification") with the full TypeScript interface (Section 4A.1), dual-read algorithm (Section 4A.2), scope comparison logic with `isScopeSatisfied` (Section 4A.3), near-expiry handling with 5-second timeout (Section 4A.4), error cases table (Section 4A.5), and caching strategy -- no caching, fresh per-request (Section 4A.6). This is comprehensive and addresses the finding completely.

**P3-8 (Tenant isolation bypass safeguards): RESOLVED.** GAP-3.3 Section 5.1 now specifies the bypass mechanism: `EndUserOAuthToken.collection.distinct('tenantId')` (direct MongoDB driver access). Four safeguards are documented: (1) the `distinct` query returns only tenant IDs, no token data; (2) all subsequent per-tenant queries go through the plugin-scoped model; (3) a mandatory code comment documenting the bypass; (4) no direct driver access for any query returning token data.

### MEDIUM Findings (4/4 RESOLVED)

| Finding                                  | Status   | Evidence                                                                                                                                                                                                                                                  |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-2 (FanOutBranchAuthContext ambiguity) | RESOLVED | GAP-3.2 Section 7.6 now says: "already implemented for connection mode validation; consent state fields will be added in Phase 2."                                                                                                                        |
| P3-3 (Handoff table clarity)             | RESOLVED | GAP-3.2 Section 8 task table correctly lists it as implementation work. The ambiguity was minor.                                                                                                                                                          |
| P3-5 (OAuth callback two-step flow)      | RESOLVED | GAP-3.1 Section 5.1 step 5 now has an explicit "Two-step callback flow" description: (a) provider redirects to Studio callback page, (b) callback page calls runtime API, (c) callback page posts result via `postMessage`. GAP-3.3 task scope clarified. |
| P3-7 (Inline consent queuing mechanism)  | RESOLVED | GAP-3.2 Section 3.4 `ConsentRequiredError` class now includes a full "Queuing mechanism" paragraph: client-side FIFO queue, one popup at a time, GAP-3.4 or widget SDK implements the queue, runtime coalesces tool results.                              |

### LOW Findings (3/3 RESOLVED)

| Finding                                | Status   | Evidence                                                                                                                                                                                        |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-1 (Task 9 HMAC text)                | RESOLVED | GAP-3.3 Section 11, Phase B, Task 9 now reads: "Implement AES-256-GCM encrypted state parameter with nonce (Redis SETEX for replay prevention)."                                                |
| P3-6 (AuthProfileOAuthDialog location) | SEE P5-1 | GAP-3.4 Task 2.3 was updated -- but the update introduced a new misrepresentation. See finding P5-1 below.                                                                                      |
| P3-9 (Studio test panel identity)      | RESOLVED | GAP-3.3 Section 11 has a new "Phase D+" with Task 20a addressing this. GAP-3.1 Sprint N+2 step 6 also now includes the task. Both plans reference using the developer's user ID as `contactId`. |

---

## NEW Findings in Pass 4 Revised Plans

### Finding P5-1: GAP-3.4 Task 2.3 Claims `AuthProfileOAuthDialog` "Does Not Yet Exist" -- It Does

- **Severity**: MEDIUM
- **Plan**: GAP-3.4
- **Issue**: GAP-3.4 Section 14, Phase 2, Task 2.3 says: "Create `AuthProfileOAuthDialog` component (does not yet exist in codebase -- new file)." This was added in pass 4 to resolve P3-6, but it is factually incorrect. The component already exists at `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` (250 lines). It was created in the Phase 1 commit (`b6c928532`). The component handles single-connector OAuth popup flows, including popup management, `postMessage` callback, and error states.
- **Evidence**: `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` exists with props `{ open, projectId, authProfileId, connectorName, displayName, onSuccess, onClose }`. The callback page `apps/studio/src/app/oauth/auth-profile-callback/page.tsx` also exists and posts `auth-profile-oauth-callback` messages.
- **Resolution**: Update Task 2.3 to: "Wire existing `AuthProfileOAuthDialog` component (`apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`) for single-connector auth within the batch consent flow. Extend its props if needed to accept `sessionId` for consent-mode OAuth state parameter inclusion."

### Finding P5-2: GAP-3.1 References Wrong OAuth Callback Page

- **Severity**: LOW
- **Plan**: GAP-3.1
- **Issue**: GAP-3.1 Section 5.1 step 4 says to "reuse existing popup pattern from `apps/studio/src/app/oauth/connection-callback/page.tsx`." The auth-profile OAuth flow already has its own dedicated callback page at `apps/studio/src/app/oauth/auth-profile-callback/page.tsx`, which posts the `auth-profile-oauth-callback` message type. The `connection-callback/page.tsx` is for connector connection OAuth flows, not auth profile consent flows. The two-step callback description in step 5 should reference the correct page.
- **Evidence**: `AuthProfileOAuthDialog.tsx` line 42 defines `MESSAGE_TYPE = 'auth-profile-oauth-callback'`. The `auth-profile-callback/page.tsx` line 15 defines `OAUTH_MESSAGE_TYPE = 'auth-profile-oauth-callback'`. The `connection-callback/page.tsx` uses a different message type for connector connections.
- **Resolution**: Update GAP-3.1 Section 5.1 step 4 to reference `apps/studio/src/app/oauth/auth-profile-callback/page.tsx` instead of `connection-callback/page.tsx`. Update step 5 to note that the existing auth-profile callback page already implements the two-step flow.

### Finding P5-3: Type Mismatch Between `checkPreflightAuth` Return and `ConsentStateResolver` Return

- **Severity**: MEDIUM
- **Plan**: GAP-3.1, GAP-3.3
- **Issue**: GAP-3.1 Section 4.2 defines `checkPreflightAuth` as returning `{ pending: AuthConsentRequirement[], satisfied: AuthConsentRequirement[] }`. GAP-3.3 Section 4A.1 defines `ConsentStateResolver.resolve()` as returning `{ satisfied: ConsentEntry[], pending: PendingConsentEntry[] }`. These are structurally different types: `AuthConsentRequirement` includes `displayName`, `authorizationUrl`, `authType`, `consentMode`; `ConsentEntry` only has `connector`, `scopes`, `authProfileId?`, `grantedAt?`. The mapping between `ConsentStateResolver` output and `checkPreflightAuth` output is never specified. Since `checkPreflightAuth` calls `ConsentStateResolver` (GAP-3.1 step 5), it must transform the result, but the transformation logic is not described.
- **Evidence**: GAP-3.1 Section 4.2 step 5 says "delegate to GAP-3.3's `ConsentStateResolver.checkToken()`" but the resolver's method is actually called `resolve()` (GAP-3.3 Section 4A.1). The return types differ, and no mapping function is specified.
- **Resolution**: Add a note to GAP-3.1 Section 4.2 describing the transformation: `checkPreflightAuth` calls `ConsentStateResolver.resolve()`, then enriches each `PendingConsentEntry` back into `AuthConsentRequirement` by joining with the original `preflight_auth_requirements` from `CompilationOutput` (which has the `displayName`, `authorizationUrl`, etc.). Also fix the method name reference from `checkToken()` to `resolve()`.

### Finding P5-4: GAP-3.3 `GracePeriodProfile` Interface Does Not Match Infrastructure Plan Target

- **Severity**: LOW
- **Plan**: GAP-3.3, Infrastructure Gaps
- **Issue**: GAP-3.3 Section 16 ("Existing Schema Acknowledgment") says to "verify if grace period logic is already partially implemented before implementing Section 5.3." The `resolveWithGracePeriod` function at `packages/shared/src/services/auth-profile/grace-period.ts` exists and implements the try/catch/fallback logic (lines 28-47). However, the `GracePeriodProfile` interface (line 9) uses `updatedAt: Date` as the grace period anchor, which is the bug documented in Infrastructure Gaps Gap 1. The Infrastructure Gaps plan (Phase B step 3) correctly identifies this as needing `rotationStartedAt`. GAP-3.3 Section 5.3 ("On-Demand Refresh at Runtime") references the grace period logic but does not mention the `updatedAt` vs `rotationStartedAt` anchor issue. Since GAP-3.3 depends on Infrastructure Gaps Gap 1, the dependency is correctly stated, but a developer implementing GAP-3.3 Section 5.3 could inadvertently use the buggy `updatedAt`-based anchor if Gap 1 is not yet completed.
- **Evidence**: `grace-period.ts` line 40: `Date.now() - profile.updatedAt.getTime() < profile.rotationGracePeriodMs`. No `rotationStartedAt` field exists yet.
- **Resolution**: Add a note to GAP-3.3 Section 5.3: "IMPORTANT: The grace period anchor in `resolveWithGracePeriod` currently uses `updatedAt`, which resets on every document save. Infrastructure Gaps Gap 1 Phase B must be completed first to add `rotationStartedAt` as the correct anchor. Do not use `resolveWithGracePeriod` for consent token validation until Gap 1 is deployed."

---

## Cross-Plan Consistency Check

### Consent State Model: CONSISTENT

All four GAP plans reference GAP-3.1 Section 3.1 as the canonical source. No contradictions found in pass 4 revisions.

### WS Event Names: CONSISTENT

All plans reference the unified set from GAP-3.1 Section 5.1.

### Sprint Sequencing: CONSISTENT

All plans agree on N (compiler) -> N+1 (runtime) -> N+2 (UI) -> N+3 (persistence + inline + channels).

### OAuth Callback Flow: MOSTLY CONSISTENT

GAP-3.1 now has the two-step callback description (pass 4 addition), GAP-3.3 tasks 7-8 are correctly scoped to runtime API. However, the wrong callback page is referenced (P5-2).

### ConsentStateResolver: CONSISTENT IN INTENT, INCONSISTENT IN TYPES

GAP-3.1, GAP-3.2, and GAP-3.3 all reference `ConsentStateResolver` as the token lookup service. The interface is well-defined in GAP-3.3 Section 4A. However, the return type mismatch (P5-3) means the calling code in GAP-3.1 needs a transformation step that is not described.

### Inline Consent Queuing: CONSISTENT

GAP-3.2 Section 3.4 now specifies client-side queuing. GAP-3.4 is referenced as the implementor. No contradictions.

---

## Codebase Verification of Pass 4 Claims

### Claim: `AuthProfileOAuthDialog` does not exist in codebase

**FALSIFIED.** File exists at `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` (250 lines, created in Phase 1 commit `b6c928532`). See finding P5-1.

### Claim: OAuth callback page is `connection-callback/page.tsx`

**PARTIALLY INCORRECT.** The connection-callback page exists but is for connector connections. Auth profile OAuth uses `auth-profile-callback/page.tsx`. See finding P5-2.

### Claim: `ConsentStateResolver` has no implementation in codebase

**VERIFIED.** Grep for `ConsentStateResolver` across all `.ts` files returns zero matches. This is correctly identified as new work.

### Claim: `rotationStartedAt` does not exist on `AuthProfile`

**VERIFIED.** No matches in `packages/database/src/models/auth-profile.model.ts`.

### Claim: `resolveWithGracePeriod` uses `updatedAt` anchor

**VERIFIED.** `grace-period.ts` line 40 uses `profile.updatedAt.getTime()`. No `rotationStartedAt` reference.

---

## Summary

| Severity  | Pass 3 Findings | Pass 5 Status    | New Pass 5 Findings |
| --------- | --------------- | ---------------- | ------------------- |
| CRITICAL  | 0               | N/A              | 0                   |
| HIGH      | 2               | 2/2 RESOLVED     | 0                   |
| MEDIUM    | 4               | 4/4 RESOLVED     | 2 (P5-1, P5-3)      |
| LOW       | 3               | 3/3 RESOLVED     | 2 (P5-2, P5-4)      |
| **Total** | **9**           | **9/9 RESOLVED** | **4 new**           |

### Pass 5 Verdict

All 9 findings from pass 3 have been resolved. The two HIGH gaps (ConsentStateResolver spec and tenant isolation safeguards) are fully addressed with detailed specifications.

The 4 new findings are minor:

- **0 CRITICAL** -- no architectural contradictions remain
- **0 HIGH** -- all significant design gaps are addressed
- **2 MEDIUM** -- `AuthProfileOAuthDialog` existence misrepresentation (P5-1, introduced by pass 4 fix for P3-6), type mismatch between `checkPreflightAuth` and `ConsentStateResolver` return types (P5-3)
- **2 LOW** -- wrong callback page reference (P5-2), grace period anchor dependency ordering note (P5-4)

**Top 2 Actions Before Implementation:**

1. **Fix `AuthProfileOAuthDialog` claim in GAP-3.4** (P5-1) -- the component already exists; the plan should reference it, not create it.
2. **Add type transformation note to GAP-3.1** (P5-3) -- describe how `ConsentStateResolver` output maps to `checkPreflightAuth` return type.
