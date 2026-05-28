# A2A Productization — Implementation Plan

**Date:** 2026-03-18
**Status:** Draft
**Branch:** develop
**Scope:** 5 findings from A2A review — auth, session race, Studio agent enrichment, history fidelity, Studio endpoint UX

---

## Finding 1 — Inbound A2A Auth (P0, Critical)

### Problem

A2A routes (`/a2a/:connectionId`) are mounted at `server.ts:683` via `a2aHandlers.setupRoutes(app)` with no auth middleware. The manifest declares `authMode: 'api_key'` but `requiredCredentials: []` and no enforcement exists. Any caller who knows a valid `connectionId` can invoke the JSON-RPC, SSE, and agent card endpoints.

### Design

Follow the **connection-scoped credential pattern** already used by voice channels (inboundAuthToken stored encrypted, decrypted at request time). This is simpler and more appropriate than the SDK token-exchange flow since A2A callers are external agents, not browser sessions.

**Auth flow:**

1. On connection creation, generate a random API key (`a2a_sk_<random>`), encrypt it via `getEncryptionService().encryptForTenant()`, store in `encryptedCredentials`.
2. Return the plaintext key once to the creator (Studio UI shows it, user copies it).
3. On inbound request, require `Authorization: Bearer <key>` header. Decrypt `encryptedCredentials` from the connection, compare via `timingSafeEqual`.
4. Publish the `authentication` block in the agent card so callers know to send a bearer token.

### Files to Modify

| File                                                                        | Change                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/manifest.ts:435`                                 | Set `requiredCredentials: ['apiKey']`                                                     |
| `packages/a2a/src/infrastructure/express-handlers.ts`                       | Add `authenticateA2ARequest` middleware before `resolveConnection` in the chain           |
| `apps/runtime/src/server.ts:649`                                            | Pass auth config (encryption service, logger) into `createA2AExpressHandlers`             |
| `apps/runtime/src/services/a2a/agent-card-builder.ts:104`                   | Add `authentication: { schemes: ['bearer'] }` to card output                              |
| `apps/runtime/src/routes/channel-connections.ts`                            | On A2A connection create, auto-generate key, encrypt, store; return plaintext in response |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx:1355` | Set `hasCredentials: true`, add `credentialFields` for the generated key display          |

### Implementation Steps

1. **Add key generation to connection creation** (`channel-connections.ts`):
   - In the POST handler, when `channelType === 'a2a'`, generate `a2a_sk_${crypto.randomBytes(32).toString('hex')}`.
   - Encrypt via `getEncryptionService().encryptForTenant(tenantId, plainKey)`.
   - Store in `encryptedCredentials`.
   - Include `{ generatedApiKey: plainKey }` in the creation response (one-time reveal).

2. **Add auth middleware** (`express-handlers.ts`):
   - New `authenticateA2ARequest` middleware inserted after `resolveConnection` (needs connection data).
   - Extract `Authorization: Bearer <token>` from headers.
   - Decrypt `connection.encryptedCredentials` using the encryption service.
   - Compare with `crypto.timingSafeEqual`. Return 401 on mismatch.
   - Skip auth for `GET /.well-known/agent-card.json` (agent card is public per A2A spec).

3. **Update express-handlers config interface** to accept `decryptCredential: (connectionId: string, encryptedCreds: string) => Promise<string>`.

4. **Update server.ts** to pass `decryptCredential` callback that uses `getEncryptionService().decryptForTenant()`.

5. **Update agent card** to include authentication scheme so callers know how to authenticate.

6. **Update manifest** `requiredCredentials` so Studio shows the credential in the connection config.

7. **Update Studio channel registry** to show the generated API key on creation (read-only, copy-to-clipboard).

### Integration Tests

```
File: packages/a2a/src/__tests__/a2a-auth-integration.test.ts
```

| #   | Test Case                                                                     | Assertion                                                               |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Request without Authorization header → 401                                    | Response status 401, body `{ error: 'Authentication required' }`        |
| 2   | Request with invalid bearer token → 401                                       | Response status 401, body `{ error: 'Invalid credentials' }`            |
| 3   | Request with valid bearer token → 200 (passes through to handler)             | `resolveConnection` and handler are called, context is populated        |
| 4   | Agent card endpoint (`/.well-known/agent-card.json`) without auth → 200       | Card is returned without requiring credentials                          |
| 5   | SSE endpoint without auth → 401                                               | SSE connection rejected                                                 |
| 6   | Inactive connection with valid auth → 410                                     | Auth passes but connection status check still returns 410               |
| 7   | Missing connection with valid-format auth → 404                               | Connection not found, not 401 (no info leak about existence)            |
| 8   | Agent card includes `authentication.schemes: ['bearer']`                      | Card JSON has correct auth declaration                                  |
| 9   | Connection creation returns one-time `generatedApiKey`                        | POST response includes key, subsequent GETs do not expose it            |
| 10  | Key rotation: update connection credentials → old key rejected, new key works | PUT with new key, verify old fails and new passes                       |
| 11  | Timing-safe comparison: constant-time regardless of key prefix match          | No timing side-channel (validate implementation uses `timingSafeEqual`) |
| 12  | Rate limiting: >N failed auth attempts → 429                                  | Brute-force protection on auth failures                                 |

### Integration Checklist

- [ ] `POST /api/projects/:projectId/channel-connections` with `channelType: 'a2a'` generates and returns API key
- [ ] API key is encrypted at rest in `encryptedCredentials` field
- [ ] Plaintext key is NOT returned on subsequent GET requests
- [ ] `POST /a2a/:connectionId` without auth returns 401
- [ ] `POST /a2a/:connectionId` with wrong key returns 401
- [ ] `POST /a2a/:connectionId` with correct key returns 200 and processes JSON-RPC
- [ ] `GET /a2a/:connectionId/sse` without auth returns 401
- [ ] `GET /a2a/:connectionId/.well-known/agent-card.json` without auth returns 200 (public)
- [ ] Agent card JSON includes `authentication: { schemes: ['bearer'] }` block
- [ ] Failed auth does NOT reveal whether connection exists (404 vs 401 ordering)
- [ ] `manifest.ts` has `requiredCredentials: ['apiKey']` for A2A
- [ ] Studio shows generated API key on connection creation with copy button
- [ ] Key comparison uses `crypto.timingSafeEqual`, not `===`
- [ ] Auth middleware is positioned after `resolveConnection` (needs connection to decrypt)
- [ ] Existing A2A tests still pass (no regression)

---

## Finding 2 — Session Creation Race (P1, High)

### Problem

`resolveSessionId()` at `agent-executor-adapter.ts:353` does `resolve → createSession → register` non-atomically. Two concurrent first-turn requests with the same `contextId` both see `isNew: true`, both call `createSession`, and the second `SET` at `redis-a2a-session-resolver.ts:57` silently overwrites the first mapping. One session becomes orphaned.

### Design

Use Redis `SET NX` for atomic claim. The first writer wins; the second detects the conflict and reads the winner's session ID.

### Files to Modify

| File                                                               | Change                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `packages/a2a/src/infrastructure/redis-a2a-session-resolver.ts:55` | Change `registerSession` to use `SET NX`, add `claimSession` method                                |
| `packages/a2a/src/infrastructure/memory-a2a-session-resolver.ts`   | Mirror atomic claim semantics with in-memory CAS                                                   |
| `packages/a2a/src/domain/ports.ts:67`                              | Add `claimSession` to `A2ASessionResolverPort` (returns `{ claimed: boolean; sessionId: string }`) |
| `packages/a2a/src/infrastructure/agent-executor-adapter.ts:353`    | Replace `registerSession` with `claimSession`, handle conflict                                     |

### Implementation Steps

1. **Add `claimSession` to the port interface** (`ports.ts`):

   ```typescript
   claimSession(contextId: string, tenantId: string, sessionId: string): Promise<{ claimed: boolean; sessionId: string }>;
   ```

2. **Implement in Redis resolver** (`redis-a2a-session-resolver.ts`):

   ```typescript
   async claimSession(contextId: string, tenantId: string, sessionId: string): Promise<{ claimed: boolean; sessionId: string }> {
     const k = this.key(tenantId, contextId);
     const result = await this.redis.set(k, sessionId, 'EX', this.ttlSeconds, 'NX');
     if (result === 'OK') return { claimed: true, sessionId };
     // Another request won — read the winner
     const existing = await this.redis.get(k);
     return { claimed: false, sessionId: existing! };
   }
   ```

3. **Implement in memory resolver** (`memory-a2a-session-resolver.ts`):
   - Check-and-set: if key exists and not expired, return existing. Otherwise write and return new.

4. **Update `resolveSessionId`** in `agent-executor-adapter.ts`:

   ```typescript
   const sessionId = await this.executionPort.createSession(context);
   const claim = await this.sessionResolver.claimSession(contextId, context.tenantId, sessionId);
   if (!claim.claimed) {
     // Another request won the race — use their session, ours is orphaned
     // Optionally: clean up the orphaned session we just created
     return claim.sessionId;
   }
   return sessionId;
   ```

5. **Keep `registerSession` for backward compat** but deprecate it. New code uses `claimSession`.

### Integration Tests

```
File: packages/a2a/src/__tests__/session-race-integration.test.ts
```

| #   | Test Case                                                                                 | Assertion                                                        |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Two concurrent first-turn requests with same `contextId` → both resolve to same sessionId | `Promise.all([resolve, resolve])` returns identical session IDs  |
| 2   | First writer wins the claim                                                               | `claimSession` returns `{ claimed: true }` for first call        |
| 3   | Second writer loses the claim and gets winner's sessionId                                 | `claimSession` returns `{ claimed: false, sessionId: <winner> }` |
| 4   | After race, subsequent requests resolve to the winning session                            | Third request sees `isNew: false`, correct sessionId             |
| 5   | Race with Redis resolver (mock Redis with artificial delay)                               | SET NX semantics hold under concurrent writes                    |
| 6   | Race with memory resolver                                                                 | Same semantics as Redis variant                                  |
| 7   | Different `contextId` values in parallel → separate sessions                              | No cross-contamination between contexts                          |
| 8   | Different `tenantId` same `contextId` → separate sessions                                 | Tenant isolation holds under concurrency                         |
| 9   | `claimSession` on Redis failure → throws (does not silently create duplicate)             | Error propagated, caller can retry or fail                       |
| 10  | Orphaned session created by loser is identifiable for cleanup                             | Log or metric emitted when claim fails indicating orphan         |
| 11  | TTL set on winning claim                                                                  | `TTL` check on Redis key returns expected value                  |
| 12  | 10 concurrent first-turn requests → exactly 1 session created                             | `createSession` call count = N, but all resolve to same ID       |

### Integration Checklist

- [ ] `redis-a2a-session-resolver.claimSession` uses `SET NX PX` (not plain `SET`)
- [ ] `memory-a2a-session-resolver.claimSession` uses check-and-set (no TOCTOU)
- [ ] `resolveSessionId` calls `claimSession` instead of `registerSession`
- [ ] Losing writer returns the winning sessionId (not its own)
- [ ] Orphaned sessions are logged at warn level with sessionId for cleanup
- [ ] TTL is applied on the winning claim
- [ ] Tenant isolation: `SET NX` key includes tenantId
- [ ] `resolveSession` still returns `isNew: false` for already-claimed contexts
- [ ] `touchSession` still refreshes TTL on existing mappings
- [ ] `closeSession` still deletes the mapping
- [ ] Port interface `A2ASessionResolverPort` includes `claimSession`
- [ ] Backward compat: `registerSession` still works (overwrite behavior) for non-race scenarios
- [ ] All existing session resolver tests pass without modification
- [ ] Redis failure in `claimSession` throws (not silently succeeds)
- [ ] Metric or structured log emitted on race detection

---

## Finding 3 — Studio Agent Enrichment (P2, Medium-High)

### Problem

`useSessionDetail.ts:181` fetches `/api/runtime/agents/${name}?projectId=...` — a route that doesn't exist in Studio's Next.js API. The runtime's `/api/agents/:name` at `routes/agents.ts:126` is tenant-scoped only, so even a proxy would be ambiguous when duplicate agent names exist across projects. The fetch silently fails and session detail degrades to string-only agent data.

### Design

Use the existing project-scoped Studio API route at `/api/projects/[id]/agents/[agentId]/route.ts` which already does `findProjectAgent(projectId, agentName, tenantId)`. This is project-scoped and unambiguous.

### Files to Modify

| File                                            | Change                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/hooks/useSessionDetail.ts:181` | Change fetch URL from `/api/runtime/agents/${name}?projectId=...` to `/api/projects/${projectId}/agents/${name}` |

### Implementation Steps

1. **Fix the fetch URL** in `useSessionDetail.ts`:
   - Change: `/api/runtime/agents/${encodeURIComponent(resolvedAgentName)}?projectId=${urlProjectId}`
   - To: `/api/projects/${urlProjectId}/agents/${encodeURIComponent(resolvedAgentName)}`

2. **Verify response shape**: The project-scoped route returns `{ agent }`. The existing code already handles `agentData.agent || agentData`, so this should work without further changes.

3. **Handle A2A remote agents**: For A2A handoff sessions, the `agent` field may be a remote agent name not present in the local project. The catch block already handles this gracefully. Consider adding a debug log so it's visible when enrichment fails for remote agents.

### Integration Tests

```
File: apps/studio/src/__tests__/session-agent-enrichment.test.ts
```

| #   | Test Case                                                                | Assertion                                                |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1   | Session with string agent name + valid projectId → enriched agent object | `agentObject` has DSL/IR data, not just string name      |
| 2   | Session with string agent name + invalid projectId → graceful fallback   | `agentObject` is undefined, no error thrown              |
| 3   | Session with string agent name + missing agent → graceful fallback       | 404 from API is caught, session still renders            |
| 4   | Session with object agent (already enriched) → no fetch made             | No API call when agent is already an object              |
| 5   | Session with `agent: 'Unknown'` → no fetch made                          | Short-circuit for unknown agent                          |
| 6   | A2A remote agent name not in local project → graceful fallback           | Fetch returns 404, session renders with string agent     |
| 7   | Duplicate agent names across projects → correct one resolved             | Project-scoped route returns the correct project's agent |
| 8   | Network error during fetch → graceful fallback                           | Catch block fires, session still usable                  |
| 9   | Response shape `{ agent: {...} }` is correctly unpacked                  | `agentObject` matches `agentData.agent`                  |
| 10  | Agent with DSL content populates session detail observatory              | DSL/IR data available for DebugTabs rendering            |

### Integration Checklist

- [ ] `useSessionDetail.ts` fetches `/api/projects/${projectId}/agents/${name}`, NOT `/api/runtime/agents/...`
- [ ] Fetch URL uses `encodeURIComponent` for agent name
- [ ] 404 response is handled gracefully (no console error, no UI break)
- [ ] 403 response is handled gracefully (user lacks permission for that project)
- [ ] Network failure is handled gracefully
- [ ] Already-enriched agent objects (typeof === 'object') skip the fetch
- [ ] Agent name 'Unknown' skips the fetch
- [ ] Missing projectId in URL skips the fetch
- [ ] Response shape `{ agent }` is correctly destructured
- [ ] Session detail page renders correctly with string-only agent data
- [ ] Session detail page renders correctly with enriched agent data
- [ ] A2A remote agent sessions degrade gracefully (string-only, no error)

---

## Finding 4 — Rich History Degradation (P2, Medium)

### Problem

The outbound side builds `Array<{ role: string; content: MessageContent }>` where `MessageContent = string | ContentBlock[]` at `routing-executor.ts:913`. The inbound side at `agent-executor-adapter.ts:164` casts to `Array<{ role: string; content: string }>` and interpolates directly. Any `ContentBlock[]` turns stringify to `[object Object]`.

### Design

Serialize `ContentBlock[]` to text on the **outbound side** before placing history on the message metadata. This is the right place because:

- The outbound side has access to `contentToString()` (already exists at `routing-executor.ts:143`).
- The inbound side is in the generic `@agent-platform/a2a` package and shouldn't depend on runtime types.

### Files to Modify

| File                                                          | Change                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/routing-executor.ts:968` | Serialize history entries through `contentToString()` before attaching to metadata |

### Implementation Steps

1. **Serialize history before sending** (`routing-executor.ts`, around line 968):

   ```typescript
   const serializedHistory = historyMessages?.map((m) => ({
     role: m.role,
     content: contentToString(m.content),
   }));
   ```

   Then use `serializedHistory` in the `metadata: { history: serializedHistory }` block.

2. **Verify `contentToString`** handles all `ContentBlock` variants:
   - `{ type: 'text', text: string }` → extract text
   - `{ type: 'image', ... }` → placeholder like `[image]`
   - `{ type: 'tool_use', ... }` → `[tool_call: name]`
   - `{ type: 'tool_result', ... }` → extract text content

3. **Update inbound type assertion** in `agent-executor-adapter.ts:164` to add a runtime guard:
   ```typescript
   const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
   ```
   This is a safety net — the outbound side should always send strings, but the inbound side shouldn't crash if it receives unexpected types.

### Integration Tests

```
File: packages/a2a/src/__tests__/history-fidelity-integration.test.ts
```

| #   | Test Case                                                                 | Assertion                                             |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | Plain string history survives round-trip                                  | Inbound adapter receives identical text               |
| 2   | `ContentBlock[]` with text blocks → serialized to joined text             | No `[object Object]` in received history              |
| 3   | Mixed string and ContentBlock history entries → all serialized            | Each entry is a string on the inbound side            |
| 4   | Image content block → `[image]` placeholder (not dropped)                 | Placeholder preserved in history text                 |
| 5   | Tool use content block → `[tool_call: name]` placeholder                  | Tool context preserved as text hint                   |
| 6   | Empty history array → no `[Conversation History]` prefix                  | Message text is unchanged                             |
| 7   | `history: undefined` → no history injected                                | Clean message without prefix                          |
| 8   | History with 50+ turns → all preserved, correctly ordered                 | Turn count and ordering verified                      |
| 9   | History with special characters (newlines, brackets) → no corruption      | Content is intact after serialization                 |
| 10  | `summary_only` strategy → no history sent (verify current behavior)       | `historyMessages` is undefined                        |
| 11  | `{ last_n: 3 }` strategy → exactly 3 most recent turns                    | Slice is correct                                      |
| 12  | Inbound safety net: non-string content received → JSON.stringify fallback | No crash, structured content preserved as JSON string |

### Integration Checklist

- [ ] `contentToString` is called on every history entry before attaching to metadata
- [ ] `contentToString` handles `type: 'text'` blocks (extracts `.text`)
- [ ] `contentToString` handles `type: 'image'` blocks (returns placeholder)
- [ ] `contentToString` handles `type: 'tool_use'` blocks (returns placeholder with tool name)
- [ ] `contentToString` handles `type: 'tool_result'` blocks (extracts text content)
- [ ] Outbound metadata type is `Array<{ role: string; content: string }>` (all strings)
- [ ] Inbound adapter has runtime guard against non-string content (safety net)
- [ ] `[object Object]` does NOT appear in any history forwarding scenario
- [ ] `summary_only` strategy correctly results in no history (existing behavior)
- [ ] `full` strategy sends all conversation turns
- [ ] `{ last_n }` strategy sends correct slice
- [ ] `none` strategy (default) sends no history
- [ ] History injection prefix `[Conversation History]` only appears when history exists
- [ ] Existing task-lifecycle-integration.test.ts history tests still pass

---

## Finding 5 — Studio A2A Endpoint UX (P1, Medium)

### Problem

Studio asks for an "Agent Endpoint Name" but the actual A2A URL uses `connection._id`. `webhookPathPattern: null` and `hasWebhookUrl: false` mean Studio never surfaces the real A2A endpoint URL. Users create an A2A connection but cannot discover or share the endpoint.

### Design

Surface A2A URLs in the same way as webhook channels, with two adjustments:

1. A2A URL uses `connection._id` (not `externalIdentifier`), so `formatConnection` needs an A2A-specific path.
2. The A2A endpoint has two useful URLs: the JSON-RPC endpoint (`/a2a/{id}`) and the agent card (`/a2a/{id}/.well-known/agent-card.json`). Surface both.

### Files to Modify

| File                                                                        | Change                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/runtime/src/channels/manifest.ts:447`                                 | Set `webhookPathPattern: '/a2a/:connectionId'` (new placeholder) |
| `apps/runtime/src/channels/manifest.ts` (`buildWebhookUrl`)                 | Handle `:connectionId` placeholder substitution                  |
| `apps/runtime/src/routes/channel-connections.ts:233`                        | Pass `doc._id` for A2A connections to `getWebhookUrl`            |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx:1355` | Set `hasWebhookUrl: true`, update labels                         |
| `apps/studio/src/components/deployments/channels/tabs/OverviewTab.tsx`      | Show A2A-specific URLs (endpoint + agent card)                   |

### Implementation Steps

1. **Update manifest** (`manifest.ts`):
   - Set `webhookPathPattern: '/a2a/:connectionId'` for the A2A channel.

2. **Update `buildWebhookUrl`** to handle `:connectionId` placeholder:

   ```typescript
   if (pattern.includes(':connectionId')) {
     return `${baseUrl}${pattern.replace(':connectionId', connectionId)}`;
   }
   ```

3. **Update `formatConnection`** (`channel-connections.ts`):
   - For A2A type, call `getWebhookUrl` with `doc._id` as the identifier (instead of `doc.externalIdentifier`).
   - Add `agentCardUrl` as `${webhookUrl}/.well-known/agent-card.json` in the response.

4. **Update Studio channel registry** (`channel-registry.tsx`):
   - Set `hasWebhookUrl: true`.
   - Update webhook label to "A2A Endpoint URL".
   - Keep `externalIdentifierLabel: 'Agent Endpoint Name'` as a human-friendly name (used in agent card `name` field).

5. **Update OverviewTab** (`OverviewTab.tsx`):
   - For A2A channels, show two copyable fields: "A2A Endpoint" and "Agent Card URL".
   - Add a note: "Share the Agent Card URL with other agents for discovery."

### Integration Tests

```
File: apps/runtime/src/__tests__/a2a-endpoint-url.test.ts
```

| #   | Test Case                                                                     | Assertion                                         |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `buildWebhookUrl('a2a', connectionId)` returns `/a2a/{connectionId}` path     | URL matches expected pattern                      |
| 2   | `formatConnection` for A2A includes `webhookUrl` with base URL + `/a2a/{id}`  | Non-null, correct format                          |
| 3   | `formatConnection` for A2A includes `agentCardUrl`                            | Ends with `/.well-known/agent-card.json`          |
| 4   | `formatConnection` for non-A2A channels unchanged                             | Regression: Slack/Telegram URLs still correct     |
| 5   | `GET /api/projects/:pid/channel-connections` returns A2A connection with URLs | API response has both URLs                        |
| 6   | `RUNTIME_PUBLIC_BASE_URL` is used for A2A URL when set                        | Public URL preferred over internal                |
| 7   | No `RUNTIME_PUBLIC_BASE_URL` → fallback to `RUNTIME_BASE_URL`                 | Fallback chain works                              |
| 8   | Agent card URL matches what `agent-card-builder.ts` serves                    | Consistency between computed URL and actual route |
| 9   | Connection with custom `externalIdentifier` → URL still uses `_id`            | externalIdentifier is display-only for A2A        |
| 10  | Multiple A2A connections → each has unique URL                                | No collision between connections                  |

### Integration Checklist

- [ ] `manifest.ts` A2A entry has `webhookPathPattern: '/a2a/:connectionId'`
- [ ] `buildWebhookUrl` handles `:connectionId` placeholder
- [ ] `formatConnection` passes `doc._id` (not `externalIdentifier`) for A2A
- [ ] API response for A2A connections includes `webhookUrl`
- [ ] API response for A2A connections includes `agentCardUrl`
- [ ] Studio channel registry has `hasWebhookUrl: true` for A2A
- [ ] OverviewTab renders the A2A endpoint URL as a copyable field
- [ ] OverviewTab renders the agent card URL as a copyable field
- [ ] URL uses `RUNTIME_PUBLIC_BASE_URL` when available
- [ ] Non-A2A channel URLs are unchanged (regression check)
- [ ] `externalIdentifierLabel` remains "Agent Endpoint Name" (human-friendly name)
- [ ] Agent card served at the computed URL matches the connection's card

---

## Bonus Finding — Route Ordering Bug

### Problem (discovered during exploration)

`a2aHandlers.setupRoutes(app)` at `server.ts:683` registers `/a2a/:connectionId` before the callback router at `/a2a/callbacks/:callbackId` (line 916). Express matches top-down, so `/a2a/callbacks` is captured as `connectionId="callbacks"`, and `resolveConnection` returns 404 (no connection with that ID), blocking the callback route entirely.

### Fix

Mount the callback router BEFORE `a2aHandlers.setupRoutes(app)`, or change the callback path to a non-overlapping prefix (e.g., `/a2a-callbacks/:callbackId`).

### Integration Checklist

- [ ] `POST /a2a/callbacks/:callbackId` is reachable and not intercepted by A2A connection router
- [ ] `POST /a2a/:connectionId` still works for valid connection IDs
- [ ] Route registration order verified: callbacks before connection-scoped routes
- [ ] Existing callback tests pass

---

## Execution Order

```
Phase 1 (Week 1): Finding 1 (Auth) — security blocker
Phase 2 (Week 1): Finding 2 (Session Race) — small fix, high impact
Phase 2 (Week 1): Bonus (Route Ordering) — quick fix, blocks callbacks
Phase 3 (Week 2): Finding 5 (Studio Endpoint UX) — unblocks adoption
Phase 3 (Week 2): Finding 4 (History Fidelity) — small fix
Phase 4 (Week 2): Finding 3 (Agent Enrichment) — one-line fix, needs verification
```

## Test Commands

```bash
# A2A package tests
pnpm --filter @agent-platform/a2a exec vitest run

# Runtime tests (for auth + endpoint URL)
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/a2a-auth-integration.test.ts
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/a2a-endpoint-url.test.ts

# Studio tests (for agent enrichment + UX)
pnpm --filter @agent-platform/studio exec vitest run src/__tests__/session-agent-enrichment.test.ts

# Full regression
pnpm build && pnpm test
```
