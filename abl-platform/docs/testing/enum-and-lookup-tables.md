# Test Specification: Enum Fields & Lookup Tables

**Feature Spec**: `docs/features/enum-and-lookup-tables.md`
**HLD**: N/A (post-implementation)
**LLD**: N/A (post-implementation)
**Status**: IN PROGRESS
**Last Updated**: 2026-03-24

---

## 1. Coverage Matrix

| FR            | Description                                                   | Unit | Integration | E2E | Manual | Status              |
| ------------- | ------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------------------- |
| GAP-1         | Parser: `options` property on gather fields                   | ✅   | ❌          | ❌  | ❌     | Unit done (7 tests) |
| GAP-2         | Compiler: enum → `type:'enum'` ValidationRule + `enum_values` | ✅   | ❌          | ❌  | ❌     | Unit done (5 tests) |
| GAP-3         | Runtime: Lookup values injected into LLM extraction prompt    | ✅   | ❌          | ❌  | ❌     | Unit done (9 tests) |
| GAP-4         | Runtime: API auth header forwarding                           | ✅   | ❌          | ❌  | ❌     | Unit done (2 tests) |
| GAP-5         | Studio: Lookup field type in GatherEditor                     | ❌   | ❌          | ❌  | ✅     | Manual smoke tested |
| GAP-6         | Runtime: Collection fuzzy matching                            | ✅   | ❌          | ❌  | ❌     | Unit done (3 tests) |
| GAP-7         | Runtime: LRU eviction in TTLCache                             | ✅   | ❌          | ❌  | ❌     | Unit done (1 test)  |
| GAP-8         | Runtime: Token budget guard for large value sets              | ✅   | ❌          | ❌  | ❌     | Unit done (2 tests) |
| LOOKUP-INLINE | Inline source: exact/case-insensitive/fuzzy match             | ✅   | ❌          | ❌  | ❌     | Partial             |
| LOOKUP-API    | API source: HTTP fetch, SSRF, circuit breaker, cache          | ✅   | ❌          | ❌  | ❌     | Partial             |
| LOOKUP-COLL   | Collection source: MongoDB lookup, tenant isolation           | ✅   | ❌          | ❌  | ❌     | Partial             |
| REST-API      | Lookup data CRUD: upsert, list, delete, upload                | ❌   | ❌          | ❌  | ❌     | NOT STARTED         |
| STUDIO-SER    | Serializer: GatherEditor → DSL → IR round-trip                | ❌   | ❌          | ❌  | ✅     | Manual only         |
| STUDIO-HYD    | Hydration: IR → GatherEditor store fields                     | ❌   | ❌          | ❌  | ✅     | Manual only         |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers.

### E2E-1: Enum field — valid value accepted through full pipeline

- **Preconditions**: Runtime server running on random port. Agent DSL with `type: enum`, `OPTIONS: [economy, business, first]` compiled and loaded.
- **Steps**:
  1. POST `/api/projects/:projectId/agents` — create agent from DSL with enum gather field
  2. POST `/api/projects/:projectId/sessions` — create session
  3. POST `/api/projects/:projectId/sessions/:sessionId/messages` — send "economy"
  4. GET `/api/projects/:projectId/sessions/:sessionId` — check gathered field value
- **Expected Result**: `cabin_class` field is gathered with value `"economy"`. No re-prompt.
- **Auth Context**: Valid tenant JWT, project member with `agent:execute` permission
- **Isolation Check**: Different tenant cannot access this session (404)

### E2E-2: Enum field — invalid value triggers re-prompt with allowed values

- **Preconditions**: Same agent as E2E-1
- **Steps**:
  1. POST `/api/projects/:projectId/sessions/:sessionId/messages` — send "premium"
  2. Assert response contains re-prompt with error message listing allowed values
  3. POST `/api/projects/:projectId/sessions/:sessionId/messages` — send "business"
  4. GET session — check field is now gathered
- **Expected Result**: First message rejected with "Invalid cabin_class. Allowed values: economy, business, first". Second message accepted.
- **Auth Context**: Valid tenant JWT, project member
- **Isolation Check**: Cross-project session access returns 404

### E2E-3: Inline lookup — exact match and fuzzy match with confirmation

- **Preconditions**: Agent DSL with inline lookup table `cities: [New York, Los Angeles, Chicago]`, fuzzy_match: true, fuzzy_threshold: 0.8
- **Steps**:
  1. Create agent, create session
  2. POST message — send "New York" (exact match)
  3. Assert field gathered without confirmation prompt
  4. Create new session for fuzzy test
  5. POST message — send "New Yrok" (typo)
  6. Assert response asks "Did you mean New York?"
  7. POST message — send "yes"
  8. Assert field gathered with value "New York"
- **Expected Result**: Exact match bypasses confirmation. Fuzzy match triggers confirmation flow.
- **Auth Context**: Valid tenant JWT, project member
- **Isolation Check**: N/A (inline values are in IR, not tenant-scoped)

### E2E-4: Collection lookup — tenant-isolated MongoDB validation

- **Preconditions**: Runtime + MongoDB running. Lookup entries seeded via REST API for tenant-A/project-A.
- **Steps**:
  1. POST `/api/projects/:projectId/lookup-tables/products/entries` — seed entries ["Widget", "Gadget", "Gizmo"] for tenant-A
  2. Create agent with collection lookup `products` linked to gather field
  3. Create session, POST message "Widget"
  4. Assert field gathered with "Widget"
  5. Create session under tenant-B (different tenant)
  6. POST message "Widget" under tenant-B
  7. Assert lookup returns not-found (tenant isolation), triggers re-prompt
- **Expected Result**: Tenant-A's lookup values are invisible to tenant-B.
- **Auth Context**: Separate JWTs for tenant-A and tenant-B
- **Isolation Check**: This IS the isolation test — cross-tenant lookup returns not-found

### E2E-5: API lookup — remote validation with timeout and circuit breaker

- **Preconditions**: Runtime running. Mock external API server on random port returning `{ found: true, matched_value: "..." }` for known values.
- **Steps**:
  1. Start mock API server that responds to `/lookup?value=X&field=name`
  2. Create agent with API lookup pointing to mock server
  3. Create session, POST message with valid value
  4. Assert field gathered successfully
  5. Kill mock API server
  6. POST 3 messages with new values (trigger 3 failures)
  7. Assert circuit breaker opens (error response mentions circuit)
  8. Restart mock API server, wait 30s
  9. POST message — assert circuit breaker resets and lookup succeeds
- **Expected Result**: Circuit breaker opens after 3 failures, resets after 30s window.
- **Auth Context**: Valid tenant JWT, project member
- **Isolation Check**: N/A (API source is external)

### E2E-6: REST API — lookup data CRUD with auth and project isolation

- **Preconditions**: Runtime + MongoDB running
- **Steps**:
  1. POST `/api/projects/:projectId/lookup-tables/colors/entries` — upsert ["red", "green", "blue"] with `lookup_data:write` permission
  2. GET `/api/projects/:projectId/lookup-tables/colors/entries` — list entries, assert 3 returned
  3. POST `/api/projects/:projectId/lookup-tables/colors/upload` — upload CSV with additional values
  4. GET entries again — assert count increased
  5. DELETE `/api/projects/:projectId/lookup-tables/colors/entries` — delete all
  6. GET entries — assert empty
  7. Attempt GET from different project — assert 404
  8. Attempt POST without auth — assert 401
  9. Attempt POST without `lookup_data:write` — assert 403
- **Expected Result**: Full CRUD lifecycle with proper auth enforcement
- **Auth Context**: JWT with `lookup_data:read` + `lookup_data:write`, then JWT without permissions
- **Isolation Check**: Cross-project returns 404, no-auth returns 401, no-permission returns 403

### E2E-7: LLM extraction tool includes enum constraint from compiled IR

- **Preconditions**: Agent with `type: enum, OPTIONS: [economy, business, first]` compiled to IR
- **Steps**:
  1. Create agent, inspect compiled IR via admin API
  2. Assert IR gather field has `validation.type === 'enum'` and `validation.rule === 'economy|business|first'`
  3. Assert IR gather field has `enum_values === ['economy', 'business', 'first']`
  4. Create session, trigger extraction
  5. Inspect trace events for the extraction tool call
  6. Assert the tool's JSON schema includes `enum: ['economy', 'business', 'first']`
- **Expected Result**: Enum values flow from DSL through compiler to LLM tool schema
- **Auth Context**: Valid tenant JWT, project member
- **Isolation Check**: N/A (IR is agent-scoped)

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Parser → Compiler pipeline — enum field with options

- **Boundary**: `@abl/core` parser → `@abl/compiler` IR compiler
- **Setup**: DSL string with enum gather field + options
- **Steps**:
  1. Parse DSL with `parseAgentBasedABL()`
  2. Compile with `compileABLtoIR()`
  3. Assert IR gather field has `validation.type === 'enum'`
  4. Assert IR gather field has `validation.rule === 'economy|business|first'`
  5. Assert IR gather field has `enum_values === ['economy', 'business', 'first']`
- **Expected Result**: Options parsed from DSL survive compilation to IR with correct enum validation type
- **Failure Mode**: If parser doesn't parse options, compiler falls back to `type: 'custom'`

### INT-2: Parser → Compiler pipeline — lookup table with headers

- **Boundary**: `@abl/core` parser → `@abl/compiler` IR compiler
- **Setup**: DSL with LOOKUP_TABLES section including `headers:` sub-block
- **Steps**:
  1. Parse DSL with lookup table having `headers: { Authorization: Bearer token, X-API-Key: secret }`
  2. Compile to IR
  3. Assert `ir.lookup_tables.products.headers` equals `{ Authorization: 'Bearer token', 'X-API-Key': 'secret' }`
- **Expected Result**: Headers parsed from DSL sub-block and carried through to IR
- **Failure Mode**: Headers mistakenly parsed as a separate table name

### INT-3: Runtime LookupResolver → MongoDB — collection source with tenant isolation

- **Boundary**: `lookup-resolver.ts` → MongoDB `lookup_entries` collection
- **Setup**: MongoDB running. Seed entries for tenant-A and tenant-B in same table name.
- **Steps**:
  1. Insert entries: tenant-A/project-A/cities = ["NYC", "LAX"], tenant-B/project-B/cities = ["London", "Paris"]
  2. Call `resolveLookup("NYC", table, { tenantId: 'tenant-A', projectId: 'project-A' })`
  3. Assert found = true, matched_value = "NYC"
  4. Call `resolveLookup("NYC", table, { tenantId: 'tenant-B', projectId: 'project-B' })`
  5. Assert found = false (tenant isolation)
- **Expected Result**: Same table name, different tenants, completely isolated
- **Failure Mode**: Missing tenantId in query leaks cross-tenant data

### INT-4: Runtime LookupResolver → HTTP — API source with header forwarding

- **Boundary**: `lookup-resolver.ts` → external HTTP API
- **Setup**: Local HTTP server on random port. Validates Authorization header.
- **Steps**:
  1. Start mock server that returns 401 without Authorization header, 200 with it
  2. Call `resolveLookup("widget", table, ctx)` where table has `headers: { Authorization: 'Bearer test' }`
  3. Assert found = true
  4. Call with table without headers
  5. Assert found = false (401 from server)
- **Expected Result**: Configured headers forwarded on every API lookup request
- **Failure Mode**: Headers not merged into fetch options

### INT-5: Runtime LookupResolver — SSRF protection blocks private IPs

- **Boundary**: `lookup-resolver.ts` → `validateUrlForSSRF()`
- **Setup**: API lookup table with private IP endpoints
- **Steps**:
  1. Call `resolveLookup` with endpoint `http://127.0.0.1:8080/lookup`
  2. Assert error/rejection (SSRF blocked)
  3. Call with endpoint `http://169.254.169.254/latest/meta-data`
  4. Assert error/rejection (cloud metadata blocked)
  5. Call with endpoint `http://10.0.0.1/internal`
  6. Assert error/rejection (private network blocked)
- **Expected Result**: All private/internal IPs blocked before HTTP request is made
- **Failure Mode**: SSRF validation skipped, request sent to internal network

### INT-6: Studio serializer round-trip — lookup field editor → DSL → IR → editor

- **Boundary**: `abl-serializers.ts` → parser → compiler → `agent-detail-store.ts`
- **Setup**: GatherFieldData with `type: 'lookup'`, all lookup fields populated
- **Steps**:
  1. Create GatherFieldData with lookupSource='api', lookupEndpoint, lookupHeaders, etc.
  2. Call `serializeGatherToABL()` — get DSL text
  3. Assert DSL contains `LOOKUP_TABLES:` section with correct properties
  4. Parse DSL with `parseAgentBasedABL()`
  5. Compile with `compileABLtoIR()`
  6. Hydrate with `parseGather(ir)` from agent-detail-store
  7. Assert hydrated GatherFieldData matches original (all lookup fields preserved)
- **Expected Result**: Full round-trip: editor state → DSL → parser → compiler → IR → editor state
- **Failure Mode**: Field lost during any serialization/deserialization step

### INT-7: Runtime LookupResolver — cache TTL and LRU eviction

- **Boundary**: `lookup-resolver.ts` internal caches
- **Setup**: API lookup with mock fetchFn
- **Steps**:
  1. Resolve value "A" — assert fetch called
  2. Resolve value "A" again — assert fetch NOT called (cache hit)
  3. Wait > TTL (5 min in prod, use shorter for test)
  4. Resolve value "A" — assert fetch called again (cache expired)
  5. Fill cache to max capacity, access "A" to refresh its LRU position
  6. Add one more entry — assert "A" survives (LRU, not FIFO)
- **Expected Result**: Cache respects TTL and uses LRU eviction
- **Failure Mode**: FIFO eviction drops hot entries; stale cache serves expired data

---

## 4. Unit Test Scenarios

### Existing Tests (31 total, all passing)

| ID   | Test File                                                         | Count | Covers                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UT-1 | `packages/core/src/__tests__/parser-enum-options.test.ts`         | 7     | GAP-1: bracket list, comma-separated, whitespace trim, empty filter, single value, coexist with other props                                                                                                      |
| UT-2 | `packages/core/src/__tests__/parser-lookup-headers.test.ts`       | 4     | GAP-4: headers sub-block parsing, undefined when absent, single header, coexist with other props                                                                                                                 |
| UT-3 | `packages/compiler/src/__tests__/gather-enum-compilation.test.ts` | 5     | GAP-2: enum→ValidationRule, enum_values populated, no options→no validation, non-enum still custom, error message lists values                                                                                   |
| UT-4 | `apps/runtime/src/__tests__/extraction-lookup-injection.test.ts`  | 9     | GAP-3+8: inline values as JSON Schema enum, no inject when has enum validation, no inject for collection/api, description hint >100 values, boundary at 100, missing table, no tables param, no semantics.lookup |
| UT-5 | `apps/runtime/src/__tests__/lookup-resolver-gaps.test.ts`         | 6     | GAP-4+6+7: API header forwarding, headers-only Content-Type, collection fuzzy match, fuzzy below threshold, no fuzzy when disabled, LRU eviction                                                                 |

### Additional Unit Tests Needed

| ID    | Module                  | Description                                                                      | Priority |
| ----- | ----------------------- | -------------------------------------------------------------------------------- | -------- |
| UT-6  | `abl-serializers.ts`    | `serializeLookupTableEntry()` — inline source emits values                       | HIGH     |
| UT-7  | `abl-serializers.ts`    | `serializeLookupTableEntry()` — API source emits endpoint, method, body, headers | HIGH     |
| UT-8  | `abl-serializers.ts`    | `serializeLookupTableEntry()` — collection source emits table_name, field        | HIGH     |
| UT-9  | `abl-serializers.ts`    | `serializeGatherToABL()` — lookup field emits semantics.lookup                   | HIGH     |
| UT-10 | `abl-serializers.ts`    | `serializeGatherToABL()` — returns both GATHER and LOOKUP_TABLES sections        | HIGH     |
| UT-11 | `agent-detail-store.ts` | `parseGather()` — hydrates lookup fields from IR lookup_tables                   | HIGH     |
| UT-12 | `agent-detail-store.ts` | `parseGather()` — non-lookup field unaffected by lookup_tables                   | MEDIUM   |
| UT-13 | `lookup-resolver.ts`    | API circuit breaker opens after 3 failures                                       | MEDIUM   |
| UT-14 | `lookup-resolver.ts`    | API circuit breaker resets after 30s                                             | MEDIUM   |
| UT-15 | `lookup-resolver.ts`    | SSRF blocks private IP endpoints                                                 | MEDIUM   |

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant access returns 404**: Collection lookup queries include tenantId. REST API routes scoped by tenant. (Covered in E2E-4, INT-3)
- [x] **Cross-project access returns 404**: REST API routes under `/api/projects/:projectId/`. Lookup entries scoped by projectId. (Covered in E2E-6)
- [ ] **Cross-user access returns 404**: N/A — lookup tables are project-level, not user-owned
- [x] **Missing auth returns 401**: REST API requires `authMiddleware`. (Covered in E2E-6)
- [x] **Insufficient permissions returns 403**: REST API requires `lookup_data:read`/`write`. (Covered in E2E-6)
- [x] **Input validation rejects malformed data**: Zod validation on bulk upsert (max 1K entries), upload (max 10K values, 1MB body). (Covered in E2E-6)
- [x] **SSRF protection**: API lookup source validates URLs against private IP ranges. (Covered in INT-5)
- [ ] **Header injection prevention**: Lookup table headers should not allow CRLF injection in header values
- [ ] **XSS in lookup values**: Inline values rendered in Studio UI should be escaped

---

## 6. Performance & Load Tests

| Test   | Description                                       | Threshold                 | Priority |
| ------ | ------------------------------------------------- | ------------------------- | -------- |
| PERF-1 | Parse DSL with 1000 inline lookup values          | < 100ms                   | LOW      |
| PERF-2 | Compile agent with 10 lookup tables               | < 500ms                   | LOW      |
| PERF-3 | Resolve 100 concurrent inline lookups             | < 10ms avg                | MEDIUM   |
| PERF-4 | API lookup with 5s timeout — verify timeout fires | Timeout at 5000ms ± 500ms | MEDIUM   |
| PERF-5 | Cache hit rate under steady-state lookup load     | > 90% after warmup        | LOW      |

---

## 7. Test Infrastructure

- **Required services**: MongoDB (Docker), Redis (Docker), Runtime Express server (random port)
- **Data seeding**: `LookupEntry` model for collection source tests, REST API for E2E seeding
- **Environment variables**: Standard test env from `.env.test` — MongoDB URI, Redis URL, JWT secret
- **CI configuration**: Vitest with `--run` flag. MongoDB container in CI via Docker Compose. No external API dependencies (mock servers for API source).
- **Mock strategy**: Only mock external HTTP APIs via dependency injection (`fetchFn` parameter in `resolveLookup`). Never mock internal components (parser, compiler, resolver, MongoDB).

---

## 8. Test File Mapping

| Test File                                                                     | Type        | Covers                   | Status         |
| ----------------------------------------------------------------------------- | ----------- | ------------------------ | -------------- |
| `packages/core/src/__tests__/parser-enum-options.test.ts`                     | unit        | GAP-1                    | DONE (7 tests) |
| `packages/core/src/__tests__/parser-lookup-headers.test.ts`                   | unit        | GAP-4 (parser)           | DONE (4 tests) |
| `packages/compiler/src/__tests__/gather-enum-compilation.test.ts`             | unit        | GAP-2                    | DONE (5 tests) |
| `apps/runtime/src/__tests__/extraction-lookup-injection.test.ts`              | unit        | GAP-3, GAP-8             | DONE (9 tests) |
| `apps/runtime/src/__tests__/lookup-resolver-gaps.test.ts`                     | unit        | GAP-4, GAP-6, GAP-7      | DONE (6 tests) |
| `apps/studio/src/__tests__/serializer-lookup.test.ts`                         | unit        | UT-6..UT-10, STUDIO-SER  | PLANNED        |
| `apps/studio/src/__tests__/store-gather-hydration.test.ts`                    | unit        | UT-11..UT-12, STUDIO-HYD | PLANNED        |
| `apps/runtime/src/__tests__/lookup-resolver-circuit.test.ts`                  | unit        | UT-13..UT-15             | PLANNED        |
| `apps/runtime/src/__tests__/e2e/enum-lookup-pipeline.test.ts`                 | e2e         | E2E-1..E2E-5, E2E-7      | PLANNED        |
| `apps/runtime/src/__tests__/e2e/lookup-data-api.test.ts`                      | e2e         | E2E-6                    | PLANNED        |
| `apps/runtime/src/__tests__/integration/lookup-resolver-mongo.test.ts`        | integration | INT-3, INT-7             | PLANNED        |
| `apps/runtime/src/__tests__/integration/lookup-resolver-api.test.ts`          | integration | INT-4, INT-5             | PLANNED        |
| `packages/compiler/src/__tests__/integration/enum-lookup-compilation.test.ts` | integration | INT-1, INT-2             | PLANNED        |
| `apps/studio/src/__tests__/integration/serializer-roundtrip.test.ts`          | integration | INT-6                    | PLANNED        |

---

## 9. Open Testing Questions

1. **API source E2E**: Should E2E-5 use a real mock HTTP server (e.g., express on random port) or a test fixture? Decision: Real mock server for full network-level testing.
2. **Circuit breaker timing**: The 30s reset window makes E2E-5 slow. Consider using a test-configurable reset interval or accepting the slow test.
3. **Studio UI E2E**: Should we add Playwright tests for the lookup config panel? Currently manual-only. Not blocking for initial spec.
4. **Upload E2E**: CSV/JSON upload tests need file fixtures. Create `apps/runtime/src/__tests__/fixtures/lookup-upload-test.csv` and `.json`.
5. **Fuzzy threshold boundary**: Need tests at exactly the threshold value (e.g., similarity === 0.85) to verify >= vs > comparison.
