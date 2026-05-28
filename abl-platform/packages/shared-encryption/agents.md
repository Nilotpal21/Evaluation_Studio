# shared-encryption — Package Learnings

> Append-only. Read before modifying this package. Write after completing work.

---

## 2026-03-26 — DEK Envelope Encryption Core

### Wire Format (dek-codec.ts)

- Format: `base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)`
- `idLen` byte encodes dekId length, allowing variable-length IDs
- Uses AES-256-GCM with random 12-byte IV per encryption
- `encryptWithDEK` / `decryptWithDEK` — NOT `encrypt`/`decrypt` (avoid confusion with engine.ts)

### TenantEncryptionFacade Pattern

- Single facade instance on `globalThis.__encryptionFacade` via `facade-accessor.ts`
- Delegates to `DEKManagerLike` interface (duck-typed to avoid circular import with `packages/database`)
- `encrypt(plaintext, scope)` / `decrypt(ciphertext, tenantId)` — decrypt needs no scope (dekId is globally unique)
- Unsupported tenant ciphertext is rejected immediately; no legacy tenant fallback remains

### Envelope Format Detection

- `envelope-format.ts` is the single source of truth for DEK envelope detection
- Format check is heuristic-based — base64 validity, length, first-byte range, and embedded DEK-id header sanity

### Buffer Safety

- `TenantKeyCache` and `DEKCache` must store `Buffer.from(original)` copies, NOT references
- Zero-fill on eviction: `entry.key.fill(0)` — prevents memory scraping
- Callers must NOT zero-fill returned buffers (would corrupt cache)

### Logging Pattern

- Cannot import `createLogger` (circular dep with `@abl/compiler/platform`)
- Uses `createStderrLogger()` from `stderr-logger.ts` — structured JSON to stderr
- Container-friendly, picked up by log aggregators

### Encryption Context (AsyncLocalStorage)

- `runWithEncryptionContext({ environment })` wraps request handlers
- `getEncryptionEnvironment()` returns current environment or `null`
- Plugin reads environment from: doc field → ALS → `'_shared'` default

### Scope Sentinels

- `'_shared'`: project-scoped models without environment context
- `'_tenant'`: tenant-scoped models (projectId and environment both set to `'_tenant'`)

## 2026-05-15 — Workflow-Docling Queue Encryption (Phase 4) — ABLP-1073

**Category**: pattern | gotcha
**Learning**: `REDIS_QUEUE_ENCRYPTION_MANIFEST['workflow-docling-extraction'].fieldsToEncrypt` includes `'callbackSecret'`. The BullMQ payload carries a plaintext HMAC secret used by the worker to sign its callback POST; without encryption at-rest the secret would sit in Redis in plaintext until job pickup. Engine encrypts in `apps/workflow-engine/src/index.ts` via `wrapJobDataForEncrypt(...)` before `.add()`; worker decrypts in `apps/search-ai/src/workers/branches/extraction-only.ts` via `unwrapJobDataForDecrypt(...)`. `decryptFields` returns the row unchanged if `_enc` is missing — older jobs that landed before the manifest entry still dequeue safely. `encryptFields` THROWS if `_enc` is already set; never double-wrap.
**Files**: `src/encryption-manifest.ts:35`, `src/secure-queue.ts`, `src/field-interceptor.ts`.
**Impact**: New BullMQ queues that carry secrets (callback tokens, API keys, OAuth refresh tokens) must add their queue + sensitive field to the manifest AND both producer and consumer must call the wrap/unwrap helpers. Data-flow audit (CLAUDE.md mandatory check) should always trace BullMQ payloads as a separate boundary.
