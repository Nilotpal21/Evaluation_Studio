# Data-Flow & Dependency-Wiring Audit: ABLP-155 Azure KMS Dep Resolution

**Date**: 2026-05-14
**Auditor**: data-flow-audit skill (pr-review Phase A + B follow-up)
**Round**: 1 + 2 (combined — no CRITICAL/HIGH fixes required)
**Feature**: PR #1009 — `[ABLP-155] fix(workflow-engine): declare @azure/keyvault-keys as direct dep`
**Worktree**: `.worktrees/pr-1009`
**Commits audited**:

- `5829c015aa` `[ABLP-155] fix(workflow-engine): declare @azure/keyvault-keys as direct dep`
- `a04eec57eb` `[ABLP-155] test(workflow-engine): add azure KMS dep-resolution guard`
- `cbf5d85c12` `[ABLP-155] test(workflow-engine): remove unexported database sub-path import`

## Why this audit ran

PR #1009 touches the KMS dependency-wiring path:

- Introduces new **dependency wiring** for `@azure/identity` and `@azure/keyvault-keys` as direct deps
  in `apps/workflow-engine/package.json` (previously only transitive optionals, pruned by `pnpm deploy --prod`).
- New serialization boundary made reachable at runtime: `AzureKeyVaultProvider.initialize()` →
  `@azure/identity.ClientSecretCredential` → Azure OAuth token endpoint (HTTPS).
- Affects the DEK plaintext lifecycle for any workflow-engine tenant using `azure-keyvault` KMS.

## Sensitive values audited

| Value                           | Data class | Notes                                                                                             |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| Azure service principal creds   | CREDENTIAL | `clientId`, `clientSecret`, `tenantId` — env var or per-tenant encrypted blob                     |
| DEK plaintext (32-byte AES key) | KEY        | In-memory only; zero-filled on eviction/error                                                     |
| DEK ciphertext (`wrappedDek`)   | KEY (enc)  | RSA-OAEP-256-wrapped; stored in MongoDB `dek_registry`                                            |
| `authConfigEncrypted` blob      | CREDENTIAL | Per-tenant Azure creds, AES-GCM encrypted with platform key; stored in `materialized_kms_configs` |

---

## VALUE 1 — Azure service principal credentials (clientId, clientSecret, tenantId)

**Data class:** CREDENTIAL
**Approved consumers:** Azure SDK (`@azure/identity.ClientSecretCredential` / `DefaultAzureCredential`) only.

### 1. Source

Two entry paths:

- **Platform default**: `kms-provider-pool.ts:398-403` (`resolveAuthConfig()`) — reads `KMS_AZURE_TENANT_ID`,
  `KMS_AZURE_CLIENT_ID`, `KMS_AZURE_CLIENT_SECRET` from process env. Validation: presence only (no schema);
  absent creds cause Azure SDK to fall back to `DefaultAzureCredential` (Managed Identity).
- **Per-tenant**: `kms-provider-pool.ts:376-393` — decrypts `config.authConfigEncrypted` via
  `decryptAuthConfig(encrypted, localProvider, 'platform-default', aad)`. FAIL CLOSED: throws on any
  decrypt error, never falls back to platform env vars.

### 2. Writes

| Sink                                                  | Format                               | Notes                                                                                       |
| ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `MaterializedKMSConfig.authConfigEncrypted` (MongoDB) | AES-GCM encrypted base64 blob        | Written by admin routes (out of scope for this PR)                                          |
| `DEKEntry.wrappingProvider` (MongoDB)                 | `authConfigEncrypted: null` (zeroed) | `cloneProviderRef()` at `dek-manager.ts:230-240` explicitly nulls this field before write ✓ |
| Process env vars                                      | Plaintext in memory (OS-managed)     | Never written back to disk by platform code                                                 |
| Logs                                                  | Never                                | `console.warn` in pool logs errors but not values                                           |

**Key security control:** `cloneProviderRef()` at `dek-manager.ts:230-240` sets `authConfigEncrypted: null`
before persisting the provider snapshot to `dek_registry`. Per-tenant credentials **never reach MongoDB
via the DEKEntry write path**.

### 3. Serialization boundaries

| Boundary                                         | What crosses                                         | Receiver                                                 |
| ------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| `resolveAuthConfig()` → `ClientSecretCredential` | tenantId, clientId, clientSecret (in-process)        | Azure SDK (never serialized externally by platform code) |
| Azure SDK → Azure OAuth token endpoint           | OAuth2 client_credentials grant (HTTPS, SDK-managed) | Azure AD (external, encrypted in transit)                |
| Azure SDK → Azure Key Vault REST API             | Bearer token (SDK-managed, not creds)                | Azure Key Vault                                          |

Platform code never serializes credentials to network/disk. Only the Azure SDK transmits them
(OAuth2 over HTTPS).

### 4. Read paths

- `resolveAuthConfig()` — called once per new provider creation in `KMSProviderPool.createProvider()`.
- No HTTP route or admin endpoint exposes credential values.
- `decryptAuthConfig()` at `auth-config-crypto.ts:42-61` decrypts the blob and returns parsed JSON.

### 5. Policy boundary

| Consumer               | Required policy  | Actual                                                                                                         | Verdict |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| Azure SDK              | Plaintext (auth) | Plaintext in-process call                                                                                      | ✓       |
| MongoDB `dek_registry` | Never            | `cloneProviderRef()` nulls it                                                                                  | ✓       |
| Logs / audit events    | Never            | Absent from all log calls                                                                                      | ✓       |
| Other tenants          | Never            | `computeFingerprint()` includes `tenantId + SHA-256(authConfigEncrypted)` — cross-tenant pool reuse impossible | ✓       |
| Error messages         | Never            | `err instanceof Error ? err.message : String(err)` pattern used; no credential field included                  | ✓       |

### 6. Consumers / sinks

- `@azure/identity.ClientSecretCredential` → Azure OAuth endpoint (HTTPS)
- `@azure/keyvault-keys.KeyClient` / `CryptographyClient` → Azure Key Vault (HTTPS, Bearer token only)

No external consumer receives the plaintext credentials.

### 7. Wiring

```
DEPENDENCY: @azure/keyvault-keys + @azure/identity
  Constructed at: azure-keyvault-provider.ts:31-38 (loadAzureKeyvault / loadAzureIdentity)
  Consumer 1: AzureKeyVaultProvider.initialize() — WIRED ✓ (dynamic import)
  Consumer 2: KMSProviderPool.createProvider() → createKMSProvider() — WIRED ✓
  Consumer 3: KMSProviderPool.initialize() pre-warm — WIRED ✓
  Consumer 4: initDEKFacade() → KMSProviderPool → WIRED ✓
  Consumer 5: apps/workflow-engine/src/services/database.ts:80 → initDEKFacade() — WIRED ✓

  Pre-PR status:  Packages loadable in dev/test (transitive optional from packages/database)
                  NOT loadable under pnpm deploy --prod (transitive optionals pruned)
  Post-PR status: WIRED ✓ — declared as direct dependency in apps/workflow-engine/package.json
  Null-handling:  initialize() throws if SDK missing → initDEKFacade() propagates → server fails to start (fail-fast ✓)
```

### 8. Parallel paths

| App                    | Direct dep declared   | Pattern used    | Parity verdict  |
| ---------------------- | --------------------- | --------------- | --------------- |
| apps/runtime           | ✓ (pre-existing)      | Same `^4.x` pin | ✓               |
| apps/studio            | ✓ (pre-existing)      | Same `^4.x` pin | ✓               |
| apps/search-ai         | ✓ (pre-existing)      | Same `^4.x` pin | ✓               |
| apps/search-ai-runtime | ✓ (pre-existing)      | Same `^4.x` pin | ✓               |
| apps/workflow-engine   | **Added by PR #1009** | Same `^4.x` pin | ✓ (now aligned) |

### 9. Boundary tests

- [x] `apps/workflow-engine/src/__tests__/azure-kms-dep-resolution.test.ts` (new, PR #1009) —
      dynamic import tests for `@azure/keyvault-keys` (KeyClient, CryptographyClient) and `@azure/identity`
      (DefaultAzureCredential, ClientSecretCredential). Runs in workflow-engine context; fails if direct
      declarations removed from package.json.
- [x] `packages/database/src/__tests__/kms-azure-dep-resolution.test.ts` (pre-existing) — same
      checks in database package context (does not catch workflow-engine deploy regression).

---

## VALUE 2 — DEK plaintext (32-byte AES key material)

**Data class:** KEY
**Approved consumers:** `TenantEncryptionFacade` only (in-process AES-256-GCM encrypt/decrypt).

### 1. Source

- **Generate path**: `azure-keyvault-provider.ts:127` — `const dekPlaintext = randomBytes(32)`.
  Immediately passed to `CryptographyClient.wrapKey('RSA-OAEP-256', dekPlaintext)`.
- **Unwrap path**: `azure-keyvault-provider.ts:165` — `client.unwrapKey('RSA-OAEP-256', ciphertext)`.
  Returns plaintext as `Buffer.from(result)`.

### 2. Writes

| Sink                              | Format                     | Notes                                                                                                 |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DEKCache` (in-process LRU)       | Plaintext `Buffer` copy    | Max 100 entries, 5-min TTL, zero-fill on eviction (`entry.plaintext.fill(0)` at `dek-manager.ts:127`) |
| `_lastAcquiredDekIds` map         | Opaque `dekId` string only | Plaintext NOT stored; only the opaque key reference                                                   |
| MongoDB `dek_registry.wrappedDek` | Never plaintext            | Only the RSA-OAEP-256 ciphertext is persisted                                                         |
| On `DEKEntry.create()` failure    | Zero-filled immediately    | `dek-manager.ts:445`: `plaintext.fill(0)` on every create error                                       |

### 3. Serialization boundaries

DEK plaintext is **not serialized across any process boundary**. It stays in-process:
`acquireDEK()` → `AcquiredDEK.plaintext` → `TenantEncryptionFacade.encrypt()` → AES-GCM encrypt.

### 4. Read paths

| Reader                                      | File:line                | Tenant isolation enforced                        |
| ------------------------------------------- | ------------------------ | ------------------------------------------------ |
| `DEKCache.get(dekId, tenantId?)`            | `dek-manager.ts:91-113`  | ✓ — `entry.tenantId !== tenantId` → cache miss   |
| `DEKManager.getCachedDEK(dekId, tenantId?)` | `dek-manager.ts:731-734` | ✓ — delegates to cache                           |
| `DEKManager.unwrapDEK(dekId, tenantId?)`    | `dek-manager.ts:615-645` | ✓ when tenantId provided; see MEDIUM finding M-1 |
| `TenantEncryptionFacade.decrypt()`          | `shared-encryption:113`  | ✓ — always passes tenantId                       |

`DEKCache.get()` returns `Buffer.from(entry.plaintext)` — a defensive copy, preventing aliasing.

### 5. Policy boundary

| Consumer                  | Verdict                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `TenantEncryptionFacade`  | ✓ — sole approved consumer; in-process only                                   |
| Any HTTP response         | ✓ — absent; no route returns plaintext                                        |
| Kafka / EventBus payloads | ✓ — not applicable to KMS layer                                               |
| Logs / audit events       | ✓ — never logged (log calls only include `dekId`, `tenantId`, `providerType`) |
| DEKEntry MongoDB record   | ✓ — only `wrappedDek` (ciphertext) stored                                     |

### 6. Consumers / sinks

- `TenantEncryptionFacade` → AES-256-GCM (in-process)
- No external system.

### 7. Wiring

Same wiring chain as VALUE 1. Post-PR, `initDEKFacade()` succeeds for azure-keyvault provider in
the workflow-engine deploy context, and `DEKManager.acquireDEK()` can call Azure KMS to wrap/unwrap
DEK plaintext.

### 8. Parallel paths

DEK plaintext lifecycle is identical across all server processes — all call `initDEKFacade()` with
the same `KMSProviderPool` → `DEKManager` → `TenantEncryptionFacade` chain. PR #1009 only restores
parity for workflow-engine (which was broken by the pruned optionals).

### 9. Boundary tests

- [x] `azure-kms-dep-resolution.test.ts` — confirms SDK resolution (prerequisite for the plaintext path).
- [ ] **No integration test exercises the full generate → wrap → unwrap → decrypt cycle with Azure KMS**
      in the workflow-engine context (would require live Azure credentials). Documented as M-2 below.

---

## VALUE 3 — DEK ciphertext (`wrappedDek`, RSA-OAEP-256)

**Data class:** KEY (encrypted)
**Approved consumers:** Azure Key Vault unwrap API only.

### 1. Source

- `azure-keyvault-provider.ts:128-129`: `this.cryptoClient.wrapKey('RSA-OAEP-256', dekPlaintext)` →
  `Buffer.from(wrapResult.result)`.

### 2. Writes

| Sink                                   | Format         | Notes                                                   |
| -------------------------------------- | -------------- | ------------------------------------------------------- |
| MongoDB `dek_registry.wrappedDek`      | base64 string  | `ciphertext.toString('base64')` at `dek-manager.ts:432` |
| `wrappingProvider.authConfigEncrypted` | null (cleared) | `cloneProviderRef()` prevents credential co-location    |

### 3. Serialization boundaries

| Boundary                                    | Direction   | Notes                                           |
| ------------------------------------------- | ----------- | ----------------------------------------------- |
| `CryptographyClient.wrapKey()`              | to Azure KV | RSA-OAEP-256; authenticated via Bearer token    |
| MongoDB write (`DEKEntry.create()`)         | to DB       | base64 ciphertext; safe to store encrypted      |
| `CryptographyClient.unwrapKey()` on decrypt | to Azure KV | ciphertext sent; plaintext returned; HTTPS only |

### 4. Read paths

- `DEKManager.acquireDEK()` → `DEKEntry.findOne({tenantId, projectId, environment, status: 'active'})` ✓
- `DEKManager.unwrapDEK()` → `DEKEntry.findOne({dekId, ...})` — tenantId filter applied when provided ✓

### 5. Policy boundary

The ciphertext is encrypted data and safe at rest. It cannot be unwrapped without Azure Key Vault
access. Ciphertext is never exposed in HTTP responses or logs.

### 6. Consumers / sinks

- Azure Key Vault `unwrapKey` (HTTPS) — the only path to convert ciphertext back to plaintext.

### 7. Wiring

Same as VALUES 1 and 2.

### 8. Parallel paths

Same as VALUE 2.

### 9. Boundary tests

Same as VALUE 2 — no live-Azure integration test in workflow-engine context.

---

## VALUE 4 — `authConfigEncrypted` blob

**Data class:** CREDENTIAL (encrypted)
**Approved consumers:** `decryptAuthConfig()` + local KMS provider only.

### 1. Source

Written by admin credential-management routes (out of scope for PR #1009). Stored as AES-GCM
encrypted base64 string in `materialized_kms_configs` collection.

### 2. Writes

| Sink                                            | Format                              | Notes                                            |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `MaterializedKMSConfig.authConfigEncrypted`     | AES-GCM encrypted base64            | Platform key (ENCRYPTION_MASTER_KEY) encrypts it |
| `DEKEntry.wrappingProvider.authConfigEncrypted` | `null` (zeroed by cloneProviderRef) | **Never persisted to dek_registry** ✓            |

### 3. Serialization boundaries

- `decryptAuthConfig(encrypted, localProvider, 'platform-default', aad)` — in-process decryption only.
- **AAD fallback**: `auth-config-crypto.ts:54-58` — if AAD present but auth-tag mismatches, retries
  without AAD. This is a **migration backward-compat path** (old entries written without AAD). See M-3.

### 4. Policy boundary

| Consumer                      | Verdict                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `resolveAuthConfig()` decrypt | ✓ — in-process only; FAIL CLOSED on error                   |
| `DEKEntry.wrappingProvider`   | ✓ — zeroed by `cloneProviderRef()`                          |
| Error messages                | ✓ — errors include `config.providerType` only, not the blob |
| Logs                          | ✓ — no log call includes the blob value                     |

---

## Findings Summary

| ID  | Severity | Dimension       | Finding                                                                                                                                                                                                                                              |
| --- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 | MEDIUM   | Policy Boundary | `unwrapDEK(dekId, tenantId?)` — tenantId is optional in the interface; DB query skips tenantId filter when absent. Primary caller (`TenantEncryptionFacade.decrypt()`) always provides it, but the API contract permits unisolated calls.            |
| M-2 | MEDIUM   | Boundary Tests  | No integration test exercises the generate → wrap → unwrap → decrypt cycle in workflow-engine context with Azure KMS. The dep-resolution test confirms SDKs load; it does not test the cryptographic path.                                           |
| M-3 | MEDIUM   | Policy Boundary | `decryptAuthConfig()` AAD fallback: if AAD present but auth-tag mismatches, retries without AAD (`auth-config-crypto.ts:54-58`). Migration compat design but weakens AAD binding guarantee on old entries. Pre-existing; not introduced by PR #1009. |

**0 CRITICAL findings. 0 HIGH findings introduced by or made reachable by PR #1009.**

The PR is a **pure dependency declaration fix**. It adds no new data-flow paths; it restores an
existing path that was broken by `pnpm deploy --prod` pruning transitive optional dependencies.
All data-flow controls were already in place.

---

## Per-finding detail

### M-1 — `unwrapDEK` optional `tenantId` weakens API contract

**Severity:** MEDIUM · **Dimension:** Policy Boundary
**Path:** Caller → `DEKManager.unwrapDEK(dekId)` → `DEKEntry.findOne({dekId})` (no tenantId filter).
**Evidence:** `dek-manager.ts:615-645` — `tenantId?: string`; filter at line 621-626 adds tenantId only
when provided. `TenantEncryptionFacade.decrypt()` at `shared-encryption:113` always passes tenantId.
**Impact:** A future caller that omits tenantId can unwrap any tenant's DEK if it obtains the opaque
dekId. dekIds are 96-bit random (base64url of 12 bytes) — guessing is impractical, but the contract
is weaker than necessary.
**Fix:** Make `tenantId` required in `DEKManager.unwrapDEK()` and `batchUnwrapDEKs()`. Update the
`DEKManagerLike` interface in `shared-encryption`. This is a follow-up refactor, not blocking for PR #1009.
**Test:** A unit test that passes `tenantId` of tenant B when unwrapping tenant A's dekId and asserts
an error (or empty result) rather than success.
**Pre-existing:** Yes. Not introduced by PR #1009.

### M-2 — No workflow-engine-scoped KMS integration test

**Severity:** MEDIUM · **Dimension:** Boundary Tests
**Path:** workflow-engine → `initDEKFacade()` → `KMSProviderPool` → `AzureKeyVaultProvider`.
**Evidence:** `apps/workflow-engine/src/__tests__/azure-kms-dep-resolution.test.ts` confirms SDK
resolution but not the cryptographic path.
**Impact:** SDK resolution is confirmed, but a misconfiguration in `AzureKeyVaultProvider` wiring
(e.g. wrong vault URL, wrong key name) would only surface at runtime, not in CI.
**Fix:** Add an optional integration test (skipped unless `AZURE_KV_TEST_*` env vars set) that
exercises `AzureKeyVaultProvider.generateDataKey()` end-to-end.
**Deferral rationale:** Requires live Azure credentials. The existing pattern (dep-resolution test +
pre-existing database-package KMS tests) is standard for this project. Deferring to a KMS integration
test sprint.

### M-3 — `authConfigEncrypted` AAD fallback weakens binding guarantee

**Severity:** MEDIUM · **Dimension:** Policy Boundary
**Path:** `decryptAuthConfig(encrypted, provider, keyId, aad)` → on auth-tag mismatch → retry without AAD.
**Evidence:** `auth-config-crypto.ts:54-58`.
**Impact:** An entry written without AAD (migration period) can be decrypted with any valid
ENCRYPTION_MASTER_KEY, even if the calling context provides incorrect AAD. The fallback prevents
production breakage of legacy entries but means AAD does not provide binding guarantees for those rows.
**Fix:** Add a migration job that re-encrypts all `authConfigEncrypted` blobs with AAD, then remove
the fallback. Pre-existing; not introduced by or fixable in PR #1009 scope.
**Pre-existing:** Yes.

---

## Round 2: Fix verification

| Finding | Fix committed                                | Boundary test                        | Verified      |
| ------- | -------------------------------------------- | ------------------------------------ | ------------- |
| M-1     | Deferred — pre-existing, follow-up refactor  | Deferred                             | ✗ (follow-up) |
| M-2     | Deferred — live Azure credentials required   | Deferred (optional integration test) | ✗ (follow-up) |
| M-3     | Deferred — pre-existing, needs migration job | N/A                                  | ✗ (follow-up) |

All three findings are pre-existing issues and/or require infrastructure not available in CI.
None are introduced or expanded by PR #1009.

**The core wiring fix is verified:**

| Control                                                                 | Verified                                      |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `@azure/keyvault-keys` declared as direct dep                           | ✓ — `apps/workflow-engine/package.json`       |
| `@azure/identity` declared as direct dep                                | ✓ — `apps/workflow-engine/package.json`       |
| Lockfile updated for workflow-engine importer                           | ✓ — `pnpm-lock.yaml` importer section updated |
| Dep-resolution test passes in workflow-engine context                   | ✓ — 2/2 `azure-kms-dep-resolution.test.ts`    |
| `cloneProviderRef()` zeroes authConfigEncrypted before DEKEntry write   | ✓ — `dek-manager.ts:230-240`                  |
| `resolveAuthConfig()` FAIL CLOSED on per-tenant decrypt                 | ✓ — `kms-provider-pool.ts:376-393`            |
| `computeFingerprint()` includes tenantId + SHA-256(authConfigEncrypted) | ✓ — `kms-provider-pool.ts:76-104`             |
| `DEKCache` tenant-isolation enforced on cache hits                      | ✓ — `dek-manager.ts:100-102`                  |
| DEK plaintext zero-filled on create failure                             | ✓ — `dek-manager.ts:445`                      |
| DEK plaintext zero-filled on cache eviction                             | ✓ — `dek-manager.ts:124-129`                  |

## Final verdict

- **0 CRITICAL findings open.**
- **0 HIGH findings open.**
- **3 MEDIUM findings documented** — all pre-existing; none introduced by PR #1009; follow-up items noted.
- **Boundary test added** (`azure-kms-dep-resolution.test.ts`) — guards against future removal of direct deps.
- **All parallel apps verified in parity** — runtime, studio, search-ai, search-ai-runtime all declared direct deps; workflow-engine now matches.
- **All critical security controls verified intact**: `cloneProviderRef()` zeroing, FAIL CLOSED auth config decrypt, tenant-scoped fingerprints, tenant-isolated DEK cache.

**PR #1009 is clean.** The data-flow is sound; the fix is minimal and correct.

Follow-up items (non-blocking):

1. Make `unwrapDEK(dekId, tenantId?)` tenantId required in a future refactor (M-1).
2. Add optional Azure KMS integration test behind env var gate (M-2).
3. Migration job to re-encrypt all `authConfigEncrypted` blobs with AAD, then remove fallback (M-3).
