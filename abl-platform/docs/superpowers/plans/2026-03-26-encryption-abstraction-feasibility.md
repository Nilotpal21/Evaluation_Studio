# Encryption/DEK/KMS Abstraction Feasibility: Black-Box Engines

**Date:** 2026-03-26
**Status:** Analysis (no code changes)

---

## Executive Summary

The current encryption stack has **three logical engines** that are already partially decoupled but still share state through globalThis singletons, duck-typed interfaces, and dynamic imports. Abstracting them into fully independent black-box engines is **feasible with moderate effort** — the dependency graph is already one-directional, and the coupling points are well-defined.

| Engine                                                | Package Today                                  | Independence Level                                    | Effort to Black-Box |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------- |
| **Crypto Engine** (encrypt/decrypt primitives)        | `shared-encryption`                            | **High** — zero imports from other packages           | Low                 |
| **DEK Engine** (key lifecycle + envelope encryption)  | `database/kms` + `shared-encryption/facade`    | **Medium** — duck-typed interface breaks circular dep | Medium              |
| **KMS Engine** (provider abstraction + key hierarchy) | `database/kms/providers` + `database/kms/pool` | **High** — clean `KMSProvider` interface              | Low                 |

---

## Current Architecture: Three Engines in Two Packages

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONSUMER LAYER                               │
│  Mongoose Plugin │ ClickHouse Interceptor │ BullMQ │ Direct     │
└────────┬─────────┴──────────┬─────────────┴───┬────┴─────┬──────┘
         │                    │                  │          │
         ▼                    ▼                  ▼          ▼
┌─────────────────────────────────────────────────────────────────┐
│              FACADE LAYER (TenantEncryptionFacade)              │
│  encrypt(plaintext, scope) → DEK envelope ciphertext            │
│  decrypt(ciphertext) → plaintext  (no scope needed)             │
│  encryptSync/decryptSync (cache-only fast path)                 │
│  PBKDF2 fallback for legacy data                                │
├──────────────────────────┬──────────────────────────────────────┤
│     CRYPTO ENGINE        │         DEK ENGINE                   │
│  (shared-encryption)     │    (database/kms/dek-manager)        │
│                          │                                      │
│  • AES-256-GCM           │  • acquireDEK(scope) → {dek, dekId} │
│  • dek-codec (wire fmt)  │  • unwrapDEK(dekId) → plaintext     │
│  • PBKDF2 key derivation │  • LRU cache (100, 5min TTL)        │
│  • HKDF key derivation   │  • Epoch dedup (concurrent create)  │
│  • Format detection      │  • expiresAt + usageCount rotation  │
│  • Blind index (HMAC)    │  • Fire-and-forget $inc             │
│  • Zstd compress+encrypt │  • DEKRegistry (MongoDB model)      │
├──────────────────────────┴──────────────────────────────────────┤
│                      KMS ENGINE                                 │
│               (database/kms/providers)                          │
│                                                                 │
│  KMSProvider interface → generateDataKey / wrapKey / unwrapKey  │
│  ├── LocalKMSProvider (dev/test)                                │
│  ├── AWSKMSProvider                                             │
│  ├── AzureKeyVaultProvider                                      │
│  ├── AzureManagedHSMProvider                                    │
│  ├── GCPCloudKMSProvider                                        │
│  └── ExternalKMSProvider                                        │
│                                                                 │
│  KMSProviderPool (LRU cache of provider instances)              │
│  KMSResolver (tenant → provider config → provider instance)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Engine-by-Engine Analysis

### Engine 1: Crypto Engine (`packages/shared-encryption`)

**What it owns:** Raw cryptographic operations — AES-256-GCM, PBKDF2 key derivation, HKDF, blind index, format detection, wire format codec, zstd compress-then-encrypt.

**Current boundaries:**

- **Zero external package imports** (only `node:crypto`, `node:zlib`, `@agent-platform/shared-kernel` for error types)
- Self-contained: `EncryptionService`, `dek-codec`, `legacy-format-detection`, key derivation strategies
- Already a leaf package in the dependency graph

**Coupling points:**

- `engine.ts` lines 116-120: `getEncryptionFacade()` — the sync `encryptForTenant` tries DEK cache before PBKDF2. This is the **only** inbound dependency from the DEK engine.
- `facade-accessor.ts`: globalThis bridge that the DEK engine writes to and the Crypto engine reads from

**Black-box feasibility: HIGH**

To make this a true black box:

1. Remove `getEncryptionFacade()` calls from `engine.ts` — the Crypto Engine should not know about the DEK Engine
2. Move `TenantEncryptionFacade` out of `shared-encryption` into its own orchestration layer (or into the DEK engine)
3. The Crypto Engine exposes pure functions: `encryptAESGCM(plaintext, key) → ciphertext`, `decryptAESGCM(ciphertext, key) → plaintext`, `derivePBKDF2Key(master, salt)`, `deriveHKDFKey(master, salt, info)`, `encodeWireFormat(dekId, ciphertext)`, `decodeWireFormat(encoded) → {dekId, ciphertext}`

**Interface contract (black box):**

```typescript
interface CryptoEngine {
  // Raw AES-256-GCM
  encrypt(plaintext: string, key: Buffer): EncryptedPayload;
  decrypt(payload: EncryptedPayload, key: Buffer): string;

  // Wire format (DEK ID + ciphertext)
  encodeEnvelope(plaintext: string, dek: Buffer, dekId: string): string;
  decodeEnvelope(encoded: string, dek: Buffer): string;
  extractDekId(encoded: string): string;

  // Key derivation
  derivePBKDF2(masterKey: Buffer, salt: string): Buffer;
  deriveHKDF(masterKey: Buffer, salt: string, info: string): Buffer;

  // Format detection
  isLegacyFormat(value: string): boolean;
  isDEKEnvelopeFormat(value: string): boolean;

  // Utilities
  blindIndex(key: Buffer, value: string): string;
  compressAndEncrypt(plaintext: string, key: Buffer): string;
  decryptAndDecompress(ciphertext: string, key: Buffer): string;
}
```

**No state. No singletons. No side effects. Pure functions.**

---

### Engine 2: DEK Engine (DEK lifecycle + envelope encryption)

**What it owns:** Data Encryption Key lifecycle — acquire active DEK for scope, unwrap DEK by ID, rotation (time + usage), epoch dedup, LRU cache with zero-fill eviction.

**Current boundaries:**

- `DEKManager` in `packages/database/src/kms/dek-manager.ts` — the core state machine
- `DEKCache` (embedded in dek-manager.ts) — LRU with TTL and zero-fill
- `TenantEncryptionFacade` in `packages/shared-encryption/src/tenant-encryption-facade.ts` — orchestrates Crypto Engine + DEK Engine
- `DEKRegistry` model in `packages/database/src/models/dek-registry.model.ts` — MongoDB persistence

**Coupling points:**

1. **DEKManager → MongoDB** (`DEKEntry` model for persistence) — tight coupling to Mongoose
2. **DEKManager → KMSProvider** (via `getKMSProviderPool()`) — gets the provider to wrap/unwrap DEKs
3. **DEKManager → KMSResolver** (constructor injection) — resolves tenant scope to KMS config
4. **TenantEncryptionFacade → DEKManagerLike** (duck-typed) — only interface coupling, not concrete
5. **TenantEncryptionFacade → dek-codec** (Crypto Engine) — for actual encrypt/decrypt
6. **TenantEncryptionFacade → PBKDF2** (Crypto Engine) — for legacy fallback
7. **globalThis.\_\_encryptionFacade** — singleton bridge between DEK and consumer layers

**Black-box feasibility: MEDIUM**

The main challenge is the **MongoDB coupling**. `DEKManager.acquireDEK()` directly queries/inserts into the `dek_registry` collection using Mongoose. To black-box this:

1. **Extract a `DEKStore` interface:**

```typescript
interface DEKStore {
  findActiveDEK(scope: DEKScope): Promise<DEKEntry | null>;
  findByDekId(dekId: string): Promise<DEKEntry | null>;
  createDEK(entry: NewDEKEntry): Promise<DEKEntry>; // handles E11000 retry
  transitionStatus(dekId: string, from: string, to: string): Promise<boolean>;
  incrementUsage(dekId: string): void; // fire-and-forget
  findByScope(scope: DEKScope): Promise<DEKEntry[]>;
}
```

2. **The concrete `MongoDEKStore`** implements this using the existing `DEKEntry` model
3. **DEKManager** takes `DEKStore` via constructor injection instead of importing the model
4. **The KMS dependency** is already interface-based (`KMSProvider`), so it naturally decouples

**Interface contract (black box):**

```typescript
interface DEKEngine {
  // Core operations
  acquireDEK(scope: DEKScope, kekKeyId: string): Promise<AcquiredDEK>;
  unwrapDEK(dekId: string): Promise<Buffer>;

  // Cache
  getCachedDEK(dekId: string): Buffer | null;
  getActiveDEKId(scope: DEKScope): string | null;
  clearCache(): void;

  // Lifecycle
  forceRotateDEK(scope: DEKScope): Promise<number>;
  destroyDEKsForScope(scope: DEKScope): Promise<number>; // crypto-shred
}

// Dependencies (injected, not imported):
interface DEKEngineDeps {
  store: DEKStore; // persistence (MongoDB, Postgres, etc.)
  kmsProvider: KMSProvider; // key wrapping
  crypto: CryptoEngine; // raw encrypt/decrypt
  config: DEKConfig; // epoch interval, max usage, cache size/TTL
}
```

---

### Engine 3: KMS Engine (provider abstraction + tenant resolution)

**What it owns:** KMS provider lifecycle, BYOK, key hierarchy (PRK → KEK → DEK), per-tenant provider resolution, provider pool management.

**Current boundaries:**

- `KMSProvider` interface in `types.ts` — **already a clean black-box contract**
- 6 concrete providers: Local, AWS, Azure KV, Azure HSM, GCP, External
- `KMSProviderPool` — LRU pool of provider instances
- `KMSResolver` — resolves (tenantId, projectId, environment) → provider config → provider instance

**Coupling points:**

1. **KMSResolver → MongoDB** (`MaterializedKMSConfig`, `TenantKMSConfig` models) — reads tenant config
2. **KMSProviderPool → `IResolvedProviderRef`** (model type) — config shape for fingerprinting
3. **Providers → cloud SDKs** (AWS SDK, Azure SDK, GCP SDK) — external, expected coupling

**Black-box feasibility: HIGH**

The `KMSProvider` interface is already an excellent black-box contract. Each provider is independent. The pool and resolver just need their MongoDB coupling extracted:

1. **Extract a `KMSConfigStore` interface:**

```typescript
interface KMSConfigStore {
  getConfig(
    tenantId: string,
    projectId: string,
    environment: string,
  ): Promise<ResolvedKMSConfig | null>;
  getPlatformDefault(): Promise<ResolvedKMSConfig>;
}
```

2. **`MongoKMSConfigStore`** implements this using existing materialized config models
3. **KMSResolver** takes `KMSConfigStore` via constructor injection

**Interface contract (black box):**

```typescript
interface KMSEngine {
  // Provider management
  getProvider(config: ProviderConfig): Promise<KMSProvider>;
  releaseProvider(fingerprint: string): void;

  // Tenant resolution
  resolveProvider(tenantId: string, projectId: string, environment: string): Promise<KMSProvider>;

  // Health
  healthCheck(tenantId: string): Promise<KMSHealthStatus>;
}

// The KMSProvider interface itself is the inner black box:
interface KMSProvider {
  generateDataKey(keyId: string): Promise<GenerateDataKeyResult>;
  wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult>;
  unwrapKey(keyId: string, ciphertext: Buffer, keyVersion?: number): Promise<Buffer>;
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;
  healthCheck(): Promise<KMSHealthStatus>;
}
```

---

## Dependency Graph: Current vs Target

### Current (implicit coupling)

```
shared-encryption ←──globalThis──── database/kms/dek-facade-factory
       │                                      │
       │ (duck-typed DEKManagerLike)           │ (direct Mongoose model imports)
       │                                      │
       └──── TenantEncryptionFacade ──────────┘
                     │
                     ├── dek-codec (Crypto)
                     ├── DEKManager (DEK + MongoDB)
                     └── KMSProviderPool (KMS + MongoDB)
```

### Target (clean black boxes)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Crypto Engine│     │  DEK Engine  │     │  KMS Engine  │
│              │     │              │     │              │
│ Pure funcs   │◄────│ DEKManager   │────►│ KMSProvider  │
│ No state     │     │ DEKCache     │     │ ProviderPool │
│ No deps      │     │              │     │ Resolver     │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                     │
                     ┌──────▼───────┐     ┌──────▼───────┐
                     │  DEKStore    │     │KMSConfigStore│
                     │  (interface) │     │  (interface)  │
                     └──────┬───────┘     └──────┬───────┘
                            │                     │
                     ┌──────▼─────────────────────▼──────┐
                     │         PERSISTENCE LAYER          │
                     │  MongoDEKStore │ MongoKMSConfigStore│
                     │  (database/models)                  │
                     └─────────────────────────────────────┘
```

---

## Feasibility Scorecard

| Dimension                 | Score | Notes                                                                                                                     |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| **Dependency direction**  | 9/10  | Already one-directional. Only violation: `engine.ts` reads globalThis facade                                              |
| **Interface cleanliness** | 8/10  | `KMSProvider` is excellent. `DEKManagerLike` works but has 4 optional methods. Crypto Engine has no formal interface      |
| **State isolation**       | 6/10  | 2 globalThis singletons + 8 module-scoped singletons. Need DI cleanup                                                     |
| **Persistence coupling**  | 5/10  | DEKManager and KMSResolver import Mongoose models directly. Need store interfaces                                         |
| **Consumer impact**       | 7/10  | 18 Mongoose models + 3 ClickHouse stores + 1 BullMQ + ~15 direct callers. Facade pattern already insulates most consumers |
| **Test isolation**        | 8/10  | Duck-typed interfaces already enable mock injection in tests                                                              |
| **Migration risk**        | 7/10  | Can be done incrementally — extract interface, implement, swap. No big bang                                               |

**Overall: 7.1/10 — Feasible with moderate effort, low risk**

---

## Recommended Refactoring Phases

### Phase A: Extract Crypto Engine Interface (Low effort, high value)

**What:** Create a `CryptoEngine` interface in `shared-encryption`. Make `EncryptionService` implement it. Remove the `getEncryptionFacade()` call from `engine.ts` (the Crypto Engine should not reach up to the DEK layer).

**Files:**

- New: `packages/shared-encryption/src/crypto-engine.ts` (interface)
- Modify: `packages/shared-encryption/src/engine.ts` (implements interface, remove facade call)
- Modify: `packages/shared-encryption/src/tenant-encryption-facade.ts` (accept CryptoEngine for PBKDF2 fallback instead of hardcoding)

**Impact:** Crypto Engine becomes a true black box. Zero breaking changes — `EncryptionService` keeps its existing public API.

### Phase B: Extract DEKStore Interface (Medium effort, high value)

**What:** Create a `DEKStore` interface. Extract MongoDB operations from `DEKManager` into `MongoDEKStore`. DEKManager takes `DEKStore` via constructor injection.

**Files:**

- New: `packages/database/src/kms/dek-store.ts` (interface)
- New: `packages/database/src/kms/mongo-dek-store.ts` (implementation)
- Modify: `packages/database/src/kms/dek-manager.ts` (inject DEKStore instead of importing model)

**Impact:** DEK Engine becomes persistence-agnostic. Tests can use in-memory store. Enables future Postgres/DynamoDB backends.

### Phase C: Extract KMSConfigStore Interface (Low effort, medium value)

**What:** Create a `KMSConfigStore` interface. Extract MongoDB operations from `KMSResolver` into `MongoKMSConfigStore`.

**Files:**

- New: `packages/database/src/kms/kms-config-store.ts` (interface)
- New: `packages/database/src/kms/mongo-kms-config-store.ts` (implementation)
- Modify: `packages/database/src/kms/kms-resolver.ts` (inject store instead of importing model)

**Impact:** KMS Engine becomes persistence-agnostic.

### Phase D: Eliminate globalThis Singletons (Medium effort, high value)

**What:** Replace `globalThis.__encryptionFacade` and `globalThis.__kmsResolver` with proper DI. The `initDEKFacade()` factory returns the constructed objects; callers pass them where needed instead of reading globals.

**This is the hardest phase** because 6+ consumer patterns read from `getEncryptionFacade()`. The Mongoose plugin reads it from a module-scoped variable (set at init time). ClickHouse and BullMQ read it from `getEncryptionService()` which reads globalThis.

**Approach:** Create an `EncryptionContainer` that holds all three engines + the facade. Pass it through Express `req.app.locals` for HTTP paths and through job data / constructor injection for BullMQ/background paths.

### Phase E: Package Restructure (Optional, high effort)

**What:** Move the three engines into separate packages:

- `packages/crypto-engine` (zero deps)
- `packages/dek-engine` (depends on crypto-engine interface only)
- `packages/kms-engine` (depends on cloud SDKs only)
- `packages/encryption-wiring` (composes all three, owns the factory)

**This is optional** — the interface extraction in Phases A-D gives 90% of the black-box benefit without the package restructure overhead.

---

## Key Risks and Mitigations

| Risk                        | Impact                                                                    | Mitigation                                                                                              |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Breaking the sync fast path | Hot-path encryption latency increases if sync cache hit path is disrupted | Keep `encryptSync`/`decryptSync` on the facade; only the orchestration changes, not the cache mechanics |
| Mongoose plugin coupling    | Plugin reads facade from module-scoped var set at init                    | Maintain the current pattern (set at init, read in hooks) — just formalize the DI contract              |
| Duck-typed interface drift  | `DEKManagerLike` and `DEKManager` can diverge silently                    | Phase B makes this explicit via a real interface. Add a type assertion test                             |
| globalThis removal scope    | 15+ files read/write globalThis singletons                                | Phase D is incremental — start with new code using DI, keep globalThis as deprecated bridge             |
| Test regressions            | 166+ encryption tests exist                                               | Each phase is backward-compatible — old tests continue passing                                          |

---

## Verdict

**All three engines can be cleanly black-boxed.** The architecture is already 70% there:

1. **Crypto Engine** — already independent, just needs a formal interface
2. **KMS Engine** — `KMSProvider` is already a perfect black-box interface; pool/resolver just need store extraction
3. **DEK Engine** — needs the most work (MongoDB store extraction + DI for cache), but the duck-typed `DEKManagerLike` proves the interface is viable

**Recommended order:** A → B → C → D (skip E unless packaging becomes a real pain point). Each phase is independently valuable and can be shipped in isolation.
