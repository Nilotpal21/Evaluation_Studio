# Test Specification: Workflow Connector OAuth2 Dual-Auth

**Feature Spec**: `docs/features/workflow-connector-oauth2-dual-auth.md`
**Feature ID**: F100
**HLD**: `docs/specs/workflow-connector-oauth2-dual-auth.hld.md` (not yet created)
**LLD**: `docs/plans/workflow-connector-oauth2-dual-auth-impl-plan.md` (not yet created)
**Status**: PLANNED
**Last Updated**: 2026-04-20

---

## 1. Coverage Matrix

| FR    | Description                                                                         | Unit | Integration | E2E | Manual | Status     |
| ----- | ----------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Zendesk AP piece patched — Bearer auth (subdomain + accessToken)                    | ⬜   | ⬜          | ⬜  | ⬜     | NOT TESTED |
| FR-2  | Jira AP piece patched — PieceAuth.OAuth2, cloudId-based URL                         | ⬜   | ⬜          | ⬜  | ⬜     | NOT TESTED |
| FR-3  | ServiceNow AP piece installed + patched — Bearer auth (instanceUrl + accessToken)   | ⬜   | ⬜          | ⬜  | ⬜     | NOT TESTED |
| FR-4  | `normalizeAuthForAP()` bridges all 3 connectors × 2 auth types                      | ✅   | —           | —   | —      | NOT TESTED |
| FR-5  | connector-catalog.json exposes oauth2 block for all 3; availableAuthTypes in Studio | —    | ⬜          | —   | ⬜     | NOT TESTED |
| FR-6  | Catalog regenerated and `--check` passes                                            | —    | ⬜          | —   | —      | NOT TESTED |
| FR-7  | Actions execute successfully with OAuth2 auth profile (all 3 connectors)            | —    | —           | ⬜  | ⬜     | NOT TESTED |
| FR-8  | Polling triggers activate and pass auth correctly; trigger path audited             | —    | ⬜          | ⬜  | —      | NOT TESTED |
| FR-9  | pnpm patches committed and re-applied on fresh install                              | —    | ⬜          | —   | ⬜     | NOT TESTED |
| FR-10 | No regressions — build passes, workspace count = 47                                 | —    | ⬜          | —   | —      | NOT TESTED |

---

## 2. E2E Test Scenarios

CRITICAL: All E2E tests must start a real Express server on `{ port: 0 }` with the full connector middleware chain. No `vi.mock()`, no direct Mongoose model access, no stubbed infrastructure. Seed data via HTTP API only.

### E2E-1: Zendesk OAuth2 — Create Ticket

- **File**: `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`
- **Preconditions**: Tenant `t-zendesk-e2e` created. Zendesk OAuth2 auth profile seeded via `POST /api/auth-profiles` with `{ authType: 'oauth2', connectorName: 'zendesk', secrets: { access_token: <token> }, connectionConfig: { subdomain: 'acmehelp-e2e' } }`. Connection record seeded via `POST /api/connections`.
- **Steps**:
  1. `POST /api/connectors/execute` with `{ connectorName: 'zendesk', actionName: 'create_ticket', authProfileId: <id>, params: { subject: 'E2E test ticket', description: 'Created by automated E2E', priority: 'normal' } }` and `Authorization: Bearer <tenant-jwt>`
  2. Assert HTTP 200
  3. Assert response body contains `{ ticketId: <number> }` (integer > 0)
  4. `POST /api/connectors/execute` with a different `tenantId` JWT but same `authProfileId` → assert HTTP 404 (auth profile not found for other tenant)
- **Expected Result**: HTTP 200, `{ ticketId: NNN }` where NNN is a positive integer
- **Auth Context**: `tenantId: t-zendesk-e2e`, no project scope (auth profiles are tenant-scoped)
- **Isolation Check**: Cross-tenant request with same `authProfileId` returns HTTP 404

### E2E-2: Jira OAuth2 — Create Issue

- **File**: `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`
- **Preconditions**: Tenant `t-jira-e2e` created. Jira OAuth2 auth profile seeded with `{ authType: 'oauth2', connectorName: 'jira-cloud', secrets: { access_token: <atlassian-oauth2-token> } }`. Connection seeded.
- **Steps**:
  1. `POST /api/connectors/execute` with `{ connectorName: 'jira-cloud', actionName: 'create_issue', authProfileId: <id>, params: { projectKey: 'TEST', summary: 'E2E test issue from OAuth2', issueType: 'Task' } }` and tenant JWT
  2. Assert HTTP 200
  3. Assert response contains `{ issueId: 'TEST-NNN', issueUrl: 'https://...' }` (string matching `TEST-\d+`)
  4. `GET /api/connectors/actions?connectorName=jira-cloud` → assert `create_issue` appears in the action list
- **Expected Result**: HTTP 200, `{ issueId: 'TEST-NNN', issueUrl: string }`
- **Auth Context**: `tenantId: t-jira-e2e`, JWT with valid tenant claims
- **Isolation Check**: Missing `Authorization` header → HTTP 401

### E2E-3: ServiceNow OAuth2 — Create Incident Record

- **File**: `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`
- **Preconditions**: Tenant `t-snow-e2e`. ServiceNow OAuth2 auth profile seeded with `{ authType: 'oauth2', connectorName: 'servicenow', secrets: { access_token: <token> }, connectionConfig: { subdomain: 'dev12345' } }`.
- **Steps**:
  1. `POST /api/connectors/execute` with `{ connectorName: 'servicenow', actionName: 'create_record', authProfileId: <id>, params: { tableName: 'incident', fields: { short_description: 'E2E test incident', urgency: '3', impact: '3' } } }`
  2. Assert HTTP 200
  3. Assert response contains `{ sys_id: string }` where `sys_id` matches `/^[a-f0-9]{32}$/`
  4. Send same request with `authProfileId` belonging to a different tenant → assert HTTP 404
- **Expected Result**: HTTP 200, `{ sys_id: '<32-char-hex>' }`
- **Auth Context**: `tenantId: t-snow-e2e`, tenant JWT
- **Isolation Check**: Cross-tenant `authProfileId` usage returns HTTP 404

### E2E-4: Zendesk Polling Trigger — Registration and First Poll

- **File**: `packages/connectors/src/__tests__/e2e/connector-trigger-oauth2.e2e.test.ts`
- **Preconditions**: Tenant `t-trig-e2e`. Zendesk OAuth2 auth profile seeded. BullMQ and Redis available (test env Docker).
- **Steps**:
  1. `POST /api/connectors/triggers/register` with `{ connectorName: 'zendesk', triggerName: 'new_ticket', authProfileId: <id>, workflowId: 'wf-e2e-1' }` and tenant JWT
  2. Assert HTTP 200, response contains `{ registrationId: string, status: 'active' }`
  3. Wait for first polling cycle (poll interval ≤ 30s in test config, or trigger manually)
  4. `GET /api/connectors/triggers/<registrationId>` → assert `lastPollAt` is set and `lastError` is null
  5. `DELETE /api/connectors/triggers/<registrationId>` → assert HTTP 200
- **Expected Result**: Trigger registered, first poll executes without auth error, `lastError` remains null
- **Auth Context**: `tenantId: t-trig-e2e`, tenant JWT
- **Isolation Check**: `GET /api/connectors/triggers/<registrationId>` with different tenant JWT returns HTTP 404

### E2E-5: Missing Subdomain → Descriptive Error (Not Silent Undefined)

- **File**: `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`
- **Preconditions**: Tenant `t-subdomain-e2e`. Zendesk OAuth2 auth profile seeded **without** `connectionConfig.subdomain` (omit the field entirely).
- **Steps**:
  1. `POST /api/connectors/execute` with `{ connectorName: 'zendesk', actionName: 'create_ticket', authProfileId: <id>, params: { subject: 'Test' } }`
  2. Assert HTTP 400 or 422 (not 500, not 200)
  3. Assert response body contains `{ error: { code: 'CONNECTOR_AUTH_ERROR', message: <string containing 'subdomain'> } }`
  4. Assert the error message does NOT contain the raw `access_token` value (no credential leakage in error)
- **Expected Result**: HTTP 400/422, structured error with `subdomain` in message, no credential leakage
- **Auth Context**: `tenantId: t-subdomain-e2e`, tenant JWT
- **Isolation Check**: N/A — error path test

### E2E-6: Zendesk API Key — Create Ticket (Alternative Auth Path)

- **File**: `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`
- **Preconditions**: Tenant `t-apikey-e2e`. Zendesk **API key** auth profile seeded via `POST /api/auth-profiles` with `{ authType: 'api_key', connectorName: 'zendesk', secrets: { apiKey: <token> }, connectionConfig: { subdomain: 'acmehelp-e2e' } }`.
- **Steps**:
  1. `POST /api/connectors/execute` with `{ connectorName: 'zendesk', actionName: 'create_ticket', authProfileId: <api-key-profile-id>, params: { subject: 'API key test ticket', description: 'Via api_key auth' } }`
  2. Assert HTTP 200
  3. Assert response contains `{ ticketId: <number> }`
  4. Assert `normalizeAuthForAP()` was routed through the api_key branch: verify no OAuth access token appears in the outgoing Zendesk request (checked via recorded HTTP traffic using `nock` or equivalent in the test harness — injected, not mocked internally)
- **Expected Result**: HTTP 200, `{ ticketId: NNN }` — same response shape as OAuth2 path
- **Auth Context**: `tenantId: t-apikey-e2e`, tenant JWT
- **Isolation Check**: Auth profile from different tenant returns HTTP 404

### E2E-7: Jira Polling Trigger — Auth Flows Through to Trigger Context

- **File**: `packages/connectors/src/__tests__/e2e/connector-trigger-oauth2.e2e.test.ts`
- **Preconditions**: Tenant `t-jira-trig-e2e`. Jira OAuth2 auth profile seeded.
- **Steps**:
  1. `POST /api/connectors/triggers/register` with `{ connectorName: 'jira-cloud', triggerName: 'new_issue', authProfileId: <id>, workflowId: 'wf-jira-1' }` and tenant JWT
  2. Assert HTTP 200, `{ registrationId: string, status: 'active' }`
  3. Wait for first poll (or trigger manually)
  4. `GET /api/connectors/triggers/<registrationId>` → `lastError` is null, `lastPollAt` is set
  5. `DELETE /api/connectors/triggers/<registrationId>` → HTTP 200
- **Expected Result**: Trigger registered and first poll completes without auth error
- **Auth Context**: `tenantId: t-jira-trig-e2e`, tenant JWT
- **Isolation Check**: Cross-tenant trigger registration lookup returns HTTP 404

---

## 3. Integration Test Scenarios

Integration tests use real service instances (MongoMemoryServer, real ConnectorRegistry, real `context-translator.ts`). External services (Jira API, Zendesk API, ServiceNow API) are replaced with lightweight in-memory HTTP doubles injected via dependency injection — no `vi.mock()`.

### INT-1: normalizeAuthForAP — All 6 Branches (Zendesk OAuth2, Zendesk API Key, Jira OAuth2, ServiceNow OAuth2, ServiceNow API Key, Missing Subdomain)

- **File**: `packages/connectors/src/__tests__/context-translator.test.ts`
- **Boundary**: `normalizeAuthForAP(connectorName, authData)` pure function
- **Setup**: None — pure function, no external state
- **Steps**:
  - Branch 1: `normalizeAuthForAP('zendesk', { access_token: 'zd-tok', connection: { connectionConfig: { subdomain: 'acmehelp' } } })` → assert `{ props: { subdomain: 'acmehelp', accessToken: 'zd-tok' } }`
  - Branch 2: `normalizeAuthForAP('zendesk', { apiKey: 'zd-key', connection: { connectionConfig: { subdomain: 'acmehelp' } } })` → assert `{ props: { subdomain: 'acmehelp', accessToken: 'zd-key' } }`
  - Branch 3: `normalizeAuthForAP('jira-cloud', { access_token: 'jira-tok', token_type: 'Bearer' })` → assert `{ access_token: 'jira-tok', token_type: 'Bearer' }` (PieceAuth.OAuth2 top-level shape)
  - Branch 4: `normalizeAuthForAP('servicenow', { access_token: 'sn-tok', connection: { connectionConfig: { subdomain: 'dev12345' } } })` → assert `{ props: { instanceUrl: 'https://dev12345.service-now.com', accessToken: 'sn-tok' } }`
  - Branch 5: `normalizeAuthForAP('servicenow', { apiKey: 'sn-key', connection: { connectionConfig: { subdomain: 'dev12345' } } })` → assert `{ props: { instanceUrl: 'https://dev12345.service-now.com', accessToken: 'sn-key' } }`
  - Branch 6: `normalizeAuthForAP('zendesk', { access_token: 'tok', connection: { connectionConfig: {} } })` → assert throws `ConnectorError` with message matching `/subdomain/`
- **Expected Result**: All 6 branches produce correct output or throw correct error
- **Failure Mode**: N/A — pure function, no external dependencies

### INT-2: Connector Catalog — All 3 Connectors Have oauth2 Block After Patches

- **File**: `packages/connectors/src/__tests__/generate-catalog.test.ts` (extend or new file)
- **Boundary**: `ConnectorRegistry.loadConnectors()` → `generateConnectorSource()` → parsed catalog entries
- **Setup**: Real `ConnectorRegistry`. AP pieces must be installed and patched (test runs after `pnpm install`).
- **Steps**:
  1. `const registry = new ConnectorRegistry(); await registry.loadFromPiecePackages();`
  2. Find Jira, Zendesk, ServiceNow entries in registry
  3. Assert each entry has `auth.type === 'oauth2'` (Jira after patch) or `auth.type === 'custom'` with `oauth2.authorizationUrl` populated (Zendesk/ServiceNow via Nango enrichment)
  4. Assert `catalog.find(c => c.name === 'servicenow')` is not undefined — ServiceNow is registered
- **Expected Result**: All 3 connectors load, Jira shows `oauth2` auth type, Zendesk/ServiceNow show `custom` with populated oauth2 block
- **Failure Mode**: If patches not applied → `auth.type` will be wrong, assertion fails with clear diff

### INT-3: buildIntegrationProviders — availableAuthTypes Contains 'oauth2' for All 3

- **File**: `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts` (new)
- **Boundary**: `buildIntegrationProviders(catalog, nangoProviders)` in `integration-provider-service.ts`
- **Setup**: Load real catalog from `connector-catalog.json` (generated artifact). Load real `providers.json` from `packages/connectors/src/adapters/nango/generated/`.
- **Steps**:
  1. `const providers = buildIntegrationProviders(catalog, nangoProviders);`
  2. `const jira = providers.find(p => p.name === 'jira-cloud');`
  3. Assert `jira.availableAuthTypes` contains `'oauth2'`
  4. Assert `jira.status === 'available'` (not 'unsupported')
  5. Repeat for Zendesk and ServiceNow
- **Expected Result**: All 3 providers have `status: 'available'` and `availableAuthTypes` includes `'oauth2'`
- **Failure Mode**: If `authType: 'custom'` exclusion still blocks → `availableAuthTypes` will be empty → assertion fails

### INT-4: Polling Trigger Auth — processPollingJob Resolves and Passes Auth to Trigger.run()

- **File**: `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts` (extend existing)
- **Boundary**: `processPollingJob()` → `ConnectorRegistry` → `ConnectionResolver` → `trigger.run(ctx)` where `ctx.auth` is the resolved + normalized auth
- **Setup**: MongoMemoryServer for `TriggerRegistration`. Register a test connector with a custom polling trigger that records the `ctx.auth` shape it receives. Seed a `TriggerRegistration` with `connectorName: 'zendesk'` and an OAuth2 connection that has `connectionConfig.subdomain = 'test-sub'`.
- **Steps**:
  1. Call `processPollingJob(jobData, deps)` with the Zendesk registration
  2. Assert `trigger.run()` was called
  3. Assert the `ctx.auth` argument passed to `trigger.run()` has shape `{ props: { subdomain: 'test-sub', accessToken: <expected-token> } }` (normalized by `normalizeAuthForAP()`)
  4. Assert no auth error emitted in the job result
- **Expected Result**: `trigger.run()` receives normalized auth, not raw `{ access_token, ... }`
- **Failure Mode**: If trigger path bypasses `normalizeAuthForAP()` → `ctx.auth` will have raw shape → assertion fails

### INT-5: ConnectorToolExecutor Auth Bridge — Zendesk Action Receives Normalized Props

- **File**: `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` (extend existing)
- **Boundary**: `ConnectorToolExecutor.execute()` → `ConnectionResolver.resolveAuth()` → `normalizeAuthForAP()` → `action.run(ctx)`
- **Setup**: Real `ConnectorRegistry` with a Zendesk connector stub that captures `ctx.auth`. Real `ConnectionResolver` backed by MongoMemoryServer. Auth profile in DB has `{ access_token: 'bearer-123', connection: { connectionConfig: { subdomain: 'testdomain' } } }`.
- **Steps**:
  1. Create a Zendesk connection record and OAuth2 auth profile in the test database
  2. Call `executor.execute({ connectorName: 'zendesk', actionName: 'captured_action', authProfileId: <id>, params: {}, tenantId: 't-1' })`
  3. Assert `action.run()` was called with `ctx.auth = { props: { subdomain: 'testdomain', accessToken: 'bearer-123' } }`
- **Expected Result**: `action.run()` receives correctly shaped auth props
- **Failure Mode**: If `normalizeAuthForAP()` not wired into executor → `ctx.auth` will be raw credential object

### INT-6: ServiceNow instanceUrl Construction — subdomain → full HTTPS URL

- **File**: `packages/connectors/src/__tests__/context-translator.test.ts`
- **Boundary**: `normalizeAuthForAP()` ServiceNow branch
- **Setup**: None — pure function
- **Steps**:
  1. `normalizeAuthForAP('servicenow', { access_token: 'tok', connection: { connectionConfig: { subdomain: 'mycompany' } } })`
  2. Assert `result.props.instanceUrl === 'https://mycompany.service-now.com'`
  3. `normalizeAuthForAP('servicenow', { access_token: 'tok', connection: { connectionConfig: { subdomain: 'dev99999' } } })`
  4. Assert `result.props.instanceUrl === 'https://dev99999.service-now.com'`
  5. `normalizeAuthForAP('servicenow', { access_token: 'tok', connection: { connectionConfig: {} } })` → assert throws with message matching `/subdomain|instanceUrl/`
- **Expected Result**: `instanceUrl` is always `https://<subdomain>.service-now.com`, missing subdomain throws
- **Failure Mode**: Hardcoded URL construction fails → integration with ServiceNow returns 401/404

### INT-7: pnpm Patch Application Verification — Patched Files Differ from npm Originals

- **File**: `packages/connectors/src/__tests__/patch-application.test.ts` (new)
- **Boundary**: Installed AP piece node_modules vs npm-original source
- **Setup**: Run after `pnpm install` in CI. Patches must be applied.
- **Steps**:
  1. `import { zendeskAuth } from '@activepieces/piece-zendesk'` → assert `zendeskAuth.props` has `accessToken` field, NOT `token` field
  2. `import { jiraCloudAuth } from '@activepieces/piece-jira-cloud'` → assert `jiraCloudAuth.type === 'OAUTH2'` (not `CUSTOM_AUTH`)
  3. `import { servicenowAuth } from '@activepieces/piece-service-now'` → assert `servicenowAuth.props` has `accessToken` field, NOT `password` field
- **Expected Result**: All 3 patches applied, auth fields match expected shapes
- **Failure Mode**: Patches not in `patchedDependencies` or patch files corrupted → original auth shapes → assertions fail

---

## 4. Unit Test Scenarios

All unit tests in `packages/connectors/src/__tests__/context-translator.test.ts`. These are pure-function tests — zero mocks, zero DI, zero infrastructure.

### UT-1: normalizeAuthForAP — Zendesk OAuth2 Shape

- **Module**: `packages/connectors/src/adapters/activepieces/context-translator.ts`
- **Input**: `('zendesk', { access_token: 'tok-abc', connection: { connectionConfig: { subdomain: 'acmehelp' } } })`
- **Expected Output**: `{ props: { subdomain: 'acmehelp', accessToken: 'tok-abc' } }`
- **Invariant**: `token`, `email`, `apiKey` fields must NOT appear in output

### UT-2: normalizeAuthForAP — Zendesk API Key Shape

- **Module**: `context-translator.ts`
- **Input**: `('zendesk', { apiKey: 'zd-token-xyz', connection: { connectionConfig: { subdomain: 'acmehelp' } } })`
- **Expected Output**: `{ props: { subdomain: 'acmehelp', accessToken: 'zd-token-xyz' } }`
- **Invariant**: Output field is `accessToken`, not `token` or `apiKey`

### UT-3: normalizeAuthForAP — Jira OAuth2 Pass-through

- **Module**: `context-translator.ts`
- **Input**: `('jira-cloud', { access_token: 'atlassian-tok-123', token_type: 'Bearer', scope: 'read:jira-work' })`
- **Expected Output**: `{ access_token: 'atlassian-tok-123', token_type: 'Bearer', scope: 'read:jira-work' }` (unchanged top-level shape for PieceAuth.OAuth2)
- **Invariant**: Shape must be PieceAuth.OAuth2 top-level — no `props` wrapper

### UT-4: normalizeAuthForAP — ServiceNow OAuth2 instanceUrl Construction

- **Module**: `context-translator.ts`
- **Input**: `('servicenow', { access_token: 'sn-tok-456', connection: { connectionConfig: { subdomain: 'dev12345' } } })`
- **Expected Output**: `{ props: { instanceUrl: 'https://dev12345.service-now.com', accessToken: 'sn-tok-456' } }`
- **Invariant**: `instanceUrl` is always `https://<subdomain>.service-now.com` — no bare subdomain passed

### UT-5: normalizeAuthForAP — ServiceNow API Key Shape

- **Module**: `context-translator.ts`
- **Input**: `('servicenow', { apiKey: 'sn-api-789', connection: { connectionConfig: { subdomain: 'dev12345' } } })`
- **Expected Output**: `{ props: { instanceUrl: 'https://dev12345.service-now.com', accessToken: 'sn-api-789' } }`
- **Invariant**: `instanceUrl` constructed, `accessToken` receives API key value

### UT-6: normalizeAuthForAP — Missing Subdomain Throws ConnectorError

- **Module**: `context-translator.ts`
- **Input**: `('zendesk', { access_token: 'tok', connection: { connectionConfig: {} } })`
- **Expected Output**: Throws `ConnectorError` (or equivalent) with message matching `/subdomain/i`
- **Invariant**: Error must reference `subdomain` explicitly — no generic "invalid auth" message

### UT-7: normalizeAuthForAP — Unknown Connector Falls Through (Backward Compatibility)

- **Module**: `context-translator.ts`
- **Input**: `('github', { apiKey: 'gh-tok' })` (existing connector, not in the new branches)
- **Expected Output**: `{ apiKey: 'gh-tok', secret_text: 'gh-tok' }` (existing fallback behavior preserved)
- **Invariant**: New connector-keyed dispatch must not break existing connectors

---

## 5. Security & Isolation Tests

### Auth Profile Tenant Isolation

- [ ] `POST /api/connectors/execute` with `authProfileId` belonging to tenant A, called with tenant B JWT → HTTP 404 (not 403 — do not leak existence)
- [ ] `GET /api/connectors/triggers/<registrationId>` with different tenant JWT → HTTP 404
- [ ] `normalizeAuthForAP()` output must not include raw `access_token` or `apiKey` in any log entry — verify via log capture in test

### Auth Header Requirements

- [ ] `POST /api/connectors/execute` without `Authorization` header → HTTP 401
- [ ] `POST /api/connectors/triggers/register` without `Authorization` header → HTTP 401

### Credential Leakage Prevention

- [ ] Error response for missing subdomain (E2E-5) must not contain `access_token` or `apiKey` values in the response body
- [ ] When `normalizeAuthForAP()` throws, the error message must reference only field names (e.g., `subdomain`), not credential values

### Input Validation

- [ ] `POST /api/connectors/execute` with `connectorName: ''` (empty string) → HTTP 400 with validation error
- [ ] `POST /api/connectors/execute` with `authProfileId: ''` → HTTP 400 (Zod `z.string().min(1)` enforced)
- [ ] `POST /api/connectors/execute` with unknown `connectorName` → HTTP 404 with `{ error: { code: 'CONNECTOR_NOT_FOUND' } }`

---

## 6. Performance & Load Tests

Not required for alpha promotion. The following are tracked as future work:

- Jira cloudId cache hit rate under concurrent action execution (GAP-002 — per-execution `ctx.store` cache acceptable for alpha)
- Concurrent OAuth2 token refresh during execution (covered by existing `oauth-refresh-lock.integration.test.ts`)

---

## 7. Test Infrastructure

### Required Services

| Service             | Purpose                                      | How Started                                                          |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| MongoMemoryServer   | Real MongoDB for integration + E2E tests     | `mongodb-memory-server` npm package (already used in existing tests) |
| Redis (BullMQ)      | Polling trigger queue (E2E-4, E2E-7)         | Docker: `redis:7-alpine` via `docker-compose.yml`                    |
| Express (port 0)    | Real HTTP server for E2E scenarios           | Inline in test setup — `app.listen(0)`                               |
| AP pieces (patched) | Real `@activepieces/piece-*` in node_modules | Requires `pnpm install` with patches applied                         |

### Data Seeding

E2E tests seed all data via HTTP API:

- `POST /api/auth-profiles` — create OAuth2 or API key auth profile (encrypted storage)
- `POST /api/connections` — bind connector to auth profile
- `DELETE /api/auth-profiles/:id` — cleanup in `afterEach`

No direct Mongoose model access in test files.

### Environment Variables

| Variable                | Test Value                    | Purpose                 |
| ----------------------- | ----------------------------- | ----------------------- |
| `MONGO_URI`             | Provided by MongoMemoryServer | Database connection     |
| `REDIS_URL`             | `redis://localhost:6379`      | BullMQ trigger queue    |
| `JWT_SECRET`            | Test-only shared secret       | Auth middleware         |
| `ENCRYPTION_MASTER_KEY` | Test-only 32-byte hex key     | Auth profile encryption |

All must be set in test setup (`.env.test` or inline `process.env` in `beforeAll`).

### CI Configuration

Tests run under `pnpm test --filter=@agent-platform/connectors`. E2E tests are tier-2 (require Docker services). Integration tests are tier-1 (MongoMemoryServer only).

---

## 8. Test File Mapping

| Test File                                                                                            | Type        | Covers FRs                   |
| ---------------------------------------------------------------------------------------------------- | ----------- | ---------------------------- |
| `packages/connectors/src/__tests__/context-translator.test.ts`                                       | unit        | FR-4 (all 6 branches)        |
| `packages/connectors/src/__tests__/patch-application.test.ts`                                        | integration | FR-1, FR-2, FR-3, FR-9       |
| `packages/connectors/src/__tests__/generate-catalog.test.ts` (extend)                                | integration | FR-5, FR-6                   |
| `apps/studio/src/lib/__tests__/integration-provider-service.integration.test.ts`                     | integration | FR-5                         |
| `packages/connectors/src/__tests__/integration/executor-resolver-chain.integration.test.ts` (extend) | integration | FR-4, FR-7                   |
| `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts` (extend)         | integration | FR-8                         |
| `packages/connectors/src/__tests__/e2e/connector-oauth2-actions.e2e.test.ts`                         | e2e         | FR-1, FR-2, FR-3, FR-4, FR-7 |
| `packages/connectors/src/__tests__/e2e/connector-trigger-oauth2.e2e.test.ts`                         | e2e         | FR-8                         |

---

## 9. Open Testing Questions

1. **Real vs simulated Zendesk/Jira/ServiceNow API in E2E**: The E2E scenarios above describe interactions with real external APIs. For CI purposes, should the E2E tests be marked as `@manual` (run only with real credentials) or should a lightweight HTTP stub server be injected at the AP piece HTTP client level (via DI, not `vi.mock`)? Decision needed before E2E test implementation.

2. **Trigger poll interval in tests**: `processPollingJob()` integration test (INT-4) requires either waiting for a real poll cycle or injecting a short interval. The existing `polling-trigger.integration.test.ts` calls `processPollingJob()` directly — confirm that the E2E-4 scenario can use the same direct-call approach while still going through the real HTTP server.

3. **ServiceNow AP piece action inventory**: `@activepieces/piece-service-now@0.1.3` action names must be verified against the installed package before writing E2E-3 `actionName: 'create_record'` — the actual action name may differ. Update E2E-3 once GAP-004 is resolved.

4. **API key path in Studio for Zendesk**: INT-3 asserts `availableAuthTypes` includes `'api_key'` for Zendesk/ServiceNow, but GAP-001 (no `zendesk-api-key` Nango provider) may prevent this. If GAP-001 is unresolved at implementation time, INT-3 should assert `['oauth2']` only and a separate test should track api_key when the gap is closed.

---

## 10. Manual Verification Checklist (Alpha Promotion)

- [ ] Studio Integrations catalog: Jira Cloud shows `Available` badge with `OAuth2` option
- [ ] Studio Integrations catalog: Zendesk shows `Available` badge with `OAuth2` and `API Key` options
- [ ] Studio Integrations catalog: ServiceNow shows `Available` badge with `OAuth2` option
- [ ] Create Jira OAuth2 auth profile → Atlassian OAuth2 3LO flow completes, profile saved
- [ ] Create Zendesk OAuth2 auth profile → Zendesk OAuth2 flow completes, profile saved
- [ ] Create ServiceNow OAuth2 auth profile → flow completes, profile saved
- [ ] Add Jira "Create Issue" step to a workflow → select OAuth2 auth profile → execute → issue created in Jira
- [ ] Add Zendesk "Create Ticket" step to workflow → select OAuth2 auth profile → execute → ticket created
- [ ] Add ServiceNow "Create Record" step to workflow → select OAuth2 auth profile → execute → record created
- [ ] `pnpm build --filter=@agent-platform/connectors` passes after all changes
- [ ] `pnpm test --filter=@agent-platform/shared-kernel` passes (workspace count = 47)
