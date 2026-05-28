# Test Spec: Alerts

**Feature:** alerts
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-03-22

---

## Current State

| Category          | Count | Status  |
| ----------------- | ----- | ------- |
| Unit Tests        | ~57   | PASSING |
| Integration Tests | 0     | MISSING |
| E2E Tests         | 0     | MISSING |

## Test Coverage Map

| Component                            | Unit | Integration | E2E | Notes                             |
| ------------------------------------ | ---- | ----------- | --- | --------------------------------- |
| Threshold evaluation (pure logic)    | YES  | N/A         | NO  | 22 tests in alerting-threshold    |
| Alert scheduler                      | YES  | NO          | NO  | 15 tests with memory stores       |
| Alert notifier                       | YES  | NO          | NO  | 5 tests with mock delivery fn     |
| Memory stores (rule/cooldown/metric) | YES  | N/A         | N/A | 15 tests                          |
| Alert evaluator service (Restate)    | YES  | NO          | NO  | 7 tests with mocked DB/ClickHouse |
| SSRF prevention                      | YES  | NO          | NO  | 3 tests with mocked callback URL  |
| Alert config CRUD (tenant-scoped)    | NO   | NO          | NO  | No route-level tests              |
| Alert rule CRUD (project-scoped)     | NO   | NO          | NO  | No route-level tests              |
| Test-fire endpoint                   | NO   | NO          | NO  | SQL injection vulnerability here  |
| Alert delivery service               | YES  | NO          | NO  | Tested via SSRF tests only        |
| Webhook HMAC signing                 | NO   | NO          | NO  | No tests for signature generation |
| Cooldown enforcement (real)          | NO   | NO          | NO  | Only tested with memory stores    |
| Cross-tenant isolation               | YES  | NO          | NO  | Memory store tests only           |

## Health Dashboard

| Metric                              | Value | Target | Gap |
| ----------------------------------- | ----- | ------ | --- |
| Unit test count                     | ~57   | 60     | ~3  |
| Integration test count              | 0     | 10     | 10  |
| E2E test count                      | 0     | 10     | 10  |
| SQL injection test coverage         | 0     | 3      | 3   |
| Cross-tenant isolation (E2E)        | 0     | 3      | 3   |
| Webhook delivery with signing (E2E) | 0     | 2      | 2   |

---

## E2E Test Scenarios (Minimum 5)

All E2E tests exercise the real system through the HTTP API. No mocking of codebase components. Real Express servers started on random ports. Full middleware chain (auth, rate limiting, tenant isolation, validation).

### E2E-1: Alert Rule CRUD Lifecycle

**Objective:** Verify full CRUD lifecycle for project-scoped alert rules through the HTTP API.

**Setup:**

- Start real Express server on random port with full middleware chain
- Seed a tenant and project via the auth/project APIs
- Authenticate and obtain a valid token with project:write permission

**Steps:**

1. POST `/api/projects/:projectId/alerts` with valid alert rule body
2. Assert 200 with `success: true` and rule data including generated `_id`
3. GET `/api/projects/:projectId/alerts` and verify the rule appears in the list
4. PUT `/api/projects/:projectId/alerts/:alertId` to update threshold
5. Assert updated threshold is reflected in response
6. DELETE `/api/projects/:projectId/alerts/:alertId`
7. GET `/api/projects/:projectId/alerts` and verify rule is removed

**Assertions:**

- All responses match `{ success: true, data: ... }` envelope
- Created rule has correct tenantId, projectId, and default status "ok"
- Updated rule reflects new threshold value
- Deleted rule no longer appears in list

### E2E-2: Tenant Isolation for Alert Rules

**Objective:** Verify that alert rules are strictly isolated between tenants. Cross-tenant access returns 404 (not 403).

**Setup:**

- Start real Express server
- Create two tenants (tenant-A, tenant-B) with separate tokens
- Create a project under each tenant

**Steps:**

1. As tenant-A, POST to create an alert rule in tenant-A's project
2. As tenant-B, GET `/api/projects/:projectIdA/alerts` (tenant-A's project)
3. Assert 404 (not 403) -- cross-tenant access must not leak resource existence
4. As tenant-B, PUT `/api/projects/:projectIdA/alerts/:alertId` with tenant-A's alert ID
5. Assert 404
6. As tenant-B, DELETE `/api/projects/:projectIdA/alerts/:alertId`
7. Assert 404
8. As tenant-A, GET the original alert and verify it still exists (not deleted by tenant-B)

**Assertions:**

- All cross-tenant operations return 404
- No error details leak tenant-A's resource existence to tenant-B
- Tenant-A's rule is not modified or deleted

### E2E-3: Alert Config CRUD with SSRF Protection

**Objective:** Verify tenant-scoped alert config CRUD and SSRF protection on webhook URLs.

**Setup:**

- Start real Express server
- Authenticate as tenant admin with credential:manage permission

**Steps:**

1. POST `/api/tenants/:tenantId/alerts` with type=usage_threshold, channel=webhook, target=https://valid.example.com
2. Assert 201 with created config
3. POST `/api/tenants/:tenantId/alerts` with target=http://169.254.169.254/latest/
4. Assert 400 with INVALID_URL error (SSRF blocked)
5. POST `/api/tenants/:tenantId/alerts` with target=http://10.0.0.1/hook
6. Assert 400 with INVALID_URL error (private IP blocked)
7. PATCH `/api/tenants/:tenantId/alerts/:id` to update target to http://localhost/hook
8. Assert 400 with INVALID_URL error
9. GET `/api/tenants/:tenantId/alerts` and verify only the valid config exists

**Assertions:**

- Valid webhook URLs are accepted
- Cloud metadata endpoints (169.254.x.x) are rejected
- Private IP addresses are rejected
- localhost is rejected on update path too
- SSRF validation applies at both create and update time

### E2E-4: Alert Rule Validation

**Objective:** Verify input validation rejects malformed alert rule data.

**Setup:**

- Start real Express server
- Authenticated with project:write permission

**Steps:**

1. POST with missing `name` -- assert 400
2. POST with invalid `aggregation: "median"` -- assert 400
3. POST with invalid `condition: "between"` -- assert 400
4. POST with `windowMinutes: 0` -- assert 400
5. POST with `threshold: "not-a-number"` -- assert 400
6. POST with empty `channels: []` -- assert 400
7. POST with all valid fields -- assert 200
8. PUT with `{ $set: { threshold: -1 } }` -- verify the uncontrolled update behavior (current code uses `$set: req.body` which is a mass-assignment risk)

**Assertions:**

- Each invalid field produces a 400 with specific error code and message
- Valid creation succeeds
- PUT endpoint forwards entire req.body to MongoDB $set (flag as security concern)

### E2E-5: Test-Fire Endpoint (SQL Injection Prevention)

**Objective:** Verify the test-fire endpoint evaluates rules against ClickHouse and that SQL injection via metric/sourceTable is prevented.

**Setup:**

- Start real Express server with ClickHouse test instance
- Create an alert rule with known metric and sourceTable

**Steps:**

1. POST `/api/projects/:projectId/alerts` with metric="avg_sentiment", sourceTable="abl_platform.conversation_sentiment"
2. POST `/api/projects/:projectId/alerts/:alertId/test`
3. Assert response includes `currentValue`, `threshold`, `condition`, `wouldFire`
4. Create an alert rule with malicious metric: `1); DROP TABLE abl_platform.conversation_sentiment; --`
5. POST `/api/projects/:projectId/alerts/:alertId/test`
6. Assert the request is rejected (400 or 500) WITHOUT executing the malicious SQL
7. Create an alert rule with malicious sourceTable: `abl_platform.conversation_sentiment; DROP TABLE`
8. POST test-fire and assert rejection

**Assertions:**

- Normal test-fire returns structured result
- Malicious metric values are rejected at creation time (once allowlist validation is implemented)
- Malicious sourceTable values are rejected at creation time
- No ClickHouse DDL is executed

**NOTE:** This test currently exposes the SQL injection vulnerability. The fix must add allowlist validation before these tests can pass cleanly.

### E2E-6: Alert History Endpoint

**Objective:** Verify the alert history endpoint returns correct rule status data.

**Setup:**

- Start real Express server
- Create and configure an alert rule

**Steps:**

1. POST to create an alert rule
2. GET `/api/projects/:projectId/alerts/:alertId/history`
3. Assert response includes alertId, name, status, lastEvaluatedAt, lastFiredAt, enabled
4. Assert status is "ok" for a newly created rule
5. Assert lastEvaluatedAt and lastFiredAt are null for a never-evaluated rule

**Assertions:**

- History endpoint returns correct shape
- New rule has status "ok" and null timestamps
- Authenticated and tenant-isolated

### E2E-7: Permission Enforcement

**Objective:** Verify that read-only users cannot create/update/delete alert rules.

**Setup:**

- Start real Express server
- Create tokens for: unauthenticated user, session:read-only user, project:write user

**Steps:**

1. Unauthenticated: GET /alerts -- assert 401
2. Unauthenticated: POST /alerts -- assert 401
3. session:read user: GET /alerts -- assert 200
4. session:read user: POST /alerts -- assert 403
5. session:read user: PUT /alerts/:id -- assert 403
6. session:read user: DELETE /alerts/:id -- assert 403
7. project:write user: POST /alerts -- assert 200
8. project:write user: PUT /alerts/:id -- assert 200
9. project:write user: DELETE /alerts/:id -- assert 200

**Assertions:**

- Authentication is enforced on all endpoints
- Read operations require session:read
- Write operations require project:write
- Permission boundaries are enforced by the real middleware chain

---

## Integration Test Scenarios (Minimum 5)

Integration tests exercise real service boundaries (MongoDB, ClickHouse) but may use test instances. No mocking of codebase components.

### INT-1: Alert Evaluator Service with Real MongoDB

**Objective:** Verify the AlertEvaluator Restate service correctly loads rules from MongoDB and updates their status.

**Setup:**

- Start MongoMemoryServer
- Seed AlertRuleModel with test rules
- Mock only ClickHouse (external service)

**Steps:**

1. Seed 3 rules: one that should fire, one that should be ok, one in cooldown
2. Mock ClickHouse to return known metric values
3. Execute the evaluator service
4. Query MongoDB to verify each rule's status was updated correctly
5. Verify lastEvaluatedAt was set for all rules
6. Verify lastFiredAt was set only for the fired rule

**Assertions:**

- Fired rule has status "firing" and updated lastFiredAt
- OK rule has status "ok"
- Cooldown rule has status "cooldown" and was not re-fired
- All rules have updated lastEvaluatedAt

### INT-2: Alert Delivery Service with Real MongoDB

**Objective:** Verify the evaluateAndDeliver function correctly processes alert configs from MongoDB.

**Setup:**

- Start MongoMemoryServer
- Seed AlertConfig documents
- Mock external webhook endpoint

**Steps:**

1. Create an AlertConfig with webhook channel pointing to mock endpoint
2. Call evaluateAndDeliver with current value above threshold
3. Verify webhook was called with correct payload including HMAC signature
4. Verify AlertConfig.lastTriggeredAt was updated in MongoDB
5. Call evaluateAndDeliver again within cooldown period
6. Verify webhook was NOT called (cooldown respected)

**Assertions:**

- Webhook receives structured payload with type, tenantId, value, threshold
- HMAC signature header is present when ALERT_WEBHOOK_SIGNING_SECRET is set
- lastTriggeredAt is updated after successful delivery
- Cooldown prevents re-delivery within the configured period

### INT-3: AlertScheduler with ClickHouse Metrics

**Objective:** Verify the eventstore AlertScheduler correctly queries metrics and evaluates rules.

**Setup:**

- Start ClickHouse test instance (or use ClickHouse mock with real wire protocol)
- Seed metric data
- Use MemoryAlertRuleStore and MemoryCooldownStore

**Steps:**

1. Seed an alert rule monitoring error_rate > 0.1
2. Seed ClickHouse with error_rate = 0.5 for the test tenant/project
3. Start scheduler and trigger evaluateAll()
4. Verify the rule transitioned to "firing" state
5. Verify a notification was sent via the notifier
6. Verify cooldown was set
7. Seed ClickHouse with error_rate = 0.05
8. Trigger evaluateAll() again
9. Verify the rule transitioned to "resolved"

**Assertions:**

- Scheduler correctly reads metric values from ClickHouse
- State transitions follow the expected pattern: ok -> firing -> resolved
- Cooldown is set after firing
- Resolution clears cooldown

### INT-4: Alert Rule Mongoose Model Validation

**Objective:** Verify the Mongoose schema enforces constraints correctly.

**Setup:**

- Start MongoMemoryServer
- Import AlertRuleModel

**Steps:**

1. Create a valid alert rule -- assert success
2. Create a rule with missing required field (tenantId) -- assert validation error
3. Create a rule with invalid aggregation "median" -- assert enum validation error
4. Create a rule with windowMinutes=0 -- assert min validation error
5. Create two rules with same tenantId+projectId+name -- assert unique index error
6. Create rules in different tenants with same name -- assert success (uniqueness is per-tenant)

**Assertions:**

- All required fields are enforced
- Enum values are validated
- Min constraints are enforced
- Unique index on (tenantId, projectId, name) prevents duplicates
- Different tenants can have rules with the same name

### INT-5: Alert Config Route with Real Auth Middleware

**Objective:** Verify alert-config routes work end-to-end with real auth middleware and MongoDB.

**Setup:**

- Start real Express server with real auth middleware
- Start MongoMemoryServer
- Create test tenant with valid API key

**Steps:**

1. POST to create an alert config with valid data
2. Verify the config is persisted in MongoDB with correct tenantId
3. GET to list configs and verify the created config appears
4. PATCH to update the threshold
5. Verify MongoDB reflects the update
6. DELETE the config
7. Verify it's removed from MongoDB

**Assertions:**

- CRUD operations persist correctly in MongoDB
- Tenant isolation is enforced at the database query level (findOne with tenantId)
- Audit log entries are created for each mutation

### INT-6: Webhook Delivery with HMAC Verification

**Objective:** Verify webhook delivery includes correct HMAC-SHA256 signature that can be verified by the receiver.

**Setup:**

- Start a mock HTTP server that captures requests
- Set ALERT_WEBHOOK_SIGNING_SECRET environment variable

**Steps:**

1. Trigger alert delivery to the mock server
2. Capture the request body and X-Alert-Signature header
3. Independently compute HMAC-SHA256 of the body with the same secret
4. Verify the signature matches

**Assertions:**

- X-Alert-Signature header is present
- Signature format is `sha256=<hex>`
- Independent HMAC verification succeeds
- Payload body is valid JSON with expected fields

---

## Existing Test Files

| File                                                             | Package         | Type | Tests |
| ---------------------------------------------------------------- | --------------- | ---- | ----- |
| `packages/eventstore/src/__tests__/alerting-threshold.test.ts`   | eventstore      | Unit | 22    |
| `packages/eventstore/src/__tests__/alerting-scheduler.test.ts`   | eventstore      | Unit | ~25   |
| `packages/pipeline-engine/src/__tests__/alert-evaluator.test.ts` | pipeline-engine | Unit | 7     |
| `apps/runtime/src/__tests__/alert-config-ssrf.test.ts`           | runtime         | Unit | 3     |

## Testing Gaps (Priority Order)

| Priority | Gap                                             | Risk if Untested                                  |
| -------- | ----------------------------------------------- | ------------------------------------------------- |
| P0       | SQL injection via metric/sourceTable            | Arbitrary ClickHouse SQL execution                |
| P0       | E2E alert rule CRUD through HTTP API            | Route registration, middleware chain, auth gaps   |
| P0       | Tenant isolation (E2E)                          | Cross-tenant data leakage                         |
| P1       | Webhook delivery with real HTTP (integration)   | Payload format, HMAC signing, timeout handling    |
| P1       | Alert evaluator with real MongoDB (integration) | Schema validation, index behavior, status updates |
| P1       | Permission enforcement (E2E)                    | Unauthorized access to alert management           |
| P2       | Cooldown with real Redis (integration)          | Cooldown expiry, race conditions                  |
| P2       | Rate limiting on alert endpoints                | DoS via rapid alert rule creation                 |
