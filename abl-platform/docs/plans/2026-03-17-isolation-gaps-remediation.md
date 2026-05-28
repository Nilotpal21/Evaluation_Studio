# Isolation Gaps Remediation Plan

**Date:** 2026-03-17
**Status:** Planned
**Severity Distribution:** 5 CRITICAL, 4 HIGH, 5 MEDIUM, 3 LOW

This plan addresses 17 isolation gaps across user-level (U1-U8) and project-level (P1-P9) scoping. Each fix includes file paths, current code, replacement code, and a test approach.

---

## Phase 1: CRITICAL (WebSocket + Session Traces)

These gaps allow cross-tenant and cross-user data leakage through the WebSocket handler and session trace endpoints. Fix first.

---

### U1: WebSocket `list_sessions` — no tenant or user filtering

**Risk:** Any authenticated WebSocket client sees ALL active sessions across ALL tenants.

**File:** `apps/runtime/src/websocket/handler.ts` lines 2079-2097

**Current code:**

```typescript
function handleListSessions(ws: WebSocket): void {
  const traceStore = getTraceStore();
  const sessionIds = traceStore.getActiveSessions();

  const sessions = sessionIds.map((sessionId) => {
    const info = traceStore.getSessionInfo?.(sessionId);
    return {
      sessionId,
      agentName: info?.agentName,
      eventCount: info?.eventCount || 0,
      lastActivity: info?.lastActivity || new Date(),
    };
  });

  send(ws, {
    type: 'session_list',
    sessions,
  });
}
```

**Fixed code:**

```typescript
function handleListSessions(ws: WebSocket): void {
  const clientState = clients.get(ws);
  const clientTenantId = clientState?.tenantId;
  const clientUserId = clientState?.userId;

  if (!clientTenantId) {
    send(ws, { type: 'session_list', sessions: [] });
    return;
  }

  const executor = getRuntimeExecutor();
  const traceStore = getTraceStore();
  const sessionIds = traceStore.getActiveSessions();

  const sessions: Array<{
    sessionId: string;
    agentName?: string;
    eventCount: number;
    lastActivity: Date;
  }> = [];

  for (const sessionId of sessionIds) {
    // Filter by tenant + user ownership
    const runtimeSession = executor.getSession(sessionId);
    if (!runtimeSession) continue;
    if (runtimeSession.tenantId !== clientTenantId) continue;
    if (clientUserId && runtimeSession.userId && runtimeSession.userId !== clientUserId) continue;

    const info = traceStore.getSessionInfo?.(sessionId);
    sessions.push({
      sessionId,
      agentName: info?.agentName,
      eventCount: info?.eventCount || 0,
      lastActivity: info?.lastActivity || new Date(),
    });
  }

  send(ws, { type: 'session_list', sessions });
}
```

**Test approach:**

- Unit test: create mock sessions for tenant-A/user-1, tenant-A/user-2, tenant-B/user-3. Connect WS as tenant-A/user-1 and verify only that user's sessions are returned.
- Cross-tenant test: verify tenant-B sessions are never included in tenant-A's list.

---

### U2: WebSocket `subscribe_session` — no userId ownership check

**Risk:** Any user within the same tenant can subscribe to another user's session traces.

**File:** `apps/runtime/src/websocket/handler.ts` lines 2022-2054

**Current code:**

```typescript
async function handleSubscribeSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'subscribe_session' }>,
): Promise<void> {
  const { sessionId } = message;

  // Tenant ownership verification — prevent cross-tenant session subscription
  const clientState = clients.get(ws);
  const runtimeSession = getRuntimeExecutor().getSession(sessionId);
  if (
    runtimeSession?.tenantId &&
    clientState?.tenantId &&
    runtimeSession.tenantId !== clientState.tenantId
  ) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  const traceStore = getTraceStore();
  // ... subscribe proceeds
```

**Fixed code:**

```typescript
async function handleSubscribeSession(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: 'subscribe_session' }>,
): Promise<void> {
  const { sessionId } = message;

  const clientState = clients.get(ws);
  const runtimeSession = getRuntimeExecutor().getSession(sessionId);

  // Tenant isolation: cross-tenant subscription blocked
  if (
    runtimeSession?.tenantId &&
    clientState?.tenantId &&
    runtimeSession.tenantId !== clientState.tenantId
  ) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  // User isolation: non-admin users can only subscribe to their own sessions
  if (
    runtimeSession?.userId &&
    clientState?.userId &&
    runtimeSession.userId !== clientState.userId
  ) {
    send(ws, ServerMessages.error('Session not found'));
    return;
  }

  const traceStore = getTraceStore();
  // ... subscribe proceeds
```

**Test approach:**

- Unit test: user-1 creates a session, user-2 (same tenant) tries to subscribe. Expect `error` message.
- Positive test: user-1 subscribes to their own session. Expect `subscribed` message.

---

### P1: Session traces — missing projectId check

**Risk:** A session from project-A can be queried through the project-B traces endpoint if the session ID is known.

**File:** `apps/runtime/src/routes/sessions.ts` lines 1396-1436

**Current code:**

The traces endpoint verifies `tenantId` via `findSessionById` but when `dbVerified` is true, it never checks `dbSession.projectId !== projectId`. It only checks projectId in the `!dbVerified` fallback path.

```typescript
let dbVerified = false;
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (dbSession) {
    dbVerified = true;
  }
} catch {
  /* DB unavailable — try sessionId directly */
}

const projectId = (req.params as Record<string, string>).projectId;

if (!dbVerified) {
  // ... only checks projectId in RuntimeExecutor fallback
}
```

**Fixed code:**

```typescript
const projectId = (req.params as Record<string, string>).projectId;

let dbVerified = false;
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (dbSession) {
    // Cross-project validation: session must belong to this project
    // Safe for legacy sessions without projectId — they pass through. Consider backfill migration.
    if (dbSession.projectId && dbSession.projectId !== projectId) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
      return;
    }
    dbVerified = true;
  }
} catch {
  /* DB unavailable — try sessionId directly */
}

if (!dbVerified) {
  // ... RuntimeExecutor fallback (unchanged)
}
```

**Test approach:**

- Create session in project-A. Query `GET /api/projects/<project-B>/sessions/<session-A>/traces`. Expect 404.
- Positive test: query through project-A. Expect 200 with trace data.

---

### P2: Session metrics — missing projectId check

**Risk:** Same as P1 but for the metrics endpoint.

**File:** `apps/runtime/src/routes/sessions.ts` lines 2421-2440

**Current code:**

```typescript
// Verify session belongs to tenant
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (!dbSession) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
} catch {
  log.warn('DB unavailable for tenant verification in metrics', { sessionId });
  // Continue with sessionId directly — allow trace-only access
}
```

**Fixed code:**

```typescript
const projectId = (req.params as Record<string, string>).projectId;

// Verify session belongs to tenant AND project
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (!dbSession) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
  // Cross-project validation
  // Safe for legacy sessions without projectId — they pass through. Consider backfill migration.
  if (dbSession.projectId && dbSession.projectId !== projectId) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
} catch {
  log.warn('DB unavailable for tenant verification in metrics', { sessionId });
  res.status(503).json({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
  });
  return;
}
```

**Note:** The DB-unavailable path now returns 503 instead of continuing unverified. This matches the span-children endpoint's behavior and is safer.

**Test approach:**

- Create session in project-A. Query `GET /api/projects/<project-B>/sessions/<session-A>/metrics`. Expect 404.
- DB-unavailable test: mock DB failure. Expect 503 (not leaked data).

---

### P3: Span children — missing projectId check

**Risk:** Same cross-project leak as P1/P2.

**File:** `apps/runtime/src/routes/sessions.ts` lines 2367-2390

**Current code:**

```typescript
// Verify session belongs to tenant
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (!dbSession) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
} catch {
  log.warn('DB unavailable for tenant verification in span children', { sessionId });
  res.status(503).json({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
  });
  return;
}
```

**Fixed code:**

```typescript
const projectId = (req.params as Record<string, string>).projectId;

// Verify session belongs to tenant AND project
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (!dbSession) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
  // Cross-project validation
  // Safe for legacy sessions without projectId — they pass through. Consider backfill migration.
  if (dbSession.projectId && dbSession.projectId !== projectId) {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    return;
  }
} catch {
  log.warn('DB unavailable for tenant verification in span children', { sessionId });
  res.status(503).json({
    success: false,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable for authorization' },
  });
  return;
}
```

**Test approach:**

- Create session with traces in project-A. Query span children through project-B. Expect 404.

---

## Phase 2: HIGH (Studio Sessions + WebSocket Resume)

These gaps expose session data across users and projects in the Studio UI and WebSocket resume flow.

---

### U3: Studio sessions list — no user-level filtering

**Risk:** Any project member sees ALL sessions in the project, including sessions initiated by other users.

**File:** `apps/studio/src/services/project-service.ts` lines 299-315

**Current code:**

```typescript
export async function getProjectSessions(
  projectId: string,
  options: { limit?: number; offset?: number; tenantId?: string } = {},
): Promise<any[]> {
  const { limit = 50, offset = 0, tenantId } = options;

  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId };
  if (tenantId) filter.tenantId = tenantId;

  const docs = await Session.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}
```

**Fixed code:**

```typescript
export async function getProjectSessions(
  projectId: string,
  options: {
    limit?: number;
    offset?: number;
    tenantId?: string;
    userId?: string;
    isAdmin?: boolean;
  } = {},
): Promise<any[]> {
  const { limit = 50, offset = 0, tenantId, userId, isAdmin } = options;

  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId };
  if (tenantId) filter.tenantId = tenantId;

  // User-level isolation: non-admin users see only their own sessions
  if (userId && !isAdmin) {
    filter.initiatedById = userId;
  }

  const docs = await Session.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}
```

**File:** `apps/studio/src/app/api/projects/[id]/sessions/route.ts` lines 51-56

**Current code:**

```typescript
const sessions = await getProjectSessions(id, {
  limit,
  offset,
  tenantId: access.project.tenantId,
});
```

**Fixed code:**

```typescript
const sessions = await getProjectSessions(id, {
  limit,
  offset,
  tenantId: access.project.tenantId,
  userId: user.id,
  isAdmin: user.role === 'admin' || user.role === 'owner',
});
```

**Notes:**

- `user.id` and `user.role` come from the `AuthenticatedUser` interface in `apps/studio/src/lib/auth.ts`. The `role` field is optional (`role?: string`), so the `=== 'admin'` / `=== 'owner'` checks safely handle the `undefined` case (they evaluate to `false`).
- `initiatedById` is the correct field name on the Session model (`packages/database/src/models/session.model.ts` line 25). An index already exists: `{ tenantId: 1, initiatedById: 1 }` (line 196).
- Also fix pre-existing `console.error` on line 59 of `apps/studio/src/app/api/projects/[id]/sessions/route.ts` — use `createLogger('sessions-route')` instead.

**Test approach:**

- Unit test: create sessions for user-1 and user-2 in same project. User-1 lists sessions, sees only their own.
- Admin test: admin user lists sessions, sees all.
- Verify `initiatedById` index exists on Session model for performance.

---

### U4: WebSocket `resume_session` — no userId ownership check

**Risk:** Any user in the same tenant can resume another user's session, gaining full conversational control.

**File:** `apps/runtime/src/websocket/handler.ts` lines 2199-2206

**Note:** The null-check for `runtimeSession` and the session-not-found guard are above this range (lines 2195-2198). The lines below are specifically the tenant ownership check that needs the user ownership check appended.

**Current code:**

```typescript
// 4b. Cross-tenant ownership check — prevent resuming another tenant's session
const clientTenantId = clients.get(ws)?.tenantId;
if (clientTenantId && runtimeSession.tenantId && runtimeSession.tenantId !== clientTenantId) {
  send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
  return;
}
```

**Fixed code:**

```typescript
// 4b. Cross-tenant ownership check — prevent resuming another tenant's session
const clientTenantId = clients.get(ws)?.tenantId;
if (clientTenantId && runtimeSession.tenantId && runtimeSession.tenantId !== clientTenantId) {
  send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
  return;
}

// 4c. User ownership check — prevent resuming another user's session
const clientUserId = clients.get(ws)?.userId;
if (clientUserId && runtimeSession.userId && runtimeSession.userId !== clientUserId) {
  send(ws, { type: 'session_expired', sessionId, reason: 'Session not found or expired' });
  return;
}
```

**Test approach:**

- Unit test: user-1 creates a session, user-2 (same tenant) sends `resume_session`. Expect `session_expired`.
- Positive test: user-1 resumes their own session. Expect `session_resumed`.

---

### P4: Session export — missing projectId check

**Risk:** Export CSV of session traces from project-A via project-B's export endpoint.

**File:** `apps/runtime/src/routes/sessions.ts` lines 695-703

**Current code:**

```typescript
for (const sid of sessionIds) {
  // Verify session belongs to this tenant before exporting
  try {
    const dbSession = await findSessionById(sid, tenantId);
    if (!dbSession) continue; // Skip sessions that don't belong to this tenant
  } catch {
    log.warn('DB unavailable for tenant verification, skipping session in export', { sid });
    continue; // Do not serve unverified data
  }
```

**Fixed code:**

```typescript
const projectId = (req.params as Record<string, string>).projectId;

for (const sid of sessionIds) {
  // Verify session belongs to this tenant AND project before exporting
  try {
    const dbSession = await findSessionById(sid, tenantId);
    if (!dbSession) continue; // Skip sessions that don't belong to this tenant
    if (dbSession.projectId && dbSession.projectId !== projectId) continue; // Skip cross-project sessions
  } catch {
    log.warn('DB unavailable for tenant verification, skipping session in export', { sid });
    continue; // Do not serve unverified data
  }
```

**Test approach:**

- Create sessions in project-A and project-B. Export from project-A with both session IDs. Verify only project-A session appears in CSV.

---

### P5: Generations list — missing projectId check

**Risk:** LLM call events from sessions in other projects can be enumerated.

**File:** `apps/runtime/src/routes/sessions.ts` lines 809-821

**Current code:**

```typescript
for (const sid of sessionIds) {
  // Verify session belongs to this tenant
  if (!sessionIdFilter) {
    try {
      const dbSession = await findSessionById(sid, tenantId);
      if (!dbSession) continue;
    } catch {
      log.warn('DB unavailable for tenant verification, skipping session in generations', {
        sid,
      });
      continue; // Do not serve unverified data
    }
  }
```

**Fixed code:**

```typescript
const projectId = (req.params as Record<string, string>).projectId;

for (const sid of sessionIds) {
  // Verify session belongs to this tenant AND project
  if (!sessionIdFilter) {
    try {
      const dbSession = await findSessionById(sid, tenantId);
      if (!dbSession) continue;
      if (dbSession.projectId && dbSession.projectId !== projectId) continue; // Cross-project isolation
    } catch {
      log.warn('DB unavailable for tenant verification, skipping session in generations', {
        sid,
      });
      continue;
    }
  } else {
    // Even when sessionIdFilter is provided, verify project ownership
    // Note: sessionIdFilter is always a single ID, so this loop executes at most once
    try {
      const dbSession = await findSessionById(sid, tenantId);
      if (!dbSession || (dbSession.projectId && dbSession.projectId !== projectId)) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Session not found in this project' },
        });
        return;
      }
    } catch {
      log.warn('DB unavailable for tenant verification in generations', { sid });
      continue;
    }
  }
```

**Note:** The `sessionIdFilter` path currently skips tenant verification entirely. This fix adds project verification for both paths.

**Test approach:**

- Create session in project-A with LLM calls. Query generations from project-B with that sessionId. Expect 404.
- Query generations from project-A. Expect 200 with data.

---

## Phase 3: MEDIUM (Repos + RBAC)

These gaps are in shared repository functions and RBAC enforcement.

---

### P6: Tool secrets repo — `findToolSecretById` missing projectId check

**Risk:** A tool secret from project-A can be read/updated/deleted through any project-scoped route if the ID and tenantId match.

**File:** `packages/shared/src/repos/security-repo.ts` lines 99-106

**Current code:**

```typescript
export async function findToolSecretById(
  id: string,
  tenantId: string,
): Promise<NormalizedToolSecret | null> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const doc = await ToolSecret.findOne({ _id: id, tenantId }).lean();
  return normalizeToolSecret(doc);
}
```

**Fixed code:**

```typescript
// TODO(isolation): make projectId required after all callers updated
// Callers that need updating:
//   - apps/runtime/src/routes/tool-secrets.ts:341 (findToolSecretById — GET by ID)
//   - apps/runtime/src/routes/tool-secrets.ts:369 (updateToolSecret — PATCH)
//   - apps/runtime/src/routes/tool-secrets.ts:444 (findToolSecretById — DELETE pre-check)
//   - apps/runtime/src/routes/tool-secrets.ts:455 (deleteToolSecret — DELETE)
export async function findToolSecretById(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<NormalizedToolSecret | null> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ToolSecret.findOne(query).lean();
  return normalizeToolSecret(doc);
}
```

Also update `updateToolSecret` and `deleteToolSecret` similarly:

**File:** `packages/shared/src/repos/security-repo.ts` lines 115-134

```typescript
// updateToolSecret — add optional projectId parameter
export async function updateToolSecret(
  id: string,
  tenantId: string,
  data: ToolSecretUpdateData,
  projectId?: string,
): Promise<NormalizedToolSecret | null> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ToolSecret.findOne(query);
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalizeToolSecret(doc.toObject());
}

// deleteToolSecret — add optional projectId parameter
export async function deleteToolSecret(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  const { ToolSecret } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  await ToolSecret.deleteOne(query);
}
```

**Callers to update:** `apps/runtime/src/routes/tool-secrets.ts` — pass `projectId` from request body/query to all three functions.

**Test approach:**

- Unit test: create secret in project-A. Call `findToolSecretById(id, tenantId, projectB)`. Expect null.
- Integration test: attempt to rotate/delete secret through wrong project route. Expect 404.

---

### P7: MCP server config repo — missing projectId in write queries

**Risk:** `updateMcpServerConfig` uses `{ _id, tenantId }` but not `projectId`. A user in one project could update an MCP config belonging to another project within the same tenant.

**File:** `packages/shared/src/repos/mcp-server-config-repo.ts` lines 122-136

**Current code:**

```typescript
export async function updateMcpServerConfig(
  id: string,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<NormalizedMCPServerConfig | null> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const doc = await MCPServerConfig.findOne({ _id: id, tenantId });
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalize(doc.toObject());
}
```

**Fixed code:**

```typescript
// TODO(isolation): make projectId required after all callers updated
// Callers that need updating:
//   - apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts (PATCH handler)
//   - apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts (DELETE handler)
//   - packages/shared/src/repos/mcp-server-config-repo.ts:149 (updateMcpServerConfigStatus — internal wrapper)
export async function updateMcpServerConfig(
  id: string,
  tenantId: string,
  data: Record<string, unknown>,
  projectId?: string,
): Promise<NormalizedMCPServerConfig | null> {
  const { MCPServerConfig } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await MCPServerConfig.findOne(query);
  if (!doc) return null;
  for (const [key, value] of Object.entries(data)) {
    doc.set(key, value);
  }
  await doc.save();
  return normalize(doc.toObject());
}
```

Also update `deleteMcpServerConfigWithCascade` at line 154 similarly.

**Callers to update:** any route calling `updateMcpServerConfig` or `deleteMcpServerConfigWithCascade` should pass the route's `projectId`.

**Test approach:**

- Unit test: create config in project-A. Call update with `projectId=project-B`. Expect null.
- Integration test: attempt PATCH through wrong project endpoint. Expect 404.

---

### U5: Runtime sessions list — no user scoping for platform members

**Risk:** Platform members (non-SDK auth) see ALL sessions in the project, not just their own.

**File:** `apps/runtime/src/routes/sessions.ts` lines 257-264

**Current code:**

```typescript
if (tenantCtx?.authType === 'sdk_session') {
  const authCtx = toAuthContext(tenantCtx);
  where = buildSessionListFilter(authCtx, projectId);
} else {
  where = {};
  where.tenantId = req.tenantContext!.tenantId;
  where.projectId = projectId;
}
```

**Fixed code:**

```typescript
if (tenantCtx?.authType === 'sdk_session') {
  const authCtx = toAuthContext(tenantCtx);
  where = buildSessionListFilter(authCtx, projectId);
} else {
  where = {};
  where.tenantId = req.tenantContext!.tenantId;
  where.projectId = projectId;

  // User-level scoping: non-admin platform members see only their own sessions.
  // Admin/owner users and API keys bypass this filter.
  const userId = tenantCtx?.userId;
  const role = tenantCtx?.role;
  const isAdmin = role === 'admin' || role === 'owner';
  if (userId && !isAdmin && tenantCtx?.authType !== 'api_key') {
    where.initiatedById = userId;
  }
}
```

**Test approach:**

- Unit test: create sessions for user-1 and user-2 in the same project. List as user-1 (member role). Expect only user-1's sessions.
- Admin test: list as admin. Expect all sessions.
- API key test: list with API key. Expect all sessions.

---

### U6: Agent ownership transfer — no owner/admin check

**Risk:** Any project member can reassign agent ownership to themselves or anyone else.

**File:** `apps/studio/src/app/api/projects/[id]/agents/[agentId]/ownership/route.ts` lines 36-72

**Current code:**

The PUT handler only checks `requireProjectAccess` (membership), not whether the caller is the current owner or an admin.

```typescript
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  // ... directly upserts ownership
  const ownership = await AgentOwnership.findOneAndUpdate(
    { projectId, agentId },
    {
      $set: {
        ownerId: body.ownerId ?? null,
        ownerTeamId: body.ownerTeamId ?? null,
        agentName: body.agentName ?? agentId,
      },
      $setOnInsert: { projectId, agentId },
    },
    { upsert: true, new: true },
  ).lean();
```

**Fixed code:**

```typescript
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  // Note: import { IAgentOwnership } from '@agent-platform/database/models' for the type cast below.
  // Authorization: only the current owner or project admin/owner can transfer ownership
  const tenantId = access.project.tenantId;
  const existing = await AgentOwnership.findOne({ projectId, agentId }).lean() as IAgentOwnership | null;
  const isAdmin = user.role === 'admin' || user.role === 'owner';
  if (existing && existing.ownerId !== user.id && !isAdmin) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ... upsert ownership (unchanged)
  const ownership = await AgentOwnership.findOneAndUpdate(
    { projectId, agentId },
    {
      $set: {
        ownerId: body.ownerId ?? null,
        ownerTeamId: body.ownerTeamId ?? null,
        agentName: body.agentName ?? agentId,
        // Note: audit fields (transferredBy, transferredAt) omitted —
        // AgentOwnership schema does not have these fields yet
      },
      $setOnInsert: { projectId, agentId },
    },
    { upsert: true, new: true },
  ).lean();
```

**Test approach:**

- Unit test: user-1 owns agent-X. User-2 (member) tries PUT to reassign. Expect 404.
- Admin test: admin user can transfer ownership. Expect 200.
- New ownership test: no existing owner. Any member can claim. Expect 200.

---

## Phase 4: LOW (Cleanup)

Lower-impact gaps that should be addressed for defense-in-depth.

---

### P8: Config variables repo — `findConfigVariableById` and `deleteConfigVariable` missing projectId

**Risk:** A config variable from project-A can be read or deleted by a user with access to project-B in the same tenant, if the variable ID is known.

**File:** `apps/studio/src/repos/config-variable-repo.ts` lines 43-48 and 106-110

**Current code:**

```typescript
export async function findConfigVariableById(id: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const doc = await ProjectConfigVariable.findOne({ _id: id, tenantId }).lean();
  return normalizeId(doc);
}

export async function deleteConfigVariable(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  await ProjectConfigVariable.findOneAndDelete({ _id: id, tenantId });
}
```

**Fixed code:**

```typescript
export async function findConfigVariableById(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ProjectConfigVariable.findOne(query).lean();
  return normalizeId(doc);
}

export async function deleteConfigVariable(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  await ProjectConfigVariable.findOneAndDelete(query);
}
```

Also update `updateConfigVariable` (line 84) to accept and use `projectId`.

**Callers to update:** any Studio API route calling these functions should pass `projectId` from the route params.

**Test approach:**

- Unit test: create variable in project-A. Call `findConfigVariableById(id, tenantId, projectB)`. Expect null.

---

### P9: Channel connections — missing projectId in write queries

**Risk:** `ChannelConnection.findOneAndUpdate` on lines 541, 918, 972, 1002, 1154 uses `{ _id, tenantId }` but omits `projectId`. A user in project-B could theoretically modify a channel connection in project-A if they know the ID.

**File:** `apps/runtime/src/routes/channel-connections.ts` — multiple locations

**Current code (example at line 541):**

```typescript
await ChannelConnection.findOneAndUpdate({ _id: doc._id, tenantId }, { $set: configUpdate });
```

**Fixed code:**

```typescript
await ChannelConnection.findOneAndUpdate(
  { _id: doc._id, tenantId, projectId },
  { $set: configUpdate },
);
```

Apply the same `projectId` addition to all `findOneAndUpdate` calls in this file:

- Line 541: `{ _id: doc._id, tenantId }` -> `{ _id: doc._id, tenantId, projectId }`
- Line 918: `{ _id: req.params.id, tenantId }` -> `{ _id: req.params.id, tenantId, projectId }`
- Line 972: `{ _id: req.params.id, tenantId }` -> `{ _id: req.params.id, tenantId, projectId }`
- Line 1002: `{ _id: req.params.id, tenantId }` -> `{ _id: req.params.id, tenantId, projectId }`
- Line 1154: `{ _id: req.params.id, tenantId }` -> `{ _id: req.params.id, tenantId, projectId }`

**Test approach:**

- Unit test: create connection in project-A. Attempt PATCH through project-B. Verify connection is unchanged.

---

### U7: Human tasks — no default user scoping

**Risk:** The human tasks list endpoint returns all tasks in a project. A non-admin user can see tasks assigned to other users.

**File:** `apps/runtime/src/routes/human-tasks.ts` lines 56-79

**Current code:**

```typescript
const filter: Record<string, unknown> = { tenantId, projectId };
if (status) filter.status = status;
if (type) filter.type = type;
if (assignedTo) filter.$or = [{ assignedTo }, { claimedBy: assignedTo }];
if (priority) filter.priority = priority;
```

**Fixed code:**

```typescript
const filter: Record<string, unknown> = { tenantId, projectId };
if (status) filter.status = status;
if (type) filter.type = type;
if (priority) filter.priority = priority;

if (assignedTo) {
  filter.$or = [{ assignedTo }, { claimedBy: assignedTo }];
} else {
  // Default user scoping: non-admin users see only tasks assigned to or created by them.
  const userId = (req as any).tenantContext?.userId;
  const role = (req as any).tenantContext?.role;
  const isAdmin = role === 'admin' || role === 'owner';
  if (userId && !isAdmin) {
    filter.$or = [{ assignedTo: userId }, { claimedBy: userId }, { createdBy: userId }];
  }
}
```

**Test approach:**

- Unit test: create tasks assigned to user-1 and user-2. User-1 (member) lists without `assignedTo` filter. Expect only user-1's tasks.
- Admin test: admin lists all tasks. Expect all.

---

### U8: Tenant credentials — no RBAC permission check

**Risk:** Any authenticated user in the tenant can create, read, update, and delete org-level LLM credentials. There is no role-based restriction.

**File:** `apps/studio/src/app/api/tenant-credentials/route.ts` lines 44-46 and 77-79

**Current code:**

```typescript
async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  // ... proceeds with no role check
```

**Fixed code:**

```typescript
async function getHandler(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  // RBAC: only admin/owner can manage tenant-level credentials
  if (user.role !== 'admin' && user.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // ... proceeds
```

Apply the same RBAC check to `postHandler` in the same file and to all handlers in `apps/studio/src/app/api/tenant-credentials/[id]/route.ts`.

**Test approach:**

- Unit test: member-role user calls GET /api/tenant-credentials. Expect 403.
- Admin test: admin user calls GET. Expect 200 with credential list.
- Same tests for POST, PATCH, DELETE.

---

## Implementation Checklist

| ID  | Phase | Severity | Fix Summary                                    | LOC | Files Changed |
| --- | ----- | -------- | ---------------------------------------------- | --- | ------------- |
| U1  | 1     | CRITICAL | WS list_sessions tenant+user filter            | ~25 | 1             |
| U2  | 1     | CRITICAL | WS subscribe_session userId check              | ~8  | 1             |
| P1  | 1     | CRITICAL | Session traces projectId check                 | ~6  | 1             |
| P2  | 1     | CRITICAL | Session metrics projectId check + 503 fallback | ~10 | 1             |
| P3  | 1     | CRITICAL | Span children projectId check                  | ~4  | 1             |
| U3  | 2     | HIGH     | Studio sessions list userId filter             | ~10 | 2             |
| U4  | 2     | HIGH     | WS resume_session userId check                 | ~6  | 1             |
| P4  | 2     | HIGH     | Session export projectId check                 | ~3  | 1             |
| P5  | 2     | HIGH     | Generations list projectId check               | ~15 | 1             |
| P6  | 3     | MEDIUM   | Tool secrets repo projectId param              | ~20 | 2             |
| P7  | 3     | MEDIUM   | MCP config repo projectId in writes            | ~10 | 2             |
| U5  | 3     | MEDIUM   | Runtime sessions list user scoping             | ~8  | 1             |
| U6  | 3     | MEDIUM   | Ownership transfer owner/admin check           | ~10 | 1             |
| P8  | 4     | LOW      | Config variables repo projectId param          | ~15 | 2             |
| P9  | 4     | LOW      | Channel connections projectId in writes        | ~5  | 1             |
| U7  | 4     | LOW      | Human tasks default user scoping               | ~10 | 1             |
| U8  | 4     | LOW      | Tenant credentials RBAC check                  | ~20 | 2             |

**Total estimated LOC:** ~185 lines changed across ~15 files.

---

## Testing Strategy

### Unit Tests (per fix)

Each fix gets a dedicated test file following the pattern `<module>-isolation.test.ts`:

- `apps/runtime/src/__tests__/ws-session-isolation.test.ts` — U1, U2, U4
- `apps/runtime/src/__tests__/session-traces-isolation.test.ts` — P1, P2, P3
- `apps/runtime/src/__tests__/session-export-isolation.test.ts` — P4, P5
- `apps/studio/src/__tests__/studio-sessions-isolation.test.ts` — U3
- `packages/shared/src/__tests__/security-repo-isolation.test.ts` — P6
- `packages/shared/src/__tests__/mcp-config-repo-isolation.test.ts` — P7
- `apps/runtime/src/__tests__/session-list-isolation.test.ts` — U5
- `apps/studio/src/__tests__/ownership-transfer-isolation.test.ts` — U6

### Integration Pattern

For each fix, the test should follow this template:

1. **Setup:** Create resources (sessions, secrets, configs) in project-A and project-B under the same tenant. Create user-1 and user-2 in the tenant.
2. **Cross-project test:** Access project-A's resource via project-B's endpoint. Expect 404.
3. **Cross-user test:** User-2 accesses user-1's resource. Expect 404 or filtered results.
4. **Cross-tenant test:** Tenant-B accesses tenant-A's resource. Expect 404.
5. **Positive test:** Correct user/project/tenant accesses the resource. Expect 200 with correct data.

### Regression Safety

- Run `pnpm build` after each phase to catch type errors from signature changes.
- Run existing test suites (`pnpm test --filter=runtime`, `pnpm test --filter=studio`) to catch regressions.
- The optional `projectId` parameter in repo functions preserves backward compatibility with callers that do not yet pass it.

---

## Rollout Order

1. **Phase 1** (CRITICAL): Deploy immediately. These are active data leak vectors.
2. **Phase 2** (HIGH): Deploy within the same sprint. These affect Studio UX and session control.
3. **Phase 3** (MEDIUM): Deploy in the following sprint. These are defense-in-depth improvements.
4. **Phase 4** (LOW): Deploy as part of regular maintenance. Lower risk but still important for compliance.
