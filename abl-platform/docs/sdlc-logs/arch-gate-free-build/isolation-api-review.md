# Tenant/User Isolation & API Review: Gate-Free Onboarding

**Date**: 2026-04-10
**Focus**: Tenant isolation, user isolation, API surface, missing endpoints

---

## Verdict: PASS with 2 findings (1 high, 1 medium)

The existing tenant/user isolation is sound and NOT broken by this change. Every data path already scopes by `(tenantId, userId)`. The gate removal doesn't introduce new unscoped paths. Two findings below.

---

## 1. Isolation Audit Trail

### Session CRUD — All Scoped (No Change)

| Operation               | Scoping                                                 | File                     | Status           |
| ----------------------- | ------------------------------------------------------- | ------------------------ | ---------------- |
| Create session          | `{ tenantId, userId, mode, projectId }`                 | `session-service.ts:161` | PASS — unchanged |
| Get session by ID       | `{ _id, tenantId, userId }`                             | `session-service.ts:316` | PASS — unchanged |
| Get current session     | `{ tenantId, userId, state, mode }`                     | `session-service.ts:333` | PASS — unchanged |
| Transition state        | `{ _id, tenantId, userId, state: from }`                | `session-service.ts:377` | PASS — unchanged |
| Update phase            | `{ _id, tenantId, userId, state: { $ne: 'ARCHIVED' } }` | `session-service.ts:452` | PASS — unchanged |
| Update spec             | `{ _id, tenantId, userId, state: { $ne: 'ARCHIVED' } }` | `session-service.ts:484` | PASS — unchanged |
| Set pending interaction | `{ _id, tenantId, userId, state: { $ne: 'ARCHIVED' } }` | `session-service.ts:572` | PASS — unchanged |
| Archive                 | `{ _id, tenantId, userId, state: { $in: ARCHIVABLE } }` | `session-service.ts:617` | PASS — unchanged |
| Force archive stuck     | `{ tenantId, userId, mode, state, updatedAt }`          | `session-service.ts:244` | PASS — unchanged |

### Raw MongoDB Operations in Route Handler — All Scoped (No Change)

Every `db.collection('arch_sessions').updateOne/findOne` call in the route handler includes the triple-filter `{ _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId }`. I verified 10+ occurrences at lines: 1405, 1476, 1487, 1648, 1709, 3228, 3326, 3406, 3816, 3866. **All pass.**

### Project Creation — Scoped (No Change)

`createProject()` at route.ts:3547 uses `{ tenantId: ctx.tenantId, ownerId: ctx.userId }`. **Pass.**

### API Authentication — All Routes Guarded (No Change)

| Route                                      | Auth Guard                         | Verified |
| ------------------------------------------ | ---------------------------------- | -------- |
| `POST /api/arch-ai/message`                | `requireTenantAuth` at line 482    | PASS     |
| `POST /api/arch-ai/sessions`               | `requireTenantAuth` at line 26     | PASS     |
| `GET /api/arch-ai/sessions/current`        | `requireTenantAuth` at line 26     | PASS     |
| `DELETE /api/arch-ai/sessions/:id/archive` | `requireTenantAuth`                | PASS     |
| IN_PROJECT cross-project check             | `requireProjectAccess` at line 515 | PASS     |

### `proceed_to_next_phase` Tool — New, Must Be Scoped

**This is the one NEW data path introduced by the change.** The `proceed_to_next_phase` tool handler will:

1. Call `sessionService.updatePhase(ctx, sessionId, newPhase)` — scoped via ctx
2. Update metadata fields (`topologyApproved`, etc.) via raw MongoDB — must include `{ tenantId, userId }`
3. Call `transitionPhase()` — pure function, no DB access
4. Emit SSE events — no DB access

**All DB mutations MUST use `ctx.tenantId` and `ctx.userId` in the filter.** The handler runs within the same `POST /api/arch-ai/message` route handler which already has `ctx` from `requireTenantAuth`. As long as the implementation follows the existing pattern (copy from the topology_approval handler's DB operations), isolation is maintained.

---

## 2. Findings

### ISO-H1 (HIGH): `proceed_to_next_phase` BLUEPRINT→BUILD Handler Must Replicate topology_approval's Tenant-Scoped MongoDB Operations

The current `topology_approval` gate handler (route.ts:3752-3912) does 5+ raw MongoDB `updateOne` calls, all including `{ _id: session.id, tenantId: ctx.tenantId, userId: ctx.userId }`. When this logic moves into the `proceed_to_next_phase` tool handler, these tenant-scoped filters MUST be preserved verbatim.

Specifically, these operations must keep tenant scoping:

- `$set: { 'metadata.topologyApproved': true }` — line 3866
- `$set/$unset` for topology diff (preserve/remove files) — line 3816
- `$pull: { 'metadata.approvedAgents' }` for removed agents — line 3816

**Risk if missed**: Cross-tenant data leakage — a session could update another tenant's session metadata if the filter drops `tenantId`.

**Recommendation**: Add to FR-4.4: "All DB mutations in the `proceed_to_next_phase` handler MUST include `{ _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId }` in the filter, consistent with all existing raw MongoDB operations in the route handler."

---

### ISO-M1 (MEDIUM): `forceArchiveStuck` GATE_PENDING Cleanup — Already Tenant-Scoped but Needs Verification

FR-1.9 says old `GATE_PENDING` sessions must be force-archived. `forceArchiveStuck` (session-service.ts:228-309) uses `buildSessionScopeFilter(ctx, mode, projectId)` which includes `{ tenantId, userId, mode }`. This means it can only archive sessions belonging to the requesting user.

**But**: The cleanup should also cover sessions from OTHER users who are stuck in `GATE_PENDING`. A per-user-on-access cleanup won't catch sessions from users who never return.

**Options**:

1. Accept per-user cleanup (current approach) — orphaned sessions from inactive users persist but cause no harm
2. Add a startup migration or admin endpoint that archives all `GATE_PENDING` sessions across all tenants — more thorough but requires admin access

**Recommendation**: Option 1 is sufficient. `GATE_PENDING` sessions that are never accessed again are inert — they don't consume resources or block other users. The unique index on `(tenantId, userId, mode)` for non-terminal states means they only block that specific user from creating a new session in the same mode, and `forceArchiveStuck` handles that on next access.

---

## 3. API Surface Check

### Existing Endpoints — No Changes Needed

| Endpoint                                   | Change?        | Notes                                                                                   |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------------------------- |
| `POST /api/arch-ai/sessions`               | No             | Session creation unchanged                                                              |
| `GET /api/arch-ai/sessions/current`        | No             | Resume snapshot changes are internal to `buildResumeSnapshot()`                         |
| `POST /api/arch-ai/message`                | Yes — internal | Remove gate_response handling, add proceed_to_next_phase tool handler. No new endpoint. |
| `DELETE /api/arch-ai/sessions/:id/archive` | No             | Archival unchanged                                                                      |
| `GET /api/arch-ai/sessions/:id/journal`    | No             | Journal unchanged                                                                       |
| `POST /api/arch-ai/files`                  | No             | File upload unchanged                                                                   |
| `GET /api/arch-ai/files/:blobId/content`   | No             | File content unchanged                                                                  |
| `GET /api/arch-ai/project-summary`         | No             | Summary unchanged                                                                       |
| `GET /api/arch-ai/project-health`          | No             | Health unchanged                                                                        |

### Missing Endpoints — None Found

The spec doesn't introduce any new API surface. All changes are internal to the `POST /api/arch-ai/message` handler:

- `gate_response` message type removed (client stops sending it)
- `proceed_to_next_phase` is a LLM tool call processed server-side (not a new API endpoint)
- Narration is emitted via existing SSE event types (`text_delta`, `activity`)

### `gate_response` in MessageRequestSchema — Safe to Remove

Verified: IN_PROJECT mode uses `proposal_response` (separate discriminated union variant). `gate_response` is ONLY used in onboarding for `topology_approval`, `agent_review`, `tool_generation`, `quality_floor`. With all gates removed, `gate_response` has zero consumers and is safe to remove from the schema.

The `useArchChat` hook's `sendGateResponse` method (which sends `{ type: 'gate_response' }`) becomes dead code and should be removed.

---

## 4. Cross-User Isolation for `ask_user` Widgets (Unchanged)

The `ask_user` widget-pending behavior maintains user isolation:

- Session stays `ACTIVE` (mutex) — prevents a second request from the same user in another tab
- `pendingInteraction` is scoped to the session, which is scoped to `(tenantId, userId)`
- A different user cannot answer another user's widget — they have separate sessions
- `tool_answer` message clears the pending interaction via `setPendingInteraction(ctx, sessionId, null)` which filters by `(tenantId, userId)`

No change from current behavior. **Pass.**

---

## Summary

| Area              | Status    | Notes                                                                         |
| ----------------- | --------- | ----------------------------------------------------------------------------- |
| Tenant isolation  | PASS      | All DB ops include `tenantId` in filter                                       |
| User isolation    | PASS      | All DB ops include `userId` in filter. One session per user per mode.         |
| Project isolation | PASS      | IN_PROJECT uses `requireProjectAccess`. Onboarding has no project yet.        |
| Auth guards       | PASS      | All routes use `requireTenantAuth`                                            |
| New data paths    | 1 finding | `proceed_to_next_phase` handler must replicate tenant-scoped filters (ISO-H1) |
| API surface       | PASS      | No new endpoints. `gate_response` safe to remove.                             |
| Missing APIs      | PASS      | No missing endpoints identified                                               |
