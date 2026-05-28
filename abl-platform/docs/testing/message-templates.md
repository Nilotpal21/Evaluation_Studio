# Test Spec: Message Templates

**Status**: ALPHA
**Created**: 2026-03-23
**Last Updated**: 2026-03-26
**Feature Spec**: `docs/features/message-templates.md`

---

## 1. Test Strategy

The message-templates feature spans four layers: database/model, API routes, runtime resolution, and Studio UI. Testing strategy follows the platform's test pyramid with emphasis on E2E and integration tests per SDLC requirements.

| Layer                       | Test Type          | Focus                                                     | Count |
| --------------------------- | ------------------ | --------------------------------------------------------- | ----- |
| Database model + repository | Integration        | CRUD, uniqueness, version management, tenant isolation    | 8     |
| API routes                  | E2E                | Full HTTP lifecycle through auth + middleware chain       | 10    |
| Runtime template resolver   | Integration        | Channel-format selection, variable interpolation, caching | 7     |
| Compiler integration        | Unit + Integration | DSL-to-library sync, template ref resolution              | 5     |
| Studio UI                   | E2E (browser)      | Template manager CRUD, editor, preview, version compare   | 5     |

**Total minimum**: 35 test scenarios

---

## 2. E2E Test Scenarios

All E2E tests use real Express servers on random ports with full middleware chain (auth, tenant isolation, rate limiting, validation). No mocks of codebase components. Only external services mocked via DI.

### E2E-1: Template CRUD Lifecycle

**Description**: Create, read, update, list, and delete a message template via the HTTP API.

**Setup**: Start runtime/admin server on random port. Seed tenant and project via API.

**Steps**:

1. POST `/api/projects/:projectId/message-templates` with `{ name: "greeting", content: "Hello {{customerName}}", variables: [{ name: "customerName", type: "string" }] }`
2. Assert 201 response with `{ success: true, data: { _id, name, content, version: 1 } }`
3. GET `/api/projects/:projectId/message-templates/:id` — assert 200 with full template
4. PUT `/api/projects/:projectId/message-templates/:id` with updated content — assert 200, version incremented to 2
5. GET `/api/projects/:projectId/message-templates` — assert list contains the template
6. DELETE `/api/projects/:projectId/message-templates/:id` — assert 200
7. GET `/api/projects/:projectId/message-templates/:id` — assert 404

**Assertions**: Status codes, response envelope format, version increments, 404 after delete.

### E2E-2: Template Tenant Isolation

**Description**: Verify templates in one tenant/project are invisible to another tenant.

**Setup**: Two tenants with one project each. Create a template in tenant A's project.

**Steps**:

1. Create template in project A (tenant A)
2. GET template by ID from project B (tenant B) — assert 404 (not 403)
3. LIST templates in project B — assert empty list (no leak)
4. PUT template ID from project A using tenant B credentials — assert 404
5. DELETE template ID from project A using tenant B credentials — assert 404

**Assertions**: Cross-tenant access returns 404, no resource existence leakage.

### E2E-3: Template Project Isolation

**Description**: Verify templates are scoped to their project within the same tenant.

**Setup**: One tenant with two projects. Create template in project A.

**Steps**:

1. Create template in project A
2. GET template by ID under project B route — assert 404
3. LIST templates in project B — assert empty
4. Verify template appears in project A list

**Assertions**: Same tenant, different project: 404 on cross-project access.

### E2E-4: Template Name Uniqueness

**Description**: Verify duplicate template names within the same project are rejected.

**Steps**:

1. Create template with name "disclaimer"
2. Create another template with name "disclaimer" in same project — assert 409 Conflict
3. Create template with name "disclaimer" in different project — assert 201 (allowed)

**Assertions**: 409 on duplicate within project, 201 on same name in different project.

### E2E-5: Template Version History

**Description**: Verify version history is maintained across updates and supports rollback.

**Steps**:

1. Create template (version 1)
2. Update content 3 times (versions 2, 3, 4)
3. GET `/api/projects/:projectId/message-templates/:id/versions` — assert 4 versions with timestamps and author
4. POST `/api/projects/:projectId/message-templates/:id/rollback` with `{ version: 2 }` — assert 200, version 5 created with content from version 2
5. GET current template — assert content matches version 2, version number is 5

**Assertions**: Version count, rollback creates new version, content matches historical.

### E2E-6: Template with Channel Variants

**Description**: Create and retrieve a template with multiple channel-format variants.

**Steps**:

1. POST template with:
   ```json
   {
     "name": "order_confirmation",
     "content": "Your order {{orderId}} is confirmed.",
     "variants": {
       "whatsapp": "Order *{{orderId}}* confirmed! Tap below for details.",
       "slack": "*Order {{orderId}} Confirmed*\nYour order has been placed.",
       "email": "<h2>Order {{orderId}} Confirmed</h2><p>Thank you for your order.</p>",
       "voice": "Your order number {{orderId}} has been confirmed."
     }
   }
   ```
2. GET template — assert all variants stored correctly
3. Update only the `whatsapp` variant — assert other variants unchanged, version incremented

**Assertions**: Variant storage integrity, partial variant updates, version on variant change.

### E2E-7: Template Variable Validation

**Description**: Validate template variable declarations and content consistency.

**Steps**:

1. Create template with variables `[{ name: "customerName", type: "string", required: true }]`
2. Assert content referencing `{{customerName}}` passes validation
3. Create template with content `{{unknownVar}}` but no variable declaration — assert warning in response (not error)
4. Create template with variable name containing invalid characters — assert 400 validation error
5. Create template with content exceeding 64 KB — assert 400 payload too large

**Assertions**: Variable-content consistency warnings, invalid variable names rejected, size limit enforced.

### E2E-8: Template API Authentication and Authorization

**Description**: Verify auth requirements on all template endpoints.

**Steps**:

1. All CRUD endpoints without auth token — assert 401
2. Auth token for user without project permission — assert 404 (not 403, per isolation rules)
3. Auth token with read-only permission — GET succeeds, POST/PUT/DELETE return 403
4. Auth token with write permission — all CRUD succeeds

**Assertions**: 401 without auth, 404 for unauthorized project access, 403 for insufficient permission.

### E2E-9: Template List Pagination and Filtering

**Description**: Verify list endpoint supports pagination, search, and status filtering.

**Steps**:

1. Create 25 templates with varied names and statuses
2. GET list with `?limit=10&offset=0` — assert 10 results, total count 25
3. GET list with `?limit=10&offset=10` — assert next 10 results
4. GET list with `?search=greeting` — assert filtered results
5. GET list with `?status=published` — assert only published templates

**Assertions**: Pagination math, search filtering, status filtering.

### E2E-10: Template Rate Limiting

**Description**: Verify rate limiting on template API endpoints.

**Steps**:

1. Send 101 requests to POST template endpoint within 60 seconds
2. Assert the 101st request returns 429 Too Many Requests
3. Wait for rate limit window to expire
4. Assert next request succeeds

**Assertions**: 429 after limit exceeded, recovery after window.

---

## 3. Integration Test Scenarios

Integration tests verify service boundaries between components. Real MongoDB (in-memory via MongoMemoryServer), real Redis, real template engine. No mocking of codebase components.

### INT-1: Runtime Template Resolver — Channel Format Selection

**Description**: Verify the runtime resolver selects the correct format variant based on channel type.

**Setup**: Seed templates with multiple channel variants in MongoDB.

**Steps**:

1. Resolve template "order_confirmation" with channel `whatsapp` — assert WhatsApp variant returned
2. Resolve with channel `slack` — assert Slack variant
3. Resolve with channel `web_chat` — assert default variant (no specific web_chat variant)
4. Resolve with channel `voice` — assert voice variant
5. Resolve template with no variants and channel `slack` — assert default content

**Assertions**: Correct variant selection, fallback to default when no channel-specific variant exists.

### INT-2: Runtime Template Resolver — Variable Interpolation

**Description**: Verify variables are interpolated against session context at resolution time.

**Setup**: Create template with `{{customerName}}` and `{{order.total}}` variables.

**Steps**:

1. Resolve with context `{ customerName: "Alice", order: { total: "$42.99" } }` — assert interpolated content
2. Resolve with missing `customerName` — assert empty string substitution and trace warning emitted
3. Resolve with `{{#if premium}}` conditional and truthy context — assert conditional block included
4. Resolve with falsy context — assert conditional block excluded
5. Resolve with `{{#each items}}` and array context — assert iteration output

**Assertions**: Interpolation correctness, missing variable handling, conditional/iteration support.

### INT-3: Template Cache — Invalidation on Update

**Description**: Verify the in-memory cache is invalidated when a template is updated.

**Setup**: Template resolver with in-memory cache populated.

**Steps**:

1. Resolve template — assert cache hit (from pre-populated cache)
2. Update template content via repository
3. Emit cache invalidation event (Redis pub/sub)
4. Resolve template again — assert new content returned
5. Verify cache miss metric incremented

**Assertions**: Cache invalidation works, new content served after update.

### INT-4: Compiler — DSL Template Sync to Library

**Description**: Verify DSL `TEMPLATES:` block syncs to project template library during compilation.

**Setup**: Project with existing API-created templates.

**Steps**:

1. Compile DSL with `TEMPLATES:` block containing template "greeting"
2. Assert project template library has "greeting" entry
3. Compile DSL with updated "greeting" content — assert library entry updated, version incremented
4. Assert API-created templates not in DSL are preserved (additive sync)
5. Compile DSL without any `TEMPLATES:` block — assert existing library unchanged

**Assertions**: DSL-to-library sync creates and updates entries, does not delete API-created templates.

### INT-5: Template Repository — Version Lifecycle

**Description**: Verify version management including creation, limit enforcement, and eviction.

**Setup**: Template with 48 versions already stored.

**Steps**:

1. Update template twice — versions 49 and 50 created
2. Update template again — version 51 created, version 1 evicted (50-version cap)
3. Query version history — assert 50 versions, oldest is version 2
4. Assert version metadata (author, timestamp, content snapshot) is correct
5. Rollback to version 10 — assert new version 52 created with version 10's content

**Assertions**: Version cap enforcement, LRU eviction, rollback semantics.

### INT-6: Template Repository — Concurrent Update Safety

**Description**: Verify concurrent updates to the same template are handled safely.

**Setup**: Template in MongoDB.

**Steps**:

1. Issue two concurrent PUT requests with different content
2. Assert one succeeds and one receives 409 Conflict (optimistic locking)
3. Verify the winning update's content is persisted
4. Verify version incremented exactly once

**Assertions**: No lost updates, conflict detection via optimistic locking.

### INT-7: Runtime Template Resolver — Performance Under Load

**Description**: Verify template resolution meets latency targets under concurrent load.

**Setup**: 1,000 templates in cache.

**Steps**:

1. Resolve 1,000 templates sequentially — assert P95 < 5ms
2. Resolve 100 templates concurrently (Promise.all) — assert all complete within 50ms
3. Resolve with cache miss (cold start) — assert < 50ms (includes DB fetch)

**Assertions**: Latency within NFR-1 targets.

---

## 4. Unit Test Scenarios

### UNIT-1: Template Name Validation

**Description**: Validate template name format constraints.

**Cases**:

- `greeting` — valid
- `order_confirmation_v2` — valid
- `Order-Greeting` — invalid (hyphens not allowed per `\w+` DSL pattern)
- `123start` — valid (starts with digit, which `\w+` allows)
- Empty string — invalid
- 65-character name — invalid (exceeds 64 char limit)
- `my template` — invalid (spaces not allowed)

### UNIT-2: Template Content Size Validation

**Description**: Validate content size limits.

**Cases**:

- 1 KB content — valid
- 64 KB content — valid (at limit)
- 64 KB + 1 byte — invalid
- Empty content — valid (allowed for draft templates)

### UNIT-3: Channel Variant Key Validation

**Description**: Validate that variant keys map to known channel types.

**Cases**:

- `default` — valid
- `whatsapp` — valid
- `slack` — valid
- `msteams` — valid
- `email` — valid
- `voice` — valid
- `unknown_channel` — invalid
- `WHATSAPP` — invalid (case-sensitive)

### UNIT-4: Variable Schema Validation

**Description**: Validate variable declaration schema.

**Cases**:

- `{ name: "customerName", type: "string" }` — valid
- `{ name: "count", type: "number" }` — valid
- `{ name: "", type: "string" }` — invalid (empty name)
- `{ name: "a b", type: "string" }` — invalid (spaces in name)
- `{ name: "x", type: "unknown" }` — invalid (unknown type)
- `{ name: "x", type: "string", required: true, defaultValue: "N/A" }` — valid

### UNIT-5: Template Interpolation Edge Cases

**Description**: Verify `renderTemplate()` handles edge cases specific to message templates.

**Cases**:

- Nested path `{{customer.address.city}}` with full context — resolves
- Nested path with missing intermediate — returns empty string
- Self-referencing template `{{content}}` where content contains `{{var}}` — no double-interpolation
- HTML in variable values — passed through as-is (sanitization is caller responsibility)
- Very long variable value (10 KB) — passes through without truncation

---

## 5. Test Coverage Map

| Component                | E2E                               | Integration                | Unit           | Coverage Target |
| ------------------------ | --------------------------------- | -------------------------- | -------------- | --------------- |
| API CRUD endpoints       | E2E-1, E2E-4, E2E-6, E2E-7, E2E-9 | —                          | —              | 90%             |
| Tenant/project isolation | E2E-2, E2E-3                      | —                          | —              | 100%            |
| Auth/permissions         | E2E-8                             | —                          | —              | 100%            |
| Rate limiting            | E2E-10                            | —                          | —              | 80%             |
| Version management       | E2E-5                             | INT-5                      | —              | 90%             |
| Runtime resolver         | —                                 | INT-1, INT-2, INT-3, INT-7 | —              | 90%             |
| Cache invalidation       | —                                 | INT-3                      | —              | 80%             |
| Compiler sync            | —                                 | INT-4                      | —              | 80%             |
| Concurrent updates       | —                                 | INT-6                      | —              | 80%             |
| Name/content validation  | —                                 | —                          | UNIT-1, UNIT-2 | 95%             |
| Channel variants         | E2E-6                             | INT-1                      | UNIT-3         | 90%             |
| Variable schema          | E2E-7                             | INT-2                      | UNIT-4, UNIT-5 | 90%             |

---

## 6. Test Environment Requirements

| Resource  | Requirement                                                   |
| --------- | ------------------------------------------------------------- |
| MongoDB   | MongoMemoryServer for integration tests; real MongoDB for E2E |
| Redis     | Real Redis for cache invalidation tests                       |
| Express   | Random port (`{ port: 0 }`) for E2E servers                   |
| Auth      | Real JWT tokens with tenant/project claims                    |
| Seed data | Factory functions for tenants, projects, users, templates     |
| Runtime   | Real runtime executor for template resolution E2E tests       |

---

## 7. Existing Test Coverage (ALPHA)

_Audited: 2026-03-26_

### Compiler Template Resolution Tests

**File**: `packages/compiler/src/__tests__/template-resolution.test.ts` (27 test cases, 644 lines)

These tests verify compile-time `TEMPLATE(name)` inlining into IR respond fields. All 27 tests pass.

| Test Case                                                            | Covers                                    |
| -------------------------------------------------------------------- | ----------------------------------------- |
| `TEMPLATE(name)` in flow step RESPOND                                | Basic compile-time template inlining      |
| `TEMPLATE(name)` in COMPLETE respond                                 | Completion handler resolution             |
| `TEMPLATE(name)` in ON_INPUT branch                                  | Input handler resolution                  |
| `TEMPLATE(name)` in ON_SUCCESS branch                                | Success handler resolution                |
| `TEMPLATE(name)` in MESSAGES                                         | Messages block resolution                 |
| `TEMPLATE(name)` in ON_START                                         | Start handler resolution                  |
| `TEMPLATE(name)` in step-level digression                            | Digression handler resolution             |
| Undefined template reference produces compile error                  | E601 error on missing template            |
| Unused template produces warning                                     | W602 warning for dead templates           |
| Duplicate template name: last definition wins                        | Conflict resolution semantics             |
| No templates: ir.templates is undefined                              | No-template baseline                      |
| RESPOND without TEMPLATE() passes through unchanged                  | Non-template respond passthrough          |
| Multi-line template content is preserved                             | Content integrity                         |
| Reasoning agent: TEMPLATE in error handler respond                   | Reasoning agent error handler             |
| Reasoning agent: TEMPLATE in hooks respond                           | Reasoning agent hooks                     |
| Reasoning agent: TEMPLATE in COMPLETE + ON_START + MESSAGES combined | Multi-location resolution                 |
| Reasoning agent: TEMPLATE with `{{}}` interpolation vars preserved   | Variable placeholders survive compilation |
| Scripted: TEMPLATE in ON_RESULT branches                             | Scripted agent result handler             |
| Scripted: TEMPLATE in sub_intent                                     | Sub-intent resolution                     |
| Scripted: TEMPLATE in ON_SUCCESS conditional branches                | Conditional branch resolution             |
| Standalone TEMPLATE syntax compiles correctly                        | Standalone `TEMPLATE name:` syntax        |
| `TEMPLATE(name)` in top-level GATHER field prompt                    | Gather field prompt resolution            |
| TEMPLATE with formats populates rich_content on GATHER               | Multi-format rich content on gather       |
| Undefined TEMPLATE in GATHER produces E601 error                     | Error handling in gather context          |
| GATHER usage marks template as used (no W602 warning)                | Usage tracking for gather references      |
| `TEMPLATE(name)` in FLOW step GATHER field prompt                    | Flow-step gather field resolution         |
| `TEMPLATE(name)` in ON_ACTION handler respond                        | Action handler resolution                 |

### Coverage Gap Analysis: Spec Scenarios vs Existing Tests

| Spec Scenario                                                                                       | Status            | Notes                                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| **E2E-1 through E2E-10** (API CRUD, isolation, auth, pagination, rate limiting, variants, versions) | NOT COVERED       | Requires API routes and MongoDB model (not yet implemented)                                  |
| **INT-1** (Runtime resolver channel format selection)                                               | NOT COVERED       | Requires MessageTemplateResolver service (not yet implemented)                               |
| **INT-2** (Runtime variable interpolation)                                                          | PARTIALLY COVERED | `interpolateMessage()` exists in evaluator.ts; no integration test against template resolver |
| **INT-3** (Cache invalidation on update)                                                            | NOT COVERED       | Requires resolver cache + Redis pub/sub (not yet implemented)                                |
| **INT-4** (Compiler DSL-to-library sync)                                                            | NOT COVERED       | Requires `syncFromDSL()` wiring (not yet implemented)                                        |
| **INT-5** (Version lifecycle)                                                                       | NOT COVERED       | Requires version model and repository (not yet implemented)                                  |
| **INT-6** (Concurrent update safety)                                                                | NOT COVERED       | Requires repository with optimistic locking (not yet implemented)                            |
| **INT-7** (Performance under load)                                                                  | NOT COVERED       | Requires resolver with cache (not yet implemented)                                           |
| **UNIT-1** (Template name validation)                                                               | PARTIALLY COVERED | DSL parser validates `\w+` pattern; no standalone Zod schema tests                           |
| **UNIT-2** (Content size validation)                                                                | NOT COVERED       | Requires Zod schema (not yet implemented)                                                    |
| **UNIT-3** (Channel variant key validation)                                                         | NOT COVERED       | Requires variant key enum validation (not yet implemented)                                   |
| **UNIT-4** (Variable schema validation)                                                             | NOT COVERED       | Requires Zod variable schema (not yet implemented)                                           |
| **UNIT-5** (Interpolation edge cases)                                                               | PARTIALLY COVERED | `interpolateMessage()` handles nested paths and `{{var}}`; no dedicated edge-case test suite |

**Summary**: Of 22 planned test scenarios (10 E2E + 7 integration + 5 unit), only the compiler-level template resolution is covered (27 tests). All API, runtime resolver, cache, and validation test scenarios require the unimplemented CRUD system as a prerequisite.

---

## 8. Iteration Log

### 2026-03-26 — Post-implementation sync (ALPHA)

- Updated status from PLANNED to ALPHA
- Documented existing 27-test compiler suite
- Added coverage gap analysis mapping spec scenarios to implementation status
- All E2E and most integration/unit scenarios blocked on unimplemented MongoDB model, API routes, and runtime resolver
