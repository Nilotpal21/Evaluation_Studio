# Encryption / DEK / KMS Architecture Diagrams

**Date:** 2026-03-26
**Status:** Reference documentation

---

## 1. Current Architecture: Component Map

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            CONSUMER LAYER                                       │
│                                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  18 Mongoose  │  │ 5 ClickHouse │  │  1 BullMQ    │  │  ~15 Direct Call   │  │
│  │  Models       │  │ Stores       │  │  Queue       │  │  Sites             │  │
│  │              │  │              │  │              │  │                    │  │
│  │ .save()      │  │ .insert()    │  │ .add()       │  │ encryptForTenant() │  │
│  │ .find()      │  │ .query()     │  │ .process()   │  │ decryptForTenant() │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘  │
│         │                  │                  │                    │              │
└─────────┼──────────────────┼──────────────────┼────────────────────┼──────────────┘
          │                  │                  │                    │
          ▼                  ▼                  ▼                    ▼
┌─────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│ encryption      │  │ ClickHouse   │  │ secure-queue │  │ encryptForTenantAuto │
│ .plugin.ts      │  │ Interceptor  │  │ .ts          │  │ decryptForTenantAuto │
│                 │  │              │  │              │  │ (index.ts)           │
│ ASYNC           │  │ SYNC ✗       │  │ SYNC ✗       │  │ ASYNC ✓              │
│ Uses facade ✓   │  │ Uses legacy  │  │ Uses legacy  │  │ Uses facade ✓        │
│ Per-model scope │  │ EncService   │  │ EncService   │  │ Scope: _tenant only  │
│ ALS environment │  │ PBKDF2 only  │  │ PBKDF2 only  │  │                      │
└────────┬────────┘  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘
         │                  │                  │                      │
         │ facade.encrypt() │ encService       │ encService           │ facade ??
         │ facade.decrypt() │ .encryptFor      │ .encryptFor          │   ?? encService
         │                  │  Tenant()        │  Tenant()            │
         ▼                  ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│                      TenantEncryptionFacade                                     │
│                  (shared-encryption/tenant-encryption-facade.ts)                 │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │ encrypt(plaintext, scope: DEKScope) → base64 ciphertext               │    │
│  │ decrypt(ciphertext, tenantId) → plaintext  (no scope needed!)         │    │
│  │ encryptSync(plaintext, scope) → ciphertext | null  (cache-only)       │    │
│  │ decryptSync(ciphertext) → plaintext | null  (cache-only)              │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  Internally delegates to:                                                       │
│  ┌──────────────────────┐     ┌──────────────────────────────────────────┐      │
│  │ DEKManagerLike        │     │ dek-codec (Crypto Engine)               │      │
│  │ (duck-typed interface)│     │ encryptWithDEK(plain, dek, dekId)       │      │
│  │                      │     │ decryptWithDEK(cipher, dek)             │      │
│  │ acquireDEK(scope)    │     │ Wire: base64(idLen+dekId+iv+tag+cipher) │      │
│  │ unwrapDEK(dekId)     │     └──────────────────────────────────────────┘      │
│  │ getCachedDEK(dekId)  │     ┌──────────────────────────────────────────┐      │
│  │ getActiveDEKId(scope)│     │ PBKDF2 Legacy Fallback                  │      │
│  └──────────────────────┘     │ isLegacyFormat() → derivePBKDF2Key()    │      │
│                                │ hex 3-part / ENC:v3: / Z1: / N0:       │      │
│                                └──────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Architecture: Data Flow (Encrypt Path)

```
 model.save()                              ClickHouse insert()           BullMQ .add()
      │                                          │                            │
      ▼                                          ▼                            ▼
 ┌────────────┐                          ┌───────────────┐           ┌───────────────┐
 │ Plugin      │                          │ Interceptor    │           │ secure-queue   │
 │ pre('save') │                          │ beforeInsert() │           │ wrapJobData    │
 └─────┬──────┘                          └───────┬───────┘           │ ForEncrypt()   │
       │                                         │                    └───────┬───────┘
       ▼                                         │                            │
 resolveDEKScope()                               │                            │
 ┌──────────────────┐                            │                            │
 │ tenantId: doc     │                            │                            │
 │ projectId: doc    │                            │                            │
 │ environment:      │                            │                            │
 │   doc → ALS →     │                            │                            │
 │   '_shared'       │                            │                            │
 └────────┬─────────┘                            │                            │
          │                                       │                            │
          ▼                                       ▼                            ▼
 ┌──────────────────┐               ┌──────────────────────────────────────────────┐
 │ facade.encrypt() │               │        EncryptionService.encryptForTenant()  │
 │ (ASYNC, DEK)     │               │        (SYNC, opportunistic DEK)             │
 └────────┬─────────┘               │                                              │
          │                          │  1. getEncryptionFacade() → try encryptSync  │
          ▼                          │     (DEK cache hit → DEK envelope ✓)         │
 ┌──────────────────┐               │  2. Cache miss → PBKDF2 fallback ✗           │
 │ dekManager       │               │     deriveTenantKey(tenantId)                │
 │ .acquireDEK()    │               │     encryptToHex3Part()                      │
 │                  │               └──────────────────────────────────────────────┘
 │ 1. Check cache   │                         │
 │ 2. MongoDB lookup │                         │
 │ 3. KMS unwrap    │                         ▼
 │ 4. Or: generate  │               ┌──────────────────┐
 │    new DEK       │               │ Ciphertext:       │
 └────────┬─────────┘               │ ivHex:tag:cipher  │  ← PBKDF2 legacy
          │                          │ (hex 3-part)      │
          ▼                          │ or ENC:v3:...     │
 ┌──────────────────┐               └──────────────────┘
 │ dekCodec         │
 │ .encryptWithDEK  │
 │                  │
 │ AES-256-GCM      │
 │ random IV        │
 │ embed dekId      │
 └────────┬─────────┘
          │
          ▼
 ┌──────────────────┐
 │ Ciphertext:       │
 │ base64(idLen +    │  ← DEK envelope
 │  dekId + iv +     │
 │  authTag + data)  │
 └──────────────────┘
```

---

## 3. Current Architecture: State & Singleton Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          globalThis (process-wide)                          │
│                                                                             │
│  .__encryptionFacade ──→ TenantEncryptionFacade instance                   │
│  .__kmsResolver ───────→ KMSResolver instance                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│              Module-Scoped Singletons (set once at startup)                 │
│                                                                             │
│  shared-encryption/index.ts                                                │
│  └── instance: EncryptionService ──→ owns tenantKeyCache (LRU 100)         │
│                                                                             │
│  shared-encryption/encryption-context.ts                                   │
│  └── encryptionContext: AsyncLocalStorage<{environment}>                    │
│                                                                             │
│  database/kms/kms-registry.ts                                              │
│  ├── platformProvider: LocalKMSProvider                                     │
│  └── providerPool: KMSProviderPool ──→ owns providers (LRU Map, max 50)    │
│                                                                             │
│  database/kms/kms-resolver.ts                                              │
│  └── _platformDefault: ResolvedKMSConfig (lazy from env vars)              │
│                                                                             │
│  database/plugins/encryption.plugin.ts (6 variables!)                       │
│  ├── masterKeyBuffer: Buffer                                                │
│  ├── kmsProvider: KMSProvider                                               │
│  ├── kmsKeyId: string                                                       │
│  ├── encryptionFacade: TenantEncryptionFacade  ← DUPLICATE of globalThis   │
│  ├── tenantEncryption: { encrypt, decrypt }                                 │
│  └── kmsResolverFn: (tenantId) → KMSProvider                               │
│                                                                             │
│  runtime/services/kms/kms-audit-logger.ts                                  │
│  └── clickhouseAvailable: boolean                                           │
│                                                                             │
│  runtime/services/kms/kms-rotation-job.ts                                  │
│  └── rotationTimer: NodeJS.Timeout                                          │
│                                                                             │
│  runtime/services/kms/reencryption-queue.ts                                │
│  ├── bullQueue, bullWorker                                                  │
│  ├── initialized, shutdownRequested                                         │
│                                                                             │
│  runtime/services/stores/clickhouse-encryption-singleton.ts                │
│  └── interceptor: ClickHouseEncryptionInterceptor                           │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│              Instance-Level Caches (inside singletons)                      │
│                                                                             │
│  DEKManager (held by TenantEncryptionFacade)                               │
│  ├── cache: DEKCache (LRU Map, 100 entries, 5min TTL, zero-fill evict)     │
│  ├── inflight: Map<scope, Promise> (dedup, max 500)                         │
│  └── _lastAcquiredDekIds: Map<scope, dekId> (hot-path shortcut, max 1000)  │
│                                                                             │
│  KMSProviderPool                                                           │
│  ├── providers: Map<fingerprint, PooledProvider> (LRU, max 50)             │
│  └── localProvider: LocalKMSProvider (always kept)                          │
│                                                                             │
│  KMSResolver                                                               │
│  └── cache: KMSConfigCache (Map, 500 entries, 60s TTL)                      │
│                                                                             │
│  EncryptionService                                                         │
│  └── tenantKeyCache: TenantKeyCache (LRU, 100 entries, 60s TTL)            │
└─────────────────────────────────────────────────────────────────────────────┘

  Total: 2 globalThis + 14 module singletons + 7 instance caches = 23 mutable state locations
```

---

## 4. Current Architecture: Server Startup Wiring Sequence

```
  server.ts startup
       │
       │  ① Import ALS helpers
       ▼
  ┌──────────────────────────────────────────────────┐
  │ app.use(Layer 1 ALS middleware)                   │  ── { environment: null }
  │ app.use('/api/projects/:projectId', Layer 2 ALS) │  ── { environment: from req }
  └──────────────────────────┬───────────────────────┘
                             │
       ② Read ENCRYPTION_MASTER_KEY from env
       ③ setMasterKey(hex) ──→ encryption.plugin.ts:masterKeyBuffer
                             │
       ④ new KMSProviderPool({masterKeyHex})
         pool.initialize() ──→ creates LocalKMSProvider
         setKMSProviderPool(pool) ──→ kms-registry.ts:providerPool + platformProvider
                             │
       ⑤ new KMSResolver()
         setGlobalKMSResolver(resolver) ──→ globalThis.__kmsResolver
         resolver.subscribeInvalidation() ──→ Redis pub/sub listener
                             │
       ⑥ setKMSResolverFn(fn) ──→ encryption.plugin.ts:kmsResolverFn
                             │
       ⑦ initDEKFacade({masterKeyHex})
         │
         ├─ new KMSResolver()           ← NOTE: second resolver instance!
         ├─ new DEKManager(resolver)
         ├─ new TenantEncryptionFacade(dekManager, masterKey)
         └─ setEncryptionFacade(facade) ──→ encryption.plugin.ts:encryptionFacade
                                        ──→ globalThis.__encryptionFacade
                             │
       ⑧ setTenantEncryption({encryptForTenant, decryptForTenant})
         ──→ encryption.plugin.ts:tenantEncryption (PBKDF2 fallback)
                             │
       ⑨ Start rotation job, reencryption queue, audit logger
                             │
       ▼
  Server ready — all 23 state locations populated
```

---

## 5. Current Architecture: Dependency Graph (Package Level)

```
                        ┌──────────────────────┐
                        │   apps/runtime       │
                        │   apps/search-ai     │
                        │   apps/search-ai-rt  │
                        │   apps/studio        │
                        │   apps/workflow-eng   │
                        └─────────┬────────────┘
                                  │
                    ┌─────────────┼────────────────┐
                    │             │                  │
                    ▼             ▼                  ▼
          ┌─────────────┐ ┌────────────┐  ┌────────────────┐
          │  packages/   │ │ packages/  │  │  packages/     │
          │  shared      │ │ connectors │  │  eventstore    │
          │  (re-export) │ │            │  │                │
          └──────┬──────┘ └─────┬──────┘  └───────┬────────┘
                 │              │                   │
                 ▼              │                   │
     ┌───────────────────┐     │                   │
     │ packages/          │◄───┘                   │
     │ shared-encryption  │◄───────────────────────┘
     │                    │
     │ • EncryptionService│          ┌──────────────────────────┐
     │ • TenantEncFacade  │          │ packages/database        │
     │ • dek-codec        │◄─────────│                          │
     │ • format detection │ (static) │ • encryption.plugin.ts   │
     │ • facade-accessor  │          │ • clickhouse-interceptor │
     │ • encryption-ctx   │          │ • kms/ (DEK + KMS)       │
     │ • field-interceptor│          │ • models/ (DEKRegistry,  │
     │ • secure-queue     │          │   TenantKMSConfig, ...)  │
     │ • manifest         │          └──────────┬───────────────┘
     │                    │                     │
     │  ZERO imports from │         (dynamic import to avoid
     │  database ✓        │          circular dep)
     └────────────────────┘          └── dek-facade-factory.ts
                                          await import('shared-encryption')
```

---

## 6. Current Architecture: Decoupling Mechanisms

```
 ┌─────────────────────────────────────────────────────────────────┐
 │              THREE DECOUPLING STRATEGIES                        │
 │                                                                 │
 │  ① DUCK TYPING (compile-time)                                  │
 │  ┌─────────────────────────┐   ┌──────────────────────────┐   │
 │  │ shared-encryption        │   │ database/kms             │   │
 │  │                          │   │                          │   │
 │  │ interface DEKManagerLike │   │ class DEKManager          │   │
 │  │   acquireDEK(scope)     │   │   acquireDEK(scope) ✓    │   │
 │  │   unwrapDEK(dekId)      │◄──│   unwrapDEK(dekId)  ✓    │   │
 │  │   getCachedDEK?(dekId)  │   │   getCachedDEK(dekId) ✓  │   │
 │  │   getActiveDEKId?(scope)│   │   getActiveDEKId(scope) ✓│   │
 │  └─────────────────────────┘   └──────────────────────────┘   │
 │  No import needed — structural conformance.                    │
 │  Risk: can drift silently (no compile-time check).             │
 │                                                                 │
 │  ② globalThis BRIDGE (runtime)                                 │
 │  ┌─────────────────────────┐   ┌──────────────────────────┐   │
 │  │ shared-encryption        │   │ database                 │   │
 │  │                          │   │                          │   │
 │  │ getEncryptionFacade()   │   │ setEncryptionFacade()    │   │
 │  │ reads globalThis.       │◄──│ writes globalThis.       │   │
 │  │   __encryptionFacade    │   │   __encryptionFacade     │   │
 │  └─────────────────────────┘   └──────────────────────────┘   │
 │  Breaks circular dependency: shared-encryption can use the     │
 │  facade that database constructs, without importing database.  │
 │                                                                 │
 │  ③ AsyncLocalStorage (per-request context)                     │
 │  ┌─────────────────────────┐   ┌──────────────────────────┐   │
 │  │ runtime/server.ts        │   │ database/encryption       │   │
 │  │                          │   │   .plugin.ts              │   │
 │  │ runWithEncryptionContext │   │ getEncryptionEnvironment()│   │
 │  │ ({ environment: env })  │──►│ reads ALS store           │   │
 │  │                          │   │ → resolve DEK scope env   │   │
 │  └─────────────────────────┘   └──────────────────────────┘   │
 │  No import between runtime ↔ plugin — shared ALS singleton.   │
 └─────────────────────────────────────────────────────────────────┘
```

---

## 7. Ideal Architecture: Three Independent Black-Box Engines

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            CONSUMER LAYER                                       │
│                                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Mongoose     │  │  ClickHouse  │  │  BullMQ      │  │  Direct Call       │  │
│  │  Plugin       │  │  Interceptor │  │  Queue       │  │  Sites             │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘  │
│         │                  │                  │                    │              │
└─────────┼──────────────────┼──────────────────┼────────────────────┼──────────────┘
          │                  │                  │                    │
          └──────────────────┴────────┬─────────┴────────────────────┘
                                      │
                                      ▼  ALL paths go through facade (async)
                          ┌───────────────────────┐
                          │  EncryptionOrchestrator │  ← NEW: replaces TenantEncryptionFacade
                          │  (thin composition)     │
                          │                         │
                          │  encrypt(plain, scope)  │──→ acquireDEK → encrypt → ciphertext
                          │  decrypt(cipher, tid)   │──→ extractDekId → unwrap → decrypt
                          │  encryptSync (cache)    │──→ cache-only fast path
                          │  decryptSync (cache)    │──→ cache-only fast path
                          └─────┬──────┬──────┬────┘
                                │      │      │
                 ┌──────────────┘      │      └──────────────┐
                 ▼                     ▼                      ▼
┌────────────────────────┐ ┌──────────────────┐ ┌─────────────────────────┐
│    CRYPTO ENGINE       │ │   DEK ENGINE     │ │     KMS ENGINE          │
│                        │ │                  │ │                         │
│  Interface:            │ │  Interface:      │ │  Interface:             │
│  CryptoEngine          │ │  DEKEngine       │ │  KMSEngine              │
│                        │ │                  │ │                         │
│  encodeEnvelope()      │ │  acquireDEK()    │ │  resolveProvider()      │
│  decodeEnvelope()      │ │  unwrapDEK()     │ │  getProvider()          │
│  extractDekId()        │ │  getCachedDEK()  │ │  healthCheck()          │
│  derivePBKDF2Key()     │ │  getActiveDEK()  │ │                         │
│  deriveHKDFKey()       │ │  rotateDEK()     │ │  Inner contract:        │
│  blindIndex()          │ │  destroyDEKs()   │ │  KMSProvider            │
│  isLegacyFormat()      │ │                  │ │   generateDataKey()     │
│  isDEKEnvelopeFormat() │ │                  │ │   wrapKey()             │
│  compressEncrypt()     │ │                  │ │   unwrapKey()           │
│                        │ │                  │ │   encrypt/decrypt()     │
│ ┌────────────────────┐ │ │ ┌──────────────┐ │ │                         │
│ │ NO STATE           │ │ │ │ Deps:        │ │ │ ┌─────────────────────┐ │
│ │ NO SINGLETONS      │ │ │ │ DEKStore (I) │ │ │ │ Deps:               │ │
│ │ NO SIDE EFFECTS    │ │ │ │ KMSEngine(I) │ │ │ │ KMSConfigStore (I)  │ │
│ │ PURE FUNCTIONS     │ │ │ │ CryptoEng(I) │ │ │ │ Cloud SDKs          │ │
│ └────────────────────┘ │ │ │ Config       │ │ │ └─────────────────────┘ │
│                        │ │ └──────────────┘ │ │                         │
│  Package:              │ │  Package:        │ │  Package:               │
│  @abl/crypto-engine    │ │  @abl/dek-engine │ │  @abl/kms-engine        │
│  (zero deps)           │ │                  │ │                         │
└────────────────────────┘ └────────┬─────────┘ └────────────┬────────────┘
                                    │                         │
                            ┌───────▼─────────────────────────▼──────────┐
                            │         PERSISTENCE LAYER                  │
                            │                                            │
                            │  ┌──────────────┐  ┌────────────────────┐  │
                            │  │  DEKStore     │  │  KMSConfigStore    │  │
                            │  │  (interface)  │  │  (interface)       │  │
                            │  └──────┬───────┘  └────────┬───────────┘  │
                            │         │                    │              │
                            │         ▼                    ▼              │
                            │  ┌──────────────┐  ┌────────────────────┐  │
                            │  │ MongoDEKStore │  │MongoKMSConfigStore│  │
                            │  │ (DEKRegistry) │  │(MaterializedKMS   │  │
                            │  │              │  │ TenantKMSConfig)  │  │
                            │  └──────────────┘  └────────────────────┘  │
                            │                                            │
                            │  Future: PostgresDEKStore, DynamoDEKStore  │
                            └────────────────────────────────────────────┘
```

---

## 8. Ideal Architecture: Dependency Graph (No Cycles, No globalThis)

```
                    ┌───────────────────────────┐
                    │     apps/ (runtime, etc.)  │
                    │                           │
                    │  server.ts calls:          │
                    │  createEncryptionContainer │
                    │  ({masterKeyHex, mongoUri}) │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │  @abl/encryption-wiring   │  ← NEW package (composition root)
                    │                           │
                    │  createEncryptionContainer │
                    │  ({masterKeyHex, ...})     │
                    │                           │
                    │  Returns:                  │
                    │  {                          │
                    │    orchestrator,            │  ← EncryptionOrchestrator
                    │    dekEngine,               │  ← DEKEngine
                    │    kmsEngine,               │  ← KMSEngine
                    │    cryptoEngine,            │  ← CryptoEngine
                    │    pluginOptions,           │  ← for Mongoose plugin
                    │    interceptorOptions,      │  ← for ClickHouse
                    │    queueOptions,            │  ← for BullMQ
                    │    shutdown(),              │  ← graceful cleanup
                    │  }                          │
                    └──┬──────────┬──────────┬───┘
                       │          │          │
          ┌────────────┘          │          └────────────┐
          ▼                       ▼                        ▼
 ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
 │ @abl/crypto-eng │  │ @abl/dek-engine  │  │ @abl/kms-engine      │
 │                 │  │                  │  │                      │
 │ ZERO deps       │  │ deps:            │  │ deps:                │
 │ Pure functions  │  │  CryptoEngine(I) │  │  Cloud SDKs          │
 │                 │  │  KMSEngine(I)    │  │  KMSConfigStore(I)   │
 │                 │  │  DEKStore(I)     │  │                      │
 └─────────────────┘  └──────────────────┘  └──────────────────────┘

 Arrows = compile-time dependency (interface only)
 No globalThis. No module singletons. All state in container.
```

---

## 9. Ideal Architecture: State Management (DI Container)

```
  CURRENT (23 mutable locations)              IDEAL (1 container, explicit lifecycle)
  ──────────────────────────────              ──────────────────────────────────────

  globalThis.__encryptionFacade  ─┐
  globalThis.__kmsResolver       ─┤
  module: instance (EncService)  ─┤         ┌─────────────────────────────────────┐
  module: platformProvider       ─┤         │  EncryptionContainer                │
  module: providerPool           ─┤         │  (created once at startup,          │
  module: _platformDefault       ─┤  ───►   │   passed via DI to all consumers)   │
  module: masterKeyBuffer        ─┤         │                                     │
  module: kmsProvider            ─┤         │  .orchestrator: EncryptionOrchestrator │
  module: kmsKeyId               ─┤         │    └── .facade (replaces globalThis) │
  module: encryptionFacade       ─┤         │  .dekEngine: DEKEngine              │
  module: tenantEncryption       ─┤         │    ├── .cache: DEKCache (LRU 100)   │
  module: kmsResolverFn          ─┤         │    ├── .inflight: Map (dedup)       │
  module: encryptionContext (ALS)─┤         │    └── .store: DEKStore             │
  module: clickhouseAvailable    ─┤         │  .kmsEngine: KMSEngine              │
  module: rotationTimer          ─┤         │    ├── .pool: ProviderPool (LRU 50) │
  module: bullQueue              ─┤         │    ├── .resolver: KMSResolver       │
  module: bullWorker             ─┤         │    └── .configStore: KMSConfigStore │
  module: initialized            ─┤         │  .cryptoEngine: CryptoEngine        │
  module: shutdownRequested      ─┤         │    └── (stateless — pure functions)  │
  module: interceptor            ─┤         │  .context: AsyncLocalStorage         │
  instance: DEKManager.cache     ─┤         │    └── (per-request, auto-cleanup)   │
  instance: DEKManager.inflight  ─┤         │                                     │
  instance: DEKManager._lastDeks ─┤         │  .shutdown(): Promise<void>          │
  instance: ProviderPool.provs   ─┤         │    ├── zero-fill all key material   │
  instance: KMSResolver.cache    ─┤         │    ├── close KMS provider conns     │
  instance: EncService.keyCache  ─┘         │    ├── clear all caches             │
                                            │    └── stop timers/workers          │
  23 locations, no unified cleanup          └─────────────────────────────────────┘
                                              1 container, explicit lifecycle
```

---

## 10. Ideal Architecture: Encrypt Data Flow (Unified)

```
 model.save()         ClickHouse insert()       BullMQ .add()         Direct call
      │                      │                       │                      │
      ▼                      ▼                       ▼                      ▼
 ┌────────────┐     ┌───────────────┐       ┌───────────────┐     ┌───────────────┐
 │ Plugin      │     │ Interceptor    │       │ secure-queue   │     │ orchestrator  │
 │ pre('save') │     │ beforeInsert() │       │ wrapAsync()    │     │ .encrypt()    │
 │ ASYNC ✓     │     │ ASYNC ✓        │       │ ASYNC ✓        │     │ ASYNC ✓       │
 └─────┬──────┘     └───────┬───────┘       └───────┬───────┘     └───────┬───────┘
       │                     │                       │                      │
       └─────────────────────┴───────────┬───────────┴──────────────────────┘
                                         │
                                         ▼  ALL PATHS: same code, same format
                              ┌──────────────────────┐
                              │  orchestrator         │
                              │  .encrypt(plain, scope)│
                              └──────────┬───────────┘
                                         │
                    ┌────────────────────┬┴──────────────────────┐
                    │                    │                        │
                    ▼                    ▼                        ▼
          ┌─────────────────┐  ┌─────────────────┐    ┌──────────────────┐
          │ DEK Engine       │  │ KMS Engine       │    │ Crypto Engine    │
          │                  │  │                  │    │                  │
          │ acquireDEK(scope)│  │ resolveProvider()│    │ encodeEnvelope() │
          │   │              │  │   │              │    │                  │
          │   ├─ cache hit ──┼──┼───┼──────────────┼───►│ AES-256-GCM     │
          │   │  (fast path) │  │   │              │    │ Wire format      │
          │   │              │  │   │              │    │                  │
          │   └─ cache miss  │  │   ▼              │    │                  │
          │     │            │  │ getProvider(cfg)  │    │                  │
          │     ▼            │  │   │              │    │                  │
          │  DEKStore.find() │  │   ▼              │    │                  │
          │     │            │  │ kms.unwrapKey()   │    │                  │
          │     ▼            │  │   or              │    │                  │
          │  kms.unwrapKey() │◄─┤ kms.genDataKey() │    │                  │
          │     │            │  │                  │    │                  │
          │     ▼            │  └──────────────────┘    │                  │
          │  cache result    │                          │                  │
          │     │            │                          │                  │
          └─────┼────────────┘                          └────────┬─────────┘
                │                                                │
                └──────────────► dek + dekId ────────────────────►│
                                                                 │
                                                                 ▼
                                                     ┌──────────────────┐
                                                     │ Ciphertext:       │
                                                     │ base64(idLen +    │
                                                     │  dekId + iv +     │
                                                     │  authTag + data)  │
                                                     │                  │
                                                     │ SAME FORMAT      │
                                                     │ EVERYWHERE ✓     │
                                                     └──────────────────┘
```

---

## 11. Ideal Architecture: Decrypt Data Flow (Unified)

```
 model.find()        ClickHouse query()       BullMQ .process()      Direct call
      │                      │                       │                      │
      ▼                      ▼                       ▼                      ▼
 ALL PATHS ──────────────────────────────────────────────────────────────────┐
                                                                             │
                              ┌──────────────────────┐                       │
                              │  orchestrator         │◄──────────────────────┘
                              │  .decrypt(cipher, tid)│
                              └──────────┬───────────┘
                                         │
                                  format detection
                                         │
                         ┌───────────────┼───────────────┐
                         │               │               │
                    DEK envelope    Legacy hex      Unrecognized
                    (base64)        (3-part/v3)     (plaintext)
                         │               │               │
                         ▼               ▼               ▼
                  ┌──────────────┐ ┌──────────┐    return as-is
                  │ Crypto Engine│ │ Crypto    │    (Decision 14)
                  │ extractDekId │ │ Engine    │
                  └──────┬───────┘ │ derivePBKDF2│
                         │         │ decrypt3Part│
                         ▼         └──────┬─────┘
                  ┌──────────────┐        │
                  │ DEK Engine    │        ▼
                  │ unwrapDEK     │    plaintext
                  │ (dekId)       │    (legacy)
                  │               │
                  │ ┌─cache hit─┐ │
                  │ │ return    │ │
                  │ └───────────┘ │
                  │               │
                  │ ┌─cache miss┐ │
                  │ │ DEKStore  │ │
                  │ │ .findBy   │ │
                  │ │  DekId()  │ │
                  │ │     │     │ │
                  │ │     ▼     │ │
                  │ │ KMS Engine│ │
                  │ │ .unwrap() │ │
                  │ └───────────┘ │
                  └──────┬───────┘
                         │ dek
                         ▼
                  ┌──────────────┐
                  │ Crypto Engine│
                  │ decodeEnvelope│
                  │ AES-256-GCM  │
                  └──────┬───────┘
                         │
                         ▼
                     plaintext

  KEY INSIGHT: Decrypt needs NO scope — dekId extracted from ciphertext is globally unique.
  The same code path works for all consumers.
```

---

## 12. Migration Path: Current → Ideal (Incremental)

```
  Phase A                    Phase B                   Phase C
  Extract CryptoEngine       Extract DEKStore          Extract KMSConfigStore
  interface                  interface                 interface
  ─────────────────          ─────────────             ─────────────────────

  ┌────────────────┐         ┌────────────────┐        ┌────────────────┐
  │ CryptoEngine   │         │ DEKStore       │        │ KMSConfigStore │
  │ (interface)    │         │ (interface)    │        │ (interface)    │
  │                │         │                │        │                │
  │ encodeEnvelope │         │ findActiveDEK  │        │ getConfig      │
  │ decodeEnvelope │         │ findByDekId    │        │ getPlatform    │
  │ extractDekId   │         │ createDEK      │        │ Default        │
  │ derivePBKDF2   │         │ transition     │        │                │
  │ deriveHKDF     │         │ Status         │        └───────┬────────┘
  │ blindIndex     │         │ incrementUsage │                │
  │ isLegacy       │         └───────┬────────┘        ┌───────▼────────┐
  │ isDEKEnvelope  │                 │                 │ MongoKMSConfig │
  └───────┬────────┘         ┌───────▼────────┐        │ Store (impl)   │
          │                  │ MongoDEKStore  │        └────────────────┘
  ┌───────▼────────┐         │ (impl)         │
  │ EncryptionSvc  │         └────────────────┘
  │ implements     │
  │ CryptoEngine   │
  └────────────────┘

  Phase D                                    Phase E (optional)
  Replace globalThis                         Package restructure
  with DI container                          ───────────────────
  ─────────────────────
                                             ┌──────────────────┐
  ┌────────────────────────────┐             │ @abl/crypto-engine│
  │ EncryptionContainer        │             │ @abl/dek-engine   │
  │                            │             │ @abl/kms-engine   │
  │ Created once at startup    │   ───►      │ @abl/encryption-  │
  │ Passed via DI everywhere   │             │   wiring          │
  │ Explicit shutdown()        │             └──────────────────┘
  │                            │
  │ Replaces:                  │             90% of value already
  │  - 2 globalThis            │             captured by Phase D.
  │  - 14 module singletons    │             Only do if packaging
  │  - no zero-fill gaps       │             pain is real.
  └────────────────────────────┘
```

---

## 13. Key Differences Summary

| Aspect                      | Current                                                                                  | Ideal                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Consumer paths**          | 4 different patterns (plugin/interceptor/queue/direct), 2 sync + 2 async                 | 1 unified async path through orchestrator                          |
| **Ciphertext format**       | Mixed: DEK envelope (Mongoose), hex 3-part (ClickHouse/BullMQ/direct), ENC:v3:, Z1:, N0: | DEK envelope everywhere. Legacy detected and decoded transparently |
| **State management**        | 23 mutable locations across globalThis + modules + instances                             | 1 DI container with explicit lifecycle                             |
| **Engine coupling**         | Crypto engine reads DEK facade via globalThis (layer violation)                          | Pure functions, no upward dependency                               |
| **Persistence**             | DEKManager and KMSResolver directly import Mongoose models                               | Store interfaces. MongoDB is one implementation                    |
| **Scope resolution**        | Only Mongoose plugin resolves full 3D scope. ClickHouse/BullMQ pass tenantId only        | All paths resolve full DEKScope from their context                 |
| **Cleanup**                 | Asymmetric: some have shutdown, most have test-only reset, key material not zero-filled  | Unified `container.shutdown()` — zero-fills all key material       |
| **Testability**             | Duck-typed mocks work but 23 singletons make integration tests fragile                   | Constructor injection everywhere. In-memory stores for tests       |
| **New persistence backend** | Fork DEKManager and KMSResolver, rewrite MongoDB calls                                   | Implement DEKStore and KMSConfigStore interfaces                   |
