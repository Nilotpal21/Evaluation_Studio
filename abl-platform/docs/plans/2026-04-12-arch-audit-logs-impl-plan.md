# LLD: Arch AI Audit Logs

**Feature Spec**: `docs/features/arch-audit-logs.md`
**HLD**: `docs/specs/arch-audit-logs.hld.md`
**Test Spec**: `docs/testing/arch-audit-logs.md`
**Status**: DONE (Phases 1-4 implemented, Phase 5 E2E deferred)
**Date**: 2026-04-12

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                           | Rationale                                                                             | Alternatives Rejected                                                                         |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Emitter accepts `Model<IArchAuditLog>` via constructor DI          | Testable without mocking imports. Unit tests inject a test model or spy.              | Module-level singleton (untestable), AsyncLocalStorage (unnecessary for per-request scope)    |
| D-2 | `onStepFinish` for token capture, not `onFinish`                   | `onFinish` doesn't fire on stream abort. `onStepFinish` captures each completed step. | `onFinish` only (misses aborted streams), manual token counting (fragile)                     |
| D-3 | Explicit `{ tenantId }` in every query, plugin as backup           | Studio has no ALS tenant-context provider. Plugin alone is unreliable in Studio.      | Plugin-only (broken in Studio), withTenantContext wrapper (adds startup dependency)           |
| D-4 | `requireAdminRole(auth.id, auth.tenantId)` on all read endpoints   | Audit data includes all users' sessions, costs, errors. Non-admins must not see this. | `requireTenantAuth` only (any member sees all data — security violation)                      |
| D-5 | `format=csv` / `format=json-export` for export, omit for paginated | Avoids ambiguity where default `json` could mean paginated or full export.            | `format=json` as dual-purpose (ambiguous contract), separate `/export` endpoint (unnecessary) |
| D-6 | Tenant-delete cascade hook + user-erasure updateMany               | TTL alone is not GDPR-compliant erasure. Plugin doesn't perform deletions.            | TTL only (no on-demand erasure), no hook (compliance gap)                                     |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/audit/types.ts

export type AuditLogCategory =
  | 'llm_call'
  | 'tool_execution'
  | 'phase_transition'
  | 'user_action'
  | 'build_event'
  | 'error'
  | 'system_event';

export type AuditLogSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AuditLogTokens {
  input: number;
  output: number;
  total: number;
  estimatedCost: number;
}

export interface AuditLogEntry {
  category: AuditLogCategory;
  severity: AuditLogSeverity;
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: AuditLogTokens;
  projectId?: string;
}

export interface AuditEmitterContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}
```

```typescript
// packages/arch-ai/src/audit/audit-log-emitter.ts

import type { Model } from 'mongoose';
import type { IArchAuditLog } from '@agent-platform/database/models';

export class AuditLogEmitter {
  constructor(
    private ctx: AuditEmitterContext,
    private model: Model<IArchAuditLog>,
    private opts?: { bufferThreshold?: number; flushIntervalMs?: number },
  ) {}

  emit(entry: AuditLogEntry): void;
  async flush(): Promise<void>;
  destroy(): void; // clears timer
}
```

### Module Boundaries

| Module                                                 | Responsibility                            | Depends On                                                            |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------- |
| `packages/arch-ai/src/audit/`                          | Types, emitter class, re-exports          | `@agent-platform/database` (IArchAuditLog type only)                  |
| `packages/database/src/models/arch-audit-log.model.ts` | Schema, indexes, TTL, plugin              | `mongoose`, `tenantIsolationPlugin`, `uuidv7`                         |
| `apps/studio/src/app/api/arch-ai/audit-logs/`          | 4 read endpoints                          | `@/lib/auth`, `@/lib/api-response`, `@agent-platform/database/models` |
| `apps/studio/src/app/api/arch-ai/message/route.ts`     | Emit audit events from hot path           | `@agent-platform/arch-ai` (AuditLogEmitter)                           |
| `apps/studio/src/components/admin/`                    | UI: tab, filters, rows, timeline, summary | `@/store/arch-audit-store`                                            |
| `apps/studio/src/store/arch-audit-store.ts`            | Zustand store for audit UI state          | `@/lib/api-client`                                                    |

---

## 2. File-Level Change Map

### New Files

| File                                                                         | Purpose                                               | LOC Estimate |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| `packages/arch-ai/src/audit/types.ts`                                        | Category, severity, entry types, detail payload types | ~80          |
| `packages/arch-ai/src/audit/audit-log-emitter.ts`                            | Buffered non-blocking emitter class                   | ~100         |
| `packages/arch-ai/src/audit/index.ts`                                        | Re-exports                                            | ~5           |
| `packages/database/src/models/arch-audit-log.model.ts`                       | Mongoose schema, indexes, TTL, plugin                 | ~120         |
| `apps/studio/src/app/api/arch-ai/audit-logs/route.ts`                        | GET list + export endpoint                            | ~150         |
| `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts`                | GET summary aggregation                               | ~80          |
| `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts` | GET session timeline                                  | ~60          |
| `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts`         | GET cost breakdown                                    | ~80          |
| `apps/studio/src/app/api/arch-ai/audit-logs/_seed/route.ts`                  | POST test-only seeding (NODE_ENV=test guard)          | ~40          |
| `apps/studio/src/store/arch-audit-store.ts`                                  | Zustand store for audit log UI state                  | ~120         |
| `apps/studio/src/components/admin/ArchAuditLogsTab.tsx`                      | Main audit logs tab                                   | ~200         |
| `apps/studio/src/components/admin/AuditLogSummaryCards.tsx`                  | KPI summary cards                                     | ~80          |
| `apps/studio/src/components/admin/AuditLogFilters.tsx`                       | Filter bar with pill chips                            | ~120         |
| `apps/studio/src/components/admin/AuditLogRow.tsx`                           | Expandable log row                                    | ~100         |
| `apps/studio/src/components/admin/AuditLogTimeline.tsx`                      | Inline session timeline                               | ~80          |
| `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts`                   | Unit tests for emitter                                | ~150         |
| `packages/arch-ai/src/__tests__/audit-log-types.test.ts`                     | Unit tests for types                                  | ~60          |
| `packages/database/src/__tests__/arch-audit-log.model.test.ts`               | Schema/index tests                                    | ~80          |

### Modified Files

| File                                                    | Change Description                                                                                                  | Risk |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/index.ts`                 | Add `export { ArchAuditLog, type IArchAuditLog }` (line ~100)                                                       | Low  |
| `packages/arch-ai/src/index.ts`                         | Add `export * from './audit/index.js'`                                                                              | Low  |
| `apps/studio/src/app/api/arch-ai/message/route.ts`      | Create emitter at request entry, add `onStepFinish` to 3 `streamText()` calls, emit at tool/phase/error/done points | Med  |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts`     | Emit `system_event` on session create/archive                                                                       | Low  |
| `apps/studio/src/components/admin/ArchSettingsPage.tsx` | Add tab navigation to include AuditLogsTab                                                                          | Low  |
| `apps/studio/src/components/navigation/AppShell.tsx`    | No change needed — `ArchSettingsPage` is already routed for `admin/arch`                                            | None |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Data Layer (Model + Emitter)

**Goal**: Mongoose model with schema/indexes/TTL and the emitter class with buffer/flush logic — all testable without API routes.

**Tasks**:

1.1. Create `packages/database/src/models/arch-audit-log.model.ts`:

- `IArchAuditLog` interface matching HLD §5 schema
- Mongoose schema with all fields, enum constraints, subdocuments
- 6 indexes + TTL index (`expireAfterSeconds: 7776000`)
- `tenantIsolationPlugin` applied
- Export model with `mongoose.models` guard (same pattern as `arch-journal.model.ts`)

  1.2. Add export to `packages/database/src/models/index.ts`:

- `export { ArchAuditLog, type IArchAuditLog } from './arch-audit-log.model.js';`

  1.3. Create `packages/arch-ai/src/audit/types.ts`:

- `AuditLogCategory`, `AuditLogSeverity` union types
- `AuditLogTokens`, `AuditLogEntry`, `AuditEmitterContext` interfaces
- Detail payload types per category (LLMCallDetail, ToolExecutionDetail, etc.)

  1.4. Create `packages/arch-ai/src/audit/audit-log-emitter.ts`:

- Constructor: `(ctx: AuditEmitterContext, model: Model<IArchAuditLog>, opts?)`
- `emit(entry)`: push to `buffer[]`, auto-flush at threshold
- `flush()`: `insertMany(batch, { ordered: false })` in try/catch, log.warn on error, clear buffer
- `scheduleFlush()`: 2s timer (configurable), reset on emit
- `destroy()`: clear timer
- Read `ARCH_AUDIT_LOG_ENABLED` env — if false, emit/flush are no-ops

  1.5. Create `packages/arch-ai/src/audit/index.ts` — re-export types and class

  1.6. Add export to `packages/arch-ai/src/index.ts`:

- `export { AuditLogEmitter, type AuditLogEntry, type AuditLogCategory, type AuditLogSeverity, type AuditEmitterContext } from './audit/index.js';`

  1.7. Write unit tests:

- `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts` (UT-1 through UT-4)
- `packages/arch-ai/src/__tests__/audit-log-types.test.ts` (UT-5, UT-10, UT-11)
- `packages/database/src/__tests__/arch-audit-log.model.test.ts` (UT-6 through UT-9)

**Files Touched**:

- `packages/database/src/models/arch-audit-log.model.ts` — NEW
- `packages/database/src/models/index.ts` — add 1 export line
- `packages/arch-ai/src/audit/types.ts` — NEW
- `packages/arch-ai/src/audit/audit-log-emitter.ts` — NEW
- `packages/arch-ai/src/audit/index.ts` — NEW
- `packages/arch-ai/src/index.ts` — add 1 export line
- `packages/arch-ai/src/__tests__/audit-log-emitter.test.ts` — NEW
- `packages/arch-ai/src/__tests__/audit-log-types.test.ts` — NEW
- `packages/database/src/__tests__/arch-audit-log.model.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] All 11 unit tests pass (UT-1 through UT-11)
- [ ] `ArchAuditLog` model compiles and schema has all 6 indexes + TTL
- [ ] `AuditLogEmitter` flushes at threshold, flushes on `flush()`, swallows errors
- [ ] `ARCH_AUDIT_LOG_ENABLED=false` makes emitter a no-op

**Test Strategy**:

- Unit: Emitter buffer/flush via DI (inject model spy that tracks `insertMany` calls). Schema validation via mongoose `validateSync`. Index presence via `schema.indexes()`.

**Rollback**: Delete the 3 new files + revert 2 index.ts edits.

---

### Phase 2: API Layer (4 Read Endpoints + Seed)

**Goal**: All 4 query endpoints working with real MongoDB, admin-role-gated, tenant-isolated, plus the test seed endpoint.

**Tasks**:

2.1. Create `apps/studio/src/app/api/arch-ai/audit-logs/route.ts`:

- `GET` handler: `requireTenantAuth` → `requireAdminRole(auth.id, auth.tenantId)`
- Zod schema for query params: `category`, `severity`, `phase`, `userId`, `sessionId`, `specialist`, `from`, `to`, `page`, `limit`, `format`
- When `format` is omitted: paginated query with `{ tenantId: auth.tenantId, ...filters }`, `.sort({ timestamp: -1 })`, `.skip()`, `.limit()`, `.lean()`. Count via `countDocuments`. Return `{ success, entries, total, page, hasMore }`.
- When `format=csv`: same filters, no pagination, `.limit(10_000)`. Stream CSV with `Content-Type: text/csv`, `Content-Disposition: attachment`. Serialize `detail` and `tokens` as JSON strings.
- When `format=json-export`: same as csv but return JSON array with `Content-Disposition: attachment`.

  2.2. Create `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts`:

- `GET` handler with admin auth
- MongoDB `$facet` aggregation with explicit `{ tenantId }` match:
  - `totals`: `$group` for count, token sums, cost sum
  - `errorCounts`: `$match { severity: { $in: ['warning','error','critical'] } }` → `$group` by severity
  - `byCategory`: `$group` by category

    2.3. Create `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts`:

- `GET` handler with admin auth
- `find({ tenantId, sessionId }).sort({ timestamp: 1 }).lean()`
- Return `{ success, entries }`

  2.4. Create `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts`:

- `GET` handler with admin auth
- `aggregate`: `$match { tenantId, category: 'llm_call', timestamp range }` → `$group { _id: { userId, phase, model: '$detail.model' }, totalCost: { $sum }, totalTokens: { $sum }, callCount: { $sum: 1 } }` → `$sort { totalCost: -1 }`

  2.5. Create `apps/studio/src/app/api/arch-ai/audit-logs/_seed/route.ts`:

- `POST` handler: `if (process.env.NODE_ENV !== 'test') return 404`
- Accepts `{ entries: AuditLogEntry[] }` in body
- Creates `AuditLogEmitter`, calls `emit()` for each entry, then `flush()`
- Returns `{ success, count }`

  2.6. Write integration tests:

- `apps/studio/src/__tests__/arch-ai/audit-logs-list.integration.test.ts` (INT-4, INT-8)
- `apps/studio/src/__tests__/arch-ai/audit-logs-summary.integration.test.ts` (INT-5)
- `apps/studio/src/__tests__/arch-ai/audit-logs-timeline.integration.test.ts` (INT-6)
- `apps/studio/src/__tests__/arch-ai/audit-logs-cost.integration.test.ts` (INT-7)
- `apps/studio/src/__tests__/arch-ai/audit-logs-emitter.integration.test.ts` (INT-1, INT-2, INT-3)

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/audit-logs/route.ts` — NEW
- `apps/studio/src/app/api/arch-ai/audit-logs/summary/route.ts` — NEW
- `apps/studio/src/app/api/arch-ai/audit-logs/sessions/[id]/timeline/route.ts` — NEW
- `apps/studio/src/app/api/arch-ai/audit-logs/cost-breakdown/route.ts` — NEW
- `apps/studio/src/app/api/arch-ai/audit-logs/_seed/route.ts` — NEW
- 5 integration test files — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] All 8 integration tests pass (INT-1 through INT-8)
- [ ] `GET /audit-logs` returns paginated results with correct `total`/`hasMore`
- [ ] `GET /audit-logs?format=csv` returns full filtered set (no pagination)
- [ ] `GET /audit-logs/summary` returns correct token/cost/error aggregates
- [ ] `GET /audit-logs/sessions/:id/timeline` returns chronological entries
- [ ] `GET /audit-logs/cost-breakdown` groups by user/phase/model correctly
- [ ] Non-admin user receives 403 on all endpoints
- [ ] Cross-tenant query returns empty results

**Test Strategy**:

- Integration: Real MongoDB via test helper. Seed directly via model for integration tests (integration tests test the route handler logic, not the middleware chain). Auth context injected via mocked `requireTenantAuth`/`requireAdminRole` returns.

**Rollback**: Delete 5 route files + 5 test files.

---

### Phase 3: Emission Instrumentation (Token Capture + Event Emission)

**Goal**: Wire the emitter into `message/route.ts` and `sessions/route.ts` so every Arch AI interaction generates audit log entries.

**Tasks**:

3.1. In `message/route.ts` request entry (~line 100-110):

- Import `AuditLogEmitter` and `ArchAuditLog` model
- After auth: `const auditEmitter = process.env.ARCH_AUDIT_LOG_ENABLED !== 'false' ? new AuditLogEmitter({ tenantId: auth.tenantId, userId: auth.id, sessionId }, ArchAuditLog) : null;`
- Emit `user_action` with `action: 'message_sent'`

  3.2. Add `onStepFinish` to `VercelLLMStreamClient` `streamText()` (~L396):

- Inside `onStepFinish({ usage, finishReason, toolCalls })`:
- `auditEmitter?.emit({ category: 'llm_call', severity: 'info', summary: \`LLM step: ${usage.totalTokens} tokens\`, detail: { model: modelId, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, ... }, tokens: { input: usage.promptTokens, output: usage.completionTokens, total: usage.totalTokens, estimatedCost: estimateCost(modelId, usage.promptTokens, usage.completionTokens) } })`

  3.3. Add `onStepFinish` to `startStream()` (~L4988):

- Same pattern as 3.2 for ONBOARDING mode

  3.4. Add `onStepFinish` to build agent generation `streamText()` (~L3642):

- Same pattern, with `agentName` in detail

  3.5. Emit `tool_execution` around tool execution blocks:

- Wrap tool execute calls with `const start = Date.now()`, then emit after result
- `auditEmitter?.emit({ category: 'tool_execution', detail: { toolName, durationMs: Date.now() - start, resultStatus, inputSummary: JSON.stringify(input).slice(0, 200) } })`

  3.6. Emit `phase_transition` in `phase-transition.ts`:

- After successful transition: `auditEmitter?.emit({ category: 'phase_transition', detail: { from, to, trigger } })`
- Pass `auditEmitter` as parameter to `executePhaseTransition()`

  3.7. Emit `build_event` in agent generation block:

- `build_agent_start`, `build_agent_compiled`, `build_agent_error` — piggyback on existing SSE events

  3.8. Emit `error` in catch blocks:

- At each `log.error(...)` call, add `auditEmitter?.emit({ category: 'error', severity: 'error', detail: { errorCode, message, source, recoveryAction } })`

  3.9. Flush emitter on SSE `done` event:

- Before emitting the `done` SSE event: `await auditEmitter?.flush()`

  3.10. In `sessions/route.ts`:

- Emit `system_event` with `event: 'session_created'` after `sessionService.create()`
- Emit `system_event` with `event: 'session_archived'` after archive

  3.11. Register tenant-delete cascade hook:

- In `packages/database/src/models/arch-audit-log.model.ts` or a Studio startup hook: `ArchAuditLog.deleteMany({ tenantId })` on tenant delete

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/message/route.ts` — MODIFIED (add emitter creation, onStepFinish x3, tool/phase/error/done emissions)
- `apps/studio/src/app/api/arch-ai/sessions/route.ts` — MODIFIED (add system_event emissions)
- `apps/studio/src/lib/arch-ai/phase-transition.ts` — MODIFIED (accept auditEmitter param, emit phase_transition)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Sending a message to Arch AI creates audit log entries in the database
- [ ] `llm_call` entries have `tokens` subdocument with non-zero values
- [ ] `tool_execution` entries have `durationMs` > 0
- [ ] `phase_transition` entries appear when phase changes
- [ ] `error` entries appear when LLM stream fails
- [ ] `system_event` entries appear on session create/archive
- [ ] SSE stream latency unchanged at p95 (manual verification)

**Test Strategy**:

- Manual verification: send a message via Arch AI chat, query audit logs API, verify entries exist with correct data. This phase modifies the 5400-line route file — automated E2E testing happens in Phase 5.

**Rollback**: Revert the 3 modified files. Emitter creation is guarded by `ARCH_AUDIT_LOG_ENABLED` — set to `false` as immediate kill switch.

---

### Phase 4: UI (Admin Tab + Store)

**Goal**: Audit logs tab on the Arch settings page with filtering, summary cards, expandable rows, timeline, and export.

**Tasks**:

4.1. Create `apps/studio/src/store/arch-audit-store.ts`:

- Zustand store: `filters` (category, severity, phase, userId, sessionId, specialist, from, to), `page`, `limit`, `entries`, `total`, `hasMore`, `loading`, `summary`, `costBreakdown`, `timelineSessionId`, `timelineEntries`
- Actions: `fetchLogs()`, `fetchSummary()`, `fetchTimeline(sessionId)`, `fetchCostBreakdown()`, `setFilter()`, `clearFilters()`, `setPage()`, `refresh()`

  4.2. Create `apps/studio/src/components/admin/AuditLogSummaryCards.tsx`:

- 4 KPI cards: Total LLM Calls, Tokens Used, Estimated Cost, Error Count
- Use semantic design tokens for card styling

  4.3. Create `apps/studio/src/components/admin/AuditLogFilters.tsx`:

- Pill-based filter chips for each category (7 chips with category color)
- Dropdowns for severity, phase, specialist
- Date range picker for from/to
- "Clear all" button

  4.4. Create `apps/studio/src/components/admin/AuditLogRow.tsx`:

- Compact row: timestamp | category icon+color | summary | key metric (tokens/duration/error)
- Click to expand: detail card with all fields from `detail` payload
- Session ID as clickable link → triggers timeline load

  4.5. Create `apps/studio/src/components/admin/AuditLogTimeline.tsx`:

- Inline section that appears below the log table when a session ID is clicked
- Chronological list of all events for that session
- Category icons + timestamp + summary per row

  4.6. Create `apps/studio/src/components/admin/ArchAuditLogsTab.tsx`:

- Composes: SummaryCards + Filters + LogTable (with AuditLogRow) + Timeline
- Manual refresh button in header
- Export CSV / JSON-export buttons
- Admin-role guard: check user role before rendering (show "Access denied" for non-admins)
- Pagination controls at bottom

  4.7. Modify `apps/studio/src/components/admin/ArchSettingsPage.tsx`:

- Add tab navigation: "Settings" (existing) | "Audit Logs" (new)
- Import and render `ArchAuditLogsTab` when "Audit Logs" tab is active

**Files Touched**:

- `apps/studio/src/store/arch-audit-store.ts` — NEW
- `apps/studio/src/components/admin/AuditLogSummaryCards.tsx` — NEW
- `apps/studio/src/components/admin/AuditLogFilters.tsx` — NEW
- `apps/studio/src/components/admin/AuditLogRow.tsx` — NEW
- `apps/studio/src/components/admin/AuditLogTimeline.tsx` — NEW
- `apps/studio/src/components/admin/ArchAuditLogsTab.tsx` — NEW
- `apps/studio/src/components/admin/ArchSettingsPage.tsx` — MODIFIED (add tab)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Navigate to `/admin/arch` → "Audit Logs" tab renders without error
- [ ] Summary cards show correct numbers from API
- [ ] Filter chips toggle categories, results update on apply
- [ ] Clicking a log row expands to show detail
- [ ] Clicking session ID loads inline timeline
- [ ] Export CSV downloads a file with correct data
- [ ] Manual refresh re-fetches from API
- [ ] Non-admin users see "Access denied" instead of the tab content

**Test Strategy**:

- Manual UI verification in browser. Start dev server, navigate to `/admin/arch`, verify all interactions. No automated component tests in this phase (UI is thin presentation layer).

**Rollback**: Delete 6 new files, revert ArchSettingsPage.tsx tab addition.

---

### Phase 5: E2E Tests + Final Validation

**Goal**: Full E2E test suite exercising the complete system through HTTP API.

**Tasks**:

5.1. Create `apps/studio/src/__tests__/arch-ai/audit-logs-e2e.test.ts`:

- E2E-1: Full emit-to-query lifecycle (via `_seed` endpoint)
- E2E-2: Tenant isolation across all endpoints (bidirectional)
- E2E-3: Pagination and multi-filter combination
- E2E-4: Session timeline ordering and completeness
- E2E-5: Summary aggregation with token data
- E2E-6: Cost breakdown grouping
- E2E-7: CSV export with active filters
- E2E-8: Date range filtering
- E2E-9: Admin role enforcement (non-admin gets 403)
- E2E-10: Export ignores pagination (full filtered set)

  5.2. Verify all integration tests still pass (INT-1 through INT-8)

  5.3. Verify `pnpm build` and `pnpm test` pass for all affected packages

  5.4. Manual smoke test: full user journey through the UI

**Files Touched**:

- `apps/studio/src/__tests__/arch-ai/audit-logs-e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] All 10 E2E tests pass
- [ ] All 8 integration tests pass
- [ ] All 11 unit tests pass
- [ ] `pnpm build` succeeds for `@agent-platform/database`, `@agent-platform/arch-ai`, and `studio`
- [ ] No regressions in existing Arch AI tests (`pnpm test --filter=studio`)
- [ ] Manual smoke test: send message → query audit logs → filter → expand → export CSV

**Test Strategy**:

- E2E: HTTP calls to real Next.js API endpoints via `_seed` for seeding, GET for queries. Auth via test helper that creates admin tokens.

**Rollback**: Delete the test file. No production code changes in this phase.

---

## 4. Wiring Checklist

- [ ] `ArchAuditLog` model exported from `packages/database/src/models/index.ts`
- [ ] `AuditLogEmitter` and types exported from `packages/arch-ai/src/index.ts`
- [ ] 4 API route files created in `apps/studio/src/app/api/arch-ai/audit-logs/` (Next.js auto-discovers)
- [ ] `_seed` route created with `NODE_ENV=test` guard
- [ ] `AuditLogEmitter` instantiated in `message/route.ts` request handler
- [ ] `auditEmitter` passed to `executePhaseTransition()` in `phase-transition.ts`
- [ ] `onStepFinish` callback added to all 3 `streamText()` call sites
- [ ] `auditEmitter.flush()` called before SSE `done` event emission
- [ ] `ArchAuditLogsTab` imported and rendered in `ArchSettingsPage.tsx`
- [ ] `useArchAuditStore` created and used by tab components
- [ ] Tenant-delete cascade hook registered for `ArchAuditLog`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. New collection auto-created by Mongoose on first write. Indexes created at model registration.

### Feature Flags

| Flag                     | Default | Purpose                                          |
| ------------------------ | ------- | ------------------------------------------------ |
| `ARCH_AUDIT_LOG_ENABLED` | `true`  | Kill switch — disables all emission when `false` |

### Configuration Changes

| Variable                           | Default | Added In |
| ---------------------------------- | ------- | -------- |
| `ARCH_AUDIT_LOG_ENABLED`           | `true`  | Phase 1  |
| `ARCH_AUDIT_LOG_TTL_DAYS`          | `90`    | Phase 1  |
| `ARCH_AUDIT_LOG_BUFFER_SIZE`       | `50`    | Phase 1  |
| `ARCH_AUDIT_LOG_FLUSH_INTERVAL_MS` | `2000`  | Phase 1  |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] 10 E2E tests from test spec passing (E2E-1 through E2E-10)
- [ ] 8 integration tests from test spec passing (INT-1 through INT-8)
- [ ] 11 unit tests passing (UT-1 through UT-11)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec §17 updated with actual coverage
- [ ] Testing matrix updated with PASS/FAIL status
- [ ] SSE streaming latency unchanged at p95 (manual verification)
- [ ] Admin-only access enforced (non-admin gets 403)
- [ ] Tenant isolation verified bidirectionally
- [ ] Export delivers full filtered set (not truncated to page size)
- [ ] 90-day TTL index present on collection

---

## 7. Open Questions

1. Should `estimateCost()` be called inside the `onStepFinish` callback (per-step cost) or accumulated and called once in `onFinish`/post-stream (total cost)? Per-step is safer (abort-resilient) but calls the function more times. Recommendation: per-step.
2. The `_seed` endpoint is guarded by `NODE_ENV=test`. In CI, is `NODE_ENV` reliably set to `test` during test runs? Verify in CI config.

---

## FR → Task Traceability

| FR    | Covered By Tasks                                                |
| ----- | --------------------------------------------------------------- |
| FR-1  | 1.3, 1.4 (types + emitter support all 7 categories)             |
| FR-2  | 1.1, 1.3 (schema required fields + type interface)              |
| FR-3  | 1.3, 3.2-3.4 (LLM detail type + onStepFinish callbacks)         |
| FR-4  | 3.2, 3.3, 3.4 (three streamText call sites)                     |
| FR-5  | 1.4 (emitter buffer/flush/fire-and-forget)                      |
| FR-6  | 2.1 (list endpoint with filters + pagination)                   |
| FR-7  | 2.2 (summary aggregation)                                       |
| FR-8  | 2.3 (session timeline)                                          |
| FR-9  | 2.4 (cost breakdown)                                            |
| FR-10 | 2.1-2.4 (requireAdminRole on all endpoints + explicit tenantId) |
| FR-11 | 1.1 (TTL index on schema)                                       |
| FR-12 | 4.1, 4.6 (store refresh action + UI refresh button)             |
| FR-13 | 2.1, 4.6 (format=csv/json-export + export buttons)              |
| FR-14 | 4.4, 4.5 (clickable session ID + timeline component)            |
| FR-15 | 1.3, 3.8 (error detail type + error emission)                   |
| FR-16 | 1.3, 3.7 (build event detail type + build emission)             |
