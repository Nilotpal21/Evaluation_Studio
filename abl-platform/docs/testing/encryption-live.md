# Feature Test Guide: Encryption (Live E2E)

**Feature**: DEK envelope encryption — env vars, LLM credentials, tool secrets, KMS admin
**Owner**: Platform team
**Branch**: feature/benchmark-ir-cache-rate-limit
**First tested**: 2026-04-08
**Last updated**: 2026-04-08
**Overall status**: STABLE

---

## Current State (as of 2026-04-08)

All encryption flows are working end-to-end. Environment variables, LLM credentials, and tool secrets are encrypted at rest using DEK envelope encryption (AES-256-GCM). Decryption returns correct plaintext values. Cross-project isolation returns 404. AAD (tenantId) binding prevents cross-tenant ciphertext swapping at the cryptographic level. KMS admin APIs work correctly — config retrieval, DEK listing, forced rotation, and health checks all pass. Pre-rotation data continues to decrypt after DEK rotation.

### Quick Health Dashboard

| Area                          | Status | Last Verified | Notes                                    |
| ----------------------------- | ------ | ------------- | ---------------------------------------- |
| Env var create (encrypted)    | PASS   | 2026-04-08    | All values encrypted at rest             |
| Env var list (no values)      | PASS   | 2026-04-08    | encryptedValue excluded from list        |
| Env var decrypt (single)      | PASS   | 2026-04-08    | GET /:id/value returns plaintext         |
| Env var export (bulk decrypt) | PASS   | 2026-04-08    | POST /export decrypts all vars           |
| Env var update (re-encrypt)   | PASS   | 2026-04-08    | New ciphertext after value update        |
| LLM credential create         | PASS   | 2026-04-08    | encryptedApiKey is ciphertext in DB      |
| LLM credential list           | PASS   | 2026-04-08    | No apiKey/encryptedApiKey in response    |
| Tool secret create            | PASS   | 2026-04-08    | encryptedValue is ciphertext in DB       |
| Tool secret list              | PASS   | 2026-04-08    | No values in list response               |
| Tool secret rotation          | PASS   | 2026-04-08    | Version increments, new ciphertext       |
| Cross-project isolation       | PASS   | 2026-04-08    | Wrong project returns 404                |
| AAD cross-tenant binding      | PASS   | 2026-04-08    | Wrong tenantId = auth tag mismatch       |
| KMS config                    | PASS   | 2026-04-08    | Local provider configured                |
| KMS DEK listing               | PASS   | 2026-04-08    | wrappedDek excluded from response        |
| KMS DEK rotation              | PASS   | 2026-04-08    | Re-encryption job enqueued               |
| KMS health                    | PASS   | 2026-04-08    | Healthy, 5 active + 81 decrypt_only DEKs |
| Post-rotation decrypt         | PASS   | 2026-04-08    | Old data decrypts after rotation         |
| Post-rotation encrypt         | PASS   | 2026-04-08    | New data uses new DEK                    |
| Cross-tenant isolation (UI)   | --     | Not tested    | Needs second tenant JWT                  |

---

## Test Coverage Map

### Env Var Encryption

- [x] Create plain env var -- `Iteration 1 (2026-04-08) PASS`
- [x] Create secret env var -- `Iteration 1 (2026-04-08) PASS`
- [x] Create cross-environment secret -- `Iteration 1 (2026-04-08) PASS`
- [x] Verify encrypted at rest in MongoDB -- `Iteration 1 (2026-04-08) PASS`
- [x] List returns metadata only (no values) -- `Iteration 1 (2026-04-08) PASS`
- [x] Single value decrypt returns correct plaintext -- `Iteration 1 (2026-04-08) PASS`
- [x] Non-secret value also decrypts correctly -- `Iteration 1 (2026-04-08) PASS`
- [x] Bulk export decrypts all values -- `Iteration 1 (2026-04-08) PASS`
- [x] Update value re-encrypts with new ciphertext -- `Iteration 1 (2026-04-08) PASS`
- [x] Updated value decrypts to new plaintext -- `Iteration 1 (2026-04-08) PASS`
- [ ] Import bulk encrypt -- `Not tested`
- [ ] Diff endpoint decrypts for comparison -- `Not tested`

### LLM Credential Encryption

- [x] Create OpenAI credential -- `Iteration 1 (2026-04-08) PASS`
- [x] Create Anthropic credential -- `Iteration 1 (2026-04-08) PASS`
- [x] Verify encryptedApiKey is ciphertext in MongoDB -- `Iteration 1 (2026-04-08) PASS`
- [x] List excludes apiKey/encryptedApiKey -- `Iteration 1 (2026-04-08) PASS`
- [ ] Update credential re-encrypts -- `Not tested`
- [ ] Delete credential removes encrypted data -- `Not tested`
- [ ] Credential used for LLM call (decrypt at runtime) -- `Not tested`

### Tool Secret Encryption

- [x] Create tool secret -- `Iteration 1 (2026-04-08) PASS`
- [x] Verify encrypted at rest in MongoDB -- `Iteration 1 (2026-04-08) PASS`
- [x] List returns metadata only -- `Iteration 1 (2026-04-08) PASS`
- [x] Rotate secret (version bump, re-encrypt) -- `Iteration 1 (2026-04-08) PASS`
- [x] Verify rotated value is new ciphertext in DB -- `Iteration 1 (2026-04-08) PASS`
- [ ] Delete tool secret -- `Not tested`
- [ ] Expiry warning on near-expired secrets -- `Not tested`

### Cross-Tenant / Cross-Project Isolation

- [x] Access env var from wrong project returns 404 -- `Iteration 1 (2026-04-08) PASS`
- [x] List env vars in wrong project returns that project's vars only -- `Iteration 1 (2026-04-08) PASS`
- [x] AAD: encrypt with tenant-A, decrypt with tenant-A = SUCCESS -- `Iteration 1 (2026-04-08) PASS`
- [x] AAD: encrypt with tenant-A, decrypt with tenant-B = REJECTED -- `Iteration 1 (2026-04-08) PASS`
- [x] AAD: encrypt with tenant-A, decrypt with no AAD = REJECTED -- `Iteration 1 (2026-04-08) PASS`
- [ ] Full cross-tenant test with second tenant JWT -- `Not tested`

### KMS Admin

- [x] Get KMS config -- `Iteration 1 (2026-04-08) PASS`
- [x] List DEKs (wrappedDek excluded) -- `Iteration 1 (2026-04-08) PASS`
- [x] KMS health check -- `Iteration 1 (2026-04-08) PASS`
- [x] Force DEK rotation (manual-rotation) -- `Iteration 1 (2026-04-08) PASS`
- [x] Pre-rotation data still decrypts -- `Iteration 1 (2026-04-08) PASS`
- [x] Post-rotation data uses new DEK -- `Iteration 1 (2026-04-08) PASS`
- [ ] Update KMS config (change provider) -- `Not tested`
- [ ] Validate external KMS endpoint -- `Not tested`
- [ ] KMS audit log query -- `Not tested`
- [ ] Project-level KMS override -- `Not tested`

---

## Open Gaps

- **GAP-001**: Full cross-tenant isolation not tested with second tenant JWT
  - **Severity**: Medium
  - **Reason**: Need to create a second tenant and user to test API-level cross-tenant access denial

- **GAP-002**: Credential decrypt at runtime (LLM call) not tested
  - **Severity**: Medium
  - **Reason**: Requires a valid LLM API key and model configuration

- **GAP-003**: KMS config update and external provider validation not tested
  - **Severity**: Low
  - **Reason**: No external KMS available in local dev

---

## Pending / Future Work

- [ ] Test with AWS KMS / GCP Cloud KMS provider (requires cloud credentials)
- [ ] Test crypto shredding (KEK deletion makes all DEKs unrecoverable)
- [ ] Test bulk re-encryption job completion after rotation
- [ ] Test concurrent encrypt/decrypt under load
- [ ] Test DEK cache eviction under memory pressure
- [ ] Test encryption plugin with ClickHouse interceptor

---

## Iteration Log

### Iteration 1 -- 2026-04-08

**Scope**: Full encryption E2E: env vars, LLM credentials, tool secrets, AAD binding, KMS admin
**Branch**: feature/benchmark-ir-cache-rate-limit
**Duration**: ~15min
**Tested by**: Claude Code (agent)

#### Results

| #   | Test                        | Method                                  | Expected               | Actual                                                                              | Status |
| --- | --------------------------- | --------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- | ------ |
| 1   | Create plain env var        | POST /env-vars                          | 201, encrypted at rest | 201, ciphertext in DB (104 chars vs 30 plaintext)                                   | PASS   |
| 2   | Create secret env var       | POST /env-vars                          | 201, isSecret=true     | 201, encrypted correctly                                                            | PASS   |
| 3   | Create staging secret       | POST /env-vars                          | 201, staging env       | 201, separate from dev vars                                                         | PASS   |
| 4   | List env vars               | GET /env-vars                           | No values returned     | Metadata only, no encryptedValue                                                    | PASS   |
| 5   | Decrypt single value        | GET /env-vars/:id/value                 | Correct plaintext      | `sk-test-abc123-secret-key-value`                                                   | PASS   |
| 6   | Decrypt non-secret          | GET /env-vars/:id/value                 | Correct plaintext      | `mongodb://prod-host:27017/mydb`                                                    | PASS   |
| 7   | Bulk export                 | POST /env-vars/export                   | All decrypted          | 2 vars with correct values                                                          | PASS   |
| 8   | Update value                | PUT /env-vars/:id                       | Re-encrypted           | New ciphertext in DB                                                                | PASS   |
| 9   | Decrypt updated value       | GET /env-vars/:id/value                 | New plaintext          | `sk-ROTATED-new-key-value-xyz`                                                      | PASS   |
| 10  | Create OpenAI credential    | POST /tenant-credentials                | 201, encrypted         | encryptedApiKey=96 chars (not plaintext)                                            | PASS   |
| 11  | Create Anthropic credential | POST /tenant-credentials                | 201, encrypted         | encryptedApiKey=92 chars (not plaintext)                                            | PASS   |
| 12  | List credentials            | GET /tenant-credentials                 | No API keys            | Fields: id,name,provider,authType,isActive,isDefault,createdAt,updatedAt,lastUsedAt | PASS   |
| 13  | Create tool secret          | POST /tool-secrets                      | 201, metadata only     | id,toolName,secretKey,environment,version                                           | PASS   |
| 14  | Create another tool secret  | POST /tool-secrets                      | 201                    | Created correctly                                                                   | PASS   |
| 15  | List tool secrets           | GET /tool-secrets                       | No values              | Metadata only, no encryptedValue                                                    | PASS   |
| 16  | Rotate tool secret          | POST /tool-secrets/:id/rotate           | Version 2              | version=2, new ciphertext, rotatedAt set                                            | PASS   |
| 17  | Cross-project access        | GET /env-vars/:id/value (wrong project) | 404                    | `{success:false, error:"Environment variable not found"}`                           | PASS   |
| 18  | Cross-project list          | GET /env-vars (wrong project)           | Different vars         | bench-sat-t1 vars only                                                              | PASS   |
| 19  | Get KMS config              | GET /kms/config                         | Local provider         | providerType=local, keyId=tenant-default-key                                        | PASS   |
| 20  | List DEKs                   | GET /kms/keys                           | No wrappedDek          | 5 active, 81 decrypt_only, wrappedDek excluded                                      | PASS   |
| 21  | KMS health                  | GET /kms/health                         | Healthy                | healthy=true, provider=local                                                        | PASS   |
| 22  | Force rotation              | POST /kms/keys/rotate                   | Re-encryption enqueued | reencryptionJobId returned                                                          | PASS   |
| 23  | Post-rotation: active DEKs  | GET /kms/keys?status=active             | Active DEKs exist      | 5 active DEKs with epochs                                                           | PASS   |
| 24  | wrappedDek excluded         | GET /kms/keys                           | Not in response        | 19 fields, no wrappedDek                                                            | PASS   |
| 25  | Pre-rotation decrypt        | GET /env-vars/:id/value                 | Old data decrypts      | `mongodb://prod-host:27017/mydb`                                                    | PASS   |
| 26  | Post-rotation encrypt       | POST /env-vars                          | New var created        | Uses new DEK                                                                        | PASS   |
| 27  | Post-rotation decrypt       | GET /env-vars/:id/value                 | New data decrypts      | `encrypted-after-rotation-value`                                                    | PASS   |

#### AAD Cross-Tenant Binding (Crypto-Level Test)

| #   | Test                               | Expected           | Actual                                             | Status |
| --- | ---------------------------------- | ------------------ | -------------------------------------------------- | ------ |
| A1  | Encrypt tenant-A, decrypt tenant-A | Success            | `super-secret-value`                               | PASS   |
| A2  | Encrypt tenant-A, decrypt tenant-B | Auth tag rejection | `Unsupported state or unable to authenticate data` | PASS   |
| A3  | Encrypt tenant-A, decrypt no AAD   | Auth tag rejection | `Unsupported state or unable to authenticate data` | PASS   |

#### Bugs Fixed

- **BUG-001**: Studio returning 500 on all routes after TenantKeyCache removal
  - **File**: `packages/shared/dist/encryption/index.js` (stale build output)
  - **Root Cause**: `shared` package had stale `dist/` still exporting `TenantKeyCache` after source removal in G3 cleanup. Next.js webpack picked up the stale build.
  - **Fix**: `pnpm build --filter=@agent-platform/shared` to regenerate dist, then `pm2 restart abl-studio`
  - **Verified**: Studio dev-login returns 200 with valid JWT

#### Gaps Found

- GAP-001: Full cross-tenant isolation with second tenant JWT (Medium)
- GAP-002: LLM credential decrypt during actual LLM call (Medium)
- GAP-003: KMS config update / external provider validation (Low)

---

## Test Environment

- Runtime: localhost:3112 (PM2, fork mode)
- Studio: localhost:5173 (PM2, Next.js dev)
- MongoDB: localhost:27017/abl_platform
- Test project: `019d6e33-f0db-72f1-b94b-41c9a06385ce` (encryption-live-test)
- Tenant: `tenant-dev-001`
- KMS provider: local (default)
- Encryption: DEK envelope (AES-256-GCM with AAD)
