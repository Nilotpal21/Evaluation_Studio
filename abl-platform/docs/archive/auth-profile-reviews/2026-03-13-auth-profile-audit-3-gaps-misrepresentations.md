# Auth Profile Implementation Plans — Gaps & Misrepresentations Audit

> **Auditor:** Claude Opus 4.6
> **Date:** 2026-03-13
> **Plans Reviewed:**
>
> 1. GAP-3.1: Preflight Consent Modal
> 2. GAP-3.2: Partial Consent Handling
> 3. GAP-3.3: Consent Persistence
> 4. GAP-3.4: Batch Consent UI
> 5. Infrastructure Gaps
> 6. Deferred Types & Addons

---

## Contradictions Between Plans

### Finding M-1: Conflicting Session State Machines for Consent

- **Severity**: CRITICAL
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 defines consent state on `SessionData` (the serializable Redis type) via an `authGate` field with states `pending | satisfied | timed_out | denied`. GAP-3.2 defines consent state on `RuntimeSession` (the in-memory execution type) via `_consentState`, `_blocked`, and `_pendingInlineConsent` fields, with a completely different state machine (`BLOCKED -> INITIALIZED -> SUSPENDED -> RUNNING`). These are two independent state representations for the same concept, with different field names, different state values, and different locations. Any implementer would have to choose one or reconcile both, which neither plan addresses.
- **Evidence**: GAP-3.1 Section 3.1 adds `authGate` to `SessionData` in `apps/runtime/src/services/session/types.ts`. GAP-3.2 Section 4.1 adds `_consentState` and `_blocked` to `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`. These are different types — `SessionData` is the serializable form stored in Redis; `RuntimeSession` is the hydrated in-memory form. The plans never reference each other's state structures.
- **Resolution**: Consolidate into a single consent state model. `SessionData` should hold the serializable consent state (since it must survive pod restarts), and `RuntimeSession` should hydrate from it. Define one canonical type in `packages/shared/src/types/auth-gate.ts` and use it in both locations. Remove the duplicate state machine from GAP-3.2.

### Finding M-2: Conflicting WebSocket Event Names

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 Section 5.1 defines server WebSocket events: `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `auth_gate_timeout`. GAP-3.2 Section 6.5 defines different events for the same concepts: `consent_state_changed`, `session_unblocked`, `inline_consent_required`, `inline_consent_satisfied`. These are overlapping event sets with no reconciliation. For instance, when all preflight connectors are satisfied, GAP-3.1 sends `auth_gate_satisfied` while GAP-3.2 sends `session_unblocked`. A client would need to handle both.
- **Evidence**: Current `events.ts` at `apps/runtime/src/websocket/events.ts` has neither set of events — it only defines `load_agent`, `send_message`, `agent_loaded`, `response_*`, `trace_event`, etc. The two plans propose incompatible additions to the same file.
- **Resolution**: Unify into a single event vocabulary. Recommended: use the GAP-3.1 naming (`auth_required`, `auth_gate_updated`, `auth_gate_satisfied`) for preflight, and add `inline_consent_required` / `inline_consent_satisfied` only for the inline consent flow (which is a different UX path).

### Finding M-3: Conflicting Session Blocking Mechanisms

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 blocks the session by not executing `ON_START` and not sending `agent_loaded`. GAP-3.2 blocks the session by setting `session._blocked = true` which "prevents initializeSession from running." These are different mechanisms. GAP-3.1's approach is at the WebSocket handler level (don't call the runtime), while GAP-3.2's approach is inside the runtime executor. If both are implemented, the check happens in two places with potential for one to succeed while the other fails.
- **Evidence**: GAP-3.1 Section 4.3 says "Do NOT execute `ON_START`" and "Do NOT send the `agent_loaded` success response." GAP-3.2 Section 3.1 says `session._blocked = true; // Prevents initializeSession from running` with the check happening inside `createSessionFromResolved()`.
- **Resolution**: Pick one enforcement point. The runtime executor (`createSessionFromResolved`) is the better location since it works for all entry points (WebSocket, REST, async channels). The handler layer should simply forward the runtime's response to the client, not duplicate the blocking logic.

### Finding M-4: Conflicting Consent Satisfaction Endpoints

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 uses a WebSocket message (`auth_consent_complete`) for the client to notify the server that OAuth completed, combined with Redis pub/sub for cross-pod coordination. GAP-3.2 defines a REST endpoint `POST /api/runtime/sessions/:sessionId/consent` for the same purpose. These are different API contracts. GAP-3.4 references yet another endpoint: `GET /api/projects/:pid/auth-profiles/preflight-status?sessionId=X` for polling.
- **Evidence**: GAP-3.1 Section 5.1 client messages: `auth_consent_complete`. GAP-3.2 Section 3.3: `POST /api/runtime/sessions/:sessionId/consent`. GAP-3.4 Section 1.1: `GET /api/projects/:pid/auth-profiles/preflight-status?sessionId=X`.
- **Resolution**: The REST endpoint approach (GAP-3.2) is more robust because it works for all channel types (not just WebSocket). Keep the REST endpoint as the canonical satisfaction path. The WebSocket message can be a convenience wrapper that calls the same underlying service. Eliminate the separate polling endpoint from GAP-3.4 — use the same REST endpoint with a simple GET variant.

---

## Architectural Misrepresentations

### Finding M-5: AgentIR Has No `auth_requirements` Field

- **Severity**: CRITICAL
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 Section 4.2 states "Extract `authRequirements` from the compiled `AgentIR`" and claims "the compiler already propagates `per_user` + `consent: preflight` requirements up the dependency tree per design Section 6." GAP-3.2 Section 2.3 proposes adding `auth_requirements?: AuthRequirementIR[]` to `AgentIR`. The actual `AgentIR` type at `packages/compiler/src/platform/ir/schema.ts` has **no** `auth_requirements` field, no `consent` field, no `connection_mode` field. Zero `auth_requirements` or `consent` references exist anywhere in the compiler source.
- **Evidence**: The `AgentIR` interface (schema.ts line 130-202) contains: `metadata`, `execution`, `identity`, `tools`, `gather`, `attachments`, `memory`, `constraints`, `coordination`, `completion`, `error_handling`, `flow`, `on_start`, `messages`, `hooks`, `nlu`, `intent_handling`, `templates`, `routing`, `available_agents`, `project_runtime_config`, `lookup_tables`, `behavior_profiles`. No auth-related fields. The `ToolDefinition` interface (line 550-627) has no `connection_mode` or `consent_mode`. The `ConnectorBindingIR` (line 637-640) has only `connector` and `action` — no auth fields. `grep` for `consent|per_user|connection_mode` in the entire compiler source returns zero files.
- **Resolution**: GAP-3.2's Phase 1 task list correctly identifies this as new work (tasks 1.1 through 1.9). GAP-3.1 must be updated to remove the false claim that "the compiler already propagates" these requirements. Both plans must acknowledge that the compiler IR changes are a prerequisite that does not yet exist, and GAP-3.1's runtime work cannot start until GAP-3.2's Phase 1 (compiler IR) is complete.

### Finding M-6: CompilationOutput Has No `preflight_auth_requirements`

- **Severity**: HIGH
- **Plans Affected**: GAP-3.2
- **Issue**: GAP-3.2 Section 2.4 proposes adding `preflight_auth_requirements?: AuthRequirementIR[]` to `CompilationOutput`. The actual `CompilationOutput` interface has no such field.
- **Evidence**: `CompilationOutput` at schema.ts line 1873 contains: `version`, `compiled_at`, `agents`, `entry_agent`, `deployment`, `remote_agents`, `coordination_defaults`. No auth fields.
- **Resolution**: This is acknowledged as new work in GAP-3.2's task list. Not a misrepresentation per se, but the dependency must be explicit: GAP-3.1's runtime `checkPreflightAuth()` function depends on this field existing.

### Finding M-7: `EndUserOAuthToken` Lacks `projectId`, `contactId`, and `tokenStatus`

- **Severity**: HIGH
- **Plans Affected**: GAP-3.3
- **Issue**: GAP-3.3 Section 1.2 proposes adding `projectId`, `contactId`, `authProfileId`, `grantedScopes`, `tokenStatus`, `refreshFailCount`, `refreshFailedAt`, and `deviceFingerprint` to `EndUserOAuthToken`. However, the plan also says in Section 1.1 that the model "already exists" with the listed fields, implying the base model is complete. The actual model has none of these proposed fields.
- **Evidence**: `EndUserOAuthToken` at `packages/database/src/models/end-user-oauth-token.model.ts` has: `_id`, `tenantId`, `userId`, `provider`, `providerUserId`, `encryptedAccessToken`, `encryptedRefreshToken`, `scope`, `expiresAt`, `refreshedAt`, `consentedAt`, `revokedAt`, `lastUsedAt`, `_v`. No `projectId`, no `contactId`, no `tokenStatus`, no `grantedScopes`. The unique index is `{ tenantId, userId, provider }` — no `projectId` in the index.
- **Resolution**: Section 1.2 correctly identifies these as "Required Schema Changes." The plan is internally consistent but should more clearly mark Section 1.1 as "current state" and Section 1.2 as "proposed additions." The breaking index change from `{ tenantId, userId, provider }` to `{ tenantId, projectId, userId, provider }` needs a migration strategy that handles the transition without downtime — the plan mentions this but buries it.

### Finding M-8: `handler.ts` Does Not Exist at the Claimed Location

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 6.2 references "Redis pub/sub (already used for cross-pod delivery, see `handler.ts` line ~187)." The file exists at `apps/runtime/src/websocket/handler.ts` but the claim that Redis pub/sub is "already used for cross-pod delivery" at line ~187 needs verification. The WebSocket handler file does not have a separate events file — the WS events are defined at `apps/runtime/src/websocket/events.ts` which contains only message parsing utilities and creators, with no Redis pub/sub infrastructure.
- **Evidence**: `events.ts` defines `parseClientMessage()` and `ServerMessages.*` factory functions. No Redis imports, no pub/sub channels. The handler itself may use Redis through the session store, but no dedicated auth gate pub/sub channel exists.
- **Resolution**: The plan must acknowledge that Redis pub/sub for auth gate coordination is entirely new infrastructure, not an extension of existing cross-pod delivery.

### Finding M-9: CredentialAgeMonitor Already Queries AuthProfile (Infrastructure Gaps Plan Correctly Notes This)

- **Severity**: LOW
- **Plans Affected**: Infrastructure Gaps
- **Issue**: The Infrastructure Gaps plan (Gap 5) correctly states "This gap has been addressed" and that the monitor already queries AuthProfile. This is accurate per the codebase. However, it then says the monitor uses `rotatedAt` from a `CredentialRecord` interface but `AuthProfile` does not have `rotationStartedAt`. The plan correctly identifies this as a follow-up dependency on Gap 1.
- **Evidence**: `credential-age-monitor.ts` imports `AuthProfile` and queries it at line 42+. The `rotatedAt` field at line 22 is checked at line 68.
- **Resolution**: No action needed — this is correctly identified and handled.

---

## Logical Gaps

### Finding M-10: Voice Channel OAuth is Practically Impossible for Many Deployments

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 5.2 proposes that voice channels send an SMS link or read a URL aloud. For pure voice channels (VXML, AudioCodes, KoreVG) without SMS capability, the plan suggests reading a vanity URL aloud ("go.kore.ai/auth/XXXX"). This requires: (a) a URL shortener service that doesn't exist in the platform, (b) the user to memorize or type a URL while on a phone call, (c) the user to have a web browser available during the call. For IVR callers using landlines or basic phones, this entire flow is impossible.
- **Evidence**: The channel types include `vxml`, `audiocodes`, `korevg` — these are typically enterprise IVR systems where callers may be on desk phones. The plan has no fallback for callers who cannot access a web browser.
- **Resolution**: Add an explicit fallback: if the channel is pure voice with no SMS capability and no web handoff path, the preflight check should fail with a deployment-time validation error: "Agent X uses per_user preflight connectors but is deployed on voice channel Y which cannot present OAuth consent. Either use shared connections or add an SMS-capable channel." This is cheaper and more honest than building a URL-reading flow that will fail in practice.

### Finding M-11: Anonymous Users (Tier 0) Cannot Use Per-User Preflight

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.3
- **Issue**: GAP-3.1 Section 15 (Open Question 4) asks "How does `per_user` work without a platform identity?" and proposes using phone number hash as `createdBy`. GAP-3.3 Section 3.1 states Tier 0 (anonymous) tokens are "session-scoped only — no cross-session persistence" and "The pre-flight will always appear for anonymous users." These two plans partially contradict: GAP-3.1 proposes using a phone number hash (which IS a persistent identity, equivalent to Tier 1), while GAP-3.3 says anonymous users get no persistence. The core problem remains unaddressed: web chat users with no login have no phone number and no persistent identity.
- **Evidence**: `SessionData` at `apps/runtime/src/services/session/types.ts` has `callerContext?: CallerContext` which provides identity tiers, but many sessions will have no `callerContext` (e.g., Studio test panel).
- **Resolution**: Explicitly define behavior for anonymous web users: (a) During preflight, store the OAuth token with `userId = sessionId` (session-scoped), (b) Accept that every new session requires re-authorization, (c) Document this as a known UX limitation, (d) In Studio test panel specifically, use the developer's authenticated identity instead of anonymous.

### Finding M-12: Inline Consent Tool Suspension Has No LLM State Recovery

- **Severity**: HIGH
- **Plans Affected**: GAP-3.2
- **Issue**: GAP-3.2 Section 3.4 says when an inline consent is needed: "Suspend the tool execution (do NOT call the tool)" and "Set `session._pendingInlineConsent = { connector, toolName, toolCallId }`." After OAuth completes, "Retry the tool call with the now-available token." The problem is that the LLM's tool call is part of a streaming response with potentially multiple tool calls in a single turn. Suspending mid-tool-execution means: (a) the LLM's response is partially consumed, (b) other tool calls in the same turn may have already executed, (c) the conversation state has advanced. Simply "retrying the tool call" does not restore the LLM's reasoning context.
- **Evidence**: `RuntimeSession.conversationHistory` stores the conversation as `{ role, content }` pairs. The reasoning executor processes tool calls within a single LLM turn. There is no mechanism to "pause" a turn mid-execution and resume it later — the executor either completes the turn or fails.
- **Resolution**: For inline consent, the tool should return a structured error result to the LLM (not suspend execution): `{ error: "CONSENT_REQUIRED", message: "User needs to authorize Gmail" }`. The LLM will naturally respond by telling the user to authorize. After authorization, the user's next message triggers a new LLM turn where the tool can be called successfully. This avoids the impossible mid-turn suspension problem.

### Finding M-13: No Handling of Handoff During Preflight Gate

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.2 Section 5.3 addresses handoff to agents with unsatisfied preflight requirements — it blocks the handoff and returns `auth_required`. But neither plan addresses the reverse: what happens if the user is in the preflight gate of Agent A and Agent A is a handoff target from Agent B? The session flow is: user loads Agent B -> Agent B hands off to Agent A -> Agent A has preflight requirements -> gate shown. But the user is now mid-conversation with Agent B, and the gate blocks Agent A's start. The UX is confusing because the user was talking to Agent B and suddenly sees a consent wall for Agent A's connectors.
- **Evidence**: The `handoffStack` on `SessionData` tracks handoff chains. No plan discusses how to present the consent gate in the context of a handoff — should it say "Agent A needs access..." when the user was talking to Agent B?
- **Resolution**: When preflight requirements arise during handoff, the consent message should include context: "To continue, [Agent A] needs access to the following services." The UX should make it clear that this is a transition, not a malfunction. Additionally, consider whether the compiler should bubble up all reachable agents' preflight requirements to the entry agent (as GAP-3.2 Section 5.1 partially addresses).

---

## Circular Dependencies

### Finding M-14: GAP-3.1 Depends on GAP-3.2 Which Depends on GAP-3.1

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 assumes `authRequirements` exist on the compiled IR (which GAP-3.2 Phase 1 creates). GAP-3.2 Section 3.1 says the preflight check happens "after `createSessionFromResolved()` builds the session" and refers to the same runtime integration points that GAP-3.1 claims to own. Both plans modify the same files (`session types`, `runtime-executor.ts`, `handler.ts`, `events.ts`) without a clear ownership split.
- **Evidence**: GAP-3.1 Section 8.2 modifies: `session/types.ts`, `websocket/events.ts`, `websocket/handler.ts`, `session-bootstrap.ts`, `runtime-executor` (indirectly). GAP-3.2 Section 8 modifies: `execution/types.ts` (RuntimeSession), `runtime-executor.ts`, `flow-step-executor.ts`, `reasoning-executor.ts`. Both touch the same execution path.
- **Resolution**: Establish a clear layering: (1) GAP-3.2 Phase 1 (compiler IR) runs first with zero runtime dependencies, (2) GAP-3.1 owns the runtime integration for preflight only, (3) GAP-3.2 Phases 2-3 add inline consent on top of GAP-3.1's runtime infrastructure. The shared types (consent state, auth requirements) must be defined once in `packages/shared` and imported by both.

---

## Over-Engineering

### Finding M-15: Three Separate Polling/Notification Mechanisms for Consent Satisfaction

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.2, GAP-3.4
- **Issue**: The plans collectively propose: (a) Redis pub/sub for cross-pod auth gate notification (GAP-3.1 Section 6.2), (b) WebSocket events for real-time client updates (GAP-3.1 Section 5.1), (c) REST polling endpoint for status checks (GAP-3.4 Section 1.1), (d) `POST /sessions/:id/consent` satisfaction endpoint (GAP-3.2 Section 3.3). This is four different communication paths for what is fundamentally a single event: "user authorized connector X."
- **Evidence**: GAP-3.1 Section 6.1-6.3 describes the full chain: OAuth callback -> update session -> Redis pub/sub -> WebSocket -> client. GAP-3.4 adds a polling endpoint on top. GAP-3.2 adds a REST consent endpoint.
- **Resolution**: Simplify to two paths: (1) OAuth callback handler updates session store + publishes Redis event, (2) Redis subscriber on the WS-holding pod sends the WS event to client. The polling endpoint is a fallback for non-WebSocket channels only. The separate `POST /consent` endpoint is unnecessary if the OAuth callback already handles satisfaction.

### Finding M-16: Concurrent Session Cross-Notification is Unnecessary Complexity

- **Severity**: LOW
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 7.5 proposes that when a user authorizes Gmail in Session A, Session B should automatically detect it via a wildcard pub/sub pattern `auth_gate:*:connector_satisfied`. This adds significant infrastructure (wildcard Redis subscriptions, per-connector event channels) for an edge case that the preflight check already handles: Session B's preflight check queries the token store, which will find the token created by Session A.
- **Evidence**: GAP-3.3 Section 7.8 correctly identifies: "The `oauth2_token` is per-user, not per-session. The consent state check queries the auth profile store, not the session." This means Session B's initial preflight check will already find Session A's token if they happen close together.
- **Resolution**: Drop the cross-session notification. If Session B is already in the gate, the user can click "Authorize" again and the flow will detect the existing token, or the standalone preflight page can poll the status endpoint. The marginal UX improvement does not justify wildcard pub/sub infrastructure.

---

## Under-Engineering

### Finding M-17: No Rate Limiting on OAuth Consent Endpoints

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: The `POST /oauth/user-consent` endpoint generates OAuth authorization URLs with embedded state parameters. The `POST /oauth/callback` endpoint exchanges authorization codes for tokens. Neither plan specifies rate limiting beyond GAP-3.1's "20 requests per minute per token" for the standalone preflight page. A malicious user could spam `/user-consent` to generate thousands of OAuth state entries in Redis/memory, or flood `/callback` with forged codes causing upstream provider rate limiting.
- **Evidence**: No rate limiting middleware is specified for any of the new endpoints. The existing channel adapter endpoints have rate limiting, but these are new routes.
- **Resolution**: Add rate limiting: (a) `/user-consent`: 10 requests per minute per session, (b) `/callback`: 5 requests per minute per session, (c) `/preflight-link`: 3 requests per minute per session. Use existing rate limiting middleware pattern.

### Finding M-18: No Cleanup of Orphaned OAuth State Parameters

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.3
- **Issue**: GAP-3.1 Section 10.2 states "The state is encrypted (AES-256-GCM) with the platform encryption key" and includes `nonce` for replay prevention. GAP-3.3 Section 10.4 says "nonce uniqueness (Redis SET NX)." However, neither plan specifies TTL for the nonce entries in Redis. If the user abandons the OAuth flow (closes popup without completing), the nonce stays in Redis forever.
- **Evidence**: The OAuth state parameter includes `exp` (expiration), but the Redis nonce tracking (`SET NX`) has no specified TTL.
- **Resolution**: The nonce entries in Redis must use `SETEX` with TTL equal to `AUTH_TOKEN_OAUTH_STATE_TTL_SECONDS` (10 minutes per GAP-3.3 Section 12). This is a one-line fix but critical for preventing Redis memory leaks.

### Finding M-19: No Deployment-Time Validation for Per-User Requirements

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 Section 5.5 mentions deploy-time validation for A2A channels but does not specify comprehensive deployment validation. If an agent declares `per_user` + `preflight` for a connector but no `oauth2_app` Auth Profile exists for that connector in the project, the preflight flow will fail at runtime (no `authorizationUrl` to redirect to). This should be caught at deploy time, not at session start.
- **Evidence**: GAP-3.2 Section 5.2 mentions: "If no matching `oauth2_app` profile exists for a preflight connector, the deployment validation emits a warning." But a warning is insufficient — this should be a blocking error since the agent literally cannot function.
- **Resolution**: Deployment validation must: (a) error (not warn) if a preflight connector has no `oauth2_app` profile, (b) error if a `per_user` agent is deployed to a voice-only channel with no SMS fallback, (c) error if A2A agents have `per_user` requirements without shared fallback. These are configuration errors, not runtime edge cases.

---

## Naming Inconsistencies

### Finding M-20: `authGate` vs `consentState` vs `consent` Naming Split

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.2, GAP-3.3, GAP-3.4
- **Issue**: The same concept has four different names across plans:
  - GAP-3.1: `authGate` (field on SessionData), `AuthPreflightRequirement`, `AuthGateState`
  - GAP-3.2: `_consentState` (field on RuntimeSession), `ConsentState`, `ConsentEntry`, `PendingInlineConsent`
  - GAP-3.3: `ConsentStateResolver` (service name), `tokenStatus`
  - GAP-3.4: `BatchConsentState` (Zustand store), `ConsentConnector`, `ConsentStatus`
- **Evidence**: All four plans. The UI layer (GAP-3.4) uses "Consent" terminology, the runtime layer (GAP-3.1) uses "AuthGate" terminology, and GAP-3.2 mixes both.
- **Resolution**: Pick one vocabulary:
  - **Domain term**: "Auth Gate" for the blocking preflight mechanism
  - **Domain term**: "Consent" for the user's authorization action
  - **Types**: `AuthGate` for the session-level gate state, `ConsentRequirement` for individual connector requirements, `ConsentStatus` for per-connector state
  - Apply consistently across all plans before implementation begins.

### Finding M-21: Different Field Names for the Same OAuth App Reference

- **Severity**: LOW
- **Plans Affected**: GAP-3.1, GAP-3.2, GAP-3.3
- **Issue**: The reference to the OAuth app profile that provides `clientId`/`clientSecret` is named differently: `authProfileId` (GAP-3.1 Section 3.1), `auth_profile_id` (GAP-3.2 Section 2.3 in `AuthRequirementIR`), `authProfileId` (GAP-3.3 Section 1.2 on `EndUserOAuthToken`). The IR type uses snake_case (correct for IR), but the plan text and runtime types inconsistently alternate between camelCase and snake_case.
- **Evidence**: GAP-3.1: `authProfileId: string; // oauth2_app profile ID`. GAP-3.2: `auth_profile_id?: string;`. Both refer to the same concept.
- **Resolution**: Use snake_case in all IR types (compiler output) and camelCase in all runtime/service types (TypeScript convention). This matches existing codebase patterns where `AgentIR` uses snake_case and `RuntimeSession` uses camelCase.

---

## Security Holes

### Finding M-22: Standalone Preflight Page JWT Contains Sensitive Claims Without Encryption

- **Severity**: HIGH
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 10.1 states the preflight page token (`/auth/preflight/<token>`) is a JWT containing `sessionId`, `tenantId`, `projectId`, `userId`, `exp`. The JWT is "signed with the platform's existing JWT signing key" but is not encrypted. JWTs are base64-encoded and trivially readable. This means anyone who intercepts the URL (network logs, browser history, shared link) can extract the `tenantId`, `projectId`, and `userId`.
- **Evidence**: GAP-3.1 Section 5.2: "The `<token>` is a JWT with `{ sessionId, tenantId, projectId, userId, exp }`." Standard JWTs (JWS) are signed but not encrypted — the payload is readable.
- **Resolution**: Either (a) use an opaque token (random UUID) stored in Redis with the session metadata mapped server-side, or (b) use JWE (encrypted JWT) instead of JWS. Option (a) is simpler and more secure — the token reveals nothing and the server controls all access via the Redis mapping.

### Finding M-23: OAuth State Parameter Contains sessionId — Potential Session Fixation

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 9.1 says the OAuth state parameter includes `sessionId`. GAP-3.1 Section 10.2 says the state is "encrypted (AES-256-GCM)." However, GAP-3.3 Section 10.4 says the state is "Signed with HMAC-SHA256" (not encrypted). These contradict. If HMAC-signed (not encrypted), the `sessionId` is visible in the state parameter to anyone who intercepts the OAuth redirect. Combined with the preflight page token (Finding M-22), an attacker who intercepts both values could attempt to bind their OAuth token to another user's session.
- **Evidence**: GAP-3.1 Section 10.2: "encrypted (AES-256-GCM)." GAP-3.3 Section 10.4: "Signed with HMAC-SHA256." These are different — one is confidential, the other is integrity-only.
- **Resolution**: The OAuth state MUST be encrypted (not just signed) since it contains `sessionId`, `tenantId`, and `userId`. Use AES-256-GCM as GAP-3.1 specifies. Update GAP-3.3 Section 10.4 to match.

---

## Timeline Conflicts

### Finding M-24: GAP-3.1 and GAP-3.2 Both Claim Sprint 1 for Overlapping Work

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1, GAP-3.2
- **Issue**: GAP-3.1 Section 13 schedules "Sprint 1: Core Runtime (3-4 days)" including shared types, session types changes, preflight check, and WebSocket integration. GAP-3.2 Section 8 schedules "Phase 1: Compiler IR and Propagation" and "Phase 2: Runtime Consent State" which overlaps with GAP-3.1's Sprint 1 work. Both plans assume they own the session type changes and runtime integration. Total estimated work if both run in Sprint 1: 3-4 days (GAP-3.1) + ~5 days (GAP-3.2 Phase 1-2) = 8-9 days, which exceeds a single sprint.
- **Evidence**: GAP-3.1 Sprint 1 task 2: "Add `authGate` to `SessionData` in session types." GAP-3.2 Task 2.2: "Add `_consentState`, `_blocked`, `_pendingInlineConsent` to `RuntimeSession`." Same types, different fields.
- **Resolution**: Sequence explicitly: Sprint N = GAP-3.2 Phase 1 (compiler IR only, no runtime), Sprint N+1 = GAP-3.1 Sprint 1 + GAP-3.2 Phase 2 (unified runtime consent, single set of session fields), Sprint N+2 = GAP-3.1 Sprint 2 + GAP-3.4 (UI), Sprint N+3 = GAP-3.1 Sprints 3-4 + GAP-3.2 Phase 3 (channels + inline consent).

---

## Impossible Flows

### Finding M-25: `ChannelAdapter` Interface Has No `sendAuthRequiredMessage` Method

- **Severity**: MEDIUM
- **Plans Affected**: GAP-3.1
- **Issue**: GAP-3.1 Section 5.3 proposes adding `sendAuthRequiredMessage` to the `ChannelAdapter` interface. The current `ChannelAdapter` interface has methods: `verifyRequest`, `parseIncoming`, `sendResponse`. The plan says the new method is "optional, with a default implementation." TypeScript interfaces cannot have default implementations — this would require either an abstract base class (which doesn't exist) or a separate utility function that checks `typeof adapter.sendAuthRequiredMessage === 'function'`.
- **Evidence**: `ChannelAdapter` at `apps/runtime/src/channels/types.ts` line 196 is a pure interface with no default implementations.
- **Resolution**: Either (a) add `sendAuthRequiredMessage` as a required method on `ChannelAdapter` and implement it in all 15+ adapters, or (b) create a standalone `sendAuthRequiredMessage(adapter: ChannelAdapter, ...)` function that uses `adapter.sendResponse()` with the auth-required message formatted per channel type. Option (b) is less invasive.

---

## Infrastructure Gaps Plan — Internal Issues

### Finding M-26: Infrastructure Gap 1 Rotation Grace Period is Defeated by `timestamps: true`

- **Severity**: HIGH
- **Plans Affected**: Infrastructure Gaps
- **Issue**: The Infrastructure Gaps plan (Gap 1) correctly identifies that `rotationGracePeriodMs` is anchored to `updatedAt` per the design, but Mongoose `timestamps: true` updates `updatedAt` on every `save()`. The plan proposes adding `rotationStartedAt` as a fix. However, the plan does not address that the `AuthProfile` model already exists in production with `timestamps: true` and existing `rotationGracePeriodMs` values. If any code currently reads `rotationGracePeriodMs` and compares against `updatedAt`, the behavior will change when `rotationStartedAt` is introduced (it would be `null` on existing records).
- **Evidence**: `AuthProfile` schema at `packages/database/src/models/auth-profile.model.ts` has `rotationGracePeriodMs?: number` (line 80) and uses `timestamps: true` (implicit from Mongoose Schema options). `rotationStartedAt` does not exist in the schema.
- **Resolution**: The migration must set `rotationStartedAt = updatedAt` for all existing `AuthProfile` documents that have a non-null `rotationPolicy` and non-null `previousEncryptedSecrets`. This preserves existing grace period behavior during the transition.

---

## Summary

| Severity | Count | Key Themes                                                                                                                                                                                                                                                                                        |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | 2     | Dual state machines for consent (M-1), missing compiler IR (M-5)                                                                                                                                                                                                                                  |
| HIGH     | 11    | Conflicting WS events (M-2), conflicting blocking (M-3), voice OAuth impractical (M-10), anonymous users (M-11), inline consent suspension (M-12), circular dependency (M-14), rate limiting (M-17), deploy validation (M-19), JWT exposure (M-22), timeline (M-24), rotation grace period (M-26) |
| MEDIUM   | 8     | Conflicting endpoints (M-4), handler.ts misrepresentation (M-8), handoff during gate (M-13), over-engineered notifications (M-15), naming inconsistencies (M-20), session fixation (M-23), channel adapter interface (M-25), orphaned nonces (M-18)                                               |
| LOW      | 3     | CredentialAgeMonitor correct (M-9), concurrent session over-engineering (M-16), field name casing (M-21)                                                                                                                                                                                          |

**Top 3 Actions Before Implementation Begins:**

1. **Unify the consent state model** — Resolve M-1, M-2, M-3, M-4, M-20 by having all four GAP plans agree on a single state representation, single set of WS events, and single satisfaction endpoint.
2. **Acknowledge the compiler IR prerequisite** — Resolve M-5, M-6, M-14, M-24 by sequencing GAP-3.2 Phase 1 (compiler changes) before any runtime work in GAP-3.1.
3. **Fix the inline consent approach** — Resolve M-12 by replacing tool suspension with tool error result, avoiding the impossible mid-turn pause problem.
