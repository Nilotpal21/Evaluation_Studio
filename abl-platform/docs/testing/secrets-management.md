# Testing Guide: Secrets Management

**Feature**: [Secrets Management](../features/secrets-management.md)
**Status**: NOT STARTED
**Last Updated**: 2026-03-23

---

## 1. Quick Health Dashboard

| Dimension           | Status      | Notes                                                    |
| ------------------- | ----------- | -------------------------------------------------------- |
| Unit tests          | NOT STARTED | 0/8 planned test files implemented                       |
| Integration tests   | NOT STARTED | 0/7 planned test files implemented                       |
| E2E tests           | NOT STARTED | 0/8 planned test files implemented                       |
| Manual tests        | NOT STARTED | 0/4 planned manual test scenarios executed               |
| CI/CD integration   | NOT STARTED | No test pipeline configured for secrets management       |
| Test infrastructure | NOT STARTED | Vault dev server, mock AWS/Azure/GCP not yet provisioned |

**Overall Health: RED** -- Feature is in PLANNED status. No tests exist yet.

---

## 2. Coverage Matrix

| FR    | Description                                           | Unit | Integration | E2E | Manual | Status     |
| ----- | ----------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Secret CRUD with encrypted storage                    | P    | P           | P   | --     | NOT TESTED |
| FR-2  | Access policy enforcement (RBAC)                      | P    | P           | P   | --     | NOT TESTED |
| FR-3  | Secret version history and rollback                   | P    | --          | P   | --     | NOT TESTED |
| FR-4  | Automated rotation with dual-credential pattern       | P    | P           | P   | --     | NOT TESTED |
| FR-5  | Zero-downtime rotation with verification              | P    | P           | P   | --     | NOT TESTED |
| FR-6  | Manual rotation via API                               | P    | --          | P   | --     | NOT TESTED |
| FR-7  | Secret expiration enforcement                         | P    | P           | --  | --     | NOT TESTED |
| FR-8  | Secret revocation with cascade                        | P    | P           | P   | --     | NOT TESTED |
| FR-9  | Audit logging for all secret operations               | P    | P           | P   | --     | NOT TESTED |
| FR-10 | External secret store sync (Vault, AWS, Azure, GCP)   | P    | P           | P   | P      | NOT TESTED |
| FR-11 | Dynamic secret generation and lease management        | P    | P           | P   | --     | NOT TESTED |
| FR-12 | `{{secret.PATH}}` resolution in DSL/runtime           | P    | P           | P   | --     | NOT TESTED |
| FR-13 | Break-glass emergency access                          | P    | --          | P   | P      | NOT TESTED |
| FR-14 | Secret types (static, generated, dynamic, synced)     | P    | --          | P   | --     | NOT TESTED |
| FR-15 | Secret metadata (tags, description, linked consumers) | P    | --          | P   | --     | NOT TESTED |
| FR-16 | Cross-project secret sharing                          | P    | P           | P   | --     | NOT TESTED |
| FR-17 | Migration from env vars / auth profiles               | P    | P           | --  | P      | NOT TESTED |
| FR-18 | Secret value masking in responses/logs/traces         | P    | --          | P   | --     | NOT TESTED |

**Legend**: P = Planned, -- = Not applicable for this coverage type

---

## 3. E2E Test Scenarios (Mandatory -- minimum 5)

### E2E-1: Secret CRUD Lifecycle via HTTP API

**Objective**: Verify the complete lifecycle of a secret (create, read, update, rotate, revoke, destroy) through the HTTP API with encryption at rest.

**Prerequisites**: Running Runtime server with `ENCRYPTION_MASTER_KEY` and `SECRETS_MANAGEMENT_ENABLED=true`, authenticated user with tenant and project context.

**Steps**:

1. POST `/api/projects/:projectId/secrets` with:
   ```json
   {
     "path": "integrations/crm-api-key",
     "name": "CRM API Key",
     "type": "static",
     "value": "sk-test-crm-key-abc123",
     "description": "CRM integration API key",
     "tags": ["integration", "crm"],
     "accessPolicy": {
       "defaultAccess": "deny",
       "grants": [
         {
           "granteeType": "project",
           "granteeId": ":projectId",
           "permissions": ["read"]
         }
       ]
     }
   }
   ```
2. Assert 201 response. Verify response contains `id`, `path`, `name`, `status: 'active'`, `type: 'static'` but NOT the secret value.
3. Query MongoDB directly: verify `encryptedValue` contains ciphertext (not plaintext `sk-test-crm-key-abc123`). Verify `ire` field is `'v3'`.
4. GET `/api/projects/:projectId/secrets/:secretId` -- assert metadata returned without value.
5. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert decrypted value matches `sk-test-crm-key-abc123`.
6. PUT `/api/projects/:projectId/secrets/:secretId/value` with `{ "value": "sk-test-crm-key-xyz789", "reason": "manual-rotation" }`.
7. Assert 200, verify version incremented to 2.
8. GET `/api/projects/:projectId/secrets/:secretId/versions` -- assert 2 versions listed, version 2 is active, version 1 is `grace` or `inactive`.
9. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert returns new value `sk-test-crm-key-xyz789`.
10. POST `/api/projects/:projectId/secrets/:secretId/revoke` with `{ "reason": "compromised" }`.
11. Assert 200, verify status changed to `revoked`.
12. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert 403 or 410 (secret revoked).
13. DELETE `/api/projects/:projectId/secrets/:secretId`.
14. Assert 200, verify status changed to `destroyed`.
15. GET `/api/projects/:projectId/secrets/:secretId` -- assert 404.

**Expected Result**: Full lifecycle works end-to-end. Values are encrypted in DB, decrypted on read, and inaccessible after revocation/destruction. Version history is maintained throughout.

**Validates**: FR-1, FR-3, FR-8, FR-14, FR-18

---

### E2E-2: Tenant and Project Isolation

**Objective**: Verify that secrets are strictly isolated by tenant and project. Cross-tenant and cross-project access returns 404 (not 403).

**Prerequisites**: Two tenants (A and B) with authenticated users. Tenant A has two projects (P1 and P2). `SECRETS_MANAGEMENT_ENABLED=true`.

**Steps**:

1. As Tenant A / Project P1, POST `/api/projects/:p1Id/secrets` to create a secret at path `db/password`.
2. Assert 201. Record `secretId`.
3. As Tenant A / Project P1, GET `/api/projects/:p1Id/secrets/:secretId/value` -- assert 200 with the decrypted value.
4. As Tenant B, GET `/api/projects/:p1Id/secrets/:secretId` -- assert 404 (not 403).
5. As Tenant B, GET `/api/projects/:p1Id/secrets/:secretId/value` -- assert 404.
6. As Tenant A / Project P2 (no cross-project grant), GET `/api/projects/:p1Id/secrets/:secretId` -- assert 404.
7. As Tenant A / Project P2, attempt to list secrets for P1 via GET `/api/projects/:p1Id/secrets` -- assert 404 or empty list (depending on auth middleware behavior).
8. As Tenant A / Project P1, grant cross-project read to P2:
   ```json
   {
     "granteeType": "project",
     "granteeId": ":p2Id",
     "permissions": ["read"]
   }
   ```
9. As Tenant A / Project P2, GET the secret value through the cross-project grant mechanism -- assert 200.
10. As Tenant B, attempt the same cross-project access -- assert 404 (tenant boundary is absolute).

**Expected Result**: Tenant isolation is enforced at the query level (`tenantId` in every filter). Cross-project access is denied by default and only works with explicit grants within the same tenant. Cross-tenant access always returns 404 to avoid leaking resource existence.

**Validates**: FR-1, FR-2, FR-16

---

### E2E-3: Secret Rotation with Zero-Downtime Dual-Credential Pattern

**Objective**: Verify that automated and manual rotation creates a new version, keeps the old version valid during the grace period, and transitions correctly after the grace period expires.

**Prerequisites**: Running Runtime and rotation worker. `SECRETS_MANAGEMENT_ENABLED=true`. A mock verification endpoint that validates credentials.

**Steps**:

1. Create a secret with rotation schedule:
   ```json
   {
     "path": "api/service-key",
     "type": "static",
     "value": "original-key-v1",
     "rotationSchedule": {
       "enabled": true,
       "intervalDays": 1,
       "gracePeriodHours": 1,
       "verificationEndpoint": "http://localhost:{{mockPort}}/verify",
       "verificationMethod": "POST"
     }
   }
   ```
2. Assert 201. Record `secretId`. Verify `rotationSchedule.nextRotationAt` is set to ~1 day from now.
3. POST `/api/projects/:projectId/secrets/:secretId/rotate` with `{ "newValue": "rotated-key-v2" }` to trigger manual rotation.
4. Assert 200. Verify response indicates `status: 'rotating'`.
5. GET `/api/projects/:projectId/secrets/:secretId/versions` -- assert two versions exist:
   - Version 2: status `active`
   - Version 1: status `grace`
6. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert returns `rotated-key-v2` (the new active value).
7. Verify that version 1 (`original-key-v1`) is still valid during the grace period by checking the versions endpoint shows `grace` status.
8. Simulate the mock verification endpoint returning success for the new key.
9. Wait for the grace period to expire (or advance the BullMQ delayed job in test).
10. GET `/api/projects/:projectId/secrets/:secretId/versions` -- assert version 1 is now `inactive`.
11. Verify audit log contains entries for: `rotate_started`, `rotate_verified`, `rotate_completed`, `version_deactivated`.

**Expected Result**: Rotation creates a new version immediately. The old version remains valid during the grace period. After the grace period, the old version is deactivated. Audit events track every step.

**Validates**: FR-4, FR-5, FR-6, FR-9

---

### E2E-4: Rotation Rollback on Verification Failure

**Objective**: Verify that when the verification endpoint rejects the new secret value, the rotation engine rolls back to the previous version.

**Prerequisites**: Running Runtime and rotation worker. Mock verification endpoint configured to return failure.

**Steps**:

1. Create a secret at path `api/verified-key` with value `working-key-v1`.
2. Configure the mock verification endpoint to return HTTP 401 (unauthorized) for any new credential.
3. POST `/api/projects/:projectId/secrets/:secretId/rotate` with `{ "newValue": "bad-key-v2" }`.
4. Assert rotation starts (status `rotating`).
5. Wait for the verification step to execute and fail.
6. GET `/api/projects/:projectId/secrets/:secretId` -- assert status is back to `active` (not `rotating`).
7. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert returns `working-key-v1` (the original value).
8. GET `/api/projects/:projectId/secrets/:secretId/versions` -- assert:
   - Version 1: status `active` (restored)
   - Version 2: status `inactive` or `destroyed` (rolled back)
9. Verify audit log contains entries for: `rotate_started`, `rotate_verification_failed`, `rotate_rollback`.

**Expected Result**: Failed verification triggers automatic rollback. The original value is restored. No downtime occurs. Audit trail records the failure and rollback.

**Validates**: FR-4, FR-5, FR-9

---

### E2E-5: External Secret Store Sync (HashiCorp Vault)

**Objective**: Verify that secrets can be synced from an external HashiCorp Vault instance to the platform secret store.

**Prerequisites**: HashiCorp Vault dev server running in Docker (`vault server -dev`). `SECRETS_MANAGEMENT_ENABLED=true`. External sync worker running.

**Steps**:

1. Start HashiCorp Vault dev server: `docker run --cap-add=IPC_LOCK -e 'VAULT_DEV_ROOT_TOKEN_ID=test-token' -p 8200:8200 hashicorp/vault:latest`.
2. Write a test secret to Vault: `vault kv put secret/platform/api-key value=vault-secret-123`.
3. POST `/api/admin/secrets/stores` to configure the external store:
   ```json
   {
     "name": "dev-vault",
     "providerType": "hashicorp-vault",
     "connectionConfig": {
       "vaultAddr": "http://localhost:8200",
       "authMethod": "token",
       "token": "test-token"
     },
     "syncIntervalSeconds": 10
   }
   ```
4. Assert 201. Record `storeId`.
5. POST `/api/admin/secrets/stores/:storeId/test` -- assert connectivity test passes.
6. Create a synced secret:
   ```json
   {
     "path": "vault/api-key",
     "type": "synced",
     "externalSync": {
       "storeConfigId": ":storeId",
       "externalPath": "secret/data/platform/api-key",
       "syncDirection": "pull"
     }
   }
   ```
7. Assert 201. Wait for sync worker to execute (poll or wait for sync interval).
8. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert value is `vault-secret-123` (pulled from Vault).
9. Update the Vault secret: `vault kv put secret/platform/api-key value=vault-secret-456`.
10. Wait for the next sync cycle.
11. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert value is now `vault-secret-456`.
12. Verify audit log contains `external_sync` events for both sync operations.
13. Verify the secret metadata shows `externalSync.syncStatus: 'synced'` and `externalSync.lastSyncedAt` is recent.

**Expected Result**: Secrets are pulled from Vault and stored encrypted in the platform. Updates in Vault are reflected after the sync interval. Audit trail records all sync operations.

**Validates**: FR-10, FR-9

---

### E2E-6: Secret Access Audit Trail

**Objective**: Verify that every secret operation generates a structured audit event in the audit logging system.

**Prerequisites**: Running Runtime with ClickHouse for audit storage. `SECRETS_MANAGEMENT_ENABLED=true`.

**Steps**:

1. Create a secret at path `audit/test-key` with value `audit-test-value`.
2. GET `/api/projects/:projectId/secrets/:secretId/value` -- read the secret value.
3. PUT `/api/projects/:projectId/secrets/:secretId/value` with `{ "value": "audit-test-value-v2" }` -- update the value.
4. POST `/api/projects/:projectId/secrets/:secretId/rotate` with `{ "newValue": "audit-test-value-v3" }` -- rotate.
5. As a different user without access policy grant, attempt GET `/api/projects/:projectId/secrets/:secretId/value` -- expect 403.
6. GET `/api/projects/:projectId/secrets/:secretId/audit` -- retrieve audit trail for this secret.
7. Assert audit trail contains exactly these events in order:
   - `secret_created` -- actor is the creating user, resourceId is the secretId
   - `secret_read` -- actor is the reading user, includes IP address
   - `secret_updated` -- actor is the updating user, reason recorded
   - `secret_rotate_started` -- actor is the rotating user
   - `secret_rotate_completed` -- actor is `system:rotation-engine`
   - `secret_access_denied` -- actor is the unauthorized user, includes IP address
8. Verify each audit event contains: `id`, `tenantId`, `projectId`, `secretId`, `actorId`, `actorType`, `action`, `ipAddress`, `timestamp`, `traceId`.
9. Verify the `secret_access_denied` event includes the reason for denial.
10. Query ClickHouse directly to verify events are persisted (not just in-memory).

**Expected Result**: Every secret operation generates a structured, queryable audit event. Access denials are logged with full context. Events are persisted to ClickHouse.

**Validates**: FR-9, FR-2, FR-18

---

### E2E-7: Break-Glass Emergency Access

**Objective**: Verify that break-glass access allows authorized operators to read revoked/expired secrets with elevated audit logging and immediate alerting.

**Prerequisites**: Running Runtime. A secret in `revoked` status. A user with `secret:break-glass` permission. Mock webhook endpoint for alerts.

**Steps**:

1. Create a secret at path `emergency/critical-key` with value `critical-value`.
2. POST `/api/projects/:projectId/secrets/:secretId/revoke` with `{ "reason": "potential-compromise" }`.
3. Assert secret status is `revoked`.
4. GET `/api/projects/:projectId/secrets/:secretId/value` -- assert 403 or 410 (secret revoked, normal access blocked).
5. As a user with `secret:break-glass` permission, POST `/api/projects/:projectId/secrets/:secretId/break-glass` with:
   ```json
   {
     "reason": "Incident IR-2026-0342: need to verify if key was used in unauthorized access",
     "ticketId": "IR-2026-0342"
   }
   ```
6. Assert 200. Verify response contains the decrypted secret value `critical-value`.
7. Verify the mock webhook endpoint received an immediate alert containing:
   - Actor who performed break-glass access
   - Secret path and ID
   - Reason and ticket ID
   - Timestamp
8. GET `/api/projects/:projectId/secrets/:secretId/audit` -- verify a `break_glass_access` audit event exists with:
   - Elevated audit category (distinct from normal reads)
   - Mandatory reason field populated
   - Ticket ID in metadata
   - Actor identity and IP address
9. As a user WITHOUT `secret:break-glass` permission, attempt the same break-glass endpoint -- assert 403.

**Expected Result**: Break-glass access works for authorized operators even on revoked secrets. Immediate alert is sent. Elevated audit event is recorded. Unauthorized users cannot use break-glass.

**Validates**: FR-13, FR-9

---

### E2E-8: DSL Secret Reference Resolution

**Objective**: Verify that `{{secret.PATH}}` references in agent DSL are resolved at runtime with the correct secret value for the deployment environment.

**Prerequisites**: Running Runtime with compiler. Secrets created for multiple environments. Agent DSL using `{{secret.PATH}}` syntax.

**Steps**:

1. Create secrets for different environments:
   - `POST` secret at path `llm/openai-key` with environment `dev`, value `sk-dev-key-111`
   - `POST` secret at path `llm/openai-key` with environment `production`, value `sk-prod-key-222`
   - `POST` secret at path `llm/openai-key` with environment `null` (base), value `sk-base-key-000`
2. Create an agent DSL that references `{{secret.llm/openai-key}}` in its MODEL credentials section.
3. Deploy the agent to the `dev` environment.
4. Trigger agent execution in `dev` environment.
5. Verify the runtime resolved `{{secret.llm/openai-key}}` to `sk-dev-key-111` (the dev-environment value).
6. Deploy the agent to the `production` environment.
7. Trigger agent execution in `production` environment.
8. Verify the runtime resolved `{{secret.llm/openai-key}}` to `sk-prod-key-222` (the production-environment value).
9. Delete the `dev` environment secret. Trigger agent execution in `dev` environment again.
10. Verify the runtime falls back to the base value `sk-base-key-000`.
11. Verify audit logs show `secret_read` events for each resolution with the correct environment context.

**Expected Result**: Secret references resolve to the correct environment-specific value. Base values serve as fallbacks. Resolution is transparent to the agent DSL author.

**Validates**: FR-12, FR-1

---

## 4. Integration Test Scenarios (Mandatory -- minimum 5)

### INT-1: Rotation Engine with BullMQ Worker

**Objective**: Verify that the rotation engine correctly schedules, executes, and completes rotations via BullMQ jobs.

**Prerequisites**: Redis for BullMQ. MongoDB with encryption configured.

**Steps**:

1. Start the rotation worker process.
2. Create a secret with `rotationSchedule.enabled: true` and `nextRotationAt` set to 5 seconds from now.
3. Wait for the BullMQ job to fire.
4. Verify the rotation worker:
   a. Creates a new version with status `active`
   b. Moves the previous version to status `grace`
   c. Schedules a delayed job for grace period expiration
   d. Updates `rotationSchedule.lastRotatedAt` and `rotationSchedule.nextRotationAt`
5. Advance time past the grace period (or process the delayed job).
6. Verify the previous version transitions to `inactive`.
7. Verify the secret's `status` returns to `active` (not `rotating`).
8. Verify no secret values are present in BullMQ job data (only metadata references).

**Expected Result**: Rotation lifecycle is fully managed by BullMQ workers. Jobs are scheduled correctly. Grace periods are enforced. Secret values never appear in queue data.

**Validates**: FR-4, FR-5

---

### INT-2: Secret Expiration Worker

**Objective**: Verify that the expiration worker detects and enforces secret expiration.

**Prerequisites**: Redis for BullMQ. MongoDB with secrets at various expiration states.

**Steps**:

1. Create three secrets:
   a. Secret A: `expiresAt` 30 days from now (should trigger 30-day alert)
   b. Secret B: `expiresAt` 1 day from now (should trigger 1-day alert)
   c. Secret C: `expiresAt` 1 hour ago (should be expired immediately)
2. Start the expiration worker.
3. Wait for the worker to process.
4. Verify Secret A: status remains `active`, an alert event is emitted for "approaching expiration (30 days)".
5. Verify Secret B: status remains `active`, an alert event is emitted for "approaching expiration (1 day)".
6. Verify Secret C: status transitions to `expired`. An `secret_expired` audit event is emitted. Attempts to read the value return an error.
7. Verify alert notifications were sent (check webhook mock or in-memory alert sink).

**Expected Result**: Expiration worker correctly identifies and processes secrets at various expiration stages. Alerts are sent at configured thresholds. Expired secrets become unreadable.

**Validates**: FR-7, FR-9

---

### INT-3: Cache Invalidation via Redis Pub/Sub

**Objective**: Verify that secret value cache entries are invalidated across pods when a secret is updated.

**Prerequisites**: Redis for pub/sub. Two simulated pod instances (two service instances with separate caches).

**Steps**:

1. Create a secret at path `cache/test-key` with value `original-value`.
2. Pod A: GET the secret value. Verify it is cached (second GET is faster / does not hit DB).
3. Pod B: GET the secret value. Verify it is cached.
4. Update the secret value to `updated-value` via Pod A.
5. Verify Pod A publishes an invalidation message to Redis pub/sub channel `secret:invalidate`.
6. Pod B: verify cache entry for `cache/test-key` is invalidated within 1 second.
7. Pod B: GET the secret value. Verify it returns `updated-value` (fetched from DB, re-cached).
8. Verify cache metrics show: cache hit (step 2, second GET), cache miss (step 7).

**Expected Result**: Cache invalidation propagates across pods via Redis pub/sub. Stale values are evicted promptly. Cache metrics are accurate.

**Validates**: FR-1 (performance), FR-18 (consistency)

---

### INT-4: Dynamic Secret Lease Lifecycle (MongoDB Provider)

**Objective**: Verify that the MongoDB dynamic secret provider creates temporary database users, manages leases, and revokes credentials on expiry.

**Prerequisites**: MongoDB instance for the dynamic secret target (separate from platform DB). Redis for BullMQ.

**Steps**:

1. Configure a dynamic secret:
   ```json
   {
     "path": "db/mongo-temp-user",
     "type": "dynamic",
     "dynamicConfig": {
       "providerId": "mongodb",
       "leaseTtlSeconds": 60,
       "maxLeases": 3,
       "backendConfig": {
         "connectionUri": "mongodb://admin:admin@localhost:27018/testdb",
         "roles": [{ "role": "readWrite", "db": "testdb" }]
       }
     }
   }
   ```
2. Request a lease: GET `/api/projects/:projectId/secrets/:secretId/value` (or dedicated lease endpoint).
3. Verify response contains a unique `username` and `password` (generated credentials).
4. Verify the generated credentials can connect to the target MongoDB and read/write from `testdb`.
5. Verify `secret_leases` collection has a new entry with `status: 'active'` and `expiresAt` set to 60 seconds from now.
6. Request two more leases (total 3, at `maxLeases`).
7. Request a fourth lease -- verify it is denied (max leases exceeded).
8. Wait for the first lease to expire (or advance time).
9. Verify the lease worker revokes the expired lease's MongoDB user.
10. Verify the expired credentials can no longer connect to MongoDB.
11. Verify `secret_leases` entry transitions to `status: 'expired'`.

**Expected Result**: Dynamic secrets generate unique, short-lived credentials. Lease limits are enforced. Expired credentials are automatically revoked at the backend level.

**Validates**: FR-11, FR-14

---

### INT-5: Migration from Environment Variables

**Objective**: Verify that existing environment variable secrets can be migrated to the unified secret store with backward-compatible resolution.

**Prerequisites**: Existing environment variables with `isSecret: true` in the project. `SECRETS_MANAGEMENT_ENABLED=true`.

**Steps**:

1. Create environment variables via the existing API:
   - `DB_PASSWORD` with value `pg-secret-123` (isSecret: true, environment: `production`)
   - `API_TOKEN` with value `token-abc-456` (isSecret: true, environment: `dev`)
   - `PUBLIC_URL` with value `https://api.example.com` (isSecret: false -- should NOT be migrated)
2. POST `/api/projects/:projectId/secrets/migrate` with `{ "source": "environment-variables" }`.
3. Verify response shows:
   - 2 secrets migrated (`DB_PASSWORD`, `API_TOKEN`)
   - 1 skipped (`PUBLIC_URL` -- not a secret)
4. Verify new secrets exist in the `secrets` collection:
   - Path `env/DB_PASSWORD`, environment `production`, value `pg-secret-123`
   - Path `env/API_TOKEN`, environment `dev`, value `token-abc-456`
5. Verify original environment variables are still intact (not deleted) and marked with `migratedToSecretId`.
6. Verify `{{env.DB_PASSWORD}}` still resolves correctly (backward compatibility via dual-read in `SecretsProvider`).
7. Verify `{{secret.env/DB_PASSWORD}}` also resolves to the same value (new syntax).
8. Update the migrated secret's value via the secrets API.
9. Verify both `{{env.DB_PASSWORD}}` and `{{secret.env/DB_PASSWORD}}` return the updated value.

**Expected Result**: Migration copies secret env vars to the unified store. Original env vars remain functional. Both old and new syntax resolve correctly. Non-secret env vars are skipped.

**Validates**: FR-17, FR-12

---

### INT-6: Access Policy Evaluation

**Objective**: Verify that the access policy engine correctly evaluates grant rules for different grantee types and permission levels.

**Prerequisites**: MongoDB with secrets and various access policy configurations.

**Steps**:

1. Create a secret with a complex access policy:
   ```json
   {
     "defaultAccess": "deny",
     "grants": [
       { "granteeType": "project", "granteeId": "project-1", "permissions": ["read"] },
       {
         "granteeType": "user",
         "granteeId": "user-admin",
         "permissions": ["read", "rotate", "admin"]
       },
       { "granteeType": "role", "granteeId": "role-developer", "permissions": ["read"] },
       { "granteeType": "agent", "granteeId": "agent-crm-bot", "permissions": ["read"] },
       {
         "granteeType": "user",
         "granteeId": "user-temp",
         "permissions": ["read"],
         "expiresAt": "2026-01-01T00:00:00Z"
       }
     ]
   }
   ```
2. Evaluate access for `user-admin` with `read` permission -- assert ALLOWED.
3. Evaluate access for `user-admin` with `rotate` permission -- assert ALLOWED.
4. Evaluate access for a user with `role-developer` requesting `read` -- assert ALLOWED.
5. Evaluate access for a user with `role-developer` requesting `rotate` -- assert DENIED.
6. Evaluate access for `agent-crm-bot` requesting `read` -- assert ALLOWED.
7. Evaluate access for `agent-crm-bot` requesting `admin` -- assert DENIED.
8. Evaluate access for `user-temp` (expired grant) requesting `read` -- assert DENIED.
9. Evaluate access for `user-unknown` (no grant) requesting `read` -- assert DENIED (default deny).
10. Evaluate access for a user from a different project (project-2, no grant) -- assert DENIED.

**Expected Result**: Policy evaluation correctly enforces deny-by-default, respects grantee types, permission levels, and grant expiration.

**Validates**: FR-2

---

### INT-7: External Sync Error Handling and Retry

**Objective**: Verify that external sync handles connection failures gracefully with exponential backoff and status reporting.

**Prerequisites**: Redis for BullMQ. A mock external store that can simulate failures.

**Steps**:

1. Configure an external secret store pointing to a mock endpoint.
2. Create a synced secret referencing the mock store.
3. Simulate the mock store returning HTTP 503 (Service Unavailable).
4. Trigger the sync worker.
5. Verify the sync attempt is logged with `syncStatus: 'error'`.
6. Verify the worker schedules a retry with exponential backoff (2s, 4s, 8s, 16s, 32s).
7. After 3 consecutive failures, verify an alert is emitted.
8. Restore the mock store to return HTTP 200 with a secret value.
9. Verify the next retry succeeds and `syncStatus` transitions to `synced`.
10. Verify the secret value is updated from the external store.
11. Verify audit log shows the error attempts and the eventual success.

**Expected Result**: Sync failures are handled gracefully with retries. Alerts fire after repeated failures. Recovery is automatic when the external store comes back online.

**Validates**: FR-10, FR-9

---

## 5. Unit Test Scenarios

### UNIT-1: Secret Engine CRUD Operations

**File**: `packages/shared/src/__tests__/secrets/secret-engine.test.ts`

| Scenario                                              | Input                                            | Expected Output                                       |
| ----------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Create secret with valid path and value               | `{ path: "a/b", value: "test", type: "static" }` | Secret created with encrypted value, version 1 active |
| Create secret with duplicate path                     | Same path as existing secret                     | Error: path already exists in scope                   |
| Create secret with invalid path (empty)               | `{ path: "", ... }`                              | Zod validation error                                  |
| Create secret with path containing special characters | `{ path: "a/../b", ... }`                        | Error: path traversal not allowed                     |
| Read secret metadata (no value)                       | `getSecret(id)`                                  | Metadata returned, no `encryptedValue` field          |
| Read secret value with valid access                   | `getSecretValue(id, actor)`                      | Decrypted value returned                              |
| Read secret value with denied access                  | `getSecretValue(id, unauthorizedActor)`          | Access denied error                                   |
| Update secret value creates new version               | `updateSecretValue(id, "new-val")`               | Version incremented, old version grace/inactive       |
| Delete secret sets status to destroyed                | `deleteSecret(id)`                               | Status `destroyed`, value inaccessible                |
| Read expired secret returns error                     | `getSecretValue(expiredSecretId, actor)`         | Error: secret expired                                 |
| Read revoked secret returns error                     | `getSecretValue(revokedSecretId, actor)`         | Error: secret revoked                                 |
| Version rollback restores previous value              | `rollbackSecret(id, version: 1)`                 | Version 1 reactivated, current version deactivated    |
| Max versions exceeded triggers pruning                | Create 11 versions (max 10)                      | Oldest version crypto-shredded                        |

### UNIT-2: Access Policy Engine

**File**: `packages/shared/src/__tests__/secrets/access-policy.test.ts`

| Scenario                                   | Input                                          | Expected Output |
| ------------------------------------------ | ---------------------------------------------- | --------------- |
| Default deny with no grants                | Policy `{ defaultAccess: 'deny', grants: [] }` | DENIED          |
| Default read with no specific grant        | Policy `{ defaultAccess: 'read', grants: [] }` | ALLOWED (read)  |
| Specific user grant allows read            | Grant for userId with `['read']`               | ALLOWED         |
| Specific user grant denies rotate          | Grant for userId with `['read']` only          | DENIED          |
| Admin grant includes all permissions       | Grant with `['admin']`                         | ALLOWED for all |
| Expired grant denies access                | Grant with `expiresAt` in the past             | DENIED          |
| Project-level grant allows project members | Grant for projectId                            | ALLOWED         |
| Agent-level grant allows specific agent    | Grant for agentId                              | ALLOWED         |
| Multiple grants -- most permissive wins    | Two grants, one read, one admin                | ALLOWED (admin) |
| Cross-tenant actor always denied           | Actor from different tenant                    | DENIED          |

### UNIT-3: Rotation Engine Logic

**File**: `packages/shared/src/__tests__/secrets/rotation-engine.test.ts`

| Scenario                                     | Input                                         | Expected Output                                   |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| Start rotation creates new version           | `startRotation(secretId, newValue)`           | New version created, status `rotating`            |
| Verification success completes rotation      | `verifyRotation(secretId)` with HTTP 200 mock | Status `active`, old version `grace`              |
| Verification failure triggers rollback       | `verifyRotation(secretId)` with HTTP 401 mock | Old version reactivated, new version `inactive`   |
| Grace period expiry deactivates old version  | Process delayed job after grace period        | Old version `inactive`                            |
| Rotation with no verification endpoint       | Secret without `verificationEndpoint`         | Rotation completes immediately (no verify step)   |
| Concurrent rotation attempts blocked         | Two `startRotation` calls simultaneously      | Second call receives "rotation in progress" error |
| Generated secret rotation auto-creates value | Rotation on `type: 'generated'` secret        | New random value generated with configured format |

### UNIT-4: Secret Resolver

**File**: `packages/shared/src/__tests__/secrets/secret-resolver.test.ts`

| Scenario                                    | Input                                 | Expected Output                  |
| ------------------------------------------- | ------------------------------------- | -------------------------------- |
| Resolve valid `{{secret.a/b}}` reference    | `resolve("{{secret.a/b}}", ctx)`      | Decrypted secret value           |
| Resolve with environment override           | Secret exists for `dev` and base      | Returns `dev` environment value  |
| Resolve with base fallback                  | Secret exists only for base           | Returns base value               |
| Resolve nonexistent secret path             | `resolve("{{secret.no/exist}}", ctx)` | Error: secret not found          |
| Resolve revoked secret                      | `resolve("{{secret.revoked}}", ctx)`  | Error: secret revoked            |
| Resolve multiple references in one template | `"{{secret.a}} and {{secret.b}}"`     | Both values resolved             |
| Resolve with pinned version                 | `{{secret.a/b@3}}`                    | Returns version 3 specifically   |
| Resolve backward-compatible `{{env.KEY}}`   | `resolve("{{env.DB_PASS}}", ctx)`     | Resolves via migration dual-read |

### UNIT-5: Secret Scanner

**File**: `packages/shared/src/__tests__/secrets/secret-scanner.test.ts`

| Scenario                            | Input                                            | Expected Output                                |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Detect AWS access key               | `AKIAIOSFODNN7EXAMPLE` in DSL content            | Detection: AWS access key pattern              |
| Detect OpenAI API key               | `sk-proj-abc123...` in config content            | Detection: OpenAI API key pattern              |
| Detect generic high-entropy string  | 64-char hex string in env config                 | Detection: potential secret (high entropy)     |
| Ignore known non-secret patterns    | UUID, SHA-256 hash in metadata                   | No detection                                   |
| Detect GitHub personal access token | `ghp_xxxxxxxxxxxx` in DSL                        | Detection: GitHub PAT pattern                  |
| Detect Slack webhook URL            | `https://hooks.slack.com/services/T.../B.../...` | Detection: Slack webhook URL                   |
| Allow secret references (not leaks) | `{{secret.llm/openai-key}}` in DSL               | No detection (this is a reference, not a leak) |
| Detect private key block            | `-----BEGIN RSA PRIVATE KEY-----` in config      | Detection: private key                         |

---

## 6. Manual Test Scenarios

### MAN-1: Studio Secrets Manager UI Walkthrough

**Objective**: Verify the Studio UI for secret management works end-to-end.

**Steps**:

1. Navigate to Project Settings > Secrets.
2. Verify empty state shows "No secrets configured" with a "Create Secret" button.
3. Click "Create Secret". Verify the wizard opens with type selection (Static, Generated, Dynamic, Synced).
4. Select "Static", enter path `test/manual-key`, value `manual-test-123`, add tags `test` and `manual`.
5. Configure access policy: grant the current project read access.
6. Submit. Verify the secret appears in the table with status badge "Active" (green).
7. Click the secret to open the detail drawer. Verify version history shows version 1.
8. Click "Show Value". Verify `manual-test-123` is displayed (masked by default).
9. Click "Rotate Now". Enter a new value. Verify status badge changes to "Rotating" (blue).
10. Verify the rotation completes and the version timeline shows two entries.

### MAN-2: External Vault Connection Setup

**Objective**: Verify the admin portal UI for configuring external secret stores.

**Steps**:

1. Navigate to Admin Portal > Secret Stores.
2. Click "Add Store". Select "HashiCorp Vault".
3. Enter connection details (Vault address, auth method, token).
4. Click "Test Connection". Verify success/failure feedback.
5. Save the configuration. Verify it appears in the stores list with health status indicator.

### MAN-3: Break-Glass Access via Studio

**Objective**: Verify the break-glass modal works for authorized operators.

**Steps**:

1. Revoke a secret via the Studio UI.
2. Attempt to view the revoked secret's value. Verify access is blocked.
3. Click "Emergency Access". Verify the break-glass modal appears with a reason field and warning text.
4. Enter a reason and incident ticket ID. Submit.
5. Verify the value is displayed. Verify a notification is sent (check webhook/Slack).

### MAN-4: Migration Wizard Walkthrough

**Objective**: Verify the migration wizard correctly identifies and migrates environment variable secrets.

**Steps**:

1. Ensure the project has env vars with `isSecret: true`.
2. Navigate to Project Settings > Secrets > Migration.
3. Click "Scan for Migratable Secrets".
4. Verify the wizard lists only secret env vars (not config vars or non-secret env vars).
5. Select secrets to migrate. Click "Migrate".
6. Verify progress indicator. On completion, verify migrated secrets appear in the secrets table.
7. Verify original env vars still work via `{{env.KEY}}` resolution.

---

## 7. Test Infrastructure Requirements

### Required Services

| Service                    | Purpose                                              | Provisioning                                 |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| MongoDB                    | Secret store, version history, access policies       | MongoMemoryServer for unit/integration tests |
| Redis                      | BullMQ workers, cache invalidation, pub/sub          | Redis in Docker for integration tests        |
| ClickHouse                 | Audit log storage                                    | ClickHouse in Docker for E2E tests           |
| HashiCorp Vault (dev mode) | External secret store integration testing            | `hashicorp/vault:latest` Docker image        |
| Mock HTTP server           | Rotation verification, webhook alerts, external APIs | In-process mock (e.g., Express on port 0)    |

### Test Data Factories

| Factory                    | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `createTestSecret()`       | Creates a secret with default values for testing     |
| `createTestSecretStore()`  | Creates an external store config for testing         |
| `createTestAccessPolicy()` | Creates an access policy with various grant patterns |
| `createTestTenant()`       | Creates tenant context with encryption configured    |
| `createTestProject()`      | Creates project context within a tenant              |

### Environment Variables for Test

| Variable                     | Value                                    | Purpose                                |
| ---------------------------- | ---------------------------------------- | -------------------------------------- |
| `ENCRYPTION_MASTER_KEY`      | 64-char hex string (test-only)           | Encryption at rest for secret values   |
| `SECRETS_MANAGEMENT_ENABLED` | `true`                                   | Enable the feature in test             |
| `SECRETS_CACHE_TTL_MS`       | `1000` (1 second for faster test cycles) | Short TTL for cache invalidation tests |
| `VAULT_ADDR`                 | `http://localhost:8200`                  | Vault dev server for integration tests |
| `VAULT_DEV_ROOT_TOKEN_ID`    | `test-root-token`                        | Vault dev server root token            |

---

## 8. Testing Notes

### Priority Order

1. **E2E-1 (Secret CRUD)** and **E2E-2 (Isolation)** -- foundational; must pass before all other tests.
2. **E2E-3 (Rotation)** and **E2E-4 (Rotation Rollback)** -- core enterprise value.
3. **E2E-6 (Audit Trail)** -- compliance requirement.
4. **INT-1 through INT-3** -- rotation worker, expiration, cache -- reliability.
5. **E2E-5 (External Sync)** and **INT-4 (Dynamic Secrets)** -- Phase 3 features.
6. **E2E-7 (Break-Glass)** and **E2E-8 (DSL Resolution)** -- advanced features.

### Anti-Patterns to Avoid

- **Do NOT mock the encryption engine** in E2E tests. Use real AES-256-GCM encryption with a test master key.
- **Do NOT mock MongoDB** in integration tests. Use MongoMemoryServer for realistic behavior.
- **Do NOT mock Redis** in cache invalidation tests. Use a real Redis instance.
- **Do NOT access the database directly** in E2E tests for assertions (except verifying ciphertext storage). Use the HTTP API.
- **Do NOT use `vi.mock()` or `jest.mock()`** for codebase components in E2E tests. Only mock external third-party services (e.g., the external Vault in unit tests).
- **Do NOT skip the auth middleware** in E2E tests. All requests must go through the full authentication and authorization chain.

### Known Test Limitations

- **HashiCorp Vault tests** require Docker and may be slow to start (~5-10 seconds). Consider running vault-dependent tests in a separate CI job.
- **Dynamic secret tests** (MongoDB provider) require a separate MongoDB instance as the "target backend". MongoMemoryServer cannot be used for this (it does not support `createUser`).
- **Cache invalidation tests** are timing-sensitive. Use deterministic time advancement where possible; fall back to generous timeouts (5-second max wait) where not.

> Full feature details: [../features/secrets-management.md](../features/secrets-management.md)
