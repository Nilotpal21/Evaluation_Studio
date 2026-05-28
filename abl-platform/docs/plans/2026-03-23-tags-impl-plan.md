# LLD: Tags & Eval Tags

**Feature Spec**: `docs/features/tags.md`
**HLD**: `docs/specs/tags.hld.md`
**Test Spec**: `docs/testing/tags.md`
**Status**: DRAFT
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                         | Rationale                                                                                | Alternatives Rejected                                                  |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D-1 | Extract TagService class from route handlers     | Testable service layer; routes become thin delegators                                    | Keep logic in route handlers (current state -- untestable, monolithic) |
| D-2 | Synchronous auto-apply via direct function call  | O(n<100) completes in <10ms; BullMQ overhead unjustified                                 | BullMQ worker (M effort, eventual consistency)                         |
| D-3 | MongoDB $addToSet / $pull for Session.tags       | Idempotent, atomic array operations; no race conditions                                  | Replace entire array (not atomic, race-prone)                          |
| D-4 | ClickHouse ALTER TABLE DELETE for tag removal    | Simplest approach; ClickHouse handles async mutation internally                          | Soft-delete with 'removed' marker (complex queries)                    |
| D-5 | Zod validation on all endpoints including PUT    | Closes GAP-6 (raw req.body to $set); prevents arbitrary field injection                  | Keep raw pass-through (security risk)                                  |
| D-6 | Tag cap of 50 per session enforced in TagService | Prevents unbounded array growth (GAP-7); 50 is generous for categorization labels        | No limit (storage risk), or 10 (too restrictive)                       |
| D-7 | Studio proxy routes use apiFetch pattern         | Matches all 11 existing Studio settings tabs; provides two-layer auth (defense in depth) | Direct runtime API calls from browser (CORS issues, no Studio auth)    |
| D-8 | Condition evaluator as pure function module      | Easy to unit test; no side effects; composable with any caller                           | Method on TagService (coupled, harder to test in isolation)            |

### Key Interfaces & Types

```typescript
// apps/runtime/src/services/tag-service.ts

import { z } from 'zod';

/** Zod schema for tag rule create/update */
export const tagRuleBodySchema = z.object({
  tagName: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  conditions: z
    .array(
      z.object({
        field: z.string().min(1),
        operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'in']),
        value: z.unknown(),
      }),
    )
    .min(1),
  conditionLogic: z.enum(['AND', 'OR']).default('AND'),
  autoApply: z.boolean().default(false),
});

/** Zod schema for tag apply/remove */
export const tagApplySchema = z.object({
  sessionId: z.string().min(1),
  tags: z.array(z.string().min(1).max(100)).min(1).max(50),
});

/** Zod schema for bulk tag operations */
export const tagBulkSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(500),
  tags: z.array(z.string().min(1).max(100)).min(1).max(50),
});

/** Result type for bulk operations */
export interface BulkTagResult {
  applied: number;
  failed: number;
  errors: Array<{ sessionId: string; error: string }>;
}

/** Tag stats response shape */
export interface TagStatsResult {
  tags: Array<{
    tag_name: string;
    count: number;
    last_applied: string;
  }>;
  total_tagged_sessions: number;
  period: { from: string; to: string };
}
```

```typescript
// apps/runtime/src/services/tag-condition-evaluator.ts

export interface TagCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'in';
  value: unknown;
}

/**
 * Evaluate a set of conditions against a session object.
 * Pure function — no side effects, no DB access.
 */
export function evaluateConditions(
  session: Record<string, unknown>,
  conditions: TagCondition[],
  logic: 'AND' | 'OR',
): boolean;
```

### Module Boundaries

| Module                       | Responsibility                                                     | Depends On                                          |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| `tags.ts` (route)            | HTTP handling, auth checks, request parsing, response formatting   | TagService, Zod schemas                             |
| `tag-service.ts`             | Business logic: CRUD, apply/remove, bulk, stats, auto-apply        | TagRuleModel, Session, ClickHouse client, evaluator |
| `tag-condition-evaluator.ts` | Pure condition evaluation: (session, conditions, logic) -> boolean | None (pure function)                                |
| Studio proxy routes          | Auth + forward to runtime                                          | requireTenantAuth, requireProjectAccess, apiFetch   |
| Studio UI components         | User interaction for tag management                                | Studio proxy routes, design system                  |

---

## 2. File-Level Change Map

### New Files

| File                                                                 | Purpose                                  | LOC Estimate |
| -------------------------------------------------------------------- | ---------------------------------------- | ------------ |
| `apps/runtime/src/services/tag-service.ts`                           | TagService class with all business logic | 250          |
| `apps/runtime/src/services/tag-condition-evaluator.ts`               | Pure condition evaluator function        | 80           |
| `apps/studio/src/app/api/projects/[id]/tags/rules/route.ts`          | Proxy: GET/POST for tag rules            | 60           |
| `apps/studio/src/app/api/projects/[id]/tags/rules/[ruleId]/route.ts` | Proxy: PUT/DELETE for tag rules          | 50           |
| `apps/studio/src/app/api/projects/[id]/tags/apply/route.ts`          | Proxy: POST for tag apply                | 40           |
| `apps/studio/src/app/api/projects/[id]/tags/remove/route.ts`         | Proxy: POST for tag remove               | 40           |
| `apps/studio/src/app/api/projects/[id]/tags/stats/route.ts`          | Proxy: GET for tag stats                 | 40           |
| `apps/studio/src/components/tags/TagRulesPage.tsx`                   | Tag rules management settings page       | 200          |
| `apps/studio/src/components/tags/TagRuleDialog.tsx`                  | Create/edit rule dialog with conditions  | 250          |
| `apps/studio/src/components/tags/TagChips.tsx`                       | Inline tag display with add/remove       | 100          |
| `apps/studio/src/components/tags/TagFilter.tsx`                      | Multi-select tag filter for lists        | 80           |
| `apps/runtime/src/__tests__/tag-condition-evaluator.test.ts`         | Unit tests for condition evaluator       | 150          |
| `apps/runtime/src/__tests__/tags-crud-e2e.test.ts`                   | E2E tests for tag rules CRUD             | 200          |
| `apps/runtime/src/__tests__/tags-apply-remove-e2e.test.ts`           | E2E tests for apply/remove               | 180          |
| `apps/runtime/src/__tests__/tags-authz.test.ts`                      | Auth and isolation tests                 | 200          |

### Modified Files

| File                                            | Change Description                                                                 | Risk |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| `apps/runtime/src/routes/tags.ts`               | Refactor to delegate to TagService; add /remove, /bulk-apply, /bulk-remove, /stats | Med  |
| `apps/runtime/src/repos/session.repository.ts`  | Add auto-apply hook in updateStatus()                                              | Low  |
| `packages/database/src/models/session.model.ts` | Add multikey index `{ tenantId, projectId, tags }` (optional, deferred to Phase 4) | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: TagService Extraction + Condition Evaluator

**Goal**: Extract TagService class and condition evaluator as testable modules, replacing inline route handler logic.

**Tasks**:

1.1. Create `apps/runtime/src/services/tag-condition-evaluator.ts` with `evaluateConditions()` pure function supporting all 6 operators (eq, neq, gt, lt, contains, in) and AND/OR logic.

1.2. Create `apps/runtime/src/services/tag-service.ts` with TagService class containing: `listRules()`, `createRule()`, `updateRule()`, `deleteRule()`, `applyTags()` (dual-write: MongoDB $addToSet + ClickHouse INSERT), `removeTags()` (MongoDB $pull + ClickHouse DELETE). Include Zod schemas as exports.

1.3. Add tag cap enforcement in `applyTags()`: before writing, check current tag count + new tags <= 50. Reject with 400 if exceeded.

1.4. Refactor `apps/runtime/src/routes/tags.ts` to delegate all handler logic to TagService. Fix `POST /apply` to dual-write (closes GAP-1). Fix `PUT /rules/:ruleId` to use Zod validation (closes GAP-6).

1.5. Write unit tests for condition evaluator: `apps/runtime/src/__tests__/tag-condition-evaluator.test.ts` covering all operators, AND/OR logic, edge cases (null fields, type mismatches).

**Files Touched**:

- `apps/runtime/src/services/tag-condition-evaluator.ts` -- NEW
- `apps/runtime/src/services/tag-service.ts` -- NEW
- `apps/runtime/src/routes/tags.ts` -- MODIFIED (refactor to delegate)
- `apps/runtime/src/__tests__/tag-condition-evaluator.test.ts` -- NEW

**Exit Criteria**:

- [ ] `tag-condition-evaluator.test.ts` passes with >= 20 test cases covering all 6 operators + AND/OR + edge cases
- [ ] `pnpm build --filter=runtime` succeeds with 0 TypeScript errors
- [ ] Existing tag routes (GET /rules, POST /rules, PUT /rules/:ruleId, DELETE /rules/:ruleId, POST /apply, GET /conversations) still work -- verified by manual curl or existing tests
- [ ] `POST /apply` now writes to both MongoDB `Session.tags` and ClickHouse `conversation_tags`
- [ ] `PUT /rules/:ruleId` rejects invalid fields (e.g., `{ _id: 'injected' }`) with 400

**Test Strategy**:

- Unit: Condition evaluator -- all operators, edge cases, type coercion
- Manual: curl CRUD endpoints against local runtime to verify refactor didn't break behavior

**Rollback**: Revert tag-service.ts and tag-condition-evaluator.ts, restore original tags.ts

---

### Phase 2: New API Endpoints (Remove, Bulk, Stats)

**Goal**: Add the 4 new runtime API endpoints designed in the HLD.

**Tasks**:

2.1. Add `POST /remove` endpoint in `tags.ts` that calls `TagService.removeTags()`. Validate with `tagApplySchema`. Response: `{ success: true, data: { removed: N } }`.

2.2. Add `POST /bulk-apply` endpoint that calls `TagService.bulkApplyTags()`. Validate with `tagBulkSchema`. Response: `{ success: true, data: { applied: N, failed: M, errors: [...] } }`.

2.3. Add `POST /bulk-remove` endpoint that calls `TagService.bulkRemoveTags()`. Validate with `tagBulkSchema`. Same response shape as bulk-apply.

2.4. Add `GET /stats` endpoint that calls `TagService.getStats()`. Query params: `from`, `to` (ISO dates), `limit` (default 50, max 200). Response per HLD stats format.

2.5. Register new routes with OpenAPI schema descriptions using `openapi.route()` pattern.

2.6. Write E2E tests: `apps/runtime/src/__tests__/tags-apply-remove-e2e.test.ts` and `apps/runtime/src/__tests__/tags-crud-e2e.test.ts` covering CRUD lifecycle, apply/remove dual-write, input validation, duplicate prevention.

**Files Touched**:

- `apps/runtime/src/routes/tags.ts` -- MODIFIED (add 4 new route handlers)
- `apps/runtime/src/services/tag-service.ts` -- MODIFIED (add bulkApplyTags, bulkRemoveTags, getStats)
- `apps/runtime/src/__tests__/tags-crud-e2e.test.ts` -- NEW
- `apps/runtime/src/__tests__/tags-apply-remove-e2e.test.ts` -- NEW

**Exit Criteria**:

- [ ] `POST /remove` removes tags from MongoDB Session.tags and ClickHouse conversation_tags
- [ ] `POST /bulk-apply` applies tags to up to 500 sessions with partial failure handling
- [ ] `POST /bulk-remove` removes tags from up to 500 sessions with partial failure handling
- [ ] `GET /stats` returns tag distribution from ClickHouse with correct counts
- [ ] All new endpoints return standard error envelope on invalid input (400)
- [ ] E2E test file `tags-crud-e2e.test.ts` passes with >= 5 test cases
- [ ] E2E test file `tags-apply-remove-e2e.test.ts` passes with >= 5 test cases
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors

**Test Strategy**:

- E2E: Real HTTP requests against runtime on random port, full middleware chain
- E2E: Verify dual-write by querying both MongoDB and ClickHouse (if available)

**Rollback**: Remove new route handlers from tags.ts; service methods are additive

---

### Phase 3: Auth, Isolation & Validation Tests

**Goal**: Comprehensive auth/isolation test coverage for all tag endpoints.

**Tasks**:

3.1. Write `apps/runtime/src/__tests__/tags-authz.test.ts` covering:

- Cross-tenant access returns 404 (not 403) for all CRUD + apply/remove endpoints
- Cross-project access returns 404
- Missing auth returns 401
- Insufficient permissions returns 403 (viewer cannot create rules or apply tags)
- session:read allows GET /rules and GET /conversations
- project:write required for POST/PUT/DELETE /rules
- session:write required for POST /apply, POST /remove, POST /bulk-apply, POST /bulk-remove

  3.2. Write `apps/runtime/src/__tests__/tags-validation-e2e.test.ts` covering:

- Missing tagName rejected with 400
- Empty conditions array rejected
- Non-string tags rejected
- Missing sessionId rejected
- Bulk with > 500 sessionIds rejected
- Tags array with > 50 items rejected
- Invalid operator in conditions rejected

**Files Touched**:

- `apps/runtime/src/__tests__/tags-authz.test.ts` -- NEW
- `apps/runtime/src/__tests__/tags-validation-e2e.test.ts` -- NEW

**Exit Criteria**:

- [ ] `tags-authz.test.ts` passes with >= 10 test cases covering tenant isolation, project isolation, and permission enforcement
- [ ] `tags-validation-e2e.test.ts` passes with >= 7 test cases covering all validation edge cases
- [ ] No existing runtime tests regress: `pnpm test --filter=runtime` passes

**Test Strategy**:

- E2E: Real Express server on random port with mocked auth middleware (following existing `*-authz.test.ts` pattern in the runtime test suite)
- E2E: Test isolation by creating resources under one tenant/project and attempting access from another

**Rollback**: Delete test files (no production code changes in this phase)

---

### Phase 4: Auto-Apply Engine + Session Lifecycle Hook

**Goal**: Implement the auto-apply engine that evaluates tag rules when sessions change status.

**Tasks**:

4.1. Add `evaluateAutoApply(tenantId, projectId, sessionId)` method to TagService:

- Load auto-apply rules: `TagRuleModel.find({ tenantId, projectId, autoApply: true })`
- Load session: `Session.findOne({ _id: sessionId, tenantId })`
- For each rule, call `evaluateConditions(session, rule.conditions, rule.conditionLogic)`
- For matching rules, call `applyTags()` with `appliedBy: 'system'` and `ruleId: rule._id`
- Log: rules evaluated count, matches count, duration_ms
- Catch all errors -- never throw (auto-apply is non-critical)

  4.2. Hook into `SessionRepository.updateStatus()` in `apps/runtime/src/repos/session.repository.ts`:

- After successful status update, call `TagService.evaluateAutoApply()` in a try/catch
- Only trigger for terminal statuses: 'completed', 'ended', 'escalated', 'abandoned'
- Log errors but never let them propagate (session lifecycle must not be blocked)

  4.3. Add optional multikey index `{ tenantId: 1, projectId: 1, tags: 1 }` on sessions collection for tag-based filtering (deferred if index count is a concern).

  4.4. Write integration test `apps/runtime/src/__tests__/tag-auto-apply.integration.test.ts`:

- Create auto-apply rules and test sessions with known field values
- Trigger evaluateAutoApply and verify matching tags are applied
- Verify non-matching sessions are not tagged
- Verify failures are caught and logged

**Files Touched**:

- `apps/runtime/src/services/tag-service.ts` -- MODIFIED (add evaluateAutoApply)
- `apps/runtime/src/repos/session.repository.ts` -- MODIFIED (add hook)
- `packages/database/src/models/session.model.ts` -- MODIFIED (optional: add tags index)
- `apps/runtime/src/__tests__/tag-auto-apply.integration.test.ts` -- NEW

**Exit Criteria**:

- [ ] Auto-apply correctly applies tags to sessions matching rule conditions
- [ ] Auto-apply does not apply tags to sessions that don't match
- [ ] Session lifecycle is never blocked by auto-apply failures
- [ ] `tag-auto-apply.integration.test.ts` passes with >= 5 test cases
- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] Existing session tests are not affected

**Test Strategy**:

- Integration: Real MongoDB with test rules and sessions; verify tag application
- Unit: Condition evaluator already tested in Phase 1

**Rollback**: Remove hook from session.repository.ts; revert evaluateAutoApply method

---

### Phase 5: Studio Proxy Routes

**Goal**: Create Studio Next.js API routes that proxy to runtime tag endpoints.

**Tasks**:

5.1. Create `apps/studio/src/app/api/projects/[id]/tags/rules/route.ts` with GET (list rules) and POST (create rule) handlers. Auth: `requireTenantAuth` + `requireProjectAccess`. Forward to runtime via `apiFetch`.

5.2. Create `apps/studio/src/app/api/projects/[id]/tags/rules/[ruleId]/route.ts` with PUT (update) and DELETE (delete) handlers.

5.3. Create `apps/studio/src/app/api/projects/[id]/tags/apply/route.ts` with POST handler.

5.4. Create `apps/studio/src/app/api/projects/[id]/tags/remove/route.ts` with POST handler.

5.5. Create `apps/studio/src/app/api/projects/[id]/tags/stats/route.ts` with GET handler.

5.6. Verify all proxy routes follow the established pattern (read existing proxy routes like `apps/studio/src/app/api/projects/[id]/settings/route.ts` for reference).

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/tags/rules/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/tags/rules/[ruleId]/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/tags/apply/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/tags/remove/route.ts` -- NEW
- `apps/studio/src/app/api/projects/[id]/tags/stats/route.ts` -- NEW

**Exit Criteria**:

- [ ] All 5 proxy route files created and follow the established Studio proxy pattern
- [ ] Each route includes `requireTenantAuth` and `requireProjectAccess` checks
- [ ] `pnpm build --filter=studio` succeeds with 0 TypeScript errors
- [ ] Manual verification: Studio proxy correctly forwards to runtime (curl or browser)

**Test Strategy**:

- Manual: Verify proxy forwarding with curl against Studio dev server
- Build: TypeScript compilation catches interface mismatches

**Rollback**: Delete Studio proxy route files

---

### Phase 6: Studio UI Components

**Goal**: Build the Studio frontend for tag management.

**Tasks**:

6.1. Create `apps/studio/src/components/tags/TagChips.tsx`: Reusable component that displays tag chips with optional add/remove buttons. Props: `tags: string[]`, `onAdd?: (tag: string) => void`, `onRemove?: (tag: string) => void`, `editable?: boolean`, `colors?: Record<string, string>`.

6.2. Create `apps/studio/src/components/tags/TagFilter.tsx`: Multi-select dropdown for filtering by tags. Props: `availableTags: string[]`, `selectedTags: string[]`, `onChange: (tags: string[]) => void`.

6.3. Create `apps/studio/src/components/tags/TagRuleDialog.tsx`: Dialog for creating/editing tag rules with condition builder UI. Fields: tagName, description, color picker, conditions array with field/operator/value selectors, conditionLogic toggle, autoApply checkbox.

6.4. Create `apps/studio/src/components/tags/TagRulesPage.tsx`: Settings page listing tag rules with create/edit/delete actions. Uses `apiFetch` to call Studio proxy routes. Includes empty state, loading state, and error state.

6.5. Wire TagRulesPage into project settings navigation (find the settings nav component and add "Tags" entry).

6.6. Integrate TagChips into session detail view component.

6.7. Integrate TagFilter into session list filter bar.

6.8. Add i18n keys for all tag-related labels (read `packages/i18n` structure first).

**Files Touched**:

- `apps/studio/src/components/tags/TagChips.tsx` -- NEW
- `apps/studio/src/components/tags/TagFilter.tsx` -- NEW
- `apps/studio/src/components/tags/TagRuleDialog.tsx` -- NEW
- `apps/studio/src/components/tags/TagRulesPage.tsx` -- NEW
- Studio settings nav component -- MODIFIED (add Tags entry)
- Studio session detail component -- MODIFIED (add TagChips)
- Studio session list component -- MODIFIED (add TagFilter)

**Exit Criteria**:

- [ ] TagRulesPage renders tag rules list with create/edit/delete functionality
- [ ] TagRuleDialog correctly submits tag rule with conditions
- [ ] TagChips displays tags and supports inline add/remove
- [ ] TagFilter allows multi-select filtering
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Tags tab visible in project settings navigation
- [ ] Session detail shows tags with add/remove capability

**Test Strategy**:

- Manual: Visual verification in Studio dev environment
- Build: TypeScript compilation

**Rollback**: Remove Studio tag components and revert nav/detail/list integrations

---

### Phase 7: Eval Tags UI + Final Polish

**Goal**: Add tag filtering to eval scenarios and final integration polish.

**Tasks**:

7.1. Add tag filter to eval scenarios list in Studio (integrate TagFilter component into evals page).

7.2. Add tag editor to eval scenario create/edit dialog (integrate TagChips in editable mode).

7.3. Verify `apps/studio/src/app/api/projects/[id]/evals/scenarios/route.ts` already handles tags field in create/list (confirmed: Zod schema includes `tags: z.array(z.string())` -- no changes needed).

7.4. Add `?tag=` query parameter support to eval scenarios GET endpoint if not already present.

7.5. Write E2E test `apps/runtime/src/__tests__/tags-eval-filtering-e2e.test.ts` verifying eval scenario tag filtering via API.

7.6. Update feature spec status from PLANNED to ALPHA.

7.7. Update test spec with actual test results and coverage.

**Files Touched**:

- Studio evals page component -- MODIFIED (add TagFilter)
- Studio eval scenario dialog -- MODIFIED (add TagChips)
- `apps/studio/src/app/api/projects/[id]/evals/scenarios/route.ts` -- MODIFIED (if tag query param needed)
- `apps/runtime/src/__tests__/tags-eval-filtering-e2e.test.ts` -- NEW
- `docs/features/tags.md` -- MODIFIED (status update)
- `docs/testing/tags.md` -- MODIFIED (coverage update)

**Exit Criteria**:

- [ ] Eval scenarios can be filtered by tags in Studio
- [ ] Eval scenario create/edit dialog supports tag editing
- [ ] `tags-eval-filtering-e2e.test.ts` passes with >= 3 test cases
- [ ] `pnpm build` succeeds across all affected packages
- [ ] Feature spec status updated to ALPHA
- [ ] All 7 GAPs from the feature spec are addressed

**Test Strategy**:

- E2E: HTTP API tests for eval scenario tag filtering
- Manual: Visual verification in Studio

**Rollback**: Revert eval component changes

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `tag-service.ts` imported and instantiated in `tags.ts` route file
- [ ] `tag-condition-evaluator.ts` imported in `tag-service.ts`
- [ ] New endpoints (`/remove`, `/bulk-apply`, `/bulk-remove`, `/stats`) registered via `openapi.route()` in `tags.ts`
- [ ] Auto-apply hook added to `SessionRepository.updateStatus()` calling `TagService.evaluateAutoApply()`
- [ ] Studio proxy routes created in correct Next.js `app/api/` directory structure
- [ ] `TagRulesPage` imported and rendered in project settings page/navigation
- [ ] `TagChips` imported and rendered in session detail view component
- [ ] `TagFilter` imported and rendered in session list filter component
- [ ] `TagFilter` imported and rendered in eval scenarios list component
- [ ] `TagChips` imported and rendered in eval scenario create/edit dialog
- [ ] i18n keys added to the appropriate locale files
- [ ] Zod schemas exported from `tag-service.ts` for reuse

---

## 5. Cross-Phase Concerns

### Database Migrations

No migrations required. All MongoDB models and ClickHouse tables already exist. Optional tags multikey index on sessions is added programmatically in Phase 4 (can be deferred).

### Feature Flags

| Flag                     | Default | Purpose                          | Phase |
| ------------------------ | ------- | -------------------------------- | ----- |
| `tags.autoApply.enabled` | `true`  | Enable/disable auto-apply engine | 4     |

### Configuration Changes

| Config                     | Default | Type   | Purpose                                |
| -------------------------- | ------- | ------ | -------------------------------------- |
| `tags.maxPerSession`       | 50      | number | Maximum tags allowed per session       |
| `tags.maxRulesPerProject`  | 100     | number | Maximum tag rules per project          |
| `tags.autoApply.enabled`   | true    | bool   | Enable/disable auto-apply evaluation   |
| `tags.autoApply.batchSize` | 100     | number | Sessions per auto-apply backfill batch |
| `tags.bulk.maxSessionIds`  | 500     | number | Max session IDs in bulk operations     |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 7 phases complete with exit criteria met
- [ ] E2E tests from test spec passing: tags-crud-e2e, tags-apply-remove-e2e, tags-authz, tags-validation-e2e, tags-eval-filtering-e2e
- [ ] Integration tests passing: tag-auto-apply.integration
- [ ] Unit tests passing: tag-condition-evaluator
- [ ] No regressions in existing tests: `pnpm build && pnpm test` passes
- [ ] GAP-1 closed: POST /apply dual-writes to MongoDB + ClickHouse
- [ ] GAP-2 closed: POST /remove endpoint exists and works
- [ ] GAP-3 closed: Auto-apply engine evaluates rules on session lifecycle events
- [ ] GAP-4 closed: Studio UI for tag rule management exists
- [ ] GAP-6 closed: PUT /rules/:ruleId validates request body via Zod
- [ ] GAP-7 closed: Tag count per session capped at 50
- [ ] Feature spec status updated to ALPHA
- [ ] Testing spec updated with actual coverage results

---

## 7. Open Questions

| #   | Question                                                                                         | Status  |
| --- | ------------------------------------------------------------------------------------------------ | ------- |
| 1   | Should multikey index on sessions.tags be added in Phase 4 or deferred?                          | OPEN    |
| 2   | Where exactly in the Studio settings nav should "Tags" appear (order relative to other tabs)?    | OPEN    |
| 3   | Should the Studio session detail view show tags from MongoDB or query ClickHouse?                | DECIDED |
|     | _Decision: Read from MongoDB Session.tags (source of truth). ClickHouse is for analytics only._  |         |
| 4   | Should auto-apply evaluate on session creation (status='active') in addition to terminal states? | OPEN    |

---

## 8. FR Traceability Matrix

| FR    | Description                   | Phase(s) | Tasks            |
| ----- | ----------------------------- | -------- | ---------------- |
| FR-1  | Tag rules CRUD API            | 1, 2     | 1.2, 1.4         |
| FR-2  | Unique tag names per project  | 1        | 1.2              |
| FR-3  | Apply tags (dual-write)       | 1        | 1.2, 1.4         |
| FR-4  | Remove tags (dual-write)      | 2        | 2.1              |
| FR-5  | Tag distribution analytics    | 2        | 2.4              |
| FR-6  | Bulk tag apply/remove         | 2        | 2.2, 2.3         |
| FR-7  | Auto-apply engine             | 4        | 4.1, 4.2         |
| FR-8  | Studio tag rules UI           | 5, 6     | 5.1-5.5, 6.3-6.5 |
| FR-9  | Session detail tag management | 6        | 6.1, 6.6         |
| FR-10 | Session list tag filtering    | 6        | 6.2, 6.7         |
| FR-11 | Eval scenario tag filtering   | 7        | 7.1-7.4          |
| FR-12 | Tenant + project isolation    | 1, 3     | 1.4, 3.1         |
| FR-13 | Condition operators           | 1        | 1.1              |
| FR-14 | Session field evaluation      | 1, 4     | 1.1, 4.1         |
