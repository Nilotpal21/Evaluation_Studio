# Tenant Isolation Feedback Review — 2026-03-18

**Scope:** 16 findings from external security feedback, validated against current codebase.

**Result:** 6 Invalid, 4 Stale (pre-Mongoose migration), 6 Valid/Partially Valid

---

## CRITICAL Findings (1–7)

### #1 — WS handler has zero tenant context — INVALID

**Claim:** `handler.ts` extracts `userId` from JWT but never extracts or validates `tenantId`. `ClientState` has no `tenantId` field.

**Reality:** Fully implemented. `ClientState` has both `tenantContext` and `tenantId` fields. Tenant resolution happens at connection time and gates all message processing.

**`apps/runtime/src/websocket/handler.ts:149-179`** — ClientState definition:

```typescript
interface ClientState {
  ws: WebSocket;
  sessionId?: string;
  runtimeSession?: RuntimeSession;
  runtimeSessionId?: string;
  traceEmitter?: TraceEmitter;
  userId?: string;
  authToken?: string;
  /** Full tenant context resolved at connection time (same as REST req.tenantContext) */
  tenantContext?: TenantContextData;
  agentDetails?: AgentDetails;
  dbSessionId?: string;
  pendingDbSession?: {
    agentName: string;
    agentVersion: string;
    runtimeSessionId: string;
    entryAgentName: string;
    deploymentId?: string;
    tenantId: string;
  };
  projectId?: string;
  /** Tenant ID for the loaded agent (derived from tenantContext or project lookup) */
  tenantId?: string;
  traceId?: string;
}
```

**`apps/runtime/src/websocket/handler.ts:462-513`** — Tenant context resolution (mirrors REST unified auth):

```typescript
async function resolveWSTenantContext(
  userId: string,
  tenantIdHint?: string,
): Promise<TenantContextData | undefined> {
  if (!isDatabaseAvailable()) return undefined;

  try {
    let tenantId: string | undefined = tenantIdHint;
    let role: string | undefined;
    let customRoleId: string | null | undefined;
    let orgId: string | undefined;

    const config = getConfig();
    const superAdmins = config.security?.superAdminUserIds ?? [];
    const isSuperAdmin = superAdmins.includes(userId);

    if (tenantId) {
      // Explicit tenant — verify membership (no super-admin bypass)
      const membership = await resolveTenantMembership(userId, tenantId);
      if (!membership) return undefined;
      role = membership.role;
      customRoleId = membership.customRoleId;
      orgId = membership.orgId;
    } else {
      // No tenant hint — resolve user's default tenant
      const membership = await resolveDefaultTenant(userId);
      if (!membership) return undefined;
      tenantId = membership.tenantId;
      role = membership.role;
      customRoleId = membership.customRoleId;
      orgId = membership.orgId;
    }

    if (!tenantId || !role) return undefined;
    const permissions = await resolveEffectivePermissions(tenantId, userId, role, customRoleId);

    return {
      tenantId,
      orgId,
      userId,
      role,
      permissions,
      authType: 'user',
      isSuperAdmin,
    };
  } catch (err) {
    /* logged, returns undefined */
  }
}
```

**`apps/runtime/src/websocket/handler.ts:554-578`** — `tenantReady` gate blocks all messages until resolution completes:

```typescript
const tenantReady =
  userId && isDatabaseAvailable()
    ? resolveWSTenantContext(userId, tenantIdHint)
        .then((ctx) => {
          if (ctx) {
            state.tenantContext = ctx;
            state.tenantId = ctx.tenantId;
          }
        })
        .catch(/* logged */)
    : Promise.resolve();

// Set up message handler — await tenant resolution before processing
ws.on('message', async (data) => {
  await tenantReady;
  handleMessage(ws, data.toString());
});
```

## **Prasanna input:** Why NOT Centralize and reuse the same code across multiple channels?

### #2 — `loadAgentFromDatabase()` — no tenant filter — INVALID

**Claim:** Queries `prisma.projectAgent.findFirst({ where: { agentPath } })` without `tenantId`.

**Reality:** Uses Mongoose (not Prisma). Both lookup paths require `tenantId` and return `null` if missing.

**`apps/runtime/src/websocket/handler.ts:1234-1268`**:

```typescript
async function loadAgentFromDatabase(
  agentPath: string,
  tenantId?: string,
): Promise<{ agent: AgentDetails; projectId: string; dbAgentId: string } | null> {
  if (!isDatabaseAvailable()) return null;

  try {
    // Try exact agentPath match first (tenant-scoped)
    let record = await findProjectAgentByPath(agentPath, tenantId);

    // Fallback: match by name (last segment of "domain/name" path)
    if (!record) {
      const name = agentPath.includes('/') ? agentPath.split('/').pop()! : agentPath;
      record = await findProjectAgentByName(name, { tenantId });
    }

    if (!record?.dslContent) return null;
    // ...
  }
}
```

**`apps/runtime/src/repos/project-repo.ts:61-79`** — Both repo functions are fail-closed:

```typescript
export async function findProjectAgentByPath(agentPath: string, tenantId?: string) {
  if (!tenantId) return null; // ← Fail-closed
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const doc = await ProjectAgent.findOne({ agentPath, tenantId }).lean();
  return doc ?? null;
}

export async function findProjectAgentByName(name: string, options?: { tenantId?: string }) {
  if (!options?.tenantId) return null; // ← Fail-closed
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const doc = await ProjectAgent.findOne({ name, tenantId: options.tenantId })
    .select('-irContent')
    .lean();
  return doc ?? null;
}
```

---

### #3 — `handleListSessions()` exposes all sessions across tenants — INVALID

**Claim:** `traceStore.getActiveSessions()` returns every active session globally.

**Reality:** While `getActiveSessions()` returns all session IDs, the handler filters by tenant and user before returning results.

**`apps/runtime/src/websocket/handler.ts:2180-2221`**:

```typescript
function handleListSessions(ws: WebSocket): void {
  const clientState = clients.get(ws);
  const clientTenantId = clientState?.tenantId;
  const clientUserId = clientState?.userId;

  if (!clientTenantId) {
    send(ws, { type: 'session_list', sessions: [] }); // ← Empty if no tenant
    return;
  }

  const executor = getRuntimeExecutor();
  const traceStore = getTraceStore();
  const sessionIds = traceStore.getActiveSessions();
  // ...
  for (const sessionId of sessionIds) {
    const runtimeSession = executor.getSession(sessionId);
    if (!runtimeSession) continue;
    if (runtimeSession.tenantId !== clientTenantId) continue; // ← Tenant filter
    if (clientUserId && runtimeSession.userId && runtimeSession.userId !== clientUserId) continue; // ← User filter
    // ...
  }
  send(ws, { type: 'session_list', sessions });
}
```

---

### #4 — `handleSubscribeSession()` — cross-tenant trace subscription — MOSTLY INVALID

**Claim:** Any user can subscribe to any session's real-time trace events.

**Reality:** Tenant and user checks exist, but they are **soft checks** — skipped when either side has no tenantId set.

**`apps/runtime/src/websocket/handler.ts:2119-2139`**:

```typescript
if (
  runtimeSession?.tenantId &&
  clientState?.tenantId &&
  runtimeSession.tenantId !== clientState.tenantId // ← Only fires if BOTH are set
) {
  send(ws, ServerMessages.error('Session not found'));
  return;
}

if (
  runtimeSession?.userId &&
  clientState?.userId &&
  runtimeSession.userId !== clientState.userId // ← Only fires if BOTH are set
) {
  send(ws, ServerMessages.error('Session not found'));
  return;
}
```

**Residual gap:** Sessions without `tenantId` (debug sessions, sessions created before tenant context was added) can be subscribed to by any authenticated user.

**Prasanna input:** There should be explicit checks.

---

### #5 — `handleResumeSession()` — cross-tenant session hijacking — MOSTLY INVALID

**Claim:** Loads a session by ID without verifying tenant ownership.

**Reality:** Three layers of tenant protection exist. Same soft-check caveat as #4.

**`apps/runtime/src/websocket/handler.ts:2247-2255`** — DB fallback refuses without tenant:

```typescript
if (!runtimeSession && isDatabaseAvailable()) {
  const tenantId = clients.get(ws)?.tenantId;
  if (!tenantId) {
    // Cannot safely query without tenant context
    send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
    return;
  }
  try {
    const dbSession = await findSessionById(sessionId, tenantId);
```

**`apps/runtime/src/repos/session-repo.ts:11-17`** — Repo requires tenantId:

```typescript
export async function findSessionById(id: string, tenantId: string): Promise<any | null> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped session queries');
  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id, tenantId };
  const doc = await Session.findOne(filter).select('-context -metadata').lean();
  return doc ? { ...doc, id: (doc as any)._id } : null;
}
```

**`apps/runtime/src/websocket/handler.ts:2326-2341`** — Ownership checks (soft):

```typescript
// 4b. Cross-tenant ownership check
const clientTenantId = clients.get(ws)?.tenantId;
if (clientTenantId && runtimeSession.tenantId && runtimeSession.tenantId !== clientTenantId) {
  send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
  return;
}

// 4c. User ownership check
const clientUserId = clients.get(ws)?.userId;
if (clientUserId && runtimeSession.userId && runtimeSession.userId !== clientUserId) {
  send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
  return;
}
```

## **Prasanna input:** Lets fix this comprehensively with correct design.

### #6 — `PrismaConversationStore.resumeSession()` — no tenantId filter — STALE

**Claim:** Queries by `customerId` or `anonymousId` without tenant scoping.

**Reality:** The class is now `MongoConversationStore` (Prisma fully migrated). The method uses `withTenant()` which is fail-closed — throws if no tenant context.

**`apps/runtime/src/services/stores/mongo-conversation-store.ts:61-69`**:

```typescript
private async withTenant<T>(fn: () => Promise<T>): Promise<T> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) {
    throw new AppError('Tenant context required for database operation', {
      ...ErrorCodes.UNAUTHORIZED,
    });
  }
  return withTenantContext({ tenantId }, fn);
}
```

**`apps/runtime/src/services/stores/mongo-conversation-store.ts:265-303`**:

```typescript
async resumeSession(params: ResumeSessionParams): Promise<Session | null> {
  return this.withTenant(async () => {  // ← Wrapped in tenant context
    const query: Record<string, any> = {
      status: { $in: ['active', 'paused'] },
      channel: params.channel,
    };
    if (params.customerId) query.customerId = params.customerId;
    if (params.anonymousId) query.anonymousId = params.anonymousId;
    if (params.maxAgeMs) {
      query.lastActivityAt = { $gte: new Date(Date.now() - params.maxAgeMs) };
    }
    const doc = await SessionModel.findOne(query).sort({ lastActivityAt: -1 }).lean();
    // tenantId auto-injected by Mongoose tenantIsolationPlugin via withTenantContext
    // ...
  });
}
```

**Note:** The WS handler's `handleResumeSession()` does NOT call `MongoConversationStore.resumeSession()` — it uses `findSessionById(id, tenantId)` from the session repo instead (see #5).

**Residual gap:** The WS handler may not set ALS tenant context before calling other `MongoConversationStore` methods (e.g., `endSession`). The `withTenant()` guard would throw, which is fail-closed but could cause session-end failures on disconnect.

## **Prasanna input:** Fix it more comprehensively

### #7 — `ModelResolutionService.resolveTenantModelById()` — no tenant filter — MOSTLY INVALID

**Claim:** Queries `prisma.tenantModel.findUnique({ where: { id } })` with no tenantId.

**Reality:** Uses Mongoose. `tenantId` IS passed, but the parameter is optional — if the caller passes `undefined`, the query runs unscoped.

**`apps/runtime/src/services/llm/model-resolution.ts:782-789`**:

```typescript
private async resolveTenantModelById(
  tenantModelId: string,
  tenantId?: string,        // ← Optional
): Promise<TenantModelResolution | null> {
  if (!this.dbAvailable || !this.encryption) return null;
  try {
    const tm = await findTenantModelByIdWithPrimaryConnection(tenantModelId, tenantId);
```

**`apps/runtime/src/repos/llm-resolution-repo.ts:138-148`**:

```typescript
export async function findTenantModelByIdWithPrimaryConnection(
  id: string,
  tenantId?: string,
): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { _id: id };
  if (tenantId) filter.tenantId = tenantId; // ← Only added when provided
  const doc = await TenantModel.findOne(filter).lean();
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}
```

**Gap:** If any caller passes `undefined` for `tenantId`, the query returns any tenant's model config (including their LLM API keys). The parameter should be required, not optional.

## **Prasanna input:** Fix it more comprehensively

## HIGH Findings (8–9)

### #8 — Multiple models missing from `TENANT_SCOPED_MODELS` — STALE

**Claim:** Models like `TenantModel`, `TenantModelConnection`, `TenantServiceInstance`, etc. are missing from the RLS protection list.

**Reality:** `TENANT_SCOPED_MODELS` and `NON_TENANT_MODELS` constants **do not exist in code**. The codebase migrated from Prisma to Mongoose. Tenant isolation is now enforced via the `tenantIsolationPlugin` Mongoose plugin. Models opt in by calling `schema.plugin(tenantIsolationPlugin)`.

**`packages/database/src/mongo/plugins/tenant-isolation.plugin.ts:53-75`**:

```typescript
export function tenantIsolationPlugin(schema: Schema): void {
  const readOps = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'countDocuments',
    'estimatedDocumentCount',
    'distinct',
    'deleteOne',
    'deleteMany',
    'updateOne',
    'updateMany',
    'replaceOne',
  ] as const;

  for (const op of readOps) {
    schema.pre(op, function (this: Query<any, any>) {
      injectTenantFilter(this);
    });
  }
  // ...
}
```

**Action needed:** Audit which Mongoose models have `tenantIsolationPlugin` applied. The concern about coverage gaps is valid in spirit — just the mechanism is different.

---

### #9 — ProjectAgent in NON_TENANT_MODELS but accessed without manual tenant join — PARTIALLY VALID

**Claim:** `ProjectAgent` doesn't have automatic RLS, and the WS handler doesn't join through `Project.tenantId`.

**Reality:** `ProjectAgent` does NOT use `tenantIsolationPlugin`. However, the repo functions in #2 above show that manual `tenantId` filtering IS implemented. Per `docs/security/SECURITY.md:355`, tenant isolation is enforced via `findAgentWithTenantGuard()` which joins through `Project.tenantId`.

## **Prasanna input:** Fix it more comprehensively

## MEDIUM Findings (10–13)

### #10 — `captureAbandonedCall()` creates sessions with `tenantId: 'unknown'` — INVALID

**Claim:** Creates sessions with `tenantId: 'unknown'`, orphaned outside any tenant boundary.

**Reality:** Sets `currentAgent: 'unknown'` and `agentVersion: 'unknown'`, NOT `tenantId`. The `tenantId` field is simply omitted (undefined).

**`packages/compiler/src/platform/stores/conversation-store.ts:304-310`**:

```typescript
const session: Session = {
  id: sessionId,
  status: 'active',
  // ...
  currentAgent: 'unknown',
  agentVersion: 'unknown',
  // tenantId is not set — remains undefined
};
```

## **Prasanna input:** Fix it more comprehensively

### #11 — BullMQ queue is global — VALID

**Claim:** Single `llm-requests` queue for all tenants. Noisy-neighbor risk.

**Reality:** Confirmed. One queue, all tenants. `tenantId` is in job data but not used for partitioning.

**`apps/runtime/src/services/llm/llm-queue.ts:34-42`** — Job data:

```typescript
interface LLMJobData {
  jobId: string;
  sessionId: string;
  message: string;
  tenantId?: string; // ← Optional, not used for partitioning
  enqueuedAt: number;
  execOptions?: { attachmentIds?: string[] };
  traceId?: string;
}
```

**`apps/runtime/src/services/llm/llm-queue.ts:194-201`** — Single global queue:

```typescript
bullQueue = new Queue('llm-requests', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
    attempts: 1,
  },
});
```

**Risk:** A tenant with high LLM traffic can starve other tenants. No per-tenant rate limiting, priority, or concurrency limits at the queue level.

**Prasanna input:** Fix it more comprehensively. We need to even separte studio traffice and runtime traffic. It would be good to even separte out channel as channels can sometimes go wrong.

---

### #12 — S3 archive `getDownloadUrl()`/`delete()` accept arbitrary paths — VALID

**Claim:** No validation that the S3 path belongs to the caller's tenant. Presigned URL generation or deletion of another tenant's files is possible.

**Reality:** Confirmed. `upload()` and `list()` scope by tenant prefix, but `getDownloadUrl()` and `delete()` accept raw paths.

**`apps/studio/src/services/archive/s3-archive-store.ts:39-53`** — Upload scopes by tenant:

```typescript
const key = this.buildKey(tenantId, type, now);
const bucket = this.getBucket(tenantId);
// ...
Metadata: {
  'x-tenant-id': tenantId,
  'x-archive-type': type,
}
```

**`apps/studio/src/services/archive/s3-archive-store.ts:134-142`** — Download does NOT:

```typescript
async getDownloadUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const client = await this.getClient();
  const bucket = this.config.defaultBucket;
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const command = new GetObjectCommand({ Bucket: bucket, Key: path });  // ← Raw path
  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}
```

**`apps/studio/src/services/archive/s3-archive-store.ts:149-155`** — Delete does NOT:

```typescript
async delete(path: string): Promise<void> {
  const client = await this.getClient();
  const bucket = this.config.defaultBucket;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));  // ← Raw path
}
```

**Same pattern in shared service** at `packages/shared/src/services/s3-storage.ts:242-279`.

**Fix:** Validate that `path` starts with the expected tenant prefix (e.g., `tenants/{tenantId}/`) before generating presigned URLs or deleting.

## **Prasanna input:** This needs a more comprehensive defense in depth design.

### #13 — `requireAuth()` passes with `req.user` alone (no tenant context) — PARTIALLY VALID

**Claim:** Routes that then access `req.tenantContext.tenantId` get a runtime error instead of a 403.

**Reality:** `requireAuth()` is a guard, not a context setter. Tenant context is set by `createUnifiedAuthMiddleware()` which runs before it. The concern is valid only if routes use `requireAuth()` without the unified middleware in the chain.

**`packages/shared-auth/src/middleware/unified-auth.ts:413-422`** — `requireAuth` is just a gate:

```typescript
// requireAuth checks if req.user or req.tenantContext already exists.
// It does NOT set tenant context — that's done by createUnifiedAuthMiddleware().
```

**Prasanna input:** This needs a more comprehensive defense in depth design.

---

## LOW Findings (14–16)

### #14 — RLS middleware allows explicit tenantId override on create — VALID

**Claim:** Any code accidentally including tenantId could write to another tenant.

**Reality:** Confirmed. The plugin's pre-validate hook only sets `tenantId` if not already present.

**`packages/database/src/mongo/plugins/tenant-isolation.plugin.ts:92-98`**:

```typescript
schema.pre('validate', function () {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;

  if (this.isNew && !this.get('tenantId')) {
    // ← Preserves explicit tenantId
    this.set('tenantId', ctx.tenantId);
  }
});
```

**Risk:** If application code sets `doc.tenantId = attackerControlledValue`, the plugin will NOT correct it. Should assert `doc.tenantId === ctx.tenantId` on new documents or reject mismatches.

**Also note** `injectTenantFilter` at line 120-127:

```typescript
function injectTenantFilter(query: Query<any, any>): void {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;
  const filter = query.getFilter();
  if (!filter.tenantId) {
    // ← Skips if tenantId already in filter
    query.where('tenantId').equals(ctx.tenantId);
  }
}
```

Same pattern — explicit `tenantId` in a query filter is trusted, not validated against context.

## **Prasanna input:** This needs a more comprehensive defense in depth design.

### #15 — `PrismaRLSExtension.$allOperations` is effectively a no-op — STALE

**Claim:** The Prisma extension calls `query(args)` without modification.

**Reality:** `PrismaRLSExtension` no longer exists. The codebase has fully migrated from Prisma to Mongoose. Tenant isolation is now handled by the Mongoose `tenantIsolationPlugin` (see #8, #14).

Per `docs/db/MIGRATION_PLAN.md:246`: "Mongoose plugin replaces Prisma's `prisma-rls-middleware.ts` for the MongoDB path."

---

### #16 — `x-tenant-id` header fallback — VALID

**Claim:** Multi-tenant users can switch tenants via header.

**Reality:** The unified auth middleware explicitly blocks this. However, **three places bypass the policy**:

**`packages/shared-auth/src/middleware/unified-auth.ts:348-351`** — Correctly blocks header trust:

```typescript
// SECURITY: Never read tenant hints from request headers (X-Tenant-Id,
// X-Organization-Id) or query params. TenantId must come exclusively
// from verified credentials (JWT claims, SDK tokens, API key lookups).
```

**`apps/runtime/src/routes/agent-transfer-settings.ts:35`** — Reads tenant from UNTRUSTED header:

```typescript
const tenantId = req.headers['x-tenant-id'] as string | undefined;
```

**`apps/runtime/src/routes/agent-transfer-settings.ts:87`** — Same pattern:

```typescript
const tenantId = req.headers['x-tenant-id'] as string | undefined;
```

**`apps/runtime/src/middleware/workflow-engine-proxy.ts:76-78`** — Falls back to header:

```typescript
const tenantId =
  (req as any).tenantContext?.tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
if (tenantId) headers['x-tenant-id'] = tenantId;
```

The `agent-transfer-settings.ts` routes are the most concerning — they read tenant identity entirely from an untrusted header, bypassing the auth middleware's security policy.

## **Prasanna input:** Prisma is not there. lets fix this comprehensively.

## Summary

### Validation Results

| #   | Finding                                          | Verdict                                                    | Severity |
| --- | ------------------------------------------------ | ---------------------------------------------------------- | -------- |
| 1   | WS handler has zero tenant context               | **INVALID** — fully implemented                            | —        |
| 2   | `loadAgentFromDatabase()` no tenant filter       | **INVALID** — fail-closed guards                           | —        |
| 3   | `handleListSessions()` exposes all sessions      | **INVALID** — filtered by tenant + user                    | —        |
| 4   | `handleSubscribeSession()` cross-tenant          | **MOSTLY INVALID** — soft check gap                        | Low      |
| 5   | `handleResumeSession()` cross-tenant hijack      | **MOSTLY INVALID** — soft check gap                        | Low      |
| 6   | `PrismaConversationStore` no tenant filter       | **STALE** — now MongoConversationStore with `withTenant()` | —        |
| 7   | Model resolution no tenant filter                | **MOSTLY INVALID** — optional param gap                    | Medium   |
| 8   | Models missing from `TENANT_SCOPED_MODELS`       | **STALE** — constants don't exist, now Mongoose plugin     | —        |
| 9   | ProjectAgent no automatic RLS                    | **PARTIALLY VALID** — manual guards exist                  | Low      |
| 10  | `captureAbandonedCall()` tenantId 'unknown'      | **INVALID** — sets `currentAgent: 'unknown'`, not tenantId | —        |
| 11  | BullMQ global queue noisy-neighbor               | **VALID**                                                  | Medium   |
| 12  | S3 archive no tenant path validation             | **VALID**                                                  | High     |
| 13  | `requireAuth()` no tenant context                | **PARTIALLY VALID** — depends on middleware chain          | Low      |
| 14  | Tenant isolation plugin allows tenantId override | **VALID**                                                  | Medium   |
| 15  | `PrismaRLSExtension` no-op                       | **STALE** — no longer exists                               | —        |
| 16  | `x-tenant-id` header trust bypass                | **VALID**                                                  | High     |

### Remaining Gaps — Priority Order

| Priority | Gap                                                                         | Files                                                               | Fix                                                    |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **P1**   | S3 download/delete accept raw paths without tenant validation               | `apps/studio/src/services/archive/s3-archive-store.ts:134,149`      | Validate path starts with tenant prefix                |
| **P1**   | `x-tenant-id` header trusted in agent-transfer-settings                     | `apps/runtime/src/routes/agent-transfer-settings.ts:35,87`          | Use `req.tenantContext.tenantId` from auth middleware  |
| **P2**   | Tenant isolation plugin allows explicit tenantId override on create         | `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts:96` | Assert `doc.tenantId === ctx.tenantId` or reject       |
| **P2**   | Model resolution `tenantId` is optional — unscoped query when undefined     | `apps/runtime/src/repos/llm-resolution-repo.ts:140-144`             | Make `tenantId` required                               |
| **P3**   | Soft tenant checks in WS subscribe/resume (skipped when tenantId undefined) | `apps/runtime/src/websocket/handler.ts:2119,2328`                   | Require both sides to have tenantId; reject if missing |
| **P3**   | BullMQ global queue — noisy-neighbor risk                                   | `apps/runtime/src/services/llm/llm-queue.ts:194`                    | Per-tenant concurrency limits or priority queues       |
| **P3**   | WS handler may not set ALS context for MongoConversationStore calls         | `apps/runtime/src/websocket/handler.ts` → `MongoConversationStore`  | Wrap store calls in `runWithTenantContext()`           |

### Note on Feedback Freshness

The feedback references Prisma (`PrismaConversationStore`, `prisma.projectAgent.findFirst`, `PrismaRLSExtension`), `TENANT_SCOPED_MODELS`/`NON_TENANT_MODELS` constants, and patterns that predate the Mongoose migration. Four of sixteen findings (#6, #8, #10, #15) are stale as a result. Future security reviews should be conducted against the current Mongoose-based data layer.

---

## Re-validation: Remaining Gaps (2026-03-18)

All 7 remaining gaps were re-checked after tenant isolation centralization and linter additions. **None are fully resolved.** One has a partial fix.

### Gap Status

| #   | Gap                                        | Status                              | Evidence                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | S3 archive tenant path validation          | **STILL OPEN**                      | `s3-archive-store.ts:134,149` — `getDownloadUrl(path)` and `delete(path)` still accept raw S3 keys with no tenant prefix assertion. `upload()` scopes by `buildKey(tenantId, ...)` but read/delete do not validate ownership. Same in `packages/shared/src/services/s3-storage.ts:242,269`.           |
| 2   | `x-tenant-id` header trust                 | **STILL OPEN** (partial mitigation) | `agent-transfer-settings.ts:35,87` still reads `req.headers['x-tenant-id']` directly instead of `req.tenantContext.tenantId`. `workflow-engine-proxy.ts:76-78` now prefers `tenantContext` but falls back to header when absent.                                                                      |
| 3   | Tenant isolation plugin override on create | **STILL OPEN**                      | `tenant-isolation.plugin.ts:92-98` — `if (this.isNew && !this.get('tenantId'))` still preserves explicit tenantId without asserting match against ALS context. Same at `insertMany` hook (line ~109-114): `if (!doc.tenantId)`.                                                                       |
| 4   | Model resolution optional tenantId         | **STILL OPEN**                      | `llm-resolution-repo.ts:138-144` — `tenantId?: string` is still optional. `if (tenantId) filter.tenantId = tenantId` skips tenant filter when undefined. `model-resolution.ts:782-784` passes `context.tenantId` which is typed optional.                                                             |
| 5   | Soft tenant checks in WS                   | **STILL OPEN**                      | `handler.ts:2119-2126` (subscribe), `handler.ts:2327-2331` (resume), `handler.ts:3091-3096` (fork) — all use `a && b && a !== b` pattern that skips the check when either tenantId is undefined.                                                                                                      |
| 6   | BullMQ global queue                        | **STILL OPEN**                      | `llm-queue.ts:194` — single `Queue('llm-requests')` for all tenants. `tenantId` in job data (line 38) is metadata only, not used for partitioning or per-tenant rate limiting.                                                                                                                        |
| 7   | WS handler ALS context                     | **PARTIALLY FIXED**                 | `sdk-handler.ts:429,530,647` wraps operations in `runWithTenantContext()`. Main `handler.ts` does NOT — `runWithTenantContext` is not imported or called. MongoConversationStore's `withTenant()` would throw (fail-closed), which prevents cross-tenant writes but could cause session-end failures. |

### Linter & Hook Coverage Assessment

The following Claude Code PreToolUse hooks exist for isolation enforcement:

| Hook                     | File                                        | Scope                                                                                               |
| ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `findById` lint          | `.claude/hooks/findbyid-lint.sh`            | Warns on `findById`/`findByIdAndUpdate`/`findByIdAndDelete` (should use `findOne({_id, tenantId})`) |
| Project isolation lint   | `.claude/hooks/project-isolation-lint.sh`   | Warns on Mongoose queries in project-scoped routes missing `projectId`                              |
| User isolation lint      | `.claude/hooks/user-isolation-lint.sh`      | Warns on user-owned resource queries missing `userId`/`createdBy`                                   |
| Cache key completeness   | `.claude/hooks/cache-key-completeness.sh`   | Warns on cache keys with `tenantId` but missing `userId`                                            |
| Lean on encrypted models | `.claude/hooks/lean-on-encrypted-models.sh` | Warns on `.lean()` on `LLMCredential`/`AuthProfile` queries                                         |

**Limitations:**

- **Agent-time only** — These hooks fire when Claude Code agents write/edit files. They do NOT run as git pre-commit hooks or in CI. A human developer bypasses all of them.
- **No dedicated tenant isolation hook** — `project-isolation-lint` and `user-isolation-lint` cover project/user scope but there is no hook checking that tenant-scoped routes include `tenantId` in queries, or that `x-tenant-id` headers are not trusted.
- **No CI enforcement** — None of these checks run in the Harness CI pipeline. A PR that introduces a `findById` call or reads `x-tenant-id` from headers will not be blocked.

### Recommendations

1. **Promote hooks to CI** — Convert the most critical hooks (`findById` lint, project/user isolation) into a CI-stage script (e.g., `tools/tenant-isolation-lint.sh`) that runs on every PR.
2. **Add `x-tenant-id` header lint** — A grep-based check that blocks `req.headers['x-tenant-id']` outside of explicitly allowed files (e.g., dev-auth.ts).
3. **Add S3 path validation** — Either in `s3-archive-store.ts` (assert path prefix) or via a caller-side middleware that resolves paths through a tenant-scoped lookup.
4. **Harden the Mongoose plugin** — Assert `doc.tenantId === ctx.tenantId` on create (not just set-if-empty). Log a security warning on mismatch.
5. **Make `tenantId` required** in `findTenantModelByIdWithPrimaryConnection` and `resolveTenantModelById` — callers that cannot provide tenantId should fail explicitly.
6. **Harden WS soft checks** — Change from `a && b && a !== b` to: reject if the client has no tenantId (`!clientTenantId → error`), then reject if session has no tenantId and client is not super-admin.
