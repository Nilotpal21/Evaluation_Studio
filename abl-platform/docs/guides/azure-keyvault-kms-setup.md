# Enabling Azure Key Vault as Platform-Level KMS

**Audience**: Platform operators, DevOps engineers
**Prerequisite**: Platform running with `local` KMS provider (default)

---

## 1. Overview

This guide covers switching the platform's encryption provider from `local` (in-process AES-256-GCM derived from `ENCRYPTION_MASTER_KEY`) to **Azure Key Vault** (cloud-managed keys with `A256KW` key wrapping).

After this change:

- All **new** data is encrypted using DEKs wrapped by Azure Key Vault
- All **existing** data remains readable (backward-compatible decrypt)
- A one-time re-encryption job migrates old DEK entries to Azure-wrapped keys

## 2. Prerequisites

### 2.1 Azure Resources

| Resource                              | Purpose                            |
| ------------------------------------- | ---------------------------------- |
| Azure Key Vault instance              | Hosts the KEK (Key Encryption Key) |
| RSA or AES key in the vault           | The KEK used to wrap/unwrap DEKs   |
| Service Principal OR Managed Identity | Authentication to Key Vault        |

Create the vault and key:

```bash
# Create vault
az keyvault create \
  --name abl-platform-kms \
  --resource-group abl-prod \
  --location eastus \
  --sku standard  # or 'premium' for HSM-backed keys

# Create KEK (AES-256 recommended for A256KW wrapping)
az keyvault key create \
  --vault-name abl-platform-kms \
  --name platform-kek \
  --kty RSA \
  --size 2048 \
  --ops wrapKey unwrapKey encrypt decrypt
```

### 2.2 Permissions

The service principal or managed identity needs these Key Vault permissions:

| Operation   | Permission       | Used For                                |
| ----------- | ---------------- | --------------------------------------- |
| `wrapKey`   | Key > Wrap Key   | Wrapping new DEKs                       |
| `unwrapKey` | Key > Unwrap Key | Unwrapping DEKs for decrypt             |
| `encrypt`   | Key > Encrypt    | Direct encryption (small payloads)      |
| `decrypt`   | Key > Decrypt    | Direct decryption                       |
| `get`       | Key > Get Key    | Health checks, key metadata             |
| `create`    | Key > Create Key | Key creation (if auto-rotation enabled) |

For Azure RBAC (recommended over access policies):

```bash
az role assignment create \
  --role "Key Vault Crypto Officer" \
  --assignee <service-principal-object-id> \
  --scope /subscriptions/<sub>/resourceGroups/abl-prod/providers/Microsoft.KeyVault/vaults/abl-platform-kms
```

### 2.3 Platform Requirements

- `ENCRYPTION_MASTER_KEY` must remain set (needed for PBKDF2 legacy fallback and auth config decryption)
- Redis must be available (for re-encryption queue via BullMQ)
- MongoDB must be accessible (DEK entries and tenant configs)

## 3. Environment Variables

### 3.1 Required

| Variable              | Value             | Example                                    |
| --------------------- | ----------------- | ------------------------------------------ |
| `KMS_PROVIDER`        | `azure-keyvault`  | `azure-keyvault`                           |
| `KMS_AZURE_VAULT_URL` | Vault URI         | `https://abl-platform-kms.vault.azure.net` |
| `KMS_AZURE_KEY_NAME`  | Key name in vault | `platform-kek`                             |

### 3.2 Authentication (choose one)

**Option A: Managed Identity (recommended for AKS/Azure VMs)**

No additional env vars needed. Uses `DefaultAzureCredential` which auto-detects:

- Pod identity on AKS (Workload Identity)
- System/User Managed Identity on VMs
- Azure CLI credentials (local development)

**Option B: Service Principal**

| Variable                  | Value                    |
| ------------------------- | ------------------------ |
| `KMS_AZURE_TENANT_ID`     | Azure AD tenant ID       |
| `KMS_AZURE_CLIENT_ID`     | Service principal app ID |
| `KMS_AZURE_CLIENT_SECRET` | Service principal secret |

### 3.3 Keep existing variable

| Variable                | Must remain    | Why                                                                                                                                                     |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY` | Yes, unchanged | Local provider stays alive for: (1) PBKDF2 legacy decrypt fallback, (2) per-tenant auth credential encryption, (3) ClickHouse compressed-encrypted data |

## 4. Deployment Steps

### Step 1: Pre-flight checks

```bash
# Verify Azure Key Vault is reachable from the cluster
curl -s https://abl-platform-kms.vault.azure.net/keys/platform-kek?api-version=7.4

# Verify managed identity can access the vault
az keyvault key show --vault-name abl-platform-kms --name platform-kek
```

### Step 2: Deploy with new env vars

Set the env vars in your deployment config (Helm values, ArgoCD, etc.) and deploy **one pod first** (canary):

```yaml
# helm values example
env:
  ENCRYPTION_MASTER_KEY: '<unchanged>'
  KMS_PROVIDER: 'azure-keyvault'
  KMS_AZURE_VAULT_URL: 'https://abl-platform-kms.vault.azure.net'
  KMS_AZURE_KEY_NAME: 'platform-kek'
  # If using service principal:
  # KMS_AZURE_TENANT_ID: "..."
  # KMS_AZURE_CLIENT_ID: "..."
  # KMS_AZURE_CLIENT_SECRET: "..."
```

### Step 3: Verify startup logs

Look for these log lines in the canary pod:

```
KMS provider pool initialized (providers: local, azure-keyvault)
KMS per-tenant resolver wired into encryption plugin
DEK: TenantEncryptionFacade injected into Mongoose plugin
```

If you see:

```
KMS provider pool health check failed: azure-keyvault
```

Check network/auth. The pod will still start (non-fatal) but Azure wrapping will fail on first use.

### Step 4: Smoke test

Trigger a new encryption in the canary pod (e.g., create a channel connection with credentials, or use the admin API):

```bash
# Encrypt something via the API
curl -X POST http://canary-pod:3112/api/kms/test-encrypt \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"tenantId": "test-tenant", "plaintext": "hello"}'
```

Then verify the DEK entry was created with Azure:

```javascript
// In MongoDB
db.dek_registry.find({ tenantId: 'test-tenant' });
// Should show: kekKeyId: "platform-kek", wrappedDek: "<base64>"
```

### Step 5: Roll out to all pods

Once the canary is healthy, deploy to all pods.

### Step 6: Re-encrypt existing DEKs (optional but recommended)

Existing DEK entries wrapped by the local provider will still work (the local provider is always available). However, for full Azure-only key management, trigger re-encryption:

```bash
# Via KMS admin API — per tenant
curl -X POST http://runtime:3112/api/tenants/:tenantId/kms/keys/rotate \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

This enqueues a BullMQ job that:

1. Finds all DEK entries for the tenant
2. Unwraps each with the **old** provider (local)
3. Re-wraps with the **new** provider (Azure Key Vault)
4. Verifies the re-wrapped DEK by unwrapping it and comparing to original
5. Atomically updates the DEK entry in MongoDB

## 5. Impact on Existing Data

### What changes

| Data Type                                | Before (local)                       | After (Azure)                                 | Action Needed                      |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------- | ---------------------------------- |
| **New DEK-envelope data**                | DEK wrapped by local AES-GCM         | DEK wrapped by Azure A256KW                   | Automatic                          |
| **Existing DEK-envelope data**           | DEK wrapped by local AES-GCM         | Still readable (local provider stays alive)   | Re-encrypt for full Azure coverage |
| **Legacy PBKDF2 hex data** (ire=v3)      | Derived from `ENCRYPTION_MASTER_KEY` | Still readable (PBKDF2 fallback in facade)    | No action needed                   |
| **Legacy CEK data** (ire=v1)             | CEK wrapped by master key            | Still readable (master key unchanged)         | No action needed                   |
| **Legacy CEK/KMS data** (ire=v2)         | CEK wrapped by global KMS provider   | Still readable (v2 decrypt path preserved)    | No action needed                   |
| **ClickHouse compressed data** (Z1:/N0:) | Derived from `ENCRYPTION_MASTER_KEY` | Still readable (separate decrypt path)        | No action needed                   |
| **OAuth tokens**                         | Encrypted via `encryptForTenantAuto` | New tokens use Azure-backed DEKs              | Old tokens still decryptable       |
| **Channel credentials**                  | Encrypted via `encryptForTenantAuto` | New creds use Azure-backed DEKs               | Old creds still decryptable        |
| **Per-tenant auth configs**              | Encrypted by local provider          | Still encrypted by local provider (by design) | No action needed                   |

### Why existing data stays readable

The decrypt chain has built-in format detection and fallback:

```
Ciphertext arrives
  |
  +-- DEK envelope (base64)? --> Parse DEK ID --> unwrapDEK()
  |     |                           |
  |     |                           +-- DEK entry in MongoDB stores which KEK wrapped it
  |     |                           +-- Local provider is always available for old DEKs
  |     |                           +-- Azure provider used for new DEKs
  |     |
  |     +-- On failure + masterKey exists --> Try PBKDF2 fallback
  |
  +-- Legacy hex 3-part? --> PBKDF2 derive key from master key --> AES-GCM decrypt
  |
  +-- ENC:v3: prefix? --> Strip prefix, PBKDF2 decrypt
  |
  +-- CEK document (ire=v1/v2)? --> Unwrap CEK with master key or KMS
  |
  +-- Not encrypted? --> Return as-is
```

### Critical invariant

**`ENCRYPTION_MASTER_KEY` must never change or be removed.** It is required for:

1. PBKDF2 legacy decrypt (all data encrypted before DEK envelope was enabled)
2. Per-tenant `authConfigEncrypted` field decryption (always uses local provider)
3. ClickHouse compressed-encrypted data decrypt
4. Local provider DEK unwrapping (until all DEKs are re-encrypted to Azure)

## 6. Re-Encryption Details

### What re-encryption does

For each `DEKEntry` document in MongoDB:

1. `unwrapKey(oldKekKeyId, wrappedDek)` using the **current** provider for the tenant
2. `wrapKey(newKekKeyId, plaintext)` using the **new** provider
3. Verify: `unwrapKey(newKekKeyId, newWrappedDek)` and compare to original
4. If verification passes: atomically update `wrappedDek`, `kekKeyId`, `kekKeyVersion` in MongoDB
5. If verification fails: skip (logged as error, prevents data loss)
6. Zero-fill plaintext key material in memory after each operation

### Re-encryption is safe because

- **No data is re-encrypted** — only the DEK wrapper changes. The actual encrypted data in documents is untouched.
- **Verification step** prevents silent corruption.
- **Atomic MongoDB update** with `_v` version check prevents race conditions.
- **Idempotent** — re-running the job is safe (already-migrated DEKs are skipped).
- **Batched** — processes 50 DEKs at a time by default, respects graceful shutdown.

### Without re-encryption

If you skip re-encryption:

- Everything still works. The local provider is always kept alive in the pool.
- Old DEKs are unwrapped by the local provider, new DEKs by Azure.
- Mixed state is fully supported and has no security downside.
- Only reason to re-encrypt: if you want to eventually decommission the local key material entirely (requires also migrating all legacy PBKDF2 data, which is a larger project).

## 7. Rollback

To revert to local-only:

1. Remove Azure env vars (`KMS_PROVIDER`, `KMS_AZURE_*`)
2. Redeploy — platform falls back to `local` provider
3. New DEKs will be wrapped by local provider again
4. Any DEKs that were re-encrypted to Azure will need re-encryption back to local (or the Azure env vars must remain readable for those DEKs to be unwrappable)

**Simpler rollback**: Just unset `KMS_PROVIDER`. The local provider handles everything. Any Azure-wrapped DEKs created during the Azure period will fail to unwrap — so only roll back before re-encrypting existing DEKs, or keep Azure credentials available.

## 8. Azure Managed HSM

For FIPS 140-3 Level 3 compliance, use `azure-managed-hsm` instead:

```bash
KMS_PROVIDER=azure-managed-hsm
KMS_AZURE_VAULT_URL=https://abl-platform-hsm.managedhsm.azure.net
KMS_AZURE_KEY_NAME=platform-kek
```

Everything else is identical. The provider subclass (`AzureManagedHSMProvider`) overrides the `providerType` and reports `protectionLevel: 'hsm'` in metadata.

## 9. Monitoring

### Health check

```bash
curl http://runtime:3112/api/tenants/:tenantId/kms/health
```

Returns:

```json
{
  "healthy": true,
  "provider": "azure-keyvault",
  "latencyMs": 45,
  "vaultUrl": "https://abl-platform-kms.vault.azure.net"
}
```

### Key metrics to watch

| Metric                     | Source                     | Alert Threshold                        |
| -------------------------- | -------------------------- | -------------------------------------- |
| KMS wrap/unwrap latency    | KMS audit log (ClickHouse) | > 500ms p99                            |
| DEK cache hit rate         | Runtime logs               | < 80% (indicates frequent cold starts) |
| Re-encryption job failures | BullMQ dashboard / logs    | Any `verification FAILED`              |
| Azure Key Vault throttling | Azure Monitor              | HTTP 429 responses                     |

### Audit trail

All KMS operations are logged to ClickHouse (`kms_audit_events` table):

- `operation`: `wrap_key`, `unwrap_key`, `generate_data_key`, `rotate`
- `provider_type`: `azure-keyvault`
- `tenant_id`, `key_id`, `latency_ms`, `success`, `error`

## 10. Troubleshooting

| Symptom                                                 | Cause                                     | Fix                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `KMS provider pool health check failed: azure-keyvault` | Network/auth issue                        | Check vault URL, managed identity binding, NSG rules                                                                  |
| `A256KW unwrapKey failed`                               | Wrong key version or key rotated in Azure | Pin key version in `KMS_AZURE_KEY_NAME` (e.g., `platform-kek/abc123`) or ensure auto-rotation is configured correctly |
| `DEK not found for dekId X in tenant Y`                 | DEK entry missing in MongoDB              | Check `dek_registry` collection, verify tenant isolation                                                              |
| `Decryption failed with all key versions`               | `ENCRYPTION_MASTER_KEY` changed           | Restore the original master key — legacy data is irrecoverable without it                                             |
| `Re-encryption verification FAILED`                     | Provider mismatch during re-wrap          | Check that the re-encryption job's resolver returns the correct provider                                              |
| `ClientSecretCredential authentication failed`          | Expired or wrong service principal secret | Rotate the secret in Azure AD and update `KMS_AZURE_CLIENT_SECRET`                                                    |
