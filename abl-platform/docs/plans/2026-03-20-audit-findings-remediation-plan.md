# Audit Findings Remediation Plan

**Date:** 2026-03-20
**Audit scope:** 22 local commits on develop + uncommitted changes (282 files, +20,487 / -6,361)
**Auditors:** Security, Runtime, Studio, Tests, Shared Packages

## Priority Legend

- **P0:** Fix before push (Critical security, data integrity)
- **P1:** Fix this sprint (High impact, correctness)
- **P2:** Fix next sprint (Medium, defense-in-depth)
- **P3:** Backlog (Low, code quality)

---

## Phase 1: P0 — Security Critical (Fix before push)

### C1: Unbounded `clients` Map — OOM risk under connection flood

- **File:** `apps/runtime/src/websocket/handler.ts:196`
- **Current code:** `const clients = new Map<WebSocket, ClientState>();` — no size limit, no eviction, no monitoring.
- **Architecture:** Extract a `WebSocketConnectionManager` class that encapsulates the `clients` Map with lifecycle guarantees. This replaces the bare Map with a managed abstraction used by both `handler.ts` and `sdk-handler.ts`.
- **Implementation steps:**
  1. Create `apps/runtime/src/websocket/connection-manager.ts` with a `WebSocketConnectionManager` class:
     - Constructor takes `{ maxConnections: number, staleTtlMs: number, sweepIntervalMs: number }` from `config.server`.
     - Wraps an internal `Map<WebSocket, ClientState>` with `add(ws, state)`, `remove(ws)`, `get(ws)`, `size` accessors.
     - `add()` enforces capacity — rejects with WebSocket close code 1013 (Try Again Later) when full.
     - Tracks `lastActivity: number` on every `ClientState` — updated on every inbound message.
     - Runs a periodic stale-connection sweep (configurable interval, default 60s) that closes connections idle beyond `staleTtlMs` (default 5min). Sweep uses `setInterval` with `unref()` so it doesn't prevent process exit.
     - Exposes Prometheus-compatible gauge: `ws_active_connections{type="internal|sdk"}`.
     - `shutdown()` method closes all connections gracefully (code 1001) and clears the sweep interval.
  2. Refactor `handler.ts` to use `WebSocketConnectionManager` instead of the bare `clients` Map. The SDK handler (`sdk-handler.ts`) already has `MAX_SDK_CLIENTS` — migrate it to use the same manager.
  3. Wire `config.server.maxWsConnections` (with a sensible default of 10,000) from `packages/config/src/constants.ts`.
  4. Register `shutdown()` in the server's graceful-shutdown sequence.
- **Effort:** M (3-4 hours)
- **Acceptance criteria:**
  - Unit test: attempting to open connection #MAX+1 returns 1013 close code.
  - Unit test: stale sweep closes idle connections after TTL.
  - Both `handler.ts` and `sdk-handler.ts` use the same `WebSocketConnectionManager`.
  - `clients.size` never exceeds configured max.
  - Gauge metric emitted.
- **Dependencies:** None

### C2: ClickHouse SQL endpoint leaks raw error messages

- **File:** `apps/runtime/src/routes/analytics.ts:836-848`
- **Current code:** `res.status(500).json({ success: false, error: \`Query execution failed: ${errorMsg}\` })` — exposes ClickHouse schema names, table structures, version info.
- **Implementation steps:**
  1. Replace the catch block (lines 836-846) to return a generic error to the caller:
     ```typescript
     res.status(500).json({
       success: false,
       error: { code: 'QUERY_EXECUTION_FAILED', message: 'Query execution failed' },
     });
     ```
  2. Keep the `log.error(...)` call that already logs the full error server-side (line 838).
  3. Also fix the inconsistent error format on lines 751-754, 759-763, 767-772 — these return `{ error: 'string' }` instead of `{ error: { code, message } }`. (See also H5.)
  4. Remove the unused `SQL_QUERY_TIMEOUT_MS` constant at line 639 while in this file. (See L2.)
- **Effort:** S (30 min)
- **Acceptance criteria:**
  - No raw ClickHouse error text in any 4xx/5xx response body.
  - All error responses from this endpoint use `{ success: false, error: { code, message } }` format.
  - Server-side log still contains the full error for debugging.
- **Dependencies:** Fix H5 at the same time since they're in the same file.

### C3: Share exchange tenant-less project lookup — cross-tenant data leak

- **File:** `apps/studio/src/app/api/sdk/share/exchange/route.ts:85-87`
- **Current code:**
  ```typescript
  const projectFilter = payload.tenantId
    ? { _id: payload.projectId, tenantId: payload.tenantId }
    : { _id: payload.projectId };
  ```
  Legacy tokens without `tenantId` allow any project to be fetched by ID alone.
- **Architecture:** Preview/share is not in production yet — there are zero legacy tokens to support. Delete the fallback entirely. The exchange endpoint must always require `tenantId` in the token payload; this is enforced at the Zod schema level so invalid tokens are rejected during parsing, not in application logic.
- **Implementation steps:**
  1. Update the `shareTokenPayloadSchema` (in `sdk-share-token.ts`) to make `tenantId` required (`z.string().min(1)`), removing the `.optional()` modifier.
  2. Delete the conditional fallback in the exchange route. Replace with a direct tenant-scoped query:
     ```typescript
     const rawDoc = await Project.findOne({
       _id: payload.projectId,
       tenantId: payload.tenantId,
     }).lean();
     ```
  3. Delete any comments referencing "legacy tokens" or "backward compatibility" in the share/exchange flow — they no longer apply.
  4. Update `signShareToken()` in `sdk-share-token.ts` to require `tenantId` in its input type (remove optionality).
- **Effort:** S (30 min)
- **Acceptance criteria:**
  - `tenantId` is required in the Zod schema — tokens without it fail parsing with 400.
  - Project lookup always includes `tenantId` in the query filter.
  - No conditional fallback paths exist in the exchange route.
  - E2E test: share exchange with a tenant-scoped token succeeds; a token without `tenantId` returns 400 (schema validation).
- **Dependencies:** C4 should be fixed first or simultaneously since it affects how `tenantId` gets into the share token.

### C4: Share POST uses `ownerId` instead of `tenantId` for project lookup

- **File:** `apps/studio/src/app/api/sdk/share/route.ts:51`
- **Current code:**
  ```typescript
  const project = await Project.findOne({ _id: projectId, ownerId: user.id }).lean();
  ```
  This only matches projects owned by the requesting user, excluding team members. It also doesn't verify tenantId.
- **Architecture:** Preview/share is not in production — redesign the share POST route to follow the same tenant-scoped auth pattern as all other Studio API routes. No backward compat needed.
- **Implementation steps:**
  1. Switch from `requireAuth` to `requireTenantAuth` on this route, matching the archive routes and other tenant-scoped endpoints. This gives us `user.tenantId` from the verified auth chain.
  2. Replace the project lookup to use tenant-scoped query:
     ```typescript
     const project = await Project.findOne({ _id: projectId, tenantId: user.tenantId }).lean();
     ```
  3. Add project-level permission check via `requireProjectPermission(req, res, 'sdk:share')` or verify the user's role on the project (admin/editor) — not just tenant membership.
  4. Validate the request body against `createShareRequestSchema` at the top of the handler (line 38). The schema exists at line 18 but is only used for OpenAPI metadata, not runtime validation:
     ```typescript
     const body = createShareRequestSchema.parse(await request.json());
     const { projectId, channelId, expiresIn = 7 * 24 * 60 * 60 * 1000 } = body;
     ```
     This also fixes H7 (`expiresIn` NaN risk).
  5. Add rate limiting (fixes M8) — rate-limit by `user.id` at 10 req/min using `checkRateLimit`.
  6. Verify that `project.tenantId` is passed to `signShareToken` — it currently is, which is correct.
- **Effort:** M (1-2 hours)
- **Acceptance criteria:**
  - Route uses `requireTenantAuth`, not `requireAuth`.
  - Team members (same tenant, different `ownerId`) can generate share tokens.
  - Users from different tenants get 404.
  - Project-level permission is checked (not just tenant membership).
  - `expiresIn` is validated as a number via Zod; non-numeric values return 400.
  - Rate limited at 10 req/min per user.
  - `tenantId` is always present in the signed token payload.
- **Dependencies:** None (C3 depends on this being correct). Subsumes H7 and M8.

---

## Phase 2: P1 — High Priority (This sprint)

### H1: `getAuthorizedRuntimeSession` skips ownership check when `messageType` is falsy

- **File:** `apps/runtime/src/websocket/handler.ts:548`
- **Current code:**
  ```typescript
  if (!messageType || ensureWsSessionAccess(ws, sessionId, runtimeSession, messageType)) {
    return runtimeSession;
  }
  ```
  When `messageType` is `undefined` (optional parameter), the short-circuit `!messageType` returns the session without calling `ensureWsSessionAccess`.
- **Architecture:** Make `messageType` a required parameter — eliminate the optional path entirely. Every WebSocket message has a type; callers that don't pass one have a bug, not a valid use case.
- **Implementation steps:**
  1. Change the function signature from `messageType?: string` to `messageType: string` in:
     - `getAuthorizedRuntimeSession` (line 548)
     - `getAuthorizedPersistedSession` (line 555)
     - `hasAuthorizedSessionAccess` (line 584)
  2. Remove the `!messageType ||` short-circuit from all three functions. The access check always runs:
     ```typescript
     if (ensureWsSessionAccess(ws, sessionId, runtimeSession, messageType)) {
       return runtimeSession;
     }
     ```
  3. Audit all call sites — `grep -rn "getAuthorizedRuntimeSession\|getAuthorizedPersistedSession\|hasAuthorizedSessionAccess" apps/runtime/src/`. Fix any callers that omit `messageType` by passing the actual message type from the WebSocket frame.
  4. TypeScript will catch any remaining callers at compile time since the parameter is now required.
- **Effort:** S (1 hour)
- **Acceptance criteria:**
  - `messageType` is a required parameter (not optional) in all three function signatures.
  - No `!messageType` short-circuit exists.
  - `pnpm build --filter=@agent-platform/runtime` passes (TypeScript catches all callers).
  - Existing session access E2E tests still pass.
- **Dependencies:** None

### H2: N+1 Redis sequential GET in agent-transfer-sessions

- **File:** `apps/runtime/src/routes/agent-transfer-sessions.ts:87-122`
- **Current code:** Calls `sessionStore.get(key)` sequentially in a `for` loop for every active session key.
- **Architecture:** Add a `getMany(keys: string[]): Promise<(T | null)[]>` method to the session store interface, backed by Redis `MGET`. This is a reusable primitive — other callers that batch-read sessions will benefit. Also add server-side cursor pagination to avoid loading all keys into memory.
- **Implementation steps:**
  1. Add `getMany(keys: string[]): Promise<(T | null)[]>` to the session store interface (the abstract class or interface that `sessionStore` implements). Implement using Redis `MGET`:
     ```typescript
     async getMany(keys: string[]): Promise<(SessionData | null)[]> {
       if (keys.length === 0) return [];
       const values = await this.redis.mget(keys.map(k => this.prefixKey(k)));
       return values.map(v => v ? JSON.parse(v) : null);
     }
     ```
  2. Replace the sequential loop with:
     ```typescript
     const sessionData = await sessionStore.getMany(activeKeys);
     const sessions = sessionData
       .filter((s): s is SessionData => s !== null && s.tenantId === tenantId)
       .map((s) => ({
         /* projection */
       }));
     ```
  3. For the listing endpoint, add cursor-based pagination using Redis `SCAN` with `COUNT` hint instead of `KEYS *`:
     ```typescript
     const { keys, cursor: nextCursor } = await sessionStore.scanKeys(`transfer:${tenantId}:*`, {
       count: pageSize,
       cursor: req.query.cursor,
     });
     ```
     Return `nextCursor` in the response for the client to paginate. This also fixes L4 (in-memory pagination after full load).
  4. Add `scanKeys(pattern, opts)` to the session store interface.
- **Effort:** M (3-4 hours)
- **Acceptance criteria:**
  - Single `MGET` round-trip per page of results.
  - Cursor-based pagination — no full key scan into memory.
  - `getMany` is a reusable method on the session store interface.
  - Latency under 50ms for a page of 50 sessions.
- **Dependencies:** Subsumes L4.

### H3: Swallowed errors `.catch(() => {})`

- **Files:**
  - `apps/runtime/src/services/runtime-executor.ts:2534`
  - `apps/runtime/src/services/auth-profile/paused-execution-store.ts:174, 208, 230, 251, 477`
- **Implementation steps:**
  1. **runtime-executor.ts:2534** — Memory bridge unregister:
     ```typescript
     .catch((err: unknown) => {
       log.warn('Memory bridge unregister failed', {
         sessionId,
         error: err instanceof Error ? err.message : String(err),
       });
     });
     ```
  2. **paused-execution-store.ts:174, 208, 230, 251** — `deleteRedisKey` calls: These are fire-and-forget cleanup during timeout/resolve/reject. Replace each `.catch(() => {})` with:
     ```typescript
     .catch((err: unknown) => {
       log.warn('Redis key cleanup failed', {
         sessionId: data.sessionId,
         toolCallId: data.toolCallId,
         error: err instanceof Error ? err.message : String(err),
       });
     });
     ```
  3. **paused-execution-store.ts:477** — `redisSubscriber.quit()`:
     ```typescript
     void this.redisSubscriber.quit?.().catch((err: unknown) => {
       log.warn('Redis subscriber quit failed', {
         error: err instanceof Error ? err.message : String(err),
       });
     });
     ```
- **Effort:** S (30 min)
- **Acceptance criteria:**
  - No `.catch(() => {})` patterns remain in these files.
  - All swallowed errors produce a `log.warn` with context.
  - `grep -r "\.catch(() => {})" apps/runtime/src/` returns no results.
- **Dependencies:** None

### H4: `console.log` / `console.warn` in production code

- **Files:**
  - `apps/runtime/src/index.ts:23-47, 62-63, 67`
  - `apps/runtime/src/channels/adapters/slack-file-processor.ts:56, 73, 79`
  - `apps/runtime/src/observability/otel-setup.ts:114`
- **Implementation steps:**
  1. **index.ts:23-47** — HTTP debug interceptor: This entire block is a debug-only feature. Wrap in a `if (process.env.HTTP_DEBUG === 'true')` guard and replace all `console.log` with `log.debug` using `createLogger('http-debug')`. Better yet, extract to a separate `debug-fetch-interceptor.ts` module.
  2. **index.ts:62-63** — Config warnings: Replace `console.warn` with `log.warn('Config validation warnings', { warnings: meta.validationWarnings })`. Note: `log` must be created after config loads. Use a late-bound logger or import the config logger.
  3. **index.ts:67** — API key presence: Replace `console.log` with `log.info('LLM configuration', { anthropicKeyConfigured: Boolean(anthropicKey) })`.
  4. **slack-file-processor.ts:56, 73, 79** — Replace `console.warn`/`console.error` with the module logger. A `LOG_PREFIX` constant is already used; replace it with `createLogger('slack-file-processor')` at the top. Update:
     - Line 56: `log.warn('Download failed', { filename: ref.name, error: download.error })`
     - Line 73: `log.warn('Upload failed', { filename: ref.name, error: upload.error })`
     - Line 79: `log.error('File processing error', { filename: ref.name, error: err instanceof Error ? err.message : String(err) })`
  5. **otel-setup.ts:114** — Replace `console.error('OTEL shutdown error:', err)` with a structured logger call. Since this is the OTEL module, the logger may not be available; use `process.stderr.write` as a last resort, or import a minimal logger.
- **Effort:** M (2 hours)
- **Acceptance criteria:**
  - `grep -rn "console\.\(log\|warn\|error\)" apps/runtime/src/` returns zero hits (excluding test files and intentional `process.stderr.write` in shutdown paths).
  - All log output uses structured `createLogger` loggers.
- **Dependencies:** None

### H5: Inconsistent error format in analytics routes

- **File:** `apps/runtime/src/routes/analytics.ts` — multiple locations
- **Current code:** Returns `{ error: 'string' }` instead of `{ success: false, error: { code, message } }`.
- **Implementation steps:**
  1. Replace all error responses in this file to use the standard format. Affected lines include:
     - Line 751-754: `{ success: false, error: 'Only SELECT queries are allowed' }` → `{ success: false, error: { code: 'INVALID_QUERY', message: 'Only SELECT queries are allowed' } }`
     - Line 759-763: forbidden keywords → `{ code: 'FORBIDDEN_SQL', message: '...' }`
     - Line 767-772: validation error → `{ code: 'VALIDATION_ERROR', message: validationError }`
     - Line 784: unavailable → `{ code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' }`
     - Line 836-845: execution failed → `{ code: 'QUERY_EXECUTION_FAILED', message: 'Query execution failed' }` (see C2)
  2. Update the OpenAPI response schema at lines 730-738 to reflect the structured error format.
- **Effort:** S (30 min)
- **Acceptance criteria:**
  - All error responses from `/api/projects/:projectId/analytics/sql` use `{ success: false, error: { code, message } }`.
  - OpenAPI schema matches the actual response shape.
- **Dependencies:** Fix alongside C2.

### H6: `console.error` in all 6 archive API routes

- **Files:**
  - `apps/studio/src/app/api/archives/[id]/download/route.ts:40`
  - `apps/studio/src/app/api/archives/[id]/route.ts:35`
  - `apps/studio/src/app/api/archives/route.ts:42`
  - `apps/studio/src/app/api/archives/sessions/route.ts:46`
  - `apps/studio/src/app/api/archives/traces/route.ts:45`
  - `apps/studio/src/app/api/archives/audit-export/route.ts:42`
- **Implementation steps:**
  1. Add `import { createLogger } from '@abl/compiler/platform';` and `const log = createLogger('archives');` to each route file (or a shared archives logger).
  2. Replace each `console.error('[Archives] ... error:', error)` with:
     ```typescript
     log.error('Archive operation failed', {
       operation: '<download|delete|list|session-archive|trace-archive|audit-export>',
       error: error instanceof Error ? error.message : String(error),
     });
     ```
  3. Consider extracting a shared error handler for these routes since they all have the same try/catch pattern.
- **Effort:** S (45 min)
- **Acceptance criteria:**
  - No `console.error` in any archive route file.
  - All errors logged via `createLogger`.
- **Dependencies:** None

### H7: Share route body not validated with Zod

- **Subsumed by C4.** The share route redesign (C4) includes Zod validation, rate limiting, and tenant-scoped auth as a single coherent change. No separate fix needed.
- **Dependencies:** C4

### H8: Missing barrel re-exports in shared packages

- **Files:**
  - `packages/shared/src/index.ts`
  - `packages/shared-auth/src/middleware/index.ts`
- **Current status:** After reading both files, `buildSessionListFilter`, `evaluateSessionOwnershipAccess` ARE already exported from `packages/shared-auth/src/middleware/index.ts` (lines 68-69) and from `packages/shared/src/index.ts` (lines 39-40). The `AccessDeniedConfig` type does not exist anywhere in the codebase (grep returned zero results).
- **Implementation steps:**
  1. Verify the audit finding. The exports appear to already be present. Run:
     ```bash
     pnpm build --filter=@agent-platform/shared-auth
     ```
     and check that downstream consumers can import these symbols.
  2. If `AccessDeniedConfig` was meant to refer to `AccessDeniedReporterConfig`, add the type re-export:
     - In `packages/shared-auth/src/middleware/index.ts`, add to the access-denial exports:
       ```typescript
       export type { AccessDeniedReporterConfig } from './access-denial.js';
       ```
     - In `packages/shared/src/index.ts`, add to the type exports:
       ```typescript
       AccessDeniedReporterConfig,
       ```
- **Effort:** S (15 min)
- **Acceptance criteria:**
  - `import { buildSessionListFilter, evaluateSessionOwnershipAccess } from '@agent-platform/shared'` compiles.
  - If `AccessDeniedReporterConfig` is needed downstream, it is importable.
- **Dependencies:** None

---

## Phase 3: P2 — Medium Priority (Next sprint)

### M1: Redis Pub/Sub channel key lacks tenantId

- **File:** `apps/runtime/src/websocket/handler.ts:606-639`
- **Current code:** Channel format is `ws:deliver:{sessionId}` (line 608). Any pod can publish to any session's channel regardless of tenant.
- **Implementation steps:**
  1. Change channel format to `ws:deliver:{tenantId}:{sessionId}`.
  2. Update `registerSession` (line 646) to subscribe to the tenant-scoped channel.
  3. Update any `publish` calls (search for `ws:deliver:`) to include tenantId.
  4. In the message handler (line 606), validate that the tenantId in the channel matches the connected client's tenantId.
- **Effort:** M (2 hours)
- **Acceptance criteria:**
  - Channel keys always include tenantId.
  - Cross-tenant message delivery is impossible even with a rogue publisher.
- **Dependencies:** None

### M2: Non-null assertion on `userId` in `requireWriteAccess`

- **File:** `apps/runtime/src/middleware/rbac.ts:112`
- **Current code:** `req.tenantContext.userId!` — non-null assertion.
- **Implementation steps:**
  1. Add a guard before the membership lookup:
     ```typescript
     if (!req.tenantContext.userId) {
       return sendRuntimeAccessDenied(
         req,
         res,
         {
           allowed: false,
           statusCode: 401,
           publicError: 'User identity required',
           reasonCode: 'USER_ID_MISSING',
           reason: 'Tenant context lacks userId',
           concealAsNotFound: false,
           scope: 'auth',
         },
         'tenant:write',
       );
     }
     ```
  2. Remove the `!` assertion.
- **Effort:** S (15 min)
- **Acceptance criteria:**
  - No non-null assertions on `userId` in rbac.ts.
  - Requests without userId get a proper 401.
- **Dependencies:** None

### M3: `platformAdminAuthMiddleware` doesn't check `isSuperAdmin`

- **File:** `apps/runtime/src/middleware/auth.ts:200-205`
- **Current code:** Only calls `unifiedAuth` + `requireAuthenticatedRequestOnly`. Any authenticated user can access platform-admin routes.
- **Architecture:** The super-admin check must be composed into the middleware itself — not left as a responsibility of each downstream route. A middleware named `platformAdminAuth` that doesn't enforce admin status is a misleading API surface.
- **Implementation steps:**
  1. Compose `isSuperAdmin` into `platformAdminAuthMiddleware` as the final gate. The middleware becomes a 3-step chain: authenticate → verify user identity → verify super-admin:
     ```typescript
     export const platformAdminAuthMiddleware = compose(
       unifiedAuth,
       requireAuthenticatedRequestOnly,
       requireSuperAdmin, // new: rejects with 403 if !isSuperAdmin(userId)
     );
     ```
  2. Create `requireSuperAdmin` as a reusable middleware in `apps/runtime/src/middleware/auth.ts`:
     ```typescript
     const requireSuperAdmin: RequestHandler = (req, res, next) => {
       const userId = req.tenantContext?.userId;
       if (!userId || !isSuperAdmin(userId)) {
         return sendRuntimeAccessDenied(
           req,
           res,
           {
             allowed: false,
             statusCode: 403,
             publicError: 'Platform admin access required',
             reasonCode: 'NOT_SUPER_ADMIN',
             reason: 'User is not a super admin',
             concealAsNotFound: false,
             scope: 'auth',
           },
           'platform:admin',
         );
       }
       next();
     };
     ```
  3. Audit all routes using `platformAdminAuthMiddleware` — remove any redundant downstream `requirePlatformAdmin()` calls since the middleware now handles it.
  4. Use the `AccessDeniedReporter` pattern for the 403 (feeds into the audit trail).
- **Effort:** S (45 min)
- **Acceptance criteria:**
  - `platformAdminAuthMiddleware` itself enforces super-admin — no downstream guard needed.
  - Non-super-admin users get 403 with access-denied audit event.
  - Super-admin users can still access the routes.
  - No redundant `requirePlatformAdmin()` calls remain on routes that use this middleware.
- **Dependencies:** None

### M4: Regex-based SQL validation is fragile

- **File:** `apps/runtime/src/routes/analytics.ts:635-648`
- **Current code:** Uses regexes like `FORBIDDEN_SQL_KEYWORDS`, `PARAMETERIZED_TENANT_FILTER`, etc.
- **Architecture:** Replace regex-based SQL validation with a layered defense: (1) AST-based validation via `node-sql-parser`, (2) ClickHouse read-only execution, (3) parameterized tenant/project filters.
- **Implementation steps:**
  1. Add `node-sql-parser` to runtime dependencies. It supports ClickHouse dialect.
  2. Create `apps/runtime/src/routes/analytics-sql-validator.ts` that:
     - Parses the SQL into an AST using `node-sql-parser` with `database: 'ClickHouse'`.
     - Validates structurally: only `SELECT` statements allowed (reject at AST level, not regex).
     - Verifies `FROM` targets are in an allowed-tables allowlist (configurable per tenant).
     - Verifies `WHERE` clause includes the parameterized `{tenantId:String}` and `{projectId:String}` filters.
     - Rejects subqueries, CTEs, UNIONs, and JOINs to non-allowed tables.
     - Returns structured validation result: `{ valid: boolean, errors: string[], sanitizedAst: AST }`.
  3. Replace the regex-based `validateDeveloperSqlQuery` with the AST-based validator.
  4. Add `SETTINGS readonly = 1` to all query executions as a defense-in-depth layer.
  5. Ensure ClickHouse connection uses a read-only database user/role.
  6. Delete the regex constants (`FORBIDDEN_SQL_KEYWORDS`, `SQL_COMMENT_PATTERN`, etc.) — they're replaced by AST validation.
- **Effort:** L (6-8 hours)
- **Acceptance criteria:**
  - SQL validation uses AST parsing, not regex.
  - `node-sql-parser` parse errors return 400 with a generic message (no ClickHouse internals leaked).
  - Queries execute with `readonly = 1`.
  - Test suite covers: valid SELECT, subquery rejection, forbidden table, missing tenant filter, UNION rejection, comment injection.
- **Dependencies:** None

### M5: `findProjectsUsingTenantModel` missing tenantId in ModelConfig query

- **File:** `apps/runtime/src/repos/tenant-model-repo.ts:281`
- **Current code:** `ModelConfig.find({ tenantModelId }, { projectId: 1, tier: 1 })` — no `tenantId` filter.
- **Implementation steps:**
  1. Add `tenantId` to the initial query:
     ```typescript
     const configs = await ModelConfig.find(
       { tenantModelId, tenantId },
       { projectId: 1, tier: 1 },
     ).lean();
     ```
  2. Verify that `ModelConfig` schema has a `tenantId` field. If not, the defense-in-depth filter at line 289-291 (Project lookup with `tenantId`) is sufficient, but add a comment explaining the gap.
- **Effort:** S (15 min)
- **Acceptance criteria:**
  - The initial ModelConfig query includes tenantId (if the field exists on the schema).
  - Cross-tenant model config leakage is impossible.
- **Dependencies:** None

### M6: `_chStores` singleton never resets on init failure

- **File:** `apps/runtime/src/websocket/handler.ts:129-158`
- **Current code:** If `_chInitPromise` rejects, `_chStores` stays null but `_chInitPromise` holds the rejected promise forever. Subsequent calls to `getChStores()` return the rejected promise.
- **Implementation steps:**
  1. Add error handling to reset `_chInitPromise` on failure:
     ```typescript
     _chInitPromise = (async () => {
       try {
         // ... existing init code ...
         _chStores = { metricsStore, auditStore };
         return _chStores;
       } catch (err) {
         _chInitPromise = null; // Allow retry
         throw err;
       }
     })();
     ```
- **Effort:** S (15 min)
- **Acceptance criteria:**
  - After a failed init, the next call to `getChStores()` retries initialization.
  - If ClickHouse comes back up, stores recover.
- **Dependencies:** None

### M7: Provider API base override lacks SSRF validation

- **File:** `apps/runtime/src/channels/adapters/provider-api-base.ts`
- **Current code:** `normalizeApiBaseUrl` (line 19) only checks URL parsing validity, not whether the URL targets internal/private networks.
- **Implementation steps:**
  1. Import `validateUrlForSSRF` from `@agent-platform/shared-kernel`:
     ```typescript
     import { validateUrlForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel';
     ```
  2. In `normalizeApiBaseUrl`, after URL parsing succeeds, validate for SSRF:
     ```typescript
     const ssrfResult = validateUrlForSSRF(trimmed, getDevSSRFOptions());
     if (!ssrfResult.safe) {
       return null;
     }
     ```
  3. Log a warning when an SSRF-unsafe URL is rejected.
- **Effort:** S (30 min)
- **Acceptance criteria:**
  - Private IPs, localhost, metadata endpoints are rejected as API base URLs.
  - Dev mode still allows localhost via `getDevSSRFOptions()`.
  - Tests: `normalizeApiBaseUrl('http://169.254.169.254/')` returns `null`.
- **Dependencies:** None

### M8: No rate limiting on share token generation POST

- **Subsumed by C4.** The share route redesign (C4) includes rate limiting by `user.id` at 10 req/min as part of the comprehensive fix. No separate fix needed.
- **Dependencies:** C4

### M9: `TokenManager` lacks retry/backoff on init failure

- **File:** `packages/web-sdk/src/core/TokenManager.ts`
- **Current code:** `initToken()` (line 70) makes a single fetch. On network failure, the error propagates to the caller with no retry.
- **Implementation steps:**
  1. Add exponential backoff retry to `initToken`:

     ```typescript
     private async initToken(): Promise<string> {
       const maxRetries = 3;
       const baseDelay = 1000;
       let lastError: unknown;

       for (let attempt = 0; attempt < maxRetries; attempt++) {
         try {
           // existing init logic
           return await this.doInit();
         } catch (err) {
           lastError = err;
           if (this.isUnauthorizedError(err)) throw err; // Don't retry auth errors
           if (attempt < maxRetries - 1) {
             await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
           }
         }
       }
       throw lastError;
     }
     ```

  2. Extract the current `initToken` body into a private `doInit` method.
  3. Add the same retry logic to `refreshToken` for symmetry.

- **Effort:** M (1-2 hours)
- **Acceptance criteria:**
  - Transient network failures are retried up to 3 times with backoff.
  - Auth errors (401/403) are not retried.
  - SDK unit tests cover retry behavior.
- **Dependencies:** None

### M10: `console.warn` in default access-denial logger

- **File:** `packages/shared-auth/src/middleware/access-denial.ts:85`
- **Current code:** `warn: (message, meta) => console.warn(\`[AccessDenied] ${message}\`, meta ?? '')`
- **Implementation steps:**
  1. Replace with `createLogger`:
     ```typescript
     import { createLogger } from '@abl/compiler/platform';
     const accessDenialLog = createLogger('access-denial');
     const defaultLogger: AccessDeniedLogger = {
       warn: (message, meta) => accessDenialLog.warn(message, meta ?? {}),
     };
     ```
  2. Note: This is a shared package. Verify that `@abl/compiler/platform` is a dependency of `@agent-platform/shared-auth`. If not, keep `console.warn` but document why, or add the dependency.
- **Effort:** S (15 min)
- **Acceptance criteria:**
  - No `console.warn` in production code paths of `access-denial.ts`.
  - Access denial events appear in structured logs.
- **Dependencies:** Verify dependency graph.

### M11: CI sidecar starts all services even for lint-only runs

- **File:** `.harness/pipelines/ci-build.yaml`
- **Current code:** All service containers start regardless of which stage runs.
- **Implementation steps:**
  1. Split the pipeline into stages with conditional service containers:
     - Lint/type-check stage: no sidecar services needed.
     - Test stage: start only needed services (MongoDB, Redis).
     - Integration/E2E stage: start all services.
  2. Use Harness `when` conditions or separate stages with their own `serviceDependencies` blocks.
  3. This is a CI optimization, not a code change. Measure current CI time vs. optimized.
- **Effort:** L (4-6 hours)
- **Acceptance criteria:**
  - Lint-only pipeline runs do not start database/Redis sidecars.
  - CI time for lint-only runs decreases measurably.
- **Dependencies:** None

---

## Phase 4: P3 — Low Priority & Tech Debt (Backlog)

### L1: Duplicate `createJitAuthCallbacks` / `activateAuthGateIfRequired`

- **Files:** `apps/runtime/src/websocket/handler.ts` and `apps/runtime/src/websocket/sdk-handler.ts`
- **Current state:** Both files define near-identical `createJitAuthCallbacks` (handler.ts:224, sdk-handler.ts:177) and `activateAuthGateIfRequired` (handler.ts:313, sdk-handler.ts:266).
- **Implementation steps:**
  1. Extract both functions into a shared module `apps/runtime/src/websocket/jit-auth-helpers.ts`.
  2. Export the functions and import in both handler files.
  3. Ensure both call sites pass the same parameters.
- **Effort:** M (2 hours)
- **Acceptance criteria:**
  - Single source of truth for JIT auth callback creation.
  - Both handlers import from the shared module.
  - All existing tests pass.
- **Dependencies:** None

### L2: Unused `SQL_QUERY_TIMEOUT_MS` constant

- **File:** `apps/runtime/src/routes/analytics.ts:639`
- **Current code:** `const SQL_QUERY_TIMEOUT_MS = 10_000;` — declared but never referenced.
- **Implementation steps:**
  1. Delete the constant.
  2. Or, use it in the `SETTINGS max_execution_time = 15` line (line 795) instead of the hardcoded `15`:
     ```typescript
     execSql = `${execSql}\nSETTINGS max_execution_time = ${SQL_QUERY_TIMEOUT_MS / 1000}`;
     ```
- **Effort:** S (5 min)
- **Acceptance criteria:**
  - No unused constants in the file.
- **Dependencies:** Fix alongside C2/H5.

### L3: `error: any` in catch blocks in tenant-models.ts

- **File:** `apps/runtime/src/routes/tenant-models.ts` — 11 occurrences
- **Implementation steps:**
  1. Replace all `catch (error: any)` with `catch (error: unknown)`.
  2. Update all references to use `error instanceof Error ? error.message : String(error)` pattern.
- **Effort:** M (1-2 hours)
- **Acceptance criteria:**
  - Zero `error: any` patterns in the file.
  - `pnpm build --filter=@agent-platform/runtime` succeeds.
- **Dependencies:** None

### L4: Pagination after full in-memory load

- **Subsumed by H2.** The session store redesign (H2) introduces cursor-based pagination via Redis `SCAN`, eliminating the full in-memory load entirely. No separate fix needed.
- **Dependencies:** H2

### L5: `waitFor` test utility duplicated across 6+ test files

- **Files:** 15+ test files (see grep results).
- **Implementation steps:**
  1. Create `apps/runtime/src/__tests__/helpers/wait-for.ts`:
     ```typescript
     export async function waitFor(
       fn: () => boolean | Promise<boolean>,
       timeoutMs = 5000,
       intervalMs = 50,
     ): Promise<void> {
       /* ... */
     }
     ```
  2. Update all test files to import from the shared helper.
- **Effort:** M (2 hours)
- **Acceptance criteria:**
  - Single `waitFor` definition in test helpers.
  - All test files import from the shared location.
- **Dependencies:** None

### L6: `requestJson` / `setSuperAdmins` duplicated in tests

- **Files:** 10 test files (see grep results).
- **Implementation steps:**
  1. Create `apps/runtime/src/__tests__/helpers/test-request.ts` with shared `requestJson` and `setSuperAdmins`.
  2. Update all test files to import from the shared helper.
- **Effort:** M (2 hours)
- **Acceptance criteria:**
  - Single source of truth for test HTTP helpers.
  - All tests import from shared location.
- **Dependencies:** Can be done with L5.

### L7: web-sdk duplicates `SDK_WS_AUTH_PROTOCOL` constant

- **File:** `packages/web-sdk/src/core/websocket-auth.ts:1`
- **Current state:** This is intentional per the audit note. The web-sdk is a standalone package distributed to consumers and should not import from internal platform packages.
- **Implementation steps:** No action required. Add a comment:
  ```typescript
  // Intentionally duplicated from @agent-platform/shared — web-sdk is standalone
  export const SDK_WS_AUTH_PROTOCOL = 'sdk-auth';
  ```
- **Effort:** S (5 min)
- **Acceptance criteria:** Comment added.
- **Dependencies:** None

### L8: turbo.json `docs-internal` build doesn't exclude `.next/cache`

- **File:** `turbo.json`
- **Current code:**
  ```json
  "@agent-platform/docs-internal#build": {
    "dependsOn": ["^build"],
    "outputs": [".next/**"]
  }
  ```
- **Implementation steps:**
  1. Add cache exclusion to match the Studio config:
     ```json
     "outputs": [".next/**", "!.next/cache/**"]
     ```
- **Effort:** S (5 min)
- **Acceptance criteria:**
  - `.next/cache` is not included in Turbo's output cache for docs-internal.
  - Turbo cache hits/misses are unaffected for normal builds.
- **Dependencies:** None

---

## Phase 5: Test Coverage Expansion

### TG1: No LINE connection-scoped webhook E2E test

- **Implementation approach:**
  1. Create `apps/runtime/src/__tests__/channels-line-webhook.e2e.test.ts`.
  2. Start a real Express server on a random port with full middleware chain.
  3. Create a test LINE channel connection with webhook secret.
  4. Send simulated LINE webhook payloads (message, follow, unfollow events) with valid signatures.
  5. Verify: webhook signature validation, message routing to correct agent, response delivery, tenant isolation.
- **Effort:** L (4-6 hours)
- **Dependencies:** None

### TG2: No rate-limiting E2E test

- **Implementation approach:**
  1. Create `apps/runtime/src/__tests__/rate-limiting.e2e.test.ts`.
  2. Start a real Express server with rate-limiting middleware active.
  3. Send N+1 requests where N is the rate limit for the endpoint.
  4. Verify: first N requests return 200, request N+1 returns 429, `Retry-After` header is present, different tenants have independent limits.
- **Effort:** M (2-3 hours)
- **Dependencies:** None

### TG3: No concurrent webhook delivery E2E test

- **Implementation approach:**
  1. Create `apps/runtime/src/__tests__/concurrent-webhook-delivery.e2e.test.ts`.
  2. Start a real Express server.
  3. Fire 10-20 webhook requests concurrently using `Promise.all`.
  4. Verify: no race conditions, all requests processed, session state consistent, no duplicate message IDs.
- **Effort:** M (3-4 hours)
- **Dependencies:** TG1 (reuse LINE webhook infrastructure)

### TG4: No expired SDK token E2E test

- **Implementation approach:**
  1. Create `apps/studio/src/__tests__/sdk-expired-token.e2e.test.ts`.
  2. Generate a share token with very short expiry (1 second).
  3. Wait for expiry.
  4. Attempt exchange — verify 401 response.
  5. Attempt WebSocket connection with expired token — verify rejection.
- **Effort:** M (2 hours)
- **Dependencies:** None

### TG5: No LINE postback callback E2E test

- **Implementation approach:**
  1. Add to TG1's test file or create a separate `channels-line-postback.e2e.test.ts`.
  2. Simulate a LINE postback event (button press, rich menu action).
  3. Verify: postback data is parsed correctly, routed to the correct session, agent receives the callback.
- **Effort:** M (2 hours)
- **Dependencies:** TG1 infrastructure

### TG6: Missing email channel E2E coverage

- **Implementation approach:**
  1. Create `apps/runtime/src/__tests__/channels-email.e2e.test.ts`.
  2. Start a real Express server.
  3. Simulate inbound email webhook payloads (e.g., SendGrid inbound parse format).
  4. Verify: email parsing (to, from, subject, body, attachments), session creation, response composition, tenant isolation.
- **Effort:** L (6-8 hours — email has more complex parsing)
- **Dependencies:** None

---

## Implementation Order

Items marked ⊂ are subsumed by another finding and need no separate work.

```
Week 1 (Before push):
  ├── C4 (share route redesign — subsumes H7 + M8)         [M]
  ├── C3 (share exchange: delete legacy fallback)           [S]  ← after C4
  ├── C2 + H5 + L2 (analytics error leaks + format)        [S]
  ├── C1 (WebSocketConnectionManager abstraction)           [M]
  └── H1 (make messageType required, remove bypass)         [S]

Week 1-2 (This sprint):
  ├── H3 (swallowed errors → log.warn)                     [S]  ─── parallel
  ├── H4 + H6 (console.* → createLogger, all files)        [M]  ─── parallel
  ├── H8 (barrel re-exports verification)                   [S]  ─── parallel
  ├── H2 (session store getMany/scanKeys + cursor paging)   [M]  ← subsumes L4
  ├── M2 (userId guard, remove non-null assertion)          [S]  ─── parallel
  └── M3 (compose isSuperAdmin into middleware)             [S]  ─── parallel

Week 3 (Next sprint):
  ├── M1 (Redis Pub/Sub tenant-scoped channels)             [M]
  ├── M4 (AST-based SQL validation via node-sql-parser)     [L]
  ├── M5 (tenantId in ModelConfig query)                    [S]  ─── parallel
  ├── M6 (ClickHouse singleton retry-on-failure)            [S]  ─── parallel
  ├── M7 (SSRF validation on provider API base)             [S]  ─── parallel
  ├── M9 (TokenManager retry/backoff)                       [M]
  ├── M10 (access-denial → createLogger)                    [S]
  └── M11 (CI sidecar conditional services)                 [L]

Backlog:
  ├── L1 (extract shared jit-auth-helpers.ts)               [M]
  ├── L3 (error: any → unknown in tenant-models.ts)         [M]
  ├── L5 + L6 (extract shared test utilities)               [M]  ─── parallel
  ├── L7 (comment on intentional SDK_WS_AUTH_PROTOCOL dup)  [S]
  ├── L8 (turbo.json docs-internal cache exclusion)         [S]
  └── TG1-TG6 (test coverage expansion)                    [spread across sprints]

Subsumed (no separate work):
  ⊂ H7 → C4  (Zod validation included in share route redesign)
  ⊂ M8 → C4  (rate limiting included in share route redesign)
  ⊂ L4 → H2  (cursor pagination included in session store redesign)
```

### Dependency Graph

```
C4 ──→ C3  (C3 requires tenantId always present in tokens, which C4 ensures)
C2 ──→ H5  (same file, fix together)
C2 ──→ L2  (remove unused constant while editing analytics.ts)
C1 ──→ L1  (ConnectionManager shared by both handlers — extract JIT auth at same time)
H2 ──⊃ L4  (cursor pagination is part of session store redesign)
C4 ──⊃ H7  (Zod validation is part of share route redesign)
C4 ──⊃ M8  (rate limiting is part of share route redesign)
L5 ──→ L6  (shared test helpers, do together)
TG1 ──→ TG3 (reuse LINE webhook infra)
TG1 ──→ TG5 (reuse LINE infra for postback)
```

All other items are independent and can be parallelized within their phase.

---

## Verification Plan

### Phase 1 Verification (P0)

```bash
# Build to catch type errors
pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio

# Run existing tests
pnpm test --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/studio

# Manual verification
# C1: Check clients Map max size enforcement
grep -n "MAX_WS_CLIENTS\|clients.size" apps/runtime/src/websocket/handler.ts

# C2: Verify no raw errors leak in analytics responses
grep -n "errorMsg\|error:" apps/runtime/src/routes/analytics.ts | grep -v "log\."

# C3: Verify tenant-less fallback is removed
grep -n "payload.tenantId" apps/studio/src/app/api/sdk/share/exchange/route.ts

# C4: Verify ownerId replaced with tenantId
grep -n "ownerId" apps/studio/src/app/api/sdk/share/route.ts  # should return 0 results

# Security scan
./tools/run-semgrep.sh
```

### Phase 2 Verification (P1)

```bash
# H1: Verify no short-circuit on messageType
grep -n "!messageType" apps/runtime/src/websocket/handler.ts  # should return 0

# H3: Verify no swallowed errors
grep -rn "\.catch(() => {})" apps/runtime/src/  # should return 0

# H4: Verify no console usage in production code
grep -rn "console\.\(log\|warn\|error\)" apps/runtime/src/ --include="*.ts" | grep -v "__tests__" | grep -v "node_modules"  # should return 0

# H6: Same check for studio archives
grep -rn "console\.\(log\|warn\|error\)" apps/studio/src/app/api/archives/ | grep -v "__tests__"  # should return 0

# Full test suite
pnpm build && pnpm test
```

### Phase 3 Verification (P2)

```bash
# M1: Verify tenant-scoped channels
grep -n "ws:deliver:" apps/runtime/src/websocket/handler.ts  # should include tenantId

# M3: Verify super-admin check
grep -n "isSuperAdmin" apps/runtime/src/middleware/auth.ts  # should appear in platformAdminAuthMiddleware

# M7: Verify SSRF validation
grep -n "validateUrlForSSRF\|SSRF" apps/runtime/src/channels/adapters/provider-api-base.ts

# Build all affected packages
pnpm build
pnpm test
```

### Phase 4 Verification (P3)

```bash
# L3: Verify no error: any
grep -n "error: any" apps/runtime/src/routes/tenant-models.ts  # should return 0

# L8: Verify turbo cache exclusion
grep -A2 "docs-internal" turbo.json  # should show !.next/cache/**

# Full build + test
pnpm build && pnpm test
```

### Phase 5 Verification (Test Coverage)

```bash
# Run each new E2E test individually
pnpm test -- --testPathPattern="channels-line-webhook.e2e" --filter=@agent-platform/runtime
pnpm test -- --testPathPattern="rate-limiting.e2e" --filter=@agent-platform/runtime
pnpm test -- --testPathPattern="concurrent-webhook" --filter=@agent-platform/runtime
pnpm test -- --testPathPattern="sdk-expired-token.e2e" --filter=@agent-platform/studio
pnpm test -- --testPathPattern="channels-line-postback.e2e" --filter=@agent-platform/runtime
pnpm test -- --testPathPattern="channels-email.e2e" --filter=@agent-platform/runtime

# Verify no mocks in E2E tests
grep -rn "vi\.mock\|jest\.mock" apps/runtime/src/__tests__/*.e2e.* apps/studio/src/__tests__/*.e2e.*  # should return 0
```

### Overall Definition of Done

- [ ] All P0 items fixed and verified before push
- [ ] All P1 items fixed within current sprint
- [ ] All P2 items fixed in the following sprint
- [ ] Zero `console.log/warn/error` in production code (non-test)
- [ ] Zero `.catch(() => {})` in production code
- [ ] Zero `error: any` in catch blocks
- [ ] All error responses use `{ success, error: { code, message } }` format
- [ ] All project-scoped queries include `tenantId`
- [ ] Security scan (`run-semgrep.sh`) passes with no new findings
- [ ] Full `pnpm build && pnpm test` passes
