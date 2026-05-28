# LLD: Feedback System

**Feature Spec**: `docs/features/feedback.md`
**HLD**: `docs/specs/feedback.hld.md`
**Test Spec**: `docs/testing/feedback.md`
**Status**: DRAFT
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                    | Rationale                                                                                                    | Alternatives Rejected                     |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| D-1 | Bottom-up implementation (schema -> service -> route -> UI) | Data layer must exist before services can write; services before routes can call; routes before UI can proxy | Top-down (UI first) -- no data to display |
| D-2 | Integer-only star ratings (1-5)                             | Simpler validation. Half-stars add UI complexity with minimal analytical benefit.                            | Float star values (3.5)                   |
| D-3 | Agent name from client hint with trace fallback             | Client provides `agentName` in feedback body; service falls back to trace lookup if missing                  | Trace-only lookup (adds latency)          |
| D-4 | feedbackText max 5000 chars                                 | Matches industry CSAT text fields. Prevents abuse without being restrictive.                                 | Unlimited text, 500 chars                 |
| D-5 | No feature flag                                             | Purely additive. New routes, new tables. Nothing existing changes.                                           | Feature flag for gradual rollout          |
| D-6 | Email bridge in Phase 4 (not Phase 1)                       | Email CSAT works fine as-is. Bridge is enhancement, not prerequisite.                                        | Phase 1 bridge (adds risk to DDL phase)   |
| D-7 | Tests alongside each phase                                  | Catches integration errors early. Each phase is independently verifiable.                                    | All tests in final phase                  |
| D-8 | ClickHouse dedup via SELECT before INSERT                   | Simple, correct, auditable. ClickHouse ReplacingMergeTree is eventual-consistency backstop only.             | ReplacingMergeTree-only dedup             |

### Key Interfaces & Types

```typescript
// apps/runtime/src/services/feedback/types.ts

import { z } from 'zod';

/** Zod schema for POST /feedback request body */
export const FeedbackSubmitSchema = z
  .object({
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    ratingType: z.enum(['thumbs', 'star', 'text']),
    ratingValue: z.number().int(),
    feedbackText: z.string().max(5000).optional(),
    agentName: z.string().optional(), // client hint, optional
  })
  .refine(
    (data) => {
      if (data.ratingType === 'thumbs') return data.ratingValue === 0 || data.ratingValue === 1;
      if (data.ratingType === 'star') return data.ratingValue >= 1 && data.ratingValue <= 5;
      if (data.ratingType === 'text')
        return typeof data.feedbackText === 'string' && data.feedbackText.length > 0;
      return false;
    },
    { message: 'Invalid ratingValue for the given ratingType' },
  );

export type FeedbackSubmitInput = z.infer<typeof FeedbackSubmitSchema>;

/** Stats query params */
export const FeedbackStatsQuerySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  agentName: z.string().optional(),
});

/** Recent query params */
export const FeedbackRecentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Feedback record (ClickHouse row) */
export interface FeedbackRecord {
  tenant_id: string;
  project_id: string;
  feedback_id: string;
  timestamp: string; // ISO 8601
  session_id: string;
  message_id: string;
  agent_name: string;
  user_id: string;
  channel: string;
  rating_type: 'thumbs' | 'star' | 'text';
  rating_value: number;
  feedback_text: string;
  has_pii: number; // 0 or 1
  encrypted: number;
  key_version: number;
  source: 'api' | 'email' | 'websocket';
}

/** Stats response shape */
export interface FeedbackStats {
  totalCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  thumbsUpRatio: number;
  averageStarRating: number;
  starCount: number;
  textFeedbackCount: number;
  byAgent: Array<{
    agentName: string;
    totalCount: number;
    thumbsUpRatio: number;
    averageStarRating: number;
  }>;
}

/** Recent response shape */
export interface FeedbackRecentResponse {
  items: Array<{
    feedbackId: string;
    sessionId: string;
    messageId: string;
    agentName: string;
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText: string | null;
    timestamp: string;
    source: string;
  }>;
  total: number;
  hasMore: boolean;
}
```

### Module Boundaries

| Module                | Responsibility                                | Depends On                                           |
| --------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `feedback/types.ts`   | Zod schemas, TypeScript interfaces            | `zod`                                                |
| `feedback-service.ts` | Validate, dedup, write ClickHouse, emit trace | types, ClickHouse client, TraceStore, session repo   |
| `feedback-query.ts`   | Read stats (MV) and recent (raw table)        | types, ClickHouse client                             |
| `feedback-api.ts`     | Express route: POST, GET /stats, GET /recent  | types, service, query, auth middleware, rate limiter |
| `sdk-handler.ts`      | WebSocket `feedback.submit` message type      | types, service                                       |
| `clickhouse-schemas`  | DDL for feedback + feedback_daily_dest + MV   | ClickHouse client                                    |
| Studio proxy routes   | Next.js API routes proxying to runtime        | `apiFetch` utility                                   |
| Studio FeedbackTab    | Analytics dashboard component                 | proxy routes, shared analytics components            |

---

## 2. File-Level Change Map

### New Files

| File                                                                   | Purpose                             | LOC Estimate |
| ---------------------------------------------------------------------- | ----------------------------------- | ------------ |
| `apps/runtime/src/services/feedback/types.ts`                          | Zod schemas + TypeScript interfaces | ~100         |
| `apps/runtime/src/services/feedback/feedback-service.ts`               | Write path: validate, dedup, insert | ~150         |
| `apps/runtime/src/services/feedback/feedback-query.ts`                 | Read path: stats, recent queries    | ~120         |
| `apps/runtime/src/routes/feedback-api.ts`                              | REST API route handler              | ~180         |
| `apps/runtime/src/__tests__/feedback/feedback-validation.test.ts`      | Unit tests: Zod schemas             | ~100         |
| `apps/runtime/src/__tests__/feedback/feedback-service.test.ts`         | Unit tests: service logic           | ~150         |
| `apps/runtime/src/__tests__/feedback/feedback-query.test.ts`           | Unit tests: query logic             | ~100         |
| `apps/runtime/src/__tests__/feedback/feedback-api.integration.test.ts` | Integration tests: API endpoints    | ~250         |
| `apps/studio/src/app/api/projects/[id]/feedback/stats/route.ts`        | Studio proxy for stats              | ~40          |
| `apps/studio/src/app/api/projects/[id]/feedback/recent/route.ts`       | Studio proxy for recent             | ~40          |
| `apps/studio/src/components/analytics/FeedbackTab.tsx`                 | Analytics dashboard tab             | ~300         |

### Modified Files

| File                                               | Change Description                                                        | Risk   |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| `packages/database/src/clickhouse-schemas/init.ts` | Add 3 DDL entries: feedback table, feedback_daily_dest, feedback_daily_mv | Low    |
| `apps/runtime/src/server.ts`                       | Add `import` + `app.use()` for feedback-api route                         | Low    |
| `apps/runtime/src/websocket/sdk-handler.ts`        | Add `feedback.submit` message type handler (~30 lines)                    | Medium |
| `apps/runtime/src/routes/feedback.ts`              | Add ClickHouse bridge write after trace event (email CSAT)                | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: ClickHouse Schema + Types

**Goal**: Create the ClickHouse tables and shared TypeScript types so subsequent phases have a data layer to write to.

**Tasks**:

1.1. Add `feedback` table DDL to `packages/database/src/clickhouse-schemas/init.ts` TABLES array
1.2. Add `feedback_daily_dest` aggregation table DDL to TABLES array
1.3. Add `feedback_daily_mv` materialized view DDL to MATERIALIZED_VIEWS array (or equivalent section)
1.4. Create `apps/runtime/src/services/feedback/types.ts` with `FeedbackSubmitSchema`, `FeedbackStatsQuerySchema`, `FeedbackRecentQuerySchema`, `FeedbackRecord`, `FeedbackStats`, `FeedbackRecentResponse`
1.5. Write unit tests for Zod schemas in `apps/runtime/src/__tests__/feedback/feedback-validation.test.ts`

**Files Touched**:

- `packages/database/src/clickhouse-schemas/init.ts` -- add 3 DDL entries
- `apps/runtime/src/services/feedback/types.ts` -- new file
- `apps/runtime/src/__tests__/feedback/feedback-validation.test.ts` -- new file

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors (types compile)
- [ ] All Zod validation tests pass: valid thumbs (0,1), valid star (1-5), valid text, invalid combos (thumbs=2, star=0, star=6, text without feedbackText, empty string IDs)
- [ ] ClickHouse DDL is syntactically correct (verified by build, validated in Phase 5 integration)

**Test Strategy**:

- Unit: 10+ test cases for FeedbackSubmitSchema validation edge cases
- No integration tests in this phase (ClickHouse DDL tested in Phase 5)

**Rollback**: Remove DDL entries from init.ts. Delete types.ts and test file.

---

### Phase 2: Feedback Service (Write + Read)

**Goal**: Implement the core business logic -- write feedback to ClickHouse, emit trace events, read aggregated stats and recent entries.

**Tasks**:

2.1. Create `apps/runtime/src/services/feedback/feedback-service.ts`:

- `validateAndSubmit(input, context)`: validate session-project binding, dedup check, generate feedbackId (randomUUID), INSERT into ClickHouse, emit `feedback.submitted` trace event
- Dedup: `SELECT count() FROM abl_platform.feedback WHERE session_id = ? AND message_id = ? AND user_id = ?`
- Agent name: use `input.agentName` if provided, otherwise default to `''` (trace lookup deferred)
- Error handling: ClickHouse errors -> throw (route returns 503), TraceStore errors -> log warning, continue

  2.2. Create `apps/runtime/src/services/feedback/feedback-query.ts`:

- `getStats(tenantId, projectId, from, to, agentName?)`: query `feedback_daily_dest` with SUM aggregation
- `getRecent(tenantId, projectId, limit, offset)`: query `feedback` table ORDER BY timestamp DESC with LIMIT/OFFSET
- Both queries include `WHERE tenant_id = ? AND project_id = ?` for isolation

  2.3. Write unit tests in `apps/runtime/src/__tests__/feedback/feedback-service.test.ts`:

- Test dedup key generation
- Test trace event data construction (matches FeedbackSubmittedDataSchema)
- Test error handling (ClickHouse failure propagated, TraceStore failure logged)

  2.4. Write unit tests in `apps/runtime/src/__tests__/feedback/feedback-query.test.ts`:

- Test stats query construction (includes tenant_id, project_id, date range)
- Test recent query construction (includes ORDER BY, LIMIT, OFFSET)
- Test empty results handling

**Files Touched**:

- `apps/runtime/src/services/feedback/feedback-service.ts` -- new file
- `apps/runtime/src/services/feedback/feedback-query.ts` -- new file
- `apps/runtime/src/__tests__/feedback/feedback-service.test.ts` -- new file
- `apps/runtime/src/__tests__/feedback/feedback-query.test.ts` -- new file

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] All feedback-service unit tests pass (dedup, trace event, error handling)
- [ ] All feedback-query unit tests pass (stats, recent, empty results)
- [ ] Service correctly imports and uses types from Phase 1

**Test Strategy**:

- Unit: Mock ClickHouse client (via `createMockClickHouseClient()`), mock TraceStore
- No integration tests yet (routes not wired)

**Rollback**: Delete service files and test files.

---

### Phase 3: REST API Routes + Server Wiring

**Goal**: Expose the feedback service via authenticated REST endpoints and wire into the runtime server.

**Tasks**:

3.1. Create `apps/runtime/src/routes/feedback-api.ts`:

- `POST /` -- validate body with FeedbackSubmitSchema, call feedbackService.validateAndSubmit(), return 201 with feedbackId
- `GET /stats` -- validate query with FeedbackStatsQuerySchema, call feedbackQuery.getStats(), return 200
- `GET /recent` -- validate query with FeedbackRecentQuerySchema, call feedbackQuery.getRecent(), return 200
- Middleware chain: authMiddleware, requireProjectScope('projectId'), tenantRateLimit('feedback')
- Error handling: ZodError -> 400, DuplicateFeedbackError -> 409, ClickHouseError -> 503
- IMPORTANT: Register static routes `/stats` and `/recent` BEFORE any parameterized routes (Express ordering)

  3.2. Wire route in `apps/runtime/src/server.ts`:

- Add `import feedbackApiRouter from './routes/feedback-api.js';`
- Add `app.use('/api/projects/:projectId/feedback', feedbackApiRouter);` in the Analytics & Observability section (after analytics, before custom-events)

  3.3. Write integration tests in `apps/runtime/src/__tests__/feedback/feedback-api.integration.test.ts`:

- Test POST with valid input -> 201
- Test POST with invalid ratingType -> 400
- Test POST duplicate -> 409
- Test GET /stats with valid time range -> 200
- Test GET /recent with pagination -> 200
- Test unauthenticated request -> 401
- Test session-project mismatch -> 400
- Test rate limit exceeded -> 429

**Files Touched**:

- `apps/runtime/src/routes/feedback-api.ts` -- new file
- `apps/runtime/src/server.ts` -- add import + app.use()
- `apps/runtime/src/__tests__/feedback/feedback-api.integration.test.ts` -- new file

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] All integration tests pass (8 scenarios minimum)
- [ ] Route is accessible at `/api/projects/:projectId/feedback` (verified by tests)
- [ ] Auth middleware blocks unauthenticated requests (401)
- [ ] Rate limit middleware blocks excessive requests (429)
- [ ] Standard envelope format on all responses

**Test Strategy**:

- Integration: supertest against real Express app with mocked ClickHouse and auth
- E2E readiness: route wiring verified

**Rollback**: Remove import + app.use() from server.ts. Delete route file and test file.

---

### Phase 4: Email CSAT Bridge + WebSocket Handler

**Goal**: Bridge existing email CSAT to also write to ClickHouse. Add WebSocket `feedback.submit` message handler.

**Tasks**:

4.1. Modify `apps/runtime/src/routes/feedback.ts`:

- After the existing `getTraceStore().addEvent()` call (line ~74), add: import and call feedbackService to INSERT into ClickHouse `feedback` table with `source: 'email'`, `user_id: ''`, `agent_name: ''`
- Wrap in try/catch: if ClickHouse write fails, log warning but do NOT block the HTML response (email feedback is best-effort for ClickHouse)

  4.2. Add WebSocket handler in `apps/runtime/src/websocket/sdk-handler.ts`:

- In the message handling switch/if block, add case for `type === 'feedback.submit'`
- Extract `messageId`, `ratingType`, `ratingValue`, `feedbackText` from `payload`
- Derive `tenantId`, `projectId`, `sessionId`, `userId` from the WebSocket session context
- Call `feedbackService.validateAndSubmit()` with `source: 'websocket'`
- Send ack message: `{ type: 'feedback.ack', payload: { feedbackId, success: true } }` or error message

  4.3. Write unit test for WebSocket handler: `apps/runtime/src/__tests__/feedback/feedback-ws.test.ts`

**Files Touched**:

- `apps/runtime/src/routes/feedback.ts` -- add ClickHouse bridge write (~15 lines)
- `apps/runtime/src/websocket/sdk-handler.ts` -- add feedback.submit handler (~30 lines)
- `apps/runtime/src/__tests__/feedback/feedback-ws.test.ts` -- new file

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Existing email CSAT tests still pass (no regression)
- [ ] Email feedback now also appears in ClickHouse (verified in integration test)
- [ ] WebSocket feedback.submit handler parses message and delegates to service
- [ ] WebSocket handler sends ack/error response
- [ ] Invalid WebSocket feedback message returns error (no crash)

**Test Strategy**:

- Unit: WebSocket message parsing, ack/error response
- Integration: Email bridge writes to ClickHouse (extends Phase 3 integration tests)

**Rollback**: Remove bridge code from feedback.ts (restore to original). Remove WS handler from sdk-handler.ts.

---

### Phase 5: Studio Proxy Routes + FeedbackTab

**Goal**: Create Studio proxy routes and the FeedbackTab analytics component.

**Tasks**:

5.1. Create `apps/studio/src/app/api/projects/[id]/feedback/stats/route.ts`:

- GET handler that proxies to runtime `/api/projects/:projectId/feedback/stats`
- Use `apiFetch` pattern (same as other settings proxies)
- Pass through `from`, `to`, `agentName` query params
- Forward auth headers

  5.2. Create `apps/studio/src/app/api/projects/[id]/feedback/recent/route.ts`:

- GET handler that proxies to runtime `/api/projects/:projectId/feedback/recent`
- Pass through `limit`, `offset` query params

  5.3. Create `apps/studio/src/components/analytics/FeedbackTab.tsx`:

- KPI cards row: Total Feedback, Thumbs Up Ratio, Average Star Rating, Text Feedback Count
- Per-agent table: Agent Name, Count, Thumbs Up %, Avg Star Rating (sortable)
- Recent feedback list: Paginated table with session link, rating display, text excerpt, timestamp
- Time range selector: 24h, 7d, 30d, 90d (reuse pattern from SessionsExplorerTab)
- Use existing shared components: `KPICard`, `Pagination`, `EmptyState`, `Badge`
- Use `useTranslations('analytics')` for i18n

  5.4. Wire FeedbackTab into analytics dashboard navigation (add tab to the analytics page tabs array)

  5.5. Add i18n keys for feedback analytics labels

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/feedback/stats/route.ts` -- new file
- `apps/studio/src/app/api/projects/[id]/feedback/recent/route.ts` -- new file
- `apps/studio/src/components/analytics/FeedbackTab.tsx` -- new file
- Analytics dashboard parent component -- add FeedbackTab to tabs

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Proxy routes correctly forward requests to runtime and return responses
- [ ] FeedbackTab renders with KPI cards, agent table, and recent list
- [ ] FeedbackTab handles empty state (no feedback data) gracefully
- [ ] Time range selector changes trigger data refresh
- [ ] i18n keys present and render correctly

**Test Strategy**:

- Unit: FeedbackTab component renders with mock data (vitest + RTL)
- No E2E in this phase (runtime and Studio run separately in dev)

**Rollback**: Delete proxy routes and FeedbackTab component. Remove tab from analytics navigation.

---

### Phase 6: E2E Tests

**Goal**: Write end-to-end tests that exercise the full feedback flow through the real HTTP API.

**Tasks**:

6.1. Create `apps/runtime/src/__tests__/e2e/feedback-e2e.test.ts`:

- E2E-1: Submit thumbs-up, verify 201 + feedbackId
- E2E-2: Submit star + text, verify round-trip via /recent
- E2E-3: Duplicate returns 409
- E2E-4: Submit 3 feedback, verify /stats counts
- E2E-5: Email CSAT backward compatibility
- E2E-6: Cross-tenant isolation (404)
- E2E-7: Unauthenticated returns 401
- E2E-8: Session-project mismatch returns 400
- E2E-9: Invalid rating values return 400
- E2E-10: Rate limit enforcement (429)
- E2E-11: Recent pagination correctness

  6.2. Test infrastructure: Express on random port, mock ClickHouse client (injected), JWT_SECRET env var, test auth tokens

**Files Touched**:

- `apps/runtime/src/__tests__/e2e/feedback-e2e.test.ts` -- new file

**Exit Criteria**:

- [ ] All 11 E2E scenarios pass
- [ ] Tests run against real Express server (not mocked routes)
- [ ] Auth middleware executes in all tests
- [ ] Cross-tenant test verifies 404 (not 403)
- [ ] No vi.mock() of codebase components (only ClickHouse client and auth token generation)
- [ ] `pnpm test --filter=runtime -- --run src/__tests__/e2e/feedback-e2e.test.ts` passes

**Test Strategy**:

- E2E: Real HTTP API via supertest, real middleware chain, mock ClickHouse (external dep)

**Rollback**: Delete test file. No production code changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `feedback-service.ts` imported by `feedback-api.ts` and `sdk-handler.ts`
- [ ] `feedback-query.ts` imported by `feedback-api.ts`
- [ ] `feedback-api.ts` route registered in `server.ts` with `app.use('/api/projects/:projectId/feedback', feedbackApiRouter)`
- [ ] `types.ts` imported by service, query, and route files
- [ ] ClickHouse DDL entries added to TABLES array in `init.ts` (auto-created on startup)
- [ ] MV DDL added to materialized views section in `init.ts`
- [ ] WebSocket handler added to sdk-handler.ts message dispatch
- [ ] Email bridge added to feedback.ts route handler
- [ ] Studio proxy routes created at correct Next.js API directory paths
- [ ] FeedbackTab imported and rendered in analytics dashboard parent component
- [ ] i18n keys added to the appropriate locale file

---

## 5. Cross-Phase Concerns

### Database Migrations

No MongoDB migrations. ClickHouse tables are created declaratively by `initClickHouseSchema()` at server startup -- the DDL uses `CREATE TABLE IF NOT EXISTS` which is idempotent.

### Feature Flags

None. All changes are additive.

### Configuration Changes

No new environment variables. The feature uses existing:

- `CLICKHOUSE_URL` / `CLICKHOUSE_HOST` (ClickHouse client)
- `JWT_SECRET` (email CSAT tokens)
- `REDIS_URL` (email CSAT dedup)

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with exit criteria met
- [ ] All 11 E2E test scenarios passing (from test spec)
- [ ] All 8 integration test scenarios passing
- [ ] All unit tests passing (validation, service, query, WebSocket)
- [ ] No regressions: `pnpm build && pnpm test --filter=runtime` passes
- [ ] No regressions: `pnpm build --filter=studio` passes
- [ ] Feature spec updated with implementation file paths
- [ ] Testing matrix updated with actual coverage
- [ ] Email CSAT endpoint unchanged (existing tests still pass)

---

## 7. FR-to-Phase Traceability

| FR    | Phase(s) | Task(s)       |
| ----- | -------- | ------------- |
| FR-1  | 1, 2, 3  | 1.4, 2.1, 3.1 |
| FR-2  | 1        | 1.4, 1.5      |
| FR-3  | 3        | 3.1, 3.2      |
| FR-4  | 2        | 2.1, 2.3      |
| FR-5  | 2        | 2.1, 2.3      |
| FR-6  | 1, 2     | 1.1, 2.1      |
| FR-7  | 4        | 4.1           |
| FR-8  | 4        | 4.2, 4.3      |
| FR-9  | 2, 3     | 2.2, 3.1      |
| FR-10 | 3        | 3.1           |
| FR-11 | 3        | 3.1           |
| FR-12 | 2, 3     | 2.1, 3.3      |

---

## 8. Open Questions

1. Should the ClickHouse dedup SELECT query use a time-bounded WHERE clause (e.g., last 30 days) to limit scan range, or should it scan the full table? Time-bounded is faster but could miss very old duplicates.
2. Should the FeedbackTab in Studio use SWR for data fetching (auto-refresh) or manual fetch on user action? Other analytics tabs use manual fetch.
3. Should the WebSocket ack message include the feedbackId, or just a success boolean?
