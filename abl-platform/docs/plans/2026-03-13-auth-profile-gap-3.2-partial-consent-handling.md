# GAP-3.2: Partial Consent Handling — Preflight vs Inline

> **Status:** Implementation Plan
> **Date:** 2026-03-13
> **Depends on:** Auth Profile Phase 1-2 (merged), Section 6 of `docs/plans/2026-03-11-auth-profile-design.md`
> **Resolves:** GAP-3.2 from UX review (`docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md`)

---

## Dependencies

This plan depends on the following:

- **Auth Profile Phase 1-2** — Must be merged and stable.

Plans that depend on this plan:

- **GAP-3.1 (Preflight Consent Modal)** — Depends on Phase 1 (Compiler IR) of this plan. GAP-3.1's runtime `checkPreflightAuth()` reads `preflight_auth_requirements` from `CompilationOutput`, which this plan creates.
- **GAP-3.3 (Consent Persistence)** — Uses the `AuthConsentRequirement` types defined here.
- **GAP-3.4 (Batch Consent UI)** — Consumes the auth gate WS events and consent state defined here.

**Implementation sequence:**

1. **This plan Phase 1** (Compiler IR) — Sprint N
2. **GAP-3.1 + This plan Phase 2** (Runtime consent) — Sprint N+1
3. **GAP-3.4** (UI) — Sprint N+2
4. **GAP-3.3 + This plan Phase 3** (Persistence + inline consent) — Sprint N+3

---

## Problem Statement

The auth profile design (Section 6) defines two consent modes for `per_user` connectors:

- **Preflight** — user must authorize BEFORE the session starts; blocks `initializeSession`
- **Inline** — user authorizes mid-conversation when the tool is first invoked

Currently, the codebase has **no implementation** of this distinction:

1. The compiler IR (`AgentIR`, `ToolDefinition`, `ConnectorBindingIR`) has no `consent` or `connectionMode` fields — verified: zero `auth_requirements`, `consent`, `connection_mode`, or `per_user` references exist anywhere in the compiler source
2. The runtime (`createSessionFromResolved`, `initializeSession`) performs no preflight consent check
3. The `auth-profile-handoff.ts` module checks `per_user` requirements but does not distinguish preflight from inline
4. The `ConnectorToolExecutor` (`packages/connectors/src/executor/connector-tool-executor.ts`) resolves credentials at execution time but has no concept of "pause, request consent, resume"
5. No session-level consent state tracking exists

This plan covers the full vertical slice: DSL syntax, compiler IR, runtime resolution, session store, UI states, and edge cases.

---

## 1. DSL Syntax

### 1.1 Tool-Level Consent Declaration

The design doc (Section 6) already specifies the syntax. This plan adopts it as-is:

```yaml
AGENT: email-assistant
TOOLS:
  - gmail.send_email:
      connection: per_user
      consent: preflight
  - google-calendar.list_events:
      connection: per_user
      consent: inline
  - slack.post_message:
      connection: shared
```

### 1.2 Parsing Rules

| `connection` | `consent`   | Behavior                                 |
| ------------ | ----------- | ---------------------------------------- |
| `per_user`   | `preflight` | Blocks session start until authorized    |
| `per_user`   | `inline`    | Prompts mid-conversation on first invoke |
| `per_user`   | (omitted)   | Defaults to `preflight`                  |
| `shared`     | (any)       | Ignored — developer's token, no consent  |
| (omitted)    | (any)       | Defaults to `shared`, consent ignored    |

**Default rationale:** `per_user` without explicit consent defaults to `preflight` because it is the safest option — the user is never surprised by a mid-conversation OAuth popup.

### 1.3 Connector-Level Defaults

Connectors can declare a default consent mode in their definition:

```yaml
TOOLS:
  - gmail.*:
      connection: per_user
      consent: preflight
```

The wildcard applies the same `connection` and `consent` to all actions from that connector, unless overridden per-action.

### 1.4 Parser Changes

**File:** `packages/compiler/src/platform/ir/compiler.ts` (and AST types in `packages/core`)

Add two optional fields to the tool AST node:

```typescript
interface ToolASTNode {
  // ... existing fields
  connection?: 'per_user' | 'shared';
  consent?: 'preflight' | 'inline';
}
```

Parser must validate:

- `consent` is only valid when `connection: per_user`
- `consent` value is one of `'preflight' | 'inline'`
- Emit a warning if `consent` is set with `connection: shared` (ignored, not an error)

---

## 2. Compiler IR Changes

### 2.1 ToolDefinition Extension

**File:** `packages/compiler/src/platform/ir/schema.ts`

Add new optional fields to `ToolDefinition`:

```typescript
export interface ToolDefinition {
  // ... existing fields (name, description, parameters, etc.)

  /** Connection mode for this tool — determines credential resolution strategy */
  connection_mode?: 'per_user' | 'shared';

  /** Consent timing for per_user tools — when the user is prompted to authorize */
  consent_mode?: 'preflight' | 'inline';
}
```

### 2.2 ConnectorBindingIR Extension

**File:** `packages/compiler/src/platform/ir/schema.ts`

Extend `ConnectorBindingIR` with auth context:

```typescript
export interface ConnectorBindingIR {
  connector: string;
  action: string;
  /** Connection mode — 'per_user' requires user token, 'shared' uses developer token */
  connection_mode?: 'per_user' | 'shared';
  /** Consent mode — only meaningful when connection_mode is 'per_user' */
  consent_mode?: 'preflight' | 'inline';
  /** OAuth scopes required by this action (from connector catalog or DSL override) */
  scopes?: string[];
}
```

### 2.3 AgentIR Auth Requirements Manifest

**File:** `packages/compiler/src/platform/ir/schema.ts`

Add a new top-level field to `AgentIR`:

```typescript
export interface AgentIR {
  // ... existing fields

  /** Auth requirements collected from all tools in this agent (and its children) */
  auth_requirements?: AuthRequirementIR[];
}

export interface AuthRequirementIR {
  /** Connector name (e.g., 'gmail', 'slack') */
  connector: string;
  /** Auth type expected (e.g., 'oauth2_token') */
  auth_type: string;
  /** Connection mode */
  connection_mode: 'per_user' | 'shared';
  /** Consent timing */
  consent_mode: 'preflight' | 'inline';
  /** Union of all scopes needed across all tools using this connector */
  scopes: string[];
  /** Auth profile ID resolved at compile/deploy time (from project config) */
  auth_profile_id?: string;
  /** Auth profile name for audit trail */
  auth_profile_name?: string;
  /** Which tools in this agent need this requirement */
  tool_names: string[];
}
```

### 2.4 CompilationOutput Extension

**File:** `packages/compiler/src/platform/ir/schema.ts`

Add a project-level manifest to `CompilationOutput`:

```typescript
export interface CompilationOutput {
  // ... existing fields

  /** Project-wide preflight auth requirements (deduplicated across all agents) */
  preflight_auth_requirements?: AuthRequirementIR[];
}
```

This is the union of all `auth_requirements` with `consent_mode: 'preflight'` across all agents in the compilation, deduplicated by `connector + scopes`. The runtime reads this at session creation time.

### 2.5 Compiler Propagation Logic

**New file:** `packages/compiler/src/platform/ir/auth-requirement-collector.ts`

The collector performs a post-compilation pass:

1. Walk every agent's `tools[]` array
2. For each tool with `connection_mode: 'per_user'`, create an `AuthRequirementIR` entry
3. For connector tools, resolve scopes from the connector catalog (or DSL override)
4. For agents that reference other agents (via `coordination.handoffs`, `coordination.delegates`), recursively collect child requirements
5. Deduplicate by `connector` — union scopes, keep the stricter consent mode (preflight > inline)
6. Store per-agent in `agent.auth_requirements` and project-wide in `compilation_output.preflight_auth_requirements`

**Deduplication rule:** If the same connector appears with both `preflight` and `inline` consent across different tools, the merged requirement uses `preflight` (the stricter mode wins).

**Cycle detection:** Use a visited set to prevent infinite recursion in agent dependency graphs.

---

## 3. Runtime Resolution

### 3.1 Unified Consent State Model

> **Cross-plan agreement:** This plan uses the canonical consent state model defined in GAP-3.1 Section 3.1 (`packages/shared/src/types/auth-consent.ts`). The `AuthGate` lives on `SessionData` (serializable, survives pod restarts). `RuntimeSession` hydrates from `SessionData`.

All consent state fields are on `SessionData` in `apps/runtime/src/services/session/types.ts`:

```typescript
/** Auth consent gate — present only when per_user preflight connectors exist */
authGate?: AuthGate;
/** Whether the session is blocked waiting for preflight consent */
blocked?: boolean;
/** If an inline consent is pending, which tool invocation is waiting */
pendingInlineConsent?: PendingInlineConsent;
```

**Note:** Previous versions of this plan proposed separate `_consentState`, `_blocked`, and `_pendingInlineConsent` fields on `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`. This has been unified — all state lives on `SessionData` for serialization consistency.

### 3.2 Session Creation — Preflight Check

**File:** `apps/runtime/src/services/runtime-executor.ts`

After `createSessionFromResolved()` builds the session but before returning it to the caller, inject a preflight check:

```typescript
// In createSessionFromResolved(), after session object is built:
const preflightRequirements = resolved.compilationOutput?.preflight_auth_requirements ?? [];

if (preflightRequirements.length > 0) {
  const checkResult = await checkPreflightAuth({
    compilationOutput: resolved.compilationOutput,
    tenantId: session.tenantId,
    projectId: session.projectId,
    callerContext: session.callerContext, // Uses GAP-3.3's identity model
  });

  if (checkResult.pending.length > 0) {
    session.authGate = buildAuthGate(checkResult);
    session.blocked = true; // Prevents initializeSession from running
  }
}
```

### 3.3 Preflight Satisfaction Callback

**Canonical endpoint:** `POST /api/runtime/sessions/:sessionId/consent`

This endpoint is defined in GAP-3.1 Section 9.2. It is the single satisfaction endpoint for both preflight and inline consent. The handler:

1. Validates the session exists and is blocked
2. Verifies caller owns the session (same `contactId` + `tenantId`)
3. Re-checks all preflight requirements via GAP-3.3's `ConsentStateResolver`
4. If all preflight requirements are now satisfied, sets `session.blocked = false`
5. Returns the updated consent state
6. If all satisfied, automatically triggers `initializeSession`

### 3.4 Inline Consent — Tool Error Result Pattern

**Files:** `apps/runtime/src/services/execution/flow-step-executor.ts`, `apps/runtime/src/services/execution/reasoning-executor.ts`

> **Architecture decision:** Inline consent does NOT "pause" or "suspend" tool execution mid-LLM-turn. Instead, it uses a **tool error result pattern** that works naturally with the LLM conversation flow.

Before executing a tool with `connection_mode: 'per_user'` and `consent_mode: 'inline'`:

1. Check if the user has a valid token for this connector (via `ConsentStateResolver`)
2. If not satisfied:
   a. Return a structured error result to the LLM (do NOT suspend execution):
   ```json
   {
     "error": "CONSENT_REQUIRED",
     "message": "User needs to authorize Gmail to send emails. Ask them to click the authorization link.",
     "connector": "gmail",
     "displayName": "Gmail",
     "scopes": ["gmail.send"]
   }
   ```
   b. Send `inline_consent_required` WS event to the client with the `authorizationUrl`
   c. The LLM naturally responds to the user: "I need access to your Gmail to send that email. Please click the authorization button above."
   d. The user authorizes via the OAuth popup
   e. On the user's **next message** (new LLM turn), the tool can be called successfully with the now-available token

**Why this approach (not suspension):** The LLM's tool call is part of a streaming response with potentially multiple tool calls in a single turn. "Suspending" mid-turn means the LLM's response is partially consumed, other tool calls may have executed, and restoring the reasoning context is impossible. The tool error result approach avoids this entirely — the LLM completes its turn, the user authorizes, and the next turn retries the tool naturally.

**LLM system prompt guidance:** To ensure the LLM handles `CONSENT_REQUIRED` tool results correctly (rather than retrying or apologizing generically), the runtime should inject the following system message into the conversation context when any tool has `consent_mode: 'inline'`:

```
When a tool returns a CONSENT_REQUIRED error, inform the user that they need to authorize
the service. An authorization button has appeared in the chat interface above your message.
Do not retry the tool until the user confirms they have completed authorization. Do not
apologize for the error — this is a normal authorization step.
```

This system message is injected once per session (when the first inline consent tool is invoked), not on every tool call.

**ConsentRequiredError class:**

Define `ConsentRequiredError` as a distinct error class that:

1. Bypasses retry logic (not a transient error)
2. Does not count against tool failure thresholds
3. Returns a user-facing consent prompt via the WS event rather than a generic error message
4. Maximum concurrent inline consent: 1 at a time. If multiple tools need consent, they are queued and presented sequentially. **Queuing mechanism:** Since inline consent uses the tool error result pattern (each tool returns `CONSENT_REQUIRED` to the LLM independently), there is no server-side queue. Instead, queuing is **client-side**: when multiple `inline_consent_required` WS events arrive in the same turn, the client (Studio `ChatPanel` or widget) queues them in a FIFO array and presents one OAuth popup at a time. After one popup completes (success or failure), the next popup opens. GAP-3.4 or the widget SDK should implement this client-side queue. The runtime coalesces multiple `CONSENT_REQUIRED` tool results into a single message turn for the LLM to avoid confusion.

### 3.5 Integration with Existing Auth Modules

The existing modules need these changes:

| Module                                                         | Change                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`  | Extend `AuthRequirement` with `consent_mode` field; skip inline requirements when validating handoff    |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`   | Pass consent state per-branch; each branch inherits parent consent but can have additional requirements |
| `apps/runtime/src/services/execution/auth-profile-delegate.ts` | Propagate consent state through delegation chain                                                        |
| `packages/connectors/src/auth/connection-resolver.ts`          | Add `hasValidToken` method that checks existence + non-expired + scope coverage without decrypting      |
| `packages/connectors/src/executor/connector-tool-executor.ts`  | Before `execute()`, check consent state; throw `ConsentRequiredError` if not satisfied                  |

---

## 4. Consent State Tracking

### 4.1 Canonical Types

All consent types are defined in the shared module: `packages/shared/src/types/auth-consent.ts` (see GAP-3.1 Section 3.1 for the full type definitions).

The key types are:

- `AuthGate` — The session-level gate state, lives on `SessionData`
- `AuthConsentRequirement` — Individual connector requirement
- `ConsentEntry` — Per-connector satisfied/pending entry
- `PendingInlineConsent` — Active inline consent request

### 4.2 Persistence

Consent state MUST be persisted with the session in Redis/MongoDB so that:

- Pod failover does not lose consent progress
- The consent satisfaction callback can target any pod

All consent fields (`authGate`, `blocked`, `pendingInlineConsent`) live on `SessionData` and are included in session serialization automatically.

### 4.3 Consent State Transitions

```
Session Created
     │
     ▼
┌─────────────┐    all preflight satisfied    ┌──────────────┐
│   BLOCKED   │ ────────────────────────────► │ RUNNING      │
│  (preflight │    POST /sessions/:id/consent │  (normal     │
│   pending)  │                               │   execution) │
└─────────────┘                               └──────┬───────┘
                                                     │
                                              tool invoked with
                                              unsatisfied inline
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │  TOOL ERROR  │
                                              │  RETURNED    │
                                              │  (LLM asks   │
                                              │   user to    │
                                              │   authorize) │
                                              └──────┬───────┘
                                                     │
                                              user authorizes,
                                              sends next message
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │  RUNNING     │
                                              │  (tool       │
                                              │   succeeds)  │
                                              └──────────────┘
```

### 4.4 Consent Expiration

A granted consent (satisfied entry) is valid for the lifetime of the session. The underlying `oauth2_token` may expire and be refreshed transparently by the `ConnectionResolver`. If the token is revoked or refresh fails, the consent entry moves back to `pendingInline` and the user is re-prompted via the tool error result pattern.

---

## 5. Preflight Collection Across All Agents

### 5.1 Compiler-Time Collection

The compiler collects preflight requirements from the full agent dependency tree at compile time. The result is stored in `CompilationOutput.preflight_auth_requirements`.

**Algorithm:**

```
function collectPreflightRequirements(entryAgent, agentMap):
    visited = Set()
    requirements = Map<connector, AuthRequirementIR>()

    function walk(agentName):
        if agentName in visited: return
        visited.add(agentName)

        agent = agentMap[agentName]

        for tool in agent.tools:
            if tool.connection_mode == 'per_user':
                key = tool.connector_binding.connector
                if key in requirements:
                    // Union scopes
                    requirements[key].scopes = union(requirements[key].scopes, tool.connector_binding.scopes)
                    // Stricter consent wins
                    if tool.consent_mode == 'preflight':
                        requirements[key].consent_mode = 'preflight'
                    // Add tool name
                    requirements[key].tool_names.push(tool.name)
                else:
                    requirements[key] = new AuthRequirementIR(...)

        // Walk handoff targets
        for handoff in agent.coordination.handoffs:
            walk(handoff.to)

        // Walk delegate targets
        for delegate in agent.coordination.delegates:
            walk(delegate.agent)

    walk(entryAgent)
    return requirements.values().filter(r => r.consent_mode == 'preflight')
```

### 5.2 Deploy-Time Resolution

At deploy time (when creating a deployment via Studio), the `auth_profile_id` fields in the requirements are resolved by matching:

1. Connector name + `authType: 'oauth2_app'` in the project's auth profiles
2. Falls back to tenant-level auth profiles

**Resolution algorithm:** The `AuthRequirementCollector` resolves `auth_profile_id` by:

```
AuthProfile.findOne({
  tenantId,
  projectId,        // project-scoped first
  authType: 'oauth2_app',
  connector: requirement.connector,
  status: 'active',
})
```

If no project-scoped match, fall back to tenant-scoped:

```
AuthProfile.findOne({
  tenantId,
  projectId: null,   // tenant-scoped
  authType: 'oauth2_app',
  connector: requirement.connector,
  status: 'active',
})
```

If multiple matches exist at the same scope level, prefer the most recently created (`sort: { createdAt: -1 }`). If still ambiguous after scope preference, emit a deployment validation **warning** listing the candidates and use the first match.

If no matching `oauth2_app` profile exists for a preflight connector, the deployment validation **errors** (not warns): "No OAuth app configured for {connector}. Users will not be able to authorize." This is a configuration error that must be caught at deploy time.

### 5.3 Runtime Aggregation for Handoffs

When a handoff targets an agent with additional preflight requirements not yet satisfied:

1. The handoff validation (`auth-profile-handoff.ts`) checks the session's `authGate`
2. If unsatisfied preflight requirements exist on the target agent, the handoff is **blocked**
3. The runtime returns an `auth_required` message listing the additional connectors, with context: "To continue, [Agent Name] needs access to the following services."
4. The client collects consent, calls the satisfaction endpoint, and the handoff is retried

This handles the case where Agent A hands off to Agent B, which uses a connector not used by Agent A.

---

## 6. UI States

### 6.1 Three-State Model

| State             | Color | Icon         | Behavior                                              |
| ----------------- | ----- | ------------ | ----------------------------------------------------- |
| Satisfied         | Green | Check circle | Connector authorized, token valid                     |
| Pending Preflight | Amber | Shield alert | Blocks session start, user must authorize             |
| Pending Inline    | Gray  | Clock        | Will be requested when needed, does not block session |

### 6.2 Preflight Consent Wall

Displayed when `session.blocked` is true. Shows:

- Header: "This agent needs access to your accounts"
- List of pending connectors with:
  - Connector icon + name
  - Scopes in human-readable form (e.g., "Send emails, Read contacts")
  - [Authorize] button that opens OAuth popup
- Already-satisfied connectors shown with green checkmark
- Inline connectors shown in a "Later" section with gray styling
- "Start Chat" button — disabled until all amber items are green

### 6.3 Inline Consent Prompt

Displayed mid-conversation when a tool returns `CONSENT_REQUIRED` error:

- Chat bubble from agent: "I need access to your {Connector} account to {action}."
- Interactive button: [Authorize {Connector}]
- Clicking opens OAuth popup in new window
- On success: popup closes, user sends next message, tool execution succeeds
- On deny: agent receives tool error, continues conversation without that tool
- Timeout: if user does not respond within `timeoutMs` (default 5 minutes), the tool fails with a timeout error on next invocation attempt

### 6.4 Consent Status in Session Header

A small indicator in the chat session header shows consent status:

- All satisfied: green dot + "All connected"
- Some pending inline: gray dot + "{N} optional connections"
- Hovering shows the full breakdown

### 6.5 WebSocket Events

> **Cross-plan agreement:** All consent-related WS events are defined once in GAP-3.1 Section 5.1. This section references them.

The consent flow uses these unified WebSocket events (defined in `apps/runtime/src/websocket/events.ts`):

**Server events:**

- `auth_required` — sent after `load_agent` when preflight is needed (includes full auth gate payload)
- `auth_gate_updated` — sent when a connector is authorized
- `auth_gate_satisfied` — sent when all preflight connectors are authorized, session proceeds
- `auth_gate_timeout` — sent when the auth gate expires
- `inline_consent_required` — sent mid-conversation when a tool needs inline consent (includes `authorizationUrl`, `connector`, `scopes`)
- `inline_consent_satisfied` — sent when inline consent is granted

**Client events:**

- `auth_consent_denied` — client notifies server that user denied consent

---

## 7. Edge Cases

### 7.1 Same Connector, Multiple Tools

If `gmail.send_email` (preflight) and `gmail.read_inbox` (inline) both use the Gmail connector:

- The compiler unions the scopes: `['gmail.send', 'gmail.compose', 'gmail.readonly']`
- The stricter consent mode wins: `preflight`
- The user authorizes all scopes at session start
- Both tools use the same token

### 7.2 Same OAuth Provider, Different Connectors

If both "Gmail" and "Google Drive" use Google OAuth but are separate connectors:

- They are treated as separate requirements (different connector names)
- Each gets its own consent entry
- The user may see two Google OAuth popups (one for Gmail scopes, one for Drive scopes)
- **Optimization (deferred):** If both connectors use the same `oauth2_app` profile and the scope sets are compatible, the compiler can merge them into a single consent request with the union of scopes

### 7.3 Scope Escalation

If a user has already authorized Gmail with `gmail.readonly` but a tool now requires `gmail.send`:

1. The consent check detects that `grantedScopes` (from the existing `oauth2_token`) does not cover the required scopes
2. The connector is marked as `pendingPreflight` (or `pendingInline`) despite having a token
3. The authorization URL includes the incremental scopes
4. On re-authorization, Google returns a token with the union of old + new scopes
5. The existing `oauth2_token` auth profile is updated (not duplicated)

**Detection logic:**

```typescript
function isScopeSatisfied(grantedScopes: string[], requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes);
  return requiredScopes.every((s) => granted.has(s));
}
```

### 7.4 Token Revocation Mid-Session

If a user revokes a token externally (e.g., via Google Account settings) while a session is active:

1. The next tool execution using that token gets a 401/403 from the provider
2. The `ConnectionResolver.refreshOAuth2` attempts a refresh, which also fails
3. The token status is updated to `expired`
4. The tool returns `CONSENT_REQUIRED` error result to the LLM
5. The agent tells the user: "Your Gmail access has expired. [Re-authorize]"
6. On re-authorization and next user message, the tool succeeds

### 7.5 Handoff to Agent with Unsatisfied Preflight

Scenario: Agent A has no connector requirements. Agent A hands off to Agent B, which requires preflight consent for Salesforce.

- At compile time, Agent B's preflight requirements are NOT bubbled up to Agent A (they belong to different agent boundaries)
- At runtime, the handoff validation detects the gap
- **Recommended:** Block the handoff, return `auth_required` to the client with context: "To continue, [Agent B] needs access to Salesforce.", collect consent, then retry the handoff

### 7.6 Fan-Out with Mixed Consent Requirements

When a supervisor fans out to 3 agents, and 2 of them need inline consent for different connectors:

1. Each fan-out branch gets its own `FanOutBranchAuthContext` (already implemented for connection mode validation; consent state fields will be added in Phase 2). All branches share the **parent session's** consent state — the session-level `authGate.satisfiedConnectors` is the single source of truth. A consent granted for one branch's connector applies to all branches using the same connector.
2. If a branch hits an unsatisfied inline consent:
   - That branch's tool returns `CONSENT_REQUIRED` error result
   - Other branches continue executing (they are independent)
   - The client receives `inline_consent_required` WS event
   - Maximum 1 concurrent inline consent prompt at a time; additional are queued
3. The fan-out barrier waits for all branches

### 7.7 Session Restore After Pod Restart

Since all consent state lives on `SessionData` (serialized to Redis/MongoDB):

1. A new pod loads the session from Redis/MongoDB
2. If `session.blocked` is true, the session remains in preflight-waiting state
3. If `session.pendingInlineConsent` is set, the tool error pattern will re-trigger on next invocation
4. The consent satisfaction endpoint works on any pod (stateless)

### 7.8 Concurrent Sessions, Same User, Same Connector

User opens two sessions, both requiring Gmail preflight:

- Session 1: user authorizes Gmail, `oauth2_token` is created
- Session 2: preflight check finds the token created by Session 1
- Session 2 is unblocked without requiring re-authorization

The `oauth2_token` is per-user, not per-session. The consent state check queries the auth profile store, not the session.

---

## 8. Task Breakdown

### Phase 1: Compiler IR and Propagation (Sprint N)

| Task | Description                                                             | File(s)                                                                 |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1.1  | Add `connection_mode`, `consent_mode` to `ToolDefinition` IR            | `packages/compiler/src/platform/ir/schema.ts`                           |
| 1.2  | Add `connection_mode`, `consent_mode`, `scopes` to `ConnectorBindingIR` | `packages/compiler/src/platform/ir/schema.ts`                           |
| 1.3  | Add `AuthRequirementIR` type and `auth_requirements` to `AgentIR`       | `packages/compiler/src/platform/ir/schema.ts`                           |
| 1.4  | Add `preflight_auth_requirements` to `CompilationOutput`                | `packages/compiler/src/platform/ir/schema.ts`                           |
| 1.5  | Parse `connection` and `consent` from tool AST nodes                    | `packages/core/src/` (parser)                                           |
| 1.6  | Emit `connection_mode` and `consent_mode` in tool compilation           | `packages/compiler/src/platform/ir/compiler.ts`                         |
| 1.7  | Implement `AuthRequirementCollector` post-compilation pass              | `packages/compiler/src/platform/ir/auth-requirement-collector.ts` (new) |
| 1.8  | Wire collector into `compileABLtoIR` pipeline                           | `packages/compiler/src/platform/ir/compiler.ts`                         |
| 1.9  | Add compiler tests for consent propagation                              | `packages/compiler/src/__tests__/auth-requirements.test.ts` (new)       |

### Phase 2: Runtime Consent State (Sprint N+1, with GAP-3.1)

| Task | Description                                                              | File(s)                                                   |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 2.1  | Define canonical consent types in shared package                         | `packages/shared/src/types/auth-consent.ts` (new)         |
| 2.2  | Add `authGate`, `blocked`, `pendingInlineConsent` to `SessionData`       | `apps/runtime/src/services/session/types.ts`              |
| 2.3  | Add `hasValidToken` to `ConnectionResolver` (scope-aware check)          | `packages/connectors/src/auth/connection-resolver.ts`     |
| 2.4  | Implement `checkPreflightAuth` in runtime (reads from CompilationOutput) | `apps/runtime/src/services/auth/preflight-check.ts` (new) |
| 2.5  | Block `initializeSession` when `session.blocked` is true                 | `apps/runtime/src/services/runtime-executor.ts`           |
| 2.6  | Return `auth_required` payload from session creation                     | `apps/runtime/src/services/runtime-executor.ts`           |
| 2.7  | Add session serialization for consent state fields                       | `apps/runtime/src/services/session-store.ts`              |

### Phase 3: Inline Consent and Satisfaction Flow (Sprint N+3, with GAP-3.3)

| Task | Description                                                               | File(s)                                                                |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 3.1  | Add `POST /sessions/:id/consent` endpoint                                 | `apps/runtime/src/routes/session-routes.ts` (or new consent-routes.ts) |
| 3.2  | Implement consent re-check and session unblock logic                      | `apps/runtime/src/services/consent-service.ts` (new)                   |
| 3.3  | Add `ConsentRequiredError` class to tool execution path                   | `packages/connectors/src/executor/connector-tool-executor.ts`          |
| 3.4  | Handle `ConsentRequiredError` in reasoning executor (return error result) | `apps/runtime/src/services/execution/reasoning-executor.ts`            |
| 3.5  | Extend handoff validation with consent mode awareness                     | `apps/runtime/src/services/execution/auth-profile-handoff.ts`          |
| 3.6  | Add unified WebSocket events for consent state changes                    | `apps/runtime/src/websocket/events.ts`                                 |

### Phase 4: Integration and Tests

| Task | Description                                                       | File(s)                                                                |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 4.1  | Integration test: preflight blocks session, satisfaction unblocks | `apps/runtime/src/__tests__/consent-preflight.test.ts` (new)           |
| 4.2  | Integration test: inline consent tool error result                | `apps/runtime/src/__tests__/consent-inline.test.ts` (new)              |
| 4.3  | Integration test: scope escalation detection                      | `apps/runtime/src/__tests__/consent-scope-escalation.test.ts` (new)    |
| 4.4  | Integration test: handoff with unsatisfied consent                | `apps/runtime/src/__tests__/consent-handoff.test.ts` (new)             |
| 4.5  | Integration test: fan-out with mixed consent                      | `apps/runtime/src/__tests__/consent-fanout.test.ts` (new)              |
| 4.6  | Compiler test: propagation across agent dependency tree           | `packages/compiler/src/__tests__/auth-requirement-propagation.test.ts` |

---

## 9. Migration and Backward Compatibility

### 9.1 Existing Tools Without Consent Fields

All existing tools that lack `connection` and `consent` fields are treated as `connection: shared`. This is backward-compatible because:

- No existing tools use `per_user` (it is a new feature)
- Shared tools have no consent requirements
- No runtime behavior changes for existing deployments

### 9.2 Existing Connector Connections

Existing `ConnectorConnection` documents in the database are unaffected. They continue to work as tenant-scoped shared connections. The new consent flow only applies when the DSL explicitly declares `connection: per_user`.

### 9.3 Feature Flag

The consent check can be gated behind a feature flag (`AUTH_PROFILE_CONSENT_ENABLED`):

- `false` (default during rollout): consent state is not checked, all sessions start immediately
- `true`: preflight and inline consent checks are active

This allows gradual rollout and easy rollback. This flag controls consent mechanics for ALL auth types (core and enterprise). Enterprise type flags (from the Deferred Types plan) only control profile creation, not consent behavior.

---

## 10. Observability

### 10.1 Trace Events

| Event                       | Data                                                      |
| --------------------------- | --------------------------------------------------------- |
| `consent_preflight_check`   | `{ requirements, satisfied, pending, sessionId }`         |
| `consent_preflight_blocked` | `{ pendingConnectors, sessionId }`                        |
| `consent_satisfied`         | `{ connector, scopes, grantedAt, sessionId }`             |
| `consent_session_unblocked` | `{ sessionId, totalPreflightMs }`                         |
| `consent_inline_requested`  | `{ connector, toolName, sessionId }`                      |
| `consent_inline_satisfied`  | `{ connector, toolName, resumedAt, waitMs, sessionId }`   |
| `consent_inline_timeout`    | `{ connector, toolName, timeoutMs, sessionId }`           |
| `consent_inline_denied`     | `{ connector, toolName, sessionId }`                      |
| `consent_scope_escalation`  | `{ connector, grantedScopes, requiredScopes, sessionId }` |

### 10.2 Metrics

- `consent_preflight_wait_seconds` (histogram) — time from session creation to all preflight satisfied
- `consent_inline_wait_seconds` (histogram) — time from inline request to satisfaction
- `consent_denied_total` (counter, labels: connector, consent_mode)
- `consent_scope_escalation_total` (counter, labels: connector)

---

## 11. Security Considerations

1. **OAuth state parameter:** The consent satisfaction endpoint MUST validate the OAuth state parameter to prevent CSRF. The state is **encrypted** (AES-256-GCM), not just HMAC-signed, since it contains `sessionId`.

2. **Session ownership:** The `POST /sessions/:id/consent` endpoint MUST verify that the caller owns the session (same `contactId` + `tenantId`).

3. **Scope inflation:** The compiler's scope union must be auditable. The `auth_requirements` manifest in the IR shows exactly which scopes are requested and why (which tools need them).

4. **Token isolation:** Inline consent tokens are personal (`visibility: 'personal'`). They MUST NOT be accessible to other users even within the same tenant.

5. **Consent timeout:** Inline consent requests have a configurable timeout (default 5 minutes). After timeout, the tool invocation fails on next attempt. The session is NOT terminated — the agent continues without that tool.

6. **Rate limiting:** The `POST /sessions/:id/consent` endpoint must be rate-limited: 5 requests per minute per session.

7. **SSRF guards:** All URL fields in auth profile configs (`authorizationUrl`, `tokenUrl`, etc.) must be validated against an SSRF allow-list at profile creation time. All Zod config schemas must use `.strict()` to prevent prototype pollution.

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Unified consent state model (single `AuthGate` on `SessionData` in `session/types.ts`, not separate fields on `RuntimeSession`), replaced inline consent tool suspension with tool error result pattern (`ConsentRequiredError` returns error to LLM, next user turn retries), corrected file paths (`ConnectorToolExecutor` at `packages/connectors/src/executor/connector-tool-executor.ts`), unified WS event names with GAP-3.1 (`auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `inline_consent_required`, `inline_consent_satisfied`), unified satisfaction endpoint (`POST /sessions/:id/consent`), added cross-plan dependencies section, sequenced sprints (Phase 1 compiler first, then runtime with GAP-3.1), added rate limiting and SSRF guards, added deploy-time validation errors (not warnings), added max concurrent inline consent limit (1 at a time), fixed `ConsentRequiredError` as distinct recoverable error class.
- **Pass 4 (2026-03-13)**: Applied 20 findings from Pass 3 auditors. Specified oauth2_app profile resolution algorithm for deploy-time validation (project-scoped first, tenant-scoped fallback, most recent on ambiguity), clarified fan-out consent context (all branches share parent session's consent state, FanOutBranchAuthContext consent fields added in Phase 2), defined client-side inline consent queuing mechanism, added LLM system prompt guidance for CONSENT_REQUIRED tool results.
