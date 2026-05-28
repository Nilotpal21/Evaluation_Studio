# LLD: Five9 Agent Transfer Adapter

**Feature Spec**: `docs/features/sub-features/five9-adapter.md`
**HLD**: `docs/specs/five9-adapter.hld.md`
**Test Spec**: `docs/testing/sub-features/five9-adapter.md`
**Status**: DONE
**Date**: 2026-03-24

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                    | Rationale                                                                                                                       | Alternatives Rejected                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D-1 | Add `providerData` to `TransferSessionStoreHandle.create()` | Real store already supports it (lines 80-83); handle interface omits it. Backward-compatible — existing callers don't pass it   | Create a separate Five9SessionStore (over-engineering)      |
| D-2 | Keep `XOEvent` in `kore/event-handler.ts`                   | Already generic (`type: string`, `conversationId: string`, `orgId?: string`). Lifting to shared types premature with 2 adapters | Move to `types.ts` (churn, re-export for backward compat)   |
| D-3 | Import both event handlers in webhook route                 | Simple `if/else` by provider name. HLD Section 7 specifies this. Avoids registry coupling for event handlers                    | Resolve handler from adapter (over-abstraction)             |
| D-4 | `assertAllowedUrl` per-request on `targetHost`              | `targetHost` is dynamically discovered per conversation (from metadata). Static host validated in constructor                   | Once at init only (misses DNS rebinding on discovered host) |
| D-5 | Five9 config schema in existing `config/schema.ts`          | Follows `KoreProviderConfigSchema` pattern. Feature spec §10 specifies this location                                            | Separate file (unnecessary file proliferation)              |
| D-6 | Five9 uses `providerData` bag, not `metadata`               | `providerData` is the typed field for provider-specific session data. `metadata` is for workflow concerns (postAgentAction)     | Use metadata like Kore (mixes concerns)                     |

### Key Interfaces & Types

```typescript
// packages/agent-transfer/src/adapters/five9/types.ts

export interface Five9Credentials {
  tenantName: string;
  campaignName: string;
  host: string; // default: 'app.five9.com'
  authMode: 'anonymous' | 'supervisor';
  username?: string; // required when authMode === 'supervisor'
  password?: string; // required when authMode === 'supervisor'
  callbackUrl?: string; // override; default constructed from runtime URL
}

export interface Five9AuthResult {
  tokenId: string;
  orgId: string;
  farmId: string;
  targetHost: string; // resolved data center host
}

export interface Five9WebhookPayload {
  type: string;
  conversationId: string;
  data?: Record<string, unknown>;
  message?: string;
  agentInfo?: Record<string, unknown>;
  timestamp?: string;
}
```

```typescript
// packages/agent-transfer/src/config/schema.ts (addition)

export const Five9ProviderConfigSchema = z
  .object({
    tenantName: z.string().min(1),
    campaignName: z.string().min(1),
    host: z
      .string()
      .min(1)
      .default('app.five9.com')
      .refine((h) => !h.includes('://') && !h.includes('/'), {
        message: 'host must be a bare hostname (no protocol or path)',
      }),
    authMode: z.enum(['anonymous', 'supervisor']),
    username: z.string().optional(),
    password: z.string().optional(),
    callbackUrl: z.string().url().optional(),
  })
  .refine((data) => data.authMode !== 'supervisor' || (data.username && data.password), {
    message: 'username and password required for supervisor auth mode',
  });

export type Five9ProviderConfig = z.infer<typeof Five9ProviderConfigSchema>;
```

```typescript
// Updated TransferSessionStoreHandle.create() signature
create(params: {
  tenantId: string;
  contactId: string;
  channel: string;
  provider: string;
  providerSessionId?: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  providerData?: Record<string, unknown>;  // NEW — Five9 stores token, targetHost, farmId, orgId
}): Promise<{ success: boolean; sessionKey?: string; error?: { code: string; message: string } }>;
```

### Module Boundaries

| Module                              | Responsibility                                         | Depends On                                                                       |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `Five9Client`                       | HTTP communication with Five9 REST API                 | `assertAllowedUrl`, native `fetch`                                               |
| `Five9Adapter`                      | `AgentDesktopAdapter` impl: lifecycle, session, events | `Five9Client`, `TransferSessionStoreHandle`, `Five9EventHandler`                 |
| `Five9EventHandler`                 | Pure function: Five9 event type → ABL `AgentEventType` | None (stateless)                                                                 |
| `Five9ProviderConfigSchema`         | Zod validation for Five9 connection config             | `zod`                                                                            |
| Webhook route (modified)            | Provider-aware pre-processing + dispatch               | `Five9EventHandler`, `KoreEventHandler`                                          |
| Boot service (modified)             | Five9Adapter registration + bridge wiring              | `Five9Adapter`, `AdapterRegistry`, `MessageBridge`                               |
| `agent-desktop-registry` (modified) | Five9 provider UI definition                           | `lucide-react` (`PhoneCall` icon — Headset unavailable in lucide-react v0.303.0) |
| `EditConnectionDialog`              | Cross-provider inline connection editing modal         | `getProviderDef()`, `Dialog`, `updateConnection()` (PUT API)                     |

---

## 2. File-Level Change Map

### New Files

| File                                                                                                | Purpose                                                      | LOC Estimate |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ |
| `packages/agent-transfer/src/adapters/five9/index.ts`                                               | Five9Adapter class                                           | ~200         |
| `packages/agent-transfer/src/adapters/five9/five9-client.ts`                                        | Five9 REST API client                                        | ~180         |
| `packages/agent-transfer/src/adapters/five9/five9-event-handler.ts`                                 | Event type mapping (static map + mapEventType)               | ~50          |
| `packages/agent-transfer/src/adapters/five9/types.ts`                                               | Five9-specific TypeScript interfaces                         | ~40          |
| `apps/studio/src/components/connections/EditConnectionDialog.tsx`                                   | Inline connection edit modal                                 | ~150         |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.test.ts`                         | Unit tests for Five9Client                                   | ~250         |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter.test.ts`                        | Unit tests for Five9Adapter                                  | ~200         |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-event-handler.test.ts`                  | Unit tests for event mapping                                 | ~80          |
| `packages/agent-transfer/src/config/__tests__/five9-schema.test.ts`                                 | Unit tests for Five9ProviderConfigSchema                     | ~60          |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.integration.test.ts`             | Integration: Five9Client against mock HTTP (INT-1–6, INT-12) | ~200         |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-session-encryption.integration.test.ts` | Integration: session token encrypted in Redis (INT-7)        | ~80          |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts`    | Integration: endSession cleanup (INT-8)                      | ~80          |
| `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-registry.integration.test.ts`   | Integration: adapter registry (INT-11)                       | ~60          |
| `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts`                                              | E2E: webhook flow with real Express + Redis                  | ~300         |
| `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts`                                             | E2E: full transfer lifecycle                                 | ~350         |

### Modified Files

| File                                                                | Change Description                                                      | Risk |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---- |
| `packages/agent-transfer/src/adapters/kore/index.ts`                | Add `providerData` to `TransferSessionStoreHandle.create()` interface   | Low  |
| `packages/agent-transfer/src/config/schema.ts`                      | Add `Five9ProviderConfigSchema` + type export                           | Low  |
| `packages/agent-transfer/src/index.ts`                              | Export Five9Adapter, Five9EventHandler, Five9 types + config            | Low  |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`                | Provider-aware pre-processing: `tid` extraction, event handler dispatch | Med  |
| `apps/runtime/src/services/agent-transfer/index.ts`                 | Five9Adapter registration + bridge wiring                               | Med  |
| `apps/studio/src/components/connections/agent-desktop-registry.ts`  | Add `'five9'` to type union + Five9 provider definition                 | Low  |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` | Add pencil icon + wire EditConnectionDialog                             | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Five9 Types, Config Schema, and Client

**Goal**: Implement the Five9 REST API client with auth, metadata discovery, and conversation CRUD.

**Tasks**:

1.1. Create `packages/agent-transfer/src/adapters/five9/types.ts` with `Five9Credentials`, `Five9AuthResult`, `Five9WebhookPayload` interfaces
1.2. Add `Five9ProviderConfigSchema` to `packages/agent-transfer/src/config/schema.ts` with `tenantName`, `campaignName`, `host`, `authMode`, `username`/`password` refinement
1.3. Export `Five9ProviderConfigSchema` and `Five9ProviderConfig` type from `packages/agent-transfer/src/config/index.ts`
1.4. Create `packages/agent-transfer/src/adapters/five9/five9-client.ts`:

- Constructor takes `Five9Credentials` + optional `fetchFn` for DI (testing)
- `authenticate(tenantName, authMode, credentials?)`: POST to `/appsvcs/rs/svc/auth/anon?cookieless=true` (anonymous) or supervisor auth endpoint. Returns `tokenId`
- `discoverMetadata(host, token)`: GET `/appsvcs/rs/svc/auth/metadata`. Returns `{ orgId, farmId, targetHost }`
- `createConversation(targetHost, token, params)`: POST `/appsvcs/rs/svc/conversations`. Returns `{ conversationId }`
- `sendMessage(targetHost, conversationId, token, content)`: POST `/appsvcs/rs/svc/conversations/{id}/messages`
- `endConversation(targetHost, conversationId, token)`: DELETE `/appsvcs/rs/svc/conversations/{id}`
- All methods call `assertAllowedUrl(url)` before fetch for SSRF protection
- All non-2xx responses throw structured errors with HTTP status code
- Use `createLogger('five9-client')` — never log tokens or passwords
  1.5. Create `packages/agent-transfer/src/adapters/five9/five9-event-handler.ts`:
- Static `FIVE9_EVENT_MAP`: `Map<string, AgentEventType>` with 8 inferred mappings (subject to validation against live Five9 API per Open Question #1):
  - `'agent_message'` → `'agent:message'`
  - `'agent_connected'` → `'agent:connected'` (agent accepts the conversation — matches Kore's `agent_accepted`)
  - `'agent_joined'` → `'agent:joined'` (agent joins mid-conversation — matches Kore's `agent_joined` and FR-7)
  - `'agent_disconnected'` → `'agent:disconnected'` (agent leaves)
  - `'conversation_queued'` → `'agent:queued'` (waiting for agent)
  - `'conversation_closed'` → `'agent:disconnected'` (conversation ended)
  - `'agent_typing'` → `'agent:typing'`
  - `'agent_typing_stop'` → `'agent:typing_stop'`
- `Five9EventHandler.mapEventType(type: string): AgentEventType | undefined` (static method)
- Note: Five9EventHandler is intentionally static-only (unlike KoreEventHandler which is instance-based with `processEvent`, `onAgentMessage`, `clear`). Five9Adapter manages handler arrays directly; the event handler is a pure mapping utility.
  1.6. Write unit tests for Five9Client (`five9-client.test.ts`): auth modes, discovery, SSRF guard, HTTP error handling, sendMessage failure
  1.7. Write unit tests for Five9EventHandler (`five9-event-handler.test.ts`): all event mappings, unknown event returns undefined
  1.8. Run `pnpm build --filter=@agent-platform/agent-transfer` — verify 0 type errors

**Files Touched**:

- `packages/agent-transfer/src/adapters/five9/types.ts` — new
- `packages/agent-transfer/src/adapters/five9/five9-client.ts` — new
- `packages/agent-transfer/src/adapters/five9/five9-event-handler.ts` — new
- `packages/agent-transfer/src/config/schema.ts` — add Five9 schema
- `packages/agent-transfer/src/config/index.ts` — export Five9 schema
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.test.ts` — new
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-event-handler.test.ts` — new

**Exit Criteria**:

- [ ] `Five9Client` unit tests pass: anonymous auth, supervisor auth, discovery, SSRF rejection, conversation CRUD, error handling (minimum 8 tests)
- [ ] `Five9EventHandler` unit tests pass: all 8 event mappings + unknown event returns undefined (minimum 9 tests)
- [ ] `Five9ProviderConfigSchema` validates: valid anonymous config, valid supervisor config, rejects supervisor without password, rejects invalid authMode (verified in client test)
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` succeeds with 0 errors
- [ ] No `any` types — all Five9 API responses typed

**Test Strategy**:

- Unit: Five9Client with injected `fetchFn` (mock Five9 HTTP responses). Five9EventHandler pure function tests.
- No integration tests this phase — client has no real service boundary (Five9 API is external, mocked via DI).

**Rollback**: Delete `adapters/five9/` directory, remove schema additions from `config/schema.ts`.

---

### Phase 2: Five9Adapter and Session Store Handle Extension

**Goal**: Implement the Five9Adapter class and extend the session store handle to support `providerData`.

**Tasks**:

2.1. Add `providerData?: Record<string, unknown>` to `TransferSessionStoreHandle.create()` params in `packages/agent-transfer/src/adapters/kore/index.ts` (interface only — the real store already accepts it)
2.2. Create `packages/agent-transfer/src/adapters/five9/index.ts` — `Five9Adapter` class:

- `readonly name = 'five9'`
- `capabilities`: `{ supportsPreChecks: false, supportsPostAgentDialog: false, supportsFileUpload: false, supportsTranslation: false, transportType: 'webhook', authType: 'bearer' }`
- Constructor: `(config?: Five9Credentials, sessionStore?: TransferSessionStoreHandle, fetchFn?: typeof fetch)`
- `initialize(config: ProviderConfig)`: Parse connection credentials, validate with `Five9ProviderConfigSchema`, construct `Five9Client` with injected fetch
- `execute(payload: TransferPayload)`: auth → metadata → create conversation → store session (providerData: `{ token, targetHost, farmId, orgId }`) → return `TransferResult`
- `sendUserMessage(sessionId, message)`: get session → `JSON.parse(session.providerData)` to extract token/targetHost (handle returns `Record<string, string>` where providerData is a JSON string) → `Five9Client.sendMessage()` → extend TTL
- `endSession(sessionId, reason)`: `Five9Client.endConversation()` (best-effort, catch + WARN log) → `sessionStore.end()`
- `handleInboundEvent(event: XOEvent, tenantId)`: lookup session by provider → extend TTL → fire `onAgentMessage` callbacks with mapped event
- `onAgentMessage(handler)` / `onSessionEvent(handler)`: store handlers (max 10 per type)
- `close()`: clear handler arrays (message handlers + session event handlers) to prevent memory leaks on shutdown/re-initialization, matching KoreAdapter.close() pattern
- Use `createLogger('five9-adapter')` — structured context with `tenantId`, `conversationId`, `provider`
  2.3. Export `Five9Adapter` from `packages/agent-transfer/src/adapters/index.ts`
  2.4. Export `Five9Adapter`, `Five9EventHandler`, Five9 types from `packages/agent-transfer/src/index.ts`
  2.5. Write unit tests for Five9Adapter (`five9-adapter.test.ts`): execute lifecycle, sendUserMessage, endSession, handleInboundEvent, Zod validation rejection, handler limit
  2.6. Run `pnpm build --filter=@agent-platform/agent-transfer` — verify 0 type errors

**Files Touched**:

- `packages/agent-transfer/src/adapters/kore/index.ts` — add `providerData` to handle interface
- `packages/agent-transfer/src/adapters/five9/index.ts` — new
- `packages/agent-transfer/src/adapters/index.ts` — export Five9Adapter
- `packages/agent-transfer/src/index.ts` — export Five9 public API
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter.test.ts` — new

**Exit Criteria**:

- [ ] Five9Adapter unit tests pass: execute creates session with providerData, sendUserMessage retrieves session and calls client, endSession cleans up, handleInboundEvent fires handlers, invalid config rejected (minimum 8 tests)
- [ ] `TransferSessionStoreHandle.create()` now accepts `providerData` — KoreAdapter callers still compile (backward compat)
- [ ] All existing agent-transfer tests still pass (`pnpm test --filter=@agent-platform/agent-transfer`)
- [ ] `pnpm build --filter=@agent-platform/agent-transfer` succeeds with 0 errors
- [ ] Five9Adapter exported from package index

**Test Strategy**:

- Unit: Five9Adapter with mocked `Five9Client` (DI) and mocked `TransferSessionStoreHandle`
- Verify no regression on existing Kore tests after handle interface change

**Rollback**: Revert `providerData` addition in handle interface, delete Five9Adapter file.

---

### Phase 3: Webhook Route Enhancement and Runtime Wiring

**Goal**: Modify the webhook route for provider-aware dispatch and register Five9Adapter in the boot service.

**Tasks**:

3.1. Modify `apps/runtime/src/routes/agent-transfer-webhooks.ts`:

- Import `Five9EventHandler` from `@agent-platform/agent-transfer`
- After parsing `req.body as XOEvent` (line 119), add provider-aware block BEFORE the `orgId` check (line 128):
  ```
  if (provider === 'five9') {
    // Validate tid with Zod — Express query params can be arrays
    const tidResult = z.string().min(1).safeParse(req.query.tid);
    if (!tidResult.success) return 400 MISSING_TENANT
    event.orgId = tidResult.data;
  }
  ```
- Replace line 141 (`KoreEventHandler.mapEventType`) with provider-aware dispatch:
  `    const normalizedType = provider === 'five9'
? Five9EventHandler.mapEventType(event.type)
: KoreEventHandler.mapEventType(event.type);`
  3.2. Modify `apps/runtime/src/services/agent-transfer/index.ts`:
- Import `Five9Adapter` from `@agent-platform/agent-transfer`
- **Update the boot service `create` lambda** (~line 136-146) to forward `providerData` to the real store: add `providerData: params.providerData` in the `transferSessionStore.create()` call. Without this, Five9's providerData (token, targetHost, farmId, orgId) is silently dropped. Also ensure `ownerPod: hostname()` is included (it already is for Kore — verify it's in the lambda params).
- After KoreAdapter registration (~line 193), create, initialize, and register Five9Adapter:
  ```typescript
  const five9Adapter = new Five9Adapter(undefined, storeHandle);
  // Five9Adapter.initialize() is called lazily on first execute() —
  // it needs per-connection config which is only available at transfer time.
  // Unlike Kore (which has global smartassist config), Five9 credentials are
  // per-connection. Document this in the adapter's initialize() JSDoc.
  adapterRegistry.register('five9', five9Adapter);
  ```
- Wire `onAgentMessage` and `onSessionEvent` handlers through the message bridge — follow the exact Kore pattern at lines 197-216 but with `'five9'` provider. Explicit code:
  ```typescript
  five9Adapter.onAgentMessage(async (event) => {
    const session = await transferSessionStore.getByProvider(
      'five9',
      event.tenantId,
      event.sessionId,
    );
    if (!session) {
      log.warn('No session found for Five9 agent message — dropping event', {
        tenantId: event.tenantId,
        providerSessionId: event.sessionId,
      });
      return;
    }
    const ablKey = sessionKey(session.tenantId, session.contactId, session.channel);
    await bridge.routeAgentEvent(ablKey, { ...event, sessionId: ablKey });
  });
  five9Adapter.onSessionEvent(async (event) => {
    await bridge.routeAgentEvent(event.sessionId, event);
  });
  ```
  3.3. Run `pnpm build --filter=@agent-platform/runtime` — verify 0 type errors
  3.4. Verify existing Kore tests still pass

**Files Touched**:

- `apps/runtime/src/routes/agent-transfer-webhooks.ts` — provider-aware pre-processing
- `apps/runtime/src/services/agent-transfer/index.ts` — Five9Adapter registration

**Exit Criteria**:

- [ ] Webhook route compiles with both handler imports
- [ ] Five9 webhook with `?tid=` param: `orgId` injected before validation
- [ ] Five9 webhook without `?tid=`: returns 400 `MISSING_TENANT`
- [ ] Kore webhook path: completely unchanged (no behavioral change)
- [ ] Boot service `create` lambda forwards `providerData` param to real store
- [ ] Five9Adapter registered in `adapterRegistry` at boot (no global `initialize()` — lazy init documented in JSDoc)
- [ ] `onAgentMessage` wired through bridge: `getByProvider('five9', ...)` → `sessionKey()` → `bridge.routeAgentEvent()`
- [ ] `onSessionEvent` wired through bridge: `bridge.routeAgentEvent(event.sessionId, event)`
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] All existing runtime tests pass

**Test Strategy**:

- E2E tests are in Phase 5. This phase verifies compilation and no regressions.
- Manual verification: boot service logs "Five9Adapter registered" at startup

**Rollback**: Revert webhook route and boot service changes (2 files, git diff visible).

---

### Phase 4: Studio UI — Five9 Provider Registration and EditConnectionDialog

**Goal**: Register Five9 in Studio's provider registry and add the cross-provider inline edit dialog.

**Tasks**:

4.1. Modify `apps/studio/src/components/connections/agent-desktop-registry.ts`:

- Add `'five9'` to `AgentDesktopProvider` type union
- Add `Headset` to the lucide-react import (line 1: add alongside existing `Headphones, Globe, Phone`)
- Add Five9 provider definition to `AGENT_DESKTOP_PROVIDERS` array:
  `typescript
{
  id: 'five9',
  label: 'Five9',
  description: 'Five9 Virtual Contact Center agent desktop',
  setupHint: 'Enter your Five9 tenant name and campaign name...',
  Icon: Headset,
  authType: 'custom',
  fields: [
    { key: 'tenantName', label: 'Tenant Name', type: 'text', required: true, placeholder: 'your-tenant', hint: 'Your Five9 tenant name' },
    { key: 'campaignName', label: 'Campaign Name', type: 'text', required: true, hint: 'Five9 campaign for inbound routing' },
    { key: 'host', label: 'Host', type: 'text', required: false, placeholder: 'app.five9.com', hint: 'Five9 API host (default: app.five9.com)' },
    { key: 'authMode', label: 'Auth Mode', type: 'text', required: true, placeholder: 'anonymous', hint: 'anonymous or supervisor' },
    { key: 'username', label: 'Username', type: 'text', required: false, hint: 'Required for supervisor auth mode' },
    { key: 'password', label: 'Password', type: 'password', required: false, hint: 'Required for supervisor auth mode' },
    { key: 'callbackUrl', label: 'Callback URL', type: 'url', required: false, hint: 'Override webhook callback URL (auto-generated if empty)' },
  ],
}
`
  4.2. Create `apps/studio/src/components/connections/EditConnectionDialog.tsx`:
- Props: `{ open, onClose, projectId, connectionId, providerId, onSaved }`
- Note: `currentCredentials` is NOT passed as a prop — the API never returns decrypted secrets. All credential fields start empty.
- Uses `getProviderDef(providerId)` to render fields dynamically
- Password fields: render with empty value and placeholder "Leave blank to keep current". Never pre-populate — the API does not return decrypted passwords. Only include in the PUT payload if the user explicitly typed a new value.
- Non-password fields (tenantName, host, etc.): populated from the connection's non-secret metadata (displayName, connectorName), NOT from encrypted credentials
- Save uses existing `updateConnection(projectId, connectionId, { credentials })` from `api/connections.ts` — this is a PUT (full credential replace). Build the credentials object with all non-empty field values. Password fields that the user left blank are OMITTED from the payload (server preserves existing values for missing keys).
- Error handling: display sanitized error, close on success
- Uses `Dialog`, `Input`, `Button` from `../ui/`
- All strings hardcoded (consistent with existing providers in registry — no i18n)
  4.3. Modify `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`:
- Import `EditConnectionDialog` and `Pencil` icon
- Add pencil icon next to the default routing connection dropdown
- Wire click handler to open `EditConnectionDialog` with selected connection's data
  4.4. Run `pnpm build --filter=@agent-platform/studio` — verify 0 type errors
  4.5. Write integration test for EditConnectionDialog (`edit-connection-dialog.test.tsx`): renders fields, password fields start empty, save sends only filled credentials via `updateConnection()` PUT

**Files Touched**:

- `apps/studio/src/components/connections/agent-desktop-registry.ts` — Five9 provider def
- `apps/studio/src/components/connections/EditConnectionDialog.tsx` — new
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` — edit icon + dialog wiring
- `apps/studio/src/__tests__/edit-connection-dialog.test.tsx` — new

**Exit Criteria**:

- [ ] Five9 appears in connection creation flow with correct fields
- [ ] `EditConnectionDialog` renders fields from provider definition
- [ ] Password fields start empty with "Leave blank to keep current" placeholder — never pre-populated
- [ ] Save calls `updateConnection()` (PUT) with only user-filled credential fields
- [ ] Pencil icon visible next to connection dropdown in Agent Transfer settings
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] EditConnectionDialog integration test passes (minimum 3 assertions: render, empty password fields, PUT save)

**Test Strategy**:

- Integration: React Testing Library for EditConnectionDialog — render, empty password fields, PUT with filled credentials
- Manual: verify Five9 appears in connection list, edit icon works

**Rollback**: Revert registry addition, delete EditConnectionDialog, revert settings page change.

---

### Phase 5: E2E Tests and Integration Tests

**Goal**: Write comprehensive E2E and integration tests per the test spec.

**Tasks**:

5.1. Create `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts`:

- Gate with `AGENT_TRANSFER_E2E=1`
- Start real Express app on random port with full middleware chain
- Create real Redis connection with unique prefix
- Mock Five9 HTTP server via `Five9Client` DI (inject `fetchFn` that returns predefined responses)
- E2E-1: Valid Five9 webhook → 200, agent message routed
- E2E-2: Invalid/unknown conversationId → 404
- E2E-3: Tenant mismatch → 404 (not 403)
- E2E-4: Malformed payload → 400
- E2E-7: Missing `tid` → 400
  5.2. Create `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts`:
- E2E-5: Full transfer lifecycle (anonymous): execute → sendMessage → webhook → endSession
- E2E-8: Full transfer lifecycle (supervisor): same flow with supervisor auth
- E2E-6: Kore backward compatibility — verify existing Kore webhook still works
- E2E-9: Five9 auth failure — mock returns 401, verify `TransferResult.status === 'failed'`
  5.3. Write integration tests for Five9Client (`five9-client.integration.test.ts`):
- INT-1: Anonymous auth against mock HTTP server
- INT-2: Supervisor auth against mock HTTP server
- INT-3: Auth failure returns structured error
- INT-4: Metadata discovery resolves targetHost
- INT-5: Conversation creation
- INT-6: SSRF guard rejects private IPs (localhost, 127.0.0.1, 10.x, 169.254.x)
- INT-12: Unexpected HTTP status codes (429, 500, 503, malformed JSON)
  5.4. Write integration tests for adapter + session store (`five9-adapter.integration.test.ts`):
- INT-7: Session token encrypted in Redis (providerData blob encrypted)
- INT-8: endSession cleans up even when Five9 API fails
- INT-11: Five9Adapter registration in AdapterRegistry
  Note: INT-9 and INT-10 (EditConnectionDialog) are covered in Phase 4 task 4.5
  5.5. Run full test suite: `pnpm test` — verify no regressions

**Files Touched**:

- `apps/runtime/src/__tests__/five9-webhook.e2e.test.ts` — new (E2E-1 through E2E-4, E2E-6, E2E-7)
- `apps/runtime/src/__tests__/five9-transfer.e2e.test.ts` — new (E2E-5, E2E-8, E2E-9)
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-client.integration.test.ts` — new (INT-1–6, INT-12)
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-session-encryption.integration.test.ts` — new (INT-7)
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-cleanup.integration.test.ts` — new (INT-8)
- `packages/agent-transfer/src/adapters/five9/__tests__/five9-adapter-registry.integration.test.ts` — new (INT-11)

**Exit Criteria**:

- [ ] 9 E2E test scenarios pass (matching test spec E2E-1 through E2E-9)
- [ ] 12 integration test scenarios pass (INT-1 through INT-12, with INT-9/INT-10 in Phase 4)
- [ ] Kore backward compatibility verified (E2E-6)
- [ ] No `vi.mock()` of codebase components in E2E tests
- [ ] All tests interact via HTTP API only — no direct Redis/DB access in assertions
- [ ] `pnpm test` passes across all packages with 0 failures

**Test Strategy**:

- E2E: Real Express on random port, real Redis, Five9 API mocked via DI only
- Integration: Five9Client against mock HTTP server, adapter against real Redis
- No `vi.mock()` of codebase components

**Rollback**: Delete test files (no production code changes in this phase).

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `Five9Adapter` registered in `adapterRegistry.register('five9', ...)` in boot service (Phase 3, task 3.2)
- [ ] `Five9Adapter.onAgentMessage` wired through message bridge in boot service (Phase 3, task 3.2)
- [ ] `Five9Adapter.onSessionEvent` wired through message bridge in boot service (Phase 3, task 3.2)
- [ ] `Five9EventHandler` imported in webhook route for provider-aware dispatch (Phase 3, task 3.1)
- [ ] `Five9ProviderConfigSchema` exported from `packages/agent-transfer/src/config/index.ts` (Phase 1, task 1.3)
- [ ] `Five9Adapter`, `Five9EventHandler`, Five9 types exported from `packages/agent-transfer/src/index.ts` (Phase 2, task 2.4)
- [ ] `'five9'` added to `AgentDesktopProvider` type union in Studio registry (Phase 4, task 4.1)
- [ ] Five9 provider definition added to `AGENT_DESKTOP_PROVIDERS` array (Phase 4, task 4.1)
- [ ] `EditConnectionDialog` imported and wired in `AgentTransferSettingsPage.tsx` (Phase 4, task 4.3)
- [ ] `providerData` param added to `TransferSessionStoreHandle.create()` interface (Phase 2, task 2.1)
- [ ] Boot service `create` lambda forwards `providerData: params.providerData` to `transferSessionStore.create()` (Phase 3, task 3.2)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Five9 uses existing Redis session store with no schema changes.

### Feature Flags

None. Five9 adapter is opt-in via connection configuration — inert until a project adds a Five9 connection.

### Configuration Changes

- `Five9ProviderConfigSchema` added to `config/schema.ts` — no new environment variables
- Five9 credentials are per-connection, encrypted in MongoDB via existing `encryptionPlugin`

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] 9 E2E tests from test spec passing
- [ ] 12 integration tests from test spec passing
- [ ] 13 unit tests from test spec passing
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Kore backward compatibility verified (E2E-6)
- [ ] No `vi.mock()` of codebase components in any E2E test
- [ ] Feature spec updated with implementation details (via `/post-impl-sync`)
- [ ] Testing matrix updated with actual coverage
- [ ] `npx prettier --write` applied to all changed files
- [ ] Security: all Five9 API calls go through SSRF guard
- [ ] Security: bearer tokens encrypted in Redis via `providerData` blob encryption
- [ ] Security: webhook tenant isolation via `tid` parameter + session validation

---

## 7. Open Questions

1. ~~**Five9 webhook payload field names**~~ **RESOLVED** — Validated against live Five9 tenant. Fields use camelCase (`conversationId`, `agentInfo`).
2. ~~**Five9 supervisor auth endpoint**~~ **RESOLVED** — Confirmed: anonymous uses `/appsvcs/rs/svc/auth/anon?cookieless=true`, supervisor uses `/appsvcs/rs/svc/auth/login`.
3. ~~**Boot service initialization order**~~ **RESOLVED** — Five9Adapter registered after session store and bridge creation in `doInitializeAgentTransfer()`.

---

## 8. Post-Implementation Notes

### Enhancements Added After Initial Implementation

The following capabilities were added after the initial LLD phases were completed, based on live testing with a Five9 tenant:

1. **Agent Availability Check (FR-16)**: Added Step 3 in the adapter flow — calls `GET /logged_in_profiles` to check if any agents are logged in for the campaign before creating a conversation. Blocks transfer with user-facing message when no agents available.

2. **435 "Service Migrated" Handling (FR-17)**: Five9 returns HTTP 435 when a domain has migrated to a different data center. Implemented 3-step recovery across all API methods: (a) get updated metadata, (b) re-get with `farmId` header on active DC, (c) retry original call with new host and `farmId` header.

3. **Transfer Failure Message Propagation (FR-20)**: Converted `handleEscalate` in `routing-executor.ts` from sync fire-and-forget to async awaited. Transfer failure messages (e.g. "no agents available") now return directly in the response and reach the user's chat window.

4. **Post-Transfer Message Forwarding (FR-18)**: Added transfer message intercept in `runtime-executor.ts`. When `session.transferInitiated && session.isEscalated`, user messages are forwarded to Five9 via `adapter.sendUserMessage()` instead of being processed by the bot.

5. **Session Flag Reset on Failure (FR-19)**: When transfer fails, `session.isEscalated` and `session.transferInitiated` are reset to `false` in `routing-executor.ts`. This prevents the LLM from generating mock human agent responses on subsequent messages.

6. **Dual-Host Availability Retry**: Availability check uses `authResult.targetHost` (original auth host `app.five9.com`) first, with fallback to `metadata.targetHost` (datacenter host `app-scl.five9.com`) — the metadata-resolved datacenter may not be ready during migration.

### Files Modified (Post-LLD)

| File                                                            | Change                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/agent-transfer/src/adapters/five9/five9-client.ts`    | Added `handleServiceMigrated()`, `checkAgentAvailability()`, 435 handling across all methods |
| `packages/agent-transfer/src/adapters/five9/index.ts`           | Added Step 3 availability check with dual-host retry                                         |
| `packages/agent-transfer/src/adapters/five9/types.ts`           | Added `Five9AgentProfileResponse`, `Five9MetadataResponse` types                             |
| `apps/runtime/src/services/execution/routing-executor.ts`       | Async `handleEscalate`, session flag reset on failure                                        |
| `apps/runtime/src/services/execution/reasoning-executor.ts`     | Await `handleEscalate`, propagate failure messages via `onChunk`                             |
| `apps/runtime/src/services/runtime-executor.ts`                 | Transfer message intercept for post-transfer forwarding                                      |
| `apps/runtime/src/__tests__/escalation-transfer-wiring.test.ts` | Updated for async `handleEscalate`                                                           |
