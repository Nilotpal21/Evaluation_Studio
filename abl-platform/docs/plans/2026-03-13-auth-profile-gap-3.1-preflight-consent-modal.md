# GAP-3.1: Blocking Preflight Consent Modal — Implementation Plan

> **Parent design:** `docs/plans/2026-03-11-auth-profile-design.md` (Section 6: Pre-flight Auth Propagation, Section 7.4: Runtime Consent)
> **UX review reference:** `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md` (GAP-3.1 through GAP-3.4)
> **Date:** 2026-03-13
> **Phase:** Auth Profile Phase 2 (Pre-flight auth propagation in compiler and runtime)

---

## Dependencies

This plan depends on the following:

1. **GAP-3.2 Phase 1 (Compiler IR)** — MUST be completed first. The compiler currently has **no** `auth_requirements`, `connection_mode`, or `consent_mode` fields on `AgentIR`, `ToolDefinition`, or `ConnectorBindingIR`. GAP-3.2 Phase 1 adds these fields and the `AuthRequirementCollector` post-compilation pass. Without this, the runtime preflight check has no data to operate on.
2. **GAP-3.3 (Consent Persistence)** — Provides the canonical token lookup strategy (`ConsentStateResolver`) and the 3-tier contact identity model. This plan defers token lookup implementation to GAP-3.3.
3. **Infrastructure Gaps plan (Gap 1)** — Rotation grace period logic affects how tokens are validated during preflight.

Plans that depend on this plan:

- **GAP-3.4 (Batch Consent UI)** — Consumes the `auth_required` WS event and auth gate session state defined here.
- **GAP-3.2 Phases 2-3 (Runtime Consent + Inline)** — Builds on the runtime infrastructure defined here.

---

## 1. Problem Statement

The auth profile design specifies that tools with `connection: per_user` and `consent: preflight` must block session start until the end user authorizes all required connectors. The runtime already defines an `auth_required` response shape with `pending[]` and `satisfied[]` arrays (design Section 6), but no implementation exists for:

1. How the runtime detects and enforces preflight requirements at session start
2. How each channel type (web, voice, WhatsApp, SMS, API/SDK) presents the consent gate to end users
3. How OAuth completion resumes the blocked session
4. How partial authorization, timeouts, and mid-session token revocation are handled

This plan covers all channel types and the full lifecycle from session creation through auth completion.

---

## 2. Architecture Overview

```
                       SESSION START
                            |
                    +-------v--------+
                    | Runtime reads   |
                    | IR authRequire- |
                    | ments[] from    |
                    | CompilationOut- |
                    | put (GAP-3.2)   |
                    +-------+--------+
                            |
               has preflight requirements?
                    /               \
                  NO                 YES
                  |                   |
          normal session      +------v-------+
          continues           | Check user's |
                              | existing     |
                              | tokens via   |
                              | ConsentState |
                              | Resolver     |
                              | (GAP-3.3)    |
                              +------+-------+
                                     |
                          all satisfied?
                            /         \
                          YES          NO
                          |             |
                   skip preflight   +---v---+
                                   | Set    |
                                   | authGate|
                                   | status: |
                                   | pending |
                                   +---+---+
                                       |
                              emit auth_required
                              to channel layer
                                       |
                         +---------+---+---+---------+
                         |         |       |         |
                       Web     Voice   WhatsApp   API/SDK
                       modal   IVR+    link msg   JSON
                               link               response
```

---

## 3. Unified Consent State Model

> **Cross-plan agreement:** All four GAP-3.x plans use a single canonical consent state model defined in `packages/shared/src/types/auth-consent.ts`. This section defines that model.

### 3.1 Canonical Types

New file: `packages/shared/src/types/auth-consent.ts`

```typescript
/**
 * Canonical auth consent types — used by GAP-3.1, GAP-3.2, GAP-3.3, GAP-3.4.
 * All consent state lives on SessionData (serializable, survives pod restarts).
 * RuntimeSession hydrates from SessionData.
 */

/** Auth gate — present on SessionData when per_user preflight connectors exist */
export interface AuthGate {
  /** Current gate status */
  status: 'pending' | 'satisfied' | 'timed_out' | 'denied';
  /** Requirements from compiled IR */
  requirements: AuthConsentRequirement[];
  /** Connectors the user has already authorized */
  satisfiedConnectors: ConsentEntry[];
  /** Connectors the user explicitly denied */
  deniedConnectors: string[];
  /** When the gate was created (for timeout calculation) */
  createdAt: number;
  /** Absolute deadline — session is abandoned after this (configurable, default 10 min) */
  expiresAt: number;
  /** Inline consent requirements (will be requested mid-conversation, not blocking) */
  pendingInline: ConsentEntry[];
}

export interface AuthConsentRequirement {
  connector: string;
  displayName: string;
  authType: 'oauth2_token';
  scopes: string[];
  authProfileId: string; // oauth2_app profile ID
  authorizationUrl: string; // resolved from oauth2_app config
  consentMode: 'preflight' | 'inline';
}

export interface ConsentEntry {
  connector: string;
  scopes: string[];
  authProfileId?: string;
  /** Timestamp when consent was granted (for audit) */
  grantedAt?: number;
}

/** Pending inline consent — set when a tool invocation is waiting for user auth */
export interface PendingInlineConsent {
  connector: string;
  toolName: string;
  /** Timestamp when the consent was requested */
  requestedAt: number;
  /** Timeout in ms */
  timeoutMs: number;
}
```

### 3.2 SessionData Extension

Add to `SessionData` in `apps/runtime/src/services/session/types.ts`:

```typescript
/** Auth consent gate — present only when per_user preflight connectors exist */
authGate?: AuthGate;
/** Whether the session is blocked waiting for preflight consent */
blocked?: boolean;
/** If an inline consent is pending (GAP-3.2), which tool invocation is waiting */
pendingInlineConsent?: PendingInlineConsent;
```

**Note:** All consent state lives on `SessionData` (the serializable Redis/MongoDB type), NOT on `RuntimeSession` (the in-memory execution type). `RuntimeSession` hydrates from `SessionData`. This ensures consent progress survives pod restarts.

### 3.3 Identity Model

This plan uses GAP-3.3's 3-tier contact identity model for token ownership:

| Tier | `identityTier` | Identity Source                 | Token Persistence                          |
| ---- | -------------- | ------------------------------- | ------------------------------------------ |
| 0    | 0              | Anonymous (no identity)         | **Session-scoped only** — no cross-session |
| 1    | 1              | Channel artifact (cookie, PSID) | **Cross-session via artifact hash**        |
| 2    | 2              | Verified (OAuth, OTP, HMAC)     | **Full cross-session via contactId**       |

The `checkPreflightAuth` function takes `callerContext: CallerContext` as input (not raw `userId`), and resolves `contactId` through GAP-3.3's identity resolution chain before performing token lookups.

### 3.4 State Transitions

```
                   Session Created
                        |
                   [has preflight reqs from compiled IR]
                        |
                   authGate.status = 'pending'
                   session.blocked = true
                        |
              +---------+---------+
              |                   |
     user authorizes       user denies / timeout
     a connector                  |
              |              authGate.status =
     satisfiedConnectors       'denied' | 'timed_out'
     updated                      |
              |              session ends with
     all satisfied?          error message
        /       \
      NO        YES
      |           |
    remain    authGate.status = 'satisfied'
    pending   session.blocked = false
              normal execution begins
```

### 3.5 Message Blocking

While `authGate.status === 'pending'`, the runtime MUST reject `send_message` events with a structured error:

```json
{
  "type": "error",
  "code": "SESSION_AWAITING_AUTH",
  "message": "Session is waiting for authorization. Please complete the required connections.",
  "authGate": { "pending": ["..."], "satisfied": ["..."] }
}
```

This prevents users from sending messages that would fail because required tool credentials are missing.

---

## 4. Runtime: Preflight Detection at Session Start

### 4.1 Location

Insert the preflight check into the session bootstrap path. The enforcement happens inside the runtime executor (`createSessionFromResolved`) so it works for ALL entry points (WebSocket, REST, async channels). The WebSocket/REST handlers simply forward the runtime's response to the client — they do NOT duplicate the blocking logic.

Integration points:

- `apps/runtime/src/services/session/session-bootstrap.ts` (deployment-aware path)
- `apps/runtime/src/websocket/handler.ts` (`load_agent` handler)
- `apps/runtime/src/channels/session-resolver.ts` (async channel path)

### 4.2 Implementation: `checkPreflightAuth`

New file: `apps/runtime/src/services/auth/preflight-check.ts`

```typescript
/**
 * Check compiled IR for preflight auth requirements.
 * Delegates token lookup to GAP-3.3's ConsentStateResolver.
 * Returns unsatisfied requirements.
 */
async function checkPreflightAuth(params: {
  compilationOutput: CompilationOutput;
  tenantId: string;
  projectId: string;
  callerContext: CallerContext; // NOT raw userId — uses GAP-3.3's identity model
  environment?: string;
}): Promise<{
  required: boolean;
  pending: AuthConsentRequirement[];
  satisfied: AuthConsentRequirement[];
  pendingInline: ConsentEntry[];
}>;
```

Logic:

1. Read `preflight_auth_requirements` from `compilationOutput` (populated by GAP-3.2's `AuthRequirementCollector` post-compilation pass)
2. Filter to only `consent_mode: 'preflight'` entries
3. If none, return `{ required: false, pending: [], satisfied: [], pendingInline: [] }`
4. Resolve `contactId` from `callerContext` via GAP-3.3's identity resolution chain
5. For each requirement, delegate to GAP-3.3's `ConsentStateResolver.resolve()` which performs the dual-read strategy (AuthProfile first, EndUserOAuthToken fallback). **Type transformation:** The `ConsentStateResolver.resolve()` returns `{ satisfied: ConsentEntry[], pending: PendingConsentEntry[] }`. The `checkPreflightAuth` function must enrich each `PendingConsentEntry` back into `AuthConsentRequirement` by joining with the original `preflight_auth_requirements` from `CompilationOutput` (which provides `displayName`, `authorizationUrl`, `authType`, `consentMode`).
6. Partition into `pending` (no valid token) and `satisfied` (valid, non-expired token with matching scopes)
7. For each pending requirement, resolve the `authorizationUrl` from the linked `oauth2_app` profile (`authProfileId` in the requirement)
8. Also collect `consent_mode: 'inline'` entries for inclusion in the auth gate (informational, not blocking)

### 4.3 WebSocket Handler Integration

In `apps/runtime/src/websocket/handler.ts`, after the `load_agent` handler resolves the agent IR and creates the runtime session:

1. Call `checkPreflightAuth()`
2. If `result.required && result.pending.length > 0`:
   - Set `authGate` on the session data
   - Set `session.blocked = true`
   - Send a new `auth_required` server message (add to `apps/runtime/src/websocket/events.ts`)
   - Do NOT execute `ON_START`
   - Do NOT send the `agent_loaded` success response (or send it with `{ authRequired: true }` flag)
3. If all satisfied: proceed normally (existing flow)

### 4.4 Async Channel Integration

In `apps/runtime/src/channels/session-resolver.ts`, after `pipelineCreateSession()`:

1. Call `checkPreflightAuth()` with the resolved connection's tenant/project/callerContext
2. If pending requirements exist, set `authGate` on the session
3. The channel's inbound worker (in `apps/runtime/src/channels/pipeline/`) checks `session.blocked` before routing to the runtime executor
4. If `session.blocked === true`, send an `auth_required` response through the channel adapter instead of processing the message

---

## 5. Channel-Specific Preflight UX

### 5.1 Web Chat Widget (Studio Test Panel + Deployed Widget)

**Component:** New `AuthPreflightGate` component in `apps/studio/src/components/chat/AuthPreflightGate.tsx`

**Behavior:**

- Renders as a blocking overlay on the `ChatPanel` when the session has `authGate.status === 'pending'`
- The `ChatInput` is disabled (grayed out, no typing allowed)
- The overlay contains:
  - Heading: "Connect your accounts to continue"
  - Subheading: "This agent needs access to the following services before it can help you."
  - Vertical list of connector rows, each with:
    - Connector icon (resolved from `connector` name via a static icon map)
    - Connector display name
    - Expandable scope list (collapsed by default): "Read and send emails, Manage drafts"
    - Status indicator:
      - Pending: amber dot + "Authorize" button
      - Authorized: green checkmark + "Connected"
      - Denied: red X + "Retry" button
  - Footer: "Start Chat" button (disabled until all preflight connectors are authorized)
  - "Cancel" link that closes the session

**OAuth popup flow:**

1. User clicks "Authorize" for a connector
2. Client calls `POST /api/projects/:pid/auth-profiles/oauth/user-consent` with `{ connectorName, sessionId }`
3. Server returns `{ authUrl, state }`
4. Client opens `authUrl` in a popup window (reuse existing `AuthProfileOAuthDialog` component at `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`, which already manages popup lifecycle and `postMessage` callbacks)
5. **Two-step callback flow:** (a) The OAuth provider redirects the popup to the auth-profile callback page (`apps/studio/src/app/oauth/auth-profile-callback/page.tsx`). (b) The callback page extracts the authorization code from the URL and calls the runtime API (`POST /api/projects/:pid/auth-profiles/oauth/callback`) to exchange it for tokens. (c) The callback page posts an `auth-profile-oauth-callback` message to the opener via `postMessage`. GAP-3.3 Tasks 7-8 implement the runtime API side; the existing auth-profile callback page is the client-side coordinator. **Note:** `connection-callback/page.tsx` is for connector connection OAuth flows, NOT auth profile consent flows — do not reuse it.
6. On callback, the popup page posts `{ type: 'AUTH_PROFILE_CONSENT_COMPLETE', connector, state, success }` via `window.opener.postMessage(data, expectedOrigin)` — **MUST specify target origin, never use `'*'`**
7. The `AuthPreflightGate` component listens for this message, **validates `event.origin` against the expected platform origin**, and updates the connector row to "Connected"
8. Client calls `POST /api/runtime/sessions/:sessionId/consent` (the canonical satisfaction endpoint, shared with GAP-3.2)
9. Runtime re-checks all preflight requirements, updates `authGate.satisfiedConnectors`, checks if all satisfied
10. If all satisfied, runtime sends `auth_gate_satisfied` WS event and begins normal execution (runs `ON_START`, sends welcome message)

**Studio test panel vs deployed widget:**

- Studio test panel: The `AuthPreflightGate` renders inside `ChatPanel` as an overlay. The debug panel (Observatory) remains accessible so developers can inspect the auth gate state. Uses the developer's authenticated identity (not anonymous).
- Deployed widget (embeddable): The `AuthPreflightGate` renders as a full-height card within the widget iframe. Same connector list UI, same popup OAuth flow. The widget SDK exposes a `onAuthRequired` callback so host pages can customize behavior.

**WebSocket event names** (unified across all consent plans — add to `apps/runtime/src/websocket/events.ts`):

Server messages:

- `auth_required` — sent after `load_agent` when preflight is needed (includes full auth gate payload)
- `auth_gate_updated` — sent when a connector is authorized (updated pending/satisfied lists)
- `auth_gate_satisfied` — sent when all preflight connectors are authorized, session proceeds
- `auth_gate_timeout` — sent when the auth gate expires
- `inline_consent_required` — sent mid-conversation when a tool needs inline consent (GAP-3.2)
- `inline_consent_satisfied` — sent when inline consent is granted and tool resumes (GAP-3.2)

Client messages:

- `auth_consent_denied` — client notifies server that user denied consent for a connector

### 5.2 Voice Channel (VXML, Twilio Voice, LiveKit, AudioCodes, KoreVG)

Voice channels cannot display OAuth consent screens. The strategy is a modality handoff to web.

**Behavior:**

1. When `checkPreflightAuth()` returns pending requirements on a voice session, the runtime generates a short authorization URL: `POST /api/projects/:pid/auth-profiles/oauth/preflight-link` returns a short-lived URL (e.g., `https://<domain>/auth/preflight/<token>`)
2. The runtime sends a voice response (IVR prompt):
   - "Before I can help you, I need you to connect your accounts. I've sent a link to your phone. Please open it and authorize the required services. I'll wait."
   - For channels that support SMS alongside voice (Twilio): send the link via SMS to the caller's phone number
   - For pure voice channels without SMS capability: **this is a deployment-time validation error**. If an agent with `per_user` + `preflight` connectors is deployed to a voice-only channel with no SMS fallback, the deployment must be blocked with: "Agent X uses per_user preflight connectors but is deployed on voice channel Y which cannot present OAuth consent. Either use shared connections or add an SMS-capable channel."
3. The session enters a polling state:
   - Every 10 seconds, check if `authGate.satisfiedConnectors` has been updated (the web preflight page calls the same satisfaction endpoint)
   - After each poll, if still pending, play a hold prompt: "Still waiting for authorization..."
   - On satisfaction: "Thank you! Your accounts are now connected. How can I help you today?"
4. Timeout: If `authGate.expiresAt` passes, play: "Authorization timed out. Please call back after connecting your accounts online." End the call.

**Implementation notes:**

- The `/auth/preflight/<token>` page is a standalone Next.js page (not inside the widget) that shows the same connector list UI as the web `AuthPreflightGate`
- The `<token>` is an **opaque token** (random UUID) stored in Redis with the session metadata mapped server-side. This avoids exposing `sessionId`, `tenantId`, `projectId` in the URL (see Security Considerations).
- The page does not require login (the opaque token IS the authentication), but it is single-use and time-limited
- This page lives at `apps/studio/src/app/auth/preflight/[token]/page.tsx`

### 5.3 WhatsApp / SMS / Telegram (Text-Based Async Channels)

Text-based channels cannot render modals or popups. Strategy: send a message with a link.

**Behavior:**

1. When `checkPreflightAuth()` returns pending requirements on a text channel session:
2. Generate the same short-lived preflight link as voice (`/auth/preflight/<token>`)
3. Send a channel-native message:

   **WhatsApp (interactive message):**

   ```
   Before I can help you, please connect your accounts:
   - Gmail (read and send emails)
   - Google Calendar (view events)

   Tap the button below to authorize:
   [Connect Accounts]  <-- WhatsApp button linking to preflight URL
   ```

   **SMS/Telegram (plain text):**

   ```
   Before I can help you, please connect your accounts.
   Open this link to authorize: https://<domain>/auth/preflight/<token>
   ```

4. Session enters `authGate.status === 'pending'`. Any user message is responded to with:
   ```
   I'm still waiting for you to connect your accounts. Please use the link I sent earlier.
   ```
5. On authorization completion (via the web preflight page), the runtime detects `authGate` satisfaction and sends the welcome message proactively:
   ```
   Your accounts are now connected! How can I help you today?
   ```
6. Timeout: after `authGate.expiresAt`, send:
   ```
   The authorization link has expired. Please send any message to start a new session.
   ```
   Then mark the session as ended.

**Channel adapter changes:**

- Create a standalone `sendAuthRequiredMessage(adapter: ChannelAdapter, ...)` function that uses `adapter.sendResponse()` with the auth-required message formatted per channel type. This avoids adding a new method to the `ChannelAdapter` interface (which is a pure interface with no default implementations).
- WhatsApp adapter: format as `whatsapp_interactive` message type with a button
- Slack adapter: format as Block Kit with a button
- MS Teams adapter: format as an Adaptive Card with an action button

### 5.4 Email Channel

Email-based agent interactions (inbound email triggers a session) can encounter preflight requirements.

**Strategy:** Send an email reply with the preflight authorization link (similar to SMS/WhatsApp text channel approach). The email contains a branded HTML template with authorization buttons linking to the standalone preflight page.

### 5.5 API / SDK Channel (Programmatic Access)

API and SDK channels serve developers integrating the agent programmatically. They need a machine-readable response.

**Behavior:**

1. `POST /api/v1/chat/agent` (REST) or `load_agent` (SDK WebSocket): when preflight is required, the response includes `authRequired: true` and the full auth gate payload:

   ```json
   {
     "type": "auth_required",
     "sessionId": "sess-abc",
     "authGate": {
       "status": "pending",
       "requirements": [
         {
           "connector": "gmail",
           "displayName": "Gmail",
           "scopes": ["gmail.send", "gmail.compose"],
           "authorizationUrl": "https://accounts.google.com/o/oauth2/auth?client_id=...&redirect_uri=...&scope=...&state=...",
           "state": "oauth-state-xyz"
         }
       ],
       "satisfied": []
     }
   }
   ```

2. The SDK/API consumer is responsible for:
   - Presenting their own consent UI (or redirecting the user)
   - Completing the OAuth flow (the `authorizationUrl` already includes the correct `redirect_uri` and `state`)
   - Calling `POST /api/projects/:pid/auth-profiles/oauth/callback` with the authorization code
   - Then calling `POST /api/runtime/sessions/:sessionId/consent` to resume

3. SDK helper (optional convenience):
   - The JavaScript SDK (`packages/sdk/`) could expose `session.waitForAuth()` which returns a Promise that resolves when all connectors are satisfied
   - The SDK opens a popup or iframe for each `authorizationUrl` and handles the callback automatically

4. If the API consumer sends a message while `authGate` is pending, the response is:
   ```json
   {
     "error": {
       "code": "SESSION_AWAITING_AUTH",
       "message": "Complete required authorizations before sending messages.",
       "authGate": { "..." }
     }
   }
   ```

### 5.6 A2A (Agent-to-Agent Protocol)

A2A sessions are machine-to-machine. Preflight consent does not apply because A2A uses `shared` connections (the calling agent's credentials). If an A2A session encounters a `per_user` requirement, this is a misconfiguration.

**Behavior:**

- If `checkPreflightAuth()` finds pending `per_user` requirements on an A2A session, return an error: `{ code: 'A2A_AUTH_NOT_SUPPORTED', message: 'A2A sessions cannot handle per_user authentication. Configure shared connections for agent-to-agent calls.' }`
- This error MUST be caught at deployment validation time (Section 12 of the design), not at runtime. Deployment validation must **error** (not warn) if any agent reachable via A2A has `per_user` + `preflight` requirements without a `shared` fallback.

---

## 6. OAuth Callback and Session Resume

### 6.1 Callback Flow

The canonical satisfaction endpoint is:

`POST /api/runtime/sessions/:sessionId/consent`

This is shared with GAP-3.2. The handler:

1. Validates the session exists and `session.blocked === true`
2. Re-checks all preflight requirements via GAP-3.3's `ConsentStateResolver`
3. If all preflight requirements are now satisfied:
   - Sets `authGate.status = 'satisfied'`
   - Sets `session.blocked = false`
   - Triggers `initializeSession` (runs `ON_START`, sends welcome message)
4. Returns the updated auth gate state
5. Publishes a Redis event: `auth_gate:${sessionId}:updated`

The OAuth callback (`POST /api/projects/:pid/auth-profiles/oauth/callback`) creates the `oauth2_token` and then the client calls the satisfaction endpoint above.

### 6.2 Cross-Pod Session Resume

Sessions may be created on one pod and the OAuth callback may hit a different pod. The session store (Redis) is shared, but the WebSocket connection is pod-local.

Strategy:

- Use Redis pub/sub for cross-pod delivery (this is **new infrastructure** — no existing Redis pub/sub exists for auth gate coordination)
- Channel: `auth_gate:${sessionId}`
- The pod holding the WebSocket connection subscribes when `authGate` is set
- The pod processing the consent satisfaction publishes the update
- The subscribing pod receives it and sends the WS message to the client

**Failure mode — Redis pub/sub drop:**

If the Redis pub/sub connection drops mid-session (e.g., Redis restart, network partition), the subscribing pod will never receive the auth gate update. To prevent users from appearing stuck:

1. **Primary delivery:** The satisfaction endpoint should first attempt a direct WebSocket send via the session's `socketId` (stored in Redis session data). If the satisfaction request lands on the same pod as the WebSocket connection, this succeeds without pub/sub.
2. **Secondary delivery:** If the direct send fails (wrong pod), publish via Redis pub/sub.
3. **Belt-and-suspenders polling:** The standalone preflight page and batch consent UI (GAP-3.4) already poll `GET /api/auth/preflight/:token/status` as a fallback. The web chat `AuthPreflightGate` component should also poll the status endpoint every 10 seconds as a fallback when no `auth_gate_updated` WS event is received within 15 seconds of a consent completion.
4. **Resubscription:** The WebSocket handler should resubscribe to the auth gate channel on Redis reconnection (using the Redis client's `reconnectStrategy` callback).

### 6.3 Standalone Preflight Page Callback

For voice/WhatsApp/SMS channels, the OAuth callback returns to the standalone `/auth/preflight/<token>` page. This page:

1. Receives the OAuth callback in its popup
2. Updates the connector status in its local UI state
3. The popup calls `POST /api/projects/:pid/auth-profiles/oauth/callback` (same endpoint)
4. Then calls `POST /api/runtime/sessions/:sessionId/consent` (satisfaction endpoint)
5. The async channel worker detects satisfaction and sends a proactive message to the channel

---

## 7. Error Handling

### 7.1 Timeout

**Configuration:**

```typescript
AUTH_PREFLIGHT_TIMEOUT_MS = env.AUTH_PREFLIGHT_TIMEOUT_MS ?? 600_000; // 10 minutes
```

**Behavior:**

- `authGate.expiresAt` is set to `Date.now() + AUTH_PREFLIGHT_TIMEOUT_MS` at gate creation
- A delayed job (BullMQ or setTimeout on the WebSocket handler) fires at `expiresAt`
- On timeout:
  - Set `authGate.status = 'timed_out'`
  - Web: show "Authorization timed out. Start a new chat to try again." in the overlay
  - Voice: play timeout prompt, end call
  - Text channels: send timeout message, end session
  - API/SDK: return `{ error: { code: 'AUTH_GATE_TIMEOUT' } }` on next interaction

**Cleanup:** The session cleanup job (`apps/runtime/src/services/session-cleanup-job.ts`) should also catch orphaned `authGate.status === 'pending'` sessions past their `expiresAt`.

### 7.2 Partial Authorization

**Rule:** ALL `consent: preflight` connectors MUST be authorized before the session starts. There is no "degraded mode" for preflight.

**Rationale:** The DSL author explicitly marked these as `preflight` precisely because the agent cannot function without them. If any are denied, the session cannot start.

**Behavior when user denies one connector:**

- Mark that connector in `authGate.deniedConnectors`
- Web: show the connector as "Denied" with a "Retry" button. The "Start Chat" button remains disabled. Show helper text: "This agent requires all listed connections to function."
- If the user clicks "Retry", re-initiate the OAuth flow for that connector
- If the user clicks "Cancel", end the session

### 7.3 Token Revoked Mid-Session

After the session starts (authGate satisfied), a user's token may be revoked externally (e.g., user revokes Gmail access in Google Account settings).

**Detection:** When the runtime executes a tool that uses a `per_user` token and receives a 401/403:

1. The tool execution retry logic (existing) attempts token refresh
2. If refresh also fails (refresh token revoked), mark the `oauth2_token` profile as `status: 'revoked'`
3. The tool returns a structured error result to the LLM: `{ error: "CONSENT_REQUIRED", message: "User needs to re-authorize Gmail", connector: "gmail" }`. The LLM naturally responds by informing the user they need to re-authorize.
4. On the next user turn, if the user re-authorizes, the new token is stored and the tool becomes available again

**Important:** Mid-session revocation does NOT re-enter the preflight gate. It uses the inline consent mechanism (GAP-3.2). The preflight gate only applies at session start.

### 7.4 OAuth Provider Errors

| Error                        | Handling                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User denies consent in popup | Popup posts `{ success: false, error: 'access_denied' }`. Gate shows "Denied" with retry.                                                                                                              |
| Provider unreachable         | `/oauth/user-consent` returns 502. Client shows "Unable to reach [Provider]. Please try again." with retry button.                                                                                     |
| Invalid redirect URI         | Callback page shows: "Configuration error: redirect URI mismatch. Contact your administrator."                                                                                                         |
| Popup blocked by browser     | Client detects `window.open()` returning null. Falls back to: "Popup was blocked. Click here to authorize in a new tab." (full-page redirect with `redirect_uri` pointing to a page that auto-closes). |
| State mismatch (CSRF)        | Callback rejects. Show: "Authorization failed (security check). Please try again."                                                                                                                     |

### 7.5 Concurrent Sessions

A user may have multiple sessions (e.g., two browser tabs). Each session has its own `authGate`, but they share the same `oauth2_token` profiles in MongoDB.

**Behavior:**

- When user authorizes Gmail in session A, the token is stored as a personal `oauth2_token` profile
- Session B's preflight check (at session start) will find the token and skip preflight
- If Session B is already in the gate and the user authorizes in Session A, Session B can poll the satisfaction endpoint or the standalone preflight page can re-check — the token exists in the store
- **No cross-session wildcard pub/sub needed** — this is simpler and avoids unnecessary infrastructure. The token store is the source of truth.

### 7.6 Stale Session in Preflight Token

For voice/text channels, the standalone preflight page token contains a `sessionId`. If the voice session's Redis TTL expires before the user completes authorization:

- The preflight page checks session existence on load and on each OAuth completion
- If the session has expired, show a message: "Your session has expired. Please call back to start a new session."

### 7.7 Handoff During Preflight Gate

When a handoff targets an agent with additional preflight requirements (see GAP-3.2 Section 5.3):

- The consent message should include context: "To continue, [Agent Name] needs access to the following services."
- The UX should make it clear that this is a transition, not a malfunction.

---

## 8. New Files and Modified Files

### 8.1 New Files

| File                                                    | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/shared/src/types/auth-consent.ts`             | Canonical consent types shared by all GAP-3.x plans         |
| `apps/runtime/src/services/auth/preflight-check.ts`     | `checkPreflightAuth()` function                             |
| `apps/runtime/src/services/auth/auth-gate-manager.ts`   | `updateAuthGate()`, timeout handling, pub/sub               |
| `apps/studio/src/components/chat/AuthPreflightGate.tsx` | Blocking consent overlay for web chat                       |
| `apps/studio/src/app/auth/preflight/[token]/page.tsx`   | Standalone preflight consent page (for voice/text channels) |
| `apps/studio/src/app/auth/preflight/[token]/layout.tsx` | Minimal layout for standalone page (no sidebar)             |

### 8.2 Modified Files

| File                                                     | Change                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/types.ts`             | Add `authGate`, `blocked`, `pendingInlineConsent` fields to `SessionData`                                                                                                                           |
| `apps/runtime/src/websocket/events.ts`                   | Add unified WS events: `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `auth_gate_timeout`, `inline_consent_required`, `inline_consent_satisfied` server; `auth_consent_denied` client |
| `apps/runtime/src/websocket/handler.ts`                  | Call `checkPreflightAuth()` after agent load; subscribe to auth gate pub/sub                                                                                                                        |
| `apps/runtime/src/websocket/sdk-handler.ts`              | Same changes as `handler.ts` for SDK WebSocket path                                                                                                                                                 |
| `apps/runtime/src/channels/session-resolver.ts`          | Call `checkPreflightAuth()` after session creation for async channels                                                                                                                               |
| `apps/runtime/src/services/session/session-bootstrap.ts` | Export preflight check integration point                                                                                                                                                            |
| `apps/runtime/src/routes/chat.ts`                        | Add auth gate check for REST chat endpoint                                                                                                                                                          |
| `apps/studio/src/components/chat/ChatPanel.tsx`          | Render `AuthPreflightGate` overlay when session has pending auth gate                                                                                                                               |
| `apps/studio/src/store/session-store.ts`                 | Add `authGate` state field, handlers for auth gate WS messages                                                                                                                                      |
| `apps/studio/src/contexts/WebSocketContext.tsx`          | Handle new auth gate message types                                                                                                                                                                  |
| `apps/runtime/src/services/session-cleanup-job.ts`       | Clean up expired auth gate sessions                                                                                                                                                                 |

---

## 9. API Endpoints

### 9.1 Existing Endpoints (Extended)

**`POST /api/projects/:pid/auth-profiles/oauth/user-consent`**

Already defined in the design (Section 8). Extended to include `sessionId` in the OAuth `state` parameter so the callback can correlate to the session's auth gate.

Request body:

```json
{
  "connectorName": "gmail",
  "sessionId": "sess-abc"
}
```

Response:

```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/auth?...",
  "state": "encrypted-state-with-session-id"
}
```

**Rate limiting:** 10 requests per minute per session, 50 per minute per IP.

### 9.2 New Endpoints

**`POST /api/runtime/sessions/:sessionId/consent`**

Canonical consent satisfaction endpoint (shared with GAP-3.2). Called by the client after each successful OAuth callback. The handler:

1. Validates the session exists and `session.blocked === true`
2. Verifies caller owns the session (same `contactId` + `tenantId`)
3. Re-checks all preflight requirements via `ConsentStateResolver`
4. If all satisfied, sets `session.blocked = false`, triggers `initializeSession`
5. Returns the updated auth gate state

**Rate limiting:** 5 requests per minute per session.

**`POST /api/projects/:pid/auth-profiles/oauth/preflight-link`**

Generates a short-lived standalone preflight page URL for non-web channels.

Request body:

```json
{
  "sessionId": "sess-abc",
  "channelType": "whatsapp"
}
```

Response:

```json
{
  "preflightUrl": "https://app.example.com/auth/preflight/<opaque-token>",
  "expiresAt": "2026-03-13T10:10:00Z"
}
```

**Rate limiting:** 3 requests per minute per session.

**`GET /api/auth/preflight/:token/status`**

Polled by the standalone preflight page to get current gate status.

Response:

```json
{
  "status": "pending",
  "requirements": ["..."],
  "satisfied": ["google-calendar"],
  "pending": ["gmail"]
}
```

**Rate limiting:** 20 requests per minute per token.

---

## 10. Security Considerations

### 10.1 Preflight Token Security

- The `<token>` in `/auth/preflight/<token>` is an **opaque token** (random UUID) stored in Redis with session metadata mapped server-side
- Redis key: `preflight_token:{token}` → `{ sessionId, tenantId, projectId, contactId, expiresAt }`
- TTL matches `authGate.expiresAt`
- The token reveals nothing about the session if intercepted (unlike a JWT which would expose `sessionId`, `tenantId`, etc.)
- The standalone page does NOT require login (the opaque token IS the auth), but it is rate-limited

### 10.2 OAuth State Parameter

- The `state` parameter MUST include: `sessionId`, `connector`, `nonce` (crypto random), `exp` (expiration)
- The state is **encrypted** (AES-256-GCM) with the platform encryption key, not just HMAC-signed — this is critical since it contains `sessionId`
- On callback, the state is decrypted and validated: nonce uniqueness (Redis SETEX with TTL matching `AUTH_TOKEN_OAUTH_STATE_TTL_SECONDS`), expiration, session existence
- Nonce entries use `SETEX` (not bare `SET NX`) with TTL of 10 minutes to prevent Redis memory leaks from abandoned OAuth flows

### 10.3 postMessage Origin Validation

- The `AuthPreflightGate` component MUST validate `event.origin` against the expected platform origin when receiving `AUTH_PROFILE_CONSENT_COMPLETE` messages
- The `postMessage` call in the popup MUST specify the target origin: `window.opener.postMessage(data, expectedOrigin)` — never use `'*'`

### 10.4 SSRF Prevention

- All URL fields in auth profile configs (`authorizationUrl`, `tokenUrl`, `refreshUrl`, `revocationUrl`) must be validated against an SSRF allow-list at profile creation time
- The preflight page does not make any server-side requests to user-controlled URLs

### 10.5 Channel-Specific Risks

| Channel  | Risk                                              | Mitigation                                                                                                   |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| WhatsApp | Preflight link could be forwarded to another user | Link is bound to the session's contact identity via the opaque token; the standalone page verifies ownership |
| Voice    | Short URL could be overheard                      | Use time-limited tokens (5 min for voice); URL is useless after expiry                                       |
| API/SDK  | `authorizationUrl` exposed to API consumer        | This is intentional; the consumer needs it to complete OAuth. The URL is provider's standard OAuth endpoint. |

### 10.6 Third-Party Cookie Fallback

OAuth popups rely on cookies for the OAuth provider's authentication flow. Modern browsers (Safari, Firefox with ETP) may block third-party cookies. If the OAuth provider's consent page cannot maintain a session:

- Fallback: if popup-based OAuth fails, offer a redirect-based flow where the entire page navigates to the OAuth provider and returns via redirect URI
- GAP-3.4 Section 8.2 implements this for mobile; this plan references it for desktop browsers with strict cookie policies

---

## 11. Telemetry and Observability

### 11.1 Trace Events

Add to `TraceStore` event types:

| Event                            | When                                        | Data                                  |
| -------------------------------- | ------------------------------------------- | ------------------------------------- |
| `auth_gate_created`              | Preflight check finds pending requirements  | `{ connectors, channelType }`         |
| `auth_gate_connector_authorized` | User completes OAuth for one connector      | `{ connector, durationMs }`           |
| `auth_gate_satisfied`            | All connectors authorized, session proceeds | `{ totalDurationMs, connectorCount }` |
| `auth_gate_timeout`              | Gate expires before satisfaction            | `{ pendingConnectors, elapsedMs }`    |
| `auth_gate_denied`               | User explicitly denies a connector          | `{ connector, channelType }`          |

### 11.2 Metrics

| Metric                             | Type      | Labels                                                         |
| ---------------------------------- | --------- | -------------------------------------------------------------- |
| `auth_gate_sessions_total`         | Counter   | `status=created\|satisfied\|timed_out\|denied`, `channel_type` |
| `auth_gate_duration_seconds`       | Histogram | `status`, `channel_type`                                       |
| `auth_gate_connectors_per_session` | Histogram | `channel_type`                                                 |

---

## 12. Deployment Validation

At deploy time (when creating a deployment via Studio), the following must be **errors** (not warnings):

1. **Missing OAuth app:** If a preflight connector has no matching `oauth2_app` Auth Profile in the project, block deployment: "No OAuth app configured for {connector}. Users will not be able to authorize."
2. **Voice-only without SMS:** If a `per_user` + `preflight` agent is deployed to a voice-only channel with no SMS fallback, block deployment: "Agent X uses per_user preflight connectors but is deployed on voice channel Y which cannot present OAuth consent."
3. **A2A without shared fallback:** If any agent reachable via A2A has `per_user` + `preflight` requirements without a `shared` fallback, block deployment.

---

## 13. Testing Strategy

### 13.1 Unit Tests

| Test                                                              | File                        |
| ----------------------------------------------------------------- | --------------------------- |
| `checkPreflightAuth` returns empty when no preflight requirements | `preflight-check.test.ts`   |
| `checkPreflightAuth` correctly partitions pending/satisfied       | `preflight-check.test.ts`   |
| `checkPreflightAuth` uses callerContext (not raw userId)          | `preflight-check.test.ts`   |
| `updateAuthGate` transitions status correctly                     | `auth-gate-manager.test.ts` |
| `authGate` timeout fires and updates session                      | `auth-gate-manager.test.ts` |
| Message rejection while gate is pending                           | `handler.test.ts`           |
| Partial auth does not satisfy gate                                | `auth-gate-manager.test.ts` |

### 13.2 Integration Tests

| Test                                                                            | Scope                             |
| ------------------------------------------------------------------------------- | --------------------------------- |
| WebSocket `load_agent` with preflight requirements returns `auth_required`      | WS handler + preflight check      |
| Consent satisfaction endpoint updates auth gate and sends `auth_gate_satisfied` | Consent route + gate manager + WS |
| REST chat endpoint returns `SESSION_AWAITING_AUTH` when gate is pending         | REST route + gate manager         |
| Cross-pod auth gate update via Redis pub/sub                                    | Gate manager + Redis              |
| Standalone preflight page opaque token validation and status polling            | Preflight page API                |
| Session cleanup removes expired auth gate sessions                              | Cleanup job                       |

### 13.3 E2E Tests

| Test                                                                                | Channels                |
| ----------------------------------------------------------------------------------- | ----------------------- |
| Full OAuth preflight flow: load agent, see gate, authorize in popup, session starts | Web (Studio test panel) |
| Multi-connector preflight: authorize two connectors sequentially                    | Web                     |
| Timeout: wait for gate to expire, verify timeout message                            | Web                     |
| Deny consent: deny in popup, verify denied state and retry                          | Web                     |

---

## 14. Implementation Order

> **Sprint sequencing (unified across all GAP-3.x plans):**
> Sprint N = GAP-3.2 Phase 1 (compiler IR only)
> Sprint N+1 = GAP-3.1 Core Runtime + GAP-3.2 Phase 2 (unified runtime consent)
> Sprint N+2 = GAP-3.1 Web UI + GAP-3.4 (Batch Consent UI)
> Sprint N+3 = GAP-3.3 (Consent Persistence) + GAP-3.1 Channels + GAP-3.2 Phase 3 (inline consent)

### Sprint N+1: Core Runtime (3-4 days)

1. Define shared types (`packages/shared/src/types/auth-consent.ts`)
2. Add `authGate`, `blocked`, `pendingInlineConsent` to `SessionData` in session types
3. Implement `checkPreflightAuth()` in `preflight-check.ts`
4. Implement `AuthGateManager` with `updateAuthGate()`, timeout, pub/sub
5. Add `POST /api/runtime/sessions/:sessionId/consent` endpoint
6. Integrate into WebSocket `load_agent` handler
7. Add new WS message types to `events.ts`
8. Unit tests for preflight check and gate manager

### Sprint N+2: Web UI (3-4 days)

1. Build `AuthPreflightGate` component
2. Integrate into `ChatPanel` with session store
3. Handle OAuth popup flow (reuse existing popup pattern, add origin validation)
4. Handle WS message types for gate updates
5. Build standalone `/auth/preflight/[token]` page
6. Ensure Studio test panel sets `callerContext.contactId` to the developer's user ID when creating test sessions, so preflight token lookups use the developer's identity instead of anonymous
7. Integration tests for WS auth flow

### Sprint N+3: Channel Adapters (2-3 days)

1. Implement `sendAuthRequiredMessage()` standalone function
2. Implement WhatsApp adapter format (interactive button)
3. Implement Slack adapter format (Block Kit button)
4. Implement voice channel handling (IVR prompt + SMS link)
5. Implement SMS/Telegram plain text with link
6. Implement email channel HTML template with link
7. Integrate preflight check into async channel session resolver

### Sprint N+3 (continued): API/SDK + Hardening (2-3 days)

1. Extend REST chat endpoint with auth gate response
2. Extend SDK handler with auth gate
3. Add A2A and voice-only deploy-time validation
4. Implement session cleanup for expired gates
5. Add telemetry (trace events + metrics)
6. Add rate limiting to all new endpoints
7. E2E tests
8. Security review of preflight token and OAuth state

---

## 15. Configuration

| Environment Variable                    | Default           | Description                                                                 |
| --------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `AUTH_PREFLIGHT_TIMEOUT_MS`             | `600000` (10 min) | Maximum time to wait for user to complete all authorizations                |
| `AUTH_PREFLIGHT_VOICE_POLL_INTERVAL_MS` | `10000` (10 sec)  | How often voice channels check if auth is satisfied                         |
| `AUTH_PREFLIGHT_LINK_TTL_MS`            | `600000` (10 min) | TTL for standalone preflight page tokens                                    |
| `AUTH_PREFLIGHT_MAX_RETRIES`            | `3`               | Max OAuth retry attempts per connector before marking as permanently denied |

---

## 16. Existing Schema Acknowledgment

The following fields and types already exist in the codebase and do NOT need to be created:

- `CallerContext` with `identityTier`, `channelArtifact`, `contactId` — in `packages/shared-auth/src/types/index.ts`
- `EndUserOAuthToken` model with encryption plugin — in `packages/database/src/models/end-user-oauth-token.model.ts`
- `AuthProfile` model with enterprise types (`digest`, `kerberos`, `saml`, `hawk`, `ws_security`) already in the enum — in `packages/database/src/models/auth-profile.model.ts`
- `resolveWithGracePeriod` — in `packages/shared/src/services/auth-profile/grace-period.ts`

---

## 17. Open Questions

1. **"Connect All" button:** Should the web UI offer a "Connect All" button that initiates OAuth flows sequentially for each pending connector? This improves UX for 3+ connectors but adds complexity (sequential popup management). Recommendation: defer to Sprint N+2 based on user feedback. GAP-3.4 covers this in detail.

2. **Remembered consent:** If a user authorizes Gmail in one session and starts a new session later with the same agent, should the preflight be skipped entirely (token exists) or should we still show a brief "Connecting..." indicator? Recommendation: skip entirely if valid tokens exist (the check already handles this in step 3 of Section 4.2).

3. **Scope upgrades:** If the agent's required scopes change between deployments (e.g., adds `gmail.delete`), should existing tokens with fewer scopes trigger a re-consent? Recommendation: yes, treat scope mismatch as "pending" and re-initiate OAuth with the expanded scope set. This requires comparing `grantedScopes` on the existing token against `scopes` in the requirement.

4. **Anonymous users:** Tier 0 (anonymous) users have no persistent identity. Tokens are session-scoped — the preflight will always appear. In Studio test panel specifically, use the developer's authenticated identity instead of anonymous.

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Unified consent state model (single `AuthGate` on `SessionData`), fixed identity model to use GAP-3.3's 3-tier `contactId` (not raw `userId`), corrected compiler claim (GAP-3.2 Phase 1 is a prerequisite — compiler does NOT already propagate auth requirements), fixed inline consent to use tool error result pattern (not mid-turn suspension), corrected file paths (`SessionData` in `session/types.ts`, `ConnectorToolExecutor` in `packages/connectors/src/executor/connector-tool-executor.ts`), added cross-plan dependencies section, added security hardening (rate limiting, `postMessage` origin validation, opaque preflight tokens instead of JWTs, SSRF guards, nonce TTLs), unified WS event names across all plans, sequenced sprints (GAP-3.2 compiler first), added email channel, added deployment-time validation errors, added existing schema acknowledgment, removed cross-session wildcard pub/sub (over-engineering), added standalone function instead of ChannelAdapter interface method.
- **Pass 4 (2026-03-13)**: Applied 20 findings from Pass 3 auditors. Added Redis pub/sub failure mode with fallback (direct WS send as primary, pub/sub as secondary, polling as belt-and-suspenders, resubscription on reconnect), clarified OAuth callback two-step flow (Studio page receives redirect, calls runtime API, posts result via postMessage), added Studio test panel identity handling task to Sprint N+2.
- **Pass 6 (2026-03-13)**: Fixed P5-2 — corrected OAuth callback page reference from `connection-callback/page.tsx` to `auth-profile-callback/page.tsx`. Fixed P5-3 — added type transformation note for `ConsentStateResolver.resolve()` → `checkPreflightAuth` return type mapping, corrected method name from `checkToken()` to `resolve()`.
