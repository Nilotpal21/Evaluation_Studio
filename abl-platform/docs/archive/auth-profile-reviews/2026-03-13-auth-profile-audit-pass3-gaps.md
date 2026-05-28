# Auth Profile Implementation Plans — Pass 3 Audit (Gaps & Misrepresentations)

> **Auditor:** Claude Opus 4.6
> **Date:** 2026-03-13
> **Previous audit:** `docs/plans/2026-03-13-auth-profile-audit-3-gaps-misrepresentations.md` (26 findings: 2 CRITICAL, 11 HIGH, 8 MEDIUM, 3 LOW)
> **Plans Re-Audited:**
>
> 1. GAP-3.1: Preflight Consent Modal (revised)
> 2. GAP-3.2: Partial Consent Handling (revised)
> 3. GAP-3.3: Consent Persistence (revised)
> 4. GAP-3.4: Batch Consent UI (revised)
> 5. Infrastructure Gaps (revised)
> 6. Deferred Types & Addons (revised)

---

## Resolution Status of Previous Findings

### CRITICAL Findings (2/2 RESOLVED)

**M-1 (Conflicting state machines): RESOLVED.** GAP-3.1 Section 3 now defines a single canonical consent state model in `packages/shared/src/types/auth-consent.ts`. GAP-3.2 Section 3.1 explicitly defers to this model: "This plan uses the canonical consent state model defined in GAP-3.1 Section 3.1." All consent state (`authGate`, `blocked`, `pendingInlineConsent`) lives on `SessionData` in `session/types.ts`. The duplicate `_consentState`/`_blocked`/`_pendingInlineConsent` fields on `RuntimeSession` have been removed. The note in GAP-3.2 Section 3.1 says: "Previous versions of this plan proposed separate fields on RuntimeSession. This has been unified."

**M-5 (False compiler claim): RESOLVED.** GAP-3.1 Dependencies section now clearly states: "The compiler currently has **no** `auth_requirements`, `connection_mode`, or `consent_mode` fields on `AgentIR`, `ToolDefinition`, or `ConnectorBindingIR`." GAP-3.2 Section 2 (Problem Statement) confirms: "verified: zero `auth_requirements`, `consent`, `connection_mode`, or `per_user` references exist anywhere in the compiler source." Both plans acknowledge GAP-3.2 Phase 1 as a prerequisite. Verified against codebase: grep for `auth_requirements|consent_mode|connection_mode|per_user` in `packages/compiler/src` returns zero files.

### HIGH Findings (11/11 RESOLVED)

| Finding                                   | Status   | Evidence                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-2 (Conflicting WS events)               | RESOLVED | GAP-3.2 Section 6.5 now says: "All consent-related WS events are defined once in GAP-3.1 Section 5.1." Both plans use unified set: `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `auth_gate_timeout`, `inline_consent_required`, `inline_consent_satisfied` (server); `auth_consent_denied` (client).                                |
| M-3 (Conflicting blocking)                | RESOLVED | GAP-3.1 Section 4.1 now says: "The enforcement happens inside the runtime executor (`createSessionFromResolved`) so it works for ALL entry points (WebSocket, REST, async channels). The WebSocket/REST handlers simply forward the runtime's response to the client -- they do NOT duplicate the blocking logic." Single enforcement point chosen. |
| M-10 (Voice OAuth impractical)            | RESOLVED | GAP-3.1 Section 5.2 now has explicit deployment-time validation: "For pure voice channels without SMS capability: **this is a deployment-time validation error**." Section 12 adds it as a blocking deployment error.                                                                                                                               |
| M-11 (Anonymous users)                    | RESOLVED | GAP-3.1 Section 3.3 now uses GAP-3.3's 3-tier identity model. GAP-3.3 Section 3.1 explicitly states: "Tier 0: Session-scoped only -- no cross-session." GAP-3.1 Section 17 (Open Question 4) says: "In Studio test panel specifically, use the developer's authenticated identity instead of anonymous." Consistent across plans.                   |
| M-12 (Inline consent mid-turn suspension) | RESOLVED | GAP-3.2 Section 3.4 now uses tool error result pattern: "Return a structured error result to the LLM (do NOT suspend execution)." Includes `ConsentRequiredError` class definition. The "Why this approach" subsection explicitly explains why suspension is impossible.                                                                            |
| M-14 (Circular dependency)                | RESOLVED | Both plans now have explicit Dependencies sections and a unified sprint sequence: Sprint N = GAP-3.2 Phase 1 (compiler), Sprint N+1 = GAP-3.1 + GAP-3.2 Phase 2, Sprint N+2 = GAP-3.4, Sprint N+3 = GAP-3.3 + GAP-3.2 Phase 3.                                                                                                                      |
| M-17 (No rate limiting)                   | RESOLVED | GAP-3.1 Section 9.1-9.2 specifies rate limits: `/user-consent` 10/min/session, `/consent` 5/min/session, `/preflight-link` 3/min/session, `/preflight/:token/status` 20/min/token.                                                                                                                                                                  |
| M-19 (No deploy-time validation)          | RESOLVED | GAP-3.1 Section 12 specifies three blocking deployment errors: missing OAuth app, voice-only without SMS, A2A without shared fallback. GAP-3.2 Section 5.2 says: "deployment validation **errors** (not warns)."                                                                                                                                    |
| M-22 (JWT in preflight URL)               | RESOLVED | GAP-3.1 Section 10.1 now uses opaque tokens: "The `<token>` is an **opaque token** (random UUID) stored in Redis with the session metadata mapped server-side." No more JWT exposure.                                                                                                                                                               |
| M-24 (Timeline conflicts)                 | RESOLVED | Unified sprint sequence across all four GAP plans (see M-14 above).                                                                                                                                                                                                                                                                                 |
| M-26 (Rotation grace period)              | RESOLVED | Infrastructure Gaps plan Section "Gap 1 Migration Note" says: "migration must set `rotationStartedAt = updatedAt` for all existing `AuthProfile` documents that have a non-null `rotationPolicy` and non-null `previousEncryptedSecrets`."                                                                                                          |

### MEDIUM Findings (8/8 RESOLVED)

| Finding                               | Status   | Evidence                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-4 (Conflicting endpoints)           | RESOLVED | GAP-3.1 Section 6.1 defines `POST /api/runtime/sessions/:sessionId/consent` as canonical. GAP-3.2 Section 3.3 references it. GAP-3.4 Section 1.1 note says: "No separate polling endpoint is needed -- the `auth_gate_updated` WS events provide real-time updates." |
| M-8 (Redis pub/sub misrepresentation) | RESOLVED | GAP-3.1 Section 6.2 now says: "this is **new infrastructure** -- no existing Redis pub/sub exists for auth gate coordination."                                                                                                                                       |
| M-13 (Handoff during gate)            | RESOLVED | GAP-3.1 Section 7.7 and GAP-3.2 Section 5.3 now both address handoff with context message: "To continue, [Agent Name] needs access to the following services."                                                                                                       |
| M-15 (Over-engineered notifications)  | RESOLVED | Simplified to: OAuth callback updates session + publishes Redis event; subscribing pod sends WS event. The standalone page polls `/preflight/:token/status` as fallback only.                                                                                        |
| M-18 (Orphaned nonces)                | RESOLVED | GAP-3.1 Section 10.2 says: "Nonce entries use `SETEX` (not bare `SET NX`) with TTL of 10 minutes." GAP-3.3 Section 10.4 also uses "Redis `SETEX` with TTL matching `AUTH_TOKEN_OAUTH_STATE_TTL_SECONDS`."                                                            |
| M-20 (Naming inconsistencies)         | RESOLVED | GAP-3.1 Section 3 establishes canonical naming. All plans reference it. `AuthGate` for session gate, `AuthConsentRequirement` for connector requirements, `ConsentEntry` for satisfied entries, `PendingInlineConsent` for inline state.                             |
| M-23 (OAuth state HMAC vs encryption) | RESOLVED | GAP-3.1 Section 10.2 says "encrypted (AES-256-GCM)." GAP-3.3 Section 10.4 now also says "Encrypted with AES-256-GCM using the platform encryption key (NOT just HMAC-signed)." Consistent.                                                                           |
| M-25 (ChannelAdapter interface)       | RESOLVED | GAP-3.1 Section 5.3 now says: "Create a standalone `sendAuthRequiredMessage(adapter: ChannelAdapter, ...)` function that uses `adapter.sendResponse()`. This avoids adding a new method to the ChannelAdapter interface."                                            |

### LOW Findings (3/3 RESOLVED)

| Finding                               | Status   | Evidence                                                                                                                                                                               |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-9 (CredentialAgeMonitor)            | RESOLVED | Infrastructure Gaps plan correctly tracks as follow-up to Gap 1.                                                                                                                       |
| M-16 (Cross-session over-engineering) | RESOLVED | GAP-3.1 Section 7.5 now says: "No cross-session wildcard pub/sub needed." Concurrent sessions share the token store.                                                                   |
| M-21 (Field name casing)              | RESOLVED | GAP-3.2 uses snake_case in IR types (`auth_requirements`, `connection_mode`, `consent_mode`), camelCase in runtime types (`authGate`, `blocked`). Consistent with codebase convention. |

---

## NEW Findings in Revised Plans

### Finding P3-1: GAP-3.3 Task 9 Still Says "HMAC-signed state parameter"

- **Severity**: LOW
- **Plan**: GAP-3.3
- **Issue**: GAP-3.3 Section 11, Phase B, Task 9 description says: "Implement HMAC-signed state parameter with nonce (Redis SET NX for replay prevention)." This contradicts the corrected Section 10.4 which says the state is "Encrypted with AES-256-GCM." The task title was not updated to match the section text.
- **Evidence**: GAP-3.3 Section 11 Task 9: "Implement HMAC-signed state parameter with nonce." GAP-3.3 Section 10.4: "Encrypted with AES-256-GCM."
- **Resolution**: Update Task 9 description to: "Implement AES-256-GCM encrypted state parameter with nonce (Redis SETEX for replay prevention)."

### Finding P3-2: GAP-3.2 References `FanOutBranchAuthContext` as "Already Implemented" But It Has No Consent Awareness

- **Severity**: MEDIUM
- **Plan**: GAP-3.2
- **Issue**: GAP-3.2 Section 7.6 says: "Each fan-out branch gets its own `FanOutBranchAuthContext` (already implemented)." The `FanOutBranchAuthContext` interface does exist in `apps/runtime/src/services/execution/auth-profile-fanout.ts` (line 27). However, this interface has no `consent_mode` or consent state awareness -- it only tracks `per_user` vs `shared` connection requirements for handoff validation. GAP-3.2 implies it already handles consent state propagation per branch, which it does not.
- **Evidence**: `auth-profile-fanout.ts` exports `FanOutBranchAuthContext` with connection mode checking but zero consent-related fields. The plan says: "Each fan-out branch gets its own `FanOutBranchAuthContext` (already implemented)" followed by "If a branch hits an unsatisfied inline consent: That branch's tool returns CONSENT_REQUIRED error result." The "already implemented" refers to the auth context, not the consent handling, but the parenthetical placement makes it ambiguous.
- **Resolution**: Clarify: "Each fan-out branch gets its own `FanOutBranchAuthContext` (already implemented for connection mode validation; consent state fields will be added in Phase 2)."

### Finding P3-3: GAP-3.2 Section 3.5 Claims `auth-profile-handoff.ts` Has `AuthRequirement` with `consent_mode` -- It Does Not

- **Severity**: MEDIUM
- **Plan**: GAP-3.2
- **Issue**: GAP-3.2 Section 3.5 says to "Extend `AuthRequirement` with `consent_mode` field; skip inline requirements when validating handoff." The table lists this as a "Change" to `auth-profile-handoff.ts`. This is correct as a planned modification. However, the text does not make it clear that this is new work -- the table column header is "Change" which could be read as either "already changed" or "change to make."
- **Evidence**: `auth-profile-handoff.ts` line 15-18: `AuthRequirement` has `connector` and `connectionMode` only. No `consent_mode`. This is correctly identified as work to do in Task 3.5.
- **Resolution**: Minor clarity issue only. The task table in Section 8 correctly lists it as implementation work.

### Finding P3-4: GAP-3.3 ConsentStateResolver Has No Implementation Plan Detail

- **Severity**: HIGH
- **Plan**: GAP-3.3
- **Issue**: `ConsentStateResolver` is referenced in GAP-3.1 (Section 4.2 step 5), GAP-3.2 (Section 3.2 step), and GAP-3.3 (Section 11 Task 4). It is the critical component that checks whether a user has valid tokens for their auth requirements. GAP-3.3 Task 4 describes it as: "Implement `ConsentStateResolver` service: takes `CallerContext` + `authRequirements[]`, returns `{ pending[], satisfied[] }`." However, there is no section in GAP-3.3 that describes the actual implementation logic of this service -- how it does the dual-read (AuthProfile first, EndUserOAuthToken fallback), how it handles scope comparison, how it handles near-expiry tokens. The lookup flow in Section 2.2 describes the conceptual flow, but the `ConsentStateResolver` as a service boundary with its interface, error handling, and caching strategy is not defined.
- **Evidence**: GAP-3.3 Section 2.2 describes a lookup flow that is close to the ConsentStateResolver logic, but it is written as a sequence diagram narrative, not a service specification. Section 4 describes preflight skip logic. Neither section defines the `ConsentStateResolver` interface signature, its return types, its error codes, or whether it caches results within a session.
- **Resolution**: Add a dedicated section to GAP-3.3 for `ConsentStateResolver` specifying: (a) the TypeScript interface signature, (b) the dual-read strategy (AuthProfile first, EndUserOAuthToken fallback), (c) scope comparison logic (`isScopeSatisfied`), (d) near-expiry handling (attempt inline refresh with 5s timeout), (e) error cases (decryption failed, DB unreachable), (f) whether results are cached per-session or per-request.

### Finding P3-5: GAP-3.1 and GAP-3.3 Have Inconsistent OAuth Callback Endpoint Paths

- **Severity**: MEDIUM
- **Plan**: GAP-3.1, GAP-3.3
- **Issue**: GAP-3.1 Section 5.1 (step 6) says the popup calls the OAuth callback at "the existing popup pattern from `apps/studio/src/app/oauth/connection-callback/page.tsx`." GAP-3.1 Section 6.1 says the OAuth callback is at `POST /api/projects/:pid/auth-profiles/oauth/callback`. GAP-3.3 Section 2.3 says: "Implement `/oauth/user-consent` endpoint: generate signed state, redirect to provider" and "Implement OAuth callback handler: exchange code, upsert `EndUserOAuthToken`." But GAP-3.3 Task 7-8 place these in `apps/runtime`, while GAP-3.1 places the callback on the Studio side (the popup page lives in `apps/studio`). The callback page (`connection-callback/page.tsx`) is a Studio Next.js page that receives the redirect from the OAuth provider. But the token exchange (`POST /api/.../oauth/callback`) is a runtime API endpoint. The relationship between the Studio page and the runtime endpoint is not clear.
- **Evidence**: GAP-3.1 Section 5.1 references `apps/studio/src/app/oauth/connection-callback/page.tsx`. GAP-3.3 Tasks 7-8 place OAuth endpoints in `apps/runtime`. The two-step flow (Studio popup page receives redirect -> calls runtime API to exchange code) is implied but never explicitly described as a two-step flow.
- **Resolution**: Add a note to GAP-3.1 Section 5.1 clarifying the two-step callback: (1) OAuth provider redirects to Studio popup page (`/oauth/connection-callback`), (2) popup page extracts the authorization code and calls the runtime API (`POST /api/projects/:pid/auth-profiles/oauth/callback`) to exchange it for tokens, (3) popup page posts result to opener via `postMessage`. GAP-3.3 should clarify that its Tasks 7-8 implement the runtime API side, not the Studio page.

### Finding P3-6: GAP-3.4 References `AuthProfileOAuthDialog` Without Specifying Its Location

- **Severity**: LOW
- **Plan**: GAP-3.4
- **Issue**: GAP-3.4 Section 1.2 (Component Tree) references `<AuthProfileOAuthDialog />` as a reused component. Section 14 Task 2.3 says "Wire `AuthProfileOAuthDialog` reuse for single-connector auth." However, no plan specifies where this component currently lives or whether it needs to be created.
- **Evidence**: Grep for `AuthProfileOAuthDialog` in the codebase finds zero files outside of plan docs. This component does not exist yet.
- **Resolution**: Either (a) GAP-3.1 Sprint N+2 (Web UI) should create this component, or (b) GAP-3.4 Phase 2 should create it as part of the OAuth integration work. Add the component to the appropriate plan's new files list.

### Finding P3-7: GAP-3.2 Maximum Concurrent Inline Consent Limit Has No Queuing Mechanism

- **Severity**: MEDIUM
- **Plan**: GAP-3.2
- **Issue**: GAP-3.2 Section 3.4 says: "Maximum concurrent inline consent: 1 at a time. If multiple tools need consent, they are queued and presented sequentially." Section 7.6 (Fan-Out) says: "Maximum 1 concurrent inline consent prompt at a time; additional are queued." However, neither section describes the queuing mechanism. Since inline consent uses the tool error result pattern (the tool returns an error to the LLM), there is no explicit queue -- the LLM will simply get multiple `CONSENT_REQUIRED` errors if multiple tools need consent in the same turn. The LLM may ask about all of them at once, and the UI would need to manage which popup to show first.
- **Evidence**: The tool error result pattern means the LLM decides what to tell the user. If 3 tools in one turn all return `CONSENT_REQUIRED`, the LLM may mention all 3 in one message. The client would receive 3 `inline_consent_required` WS events. There is no server-side queue.
- **Resolution**: The queuing must be client-side (in the Studio/widget UI). When multiple `inline_consent_required` events arrive, the client should queue them and present one popup at a time. Add this to GAP-3.4 or GAP-3.2's UI section as a client-side responsibility. Alternatively, the runtime could coalesce multiple consent requirements and send a single `inline_consent_required` event with an array of connectors.

### Finding P3-8: GAP-3.3 Background Refresh Worker Admin-Level Query Bypasses Tenant Isolation

- **Severity**: HIGH
- **Plan**: GAP-3.3
- **Issue**: GAP-3.3 Section 5.1 says: "Query distinct tenantIds from EndUserOAuthToken (admin-level query bypassing plugin)." This is a security design decision that needs explicit justification and safeguards. The `tenantIsolationPlugin` exists to prevent cross-tenant access. Bypassing it for a background worker is valid but requires: (a) explicit documentation of why, (b) a mechanism to ensure only the worker bypasses isolation (not accidental leaks), (c) audit logging of the bypass.
- **Evidence**: The plan acknowledges the bypass but does not specify how to implement it safely. The `tenantIsolationPlugin` typically injects `tenantId` into all queries automatically. Bypassing it likely requires either a special model instance without the plugin, or a flag on the query context.
- **Resolution**: Specify the bypass mechanism. Options: (a) Use Mongoose's `Model.collection.distinct('tenantId')` (direct driver access bypasses Mongoose plugins), (b) Create a separate model registration without the tenant isolation plugin for worker-only use, (c) Use an admin context flag recognized by the plugin. Document the chosen approach and add a code comment explaining the bypass.

### Finding P3-9: No Plan Addresses Studio Test Panel Developer Identity for Preflight

- **Severity**: LOW
- **Plan**: GAP-3.1
- **Issue**: GAP-3.1 Section 17 (Open Question 4) says: "In Studio test panel specifically, use the developer's authenticated identity instead of anonymous." This is mentioned as a recommendation but not implemented in any task list. The Studio test panel creates sessions differently from production channels -- it may not set `CallerContext` at all, or it may set the developer's JWT identity. The preflight check would need to know it is in a Studio test context to use the developer identity for token lookup.
- **Evidence**: No task in GAP-3.1 or GAP-3.3 addresses the Studio test panel identity resolution. The `ChatPanel` integration (GAP-3.1 Sprint N+2 Task 3.1) does not mention identity context.
- **Resolution**: Add a task to GAP-3.1 Sprint N+2: "Ensure Studio test panel sets `callerContext.contactId` to the developer's user ID when creating test sessions, so preflight token lookups use the developer's identity." This is a small change but important for developer experience.

---

## Cross-Plan Consistency Check

### Consent State Model: CONSISTENT

All four GAP plans now reference GAP-3.1 Section 3.1 as the canonical source. The types are:

- `AuthGate` on `SessionData` -- GAP-3.1 defines, GAP-3.2/3.3/3.4 reference
- `AuthConsentRequirement` -- defined in shared types, used by all
- `ConsentEntry` -- defined in shared types, used by all
- `PendingInlineConsent` -- defined in shared types, used by GAP-3.2

### WS Event Names: CONSISTENT

All plans reference the same set defined in GAP-3.1 Section 5.1. GAP-3.2 Section 6.5 explicitly defers. GAP-3.4 Section 1.1 references the canonical satisfaction endpoint.

### Inline Consent Approach: CONSISTENT

GAP-3.2 Section 3.4 uses tool error result pattern. GAP-3.1 Section 7.3 uses the same pattern for mid-session token revocation. Both reference `ConsentRequiredError`.

### Sprint Sequencing: CONSISTENT

All plans agree on: N (compiler) -> N+1 (runtime) -> N+2 (UI) -> N+3 (persistence + inline + channels).

### Satisfaction Endpoint: CONSISTENT

All plans reference `POST /api/runtime/sessions/:sessionId/consent` as canonical.

### Identity Model: CONSISTENT

GAP-3.1 uses `callerContext` and defers to GAP-3.3's 3-tier model. GAP-3.3 defines the tiers. GAP-3.2 and GAP-3.4 follow.

### OAuth State Encryption: CONSISTENT

GAP-3.1 Section 10.2 and GAP-3.3 Section 10.4 both say AES-256-GCM (though Task 9 text is stale -- see P3-1).

---

## Codebase Verification of New Claims

### Claim: `CallerContext` has `identityTier`, `channelArtifact`, `contactId`

**VERIFIED.** `packages/shared-auth/src/types/index.ts` has all three fields (lines 69, 71, 93).

### Claim: `resolveWithGracePeriod` already exists

**VERIFIED.** `packages/shared/src/services/auth-profile/grace-period.ts` exports the function (line 28).

### Claim: `isAuthProfileEnabled` function exists in feature flag file

**VERIFIED.** `packages/shared/src/services/auth-profile/feature-flag.ts` exports it (line 11).

### Claim: `FanOutBranchAuthContext` exists in auth-profile-fanout.ts

**VERIFIED.** `apps/runtime/src/services/execution/auth-profile-fanout.ts` defines it (line 27).

### Claim: `auth-profile-handoff.ts` checks `per_user` requirements

**VERIFIED.** The file has `connectionMode: 'per_user' | 'shared'` on `AuthRequirement` (line 17) and checks it (line 65).

### Claim: `VoiceServiceFactory.subscribeToAuthProfileEvents` exists but is not wired

**VERIFIED.** Method exists (line 136) but grep shows no caller wiring it at server startup.

### Claim: `@node-saml/node-saml` is already in Studio dependencies

**VERIFIED.** `apps/studio/package.json` has `"@node-saml/node-saml": "^5.1.0"` (line 39).

### Claim: `ConnectorToolExecutor` is at `packages/connectors/src/executor/connector-tool-executor.ts`

**VERIFIED.** File exists at that path.

### Claim: `ConnectionResolver` has no `hasValidToken` method

**VERIFIED.** Grep for `hasValidToken` in `packages/connectors/src/auth/connection-resolver.ts` returns no matches. This is correctly identified as new work in GAP-3.2 Task 2.3.

### Claim: `rotationStartedAt` does not yet exist on AuthProfile

**VERIFIED.** Grep for `rotationStartedAt` in `packages/database/src/models/auth-profile.model.ts` returns no matches.

### Claim: No consent-related types exist in shared package

**VERIFIED.** Grep for `auth-consent|AuthGate|AuthConsentRequirement|PendingInlineConsent` in `packages/shared/src` returns zero files.

### Claim: No consent-related WS events exist

**VERIFIED.** Grep for `auth_required|auth_gate_updated|inline_consent` in `apps/runtime/src/websocket/events.ts` returns no matches.

---

## Summary

| Severity  | Pass 2 Findings | Pass 3 Status      | New Pass 3 Findings        |
| --------- | --------------- | ------------------ | -------------------------- |
| CRITICAL  | 2               | 2/2 RESOLVED       | 0                          |
| HIGH      | 11              | 11/11 RESOLVED     | 2 (P3-4, P3-8)             |
| MEDIUM    | 8               | 8/8 RESOLVED       | 4 (P3-2, P3-5, P3-7, P3-3) |
| LOW       | 3               | 3/3 RESOLVED       | 3 (P3-1, P3-6, P3-9)       |
| **Total** | **24**          | **24/24 RESOLVED** | **9 new**                  |

### Pass 3 Verdict

All 24 findings from Pass 2 have been resolved. The two CRITICAL gaps (conflicting state machines and false compiler claim) are fully addressed with clear cross-plan references and codebase-verified acknowledgments.

The 9 new findings are lower severity:

- **0 CRITICAL** -- no architectural contradictions or misrepresentations remain
- **2 HIGH** -- `ConsentStateResolver` needs more implementation detail (P3-4), background worker tenant bypass needs safeguards (P3-8)
- **4 MEDIUM** -- minor ambiguities in fan-out consent context (P3-2), OAuth callback flow clarity (P3-5), inline consent queuing mechanism (P3-7), handoff table clarity (P3-3)
- **3 LOW** -- stale task description (P3-1), missing component location (P3-6), Studio test panel identity (P3-9)

**Top 3 Actions Before Implementation:**

1. **Add `ConsentStateResolver` specification to GAP-3.3** (P3-4) -- this service is referenced by 3 plans but has no interface definition.
2. **Specify tenant isolation bypass mechanism for refresh worker** (P3-8) -- security-sensitive design decision.
3. **Clarify OAuth callback two-step flow** (P3-5) -- Studio page vs runtime API responsibility is implied but not explicit.
