# Test Specification: Tags & Eval Tags

**Feature Spec**: `docs/features/tags.md`
**HLD**: `docs/specs/tags.hld.md` (planned)
**LLD**: `docs/plans/2026-03-23-tags-impl-plan.md` (planned)
**Status**: PLANNED
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR    | Description                          | Unit    | Integration | E2E     | Manual  | Status      |
| ----- | ------------------------------------ | ------- | ----------- | ------- | ------- | ----------- |
| FR-1  | Tag rules CRUD API                   | PLANNED | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-2  | Unique tag names per project         | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-3  | Apply tags (MongoDB + ClickHouse)    | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-4  | Remove tags (MongoDB + ClickHouse)   | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-5  | Tag distribution analytics           | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-6  | Bulk tag apply/remove                | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-7  | Auto-apply engine                    | PLANNED | PLANNED     | -       | PLANNED | NOT STARTED |
| FR-8  | Studio tag rules UI                  | -       | -           | -       | PLANNED | NOT STARTED |
| FR-9  | Session detail tag management        | -       | -           | -       | PLANNED | NOT STARTED |
| FR-10 | Session list tag filtering           | -       | -           | -       | PLANNED | NOT STARTED |
| FR-11 | Eval scenario tag filtering          | -       | -           | PLANNED | PLANNED | NOT STARTED |
| FR-12 | Tenant + project isolation           | -       | PLANNED     | PLANNED | -       | NOT STARTED |
| FR-13 | Condition operators (eq/neq/gt/etc.) | PLANNED | -           | -       | -       | NOT STARTED |
| FR-14 | Session field evaluation             | PLANNED | PLANNED     | -       | -       | NOT STARTED |

---

## 2. E2E Test Scenarios

> CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Start Express on random ports with full middleware chain.

### E2E-1: Tag Rules CRUD Full Lifecycle

- **Preconditions**: Runtime server started on random port. Test tenant and project seeded via `POST /api/auth/register` and `POST /api/projects`. User has `project:write` permission.
- **Auth Context**: JWT token with `{ tenantId: 'test-tenant-1', userId: 'user-1' }`, project member with admin role.
- **Steps**:
  1. `POST /api/projects/:projectId/tags/rules` with body:
     ```json
     {
       "tagName": "escalated-voice",
       "description": "Voice calls that were escalated",
       "color": "#FF5733",
       "conditions": [
         { "field": "channel", "operator": "eq", "value": "voice" },
         { "field": "outcome", "operator": "eq", "value": "escalated" }
       ],
       "conditionLogic": "AND",
       "autoApply": true
     }
     ```
     Assert: 200 OK, response body `{ success: true, data: { _id, tagName: 'escalated-voice', ... } }`
  2. `GET /api/projects/:projectId/tags/rules`
     Assert: 200 OK, array contains the rule from step 1 with matching `_id` and all fields correct
  3. `PUT /api/projects/:projectId/tags/rules/:ruleId` with body `{ description: 'Updated description', autoApply: false }`
     Assert: 200 OK, `data.description === 'Updated description'`, `data.autoApply === false`
  4. `GET /api/projects/:projectId/tags/rules` again
     Assert: Updated fields persisted
  5. `DELETE /api/projects/:projectId/tags/rules/:ruleId`
     Assert: 200 OK, `{ success: true }`
  6. `GET /api/projects/:projectId/tags/rules`
     Assert: Array does not contain the deleted rule
- **Expected Result**: Complete CRUD lifecycle succeeds with correct data at each step
- **Isolation Check**: Rule queries include `tenantId` and `projectId` in filter

### E2E-2: Manual Tag Apply and Remove with Dual-Write Verification

- **Preconditions**: Runtime server with MongoDB and ClickHouse connections. Test session created via session creation API.
- **Auth Context**: JWT with `session:write` permission for the project.
- **Steps**:
  1. `POST /api/projects/:projectId/tags/apply` with body:
     ```json
     {
       "sessionId": "<test-session-id>",
       "tags": ["vip", "priority", "needs-review"]
     }
     ```
     Assert: 200 OK, `{ success: true, data: { applied: 3 } }`
  2. `GET /api/projects/:projectId/tags/conversations?tag=vip`
     Assert: 200 OK, response contains the test session ID
  3. `GET /api/projects/:projectId/tags/conversations?tag=priority`
     Assert: 200 OK, response contains the test session ID
  4. `POST /api/projects/:projectId/tags/remove` with body:
     ```json
     {
       "sessionId": "<test-session-id>",
       "tags": ["vip"]
     }
     ```
     Assert: 200 OK
  5. `GET /api/projects/:projectId/tags/conversations?tag=vip`
     Assert: Session no longer appears in results
  6. `GET /api/projects/:projectId/tags/conversations?tag=priority`
     Assert: Session still appears (only 'vip' was removed)
- **Expected Result**: Tags applied to both MongoDB and ClickHouse, removed correctly, non-removed tags preserved
- **Isolation Check**: ClickHouse queries parameterized with `tenant_id` and `project_id`

### E2E-3: Cross-Tenant Isolation Returns 404

- **Preconditions**: Two test tenants (tenant-A, tenant-B) each with their own project. Tenant-A has a tag rule.
- **Auth Context**: Separate JWT tokens for each tenant.
- **Steps**:
  1. As tenant-A: `POST /api/projects/:projectIdA/tags/rules` -- create rule, capture `ruleId`
  2. As tenant-B: `GET /api/projects/:projectIdA/tags/rules/:ruleId` using tenant-B's JWT but tenant-A's projectId
     Assert: 404 (not 403) -- tenant isolation enforced
  3. As tenant-B: `PUT /api/projects/:projectIdA/tags/rules/:ruleId` with `{ description: 'hacked' }`
     Assert: 404 (not 403)
  4. As tenant-B: `DELETE /api/projects/:projectIdA/tags/rules/:ruleId`
     Assert: 404 (not 403)
  5. As tenant-A: `GET /api/projects/:projectIdA/tags/rules` -- verify rule is unmodified
- **Expected Result**: Cross-tenant access returns 404 for all operations, data integrity preserved
- **Isolation Check**: Response must be 404, never 403 (to avoid leaking resource existence)

### E2E-4: Cross-Project Isolation for Tag Rules

- **Preconditions**: Single tenant with two projects (project-A, project-B). Tag rule created in project-A.
- **Auth Context**: JWT with admin role in both projects.
- **Steps**:
  1. As tenant: `POST /api/projects/:projectIdA/tags/rules` -- create rule in project-A, capture `ruleId`
  2. `GET /api/projects/:projectIdB/tags/rules/:ruleId` -- access via project-B's route
     Assert: 404 (rule belongs to project-A, not project-B)
  3. `PUT /api/projects/:projectIdB/tags/rules/:ruleId` with `{ description: 'cross-project' }`
     Assert: 404
  4. `DELETE /api/projects/:projectIdB/tags/rules/:ruleId`
     Assert: 404
  5. `GET /api/projects/:projectIdA/tags/rules` -- verify rule is unmodified
  6. `GET /api/projects/:projectIdB/tags/rules` -- verify no rules exist
     Assert: 200 OK, empty array
- **Expected Result**: Tag rules are strictly project-scoped
- **Isolation Check**: `findOneAndUpdate({ _id, tenantId, projectId })` prevents cross-project access

### E2E-5: Bulk Tag Apply and Remove Across Multiple Sessions

- **Preconditions**: Three test sessions created in the same project.
- **Auth Context**: JWT with `session:write` permission.
- **Steps**:
  1. `POST /api/projects/:projectId/tags/bulk-apply` with body:
     ```json
     {
       "sessionIds": ["<session-1>", "<session-2>", "<session-3>"],
       "tags": ["batch-processed", "wave-1"]
     }
     ```
     Assert: 200 OK, `{ success: true, data: { applied: 6 } }` (3 sessions x 2 tags)
  2. `GET /api/projects/:projectId/tags/conversations?tag=batch-processed`
     Assert: All three session IDs appear in results
  3. `POST /api/projects/:projectId/tags/bulk-remove` with body:
     ```json
     {
       "sessionIds": ["<session-1>", "<session-3>"],
       "tags": ["batch-processed"]
     }
     ```
     Assert: 200 OK
  4. `GET /api/projects/:projectId/tags/conversations?tag=batch-processed`
     Assert: Only session-2 appears (session-1 and session-3 were removed)
  5. `GET /api/projects/:projectId/tags/conversations?tag=wave-1`
     Assert: All three sessions still have 'wave-1' tag (only 'batch-processed' was removed)
- **Expected Result**: Bulk operations correctly apply/remove across multiple sessions without affecting other tags

### E2E-6: Tag Distribution Statistics

- **Preconditions**: Multiple sessions with various tags applied via prior test setup.
- **Auth Context**: JWT with `session:read` permission.
- **Steps**:
  1. Apply tags to set up known distribution:
     - Session-1: tags ['vip', 'resolved']
     - Session-2: tags ['vip', 'escalated']
     - Session-3: tags ['escalated', 'needs-review']
  2. `GET /api/projects/:projectId/tags/stats`
     Assert: 200 OK, response contains:
     ```json
     {
       "success": true,
       "data": [
         { "tag_name": "vip", "count": 2 },
         { "tag_name": "escalated", "count": 2 },
         { "tag_name": "resolved", "count": 1 },
         { "tag_name": "needs-review", "count": 1 }
       ]
     }
     ```
  3. Verify ordering is by count descending
- **Expected Result**: Stats endpoint returns accurate tag distribution from ClickHouse
- **Isolation Check**: Stats query is scoped to `tenant_id` and `project_id`

### E2E-7: Duplicate Tag Rule Prevention (Unique Constraint)

- **Preconditions**: Runtime server started.
- **Auth Context**: JWT with `project:write` permission.
- **Steps**:
  1. `POST /api/projects/:projectId/tags/rules` with `{ tagName: 'vip', conditions: [{ field: 'status', operator: 'eq', value: 'escalated' }], conditionLogic: 'AND' }`
     Assert: 200 OK (created)
  2. `POST /api/projects/:projectId/tags/rules` with `{ tagName: 'vip', conditions: [{ field: 'channel', operator: 'eq', value: 'voice' }], conditionLogic: 'AND' }` (same tagName, different conditions)
     Assert: 409 Conflict or 400 Bad Request with error code indicating duplicate tagName
  3. `GET /api/projects/:projectId/tags/rules`
     Assert: Only one rule with tagName 'vip' exists
- **Expected Result**: MongoDB unique index on `{tenantId, projectId, tagName}` prevents duplicates

### E2E-8: Input Validation Rejects Malformed Data

- **Preconditions**: Runtime server started.
- **Auth Context**: JWT with `project:write` permission.
- **Steps**:
  1. `POST /api/projects/:projectId/tags/rules` with missing `tagName`:
     ```json
     { "conditions": [{ "field": "status", "operator": "eq", "value": "active" }] }
     ```
     Assert: 400 Bad Request, `{ success: false, error: { code: 'INVALID_INPUT' } }`
  2. `POST /api/projects/:projectId/tags/rules` with empty conditions array:
     ```json
     { "tagName": "test", "conditions": [] }
     ```
     Assert: 400 Bad Request
  3. `POST /api/projects/:projectId/tags/rules` with invalid operator:
     ```json
     {
       "tagName": "test",
       "conditions": [{ "field": "status", "operator": "regex", "value": ".*" }]
     }
     ```
     Assert: 400 Bad Request (if validation exists) or accepted (gap -- GAP-6 noted)
  4. `POST /api/projects/:projectId/tags/apply` with missing `sessionId`:
     ```json
     { "tags": ["vip"] }
     ```
     Assert: 400 Bad Request
  5. `POST /api/projects/:projectId/tags/apply` with non-string tags:
     ```json
     { "sessionId": "abc", "tags": [123, null] }
     ```
     Assert: 400 Bad Request
- **Expected Result**: All invalid payloads rejected with appropriate error codes

### E2E-9: Permission Enforcement on Tag Operations

- **Preconditions**: Two users -- admin (project:write + session:write) and viewer (session:read only).
- **Auth Context**: Separate JWT tokens for each role.
- **Steps**:
  1. As viewer: `POST /api/projects/:projectId/tags/rules` -- attempt to create rule
     Assert: 403 Forbidden (viewer lacks project:write)
  2. As viewer: `GET /api/projects/:projectId/tags/rules` -- attempt to list rules
     Assert: 200 OK (viewer has session:read)
  3. As viewer: `POST /api/projects/:projectId/tags/apply` -- attempt to apply tags
     Assert: 403 Forbidden (viewer lacks session:write)
  4. As viewer: `GET /api/projects/:projectId/tags/conversations?tag=vip` -- query by tag
     Assert: 200 OK (viewer has session:read)
  5. As admin: All operations succeed with 200 OK
- **Expected Result**: RBAC permissions enforced correctly per endpoint

### E2E-10: Eval Scenario Tag Filtering via Studio API

- **Preconditions**: Multiple eval scenarios with different tags.
- **Auth Context**: JWT with project access.
- **Steps**:
  1. `POST /api/projects/:id/evals/scenarios` with `{ name: 'Scenario A', tags: ['regression', 'voice'], ... }`
  2. `POST /api/projects/:id/evals/scenarios` with `{ name: 'Scenario B', tags: ['smoke', 'voice'], ... }`
  3. `POST /api/projects/:id/evals/scenarios` with `{ name: 'Scenario C', tags: ['regression', 'web'], ... }`
  4. `GET /api/projects/:id/evals/scenarios?tag=regression`
     Assert: Returns Scenario A and Scenario C
  5. `GET /api/projects/:id/evals/scenarios?tag=voice`
     Assert: Returns Scenario A and Scenario B
  6. `GET /api/projects/:id/evals/scenarios?tag=nonexistent`
     Assert: Returns empty array
- **Expected Result**: Eval scenarios filterable by tags via API

---

## 3. Integration Test Scenarios

> Integration tests verify service boundary interactions with real services (MongoDB, ClickHouse). Only external third-party services may be mocked via dependency injection.

### INT-1: Tag Rule Condition Evaluator -- All Operators

- **Boundary**: Condition evaluator logic against session field values
- **Setup**: In-memory session object with known field values:
  ```json
  {
    "status": "escalated",
    "channel": "voice",
    "messageCount": 15,
    "tokenCount": 2000,
    "isTest": false,
    "outcome": "escalated",
    "currentAgent": "support-bot"
  }
  ```
- **Steps**:
  1. Evaluate condition `{ field: 'channel', operator: 'eq', value: 'voice' }` -- expect true
  2. Evaluate condition `{ field: 'channel', operator: 'neq', value: 'web' }` -- expect true
  3. Evaluate condition `{ field: 'messageCount', operator: 'gt', value: 10 }` -- expect true
  4. Evaluate condition `{ field: 'messageCount', operator: 'lt', value: 10 }` -- expect false
  5. Evaluate condition `{ field: 'currentAgent', operator: 'contains', value: 'support' }` -- expect true
  6. Evaluate condition `{ field: 'channel', operator: 'in', value: ['voice', 'sms'] }` -- expect true
  7. Evaluate condition `{ field: 'channel', operator: 'in', value: ['web', 'sms'] }` -- expect false
  8. Evaluate AND logic: conditions [eq voice, gt 10 messageCount] -- expect true
  9. Evaluate OR logic: conditions [eq web, gt 10 messageCount] -- expect true (second matches)
  10. Evaluate AND logic: conditions [eq web, gt 10 messageCount] -- expect false (first fails)
- **Expected Result**: All operators evaluate correctly against session fields
- **Failure Mode**: Invalid operator throws descriptive error, unknown field returns false

### INT-2: Dual-Write Consistency (MongoDB + ClickHouse)

- **Boundary**: Tag apply service writing to both MongoDB Session.tags and ClickHouse conversation_tags
- **Setup**: Real MongoDB with test session document, real ClickHouse with conversation_tags table
- **Steps**:
  1. Call tag apply service with `{ sessionId, tags: ['test-tag'], tenantId, projectId, userId }`
  2. Query MongoDB `Session.findOne({ _id: sessionId, tenantId })` -- verify `tags` includes 'test-tag'
  3. Query ClickHouse `SELECT * FROM conversation_tags WHERE session_id = ? AND tag_name = 'test-tag'`
     Verify: row exists with correct `tenant_id`, `project_id`, `applied_by`, `rule_id = 'manual'`
  4. Call tag remove service with same session and tag
  5. Query MongoDB -- verify 'test-tag' removed from `tags` array
  6. Query ClickHouse -- verify row removed or marked as removed
- **Expected Result**: Both stores consistent after apply and remove operations
- **Failure Mode**: If ClickHouse write fails, MongoDB write should be rolled back (or logged for retry)

### INT-3: Auto-Apply Engine Rule Matching

- **Boundary**: Auto-apply service evaluating rules against session data
- **Setup**: Real MongoDB with:
  - TagRule: `{ tagName: 'voice-escalation', conditions: [{ field: 'channel', operator: 'eq', value: 'voice' }, { field: 'outcome', operator: 'eq', value: 'escalated' }], conditionLogic: 'AND', autoApply: true }`
  - TagRule: `{ tagName: 'high-volume', conditions: [{ field: 'messageCount', operator: 'gt', value: 20 }], conditionLogic: 'AND', autoApply: true }`
  - Session A: `{ channel: 'voice', outcome: 'escalated', messageCount: 5 }` -- matches rule 1 only
  - Session B: `{ channel: 'web', outcome: 'contained', messageCount: 25 }` -- matches rule 2 only
  - Session C: `{ channel: 'voice', outcome: 'escalated', messageCount: 30 }` -- matches both rules
  - Session D: `{ channel: 'web', outcome: 'contained', messageCount: 5 }` -- matches neither
- **Steps**:
  1. Run auto-apply engine for the project
  2. Verify Session A has tag 'voice-escalation' only
  3. Verify Session B has tag 'high-volume' only
  4. Verify Session C has tags ['voice-escalation', 'high-volume']
  5. Verify Session D has no tags
- **Expected Result**: Rules correctly match sessions based on conditions and logic
- **Failure Mode**: Engine logs errors but does not crash on individual session failures

### INT-4: ClickHouse Tag Distribution Aggregation

- **Boundary**: ClickHouse query for tag stats
- **Setup**: Insert known data into ClickHouse conversation_tags:
  - 10 rows with tag_name = 'vip'
  - 7 rows with tag_name = 'escalated'
  - 3 rows with tag_name = 'needs-review'
    All scoped to same tenant_id and project_id
- **Steps**:
  1. Execute the stats aggregation query: `SELECT tag_name, count() AS cnt FROM conversation_tags WHERE tenant_id = ? AND project_id = ? GROUP BY tag_name ORDER BY cnt DESC`
  2. Verify results: [{ tag_name: 'vip', cnt: 10 }, { tag_name: 'escalated', cnt: 7 }, { tag_name: 'needs-review', cnt: 3 }]
  3. Insert 5 rows with different `project_id` but same `tenant_id` and tag_name = 'vip'
  4. Re-run query for original project
  5. Verify count for 'vip' is still 10 (not 15 -- project isolation in ClickHouse)
- **Expected Result**: Aggregation returns correct counts, project-scoped
- **Failure Mode**: ClickHouse query timeout handled gracefully (existing SETTINGS max_execution_time = 10)

### INT-5: Session Lifecycle Hook Triggers Auto-Apply

- **Boundary**: Session status change event triggers auto-apply evaluation
- **Setup**: Real MongoDB with auto-apply tag rule: `{ tagName: 'completed-conversation', conditions: [{ field: 'status', operator: 'eq', value: 'completed' }], autoApply: true }`
- **Steps**:
  1. Create session with status 'active' -- verify no tag applied
  2. Update session status to 'completed' via session lifecycle service
  3. Verify auto-apply engine was triggered (or event was emitted)
  4. Verify session now has tag 'completed-conversation'
  5. Verify ClickHouse row exists with `rule_id` set to the tag rule's `_id`
- **Expected Result**: Status change triggers rule evaluation and tag application
- **Failure Mode**: If auto-apply fails, session lifecycle is not blocked

### INT-6: Bulk Operations with Partial Failures

- **Boundary**: Bulk apply service handling mixed valid/invalid session IDs
- **Setup**: Real MongoDB with 3 valid sessions and 2 invalid session IDs
- **Steps**:
  1. Call bulk apply with `{ sessionIds: [valid1, valid2, invalid1, valid3, invalid2], tags: ['bulk-tag'] }`
  2. Verify valid sessions (valid1, valid2, valid3) have the tag applied
  3. Verify response includes information about which sessions succeeded and which failed
  4. Verify ClickHouse has 3 rows (one per valid session)
- **Expected Result**: Partial success -- valid sessions tagged, invalid sessions reported as errors
- **Failure Mode**: Entire batch does not fail because of individual session errors

### INT-7: Tag Rule Update Does Not Retroactively Change Tags

- **Boundary**: Tag rule update vs existing tagged sessions
- **Setup**: Rule 'vip' with condition `{ channel: 'voice' }`, auto-applied to 5 voice sessions
- **Steps**:
  1. Verify 5 sessions have tag 'vip'
  2. Update rule condition to `{ channel: 'web' }` (voice sessions no longer match)
  3. Verify the 5 voice sessions still have tag 'vip' (tags are not retroactively removed)
  4. Create a new voice session -- verify it does NOT get 'vip' tag (old condition no longer matches)
  5. Create a new web session -- verify it DOES get 'vip' tag (new condition matches)
- **Expected Result**: Rule updates affect future evaluations only, not retroactive
- **Failure Mode**: N/A -- this is expected behavior

---

## 4. Unit Test Scenarios

### UT-1: Condition Evaluator -- Edge Cases

- **Module**: `tag-auto-apply.ts` condition evaluator function
- **Input/Expected**:
  - Null field value with `eq` operator: returns false (not crash)
  - Undefined field with `contains` operator: returns false
  - Non-numeric field with `gt` operator: returns false
  - Empty string with `contains ''`: returns true
  - Array value with `in` operator where value is not an array: returns false with warning

### UT-2: Tag Name Normalization

- **Module**: Tag name validation utility
- **Input/Expected**:
  - `'  VIP  '` -> trimmed to `'VIP'`
  - `'tag with spaces'` -> accepted as-is (spaces allowed in tag names)
  - `''` (empty string) -> rejected
  - String longer than 100 chars -> rejected (EVAL_TAG_MAX_LENGTH)
  - `null` or `undefined` -> rejected

### UT-3: Zod Validation Schemas

- **Module**: Request body validation for tag endpoints
- **Input/Expected**:
  - Valid create rule body: passes
  - Missing required fields (tagName, conditions): fails with specific error path
  - Invalid operator in conditions: fails
  - conditionLogic not 'AND'/'OR': fails
  - tags array with non-string elements: fails
  - sessionId as empty string: fails

### UT-4: Tag Stats Query Builder

- **Module**: ClickHouse query builder for tag stats
- **Input/Expected**:
  - Basic stats query includes `tenant_id` and `project_id` filters
  - Time range filter correctly generates `applied_at BETWEEN` clause
  - Limit parameter is bounded (max 200)
  - Query uses parameterized placeholders (not string interpolation)

---

## 5. Security & Isolation Tests

### Tenant Isolation

- [x] Design: All tag rule queries filter by `{ tenantId, projectId }` (verified in `tags.ts`)
- [ ] E2E: Cross-tenant GET returns 404 (E2E-3)
- [ ] E2E: Cross-tenant PUT returns 404 (E2E-3)
- [ ] E2E: Cross-tenant DELETE returns 404 (E2E-3)
- [ ] E2E: Cross-tenant tag apply returns 404 or fails validation

### Project Isolation

- [x] Design: Unique index on `{ tenantId, projectId, tagName }` (verified in TagRuleModel)
- [ ] E2E: Cross-project GET returns 404 (E2E-4)
- [ ] E2E: Cross-project PUT returns 404 (E2E-4)
- [ ] E2E: Cross-project DELETE returns 404 (E2E-4)

### Auth & Permissions

- [ ] E2E: Missing auth returns 401 (E2E-9 prerequisite)
- [ ] E2E: Insufficient permissions returns 403 (E2E-9)
- [ ] E2E: session:read allows GET /rules and GET /conversations
- [ ] E2E: project:write required for POST/PUT/DELETE /rules
- [ ] E2E: session:write required for POST /apply and POST /remove

### Input Validation

- [ ] E2E: Missing tagName rejected (E2E-8)
- [ ] E2E: Empty conditions array rejected (E2E-8)
- [ ] E2E: Invalid operator in conditions (E2E-8, GAP-6 pending)
- [ ] E2E: Non-string tags rejected (E2E-8)
- [ ] E2E: Missing sessionId rejected (E2E-8)

### ClickHouse Injection Prevention

- [ ] Integration: Parameterized queries prevent SQL injection in tag_name
- [ ] Integration: Parameterized queries prevent injection in tenant_id/project_id

---

## 6. Performance & Load Tests

### PERF-1: Tag Rules List Latency

- **Setup**: Project with 100 tag rules (max expected)
- **Target**: GET /rules p99 < 200ms
- **Measurement**: 100 sequential requests, measure p50/p95/p99

### PERF-2: Tag Apply Throughput

- **Setup**: 50 concurrent tag apply requests to different sessions
- **Target**: All complete within 5s, no errors
- **Measurement**: Concurrent HTTP requests via test framework

### PERF-3: ClickHouse Stats Query at Scale

- **Setup**: 1M rows in conversation_tags for the test tenant
- **Target**: GET /stats p99 < 2s
- **Measurement**: ClickHouse query_log analysis

### PERF-4: Bulk Apply with Max Batch Size

- **Setup**: 500 sessions in a single bulk-apply request
- **Target**: Complete within 10s, all sessions tagged
- **Measurement**: Single request timing + verification query

---

## 7. Test Infrastructure

### Required Services

| Service    | Purpose                                  | Port     |
| ---------- | ---------------------------------------- | -------- |
| MongoDB    | Tag rules, sessions, eval scenarios      | 27017    |
| ClickHouse | conversation_tags analytics table        | 8123     |
| Runtime    | Tags API routes under test (random port) | 0 (auto) |

### Data Seeding

For E2E tests, seed data via HTTP API calls (not direct DB access):

1. **Tenant + User**: `POST /api/auth/register` or test auth helper
2. **Project**: `POST /api/projects` with tenant auth
3. **Sessions**: Create via session creation API or test chat endpoint
4. **Tag Rules**: `POST /api/projects/:projectId/tags/rules`

For integration tests, use MongoMemoryServer and test ClickHouse instance.

### Environment Variables

```bash
MONGODB_URI=mongodb://localhost:27017/abl-tags-test
CLICKHOUSE_URL=http://localhost:8123
ENCRYPTION_MASTER_KEY=test-key-32-bytes-long-for-test!!
```

### CI Configuration

- Tests run in the existing `pnpm test` pipeline
- ClickHouse integration tests may need `CLICKHOUSE_URL` in CI environment
- E2E tests start server on `{ port: 0 }` for random port assignment
- Tests use vitest with `--pool forks` for isolation

---

## 8. Test File Mapping

| Test File                                                              | Type        | Covers                   |
| ---------------------------------------------------------------------- | ----------- | ------------------------ |
| `apps/runtime/src/__tests__/tags-crud-e2e.test.ts`                     | E2E         | FR-1, FR-2, FR-12, FR-13 |
| `apps/runtime/src/__tests__/tags-apply-remove-e2e.test.ts`             | E2E         | FR-3, FR-4               |
| `apps/runtime/src/__tests__/tags-bulk-e2e.test.ts`                     | E2E         | FR-6                     |
| `apps/runtime/src/__tests__/tags-stats-e2e.test.ts`                    | E2E         | FR-5                     |
| `apps/runtime/src/__tests__/tags-authz.test.ts`                        | E2E         | FR-12 (isolation + auth) |
| `apps/runtime/src/__tests__/tags-validation-e2e.test.ts`               | E2E         | FR-1 (input validation)  |
| `apps/runtime/src/__tests__/tags-eval-filtering-e2e.test.ts`           | E2E         | FR-11                    |
| `apps/runtime/src/__tests__/tag-condition-evaluator.test.ts`           | Unit        | FR-13, FR-14             |
| `apps/runtime/src/__tests__/tag-auto-apply.integration.test.ts`        | Integration | FR-7, FR-14              |
| `apps/runtime/src/__tests__/tags-dual-write.integration.test.ts`       | Integration | FR-3, FR-4               |
| `apps/runtime/src/__tests__/tags-clickhouse-stats.integration.test.ts` | Integration | FR-5                     |
| `apps/runtime/src/__tests__/tags-bulk-partial.integration.test.ts`     | Integration | FR-6                     |
| `apps/runtime/src/__tests__/tags-lifecycle-hook.integration.test.ts`   | Integration | FR-7                     |

---

## 9. Open Testing Questions

| #   | Question                                                                                                                           | Status |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Does the CI environment have ClickHouse available for integration tests? If not, ClickHouse-dependent tests need a skip condition. | OPEN   |
| 2   | Should E2E tests for Studio proxy routes be in the Studio test suite or runtime test suite?                                        | OPEN   |
| 3   | How to seed test sessions for tag E2E tests without depending on the full chat execution pipeline?                                 | OPEN   |
| 4   | Should auto-apply integration tests use a real timer/event hook or simulate the trigger directly?                                  | OPEN   |
| 5   | What is the ClickHouse merge delay for ReplacingMergeTree -- do tests need FINAL keyword in SELECT queries?                        | OPEN   |

---

## Iteration Log

_No iterations yet. Testing will begin when implementation starts._
