# Auth Profile Implementation Plans — Pass 3 Completeness Audit

> **Date:** 2026-03-13
> **Scope:** Re-audit of 6 revised plans after Pass 2 identified 43 findings (4 CRITICAL, 14 HIGH, 16 MEDIUM, 5 LOW)
> **Previous audit:** `docs/plans/2026-03-13-auth-profile-audit-2-completeness.md`
> **Auditor:** Automated completeness review (Pass 3)

---

## Plans Reviewed

1. GAP-3.1: Preflight Consent Modal (revised)
2. GAP-3.2: Partial Consent Handling (revised)
3. GAP-3.3: Consent Persistence (revised)
4. GAP-3.4: Batch Consent UI (revised)
5. Infrastructure Gaps (revised)
6. Deferred Types & Addons (revised)

---

## Section 1: Resolution of CRITICAL Findings

### G-1 (CRITICAL): Conflicting Data Models Between GAP-3.1 and GAP-3.2 — RESOLVED

**Pass 2 finding:** GAP-3.1 defined `authGate` on `SessionData`; GAP-3.2 defined a separate `_consentState` on `RuntimeSession`. Two incompatible models for the same concern.

**Resolution:** Both plans now reference a single canonical `AuthGate` type defined in GAP-3.1 Section 3.1 (`packages/shared/src/types/auth-consent.ts`). GAP-3.2 Section 3.1 explicitly states: "This plan uses the canonical consent state model defined in GAP-3.1 Section 3.1." All consent state fields (`authGate`, `blocked`, `pendingInlineConsent`) live on `SessionData` in `apps/runtime/src/services/session/types.ts`.

**Verdict:** Fully resolved. No remaining ambiguity.

### G-3 (CRITICAL): Identity Mismatch (userId vs contactId) — RESOLVED

**Pass 2 finding:** GAP-3.1 used `userId` as the identity key for token lookup. GAP-3.3 used `contactId` with a 3-tier identity resolution chain. Fundamentally different identity models.

**Resolution:** GAP-3.1 Section 3.3 now explicitly documents the 3-tier identity model and states: "The `checkPreflightAuth` function takes `callerContext: CallerContext` as input (not raw `userId`), and resolves `contactId` through GAP-3.3's identity resolution chain." GAP-3.1 Section 4.2 shows `callerContext: CallerContext` as the parameter type.

**Verdict:** Fully resolved.

### G-32 (CRITICAL): Security Review Finding-003 (Validate Endpoint Visibility) — PARTIALLY RESOLVED

**Pass 2 finding:** `POST /:id/validate` does not enforce personal profile visibility. None of the 6 plans addressed this.

**Resolution:** The Infrastructure Gaps plan now includes this in Section "Security Findings Not Yet Addressed" (item 1), acknowledging it as a known gap with the exact fix specified: `$or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }]`. However, it is listed as "future work," not as an implementation task with a sprint assignment.

**Verdict:** Acknowledged but not scheduled. Downgraded from CRITICAL to HIGH since the fix is simple and the current behavior requires guessing an ObjectId to exploit. See new finding P3-1.

### G-33 (HIGH, previously grouped with CRITICAL): Proxy Chain Shared-to-Personal — PARTIALLY RESOLVED

**Pass 2 finding:** `proxyAuthProfileId` allows a shared profile to reference a personal profile.

**Resolution:** Listed in Infrastructure Gaps "Security Findings Not Yet Addressed" (item 2) with the exact validation rule. Not scheduled.

**Verdict:** Acknowledged but not scheduled. See P3-1.

---

## Section 2: Resolution of HIGH Findings

### G-2 (HIGH): Different Token Lookup Strategies — RESOLVED

GAP-3.1 Section 4.2 now defers token lookup to GAP-3.3's `ConsentStateResolver` with explicit cross-reference. GAP-3.3 provides the dual-read strategy.

### G-4 (HIGH): GAP-3.2 Compiler Changes Not Acknowledged as Prerequisite — RESOLVED

GAP-3.1 Dependencies section (top of document) now explicitly states: "GAP-3.2 Phase 1 (Compiler IR) -- MUST be completed first." with detailed rationale.

### G-8 (HIGH): No Rate Limiting on OAuth User-Consent Endpoint — RESOLVED

GAP-3.1 Section 9.1 now specifies: "10 requests per minute per session, 50 per minute per IP." Section 9.2 adds rate limits to the satisfaction endpoint (5/min/session) and preflight-link endpoint (3/min/session). Section 9.3 adds limits to the status polling endpoint (20/min/token).

### G-11 (HIGH): Popup postMessage Origin Validation — RESOLVED

GAP-3.1 Section 10.3 now specifies: "The `AuthPreflightGate` component MUST validate `event.origin`" and "The `postMessage` call in the popup MUST specify the target origin -- never use `'*'`." Also referenced in Section 5.1.

### G-14 (HIGH): Inline Consent and LLM Conversation History — RESOLVED

GAP-3.2 Section 3.4 replaced the "suspension" model with a "tool error result pattern." The tool returns a structured `CONSENT_REQUIRED` error to the LLM, which naturally responds to the user. The next user message triggers a new LLM turn where the tool succeeds. This eliminates the conversation history splicing problem.

### G-17 (HIGH): EndUserOAuthToken Schema Migration Rollback — RESOLVED

GAP-3.3 Section 15 now specifies a two-step migration: (1) Add new index non-unique alongside old index, backfill `projectId`. (2) Drop old unique index, make new index unique. "If step 2 fails, the old index still exists as fallback."

### G-19 (HIGH): Background Refresh Worker No Tenant Isolation — RESOLVED

GAP-3.3 Section 5.1 now specifies: "The worker must iterate over all tenants and run per-tenant queries." The pseudocode shows querying distinct tenantIds first, then per-tenant queries with explicit `tenantId` filter.

### G-29 (HIGH): SAML Cache Key Inconsistency — RESOLVED

Deferred Types plan Section 13 now documents a consistent key pattern: `auth-profile:{type}:{tenantId}:{profileId}` with explicit note that Kerberos adds `:{servicePrincipal}` as an extra component. Security note: "Since `tenantId` and `profileId` are both UUIDs, cache key collisions are prevented by design."

### G-34 (HIGH): providerUserId PII Leak Migration — PARTIALLY RESOLVED

Listed in Infrastructure Gaps "Security Findings Not Yet Addressed" (item 3) with the exact migration query. Not scheduled. See P3-1.

### G-36 (HIGH): SSRF on URL Fields / Zod .strict() — PARTIALLY RESOLVED

GAP-3.1 Section 10.4 now mentions SSRF validation for URL fields. GAP-3.2 Section 11 item 7 mentions SSRF guards and `.strict()`. However, neither plan includes an actual implementation task for adding `.strict()` to existing Zod schemas or implementing an SSRF validator. Listed in Infrastructure Gaps "Security Findings Not Yet Addressed" (item 5). See P3-1.

### G-37 (HIGH): TriggerRegistration.webhookSecret — ACKNOWLEDGED, NOT SCHEDULED

Listed in Infrastructure Gaps future work (item 6). Not scheduled.

### G-38 (HIGH): GuardrailPolicy.apiKeyCredentialId — ACKNOWLEDGED, NOT SCHEDULED

Listed in Infrastructure Gaps future work (item 7). Not scheduled.

### G-39 (HIGH): ModelConfig.credentialId — ACKNOWLEDGED, NOT SCHEDULED

Listed in Infrastructure Gaps future work (item 8). Not scheduled.

### G-42 (HIGH): Unique Constraint Name Collision — NOT ADDRESSED

**This HIGH finding was not addressed in any plan revision.** The Infrastructure Gaps plan does not mention name deduplication during migration. The `{ tenantId, projectId, name }` unique constraint will fail if auto-generated names collide during data migration.

**Verdict:** Still missing. See new finding P3-2.

---

## Section 3: Cross-Plan Dependencies

All 6 plans now include a "Dependencies" section at the top documenting:

- What this plan depends on (with plan names and specific phases)
- What depends on this plan
- Implementation sequence position (Sprint N through N+3)

### Dependency Graph Summary (from revised plans)

```
Sprint N:   GAP-3.2 Phase 1 (Compiler IR)
Sprint N+1: GAP-3.1 Core Runtime + GAP-3.2 Phase 2
Sprint N+2: GAP-3.1 Web UI + GAP-3.4 (Batch Consent UI)
Sprint N+3: GAP-3.3 (Persistence) + GAP-3.1 Channels + GAP-3.2 Phase 3 (Inline)

Parallel:   Infrastructure Gaps (independent of consent plans)
After 30d:  Deferred Types & Addons (Phase 3)
```

**Verdict:** Cross-plan dependencies are now clearly documented and the sprint sequencing is coherent. The Infrastructure Gaps plan correctly identifies its independence from consent plans but documents its downstream impact on GAP-3.1 (rotation grace period) and GAP-3.3 (background refresh decryption errors).

---

## Section 4: New Gaps Introduced by Revisions

### P3-1 (MEDIUM): Infrastructure Gaps Plan Lists 10 Security Items as "Future Work" Without Sprint Assignment

The Infrastructure Gaps plan revision added a new section "Security Findings Not Yet Addressed" listing 10 items from the security and false negatives reviews. While acknowledging these items is an improvement over Pass 2, none are assigned to a sprint, priority, or owner. Six of these are HIGH severity (G-32 through G-39) from the original audit.

**Risk:** These items will be forgotten once the main implementation begins. The "future work" framing suggests they are optional, but several are security fixes that should be mandatory before the Phase 3 cleanup that deletes `LLMCredential`.

**Recommendation:** Group the 10 items into two tranches:

- **Must-fix before Phase 3 cleanup** (items 6-8: consumer migrations for `TriggerRegistration`, `GuardrailPolicy`, `ModelConfig` -- without these, Phase 3 deletion of `LLMCredential` breaks these consumers): Add as Sprint 2 or Sprint 3 tasks in the Infrastructure Gaps plan.
- **Security hardening** (items 1-5, 9-10: validate endpoint visibility, proxy chain enforcement, SSRF, NormalizedAuthProfile type safety, alerting, health check): Schedule for the sprint after Gap 7 cleanup.

### P3-2 (HIGH): Unique Constraint Name Collision Still Missing

Pass 2 finding G-42 identified that the `{ tenantId, projectId, name }` unique index on `AuthProfile` will fail during data migration if auto-generated names collide (e.g., two `LLMCredential` records named "Production OpenAI" in the same project). None of the 6 revised plans address this.

**Where It Should Be:** Infrastructure Gaps plan, Gap 2 or a new Gap 8 for migration data quality.

**Recommendation:** The migration script must: (1) Generate names from the source model (`LLMCredential.name`, `ToolSecret.key`, `ConnectorConnection.name`). (2) On name collision within the same `(tenantId, projectId)`, append a deduplication suffix: "Production OpenAI (2)". (3) Create the unique index AFTER migration completes with deduplication, not before.

### P3-3 (LOW): GAP-3.2 Tool Error Result Pattern Has No LLM System Prompt Guidance

GAP-3.2 Section 3.4 introduces the tool error result pattern where `CONSENT_REQUIRED` is returned to the LLM. The LLM must "naturally" ask the user to authorize. However, there is no specification for:

1. Whether the system prompt should include instructions about consent-required errors
2. How the LLM knows to say "click the authorization button above" when the WS event has already sent the `authorizationUrl` to the client

**Risk:** Without system prompt guidance, the LLM may retry the tool, apologize generically, or fail to reference the authorization UI element.

**Recommendation:** Add a brief section specifying that the runtime should inject a system message like: "When a tool returns CONSENT_REQUIRED, inform the user that they need to authorize the service and that an authorization button has appeared in the chat interface. Do not retry the tool until the user confirms they have authorized."

### P3-4 (LOW): GAP-3.3 OAuth State Parameter Inconsistency Between Section 10.4 and Task 9

GAP-3.3 Section 10.4 specifies the OAuth state parameter must be **encrypted** with AES-256-GCM. However, Task 9 in Section 11 Phase B says: "Implement HMAC-signed state parameter with nonce." These contradict each other.

**Recommendation:** Update Task 9 description to: "Implement encrypted (AES-256-GCM) state parameter with nonce" to match Section 10.4.

### P3-5 (MEDIUM): GAP-3.1 Redis Pub/Sub for Cross-Pod Auth Gate Is New Infrastructure Without Failure Mode

GAP-3.1 Section 6.2 introduces Redis pub/sub for cross-pod auth gate updates. The plan notes this is "new infrastructure" but does not specify:

1. What happens if the Redis pub/sub connection drops mid-session
2. Whether a fallback polling mechanism exists for the subscribing pod
3. How the WebSocket handler resubscribes after a Redis reconnection

**Risk:** If Redis pub/sub fails, users who complete OAuth on a different pod than their WebSocket will never see the auth gate update. The session appears stuck.

**Recommendation:** Add a fallback: the satisfaction endpoint should also attempt a direct WebSocket send via the session's `socketId` (stored in Redis session data). If that fails (wrong pod), the pub/sub is the secondary mechanism. Additionally, the standalone preflight page and batch consent UI should poll the status endpoint as a belt-and-suspenders approach, which GAP-3.4 already partially addresses.

### P3-6 (MEDIUM): GAP-3.4 References Non-Existent Session Store Field

GAP-3.4 Section 12.2 states: "The `BatchConsentGate` component reads the `auth_required` message from `useSessionStore`." However, no plan specifies adding an `auth_required` message type handler to the session store (`apps/studio/src/store/session-store.ts`). GAP-3.4 Task 3.2 lists "Handle `auth_required` message type in session store" but does not specify the shape of the data or how it maps to the `BatchConsentState`.

**Risk:** Low -- this is a straightforward implementation detail. But it creates a gap between the runtime's WebSocket payload and the UI store.

**Recommendation:** GAP-3.4 should include a brief data mapping section showing how `auth_required` WS payload maps to `BatchConsentState.connectors[]`.

### P3-7 (MEDIUM): No Plan Specifies the `oauth2_app` Profile Requirement Resolution at Deploy Time

GAP-3.2 Section 5.2 and GAP-3.1 Section 12 both reference deploy-time validation that checks for matching `oauth2_app` Auth Profiles. However, no plan specifies the resolution algorithm:

1. How does the deployment validator match a connector name (e.g., "gmail") to an `oauth2_app` Auth Profile?
2. Is the match by `connector` field on the Auth Profile? By `name`? By `tags`?
3. What if multiple `oauth2_app` profiles match the same connector?

**Risk:** Without a clear resolution algorithm, the compiler may link to the wrong OAuth app, or the deployment validator may produce false positive errors.

**Recommendation:** Add a brief section to GAP-3.2 or GAP-3.1 specifying: "The `AuthRequirementCollector` resolves `auth_profile_id` by matching `AuthProfile.find({ tenantId, projectId, authType: 'oauth2_app', connector: requirement.connector, status: 'active' })`. If multiple matches, prefer project-scoped over tenant-scoped. If still ambiguous, use the most recently created. If none found, emit a deployment validation error."

---

## Section 5: Verification Against Original Requirements

### Master Design (docs/plans/2026-03-11-auth-profile-design.md)

| Design Section                                  | Coverage in Plans                      | Status                                 |
| ----------------------------------------------- | -------------------------------------- | -------------------------------------- |
| Section 6: Pre-flight Auth Propagation          | GAP-3.1 + GAP-3.2                      | Covered                                |
| Section 7.4: Runtime Consent                    | GAP-3.1 + GAP-3.2 + GAP-3.3            | Covered                                |
| Section 5: Resolution priority for oauth2_token | GAP-3.3 Section 1.3 (dual-read)        | Covered                                |
| Section 8: OAuth endpoints                      | GAP-3.1 Section 9                      | Covered                                |
| Section 10: Trace events                        | GAP-3.1 Section 11, GAP-3.2 Section 10 | Covered                                |
| Section 18: Migration strategy                  | GAP-3.3 Section 15, Infra Gaps         | Partially covered (G-42 still missing) |
| Section 19: Deferred types                      | Deferred Types plan                    | Covered                                |

### UX Review (docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md)

| UX Gap                                              | Coverage  | Status  |
| --------------------------------------------------- | --------- | ------- |
| GAP-3.1: Preflight consent modal                    | Full plan | Covered |
| GAP-3.2: Partial consent (preflight vs inline)      | Full plan | Covered |
| GAP-3.3: Consent persistence across browser refresh | Full plan | Covered |
| GAP-3.4: Multi-tool batch consent UI                | Full plan | Covered |

---

## Section 6: Sprint Sequencing Coherence Check

### Verified Dependencies

| Sprint     | Plans                                        | Prerequisites Met?                                                                                                 |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sprint N   | GAP-3.2 Phase 1 (Compiler IR)                | Yes -- no prerequisites, pure compiler work                                                                        |
| Sprint N+1 | GAP-3.1 Core Runtime + GAP-3.2 Phase 2       | Yes -- GAP-3.2 Phase 1 provides `AuthRequirementIR` and `CompilationOutput.preflight_auth_requirements`            |
| Sprint N+2 | GAP-3.1 Web UI + GAP-3.4                     | Yes -- GAP-3.1 runtime provides `auth_required` WS event and session state; GAP-3.2 Phase 2 provides consent types |
| Sprint N+3 | GAP-3.3 + GAP-3.1 Channels + GAP-3.2 Phase 3 | Yes -- all runtime infrastructure in place from N+1                                                                |
| Parallel   | Infrastructure Gaps                          | Yes -- independent of consent plans                                                                                |
| After 30d  | Deferred Types                               | Yes -- Phase 2 stability required                                                                                  |

### Potential Sequencing Issue

GAP-3.4 (Sprint N+2) depends on the `AuthGate` type from GAP-3.1 Section 3.1, which is defined in `packages/shared/src/types/auth-consent.ts`. This file is created in Sprint N+1 (GAP-3.1 task 1). This dependency is correctly sequenced.

However, GAP-3.4 also references `auth_gate_updated` and `auth_gate_satisfied` WS events, which are defined in Sprint N+1. The UI plan needs these events to update connector row status in real-time. This is also correctly sequenced.

**Verdict:** Sprint sequencing is coherent. No circular dependencies detected.

---

## Summary

### Pass 2 CRITICAL Findings Resolution

| Finding                                      | Status       | Notes                                |
| -------------------------------------------- | ------------ | ------------------------------------ |
| G-1: Conflicting data models                 | RESOLVED     | Single `AuthGate` on `SessionData`   |
| G-3: Identity mismatch (userId vs contactId) | RESOLVED     | `CallerContext` with 3-tier identity |
| G-32: Validate endpoint visibility           | ACKNOWLEDGED | Listed as future work, not scheduled |
| G-33: Proxy chain shared-to-personal         | ACKNOWLEDGED | Listed as future work, not scheduled |

### Pass 2 HIGH Findings Resolution

| Finding                                     | Status                                     |
| ------------------------------------------- | ------------------------------------------ |
| G-2: Token lookup strategy conflict         | RESOLVED                                   |
| G-4: Compiler prerequisite not acknowledged | RESOLVED                                   |
| G-8: No rate limiting                       | RESOLVED                                   |
| G-11: postMessage origin validation         | RESOLVED                                   |
| G-14: Inline consent + LLM history          | RESOLVED                                   |
| G-17: Migration rollback strategy           | RESOLVED                                   |
| G-19: Worker tenant isolation               | RESOLVED                                   |
| G-29: Redis cache key inconsistency         | RESOLVED                                   |
| G-34: providerUserId PII migration          | ACKNOWLEDGED, not scheduled                |
| G-36: SSRF / Zod .strict()                  | PARTIALLY RESOLVED (mentioned but no task) |
| G-37: TriggerRegistration.webhookSecret     | ACKNOWLEDGED, not scheduled                |
| G-38: GuardrailPolicy consumer mapping      | ACKNOWLEDGED, not scheduled                |
| G-39: ModelConfig consumer mapping          | ACKNOWLEDGED, not scheduled                |
| G-42: Unique constraint name collision      | NOT ADDRESSED                              |

### New Findings From Pass 3

| ID   | Severity | Finding                                                                    |
| ---- | -------- | -------------------------------------------------------------------------- |
| P3-1 | MEDIUM   | 10 security items listed as "future work" without sprint assignment        |
| P3-2 | HIGH     | Unique constraint name collision still unaddressed (G-42 carry-forward)    |
| P3-3 | LOW      | Tool error result pattern lacks LLM system prompt guidance                 |
| P3-4 | LOW      | OAuth state parameter description inconsistency (encrypted vs HMAC-signed) |
| P3-5 | MEDIUM   | Redis pub/sub for cross-pod auth gate has no failure mode specified        |
| P3-6 | MEDIUM   | BatchConsentGate references unspecified session store integration          |
| P3-7 | MEDIUM   | No plan specifies oauth2_app profile resolution algorithm at deploy time   |

### Overall Verdict

| Category                           | Count                                             |
| ---------------------------------- | ------------------------------------------------- |
| Pass 2 CRITICAL findings resolved  | 2 of 4 fully resolved, 2 acknowledged             |
| Pass 2 HIGH findings resolved      | 9 of 14 resolved, 4 acknowledged, 1 still missing |
| Cross-plan dependencies documented | Yes -- all 6 plans have dependency sections       |
| Sprint sequencing coherent         | Yes -- verified, no circular dependencies         |
| New gaps from revisions            | 7 (1 HIGH, 3 MEDIUM, 2 LOW, 1 HIGH carry-forward) |

**The Pass 2 revisions resolved the most critical structural issues (conflicting data models, identity mismatch, prerequisite documentation).** The remaining gaps fall into two categories:

1. **Security hardening items acknowledged but not scheduled** (P3-1): These must be scheduled before Phase 3 cleanup to avoid breaking consumer systems.
2. **Minor specification gaps** (P3-2 through P3-7): These are implementation details that a competent engineer can resolve during development, but they should be addressed in the plans to avoid ambiguity.

### Top 3 Actions Required

1. **Schedule the 3 consumer migration items** (G-37, G-38, G-39) into the Infrastructure Gaps plan as Sprint 2 or 3 tasks. Without these, Phase 3 deletion of `LLMCredential` will break `TriggerRegistration`, `GuardrailPolicy`, and `ModelConfig`.
2. **Add name deduplication to the migration script** (P3-2/G-42). This is a data integrity issue that will cause migration failures.
3. **Specify the oauth2_app profile resolution algorithm** (P3-7). Multiple plans reference deploy-time validation but none define how connector-to-profile matching works.
