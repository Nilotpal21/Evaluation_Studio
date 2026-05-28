# Session Cross-Project Isolation Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix session resumeHandle cross-project contamination — prevent stale session IDs from one project being used in another project's context.

**Architecture:** Two surgical fixes: (1) `setSession`/`restoreSession` in session-store.ts must reset `projectId` to null instead of inheriting from previous state, (2) `resolveCurrentResumableSessionId` in WebSocketContext.tsx must use fail-closed logic requiring both projectIds to be non-null and matching.

**Tech Stack:** TypeScript, Zustand, React (WebSocketContext), Vitest

**Acceptance criteria:** 14 currently-failing tests in `session-store-cross-project-isolation.test.ts` and `session-resume-project-guard.test.ts` must pass. All 37 currently-passing tests must continue to pass. Total: 51/51.

---

### Task 1: Fix `setSession` — stop inheriting stale projectId

**Files:**

- Modify: `apps/studio/src/store/session-store.ts:127-146`

- [ ] **Step 1: Run failing tests to confirm baseline**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-store-cross-project-isolation.test.ts`
Expected: 7 failures (setSession inherits stale projectId, restoreSession inherits, intermediate state tests)

- [ ] **Step 2: Fix `setSession` to reset resumeHandle from EMPTY_RESUME_HANDLE**

In `apps/studio/src/store/session-store.ts`, replace lines 127-146:

```typescript
      setSession: (sessionId, agent) => {
        set((state) => ({
          sessionId,
          agent,
          messages: [],
          messageSnapshotVersion: 0,
          state: createInitialAgentState(),
          lastAction: null,
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...state.resumeHandle,
            sessionId,
            kind: 'web_debug',
            lastSeenTraceEventId: null,
          },
          expandedThoughtIds: new Set(),
        }));
      },
```

with:

```typescript
      setSession: (sessionId, agent) => {
        set(() => ({
          sessionId,
          agent,
          messages: [],
          messageSnapshotVersion: 0,
          state: createInitialAgentState(),
          lastAction: null,
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...EMPTY_RESUME_HANDLE,
            sessionId,
            kind: 'web_debug',
          },
          expandedThoughtIds: new Set(),
        }));
      },
```

Key changes:

- `...EMPTY_RESUME_HANDLE` instead of `...state.resumeHandle` — starts from clean state
- Removes unused `state` parameter from the callback
- `projectId` is now `null` (from EMPTY_RESUME_HANDLE) — the caller (`agent_loaded` handler) will set it via `rememberResumeHandle` immediately after

- [ ] **Step 3: Run setSession tests to verify fix**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-store-cross-project-isolation.test.ts`
Expected: setSession tests pass, restoreSession tests still fail (not fixed yet)

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/store/session-store.ts
git add apps/studio/src/store/session-store.ts
git commit -m "$(cat <<'EOF'
[ABLP-002] fix(studio): setSession must not inherit stale resumeHandle projectId

setSession was spreading ...state.resumeHandle, which carried the previous
session's projectId into the new session. This caused cross-project session
ID contamination when navigating between projects.

Now starts from EMPTY_RESUME_HANDLE so projectId is null until explicitly
set by the caller via rememberResumeHandle.
EOF
)"
```

---

### Task 2: Fix `restoreSession` — stop inheriting stale projectId

**Files:**

- Modify: `apps/studio/src/store/session-store.ts:381-402`

- [ ] **Step 1: Fix `restoreSession` to reset resumeHandle from EMPTY_RESUME_HANDLE**

In `apps/studio/src/store/session-store.ts`, replace lines 381-402:

```typescript
      restoreSession: (data) => {
        set((state) => ({
          sessionId: data.sessionId,
          agent: data.agent,
          messages: data.messages,
          messageSnapshotVersion: state.messageSnapshotVersion + 1,
          state: data.state,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...state.resumeHandle,
            sessionId: data.sessionId,
            kind: 'web_debug',
          },
          expandedThoughtIds: new Set(),
        }));
      },
```

with:

```typescript
      restoreSession: (data) => {
        set((state) => ({
          sessionId: data.sessionId,
          agent: data.agent,
          messages: data.messages,
          messageSnapshotVersion: state.messageSnapshotVersion + 1,
          state: data.state,
          lastAction: null,
          isStreaming: false,
          streamingMessageId: null,
          streamingContent: '',
          isLoading: false,
          error: null,
          statusMessage: null,
          resumeHandle: {
            ...EMPTY_RESUME_HANDLE,
            sessionId: data.sessionId,
            kind: 'web_debug',
          },
          expandedThoughtIds: new Set(),
        }));
      },
```

Key change: `...EMPTY_RESUME_HANDLE` instead of `...state.resumeHandle`. The `state` param is still needed for `messageSnapshotVersion`.

- [ ] **Step 2: Run all session-store isolation tests**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-store-cross-project-isolation.test.ts`
Expected: All 30 tests pass (0 failures)

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/store/session-store.ts
git add apps/studio/src/store/session-store.ts
git commit -m "$(cat <<'EOF'
[ABLP-002] fix(studio): restoreSession must not inherit stale resumeHandle projectId

Same bug as setSession — restoreSession spread ...state.resumeHandle,
carrying the previous session's projectId. Now starts from
EMPTY_RESUME_HANDLE.
EOF
)"
```

---

### Task 3: Fix `resolveCurrentResumableSessionId` — fail-closed guard

**Files:**

- Modify: `apps/studio/src/contexts/WebSocketContext.tsx:404-413`

- [ ] **Step 1: Run failing guard tests to confirm baseline**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-resume-project-guard.test.ts`
Expected: 7 failures (null projectIds pass the guard when they shouldn't)

- [ ] **Step 2: Fix the project match guard to be fail-closed**

In `apps/studio/src/contexts/WebSocketContext.tsx`, replace lines 404-413:

```typescript
const resolveCurrentResumableSessionId = useCallback(() => {
  const currentProjectId = useNavigationStore.getState().projectId;
  const { sessionId: existingSessionId, resumeHandle } = useSessionStore.getState();
  const projectMatchesCurrent =
    !currentProjectId || !resumeHandle.projectId || resumeHandle.projectId === currentProjectId;

  return projectMatchesCurrent && (existingSessionId ?? resumeHandle.sessionId)
    ? (existingSessionId ?? resumeHandle.sessionId)
    : null;
}, []);
```

with:

```typescript
const resolveCurrentResumableSessionId = useCallback(() => {
  const currentProjectId = useNavigationStore.getState().projectId;
  const { sessionId: existingSessionId, resumeHandle } = useSessionStore.getState();
  const projectMatchesCurrent =
    currentProjectId != null &&
    currentProjectId.length > 0 &&
    resumeHandle.projectId != null &&
    resumeHandle.projectId.length > 0 &&
    resumeHandle.projectId === currentProjectId;

  return projectMatchesCurrent && (existingSessionId ?? resumeHandle.sessionId)
    ? (existingSessionId ?? resumeHandle.sessionId)
    : null;
}, []);
```

Key changes:

- Triple-OR (`!a || !b || a===b`) replaced with strict AND (`a != null && b != null && a === b`)
- Added `.length > 0` checks to treat empty strings as null (edge case from tests)
- Both projectIds must be non-null and matching for resume to proceed

- [ ] **Step 3: Run all guard tests**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-resume-project-guard.test.ts`
Expected: All 21 tests pass (0 failures)

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/studio/src/contexts/WebSocketContext.tsx
git add apps/studio/src/contexts/WebSocketContext.tsx
git commit -m "$(cat <<'EOF'
[ABLP-002] fix(studio): make session resume project guard fail-closed

The resolveCurrentResumableSessionId guard used a triple-OR that treated
null projectIds as matches (fail-open). This allowed sessions from one
project to leak into another project's context when either projectId was
null — e.g., during initial page load or after setSession didn't set
projectId.

Now requires both projectIds to be non-null, non-empty, and equal.
EOF
)"
```

---

### Task 4: Run full test suite and verify no regressions

- [ ] **Step 1: Run both isolation test files — all 51 must pass**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-store-cross-project-isolation.test.ts src/__tests__/stores/session-resume-project-guard.test.ts`
Expected: 51 passed, 0 failed

- [ ] **Step 2: Run the existing session store tests — no regressions**

Run: `pnpm --filter studio test -- --run src/__tests__/stores/session-store.test.ts`
Expected: All existing tests pass

- [ ] **Step 3: Run the WebSocket session resume tests — no regressions**

Run: `pnpm --filter studio test -- --run src/__tests__/websocket-session-resume-traces.test.tsx`
Expected: All existing tests pass

- [ ] **Step 4: Run full Studio test suite**

Run: `pnpm --filter studio test`
Expected: All tests pass, no regressions from the three-line change

- [ ] **Step 5: Build check**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds with no TypeScript errors
