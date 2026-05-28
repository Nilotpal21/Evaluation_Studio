# Runtime Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.**
>
> **Run `npx prettier --write <files>` on ALL changed files before finishing your task. lint-staged WILL silently revert your work if files aren't formatted.**

**Goal:** Fix 27 verified security findings (5 CRITICAL, 10 HIGH, 12 MEDIUM) across the runtime, adding regression tests for each fix.

**Architecture:** Defense-in-depth — make tenantId required at the repo/store layer (not just route), add SSRF guards on all outbound URLs, enforce size/rate limits on all WebSocket and in-memory data structures, and replace `node:vm` with safe regex-only validators.

**Tech Stack:** TypeScript, Vitest, MongoDB/Mongoose, Express, `ws` library, `@agent-platform/shared-kernel` SSRF utilities.

---

## Chunk 1: Tenant Isolation — Repo & Store Layer (CRIT-4, H-1, H-2, H-3, H-9)

These are the highest-impact fixes. Every repo function that accepts an optional `tenantId` and conditionally applies it is a cross-tenant data leak waiting for a caller to pass `""` or `undefined`.

### Task 1.1: Make `tenantId` Required in `session-repo.ts`

**Files:**

- Modify: `apps/runtime/src/repos/session-repo.ts` (lines 11-137)
- Modify: `apps/runtime/src/__tests__/repos-session.test.ts`
- Create: `apps/runtime/src/__tests__/session-repo-isolation.test.ts`

**Context:** 7 functions use `if (tenantId) filter.tenantId = tenantId` — all must be fixed. For `deleteSessionsByIds`, create an explicit `deleteSessionsByIdsSystem` variant for system cleanup jobs that legitimately have no tenant context.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/repos-session.test.ts` — any test calling these functions without tenantId will break
- `apps/runtime/src/__tests__/sessions-authz.test.ts` — should still pass (already provides tenantId via auth context)
- `apps/runtime/src/__tests__/session-routes.test.ts` — may need tenantId added to mock calls
- `apps/runtime/src/__tests__/session-ownership-authz.test.ts` — should pass

- [ ] **Step 1: Write failing isolation tests**

Create `apps/runtime/src/__tests__/session-repo-isolation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database models
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  Session: {
    findOne: (...args: unknown[]) => ({ select: () => ({ lean: mockFindOne }) }),
    findOneAndUpdate: (...args: unknown[]) => ({ lean: mockFindOneAndUpdate }),
  },
}));

import {
  findSessionById,
  findSessionByRuntimeId,
  updateSession,
  updateSessionActivity,
  incrementSessionTokens,
  incrementSessionMetrics,
} from '../repos/session-repo.js';

describe('session-repo tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findSessionById always includes tenantId in filter', async () => {
    mockFindOne.mockResolvedValue(null);
    await findSessionById('sess-1', 'tenant-1');
    const call = mockFindOne.mock.calls[0];
    // The filter passed to findOne must include tenantId
    // We need to verify via the spy on Session.findOne
  });

  it('findSessionById rejects empty-string tenantId', async () => {
    await expect(findSessionById('sess-1', '')).rejects.toThrow();
  });

  it('findSessionByRuntimeId rejects empty-string tenantId', async () => {
    await expect(findSessionByRuntimeId('rt-1', '')).rejects.toThrow();
  });

  it('updateSession rejects empty-string tenantId', async () => {
    await expect(updateSession('sess-1', { status: 'closed' }, '')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/session-repo-isolation.test.ts`
Expected: FAIL — functions currently accept empty string without throwing.

- [ ] **Step 3: Fix all 7 functions in `session-repo.ts`**

For each function (`findSessionById`, `findSessionByRuntimeId`, `updateSession`, `updateSessionActivity`, `incrementSessionTokens`, `incrementSessionMetrics`, `unlinkContactFromSessions`):

1. Change `tenantId?: string` to `tenantId: string`
2. Add guard: `if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');`
3. Remove the `if (tenantId)` conditional — always set `filter.tenantId = tenantId`

Example for `findSessionById`:

```typescript
export async function findSessionById(id: string, tenantId: string): Promise<any | null> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const doc = await Session.findOne({ _id: id, tenantId }).select('-context -metadata').lean();
  return doc ? { ...doc, id: (doc as any)._id } : null;
}
```

For `deleteSessionsByIds` (line 306), keep optional tenantId but rename the unscoped path:

```typescript
export async function deleteSessionsByIds(ids: string[], tenantId: string): Promise<void> {
  if (!tenantId) throw new Error('tenantId is required');
  // ... scoped deletion
}

// Explicit system-level variant for retention cleanup
export async function deleteSessionsByIdsSystem(ids: string[]): Promise<void> {
  // ... unscoped (called only from retention-cleanup job)
}
```

- [ ] **Step 4: Fix callers that pass optional/empty tenantId**

Search for all callers: `grep -rn 'findSessionById\|findSessionByRuntimeId\|updateSession\|updateSessionActivity\|incrementSessionTokens\|incrementSessionMetrics' apps/runtime/src/ --include='*.ts' | grep -v '__tests__' | grep -v 'session-repo.ts'`

For each caller, ensure tenantId is passed from `req.tenantContext!.tenantId` or the session's own `tenantId`. If a caller legitimately has no tenantId (system job), switch it to use the `*System` variant (create one if needed for that function).

- [ ] **Step 5: Run all session tests**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/session-repo-isolation.test.ts src/__tests__/repos-session.test.ts src/__tests__/sessions-authz.test.ts src/__tests__/session-routes.test.ts src/__tests__/session-ownership-authz.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/repos/session-repo.ts apps/runtime/src/__tests__/session-repo-isolation.test.ts
git add apps/runtime/src/repos/session-repo.ts apps/runtime/src/__tests__/session-repo-isolation.test.ts
git commit -m "fix(runtime): make tenantId required in session-repo — prevent cross-tenant access on empty string"
```

---

### Task 1.2: Add Tenant Scoping to Contact Store (H-1)

**Files:**

- Modify: `apps/runtime/src/routes/contacts.ts` (lines 264, 306, 353, 410)
- Modify: `apps/runtime/src/__tests__/contacts-authz.test.ts`
- Create: `apps/runtime/src/__tests__/contacts-tenant-isolation.test.ts`

**Context:** GET/PUT/DELETE `/:id` all call `store.getById(id)` without tenantId. The store's `getById` method needs tenantId, and the route handlers need to pass it.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/contacts-authz.test.ts` — may need updates if store mock signatures change
- `apps/runtime/src/__tests__/contact-routes.test.ts` — will need tenantId in mock calls

- [ ] **Step 1: Write failing test for cross-tenant contact access**

Create `apps/runtime/src/__tests__/contacts-tenant-isolation.test.ts` that verifies:

- GET `/:id` returns 404 when contact belongs to different tenant
- PUT `/:id` returns 404 when contact belongs to different tenant
- DELETE `/:id` returns 404 when contact belongs to different tenant
- GET `/:id` succeeds when contact belongs to same tenant

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Update route handlers to pass tenantId**

In `routes/contacts.ts`, for each of GET/PUT/DELETE `/:id`:

```typescript
// Before:
const contact = await store.getById(req.params.id);

// After:
const contact = await store.getById(req.params.id, req.tenantContext!.tenantId);
```

Also fix `POST /:id/link-session` handler at line 410 — it calls `contactStore.getById(req.params.id)` without tenantId:

```typescript
// Before:
const contact = await contactStore.getById(req.params.id);

// After:
const contact = await contactStore.getById(req.params.id, req.tenantContext!.tenantId);
```

Update the store interface to require tenantId in `getById`, `update`, and `softDelete`. The underlying query should be `findOne({ _id: id, tenantId })`.

- [ ] **Step 4: Run tests — verify pass**

Run: `cd apps/runtime && pnpm vitest run src/__tests__/contacts-tenant-isolation.test.ts src/__tests__/contacts-authz.test.ts src/__tests__/contact-routes.test.ts`

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/contacts.ts
git add apps/runtime/src/routes/contacts.ts apps/runtime/src/__tests__/contacts-tenant-isolation.test.ts
git commit -m "fix(runtime): scope contact CRUD by tenantId — prevent cross-tenant access"
```

---

### Task 1.3: Add Tenant Scoping to `connection-resolver.ts` (H-2)

**Files:**

- Modify: `apps/runtime/src/channels/connection-resolver.ts` (line 109)
- Create: `apps/runtime/src/__tests__/connection-resolver-isolation.test.ts`

**Context:** `resolveConnectionById(connectionId)` has no tenantId parameter. The comment at line 47-48 says "external agents calling back have no auth context" — but many callers DO have auth context. Add an optional tenantId param; when provided, scope the query.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/channel-connections-authz.test.ts` — should still pass

- [ ] **Step 1: Write failing test**

```typescript
describe('resolveConnectionById tenant isolation', () => {
  it('scopes query by tenantId when provided', async () => {
    // Create mock connection for tenant-A
    // Call resolveConnectionById(connId, 'tenant-B')
    // Expect null (not found)
  });

  it('returns connection when tenantId matches', async () => {
    // Call resolveConnectionById(connId, 'tenant-A')
    // Expect the connection
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add tenantId parameter to `resolveConnectionById`**

```typescript
export async function resolveConnectionById(
  connectionId: string,
  tenantId?: string,
): Promise<ResolvedConnection | null> {
  const filter: Record<string, unknown> = { _id: connectionId };
  if (tenantId) filter.tenantId = tenantId;
  const connection = await ChannelConnection.findOne(filter).lean();
  // ...
}
```

Update all callers that have tenant context (e.g., channel pipeline, session handlers) to pass tenantId. Leave callback-initiated paths (no auth context) passing no tenantId.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

---

### Task 1.4: Add Tenant Scoping to `tenant-model-repo.ts` (H-3)

**Files:**

- Modify: `apps/runtime/src/repos/tenant-model-repo.ts` (lines ~112, ~133)
- Modify: `apps/runtime/src/__tests__/tenant-models-authz.test.ts`
- Create: `apps/runtime/src/__tests__/tenant-model-repo-isolation.test.ts`

**Context:** `findTenantModelConnections` and `createTenantModelConnection` use `findById`/`findByIdAndUpdate` without tenantId.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/tenant-models-authz.test.ts`
- `apps/runtime/src/__tests__/tenant-models.test.ts`
- `apps/runtime/src/__tests__/tenant-model-routes.test.ts`

- [ ] **Step 1: Write failing isolation test**
- [ ] **Step 2: Run test — verify fail**
- [ ] **Step 3: Add tenantId to both functions**

```typescript
export async function findTenantModelConnections(
  tenantModelId: string,
  tenantId: string,
  opts?: { limit?: number },
): Promise<any[]> {
  if (!tenantId) throw new Error('tenantId is required');
  const doc = await TenantModel.findOne(
    { _id: tenantModelId, tenantId },
    { connections: 1 },
  ).lean();
  // ...
}

export async function createTenantModelConnection(data: {
  tenantModelId: string;
  tenantId: string; /* ... */
}): Promise<any> {
  if (!data.tenantId) throw new Error('tenantId is required');
  const updated = await TenantModel.findOneAndUpdate(
    { _id: data.tenantModelId, tenantId: data.tenantId },
    { $push: { connections: connectionData } },
    { new: true },
  ).lean();
  // ...
}
```

Also fix `findTenantModel` and `updateTenantModel` — make tenantId required, remove the `findById` fallback.

- [ ] **Step 4: Fix callers — pass tenantId from route/session context**
- [ ] **Step 5: Run tests — verify pass**
- [ ] **Step 6: Commit**

---

### Task 1.5: Add Tenant Scoping to `MongoMessageStore.getMessages` (H-9)

**Files:**

- Modify: `apps/runtime/src/services/stores/mongo-message-store.ts` (lines 138-165)
- Modify: `packages/compiler/src/platform/stores/message-store.ts` (base interface)
- Create: `apps/runtime/src/__tests__/mongo-message-store-isolation.test.ts`

**Context:** `getMessages` builds filter using only `sessionId`. The `QueryMessagesParams` interface has NO `tenantId` field — it must be added as a required field. Also update the abstract `MessageStore` class and `InMemoryMessageStore` implementation.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/mongo-message-store-scrub.test.ts`
- `apps/runtime/src/__tests__/dual-write-message-store.test.ts`

- [ ] **Step 1: Write failing test**

Test that `getMessages({ sessionId: 'x' })` without tenantId throws, and that `getMessages({ sessionId: 'x', tenantId: 'tenant-A' })` includes tenantId in the MongoDB filter.

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Update `getMessages` to require and apply tenantId**

```typescript
async getMessages(params: QueryMessagesParams): Promise<Message[]> {
  if (!params.tenantId) {
    throw new Error('tenantId is required for tenant-scoped message queries');
  }
  const filter: Record<string, any> = {
    sessionId: params.sessionId,
    tenantId: params.tenantId,
  };
  // ...rest unchanged
}
```

Add `tenantId: string` as a **required** field on `QueryMessagesParams` in `packages/compiler/src/platform/stores/message-store.ts`. Making it required at the interface level ensures every `MessageStore` implementation must accept it — no future store can silently skip tenant isolation.

**All three implementations need updating:**

1. **`MongoMessageStore.getMessages`** — add `tenantId` to the MongoDB filter (the fix above).
2. **`InMemoryMessageStore.getMessages`** — accept the param; no filtering needed (single-tenant dev store, messages are keyed by sessionId only). Just update the signature to satisfy the interface contract.
3. **`ClickHouseMessageStore.getMessages`** — already uses `this.tenantId` from constructor. Optionally cross-check `params.tenantId === this.tenantId` as defense-in-depth, or ignore the param since tenant is baked into the store instance.

Also update callers: `getMessages({ sessionId })` → `getMessages({ sessionId, tenantId })` everywhere.

- [ ] **Step 4: Fix callers** — search for all `getMessages(` calls and ensure tenantId is passed.
- [ ] **Step 5: Run tests — verify pass**
- [ ] **Step 6: Commit**

---

### Task 1.6: Verify Tenant Scoping in `MongoConversationStore` (G2)

**Files:**

- Audit: `apps/runtime/src/services/stores/mongo-conversation-store.ts`
- Create: `apps/runtime/src/__tests__/mongo-conversation-store-isolation.test.ts`

**Context:** `MongoConversationStore` uses ALS-based tenant isolation via a `withTenant()` wrapper and a Mongoose tenant-isolation plugin — NOT explicit tenantId parameters like session-repo. However, individual methods use `findById(sessionId)` internally, and the Mongoose plugin may or may not inject tenantId into `findById` queries. This task audits whether the plugin is correctly scoping all queries and adds tests to verify.

- [ ] **Step 1: Read `mongo-conversation-store.ts` and trace the `withTenant()` + Mongoose plugin flow**

Verify whether `findById()` calls (lines ~154, 184, 208, 227, 277, 329, 344, 359, 369, 378) are being scoped by the tenant plugin. If the plugin intercepts `findById` and adds tenantId to the filter, no code change is needed — only tests. If not, replace `findById` with `findOne({ _id, tenantId })`.

- [ ] **Step 2: Write isolation test**

Create `apps/runtime/src/__tests__/mongo-conversation-store-isolation.test.ts` that verifies a session created by tenant-A is NOT accessible when the ALS context is set to tenant-B.

- [ ] **Step 3: Run test — verify behavior**
- [ ] **Step 4: Fix any unscoped queries found in Step 1**
- [ ] **Step 5: Run tests — verify pass**
- [ ] **Step 6: Commit**

---

## Chunk 2: Injection & Input Validation (CRIT-5, CRIT-6, M-6, M-7)

### Task 2.1: Fix `$regex` Injection in Sessions Bulk-Close (CRIT-5)

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts` (lines 524, 568-569)
- Create: `apps/runtime/src/__tests__/sessions-regex-injection.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/session-routes.test.ts`
- `apps/runtime/src/__tests__/sessions-authz.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('POST /bulk-close — regex injection prevention', () => {
  it('escapes regex metacharacters in agentName', async () => {
    // Send agentName: "^(a+)+$" — should be treated as literal string, not regex
    const res = await request(app)
      .post('/api/v1/sessions/bulk-close')
      .send({ agentName: '^(a+)+$', disposition: 'abandoned' });
    // Should not cause ReDoS — verify the query uses escaped string
  });

  it('rejects agentName exceeding max length', async () => {
    const res = await request(app)
      .post('/api/v1/sessions/bulk-close')
      .send({ agentName: 'a'.repeat(300), disposition: 'abandoned' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add `escapeRegex` helper and apply it**

```typescript
// In sessions.ts, add at top:
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// At line 524, add validation:
if (agentName && agentName.length > 200) {
  return res.status(400).json({
    success: false,
    error: { code: 'INVALID_INPUT', message: 'agentName exceeds max length (200)' },
  });
}

// At line 568-569, escape the value:
if (agentName) {
  where.currentAgent = { $regex: escapeRegex(agentName), $options: 'i' };
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 2.2: Validate Cursor Param in Contacts Route (CRIT-6)

**Files:**

- Modify: `apps/runtime/src/routes/contacts.ts` (lines 476, 494-495)
- Create: `apps/runtime/src/__tests__/contacts-cursor-validation.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/contact-routes.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('GET /contacts — cursor validation', () => {
  it('returns 400 for non-ISO cursor string', async () => {
    const res = await request(app).get('/api/contacts/contact-1/history?cursor=garbage');
    expect(res.status).toBe(400);
  });

  it('returns 400 for cursor that produces Invalid Date', async () => {
    const res = await request(app).get('/api/contacts/contact-1/history?cursor=__proto__');
    expect(res.status).toBe(400);
  });

  it('accepts valid ISO 8601 cursor', async () => {
    const res = await request(app).get(
      '/api/contacts/contact-1/history?cursor=2026-01-01T00:00:00.000Z',
    );
    expect(res.status).not.toBe(400);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add cursor validation**

```typescript
if (cursor) {
  const cursorDate = new Date(cursor);
  if (isNaN(cursorDate.getTime())) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_CURSOR', message: 'cursor must be a valid ISO 8601 date string' },
    });
  }
  filter.timestamp = { $lt: cursorDate };
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 2.3: Use Zod-Parsed Output in Workflows Create (M-6)

**Files:**

- Modify: `apps/runtime/src/routes/workflows.ts` (lines 188-192)
- Modify: `apps/runtime/src/__tests__/workflow-routes.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/workflow-routes.test.ts`
- `apps/runtime/src/__tests__/workflows-authz.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('ignores extra fields in request body (no prototype pollution)', async () => {
  const res = await request(app)
    .post('/api/v1/projects/proj-1/workflows')
    .send({ name: 'test', _id: 'injected-id', createdAt: '1970-01-01' });
  // _id should be auto-generated, not 'injected-id'
  expect(res.body.data._id).not.toBe('injected-id');
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace `...req.body` with parsed data**

```typescript
// Before:
const params = {
  ...req.body,
  projectId: req.params.projectId,
  tenantId: req.tenantContext!.tenantId,
};

// After — use only validated fields from Zod schema:
const validated = createWorkflowRequestSchema.parse(req.body);
const params = {
  ...validated,
  projectId: req.params.projectId,
  tenantId: req.tenantContext!.tenantId,
};
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 2.4: Validate Contact Query Params (M-7)

**Files:**

- Modify: `apps/runtime/src/routes/contacts.ts` (lines 178-184)
- Add to: `apps/runtime/src/__tests__/contacts-tenant-isolation.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('rejects invalid contact type', async () => {
  const res = await request(app).get('/api/v1/contacts?type={"$gt":""}');
  expect(res.status).toBe(400);
});

it('rejects non-numeric limit', async () => {
  const res = await request(app).get('/api/v1/contacts?limit=abc');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add validation**

```typescript
const VALID_CONTACT_TYPES = ['employee', 'customer', 'anonymous'] as const;

// Validate type
if (req.query.type && !VALID_CONTACT_TYPES.includes(req.query.type as any)) {
  return res.status(400).json({
    success: false,
    error: { code: 'INVALID_INPUT', message: 'type must be one of: employee, customer, anonymous' },
  });
}

// Validate limit/offset are positive integers
const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 1000)) {
  return res.status(400).json({
    success: false,
    error: { code: 'INVALID_INPUT', message: 'limit must be an integer between 1 and 1000' },
  });
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Chunk 3: WebSocket Security (CRIT-3, H-4, H-5, M-1, M-3)

### Task 3.1: Add Auth to Twilio Media WebSocket (CRIT-3)

**Files:**

- Modify: `apps/runtime/src/websocket/twilio-media-handler.ts` (lines 221-227)
- Modify: `apps/runtime/src/server.ts` (lines 1014-1017)
- Modify: `apps/runtime/src/__tests__/ws-twilio-handler.test.ts`
- Create: `apps/runtime/src/__tests__/ws-twilio-auth.test.ts`

**Context:** Twilio calls carry `customParameters` but there's no verification that tenantId/projectId are legitimate. The fix is to validate the session pre-exists (created by an authenticated HTTP call) or require a pre-auth token.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/ws-twilio-handler.test.ts` — tests for "start event" will need to provide valid pre-auth tokens or mock the validation

- [ ] **Step 1: Write failing auth test**

```typescript
describe('Twilio Media WS — authentication', () => {
  it('rejects start event with unknown sessionId (no pre-auth)', async () => {
    // Connect to /voice/media, send start with random tenantId
    // Expect connection closed with 1008 code
  });

  it('rejects start event when customParameters lack tenantId', async () => {
    // Connect to /voice/media, send start with customParameters missing tenantId
    // Expect connection closed with 1008 code
  });

  it('accepts start event with pre-authed sessionId', async () => {
    // Create session via authenticated HTTP call first
    // Connect and send start with that sessionId
    // Expect connection accepted
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add session pre-auth validation in `handleStreamStart`**

**Implementation note:** Check which ID type `customParameters.sessionId` contains. If it's a runtimeSessionId (the WS protocol ID), use `findSessionByRuntimeId`. If it's a MongoDB `_id`, use `findSessionById`. Read the Twilio integration setup code to determine which ID format callers pass.

After extracting `sessionId`, `tenantId`, `projectId` from `customParameters`:

```typescript
// Validate session exists and belongs to claimed tenant
if (sessionId && tenantId) {
  const existingSession = await findSessionByRuntimeId(sessionId, tenantId);
  if (!existingSession) {
    log.warn('Twilio media: session not found for tenant', { sessionId, tenantId, streamSid });
    ws.close(1008, 'Session not found');
    return createDisconnectedSession(ws, streamSid, callSid, sessionId);
  }
} else if (!tenantId || !projectId) {
  log.warn('Twilio media: missing tenantId or projectId', { streamSid });
  ws.close(1008, 'Missing required parameters');
  return createDisconnectedSession(ws, streamSid, callSid, sessionId);
}
```

- [ ] **Step 4: Update existing tests** to provide valid session context
- [ ] **Step 5: Run tests — verify pass**
- [ ] **Step 6: Commit**

---

### Task 3.2: Add Tenant Check to `subscribe_session` (H-4)

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts` (lines 1974-1992)
- Modify: `apps/runtime/src/__tests__/websocket-handler.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/websocket-handler.test.ts` — "subscribe_session dispatch" tests will need tenant context

- [ ] **Step 1: Write failing test**

```typescript
describe('subscribe_session — tenant isolation', () => {
  it('rejects subscription to session from different tenant', async () => {
    // Client authenticated as tenant-A
    // Sends subscribe_session for a session belonging to tenant-B
    // Expect error response, not trace events
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add tenant verification before subscribing**

**Implementation note:** Verify that the `clients` WeakMap/Map is accessible in `handleSubscribeSession` scope. It may be defined in a parent scope of handler.ts. If not directly accessible, pass it as a parameter or use a module-level accessor.

**Pre-implementation check:** Verify that `RuntimeSession` (or whatever type `getRuntimeExecutor().getSession()` returns) has a `tenantId` field. If not, the tenant check must use the DB fallback path for all cases. Read the `RuntimeSession` interface definition before implementing.

**Implementation note 2:** Verify that the `RuntimeSession` interface (from `getRuntimeExecutor().getSession()`) includes a `tenantId` field. If it doesn't, use `findSessionByRuntimeId(sessionId, clientTenantId)` for the DB check instead of comparing in-memory session fields.

In `handleSubscribeSession`:

```typescript
async function handleSubscribeSession(ws, message) {
  const { sessionId } = message;
  const clientTenantId = clients.get(ws)?.tenantId;

  // Verify session belongs to this tenant
  const executor = getRuntimeExecutor();
  const session = executor.getSession(sessionId);
  if (session && session.tenantId !== clientTenantId) {
    sendMessage(ws, { type: 'error', error: 'Session not found' });
    return;
  }

  // If session not in memory, check DB
  if (!session) {
    if (!clientTenantId) {
      sendMessage(ws, { type: 'error', error: 'Authentication required' });
      return;
    }
    const dbSession = await findSessionByRuntimeId(sessionId, clientTenantId);
    if (!dbSession) {
      sendMessage(ws, { type: 'error', error: 'Session not found' });
      return;
    }
  }

  const traceStore = getTraceStore();
  const result = await traceStore.subscribe(sessionId, ws);
  // ...
}
```

- [ ] **Step 4: Apply same pattern to `list_sessions`** — filter returned sessions by tenant
- [ ] **Step 5: Run tests — verify pass**
- [ ] **Step 6: Commit**

---

### Task 3.3: Add Tenant Check to `resume_session` In-Memory/Redis Paths (H-5)

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts` (lines 2053-2065)
- Modify: `apps/runtime/src/__tests__/websocket-handler.test.ts`

- [ ] **Step 1: Write failing test** — resume with sessionId from different tenant, expect rejection
- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add tenant check after in-memory and Redis rehydration**

```typescript
// After step 1 (in-memory) and step 2 (Redis rehydration):
if (runtimeSession) {
  const clientTenantId = clients.get(ws)?.tenantId;
  if (clientTenantId && runtimeSession.tenantId !== clientTenantId) {
    sendMessage(ws, { type: 'session_expired', sessionId });
    return;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 3.4: Fix `X-Forwarded-For` Spoofing in WS Rate Limiter (M-1)

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (lines 305-306)
- Modify: `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts` — "rate limiting" describe block

- [ ] **Step 1: Write failing test**

```typescript
it('uses socket remoteAddress when X-Forwarded-For is spoofed', () => {
  // Send WS upgrade with X-Forwarded-For: 'spoofed-ip'
  // Verify rate limiter uses req.socket.remoteAddress, not the header
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Parse X-Forwarded-For correctly**

```typescript
// Before:
const clientIp =
  (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';

// After — use rightmost non-private IP (added by trusted proxy):
function extractClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    // Use the LAST IP (closest proxy we trust), not the first (client-controlled)
    const ips = xff.split(',').map((s) => s.trim());
    // In most deployments, the rightmost IP is the one added by the load balancer
    return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

const clientIp = extractClientIp(req);
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 3.5: Set `maxPayload` on All WebSocket Servers (M-3)

**Files:**

- Modify: `apps/runtime/src/server.ts` (lines 882-885)
- Create: `apps/runtime/src/__tests__/ws-max-payload.test.ts`

- [ ] **Step 1: Write test**

```typescript
describe('WebSocket maxPayload enforcement', () => {
  it('disconnects client sending oversized frame on SDK WS', async () => {
    // Connect to /ws/sdk
    // Send a 600KB message
    // Expect connection closed
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add maxPayload to each WebSocket server**

```typescript
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 }); // 512 KB
const wssSDK = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 }); // 512 KB
const wssTwilioMedia = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64 KB
const wssAudioCodes = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }); // 256 KB
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Chunk 4: PII Sandbox & ReDoS (CRIT-7, CRIT-8)

### Task 4.1: Replace `node:vm` with Safe Regex-Only Validators (CRIT-7)

**Files:**

- Modify: `apps/runtime/src/services/pii/pattern-loader.ts` (lines 125-141)
- Modify: `apps/runtime/src/__tests__/pii-pattern-loader.test.ts`
- Create: `apps/runtime/src/__tests__/pii-sandbox-escape.test.ts`

**Context:** Rather than adding `isolated-vm` (a native dep with build complexity), the simpler fix is to restrict validators to regex-only expressions. The `validate` field is documented as a regex pattern; arbitrary JS expressions are unnecessary and dangerous.

**Note:** Do NOT replace `vm` with `new Function` constructor — it has the same escape issues. Regex-only is the correct approach since the `validate` field is documented as a regex pattern.

**Impacted existing tests:**

- `apps/runtime/src/__tests__/pii-pattern-loader.test.ts` — "buildSandboxedValidator" describe block

- [ ] **Step 1: Write failing escape test**

```typescript
describe('PII validator sandbox security', () => {
  it('rejects validator expressions that are not valid regex', () => {
    expect(() =>
      buildSandboxedValidator('this.constructor.constructor("return process")()'),
    ).toThrow();
  });

  it('rejects validator with function call syntax', () => {
    expect(() => buildSandboxedValidator('globalThis.process')).toThrow();
  });

  it('accepts valid regex validator', () => {
    const validator = buildSandboxedValidator('^[A-Z]{2}\\d{6}$');
    expect(validator('AB123456')).toBe(true);
    expect(validator('invalid')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace `vm.Script` with regex-only validator**

**Note:** `pattern-service.ts` (lines 24-30) already has `CATASTROPHIC_BACKTRACKING_PATTERNS`. Import and reuse those instead of defining a separate list, to avoid maintaining two backtracking detection lists:

```typescript
import { CATASTROPHIC_BACKTRACKING_PATTERNS } from './pattern-service.js';

function hasCatastrophicBacktracking(pattern: string): boolean {
  return CATASTROPHIC_BACKTRACKING_PATTERNS.some((cp) => cp.test(pattern));
}
```

If `CATASTROPHIC_BACKTRACKING_PATTERNS` is not exported, export it from `pattern-service.ts` first.

```typescript
export function buildSandboxedValidator(expression: string): (value: string) => boolean {
  // Only allow regex patterns — no arbitrary JS
  // Validate the expression compiles as a regex
  let regex: RegExp;
  try {
    regex = new RegExp(expression);
  } catch (err) {
    throw new Error(
      `Invalid validator expression: must be a valid regex pattern. Got: ${expression}`,
    );
  }

  // Check for catastrophic backtracking
  if (hasCatastrophicBacktracking(expression)) {
    throw new Error(`Validator regex rejected: potential catastrophic backtracking`);
  }

  return (value: string): boolean => {
    const startTime = performance.now();
    const result = regex.test(value);
    const elapsed = performance.now() - startTime;
    if (elapsed > SANDBOX_TIMEOUT_MS) {
      log.warn('PII validator regex took too long', { expression, elapsed });
    }
    return result;
  };
}
```

Remove the `import vm from 'node:vm'` import.

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 4.2: Use Sandboxed Validator in `testPattern` (CRIT-8)

**Files:**

- Modify: `apps/runtime/src/services/pii/pattern-service.ts` (lines 172-181)
- Create: `apps/runtime/src/__tests__/pii-testpattern-redos.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/pii-integration.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('testPattern — ReDoS prevention', () => {
  it('rejects validator with catastrophic backtracking', () => {
    const result = testPattern('\\d+', '12345', '(a+)+$');
    // Should not hang — either returns normally with unfiltered results, or throws
    expect(result.detections).toBeDefined();
  });

  it('completes within timeout for benign validator', () => {
    const start = Date.now();
    const result = testPattern('\\d+', '12345', '^\\d+$');
    expect(Date.now() - start).toBeLessThan(100);
    expect(result.detections.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace raw `new RegExp()` with `buildSandboxedValidator`**

```typescript
// Before:
if (validate && detections.length > 0) {
  try {
    const validatorRegex = new RegExp(validate);
    const filtered = detections.filter((d) => validatorRegex.test(d.match));

// After:
if (validate && detections.length > 0) {
  try {
    const validator = buildSandboxedValidator(validate);
    const filtered = detections.filter((d) => validator(d.match));
```

Import `buildSandboxedValidator` from `./pattern-loader.js`.

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Chunk 5: SSRF & Network Security (H-6, H-7, M-9, M-11)

### Task 5.1: Add SSRF Validation to Alert Webhook URLs (H-6)

**Files:**

- Modify: `apps/runtime/src/routes/alert-config.ts` (lines 120-131)
- Modify: `apps/runtime/src/services/alert-delivery.ts` (lines 174-197)
- Create: `apps/runtime/src/__tests__/alert-config-ssrf.test.ts`

- [ ] **Step 1: Write failing SSRF test**

```typescript
describe('Alert webhook SSRF prevention', () => {
  it('rejects webhook target pointing to metadata endpoint', async () => {
    const res = await request(app).post('/api/v1/alerts').send({
      type: 'usage_threshold',
      threshold: 90,
      channel: 'webhook',
      target: 'http://169.254.169.254/latest/',
    });
    expect(res.status).toBe(400);
  });

  it('rejects webhook target pointing to private IP', async () => {
    const res = await request(app).post('/api/v1/alerts').send({
      type: 'usage_threshold',
      threshold: 90,
      channel: 'webhook',
      target: 'http://10.0.0.1/hook',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add `assertAllowedCallbackUrl` to create/update routes**

```typescript
import { assertAllowedCallbackUrl } from '../channels/security/callback-url-policy.js';

// In POST handler, after target validation:
if (channel === 'webhook') {
  try {
    const isProduction = getConfig().env === 'production';
    await assertAllowedCallbackUrl(target.trim(), isProduction);
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_URL', message: 'Webhook URL is not allowed' },
    });
  }
}
```

Apply the identical check in the PATCH/PUT handler for alert config updates — any endpoint that accepts a new `target` URL must validate it.

Also add the same check in `deliverWebhook` as a defense-in-depth measure (in case old URLs are already stored).

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 5.2: Replace `isValidEndpointUrl` with DNS-Resolving Validator (H-7)

**Files:**

- Modify: `apps/runtime/src/routes/tenant-models.ts` (lines 227-244)
- Modify: `apps/runtime/src/__tests__/tenant-model-routes.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/tenant-model-routes.test.ts`
- `apps/runtime/src/__tests__/tenant-models-authz.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('rejects endpoint URL that could DNS-rebind to private IP', async () => {
  // Use assertUrlSafeForSSRF which does DNS resolution
  // The test verifies the function is called
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace `isValidEndpointUrl` with `assertUrlSafeForSSRF`**

```typescript
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';

// Replace the isValidEndpointUrl function usage:
try {
  assertUrlSafeForSSRF(endpointUrl);
} catch (err) {
  return res.status(400).json({
    success: false,
    error: { code: 'INVALID_URL', message: 'Endpoint URL is not allowed' },
  });
}
```

Delete the local `isValidEndpointUrl` function — it's now redundant.

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 5.3: Add SSRF Check for `stdio` MCP Transport (M-9)

**Files:**

- Modify: `apps/runtime/src/services/mcp/inline-mcp-provider.ts` (lines 70-81)
- Modify: `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('rejects stdio transport with disallowed command', async () => {
  const client = await provider.getClient({
    transport: 'stdio',
    command: '/bin/bash',
    args: ['-c', 'curl http://169.254.169.254/'],
  });
  expect(client).toBeUndefined();
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add command allowlist for stdio transport**

```typescript
const ALLOWED_STDIO_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'docker']);

if (config.transport === 'stdio') {
  const commandBase = path.basename(config.command || '');
  if (!ALLOWED_STDIO_COMMANDS.has(commandBase)) {
    log.warn('MCP stdio transport: command not in allowlist', {
      command: config.command,
      allowlist: [...ALLOWED_STDIO_COMMANDS],
    });
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 5.4: Decouple SSRF Dev Options from `NODE_ENV` (M-11)

**Files:**

- Modify: `packages/shared-kernel/src/security/ssrf-validator.ts` (lines 288-291)
- Modify: `packages/shared-kernel/src/security/__tests__/ssrf-validator.test.ts`

**Impacted existing tests:**

- `packages/shared-kernel/src/security/__tests__/ssrf-validator.test.ts` — tests for `getDevSSRFOptions` describe block

- [ ] **Step 1: Write failing test**

```typescript
it('does NOT allow private ranges in staging (NODE_ENV=staging)', () => {
  process.env.NODE_ENV = 'staging';
  const opts = getDevSSRFOptions();
  expect(opts.allowPrivateRanges).not.toBe(true);
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Use explicit env var instead of NODE_ENV**

```typescript
export function getDevSSRFOptions(): SSRFValidationOptions {
  if (process.env.ALLOW_SSRF_PRIVATE_RANGES === 'true') {
    return { allowLocalhost: true, allowPrivateRanges: true };
  }
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return { allowLocalhost: true, allowPrivateRanges: true };
  }
  return {};
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Chunk 6: Auth, Crypto & Error Handling (H-8, H-10, H-11, M-12)

### Task 6.1: Fix HMAC Bypass in Callback Router (H-8)

**Files:**

- Modify: `apps/runtime/src/routes/callbacks.ts` (lines 69-101)
- Modify: `apps/runtime/src/__tests__/llm-queue-callback-bounds.test.ts`
- Create: `apps/runtime/src/__tests__/callback-hmac-enforcement.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('Callback HMAC enforcement', () => {
  it('rejects callback when signature header is missing but secret is configured', async () => {
    // Configure a callback with a secret
    // Send POST without x-callback-signature header
    // Expect 401
  });

  it('returns 503 when HMAC verification throws (DB error)', async () => {
    // Mock suspensionStore.load to throw
    // Send POST with signature
    // Expect 503, not 200
  });
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Fix the HMAC verification flow**

**Critical:** Do NOT restructure the Redis-first flow. The atomic claim (Redis `SET NX`) at lines 44-66 provides exactly-once delivery. **Replace lines 68-101** (the entire existing `if (signature)` HMAC block) with the new `if (suspension?.callbackSecret)` block below. The `suspensionStore.load(entry.suspensionId)` at line 72 stays at line 72 but is now OUTSIDE the signature check.

```typescript
if (suspension?.callbackSecret) {
  const signature = getHeader(req.headers, 'x-callback-signature');
  if (!signature) {
    log.warn('Callback missing required signature', { callbackId });
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Signature required' },
    });
  }

  try {
    const secret = await deps.decryptSecret(suspension.callbackSecret, suspension.tenantId);
    const expectedSig = createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    const actualSig = String(signature).replace('sha256=', '');
    const sigBuf = Buffer.from(actualSig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid signature' },
      });
    }
  } catch (err) {
    log.error('HMAC verification failed', {
      callbackId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(503).json({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Verification temporarily unavailable' },
    });
  }
}
```

**Do NOT remove** the `loadByCallbackId` call at line 51 — that is the Redis-eviction fallback path and is unrelated to this HMAC fix.

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 6.2: Redact Redis URL from Startup Logs (H-10)

**Files:**

- Modify: `apps/runtime/src/config/index.ts` (lines 286-310)

**Impacted existing tests:**

- `apps/runtime/src/__tests__/config-externalization.test.ts`

- [ ] **Step 1: Write test**

```typescript
it('does not log Redis password in startup summary', () => {
  const spy = vi.spyOn(console, 'log');
  logRuntimeConfigSummary(mockConfig);
  const output = spy.mock.calls.map((c) => c.join(' ')).join('');
  expect(output).not.toContain('redis-password');
  expect(output).toContain('redis-host:6380'); // host+port visible, password redacted
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add URL redaction helper and switch to `createLogger`**

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('runtime-config');

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function logRuntimeConfigSummary(cfg: unknown): void {
  const c = cfg as RuntimeConfig;
  log.info('Runtime config summary', {
    redis: c.redis.enabled ? redactUrl(c.redis.url || 'localhost') : 'disabled',
    database: c.database.url ? 'configured' : 'not configured',
    jwtSecretLength: c.jwt.secret.length,
    // ... other non-sensitive fields
  });
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 6.3: Sanitize SSE Error Messages (H-11)

**Files:**

- Modify: `apps/runtime/src/routes/chat.ts` (lines 413-416)
- Modify: `apps/runtime/src/__tests__/chat-routes.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/chat-routes.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('does not leak internal error details in SSE error events', async () => {
  // Trigger a stream processing error
  // Verify SSE error event contains generic message, not raw error
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace raw error with generic message**

```typescript
// Before:
} catch (error) {
  log.error('Stream processing error', { error: (error as Error).message, sessionId });
  writeSSE(res, 'error', { error: (error as Error).message });
}

// After:
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  log.error('Stream processing error', { error: errorMsg, sessionId });
  writeSSE(res, 'error', { error: 'An error occurred while processing your request' });
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 6.4: Sanitize Error Responses in `project-settings.ts` (M-12)

**Files:**

- Modify: `apps/runtime/src/routes/project-settings.ts` (lines 465-477)
- Modify: `apps/runtime/src/__tests__/project-settings-route.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('does not reflect internal error details in 4xx responses', async () => {
  // Trigger a 404 with an internal message
  // Verify response body has generic message
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Replace reflected errors with generic messages**

```typescript
// Before:
if ((error as any)?.statusCode === 400 || (error as any)?.code === 'BAD_REQUEST') {
  res.status(400).json({ success: false, error: (error as Error).message });
  return;
}

// After:
const ERROR_MESSAGES: Record<number, string> = {
  400: 'Invalid request',
  404: 'Resource not found',
  422: 'Unprocessable request',
};

const statusCode = (error as any)?.statusCode;
if (statusCode && ERROR_MESSAGES[statusCode]) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  log.warn('Project settings error', { statusCode, error: errorMsg });
  res.status(statusCode).json({
    success: false,
    error: { code: (error as any)?.code || 'ERROR', message: ERROR_MESSAGES[statusCode] },
  });
  return;
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Chunk 7: Resource Exhaustion & Fail-Open Guards (M-2, M-4, M-5, M-8, M-10)

### Task 7.1: Add Size Cap to `metricsBuffer` (M-2)

**Files:**

- Modify: `apps/runtime/src/services/message-persistence-queue.ts` (lines 98-99)
- Modify: `apps/runtime/src/__tests__/message-persistence-queue.test.ts`

**Impacted existing tests:**

- `apps/runtime/src/__tests__/message-persistence-queue.test.ts`
- `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('drops oldest metrics entries when metricsBuffer exceeds max size', () => {
  // Add MAX_METRICS_BUFFER + 100 entries
  // Verify buffer size is capped
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add cap constant and check**

```typescript
const MAX_METRICS_BUFFER = 10000;

// In the metrics accumulation function, before inserting:
if (metricsBuffer.size >= MAX_METRICS_BUFFER) {
  // Drop oldest entries (first 10% by insertion order)
  const dropCount = Math.floor(MAX_METRICS_BUFFER * 0.1);
  let dropped = 0;
  for (const key of metricsBuffer.keys()) {
    if (dropped >= dropCount) break;
    metricsBuffer.delete(key);
    dropped++;
  }
  log.warn('metricsBuffer at capacity — evicted oldest entries', {
    dropped,
    max: MAX_METRICS_BUFFER,
  });
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 7.2: Add Max Session Cap to `TraceStore` (M-4)

**Files:**

- Modify: `apps/runtime/src/services/trace-store.ts` (lines 345-356)
- Create: `apps/runtime/src/__tests__/trace-store-limits.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('evicts LRU session when max cap is reached', () => {
  const store = new TraceStore({ maxSessions: 10 });
  // Add 11 sessions
  // Verify oldest was evicted, size is 10
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add max cap in `getOrCreateSession`**

```typescript
private maxSessions: number;

constructor(config: TraceStoreConfig) {
  this.maxSessions = config.maxSessions ?? 50000;
  // ...
}

private getOrCreateSession(sessionId: string): SessionTraceData {
  let session = this.sessions.get(sessionId);
  if (!session) {
    // Evict oldest if at capacity
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) {
        this.sessions.delete(oldestKey);
      }
    }
    session = { events: [], subscribers: new Set(), lastActivity: new Date() };
    this.sessions.set(sessionId, session);
  }
  return session;
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 7.3: Clean Up `activeSpans` on Session Eviction (M-5)

**Files:**

- Modify: `apps/runtime/src/observability/otel-trace-bridge.ts` (lines 31, 93-98)
- Create: `apps/runtime/src/__tests__/otel-trace-bridge-cleanup.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('ends and removes orphaned spans during cleanup', () => {
  const store = new OtelTraceStore(config);
  store.startTrace(ctx);
  // Don't call endTrace — simulate abnormal termination
  // Trigger cleanup
  // Verify activeSpans is empty and span.end() was called
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Override cleanup to handle activeSpans**

```typescript
protected cleanup(): void {
  super.cleanup();

  // End orphaned spans whose sessions no longer exist
  for (const [traceId, span] of this.activeSpans) {
    if (!this.sessions.has(traceId)) {
      try {
        span.end();
      } catch {
        // Span may already be ended
      }
      this.activeSpans.delete(traceId);
    }
  }
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 7.4: Add Size Cap to MCP Tool Results (M-8)

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts` (lines 351-402)
- Modify: `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('truncates MCP result exceeding max size', async () => {
  const hugeResult = [{ type: 'text', text: 'x'.repeat(2_000_000) }];
  const normalized = normalizeMcpResult(hugeResult);
  expect(typeof normalized === 'string' && normalized.length).toBeLessThanOrEqual(
    MAX_MCP_RESULT_CHARS + 100,
  );
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add size cap in `normalizeMcpResult`**

```typescript
const MAX_MCP_RESULT_CHARS = 100_000; // 100K chars ~ 25K tokens

function normalizeMcpResult(result: unknown): unknown {
  // ... existing normalization ...
  const joined = textParts.join('\n');
  if (joined.length > MAX_MCP_RESULT_CHARS) {
    return joined.slice(0, MAX_MCP_RESULT_CHARS) + '\n[truncated -- result exceeded size limit]';
  }
  return joined;
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

### Task 7.5: Make Guardrail Fail-Open Configurable (M-10)

**Files:**

- Modify: `packages/compiler/src/platform/guardrails/providers/custom-http.ts` (lines 303-310)
- Modify: `packages/compiler/src/__tests__/guardrails/providers/custom-http.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('fails closed when failMode is "closed"', async () => {
  const provider = new CustomHTTPProvider({ ...config, failMode: 'closed' });
  // Mock fetch to throw
  const result = await provider.evaluate(request);
  expect(result.severity).toBe('critical');
});

it('fails open by default (backward compat)', async () => {
  const provider = new CustomHTTPProvider(config);
  const result = await provider.evaluate(request);
  expect(result.severity).toBe('safe');
});
```

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Add `failMode` to provider config**

```typescript
} catch (err) {
  const latencyMs = performance.now() - start;
  log.warn('Custom HTTP provider request failed', { error: err instanceof Error ? err.message : String(err) });

  if (this.config.failMode === 'closed') {
    return {
      score: 1.0,
      severity: 'critical',
      category: request.category,
      latencyMs,
      metadata: { failedClosed: true, error: 'Provider unavailable' },
    };
  }

  return this.safeResult(request.category, latencyMs);
}
```

- [ ] **Step 4: Run tests — verify pass**
- [ ] **Step 5: Commit**

---

## Summary: All Tasks

| Chunk | Task | Finding(s) | Files Modified                                  | New Test Files                             |
| ----- | ---- | ---------- | ----------------------------------------------- | ------------------------------------------ |
| 1     | 1.1  | CRIT-4     | session-repo.ts                                 | session-repo-isolation.test.ts             |
| 1     | 1.2  | H-1        | routes/contacts.ts                              | contacts-tenant-isolation.test.ts          |
| 1     | 1.3  | H-2        | channels/connection-resolver.ts                 | connection-resolver-isolation.test.ts      |
| 1     | 1.4  | H-3        | repos/tenant-model-repo.ts                      | tenant-model-repo-isolation.test.ts        |
| 1     | 1.5  | H-9        | stores/mongo-message-store.ts, message-store.ts | mongo-message-store-isolation.test.ts      |
| 1     | 1.6  | G2         | stores/mongo-conversation-store.ts              | mongo-conversation-store-isolation.test.ts |
| 2     | 2.1  | CRIT-5     | routes/sessions.ts                              | sessions-regex-injection.test.ts           |
| 2     | 2.2  | CRIT-6     | routes/contacts.ts                              | contacts-cursor-validation.test.ts         |
| 2     | 2.3  | M-6        | routes/workflows.ts                             | (in workflow-routes.test.ts)               |
| 2     | 2.4  | M-7        | routes/contacts.ts                              | (in contacts-tenant-isolation.test.ts)     |
| 3     | 3.1  | CRIT-3     | twilio-media-handler.ts, server.ts              | ws-twilio-auth.test.ts                     |
| 3     | 3.2  | H-4        | websocket/handler.ts                            | (in websocket-handler.test.ts)             |
| 3     | 3.3  | H-5        | websocket/handler.ts                            | (in websocket-handler.test.ts)             |
| 3     | 3.4  | M-1        | websocket/sdk-handler.ts                        | (in ws-sdk-handler.test.ts)                |
| 3     | 3.5  | M-3        | server.ts                                       | ws-max-payload.test.ts                     |
| 4     | 4.1  | CRIT-7     | pii/pattern-loader.ts                           | pii-sandbox-escape.test.ts                 |
| 4     | 4.2  | CRIT-8     | pii/pattern-service.ts                          | pii-testpattern-redos.test.ts              |
| 5     | 5.1  | H-6        | alert-config.ts, alert-delivery.ts              | alert-config-ssrf.test.ts                  |
| 5     | 5.2  | H-7        | routes/tenant-models.ts                         | (in tenant-model-routes.test.ts)           |
| 5     | 5.3  | M-9        | mcp/inline-mcp-provider.ts                      | (in inline-mcp-provider.test.ts)           |
| 5     | 5.4  | M-11       | ssrf-validator.ts                               | (in ssrf-validator.test.ts)                |
| 6     | 6.1  | H-8        | routes/callbacks.ts                             | callback-hmac-enforcement.test.ts          |
| 6     | 6.2  | H-10       | config/index.ts                                 | (in config-externalization.test.ts)        |
| 6     | 6.3  | H-11       | routes/chat.ts                                  | (in chat-routes.test.ts)                   |
| 6     | 6.4  | M-12       | routes/project-settings.ts                      | (in project-settings-route.test.ts)        |
| 7     | 7.1  | M-2        | message-persistence-queue.ts                    | (in message-persistence-queue.test.ts)     |
| 7     | 7.2  | M-4        | services/trace-store.ts                         | trace-store-limits.test.ts                 |
| 7     | 7.3  | M-5        | otel-trace-bridge.ts                            | otel-trace-bridge-cleanup.test.ts          |
| 7     | 7.4  | M-8        | mcp-tool-executor.ts                            | (in mcp-tool-executor.test.ts)             |
| 7     | 7.5  | M-10       | custom-http.ts                                  | (in custom-http.test.ts)                   |

## Impacted Existing Tests Summary

These test files will likely need updates due to signature changes or behavior changes:

| Test File                           | Reason for Update                               |
| ----------------------------------- | ----------------------------------------------- |
| `repos-session.test.ts`             | tenantId now required in session-repo functions |
| `session-routes.test.ts`            | session-repo mock calls need tenantId           |
| `contact-routes.test.ts`            | store.getById now needs tenantId                |
| `contacts-authz.test.ts`            | store mock may need signature update            |
| `tenant-models.test.ts`             | repo functions now require tenantId             |
| `tenant-model-routes.test.ts`       | repo mock signatures change                     |
| `tenant-models-authz.test.ts`       | repo mock signatures change                     |
| `websocket-handler.test.ts`         | subscribe/resume now check tenant               |
| `ws-sdk-handler.test.ts`            | IP extraction logic changed                     |
| `ws-twilio-handler.test.ts`         | start event now requires valid session          |
| `pii-pattern-loader.test.ts`        | buildSandboxedValidator now regex-only          |
| `inline-mcp-provider.test.ts`       | stdio command allowlist added                   |
| `chat-routes.test.ts`               | SSE error message now generic                   |
| `project-settings-route.test.ts`    | error responses now generic                     |
| `message-persistence-queue.test.ts` | metricsBuffer cap behavior                      |
| `dual-write-message-store.test.ts`  | getMessages requires tenantId                   |
| `mongo-conversation-store.test.ts`  | methods now require tenantId                    |
| `ssrf-validator.test.ts`            | getDevSSRFOptions behavior changed              |
| `custom-http.test.ts`               | fail-open now configurable                      |
| `mcp-tool-executor.test.ts`         | result truncation behavior                      |
