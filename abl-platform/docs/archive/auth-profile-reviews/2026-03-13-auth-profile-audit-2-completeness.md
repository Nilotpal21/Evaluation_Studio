# Auth Profile Implementation Plans — Completeness Audit

> **Date:** 2026-03-13
> **Scope:** 6 implementation plans reviewed against the master design and 4 review documents
> **Auditor:** Automated completeness review

---

## Plans Reviewed

1. GAP-3.1: Preflight Consent Modal
2. GAP-3.2: Partial Consent Handling (Preflight vs Inline)
3. GAP-3.3: Consent Persistence
4. GAP-3.4: Batch Consent UI
5. Infrastructure Gaps
6. Deferred Types & Addons

## Source Documents

- Master design: `docs/plans/2026-03-11-auth-profile-design.md`
- UX review: `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md`
- Security review: `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-security.md`
- False negatives review: `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-false-negatives.md`
- CI/CD review: `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-cicd.md`

---

## Cross-Plan Dependencies

### Finding G-1: GAP-3.1 and GAP-3.2 Define Overlapping But Inconsistent Consent State Models

- **Severity**: CRITICAL
- **What's Missing**: GAP-3.1 defines `authGate` on `SessionData` with fields `status`, `requirements`, `satisfiedConnectors`, `deniedConnectors`, `createdAt`, `expiresAt`, `pendingOAuthStates`. GAP-3.2 defines `_consentState` on `RuntimeSession` with `satisfied`, `pendingPreflight`, `pendingInline`, plus `_blocked` and `_pendingInlineConsent`. These are two separate consent state models for the same concern. Neither plan acknowledges the other's data model or specifies which is canonical.
- **Where It Should Be**: Both plans need a shared "Data Model" section, or one plan must defer to the other.
- **Recommendation**: Unify into a single consent state model. GAP-3.2 is more comprehensive (covers inline consent), so GAP-3.1's `authGate` should be folded into GAP-3.2's `ConsentState`. The `authGate` becomes the preflight subset of `ConsentState`. Add explicit cross-references in both plans.

### Finding G-2: GAP-3.1 and GAP-3.3 Define Different Token Lookup Strategies

- **Severity**: HIGH
- **What's Missing**: GAP-3.1 Section 4.2 checks preflight satisfaction via `AuthProfile.findOne({ tenantId, connector, authType: 'oauth2_token', visibility: 'personal', createdBy: userId, status: 'active' })`. GAP-3.3 Section 2.2 checks via `EndUserOAuthToken` with `{ tenantId, contactId, provider, projectId, revokedAt: null }` and defines a dual-read strategy (query AuthProfile first, fall back to EndUserOAuthToken). Neither plan references the other's lookup strategy.
- **Where It Should Be**: GAP-3.1 Section 4.2 should reference GAP-3.3's dual-read strategy. GAP-3.3 should be the canonical token lookup specification.
- **Recommendation**: GAP-3.1 should defer token lookup implementation details to GAP-3.3's `ConsentStateResolver` and simply call it. Remove the inline lookup logic from GAP-3.1 Section 4.2.

### Finding G-3: GAP-3.1 and GAP-3.3 Use Different Identity Keys for Token Ownership

- **Severity**: CRITICAL
- **What's Missing**: GAP-3.1 uses `userId` as the identity key for token lookup (Section 4.2: `createdBy: userId`). GAP-3.3 uses `contactId` with a 3-tier identity resolution chain (Section 3). These are fundamentally different identity models. GAP-3.1 does not address anonymous users or channel-artifact-based identity. GAP-3.3 explicitly handles this. Neither plan acknowledges the conflict.
- **Where It Should Be**: GAP-3.1 Section 4.2 must use GAP-3.3's contact identity resolution, not raw `userId`.
- **Recommendation**: GAP-3.1 must be updated to use `contactId` as the identity key, resolved through GAP-3.3's identity tier system. The `checkPreflightAuth` function needs `callerContext` as input, not `userId`.

### Finding G-4: GAP-3.2's Compiler Changes Are Prerequisites for GAP-3.1 But Not Acknowledged

- **Severity**: HIGH
- **What's Missing**: GAP-3.1 assumes `authRequirements` already exist in the compiled `AgentIR` (Section 4.2: "Extract authRequirements from the compiled AgentIR"). GAP-3.2 Section 2 defines the compiler IR changes that create these `authRequirements` (adding `connection_mode`, `consent_mode` to ToolDefinition, creating `AuthRequirementIR`, and the `AuthRequirementCollector` post-compilation pass). GAP-3.1 does not list GAP-3.2's compiler work as a prerequisite.
- **Where It Should Be**: GAP-3.1 Prerequisites section.
- **Recommendation**: Add explicit prerequisite: "Requires GAP-3.2 Phase 1 (Compiler IR and Propagation) to be complete before runtime preflight detection can work."

### Finding G-5: GAP-3.4 Batch Consent UI Has No Runtime API for Preflight Status Polling

- **Severity**: MEDIUM
- **What's Missing**: GAP-3.4 Section 1.1 references `GET /api/projects/:pid/auth-profiles/preflight-status?sessionId=X` for status polling, but this endpoint is not defined in GAP-3.1 (which defines the runtime APIs). GAP-3.1 defines `GET /api/auth/preflight/:token/status` for the standalone preflight page, but not a session-based status endpoint for the web UI.
- **Where It Should Be**: GAP-3.1 Section 9 (API Endpoints).
- **Recommendation**: Either GAP-3.4 should use the WebSocket `auth_gate_updated` events from GAP-3.1 (no polling needed), or GAP-3.1 must add the REST endpoint GAP-3.4 references. Prefer WebSocket events.

### Finding G-6: WebSocket Event Names Are Inconsistent Across GAP-3.1 and GAP-3.2

- **Severity**: MEDIUM
- **What's Missing**: GAP-3.1 defines server events: `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `auth_gate_timeout`. GAP-3.2 defines server events: `consent_state_changed`, `session_unblocked`, `inline_consent_required`, `inline_consent_satisfied`. These are overlapping event sets with different naming conventions. An implementor would not know which to use.
- **Where It Should Be**: A shared event type definition, referenced by both plans.
- **Recommendation**: Consolidate into a single event schema. Use GAP-3.2's more granular events. GAP-3.1's `auth_gate_*` events become the preflight subset. Define all events in one place (e.g., `packages/shared/src/types/auth-gate.ts` as GAP-3.1 proposes).

### Finding G-7: Infrastructure Gaps Plan Has No Dependencies on Consent Plans

- **Severity**: LOW
- **What's Missing**: The Infrastructure Gaps plan (Gaps 1-7) is correctly independent of the consent plans. However, Gap 1 (Rotation Fields) affects how `oauth2_token` profiles are refreshed, which intersects with GAP-3.3's background refresh worker. If the rotation grace period logic changes how token decryption works, GAP-3.3's on-demand refresh at runtime (Section 5.3) must handle `AUTH_PROFILE_DECRYPTION_FAILED` as a distinct error from `invalid_grant`.
- **Where It Should Be**: GAP-3.3 Section 5.3 (On-Demand Refresh at Runtime) should handle decryption errors.
- **Recommendation**: Add a decryption error path to GAP-3.3's on-demand refresh: if decryption fails, set `tokenStatus: 'invalid'` (not 'expired') and require re-authorization.

---

## GAP-3.1: Preflight Consent Modal

### Finding G-8: No Rate Limiting on OAuth User-Consent Endpoint

- **Severity**: HIGH
- **What's Missing**: The `POST /api/projects/:pid/auth-profiles/oauth/user-consent` endpoint generates OAuth authorization URLs and state tokens. There is no rate limiting specified. An attacker could abuse this to generate thousands of state tokens, exhausting Redis storage (nonce tracking) and potentially triggering OAuth provider rate limits.
- **Where It Should Be**: Section 10 (Security Considerations) or Section 9 (API Endpoints).
- **Recommendation**: Add rate limiting: 10 requests per minute per session, 50 per minute per IP. Rate limit the `preflight-link` endpoint similarly.

### Finding G-9: Email Channel Not Addressed

- **Severity**: MEDIUM
- **What's Missing**: GAP-3.1 Section 5 covers Web, Voice, WhatsApp, SMS, Telegram, API/SDK, and A2A channels. The Email channel is not mentioned. Email-based agent interactions (inbound email triggers a session) could encounter preflight requirements.
- **Where It Should Be**: Section 5 (Channel-Specific Preflight UX), as a new subsection.
- **Recommendation**: Add email channel handling. Strategy: send an email reply with the preflight authorization link (similar to SMS/WhatsApp text channel approach). The email should contain a branded HTML template with authorization buttons.

### Finding G-10: Standalone Preflight Page JWT Contains sessionId But Sessions Have TTL

- **Severity**: MEDIUM
- **What's Missing**: The standalone preflight page token (Section 5.2) contains `sessionId` in its JWT. Voice channel sessions may be short-lived. If the user takes several minutes to complete authorization on the web page, the voice session's Redis TTL could expire before they finish. The plan does not specify how to handle a stale `sessionId` in the preflight token.
- **Where It Should Be**: Section 7 (Error Handling).
- **Recommendation**: The preflight page should check session existence on load and on each OAuth completion. If the session has expired, show a message: "Your session has expired. Please call back to start a new session."

### Finding G-11: Popup postMessage Origin Validation Not Specified

- **Severity**: HIGH
- **What's Missing**: Section 5.1 specifies the OAuth popup posts `{ type: 'AUTH_PROFILE_CONSENT_COMPLETE', ... }` via `window.opener.postMessage`. The plan does not specify origin validation on the receiving end. Without origin checking, any page that opens a popup to the same OAuth provider callback URL could inject fake consent-complete messages.
- **Where It Should Be**: Section 10 (Security Considerations).
- **Recommendation**: The `AuthPreflightGate` component must validate `event.origin` against the expected platform origin. The `postMessage` call must include a target origin (not `'*'`).

### Finding G-12: No Graceful Degradation for Browsers That Block Third-Party Cookies

- **Severity**: MEDIUM
- **What's Missing**: OAuth popups rely on cookies for the OAuth provider's authentication flow. Modern browsers (Safari, Firefox with ETP) block third-party cookies by default. If the OAuth provider's consent page cannot maintain a session due to cookie blocking, the popup flow fails silently.
- **Where It Should Be**: Section 5.1 (Web Chat Widget) or Section 7 (Error Handling).
- **Recommendation**: Add a fallback: if popup-based OAuth fails, offer a redirect-based flow where the entire page navigates to the OAuth provider and returns via redirect URI. GAP-3.4 Section 8.2 mentions this for mobile but GAP-3.1 does not.

---

## GAP-3.2: Partial Consent Handling

### Finding G-13: Inline Consent Tool Suspension Has No Maximum Concurrent Limit

- **Severity**: MEDIUM
- **What's Missing**: Section 3.4 describes suspending tool execution for inline consent. If a fan-out supervisor invokes 5 tools on 5 different connectors all requiring inline consent simultaneously, 5 concurrent suspensions would exist. The plan does not specify a maximum concurrent inline consent limit or how the UI handles multiple simultaneous consent requests.
- **Where It Should Be**: Section 7 (Edge Cases) or Section 3.4.
- **Recommendation**: Add a maximum concurrent inline consent limit (e.g., 1 at a time). Queue additional consent requests. The UI should show one consent prompt at a time, processing sequentially.

### Finding G-14: No Specification for How Inline Consent Interacts with LLM Conversation History

- **Severity**: HIGH
- **What's Missing**: When a tool is suspended for inline consent (Section 3.4), the LLM has already issued a tool call. After the user authorizes and the tool is retried, the tool result needs to be injected into the conversation at the correct position. The plan does not specify how the suspended tool call and its eventual result integrate with the LLM's conversation history and streaming response.
- **Where It Should Be**: Section 3.4 or a new Section 3.6.
- **Recommendation**: Specify that when inline consent is required: (1) the tool call is recorded in history with a `pending_consent` status, (2) the LLM receives a tool result of `{ error: "consent_required", connector: "..." }` so it can inform the user, (3) after consent is granted, a new LLM turn is initiated that re-executes the tool call.

### Finding G-15: `ConsentRequiredError` Not Defined as a Recoverable Error

- **Severity**: MEDIUM
- **What's Missing**: Section 3.5 mentions adding `ConsentRequiredError` to the tool execution path but does not define it as a specific error class or specify how the runtime error handling pipeline treats it differently from other tool errors. Standard tool errors are logged, surfaced to the LLM, and may trigger retries. `ConsentRequiredError` should NOT trigger retries and should NOT be treated as a failure by the LLM.
- **Where It Should Be**: Section 3.4 or 3.5.
- **Recommendation**: Define `ConsentRequiredError` as a distinct error class that: (1) bypasses retry logic, (2) does not count against tool failure thresholds, (3) results in a user-facing consent prompt rather than an error message.

### Finding G-16: Feature Flag for Consent Not Coordinated with Infrastructure Gaps Feature Flags

- **Severity**: LOW
- **What's Missing**: Section 9.3 defines `AUTH_PROFILE_CONSENT_ENABLED` as a feature flag. The Deferred Types plan (Section 6) defines 7 separate feature flags for enterprise auth types and addons. There is no specification for how these flags interact. If `AUTH_PROFILE_CONSENT_ENABLED=true` but an enterprise auth type is used with `per_user` consent, does the consent flow work for enterprise types?
- **Where It Should Be**: GAP-3.2 Section 9.3 or Deferred Types Section 6.
- **Recommendation**: Document that consent flows work with all auth types (core and enterprise) as long as `AUTH_PROFILE_CONSENT_ENABLED=true`. Enterprise type flags only control profile creation, not consent mechanics.

---

## GAP-3.3: Consent Persistence

### Finding G-17: `EndUserOAuthToken` Schema Migration Has No Rollback Strategy

- **Severity**: HIGH
- **What's Missing**: Section 1.2 adds 7 new fields to `EndUserOAuthToken` and replaces the unique index from `{ tenantId, userId, provider }` to `{ tenantId, projectId, userId, provider }`. This is described as a "breaking index change requiring a migration step." There is no rollback strategy specified. If the migration fails mid-way, some documents may have the new fields and some may not. The old unique index would be dropped but the new one might not be created.
- **Where It Should Be**: Section 11 (Implementation Tasks), Phase A, or a new Migration Rollback section.
- **Recommendation**: Specify a two-step migration: (1) Add new index (non-unique first) alongside old index, backfill `projectId` on existing documents. (2) Drop old unique index, make new index unique. If step 2 fails, the old index still exists as fallback.

### Finding G-18: Contact Merge Handler Has Race Condition

- **Severity**: MEDIUM
- **What's Missing**: Section 3.3 describes contact merge handling: "If conflict (both contacts had Gmail tokens): keep the newer token (by consentedAt), revoke the older one." If two merge operations run concurrently (e.g., merging contacts A+B and A+C simultaneously), there is no distributed lock to prevent both operations from modifying contact A's tokens at the same time.
- **Where It Should Be**: Section 3.3 (Contact Merge Handling).
- **Recommendation**: Acquire a distributed lock on `contactId` before processing merge. Use Redis `SET NX PX` with a 30-second TTL. If lock acquisition fails, retry with exponential backoff.

### Finding G-19: Background Refresh Worker Has No Tenant Isolation in Query

- **Severity**: HIGH
- **What's Missing**: Section 5.1 defines the background refresh worker query as `EndUserOAuthToken.find({ tokenStatus: 'active', revokedAt: null, expiresAt: { $lt: ... } })`. This query does NOT include `tenantId`. In a multi-tenant system, this means the worker processes tokens across all tenants in a single batch. If tenant A has 10,000 tokens and tenant B has 10, tenant B's tokens may be delayed. More critically, the `tenantIsolationPlugin` is applied to the model, so this query may actually fail or only return the worker's own tenant context.
- **Where It Should Be**: Section 5.1.
- **Recommendation**: The background worker must either: (1) iterate over all tenants and run per-tenant queries (respecting tenant isolation plugin context), or (2) use a direct MongoDB query that bypasses the plugin (with explicit justification and audit). Document which approach is used.

### Finding G-20: No Monitoring for Token Refresh Worker Health

- **Severity**: MEDIUM
- **What's Missing**: The background refresh worker (Section 5.1) runs every 5 minutes as a BullMQ recurring job. If the worker fails silently (e.g., Redis connection lost, worker crashes), no tokens get refreshed proactively, and users will encounter expired tokens at session start. There is no health check or alerting for this worker.
- **Where It Should Be**: Section 11, Phase E (Audit, Metrics) or a new Monitoring section.
- **Recommendation**: Add metrics: `auth_token_refresh_worker_runs_total` (counter), `auth_token_refresh_worker_last_success_timestamp` (gauge). Alert if `last_success_timestamp` is older than 15 minutes.

---

## GAP-3.4: Batch Consent UI

### Finding G-21: No Specification for Server-Side Rendering of Consent UI

- **Severity**: LOW
- **What's Missing**: The batch consent UI is a React component rendered client-side. For the standalone preflight page (used by voice/WhatsApp channels, defined in GAP-3.1), there is no specification for whether the consent UI should be server-side rendered for better initial load performance and SEO (not relevant) or accessibility for low-bandwidth connections.
- **Where It Should Be**: GAP-3.4 Section 11 or GAP-3.1 Section 5.2.
- **Recommendation**: The standalone preflight page should use Next.js server components for the initial connector list (data fetched server-side from the JWT token), with client-side hydration for the interactive OAuth flows. This ensures the page loads fast on slow mobile connections (voice channel users on cellular).

### Finding G-22: Widget Bundle Size Impact Not Quantified

- **Severity**: LOW
- **What's Missing**: Section 11 notes that the widget should use CSS-only animations instead of Framer Motion for bundle size, but does not quantify the expected bundle size increase from adding the batch consent components to the deployed widget.
- **Where It Should Be**: Section 11 (Widget vs Studio Differences).
- **Recommendation**: Estimate bundle size impact. The batch consent UI (Zustand store, connector row component, OAuth hook, scope details) likely adds 5-10KB gzipped. Document this and set a budget.

### Finding G-23: No Specification for Consent UI in Dark Mode

- **Severity**: LOW
- **What's Missing**: The design tokens referenced (Section 2.2) use CSS variable names like `--success`, `--warning`, `--error` which are theme-aware. However, the plan does not explicitly verify that all color treatments work in both light and dark modes, particularly the connector row border colors and status indicators.
- **Where It Should Be**: Section 2.2 (Row States).
- **Recommendation**: Add a testing task: "Verify all 5 row states render correctly in both light and dark themes." The design tokens should handle this automatically, but explicit verification is needed.

---

## Infrastructure Gaps

### Finding G-24: Gap 1 Re-encryption Worker Has No GDPR Consideration

- **Severity**: MEDIUM
- **What's Missing**: The re-encryption batch worker (Gap 1, Phase C) iterates all `AuthProfile` documents, decrypts with the old key, and re-encrypts with the new key. During this process, plaintext secrets exist in process memory. The plan does not specify memory handling (zeroing buffers after use) or audit logging for the bulk decryption event.
- **Where It Should Be**: Gap 1, Phase C.
- **Recommendation**: (1) Use a `SecureBuffer` pattern that zeros memory after encryption completes. (2) Emit a single audit event per batch: `{ type: 'auth_profile_bulk_reencrypt', count, tenantId, keyVersionFrom, keyVersionTo }`. (3) The worker must run with the minimum necessary permissions.

### Finding G-25: Gap 2 SDKChannel Migration Script Timing Not Specified

- **Severity**: MEDIUM
- **What's Missing**: Gap 2 specifies a migration script for encrypting existing `SDKChannel.secretKey` values (Step 1) and creating Auth Profiles from them (Step 2). The plan does not specify when these run relative to the main Auth Profile migration or whether they are part of the same migration sequence or a separate migration.
- **Where It Should Be**: Gap 2, Migration Strategy.
- **Recommendation**: Specify: Step 1 (interim encryption) should run as an independent migration BEFORE Auth Profile Phase 1. Step 2 (Auth Profile creation) runs as part of Phase 2 migration. This ensures secrets are never stored plaintext, even during the migration window.

### Finding G-26: Gap 3 TokenManager Dual-Write Consistency Check Not Specified

- **Severity**: MEDIUM
- **What's Missing**: Gap 3 mentions a "consistency check job that compares both stores" in the Risk Assessment table, but no implementation details or task item is provided for this job.
- **Where It Should Be**: Gap 3, Migration Strategy or a new subsection.
- **Recommendation**: Add a task: "Implement `auth-token-consistency-check` BullMQ job that runs daily, queries both `EndUserOAuthToken` and `AuthProfile` for the same `(tenantId, userId, provider)` tuples, and emits a metric for mismatches." This is critical for detecting dual-write drift.

### Finding G-27: Gap 4 Plugin Ordering Guard Is a Dev-Time Warning But No CI Enforcement

- **Severity**: LOW
- **What's Missing**: Gap 4 Step 2 adds a runtime check that warns if a schema has `encrypted*` fields but no `fieldsToEncrypt` metadata. This is a console warning, not a build-time or CI check. A developer could miss it.
- **Where It Should Be**: Gap 4, Step 2 or Testing Strategy.
- **Recommendation**: Add a unit test that iterates all Mongoose schemas in `packages/database/src/models/` and asserts that any schema with fields matching `/^encrypted/` has the `encryptionPlugin` applied. This is a static verification, not a runtime warning.

---

## Deferred Types & Addons

### Finding G-28: Kerberos Temp File Keytab Has No tmpdir Customization

- **Severity**: MEDIUM
- **What's Missing**: Section 1.2 specifies writing the keytab to a temp file with `mode: 0o600`. In containerized environments, `/tmp` may be a shared filesystem (e.g., when using `emptyDir` volumes). The plan does not specify using a secure temp directory or customizing the temp path.
- **Where It Should Be**: Section 1.2 (Keytab security protocol).
- **Recommendation**: Use `os.tmpdir()` with a per-invocation random subdirectory: `fs.mkdtemp(path.join(os.tmpdir(), 'krb5-'))`. Ensure the temp directory is on a `noexec` mount in Docker. Document that the runtime container should have a dedicated tmpfs mount for sensitive temp files.

### Finding G-29: SAML Assertion Cache Has No Tenant Isolation in Redis Key

- **Severity**: HIGH
- **What's Missing**: Section 1.3 defines the Redis cache key as `auth-profile:saml:{tenantId}:{profileId}`. This includes `tenantId`, which is correct for isolation. However, the Kerberos cache key (Section 1.2) is `auth-profile:kerberos:{tenantId}:{profileId}:{servicePrincipal}`. The pattern is inconsistent (SAML has no third component), and more importantly, neither plan verifies that a rogue tenant cannot craft a `profileId` that matches another tenant's cache key through a collision in the `{tenantId}:{profileId}` namespace.
- **Where It Should Be**: Sections 1.2 and 1.3.
- **Recommendation**: Use a consistent key pattern: `auth-profile:{type}:{tenantId}:{profileId}` where `profileId` is a UUID (collision-resistant by design). Since `tenantId` is a UUID or ObjectId, collisions are already extremely unlikely. Document this as a security design decision.

### Finding G-30: No Observability Specified for Enterprise Auth Types

- **Severity**: MEDIUM
- **What's Missing**: The plan specifies feature flags and rollback for enterprise types but does not define trace events or metrics for enterprise auth type resolution. The main design (Section 10) defines `auth_profile_resolved` and `auth_profile_failed` events, but enterprise types have unique failure modes (KDC unreachable, SAML assertion expired, SOAP envelope malformed) that need specific trace data.
- **Where It Should Be**: A new Section between 7 (Testing) and 8 (Rollback), or added to Section 8.6 (Monitoring for Rollback Triggers).
- **Recommendation**: Add trace events: `auth_enterprise_kerberos_ticket_acquired`, `auth_enterprise_kerberos_kdc_unreachable`, `auth_enterprise_saml_assertion_acquired`, `auth_enterprise_saml_assertion_expired`, `auth_enterprise_ws_security_applied`, `auth_enterprise_ws_security_rest_misuse`. Add latency histogram per enterprise type.

### Finding G-31: Certificate Pinning Addon Has No Pin Rotation Notification

- **Severity**: MEDIUM
- **What's Missing**: Section 4.1 describes certificate pinning with multiple pins and `expiresAt` for pin rotation. However, there is no mechanism to alert administrators when a pin is about to expire. If all active pins expire, all HTTPS connections to the pinned host will fail.
- **Where It Should Be**: Section 4.1 (certificatePinning).
- **Recommendation**: Add a background check (part of `CredentialAgeMonitor` or a new job) that queries Auth Profiles with `certificatePinning.pins[].expiresAt` approaching and emits a warning trace event 7 days before expiry. Add metric: `auth_cert_pin_expiry_days` (gauge).

---

## Requirements From Reviews Not Addressed in Any Plan

### Finding G-32: Security Review Finding-003 (Validate Endpoint Visibility) Not in Any Plan

- **Severity**: CRITICAL
- **What's Missing**: Security review FINDING-003 states that the `POST /:id/validate` endpoint does not enforce personal profile visibility. A non-admin user could trigger credential decryption for another user's personal profile by guessing the ID. None of the 6 plans address this. The Infrastructure Gaps plan covers audit trail (Finding-002/007), rotation (Finding-001/008), and ClickHouse audit (Finding-005), but not the validate endpoint access control gap.
- **Where It Should Be**: Infrastructure Gaps plan as a new Gap, or the master design should be amended.
- **Recommendation**: Add Gap 8 to the Infrastructure Gaps plan: "Validate Endpoint Visibility Enforcement." Implementation: wrap the `validateAuthProfileAccess` helper to include `$or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }]` on every ID-based endpoint.

### Finding G-33: Security Review Finding-004 (Proxy Chain Shared-to-Personal) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: Security review FINDING-004 states that `proxyAuthProfileId` allows a shared profile to reference a personal profile as its proxy, bypassing the personal visibility restriction. None of the 6 plans address this. The master design Section 3.3 mentions "Visibility check: A shared profile MUST NOT reference a personal profile as its proxy" but no plan includes the implementation.
- **Where It Should Be**: Infrastructure Gaps plan as a new Gap.
- **Recommendation**: Add Gap 8 or 9: "Proxy Chain Visibility Enforcement." Implementation: in `AuthProfileService.update()` and `AuthProfileService.create()`, when `proxy.proxyAuthProfileId` is set, verify the referenced profile is not `visibility: 'personal'` unless the current profile is also personal and `createdBy` matches.

### Finding G-34: Security Review Finding-006 (providerUserId PII Leak) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: Security review FINDING-006 states that `oauth2_token.config.providerUserId` leaks through `AUTH_PROFILE_READ` permission. The master design moved `providerUserId` to `encryptedSecrets`, but none of the implementation plans specify the migration for existing data that may have `providerUserId` in the `config` field.
- **Where It Should Be**: Infrastructure Gaps plan or GAP-3.3 (which handles token storage).
- **Recommendation**: Add a migration step: query `AuthProfile.find({ authType: 'oauth2_token', 'config.providerUserId': { $exists: true } })`, move `config.providerUserId` into `encryptedSecrets`, and `$unset` it from `config`.

### Finding G-35: Security Review Finding-009 (Normalized Type Ciphertext) Not in Any Plan

- **Severity**: MEDIUM
- **What's Missing**: Security review FINDING-009 warns that the `NormalizedAuthProfile` type pattern could expose `encryptedSecrets` ciphertext to API routes. None of the 6 plans specify the type design for `NormalizedAuthProfile` or mandate that ciphertext fields use `never` type.
- **Where It Should Be**: Infrastructure Gaps plan or a new "API Response Safety" gap.
- **Recommendation**: Define `NormalizedAuthProfile` with `encryptedSecrets?: never` and `previousEncryptedSecrets?: never`. Create a separate `DecryptedAuthProfile` type used only in the runtime resolution layer.

### Finding G-36: Security Review Finding-012 (SSRF on URL Fields / Zod .strict()) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: Security review FINDING-012 warns that `oauth2_app.config.authorizationUrl`, `tokenUrl`, `refreshUrl`, and `revocationUrl` need SSRF validation, and all config Zod schemas must use `.strict()` to prevent prototype pollution. None of the 6 plans address this.
- **Where It Should Be**: Infrastructure Gaps plan as a new Gap, or the Deferred Types plan (which defines new config schemas).
- **Recommendation**: Add a cross-cutting task: (1) Apply `ssrf-validator` to all URL fields in auth profile config schemas. (2) Change all Zod config schemas to use `.strict()`. The Deferred Types plan Section 3.1 adds new schemas for enterprise types -- these must also use `.strict()`.

### Finding G-37: False Negatives Finding 1.1 (TriggerRegistration.webhookSecret) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: The false negatives review identifies `TriggerRegistration.webhookSecret` as a plain-text credential not in the migration table. None of the 6 plans address it. The Infrastructure Gaps plan covers `SDKChannel.secretKey` (Gap 2) but not `TriggerRegistration.webhookSecret`.
- **Where It Should Be**: Infrastructure Gaps plan as a new Gap.
- **Recommendation**: Add to Infrastructure Gaps: apply `encryptionPlugin` to `TriggerRegistration.webhookSecret` as interim encryption, then migrate to Auth Profile with `webhookVerification` addon in Phase 2.

### Finding G-38: False Negatives Finding 1.2 (GuardrailPolicy.providerOverrides.apiKeyCredentialId) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: The false negatives review identifies `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` as a credential reference not in the consumer mapping table. None of the 6 plans address it. When `LLMCredential` is deleted in Phase 3, guardrail policy-level overrides will silently break.
- **Where It Should Be**: Infrastructure Gaps plan or a new consumer mapping gap.
- **Recommendation**: Add to the consumer migration table: `GuardrailPolicy.providerOverrides[].apiKeyCredentialId` -> `GuardrailPolicy.providerOverrides[].authProfileId`. Add dual-read to the guardrail execution path.

### Finding G-39: False Negatives Finding 1.4 (ModelConfig.credentialId) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: `ModelConfig.credentialId` stores a reference to `LLMCredential._id` for per-project model credential overrides. It is not in any plan's consumer mapping table. When `LLMCredential` is deleted, `ModelConfig` credential resolution breaks.
- **Where It Should Be**: Infrastructure Gaps plan.
- **Recommendation**: Add `ModelConfig.credentialId` -> `ModelConfig.authProfileId` to the consumer migration table. Update `model-resolution.ts` with dual-read.

### Finding G-40: False Negatives Finding 5.1 (No Alerting Thresholds) Not in Any Plan

- **Severity**: MEDIUM
- **What's Missing**: The false negatives review identifies that new failure modes (`AUTH_PROFILE_TOKEN_REFRESH_FAILED`, `AUTH_PROFILE_DECRYPTION_FAILED`, `AUTH_PROFILE_CERT_PIN_MISMATCH`, proxy chain failures, Redis lock contention) have error codes defined but no alerting thresholds. None of the 6 plans specify alerting.
- **Where It Should Be**: Infrastructure Gaps plan Section 12 (Testing Strategy) or a new Monitoring section.
- **Recommendation**: Add an alerting specification: `AUTH_PROFILE_DECRYPTION_FAILED` > 0 in 5 minutes = P1 alert. `AUTH_PROFILE_TOKEN_REFRESH_FAILED` > 10/min = P2 alert. `AUTH_PROFILE_CERT_PIN_MISMATCH` (strict mode) > 5% = P1 alert.

### Finding G-41: False Negatives Finding 5.2 (No Health Check) Not in Any Plan

- **Severity**: MEDIUM
- **What's Missing**: The false negatives review identifies that `authProfileService` has no health check endpoint. `authProfileService.resolve()` is on the critical path for every agent turn. None of the 6 plans add `AuthProfile` to the health check registry.
- **Where It Should Be**: Infrastructure Gaps plan.
- **Recommendation**: Add a health check task: register `AuthProfile` in `service-registry.ts`. The check should: (1) query `AuthProfile.countDocuments({ tenantId: 'health-check' })` to verify MongoDB connectivity, (2) verify the encryption service can decrypt a test value.

### Finding G-42: CI/CD Review Blocker B3 (Unique Constraint Name Collision) Not in Any Plan

- **Severity**: HIGH
- **What's Missing**: The CI/CD review identifies that the unique constraint `{ tenantId, projectId, name }` may fail during data migration if auto-generated names collide. None of the 6 plans specify name deduplication during migration.
- **Where It Should Be**: Infrastructure Gaps plan or the master design's migration section.
- **Recommendation**: The migration script must detect name collisions and append a suffix: "Production OpenAI", "Production OpenAI (2)". Create the unique index AFTER data migration with conflict resolution.

### Finding G-43: False Negatives Finding 2.3 (OrgProxyConfig Multi-Credential Merge) Not in Any Plan

- **Severity**: MEDIUM
- **What's Missing**: `OrgProxyConfig` has 6 encrypted fields mapping to 3 different auth types. The false negatives review notes that the merge strategy (one Auth Profile vs multiple) is unspecified. None of the 6 plans address this.
- **Where It Should Be**: Infrastructure Gaps plan.
- **Recommendation**: Specify the migration rule: create one Auth Profile per active auth type on the `OrgProxyConfig` record. If both `encryptedProxyUsername` and `encryptedProxyToken` are set, create two Auth Profiles (one `basic`, one `bearer`). Link the primary one to the `OrgProxyConfig.authProfileId` and store a secondary reference as `OrgProxyConfig.proxyAuthProfileIds[]`.

---

## Summary

| Severity | Count | Key Themes                                              |
| -------- | ----- | ------------------------------------------------------- |
| CRITICAL | 4     | Conflicting data models, identity mismatch, access ctrl |
| HIGH     | 14    | Missing security items, missing consumer migrations     |
| MEDIUM   | 16    | Race conditions, monitoring gaps, missing channels      |
| LOW      | 5     | Bundle size, dark mode, SSR, CI enforcement             |

### Top 5 Actions Required

1. **Unify consent state models** between GAP-3.1 and GAP-3.2 (G-1, G-6)
2. **Use contactId (not userId) for token identity** across all consent plans (G-3)
3. **Address 7 unresolved security review findings** not covered by any plan (G-32 through G-36)
4. **Add 4 missing consumer migrations** from the false negatives review (G-37 through G-39, G-43)
5. **Add rate limiting, origin validation, and SSRF guards** to consent endpoints (G-8, G-11, G-36)
