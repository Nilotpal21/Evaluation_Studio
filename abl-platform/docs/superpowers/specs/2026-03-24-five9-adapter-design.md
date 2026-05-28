# Five9 Agent Transfer Adapter Design

**Date:** 2026-03-24
**Status:** Draft
**Scope:** Five9 agent desktop adapter (v1 — core escalation), inline connection editing in Agent Transfer settings

## Problem

The platform supports agent transfer/escalation to human agents via the `AgentDesktopAdapter` interface, but only Kore SmartAssist has a production adapter. Five9 is a major CCaaS provider with no integration. Additionally, the Agent Transfer settings page lacks the ability to edit a selected connection inline — users must navigate away to modify connection details.

## Goals

1. Implement a Five9 adapter for core escalation: create conversation, relay messages bidirectionally, end session
2. Add Five9 as a configurable provider in Studio's agent desktop registry
3. Add inline edit capability for any selected connection in the Agent Transfer default routing dropdown (all providers, not Five9-specific)

## Non-Goals (v1)

- Agent availability / business hours checks
- Skill/queue-based routing beyond `campaignName`
- File/attachment support
- Chat transcript forwarding
- Comfort messages / typing indicators
- Webhook signature verification
- Token caching / refresh (discovery is per-conversation — adds ~2 round-trips latency per escalation; future optimization candidate)
- Post-agent dialog (return to bot after agent disconnect)
- Health check endpoint
- Reconnection / session recovery

## Part 1: Five9 API Client

### 1.1 Authentication

The client supports two auth modes, configured per-connection:

**Anonymous mode:**

1. `POST https://{host}/appsvcs/rs/svc/auth/anon?cookieless=true` with `{ "tenantName": "..." }`
2. Response: `{ tokenId, metadata: { dataCenters: [{ apiUrls: [{ host }] }] } }`

**Supervisor mode:**

1. Same endpoint with `{ "tenantName": "...", "username": "...", "password": "..." }`
2. Response: same shape

Both modes then: 3. `GET https://{metaHost}/appsvcs/rs/svc/auth/metadata` with `Authorization: Bearer-{token}` 4. Response: `{ orgId, context: { farmId }, metadata: { dataCenters: [{ apiUrls: [{ host }] }] } }` 5. Extract `targetHost`, `orgId`, `farmId` for subsequent calls

### 1.2 Five9Client Class

**File:** `packages/agent-transfer/src/adapters/five9/five9-client.ts`

```typescript
interface Five9AuthResult {
  token: string;
  orgId: string;
  farmId: string;
  targetHost: string;
}

interface Five9ConversationParams {
  campaignName: string;
  phoneNumber?: string;
  contactEmail?: string;
  contactName?: string;
  callbackUrl: string;
  attributes?: Record<string, string>;
  priority?: number;
}

class Five9Client {
  constructor(private credentials: Five9Credentials) {}

  async authenticate(): Promise<Five9AuthResult>;
  async createConversation(
    auth: Five9AuthResult,
    params: Five9ConversationParams,
  ): Promise<{ conversationId: string }>;
  async sendMessage(auth: Five9AuthResult, conversationId: string, message: string): Promise<void>;
  async endConversation(auth: Five9AuthResult, conversationId: string): Promise<void>;
}
```

**Discovery is per-conversation:** Each `execute()` call runs the full auth → metadata → targetHost flow. No persistent connection or cached tokens. Simple and stateless for v1.

**HTTP:** Uses `fetch` (no SDK). All requests include `Authorization: Bearer-{token}` and `farmId` headers.

### 1.3 Credential Shape

```typescript
interface Five9Credentials {
  tenantName: string;
  campaignName: string;
  host?: string; // default: 'app.five9.com'
  authMode: 'anonymous' | 'supervisor';
  username?: string; // required if supervisor
  password?: string; // required if supervisor
  callbackUrl?: string; // override; otherwise auto-generated from runtime public URL
}
```

## Part 2: Five9Adapter

### 2.1 Adapter Class

**File:** `packages/agent-transfer/src/adapters/five9/index.ts`

Implements `AgentDesktopAdapter` from `packages/agent-transfer/src/adapters/interface.ts`.

```
name: 'five9'
capabilities:
  supportsPreChecks: false
  supportsPostAgentDialog: false
  supportsFileUpload: false
  supportsTranslation: false
  transportType: 'webhook'
  authType: 'bearer'
```

### 2.2 Lifecycle Methods

| Method                                | Behavior                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize(config)`                  | Extract Five9 credentials from `config.auth.credentials`. Store config. Instantiate `Five9Client`. No network calls.                                                                                                                                                                                               |
| `execute(payload)`                    | Authenticate → create conversation on Five9 with `campaignName`, `callbackUrl`, contact info from payload, conversation history as attributes → create session in `sessionStore` (stores `conversationId`, `token`, `targetHost`, `farmId`, `orgId`) → return `TransferResult`                                     |
| `sendUserMessage(sessionId, message)` | Accepts `UserMessage` object (per interface). Extracts `message.content` for the Five9 API call. Attachments ignored in v1 (`supportsFileUpload: false`). Look up session → retrieve stored `conversationId`, `token`, `targetHost`, `farmId` → POST message to Five9 conversations API                            |
| `endSession(sessionId, reason)`       | Look up session → end Five9 conversation via API → clean up session store entry                                                                                                                                                                                                                                    |
| `onAgentMessage(handler)`             | Register callback handler (invoked when webhook receives agent messages)                                                                                                                                                                                                                                           |
| `onSessionEvent(handler)`             | Register callback handler (invoked for session lifecycle events)                                                                                                                                                                                                                                                   |
| `handleInboundEvent(event, tenantId)` | Receives `XOEvent` (the interface's parameter type). The webhook route maps the Five9 payload to `XOEvent` shape before calling (see Part 3). Internally: look up session by `event.conversationId` → extend session TTL → map `event.type` to `AgentEventType` via `Five9EventHandler` → fire registered handlers |
| `close()`                             | No-op. Five9Client uses stateless `fetch` — no connection pool to drain. Implemented for compatibility with `shutdownAgentTransfer()` which calls `close()` on all adapters.                                                                                                                                       |

### 2.3 XOEvent Compatibility

The `AgentDesktopAdapter` interface defines `handleInboundEvent(event: XOEvent, tenantId: string)`. `XOEvent` is generic enough to carry Five9 payloads — it has `type: string`, `conversationId: string`, `orgId?: string`, `data?: Record<string, unknown>`, `message?: string`. The webhook route maps Five9-native fields into `XOEvent` shape before calling the adapter:

```typescript
// In webhook route, before calling adapter.handleInboundEvent():
const xoEvent: XOEvent = {
  type: five9Payload.eventType ?? 'agent_message',
  conversationId: five9Payload.conversationId,
  orgId: session.tenantId, // resolved from connectionId → tenant mapping
  message: five9Payload.message,
  data: { agentName: five9Payload.agentName, ...five9Payload },
  timestamp: five9Payload.timestamp,
};
```

### 2.4 Session Store Data (Redis)

Each active transfer session stores:

- `conversationId` — Five9 conversation ID
- `token` — Five9 auth token for this conversation (encrypted — see Section 2.5)
- `targetHost` — discovered data center host
- `farmId` — Five9 farm ID
- `orgId` — Five9 org ID
- `provider` — `'five9'`
- `tenantId`, `contactId`, `channel`, `agentId` — standard session fields

Uses the existing `TransferSessionStoreHandle` interface (same as KoreAdapter).

### 2.5 Session Field Encryption

The Five9 `token` is a bearer credential and must be encrypted at rest in Redis. The boot service already initializes a `TenantScopedSessionEncryptor` (see `apps/runtime/src/services/agent-transfer/index.ts`). The Five9 adapter registers `token` as a sensitive field in the session store, ensuring it is encrypted/decrypted transparently via the same `SessionFieldEncryptor` mechanism used by KoreAdapter.

### 2.6 Five9-Specific Types

**File:** `packages/agent-transfer/src/adapters/five9/types.ts`

```typescript
interface Five9Credentials { ... }        // from Section 1.3
interface Five9AuthResult { ... }         // from Section 1.2
interface Five9WebhookPayload {           // inbound from Five9
  conversationId: string;
  messageType?: string;
  message?: string;
  eventType?: string;
  agentName?: string;
  timestamp?: string;
}
```

## Part 3: Webhook Integration

### 3.1 Reuse Existing Webhook Route

**No new route file needed.** The codebase already has a generic, provider-agnostic webhook route at `apps/runtime/src/routes/agent-transfer-webhooks.ts` handling `POST /api/v1/agent-transfer/webhooks/:provider`. This route:

- Checks `isAgentTransferInitialized()`
- Looks up the adapter from `AdapterRegistry` by `:provider` name
- Validates webhook signatures (if configured)
- Enforces tenant isolation via `orgId` in the event body
- Calls `adapter.handleInboundEvent(event, tenantId)`

**Five9 callbackUrl** should point to: `POST /api/v1/agent-transfer/webhooks/five9`

### 3.2 Tenant Isolation for Five9 Webhooks

The existing webhook route requires `orgId` in the event body for tenant-isolated session lookup. Five9 webhook payloads do not include our internal `orgId`. Solution: the Five9 adapter stores a mapping from `conversationId → tenantId` at transfer initiation time (in the session store via `execute()`). The webhook route pre-processing maps the Five9 payload to `XOEvent` format, injecting `orgId` from the session lookup:

1. Webhook receives Five9 payload with `conversationId`
2. Route calls `sessionStore.getByProvider('five9', '*', conversationId)` to resolve tenant
3. Injects resolved `tenantId` as `orgId` into the `XOEvent` before validation
4. Existing tenant isolation check passes

**Alternative (simpler):** Embed `tenantId` in the callback URL as a query parameter: `/api/v1/agent-transfer/webhooks/five9?tid=<tenantId>`. The route extracts `tid` and uses it as `orgId`. This avoids the extra session lookup. The webhook route needs a minor enhancement to support this pattern for providers that don't include `orgId` natively.

### 3.3 Five9-to-XOEvent Mapping in Webhook Route

A small provider-specific pre-processing block in the webhook route (or a static helper in the Five9 adapter) maps the Five9 payload to `XOEvent` shape:

```typescript
// five9 payload normalization (in webhook route or adapter helper)
function normalizeToXOEvent(body: Record<string, unknown>, tenantId: string): XOEvent {
  return {
    type: (body.eventType as string) ?? 'agent_message',
    conversationId: body.conversationId as string,
    orgId: tenantId,
    message: body.message as string | undefined,
    data: body as Record<string, unknown>,
    timestamp: body.timestamp as string | undefined,
  };
}
```

### 3.4 Event Mapping

| Five9 Callback                   | AgentEventType       |
| -------------------------------- | -------------------- |
| Agent sends text message         | `agent:message`      |
| Agent accepts/joins conversation | `agent:joined`       |
| Agent ends conversation          | `agent:disconnected` |
| Conversation queued              | `agent:queued`       |

## Part 4: Studio UI — Five9 Provider Registration

### 4.1 Agent Desktop Registry

**File:** `apps/studio/src/components/connections/agent-desktop-registry.ts`

Add `'five9'` to `AgentDesktopProvider` union type and add provider definition:

```typescript
{
  id: 'five9',
  label: 'Five9',
  description: 'Five9 Virtual Contact Center agent desktop',
  setupHint: 'Get your tenant name from Five9 admin. For supervisor auth, create dedicated credentials in Five9 VCC Admin > User Management.',
  Icon: Headset,  // distinct from Genesys (Phone) and SmartAssist (Headphones)
  authType: 'custom',
  fields: [
    { key: 'tenantName',   label: 'Tenant Name',   type: 'text',     required: true,  hint: 'Your Five9 tenant name from Five9 admin' },
    { key: 'campaignName', label: 'Campaign Name',  type: 'text',     required: true,  hint: 'Five9 campaign for routing conversations' },
    { key: 'host',         label: 'Host',           type: 'text',     required: false, placeholder: 'app.five9.com', hint: 'Five9 host (default: app.five9.com)' },
    { key: 'authMode',     label: 'Auth Mode',      type: 'text',     required: true,  placeholder: 'anonymous or supervisor', hint: 'Enter "anonymous" or "supervisor". Validated at runtime.' },
    { key: 'username',     label: 'Username',       type: 'text',     required: false, hint: 'Required for supervisor auth mode' },
    { key: 'password',     label: 'Password',       type: 'password', required: false, hint: 'Required for supervisor auth mode' },
    { key: 'callbackUrl',  label: 'Callback URL',   type: 'url',      required: false, hint: 'Override auto-generated webhook URL' },
  ],
}
```

## Part 5: Inline Connection Edit in Agent Transfer Settings

### 5.1 UX Flow

1. User opens Agent Transfer settings page
2. "Default Routing Connection" dropdown lists all configured agent desktop connections (all providers)
3. User selects a connection from the dropdown
4. An **edit icon** (pencil from lucide-react) appears next to the dropdown
5. Clicking it opens a **modal dialog** with the selected connection's fields (loaded from `getProviderDef(providerId)`)
6. Password/secret fields display as masked (`••••••`) with a "change" toggle — decrypted secrets are never fetched for display
7. User edits fields → saves → modal closes → dropdown reflects updated connection name
8. Works for all providers: SmartAssist, Five9, Genesys, Salesforce, ServiceNow, Generic

### 5.2 EditConnectionDialog Component

**File:** `apps/studio/src/components/connections/EditConnectionDialog.tsx`

**Props:**

- `connectionId: string`
- `providerId: AgentDesktopProvider`
- `open: boolean`
- `onClose: () => void`
- `onSaved: () => void` — triggers parent to refetch connection list

**Behavior:**

- On open: fetch connection details via existing connection API (credentials come back masked)
- Render fields from `getProviderDef(providerId).fields`
- Password fields: show masked placeholder, "Change" toggle reveals input
- Save: PATCH connection via existing API, only send changed fields
- Reuses existing `AGENT_DESKTOP_PROVIDERS` field definitions — no field duplication

### 5.3 Agent Transfer Settings Modification

Modify the Agent Transfer settings component to:

- Add a pencil icon (`Pencil` from lucide-react) next to the default routing connection dropdown
- Icon is enabled only when a connection is selected
- On click: open `EditConnectionDialog` with the selected connection's ID and provider

## Part 6: Config Validation (Zod Schema)

### 6.1 Five9ProviderConfigSchema

**File:** `packages/agent-transfer/src/config/schema.ts`

Add a Zod schema for Five9 provider config alongside existing schemas. Uses `z.string().min(1)` for ID fields per CLAUDE.md rules. Conditional validation ensures `username` and `password` are required when `authMode` is `supervisor`.

## Part 7: Runtime Wiring

### 7.1 Adapter Registration and Message Bridge

**File:** `apps/runtime/src/services/agent-transfer/index.ts`

Register `Five9Adapter` alongside `KoreAdapter` at boot, then wire message bridge handlers following the same pattern as the Kore adapter. The bridge wiring is critical: `onAgentMessage` resolves the ABL session key from the Five9 `conversationId` via `sessionStore.getByProvider('five9', ...)`, then calls `bridge.routeAgentEvent(ablKey, event)`. `onSessionEvent` routes session lifecycle events similarly. Without this wiring, agent messages from Five9 would be received by the adapter but never delivered to the user's channel.

### 7.2 Webhook Route Enhancement

The existing webhook route at `apps/runtime/src/routes/agent-transfer-webhooks.ts` needs a minor enhancement to support providers that don't include `orgId` natively. Add a provider-specific pre-processing step before the `orgId` validation that:

1. For `five9` provider: extracts `tenantId` from query param `tid` or resolves from session store
2. Maps the raw payload to `XOEvent` shape via a static helper
3. Injects the resolved `orgId` before the existing validation continues

This is a small, backward-compatible change. Existing providers (Kore) are unaffected.

## Files Summary

**New files:**

1. `packages/agent-transfer/src/adapters/five9/index.ts` — Five9Adapter
2. `packages/agent-transfer/src/adapters/five9/five9-client.ts` — API client
3. `packages/agent-transfer/src/adapters/five9/types.ts` — Five9-specific types
4. `packages/agent-transfer/src/adapters/five9/five9-event-handler.ts` — Five9 event type mapping
5. `apps/studio/src/components/connections/EditConnectionDialog.tsx` — inline edit dialog

**Modified files:**

1. `apps/studio/src/components/connections/agent-desktop-registry.ts` — add `'five9'` to provider union + add provider def
2. `apps/runtime/src/services/agent-transfer/index.ts` — register Five9Adapter + wire message bridge
3. `apps/runtime/src/routes/agent-transfer-webhooks.ts` — add Five9 payload normalization pre-processing
4. `packages/agent-transfer/src/config/schema.ts` — add Five9 provider config schema
5. Agent Transfer settings component — add edit icon + wire EditConnectionDialog

## Error Handling

- Five9 auth failure: return `TransferResult` with `status: 'failed'`, error code `FIVE9_AUTH_FAILED`
- Five9 conversation creation failure: return `status: 'failed'`, error code `FIVE9_CONVERSATION_FAILED`
- Webhook for unknown provider session (no session found): log warning, return `404`
- Webhook tenant mismatch: return `404` (per platform invariant, don't leak existence)
- `sendUserMessage` with expired/invalid session: log error, throw (caller handles)
- All errors logged via `createLogger('five9-adapter')`, never `console.log`
