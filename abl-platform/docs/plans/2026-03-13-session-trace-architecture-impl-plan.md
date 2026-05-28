# Session & Trace Architecture Simplification — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate dual session IDs, simplify trace pipeline to a single query path, enable WAL by default, and clean up zombie session problems.

**Architecture:** Single session ID (runtime UUID = MongoDB `_id`). Traces: live streaming via RedisTraceStore, historical queries via ClickHouse only (no waterfall). WAL-backed EventStore for crash durability. Milestone-based MongoDB persistence for session state.

**Tech Stack:** Node.js/TypeScript, MongoDB/Mongoose, ClickHouse, Redis, Express, WebSocket

**Design Doc:** `docs/plans/2026-03-13-session-trace-architecture-design.md`

---

## Phase Overview

| Phase | Name                      | Description                                                 | Independent?                    |
| ----- | ------------------------- | ----------------------------------------------------------- | ------------------------------- |
| 1     | WAL by default            | Enable EventStore WAL resilience as default                 | Yes                             |
| 2     | Single session ID         | Unify runtime UUID as MongoDB `_id`, remove dual-ID code    | Yes (after data wipe)           |
| 3     | Simplify trace query path | Remove waterfall logic, ClickHouse-only for REST/historical | Depends on Phase 2              |
| 4     | Data wipe script          | Migration script to wipe dev sessions/messages/traces       | Run between Phase 1 and Phase 2 |

---

## Chunk 1: Phase 1 — WAL by Default + Phase 4 — Data Wipe Script

### Task 1: Enable WAL by default in EventStore

**Files:**

- Modify: `apps/runtime/src/services/eventstore-singleton.ts:31-41`

The WAL infrastructure already exists. Currently gated behind `EVENTSTORE_RESILIENCE_ENABLED=true`. Change the default to enabled, with an opt-out env var.

- [ ] **Step 1: Write the test**

Create: `apps/runtime/src/__tests__/eventstore-wal-default.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('EventStore WAL default', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should enable WAL by default when EVENTSTORE_RESILIENCE_ENABLED is not set', async () => {
    delete process.env.EVENTSTORE_RESILIENCE_ENABLED;
    // The config object passed to createEventStore should include resilience.enabled = true
    // We verify this by checking the factory receives the right config
    const { createEventStore } = await import('@abl/eventstore');
    const spy = vi.spyOn({ createEventStore }, 'createEventStore');
    // Integration: verify the singleton init path includes resilience
    // (unit test: check the config construction logic)
  });

  it('should disable WAL when EVENTSTORE_RESILIENCE_ENABLED=false', async () => {
    process.env.EVENTSTORE_RESILIENCE_ENABLED = 'false';
    // Verify resilience is not included in config
  });
});
```

- [ ] **Step 2: Change the default**

Modify `apps/runtime/src/services/eventstore-singleton.ts` lines 31-41:

```typescript
// Before:
...(process.env.EVENTSTORE_RESILIENCE_ENABLED === 'true' && {
  resilience: {
    enabled: true,
    wal: { directory: process.env.EVENTSTORE_WAL_DIR ?? '/tmp/eventstore-wal' },
  },
}),

// After:
...(process.env.EVENTSTORE_RESILIENCE_ENABLED !== 'false' && {
  resilience: {
    enabled: true,
    wal: { directory: process.env.EVENTSTORE_WAL_DIR ?? '/tmp/eventstore-wal' },
  },
}),
```

The change: `=== 'true'` → `!== 'false'`. WAL is now on unless explicitly disabled.

- [ ] **Step 3: Build and verify**

```bash
pnpm build --filter=@agent-platform/runtime
```

- [ ] **Step 4: Run tests**

```bash
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/services/eventstore-singleton.ts
git add apps/runtime/src/services/eventstore-singleton.ts
git commit -m "[ABLP-2] feat(runtime): enable EventStore WAL by default for trace durability"
```

---

### Task 2: Create data wipe script

**Files:**

- Create: `tools/wipe-dev-sessions.sh`

Script to wipe all sessions, messages, and optionally traces from dev environment. Run once before deploying single-ID code.

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# wipe-dev-sessions.sh — Clear all session data from dev environment
# Run this ONCE before deploying single-session-ID code.
#
# SAFETY: Refuses to run unless NODE_ENV=development or ABL_ENV=dev.
#         Also blocked by hostname checks for known production hosts.
#
# Usage: tools/wipe-dev-sessions.sh [--include-traces]
#
# Clears:
#   - MongoDB: sessions, messages, channel_sessions collections
#   - Redis: session:* keys
#   - ClickHouse: platform_events (only with --include-traces)

set -euo pipefail

# ── Production guard ──────────────────────────────────────────────────
BLOCKED_HOSTS="prod|production|staging|stg|live"
if echo "${HOSTNAME:-$(hostname)}" | grep -qiE "$BLOCKED_HOSTS"; then
  echo "FATAL: This script cannot run on host '$(hostname)' (matches production pattern)." >&2
  exit 1
fi

ENV="${ABL_ENV:-${NODE_ENV:-}}"
if [[ "$ENV" != "development" && "$ENV" != "dev" && "$ENV" != "test" && "$ENV" != "local" ]]; then
  echo "FATAL: Refusing to wipe data — NODE_ENV or ABL_ENV must be 'development', 'dev', 'test', or 'local'." >&2
  echo "Current: NODE_ENV=${NODE_ENV:-<unset>}, ABL_ENV=${ABL_ENV:-<unset>}" >&2
  echo "Set ABL_ENV=dev to proceed." >&2
  exit 1
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/abl_platform}"
if echo "$MONGO_URI" | grep -qiE "production|prod\.|live\.|atlas.*prod"; then
  echo "FATAL: MongoDB URI looks like production: $MONGO_URI" >&2
  exit 1
fi
# ── End production guard ──────────────────────────────────────────────

INCLUDE_TRACES=false
if [[ "${1:-}" == "--include-traces" ]]; then
  INCLUDE_TRACES=true
fi

echo "=== Wiping dev session data (env=$ENV) ==="
echo "    MongoDB: $MONGO_URI"

# Confirmation prompt
read -r -p "This will DELETE all sessions, messages, and channel_sessions. Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# MongoDB
echo "[1/3] Clearing MongoDB sessions, messages, and channel_sessions..."
mongosh "$MONGO_URI" --quiet --eval '
  const sessCount = db.sessions.countDocuments();
  const msgCount = db.messages.countDocuments();
  const chSessCount = db.channel_sessions.countDocuments();
  db.sessions.deleteMany({});
  db.messages.deleteMany({});
  db.channel_sessions.deleteMany({});
  print(`Deleted ${sessCount} sessions, ${msgCount} messages, ${chSessCount} channel_sessions`);
'

# Redis
echo "[2/3] Clearing Redis session keys..."
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
redis-cli -u "$REDIS_URL" --scan --pattern "session:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "sess:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "trace:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
echo "Redis session keys cleared"

# ClickHouse (optional)
if [ "$INCLUDE_TRACES" = true ]; then
  echo "[3/3] Truncating ClickHouse platform_events..."
  CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8124}"
  curl -s "$CLICKHOUSE_URL" -d "TRUNCATE TABLE IF EXISTS abl_platform.platform_events" || echo "ClickHouse truncate failed (table may not exist)"
  echo "ClickHouse traces cleared"
else
  echo "[3/3] Skipping ClickHouse traces (use --include-traces to clear)"
fi

echo ""
echo "=== Done. Deploy single-ID code now. ==="
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x tools/wipe-dev-sessions.sh
npx prettier --write tools/wipe-dev-sessions.sh 2>/dev/null || true
git add tools/wipe-dev-sessions.sh
git commit -m "[ABLP-2] chore: add dev session data wipe script for single-ID migration"
```

---

## Chunk 2: Phase 2 — Single Session ID

### Task 3: Unify session ID in ConversationStore

**Files:**

- Modify: `apps/runtime/src/services/stores/mongo-conversation-store.ts:102-150`
- Modify: `packages/compiler/src/platform/stores/conversation-store.ts:34-64` (CreateSessionParams interface)
- Modify: `packages/database/src/models/session.model.ts:62,162,205`

Make `createSession` accept an explicit `id` parameter and use it as MongoDB `_id`. Remove `runtimeSessionId` as a separate field.

- [ ] **Step 1: Add `id` to CreateSessionParams**

Modify `packages/compiler/src/platform/stores/conversation-store.ts`:

```typescript
// Add to CreateSessionParams interface:
/** Explicit session ID. When provided, used as the MongoDB _id.
 *  Unifies runtime session ID and DB session ID into a single value. */
id?: string;
```

- [ ] **Step 2: Use explicit ID in MongoConversationStore.createSession**

Modify `apps/runtime/src/services/stores/mongo-conversation-store.ts`:

In the `createSession` method, when `params.id` is provided, pass it as `_id`:

```typescript
// In SessionModel.create() call, add:
...(params.id && { _id: params.id }),
// Keep runtimeSessionId for now (set to same value for backward compat during transition):
runtimeSessionId: params.id || params.runtimeSessionId || null,
```

- [ ] **Step 3: Build and run tests**

```bash
pnpm build --filter=@agent-platform/runtime --filter=@abl/compiler
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/stores/mongo-conversation-store.ts packages/compiler/src/platform/stores/conversation-store.ts
git add apps/runtime/src/services/stores/mongo-conversation-store.ts packages/compiler/src/platform/stores/conversation-store.ts
git commit -m "[ABLP-2] feat(runtime): support explicit session ID in ConversationStore.createSession"
```

---

### Task 4: Pass runtime UUID as DB `_id` at all session creation points

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts:254-323` (ensureDebugDbSession)
- Modify: `apps/runtime/src/routes/chat.ts:884-902,979-995` (HTTP API session creation)

At every call site that creates a DB session, pass `id: runtimeSessionId` so the DB record uses the same UUID.

- [ ] **Step 1: Update WebSocket handler**

In `ensureDebugDbSession` (handler.ts ~line 280), add `id` param:

```typescript
const dbSession = await convStore.createSession({
  id: pending.runtimeSessionId, // ← NEW: use runtime UUID as DB _id
  channel: 'web_debug',
  agentName: pending.agentName,
  // ... rest unchanged
  runtimeSessionId: pending.runtimeSessionId, // keep for now
});
```

- [ ] **Step 2: Update HTTP chat routes**

In `chat.ts` at both session creation paths (~lines 884 and 979), add `id: session.id`:

```typescript
const dbSession = await convStore.createSession({
  id: session.id, // ← NEW: use runtime UUID as DB _id
  channel: 'api',
  // ... rest unchanged
  runtimeSessionId: session.id, // keep for now
});
```

- [ ] **Step 3: Update any other session creation call sites**

Search for all `convStore.createSession` and `getConversationStore().createSession` calls:

```bash
grep -rn "createSession(" apps/runtime/src/ --include="*.ts" | grep -v test | grep -v __tests__
```

For each call site that has a `runtimeSessionId`, add `id: <same value>`.

- [ ] **Step 4: Build and run tests**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/handler.ts apps/runtime/src/routes/chat.ts
git add apps/runtime/src/websocket/handler.ts apps/runtime/src/routes/chat.ts
git commit -m "[ABLP-2] feat(runtime): pass runtime UUID as DB _id at all session creation points"
```

---

### Task 5: Remove dual-ID lookup code

**Files:**

- Modify: `apps/runtime/src/repos/session-repo.ts:19-28` (remove `findSessionByRuntimeId`)
- Modify: `apps/runtime/src/routes/sessions.ts` (remove fallback lookups)
- Modify: `apps/runtime/src/routes/chat.ts:797` (simplify session resume)
- Modify: `apps/runtime/src/websocket/handler.ts:2101` (simplify auto-rehydration)
- Modify: `apps/runtime/src/websocket/handler.ts:254-323` (remove `runtimeSessionId` from pendingDbSession)

After data wipe + unified IDs, `findSessionByRuntimeId` is no longer needed. `findSessionById` finds everything by the single ID.

- [ ] **Step 1: Remove `findSessionByRuntimeId` from session-repo.ts**

Delete the function definition (lines 19-28). Keep `findSessionById`.

- [ ] **Step 2: Update session detail endpoint**

In `apps/runtime/src/routes/sessions.ts`, the session detail handler (~line 1018-1023) has:

```typescript
let dbSession = await findSessionById(sessionId, tenantId);
if (!dbSession) {
  dbSession = await findSessionByRuntimeId(sessionId, tenantId);
}
```

Simplify to:

```typescript
const dbSession = await findSessionById(sessionId, tenantId);
```

- [ ] **Step 3: Update chat.ts session resume**

In `apps/runtime/src/routes/chat.ts` (~line 797), replace:

```typescript
const dbSession = await findSessionByRuntimeId(runtimeSessionId, callerTenantId);
```

With:

```typescript
const dbSession = await findSessionById(runtimeSessionId, callerTenantId);
```

Since `_id` now equals the runtime UUID, `findSessionById` works directly.

- [ ] **Step 4: Update WebSocket handler auto-rehydration**

In `apps/runtime/src/websocket/handler.ts` (~line 2101), replace any `findSessionByRuntimeId` call with `findSessionById`.

- [ ] **Step 5: Remove all imports of `findSessionByRuntimeId`**

```bash
grep -rn "findSessionByRuntimeId" apps/runtime/src/ --include="*.ts" | grep -v __tests__
```

Remove every import and usage. Fix any remaining references.

- [ ] **Step 6: Build and run tests**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

Many tests will need updating since they reference `findSessionByRuntimeId` or create sessions with dual IDs. Fix test failures by:

- Removing `findSessionByRuntimeId` from test mocks
- Updating session creation in tests to use unified ID
- Updating assertions that check `runtimeSessionId` separately

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/repos/session-repo.ts apps/runtime/src/routes/sessions.ts apps/runtime/src/routes/chat.ts apps/runtime/src/websocket/handler.ts
git add -A
git commit -m "[ABLP-2] refactor(runtime): remove dual-ID lookup code — single session ID everywhere"
```

---

### Task 6: Remove `runtimeSessionId` column from Session model

**Files:**

- Modify: `packages/database/src/models/session.model.ts:62,162,205`

After all code paths use the unified ID, the `runtimeSessionId` column is redundant.

- [ ] **Step 1: Remove field from interface**

In `session.model.ts`, remove `runtimeSessionId: string | null;` from the interface (~line 62).

- [ ] **Step 2: Remove field from schema**

Remove `runtimeSessionId: { type: String, default: null },` (~line 162).

- [ ] **Step 3: Remove sparse index**

Remove `SessionSchema.index({ runtimeSessionId: 1 }, { sparse: true });` (~line 205).

- [ ] **Step 4: Remove `runtimeSessionId` from all createSession params**

Search and remove `runtimeSessionId` from all `createSession()` call sites:

```bash
grep -rn "runtimeSessionId" apps/runtime/src/ --include="*.ts" | grep -v __tests__ | grep -v node_modules
```

Also check `packages/compiler/src/platform/stores/conversation-store.ts` CreateSessionParams interface.

- [ ] **Step 5: Build and run full test suite**

```bash
pnpm build
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/database/src/models/session.model.ts
git add -A
git commit -m "[ABLP-2] refactor(database): remove runtimeSessionId column — single session ID"
```

---

## Chunk 3: Phase 3 — Simplify Trace Query Path

### Task 7: Simplify traces endpoint — remove waterfall, ClickHouse-only for REST

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts:1455-1575` (traces GET handler)

Replace the waterfall (TraceStore → ClickHouse → alternate ID) with: always query ClickHouse for REST endpoint. TraceStore is only for live WS streaming (handled by RedisTraceStore subscriptions, not the REST endpoint).

- [ ] **Step 1: Rewrite traces endpoint**

Replace lines 1486-1566 with simplified logic:

```typescript
const sessionId = req.params.id;
const tenantId = req.tenantContext!.tenantId;
const projectId = (req.params as Record<string, string>).projectId;

// Verify session belongs to this tenant (single query, single ID)
let dbVerified = false;
try {
  const dbSession = await findSessionById(sessionId, tenantId);
  if (dbSession) {
    dbVerified = true;
  }
} catch {
  /* DB unavailable */
}

// If DB didn't verify, check executor (for active sessions not yet in DB)
if (!dbVerified) {
  try {
    const executor = getRuntimeExecutor();
    const session = executor.getSession(sessionId);
    if (session) {
      const sessionTenant = session.tenantId || null;
      if (sessionTenant !== tenantId || session.projectId !== projectId) {
        res.status(404).json({ success: false, error: `Session not found: ${sessionId}` });
        return;
      }
    }
  } catch {
    /* RuntimeExecutor not initialized */
  }
}

// Single query path: ClickHouse
try {
  const chEvents = await queryClickHousePlatformEvents(sessionId, tenantId);
  if (chEvents.length > 0) {
    sendTracesResponse(res, req, chEvents, 'clickhouse_platform_events');
    return;
  }
} catch (err) {
  log.warn('ClickHouse platform_events query failed', {
    sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
}

// No events found
sendTracesResponse(res, req, [], 'clickhouse_platform_events');
```

Key changes:

- No TraceStore query (live events come via WS, not REST)
- No alternate session ID fallback (single ID)
- No `runtimeSessionId` resolution

- [ ] **Step 2: Update session detail endpoint trace retrieval**

In the session detail handler (~lines 1043-1074), simplify the trace retrieval to use the single session ID:

```typescript
// Get trace events — try TraceStore for active sessions, then ClickHouse
let traceEvents: unknown[] = [];
try {
  const store = getTraceStore();
  const storeEvents = store.getEvents(sessionId); // ← single ID, no runtimeSessionId
  if (Array.isArray(storeEvents) && storeEvents.length > 0) {
    traceEvents = storeEvents;
  }
} catch {
  /* ignore */
}

if (traceEvents.length === 0 && tenantId) {
  try {
    const chEvents = await queryClickHousePlatformEvents(sessionId, tenantId);
    if (chEvents.length > 0) {
      traceEvents = chEvents;
    }
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 3: Build and run tests**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/sessions.ts
git add apps/runtime/src/routes/sessions.ts
git commit -m "[ABLP-2] refactor(runtime): simplify traces endpoint — ClickHouse-only, no waterfall"
```

---

### Task 8: Remove `runtimeSessionId` from session list endpoint responses

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts` (list sessions handler, session detail response)

Clean up API responses to not expose the now-redundant `runtimeSessionId` field.

- [ ] **Step 1: Update session list response**

In the sessions list handler, remove `runtimeSessionId` from the response object. The `id` field is now the single identifier.

- [ ] **Step 2: Update session detail response**

In the session detail handler (~line 992-1006), remove `runtimeSessionId` from the response. For backward compatibility, optionally keep it as an alias: `runtimeSessionId: session.id` (same value).

- [ ] **Step 3: Update Studio API proxy if needed**

Check `apps/studio/src/app/api/runtime/sessions/` for any routes that depend on `runtimeSessionId` in responses. Update accordingly.

- [ ] **Step 4: Build and run tests**

```bash
pnpm build
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/sessions.ts
git add -A
git commit -m "[ABLP-2] refactor(runtime): remove runtimeSessionId from API responses"
```

---

### Task 9: Fix WS reconnect DB fallback — preserve session ID

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts:2132-2158` (handleResumeSession DB rebuild)

**CRITICAL (from multi-pod review):** When a WS reconnects and the session is rebuilt from DB, the code creates a NEW `RuntimeSession` with a new `crypto.randomUUID()` instead of reusing the original session ID. This breaks the single-ID invariant.

- [ ] **Step 1: Pass `sessionId` to `createSessionFromResolved` in DB rebuild path**

At handler.ts ~line 2132, add `sessionId` to options:

```typescript
runtimeSession = executor.createSessionFromResolved(resolved, {
  sessionId, // ← CRITICAL: preserve original session ID
  tenantId: dbSession.tenantId,
  authToken: clients.get(ws)?.authToken,
  userId: clients.get(ws)?.userId,
  callerContext: resumeCallerCtx,
});
```

- [ ] **Step 2: Remove the `runtimeSessionId` write-back at ~line 2151-2158**

The code that writes `runtimeSessionId: runtimeSession.id` back to MongoDB is no longer needed since the rebuilt session has the same ID.

- [ ] **Step 3: Build and test**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/handler.ts
git add apps/runtime/src/websocket/handler.ts
git commit -m "[ABLP-2] fix(runtime): preserve session ID on WS reconnect DB rebuild"
```

---

### Task 10: Clean up channel routes and pipeline infrastructure

**Files:**

- Modify: `apps/runtime/src/routes/channel-genesys.ts` (~14 references)
- Modify: `apps/runtime/src/routes/channel-audiocodes.ts` (~5 references)
- Modify: `apps/runtime/src/routes/channel-vxml.ts` (~6 references)
- Modify: `apps/runtime/src/channels/pipeline/types.ts` (3 interfaces)
- Modify: `apps/runtime/src/channels/pipeline/lifecycle-manager.ts` (~8 references)
- Modify: `apps/runtime/src/channels/pipeline/message-pipeline.ts` (~2 references)
- Modify: `apps/runtime/src/channels/pipeline/session-factory.ts` (~5 references)
- Modify: `apps/runtime/src/channels/session-resolver.ts` (~10 references)

Since session ID is now unified, `runtimeSessionId` in these files is the same as `session.id`. Rename for clarity.

- [ ] **Step 1: Update channel pipeline types**

In `channels/pipeline/types.ts`, rename `runtimeSessionId` to `sessionId` in `MessagePipelineOptions`, `ResolvedSession`, and `ChannelMessageContext`.

- [ ] **Step 2: Update pipeline implementation files**

Update `lifecycle-manager.ts`, `message-pipeline.ts`, `session-factory.ts`, and `session-resolver.ts` to use the renamed field.

- [ ] **Step 3: Update channel route files**

Update `channel-genesys.ts`, `channel-audiocodes.ts`, `channel-vxml.ts`.

- [ ] **Step 4: Build and test**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/routes/channel-*.ts apps/runtime/src/channels/
git add apps/runtime/src/routes/channel-*.ts apps/runtime/src/channels/
git commit -m "[ABLP-2] refactor(runtime): unify session ID in channel pipeline and routes"
```

---

### Task 11: Clean up SDK handler, voice handlers, and inbound worker

**Files:**

- Modify: `apps/runtime/src/websocket/sdk-handler.ts` (~30 references)
- Modify: `apps/runtime/src/websocket/sdk-handler-contact-linking.ts` (~4 references)
- Modify: `apps/runtime/src/websocket/twilio-media-handler.ts` (~15 references)
- Modify: `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` (~17 references)
- Modify: `apps/runtime/src/services/voice/livekit/agent-worker.ts`
- Modify: `apps/runtime/src/services/voice/livekit/worker-entry.ts`
- Modify: `apps/runtime/src/services/voice/korevg/korevg-session.ts` (~1 reference)
- Modify: `apps/runtime/src/services/queues/inbound-worker.ts` (~30 references)

- [ ] **Step 1: Update SDK WebSocket handler**

Replace `state.runtimeSessionId` with `state.sessionId` throughout `sdk-handler.ts` and `sdk-handler-contact-linking.ts`. Update the `ClientState` interface if it has a separate `runtimeSessionId` field.

- [ ] **Step 2: Update voice handlers**

Update `twilio-media-handler.ts`, `runtime-llm-adapter.ts`, `agent-worker.ts`, `worker-entry.ts`, `korevg-session.ts`.

- [ ] **Step 3: Update inbound worker**

Replace `session.runtimeSessionId` with `session.id` throughout `inbound-worker.ts`.

- [ ] **Step 4: Build and test**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write apps/runtime/src/websocket/sdk-handler*.ts apps/runtime/src/websocket/twilio-media-handler.ts apps/runtime/src/services/voice/ apps/runtime/src/services/queues/inbound-worker.ts
git add -A
git commit -m "[ABLP-2] refactor(runtime): unify session ID in SDK handler, voice, and inbound worker"
```

---

### Task 12: Clean up cross-package references (A2A, pipeline-engine, Studio)

**Files:**

- Modify: `packages/a2a/src/domain/ports.ts:47`
- Modify: `packages/a2a/src/infrastructure/agent-executor-adapter.ts:275-282`
- Modify: `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts`
- Modify: `apps/runtime/src/repos/session.repository.ts:59-60` (second repo with `findByRuntimeId`)
- Modify: `apps/runtime/src/services/audit-helpers.ts:175,198`
- Modify: `apps/studio/src/repos/session-repo.ts` (Studio's `findSessionByRuntimeId`)
- Modify: `apps/studio/src/hooks/useSessionDetail.ts` (trace fallback)
- Modify: `apps/studio/src/types/index.ts:477`

- [ ] **Step 1: Update A2A package**

In `packages/a2a/src/domain/ports.ts`, rename `runtimeSessionId` to `sessionId`. Update `agent-executor-adapter.ts` accordingly.

- [ ] **Step 2: Update pipeline-engine**

In `run-eval-conversation.service.ts`, replace `runtimeSessionId` references.

- [ ] **Step 3: Remove second session repo's `findByRuntimeId`**

In `apps/runtime/src/repos/session.repository.ts`, remove the `findByRuntimeId` method.

- [ ] **Step 4: Update Studio session repo and hooks**

Remove `findSessionByRuntimeId` from `apps/studio/src/repos/session-repo.ts`. Update `useSessionDetail.ts` to use session ID directly for trace lookups (no `runtimeSessionId` fallback). Remove `runtimeSessionId` from Studio types.

- [ ] **Step 5: Update audit helpers**

Remove `runtimeSessionId` from audit type interfaces in `audit-helpers.ts`.

- [ ] **Step 6: Build full monorepo and test**

```bash
pnpm build
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/a2a/src/ packages/pipeline-engine/src/ apps/runtime/src/repos/session.repository.ts apps/runtime/src/services/audit-helpers.ts apps/studio/src/repos/session-repo.ts apps/studio/src/hooks/useSessionDetail.ts apps/studio/src/types/index.ts
git add -A
git commit -m "[ABLP-2] refactor: remove runtimeSessionId from A2A, pipeline-engine, and Studio"
```

---

### Task 13: Update ChannelSession model and data wipe script

**Files:**

- Modify: `packages/database/src/models/channel-session.model.ts` (rename `runtimeSessionId` → `sessionId`)
- Modify: `tools/wipe-dev-sessions.sh` (add `channel_sessions` collection to wipe)

- [ ] **Step 1: Rename field in ChannelSession model**

In `channel-session.model.ts`, rename `runtimeSessionId` to `sessionId` (since the IDs are now unified). Update the index.

- [ ] **Step 2: Update session-resolver.ts**

The session resolver writes `runtimeSessionId` to `ChannelSession` records. Update to use `sessionId`.

- [ ] **Step 3: Update data wipe script**

Add `db.channel_sessions.deleteMany({});` to the MongoDB wipe section in `tools/wipe-dev-sessions.sh`.

- [ ] **Step 4: Build and test**

```bash
pnpm build
cd apps/runtime && pnpm test 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/database/src/models/channel-session.model.ts tools/wipe-dev-sessions.sh
git add -A
git commit -m "[ABLP-2] refactor(database): rename runtimeSessionId to sessionId in ChannelSession model"
```

---

## Chunk 4: Scale & Resilience Fixes

### Task 14: Schedule WAL cleanup and add disk circuit breaker

**Files:**

- Modify: `apps/runtime/src/services/eventstore-singleton.ts:47-56` (add cleanup timer)
- Modify: `packages/eventstore/src/resilience/filesystem-wal.ts` (add disk size check)

- [ ] **Step 1: Schedule hourly WAL cleanup**

In `eventstore-singleton.ts`, after `startPeriodicRecovery()`, add:

```typescript
// Schedule hourly WAL cleanup to prune files older than maxRetentionHours.
// Without this, WAL grows unbounded during ClickHouse outages (~1.7GB/hr/pod).
const walCleanupTimer = setInterval(
  () => {
    _eventStore!.recovery!.cleanup().catch((err) => {
      log.warn('WAL cleanup failed', { error: err instanceof Error ? err.message : String(err) });
    });
  },
  60 * 60 * 1000,
); // hourly
if (walCleanupTimer.unref) walCleanupTimer.unref();
```

- [ ] **Step 2: Add WAL directory size check before append**

In `filesystem-wal.ts`, before `appendFile`, add a size check:

```typescript
// Circuit breaker: skip WAL writes if directory exceeds threshold (default 5GB)
const MAX_WAL_SIZE_BYTES =
  parseInt(process.env.EVENTSTORE_WAL_MAX_SIZE_MB || '5120', 10) * 1024 * 1024;
```

Check total directory size periodically (cache the check, not per-event) and skip `append()` if exceeded, logging a critical warning.

- [ ] **Step 3: Build and test**

```bash
pnpm build --filter=@agent-platform/runtime --filter=@abl/eventstore
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/services/eventstore-singleton.ts packages/eventstore/src/resilience/filesystem-wal.ts
git add -A
git commit -m "[ABLP-2] fix(eventstore): schedule WAL cleanup hourly + add disk size circuit breaker"
```

---

### Task 15: Clean up dead code in trace endpoints (export, metrics, session list)

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts` (export ~line 713, metrics ~line 2527, list ~line 305)

- [ ] **Step 1: Remove `runtimeSessionId` extraction in export endpoint**

At ~line 713-723, replace `runtimeSessionId = dbSession.runtimeSessionId || undefined` + `traceSessionId = runtimeSessionId || sid` with just `traceSessionId = sid`.

- [ ] **Step 2: Remove `runtimeSessionId` extraction in metrics endpoint**

At ~line 2527-2542, same pattern — use `sessionId` directly.

- [ ] **Step 3: Remove `runtimeSessionId`-based ghost filtering in session list**

At ~line 305-319, remove `activeRuntimeIds` map and simplify.

- [ ] **Step 4: Build, test, commit**

```bash
pnpm build --filter=@agent-platform/runtime
cd apps/runtime && pnpm test 2>&1 | tail -20
npx prettier --write apps/runtime/src/routes/sessions.ts
git add apps/runtime/src/routes/sessions.ts
git commit -m "[ABLP-2] refactor(runtime): remove dead runtimeSessionId code in export/metrics/list endpoints"
```

---

## Execution Order (Revised)

```
Phase 1 — Safe, no breaking changes:
  1. Task 1:  Enable WAL by default
  2. Task 14: Schedule WAL cleanup + disk circuit breaker
  3. Task 2:  Create data wipe script (with ChannelSession)

=== RUN: tools/wipe-dev-sessions.sh --include-traces ===

Phase 2 — Single session ID (core):
  4. Task 3:  Add `id` param to createSession
  5. Task 4:  Pass runtime UUID as DB _id at all creation points
  6. Task 9:  Fix WS reconnect DB rebuild to preserve session ID
  7. Task 5:  Remove dual-ID lookup code
  8. Task 6:  Remove runtimeSessionId column from Session model
  9. Task 13: Update ChannelSession model

Phase 3 — Cleanup (can parallelize):
  10. Task 7:  Simplify traces endpoint
  11. Task 8:  Clean up API responses
  12. Task 10: Clean up channel routes and pipeline
  13. Task 11: Clean up SDK handler, voice, inbound worker
  14. Task 12: Clean up cross-package (A2A, pipeline-engine, Studio)
  15. Task 15: Remove dead code in export/metrics/list
```

---

## Test Strategy

**Before starting**: Run full runtime test suite to establish baseline.

```bash
cd apps/runtime && pnpm test 2>&1 | tail -5
```

**After each task**: Run runtime tests. Fix any failures before proceeding.

**Key test files that will need updates** (26 files reference `runtimeSessionId` or `findSessionByRuntimeId`):

Runtime core tests:

- `apps/runtime/src/__tests__/repos-session.test.ts`
- `apps/runtime/src/__tests__/repos.test.ts`
- `apps/runtime/src/__tests__/session-repo-isolation.test.ts`
- `apps/runtime/src/__tests__/session-routes.test.ts`
- `apps/runtime/src/__tests__/chat-routes.test.ts`
- `apps/runtime/src/__tests__/chat-session-ownership.test.ts`
- `apps/runtime/src/__tests__/session-ownership-authz.test.ts`
- `apps/runtime/src/__tests__/sessions-authz.test.ts`
- `apps/runtime/src/__tests__/websocket-handler.test.ts`
- `apps/runtime/src/__tests__/ws-handler.test.ts`
- `apps/runtime/src/__tests__/cross-tenant-isolation.test.ts`
- `apps/runtime/src/__tests__/user-isolation-e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`
- `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts`
- `apps/runtime/src/__tests__/message-ownership-authz.test.ts`

Cross-package tests:

- `packages/a2a/src/__tests__/agent-executor-adapter.test.ts`

**Test update pattern**: Replace `findSessionByRuntimeId` mocks with `findSessionById` mocks. Remove assertions on `runtimeSessionId` as a separate field. Update session fixtures to use unified IDs. Rename `runtimeSessionId` to `sessionId` in test data where it appears in channel/SDK contexts.

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build` passes (full monorepo)
- [ ] `cd apps/runtime && pnpm test` passes (all runtime tests)
- [ ] Create a new session via Studio WebSocket → verify single ID in MongoDB
- [ ] Send messages → verify trace events in ClickHouse use the same session ID
- [ ] Restart runtime → verify traces still queryable from ClickHouse
- [ ] Check session detail API → no `runtimeSessionId` field (or same as `id`)
- [ ] `grep -rn "findSessionByRuntimeId" apps/ packages/ --include="*.ts" | grep -v node_modules | grep -v __tests__ | grep -v dist` returns nothing
- [ ] `grep -rn "runtimeSessionId" apps/ packages/ --include="*.ts" | grep -v node_modules | grep -v __tests__ | grep -v dist` returns nothing (or only backward-compat alias in ChannelSession)

---

## Review Findings Incorporated

This plan was reviewed by 3 parallel agents and updated to address:

**Coverage reviewer**: Added Tasks 10-13 covering channels pipeline (~50 refs), SDK handler (~35 refs), voice handlers (~20 refs), inbound worker (~30 refs), A2A package, pipeline-engine, Studio, ChannelSession model, second session repo. Added 14 test files to the test strategy.

**Multi-pod correctness reviewer**: Added Task 9 (CRITICAL) — WS reconnect DB rebuild must pass `sessionId` to preserve the original ID. Identified dead code in export/metrics endpoints (Task 15). Confirmed 5/6 distributed scenarios are correct post-migration.

**Scale & performance reviewer**: Added Task 14 — WAL cleanup timer (prevents ~1.7GB/hr/pod disk growth during ClickHouse outage) and disk size circuit breaker. Identified future improvements (ClickHouse materialized view for session queries, Redis pipeline for session persist, MongoDB index audit) — deferred to separate plan.

### Deferred Scale Improvements (separate plan)

- Add ClickHouse materialized view with `ORDER BY (tenant_id, session_id, timestamp)` for session trace queries
- Pipeline the 3 Redis calls in `saveSessionSnapshot` into a single `redis.pipeline()`
- Add Redis memory high-water-mark for trace streams
- Replace `LIMIT 1 BY` dedup with `FINAL` or write-time dedup
- Audit and reduce 17 Session MongoDB indexes
- Make WAL append fire-and-forget (buffer + batch `appendFile` calls)
