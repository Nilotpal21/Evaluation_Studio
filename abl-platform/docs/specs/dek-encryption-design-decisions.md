# DEK Envelope Encryption — Design Decisions

> Reference document for all architectural decisions made during DEK/KMS PR #505 remediation.
> These decisions govern the implementation on branch `feature/epoch-removal-dek-cache-fix`.

---

## Decision 1: No Existing DEK Data — Greenfield Schema

**Context:** DEK envelope encryption was never wired in any deployed environment.

**Decision:** Treat the DEK registry schema as greenfield. No backward compatibility, no migration scripts, no default fallback values for missing fields.

**Implications:**

- `projectId` and `environment` are required fields, not defaulted
- No legacy indexes kept alongside new ones
- No `'_default'` fallback logic for missing fields

---

## Decision 2: Encryption Plugin Scope — Hybrid A+C

**Context:** The Mongoose encryption plugin needs to know the DEK scope (tenant, project, environment) when encrypting. Two approaches considered: AsyncLocalStorage (invisible context) vs document fields (explicit).

**Decision:** Hybrid — per-model scope declaration at plugin registration + document fields for `tenantId`/`projectId` + AsyncLocalStorage for `environment`.

**Two scope levels:**

- `tenant` — uses `tenantId` only (from document)
- `project` — uses `tenantId` + `projectId` + `environment` (tenantId/projectId from document, environment from document field or AsyncLocalStorage)

**No platform scope level.** When KMS is not configured per tenant, the KMS resolver internally falls back to platform config. The plugin never needs to know about platform-level KMS.

**Plugin registration examples:**

```typescript
// Environment on document:
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedValue'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' },
});

// Environment from AsyncLocalStorage:
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['content'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

// Tenant-only:
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedKey'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});
```

**Plugin environment resolution order:**

1. `scopeFields.environment` configured and field exists on doc → use doc value
2. Else → read from AsyncLocalStorage
3. Else → `'_shared'` (see Decision 7)

**Fail-closed:** If scope is `project` and `tenantId` or `projectId` is missing on the document → throw with model name in error.

**Why hybrid over pure AsyncLocalStorage:**

- `tenantId` and `projectId` are always on the document — reading from doc is explicit and debuggable
- Only `environment` needs async context — minimal invisible data
- BullMQ workers don't need to set tenantId/projectId in context, just environment
- Testing is simpler — put fields on test doc, only mock context for environment

**Why hybrid over pure document fields:**

- Only 1 out of 18 encrypted models has `environment` on the document
- Adding `environment` to all models would be schema bloat for deployment context that doesn't belong on the data model

---

## Decision 3: Opaque DEK ID (nanoid)

**Context:** DEK IDs are embedded in ciphertext and used for decrypt lookup. Options: semantic epoch-based strings vs opaque random IDs.

**Decision:** DEK IDs are opaque `nanoid(16)` strings (e.g., `"V1StGXR8_Z5jdHi6"`).

**Wire format:** `base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)` — unchanged.

**Why opaque:**

- **Performance:** Decrypt is a single-field unique index lookup (`{ dekId }`) vs 5-field compound index
- **Reliability:** No string parsing, no format to get wrong, no regex queries
- **Decrypt needs no scope:** dekId is globally unique — eliminates scope from the entire decrypt path
- **Simplifies plugin find hooks:** Extract dekId from ciphertext, look up directly, no scope resolution needed

**What this resolved:**

- "Should decrypt use scope from ciphertext or caller?" → Neither. dekId alone is sufficient.
- "What scope does the plugin find hook use?" → No scope needed. Just dekId.
- Cache key is just `dekId` — no scope prefix needed.

**Tradeoff:** Can't tell when a DEK was created by looking at its ID. Requires DB lookup for audit/debugging. Acceptable since this is rare outside operational tooling.

---

## Decision 4: DEK Registry Schema — epoch for Dedup, No rotationSeq

**Context:** Multiple pods may try to create a DEK simultaneously. Need a dedup mechanism.

**Decision:** Keep `epoch` field as an idempotency/dedup key for concurrent DEK creation. Drop `rotationSeq`.

**Why epoch is needed:**
Without epoch, two pods both see "no active DEK" and create two different nanoid DEKs — both succeed, resulting in two active DEKs for the same scope. With epoch, both pods try to create with the same epoch string — unique index causes one to fail → retry → find the winner's DEK.

**Why rotationSeq is not needed:**
Forced/usage-based rotations create a new DEK with a new nanoid and a new epoch (current time). The old DEK transitions to `decrypt_only`. No need to track sequence within an epoch.

**Final schema:**

```typescript
{
  dekId: string,          // nanoid(16), globally unique, in ciphertext
  tenantId: string,       // required
  projectId: string,      // required
  environment: string,    // required
  epoch: string,          // "2026-03-25T12" — dedup key for concurrent creation
  status: 'active' | 'decrypt_only' | 'destroyed',
  wrappedDek: string,     // encrypted DEK material
  kekKeyId: string,
  kekKeyVersion: number,
  usageCount: number,
  maxUsageCount: number,
  expiresAt: Date,        // precomputed epoch boundary
  destroyedAt: Date | null,
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes:**

- `{ dekId: 1 }` unique — decrypt lookup
- `{ tenantId: 1, projectId: 1, environment: 1, epoch: 1 }` unique — creation dedup
- `{ tenantId: 1, projectId: 1, environment: 1, status: 1 }` — find active DEK
- `{ status: 1 }` — rotation job
- `{ kekKeyId: 1, status: 1 }` — re-encryption queries

---

## Decision 5: expiresAt Kept for Performance

**Context:** Should time-based rotation compare epochs (requires reading tenant config) or check a precomputed `expiresAt`?

**Decision:** Keep `expiresAt`. Set it on DEK creation as `epochBoundary + intervalMs`.

**Why:** Acquire hot path checks `activeEntry.expiresAt < now` — no tenant config lookup needed. `expiresAt` is a precomputed cache of the epoch boundary. Saves a DB read on every encrypt call.

---

## Decision 6: Usage Count — Fire-and-Forget $inc

**Context:** Every `acquireDEK` call increments usage. Options: awaited `$inc`, batch flush, or fire-and-forget.

**Decision:** Fire-and-forget `$inc` — non-blocking, eventually consistent.

**Why:** `maxUsageCount` default is 2^30 (~1 billion). It's a safety ceiling, not a precise threshold. Overshooting by a few hundred under concurrency is irrelevant. Zero latency impact on the encrypt hot path.

```typescript
// After acquiring DEK, fire-and-forget:
DEKEntry.updateOne({ dekId }, { $inc: { usageCount: 1 } }).catch((err) => {
  log.warn('Usage count increment failed', { dekId, error: err.message });
});
```

---

## Decision 7: Environment Default — '\_shared'

**Context:** Some project-scoped models (channel connections, SDK channels, tool secrets, MCP configs, service nodes) don't have an `environment` field and aren't environment-specific today. But DEK scope requires environment.

**Decision:** Use `'_shared'` as the default environment when no environment context is available.

**Current state by model:**

| Model                 | Has environment? | Scope                                    |
| --------------------- | ---------------- | ---------------------------------------- |
| EnvironmentVariable   | Yes (on doc)     | `(tenant, project, doc.environment)`     |
| Message               | No               | `(tenant, project, context.environment)` |
| SessionState          | No               | `(tenant, project, context.environment)` |
| SessionOAuthArtifact  | No               | `(tenant, project, context.environment)` |
| ChannelConnection     | No               | `(tenant, project, '_shared')`           |
| SDKChannel            | No               | `(tenant, project, '_shared')`           |
| ToolSecret            | No               | `(tenant, project, '_shared')`           |
| MCPServerConfig       | No               | `(tenant, project, '_shared')`           |
| ServiceNode           | No               | `(tenant, project, '_shared')`           |
| AuthProfile           | No               | `(tenant, project, '_shared')`           |
| LLMCredential         | No projectId     | `(tenant)`                               |
| WebhookSubscription   | No projectId     | `(tenant)`                               |
| EndUserOAuthToken     | No projectId     | `(tenant)`                               |
| TenantServiceInstance | No projectId     | `(tenant)`                               |
| Organization          | No projectId     | `(tenant)`                               |
| OrgProxyConfig        | No projectId     | `(tenant)`                               |
| ArchWorkspaceConfig   | No projectId     | `(tenant)`                               |
| User                  | No projectId     | `(tenant)`                               |

**Migration path when models become environment-specific:**

Later, when deployments snapshot all resources per-environment (like `DeploymentVariableSnapshot` does for env vars today):

1. **No re-encryption needed for reads:** Opaque dekId means old `'_shared'` ciphertext decrypts from any context. Decrypt never needs scope.

2. **Active migration via re-encryption queue:**
   - Read old record → decrypt (opaque dekId, works) → re-encrypt under `(tenant, project, 'production')` DEK → save
   - Old `'_shared'` DEK transitions to `decrypt_only` → eventually `destroyed`
   - The re-encryption queue already exists (`reencryption-queue.ts`)

3. **Plugin config change only:**

   ```typescript
   // Before (environment from context, falls back to '_shared'):
   scopeFields: { tenantId: 'tenantId', projectId: 'projectId' }

   // After (environment from document):
   scopeFields: { tenantId: 'tenantId', projectId: 'projectId', environment: 'environment' }
   ```

4. **Incremental per-model migration:** Each model migrates independently. Old and new ciphertext coexist.

**Why this is clean:**

- Decrypt never needs scope (opaque dekId) → no dual code paths during migration
- Re-encryption is just `decrypt(old) → encrypt(new scope)` → queue already exists
- No feature flags, no backwards-compat shims

---

## Decision 8: forceRotateDEK Scope — Flexible

**Context:** When admin triggers manual rotation, what gets rotated?

**Decision:** API accepts optional `projectId`/`environment`. If provided, rotate that specific scope. If omitted, rotate all DEKs for the tenant.

**Use cases:**

- Key compromise → rotate all for tenant (omit project/env)
- Routine rotation for one environment → rotate specific scope

---

## Decision 9: Epoch Config — Per Tenant

**Context:** Should `dekEpochIntervalHours` and `dekMaxUsageCount` be per `(tenant, project, environment)` or per tenant?

**Decision:** Per tenant, in `TenantKMSConfig`. Not per project or environment.

**Why:** Rotation policy is an organizational concern, not a per-project concern. Simpler config surface. Can always narrow scope later if needed.

---

## Decision 10: KMS Admin API — Separate Endpoints

**Context:** How to manage project/environment KMS config overrides.

**Decision:** Separate endpoints per scope: `PUT /kms/config/projects/:projectId/environments/:environment`.

**Why:** Better for UI that manages one project at a time. More granular validation. Admin-only (low traffic), so extra routes are fine.

---

## Decision 11: Materializer Trigger — Sync on Config Change

**Context:** When does the materializer resolve the 5-level KMS config inheritance chain?

**Decision:** Synchronously in the PUT/POST config handler, after saving.

**Why:**

- Admin expects changes to take effect immediately
- Config changes are rare — latency on admin request is fine
- No BullMQ job to manage, monitor, or debug
- If periodic needed later for drift correction, can add targeted triggers at that point

---

## Decision 12: Encryption Context Middleware — Two-Layer

**Context:** Where to set AsyncLocalStorage context for environment.

**Decision:** Two-layer middleware:

1. Global middleware (after auth): sets `{ environment: null }` — tenant routes don't need environment
2. Project route middleware (`/projects/:projectId/*`): overrides with `{ environment }` from deployment context or request

**Safety net:** Plugin validates scope completeness. If model declares `scope: 'project'` but environment resolves to missing and model doesn't fall back to `'_shared'` → throw with route path in error.

---

## Decision 13: DEK Naming — Epoch-Based with 12h Minimum

**Context:** How to calculate epoch strings for DEK dedup.

**Decision:** `calculateEpoch(intervalHours)` produces strings like `"2026-03-25T12"` with 12-hour minimum granularity.

```typescript
function calculateEpoch(intervalHours: number): string {
  const intervalMs = Math.max(intervalHours, 12) * 60 * 60 * 1000;
  return new Date(Math.floor(Date.now() / intervalMs) * intervalMs).toISOString().slice(0, 13);
}
```

**Note:** The epoch string is only used for dedup (unique index) and operational visibility. The `dekId` (nanoid) is what gets embedded in ciphertext and used for decrypt lookup.

---

## Decision 14: Decryption Failure Policy — Return Encrypted with Warning

**Context:** When decryption fails (DEK not found, KMS unavailable, corrupted ciphertext), what should the plugin/facade return?

**Decision:** Return the encrypted value as-is, with a warning log.

**Why:** Throwing would break reads across the board if a single field can't decrypt. Returning null loses data. Returning the ciphertext preserves it — callers can retry later or surface it in UI as "encrypted/unavailable".

**Warning log:** Every return-encrypted event logs model name, field, tenantId, and dekId (if extractable) so operations can investigate.

```typescript
log.warn('[encryption-plugin] Decryption failed, returning ciphertext', {
  model: modelName,
  field,
  tenantId,
  dekId: extractedDekId ?? 'unknown',
  error: err instanceof Error ? err.message : String(err),
});
return encryptedValue; // return as-is
```

---

## Decision 15: Cross-Pod DEK Cache Invalidation via Redis Pub/Sub

**Context:** When `forceRotateDEK()` is called on one pod, only that pod's L1 DEK cache is evicted. Other pods continue using the rotated (now `decrypt_only`) DEK for up to 5 minutes (L1 TTL). This delays the effect of rotation.

**Decision:** Add an `InvalidationTransport` interface to `DEKManager` (matching the existing pattern in `KMSResolver`). On rotation, publish `{ tenantId }` to Redis channel `kms:dek:invalidate`. All subscriber pods evict their L1 DEK cache and `_lastAcquiredDekIds` for that tenant.

**Implications:**

- `packages/database` remains Redis-free — transport is injected via `setInvalidationTransport()`
- L1 TTL remains the backstop if Redis is unavailable (graceful degradation)
- Separate channels for DEK cache (`kms:dek:invalidate`) and KMS config cache (`kms:config:invalidate`)
- Fire-and-forget publish — rotation succeeds even if pub/sub fails

**Trade-offs:**

- (+) Rotation takes effect within seconds across all pods instead of up to 5 minutes
- (+) Follows established pattern from KMSResolver
- (-) Adds Redis pub/sub dependency for optimal behavior (but not for correctness)
- (-) Requires wiring in server startup code

---

## Summary Table

| #   | Decision              | Choice                                                 |
| --- | --------------------- | ------------------------------------------------------ |
| 1   | Existing data         | Greenfield, no compat                                  |
| 2   | Plugin scope approach | Hybrid: doc fields + AsyncLocalStorage for environment |
| 3   | DEK ID format         | Opaque nanoid(16)                                      |
| 4   | Registry schema       | epoch for dedup, no rotationSeq                        |
| 5   | expiresAt             | Keep — precomputed for hot path                        |
| 6   | Usage count           | Fire-and-forget $inc                                   |
| 7   | Default environment   | '\_shared' with clean migration path                   |
| 8   | forceRotateDEK        | Flexible — optional scope params                       |
| 9   | Epoch config          | Per tenant                                             |
| 10  | Admin API             | Separate endpoints per scope                           |
| 11  | Materializer trigger  | Sync on config change                                  |
| 12  | Middleware            | Two-layer (global + project routes)                    |
| 13  | Epoch naming          | Time-based, 12h minimum granularity                    |
| 14  | Decryption failure    | Return encrypted value + warning log                   |
| 15  | Cross-pod DEK cache   | Redis pub/sub invalidation via InvalidationTransport   |
