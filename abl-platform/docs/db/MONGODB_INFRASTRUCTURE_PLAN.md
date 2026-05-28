# MongoDB Infrastructure Plan

## Context

The ABL Platform is migrating from Prisma/SQLite to MongoDB + ClickHouse (selectable via `DB_BACKEND`). The existing `docs/db/MIGRATION_PLAN.md` establishes the high-level approach (Mongoose ^8.x, `packages/database/`). This plan addresses the **missing production-grade infrastructure**: connection management, BaseModel abstraction, logging, sharding, indexes, retry/failover, migrations, and scaling.

**Existing patterns to follow:**

- Redis client singleton pattern (`apps/runtime/src/services/redis/redis-client.ts`)
- Zod config schemas (`packages/config/src/schemas/`)
- Abstract store + factory pattern (`packages/compiler/src/platform/stores/`)
- Structured logger with redaction (`packages/compiler/src/platform/logger.ts`)

---

## Directory Structure

```
packages/database/
├── src/
│   ├── mongo/
│   │   ├── index.ts                     # Public API exports
│   │   ├── connection.ts                # MongoConnectionManager (singleton)
│   │   ├── base-model.ts               # BaseModel<T> abstract class
│   │   ├── base-document.ts            # BaseDocument interface + encryption fields
│   │   ├── plugins/
│   │   │   ├── tenant-isolation.plugin.ts   # Auto-inject tenantId on queries
│   │   │   ├── encryption.plugin.ts         # ire/iv/cek/fieldsToEncrypt hooks
│   │   │   ├── audit-trail.plugin.ts        # Auto-audit on write operations
│   │   │   └── slow-query.plugin.ts         # Slow query detection & logging
│   │   ├── middleware/
│   │   │   └── error-handler.ts             # Mongoose error classification & logging
│   │   └── helpers/
│   │       ├── retry.ts                     # Exponential backoff + circuit breaker
│   │       ├── pagination.ts                # Cursor-based + offset pagination
│   │       └── aggregation.ts               # Common aggregation pipeline builders
│   ├── migrations/
│   │   ├── runner.ts                    # Migration executor with locking
│   │   ├── types.ts                     # Migration interface
│   │   ├── lock.ts                      # Distributed lock (MongoDB-based)
│   │   └── scripts/                     # Timestamped migration files
│   │       └── 20260211_000_initial_schema_validation.ts
│   ├── models/                          # Mongoose models (per MIGRATION_PLAN.md)
│   │   └── ... (40 model files)
│   └── indexes/
│       └── ensure-indexes.ts            # Startup index reconciliation
packages/config/
├── src/schemas/
│   └── mongodb.schema.ts               # NEW: MongoDB Zod config schema
```

---

## Part 1: MongoDB Config Schema

**File:** `packages/config/src/schemas/mongodb.schema.ts`

```typescript
export const MongoDBConfigSchema = z.object({
  // Connection
  enabled: z.boolean().default(false),
  url: z.string().default('mongodb://localhost:27017'),
  database: z.string().default('abl_platform'),

  // Pool
  minPoolSize: z.coerce.number().int().min(0).default(5),
  maxPoolSize: z.coerce.number().int().min(1).default(50),
  maxIdleTimeMs: z.coerce.number().int().default(60_000),

  // Timeouts
  connectTimeoutMs: z.coerce.number().int().default(10_000),
  socketTimeoutMs: z.coerce.number().int().default(45_000),
  serverSelectionTimeoutMs: z.coerce.number().int().default(30_000),
  heartbeatFrequencyMs: z.coerce.number().int().default(10_000),

  // SSL/TLS
  tls: z.boolean().default(false),
  tlsCAFile: z.string().optional(), // Atlas or self-signed CA
  tlsCertFile: z.string().optional(), // mTLS client cert
  tlsKeyFile: z.string().optional(), // mTLS client key
  tlsAllowInvalidCertificates: z.boolean().default(false), // dev only

  // Replica Set / Atlas
  replicaSet: z.string().optional(), // e.g., "rs0" or Atlas auto
  authSource: z.string().default('admin'),
  authMechanism: z.enum(['SCRAM-SHA-256', 'SCRAM-SHA-1', 'MONGODB-X509', 'MONGODB-AWS']).optional(),

  // Write/Read Concerns
  writeConcern: z.enum(['0', '1', 'majority']).default('majority'),
  readPreference: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .default('primaryPreferred'),
  readConcern: z.enum(['local', 'majority', 'linearizable', 'snapshot']).optional(),

  // Retry & Compression
  retryWrites: z.boolean().default(true),
  retryReads: z.boolean().default(true),
  compressors: z.string().optional(), // "snappy,zstd,zlib"

  // Sharding
  directConnection: z.boolean().default(false), // false for mongos

  // Performance
  autoIndex: z.boolean().default(false), // false in prod, true in dev
  slowQueryThresholdMs: z.coerce.number().int().default(200),

  // App metadata
  appName: z.string().default('abl-platform'),
});
```

**Env mapping additions** (`packages/config/src/env-mapping.ts`):

```
MONGODB_ENABLED            → mongodb.enabled
MONGODB_URL                → mongodb.url
MONGODB_DATABASE           → mongodb.database
MONGODB_MIN_POOL_SIZE      → mongodb.minPoolSize
MONGODB_MAX_POOL_SIZE      → mongodb.maxPoolSize
MONGODB_CONNECT_TIMEOUT_MS → mongodb.connectTimeoutMs
MONGODB_SOCKET_TIMEOUT_MS  → mongodb.socketTimeoutMs
MONGODB_TLS                → mongodb.tls
MONGODB_TLS_CA_FILE        → mongodb.tlsCAFile
MONGODB_REPLICA_SET        → mongodb.replicaSet
MONGODB_AUTH_SOURCE        → mongodb.authSource
MONGODB_WRITE_CONCERN      → mongodb.writeConcern
MONGODB_READ_PREFERENCE    → mongodb.readPreference
MONGODB_RETRY_WRITES       → mongodb.retryWrites
MONGODB_COMPRESSORS        → mongodb.compressors
MONGODB_AUTO_INDEX         → mongodb.autoIndex
MONGODB_SLOW_QUERY_MS      → mongodb.slowQueryThresholdMs
MONGODB_APP_NAME           → mongodb.appName
```

**Integration:** Add `mongodb: MongoDBConfigSchema.default({})` to `BaseAppConfigSchema`.

---

## Part 2: Connection Manager (Singleton)

**File:** `packages/database/src/mongo/connection.ts`

```typescript
class MongoConnectionManager {
  private static instance: MongoConnectionManager | null = null;
  private mongoose: typeof import('mongoose');
  private config: MongoDBConfig;
  private state: 'disconnected' | 'connecting' | 'connected' | 'error';
  private retryCount: number = 0;
  private readonly MAX_RETRIES = 5;

  // Singleton access
  static getInstance(): MongoConnectionManager;
  static initialize(config: MongoDBConfig): Promise<MongoConnectionManager>;
  static isAvailable(): boolean;
  static reset(): void; // for tests

  // Core
  async connect(): Promise<void>;
  async disconnect(): Promise<void>; // graceful drain
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; replicaSet?: string }>;

  // Connection options builder (private)
  private buildConnectionOptions(): mongoose.ConnectOptions {
    // Maps MongoDBConfig → mongoose.ConnectOptions
    // Handles: Atlas SRV, replica sets, mongos, SSL, pools, timeouts
    // Key options:
    //   maxPoolSize, minPoolSize, maxIdleTimeMS
    //   connectTimeoutMS, socketTimeoutMS, serverSelectionTimeoutMS
    //   heartbeatFrequencyMS
    //   tls, tlsCAFile, tlsCertificateKeyFile
    //   replicaSet, readPreference, w (writeConcern)
    //   retryWrites, retryReads
    //   compressors
    //   appName
    //   autoIndex (false in prod)
    //   directConnection (false for sharded)
    //   monitorCommands: true  // APM hooks for slow query logging
  }

  // APM hooks (private)
  private setupMonitoring(): void {
    // mongoose.connection.on('commandStarted', ...)
    // mongoose.connection.on('commandSucceeded', ...) → slow query detection
    // mongoose.connection.on('commandFailed', ...) → error logging
    // mongoose.connection.on('serverHeartbeatFailed', ...) → failover alerts
    // Topology change events for replica set monitoring
  }

  // Retry on startup (private)
  private async connectWithRetry(): Promise<void> {
    // Exponential backoff: 1s → 2s → 4s → 8s → 16s
    // Log each attempt
    // After MAX_RETRIES, throw with clear error message
  }
}
```

**Key behaviors:**

- **Atlas detection:** if URL contains `+srv://`, auto-handles DNS seedlist
- **Replica set:** auto-detected from connection string or explicit config
- **mongos:** when `directConnection: false` and connecting to mongos router
- **APM:** command monitoring for slow query plugin and error tracking
- **Graceful shutdown:** `mongoose.connection.close(false)` to drain pool

---

## Part 3: BaseDocument Interface

**File:** `packages/database/src/mongo/base-document.ts`

```typescript
// Applied to ALL documents
interface BaseDocument {
  _id: string; // UUID v7 (time-sortable) — NOT ObjectId
  createdAt: Date; // auto via timestamps
  updatedAt: Date; // auto via timestamps
  _v: number; // schema version (for migrations)
}

// Applied to soft-deletable documents
interface SoftDeletableDocument extends BaseDocument {
  deletedAt?: Date | null;
}

// Applied to tenant-scoped documents
interface TenantScopedDocument extends BaseDocument {
  tenantId: string;
}

// Applied to documents with encrypted fields
interface EncryptedDocument extends BaseDocument {
  ire: string; // initialization reference for encryption
  iv: string; // initialization vector
  cek: string; // content encryption key (encrypted by master key)
  fieldsToEncrypt: string[]; // which fields are encrypted in this doc
}

// Mongoose base schema (applied via plugin or schema.add())
const baseSchemaFields = {
  _id: { type: String, default: () => uuidv7() },
  _v: { type: Number, default: 1 },
  deletedAt: { type: Date, default: null },
};

const encryptionSchemaFields = {
  ire: { type: String },
  iv: { type: String },
  cek: { type: String },
  fieldsToEncrypt: { type: [String], default: [] },
};
```

**UUID v7 rationale:** Time-sortable, no ObjectId dependency, works across shards without central coordinator, natural chronological ordering for range queries.

---

## Part 4: BaseModel Abstract Class

**File:** `packages/database/src/mongo/base-model.ts`

```typescript
abstract class BaseModel<TDoc extends BaseDocument, TInput, TUpdate> {
  protected model: mongoose.Model<TDoc>;
  protected logger: Logger;
  protected collectionName: string;
  protected slowQueryMs: number;

  constructor(model: mongoose.Model<TDoc>, collectionName: string);

  // === CRUD ===
  async create(input: TInput): Promise<TDoc>;
  async createMany(inputs: TInput[]): Promise<TDoc[]>;
  async findById(id: string): Promise<TDoc | null>;
  async findOne(filter: FilterQuery<TDoc>): Promise<TDoc | null>;
  async find(filter: FilterQuery<TDoc>, options?: QueryOptions): Promise<TDoc[]>;
  async updateById(id: string, update: TUpdate): Promise<TDoc | null>;
  async updateMany(filter: FilterQuery<TDoc>, update: TUpdate): Promise<number>;
  async deleteById(id: string): Promise<boolean>; // hard delete
  async softDelete(id: string): Promise<TDoc | null>; // set deletedAt
  async restore(id: string): Promise<TDoc | null>; // unset deletedAt

  // === Pagination ===
  async paginate(
    filter: FilterQuery<TDoc>,
    opts: PaginationOptions,
  ): Promise<PaginatedResult<TDoc>>;
  // Cursor-based for large collections (conversations, contacts, audit)
  async cursorPaginate(filter: FilterQuery<TDoc>, opts: CursorOptions): Promise<CursorResult<TDoc>>;

  // === Aggregation ===
  async aggregate<T>(pipeline: PipelineStage[]): Promise<T[]>;
  async count(filter: FilterQuery<TDoc>): Promise<number>;
  async exists(filter: FilterQuery<TDoc>): Promise<boolean>;
  async distinct<T>(field: string, filter?: FilterQuery<TDoc>): Promise<T[]>;

  // === Bulk Operations ===
  async bulkWrite(ops: AnyBulkWriteOperation<TDoc>[]): Promise<BulkWriteResult>;
  async upsert(filter: FilterQuery<TDoc>, update: TUpdate): Promise<TDoc>;

  // === Transactions ===
  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>;

  // === Change Streams (opt-in) ===
  watch(pipeline?: PipelineStage[], options?: ChangeStreamOptions): ChangeStream<TDoc>;

  // === Internal Hooks ===
  // Every operation wraps with:
  //   1. Start timer
  //   2. Execute operation
  //   3. Log if duration > slowQueryMs (slow query log)
  //   4. On error: classify error, log with context, rethrow typed error
  //   5. Auto-exclude soft-deleted docs (unless opts.includeSoftDeleted)
  protected async executeWithLogging<T>(
    operation: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>,
  ): Promise<T>;
}
```

**Error classification** (`middleware/error-handler.ts`):

```typescript
// Classify MongoDB errors into application-level types:
enum MongoErrorCode {
  DUPLICATE_KEY = 'DUPLICATE_KEY', // E11000
  VALIDATION = 'VALIDATION', // ValidationError
  TIMEOUT = 'TIMEOUT', // serverSelectionTimeout, socketTimeout
  NETWORK = 'NETWORK', // MongoNetworkError
  WRITE_CONFLICT = 'WRITE_CONFLICT', // WriteConflict (transactions)
  NOT_FOUND = 'NOT_FOUND', // Application-level
  UNAUTHORIZED = 'UNAUTHORIZED', // MongoServerError 13/18
  SHARD_KEY_VIOLATION = 'SHARD_KEY_VIOLATION',
  DOCUMENT_TOO_LARGE = 'DOCUMENT_TOO_LARGE', // >16MB
  UNKNOWN = 'UNKNOWN',
}

class MongoAppError extends Error {
  code: MongoErrorCode;
  collection: string;
  operation: string;
  duration: number;
  retryable: boolean; // hint for retry layer
}
```

**Slow query logging** — integrated into `executeWithLogging()`:

```
[SLOW_QUERY] collection=conversations op=find duration=342ms filter={"tenantId":"t1","status":"active"} threshold=200ms
```

**Error logging**:

```
[MONGO_ERROR] collection=conversations op=updateById code=TIMEOUT duration=45032ms error="Server selection timed out" retryable=true
```

---

## Part 5: Mongoose Plugins

### 5A. Tenant Isolation Plugin (`plugins/tenant-isolation.plugin.ts`)

```typescript
// Applied to all tenant-scoped models
// - Pre-find/findOne/count/aggregate: auto-inject { tenantId } filter
// - Pre-save/insertMany: auto-inject tenantId from async context
// - Bypass for super-admin context (via AsyncLocalStorage)
// - Uses Node.js AsyncLocalStorage to get current tenant from request context
```

### 5B. Encryption Plugin (`plugins/encryption.plugin.ts`)

```typescript
// Applied to: users, organizations, projects (service_nodes),
//             llm_credentials, tenant_models, tenant_service_instances,
//             tool_secrets, end_user_oauth_tokens, org_proxy_configs
//
// Pre-save hook:
//   1. Read fieldsToEncrypt from schema option
//   2. For each field: encrypt value, store ciphertext
//   3. Set ire, iv, cek on document
//
// Post-find hook:
//   1. For each field in fieldsToEncrypt: decrypt value
//   2. Return plaintext to application layer
//
// Uses encryption.masterKey from config (already exists in BaseAppConfig)
```

### 5C. Slow Query Plugin (`plugins/slow-query.plugin.ts`)

```typescript
// Mongoose-level plugin (complements APM command monitoring)
// - Pre/post hooks on: find, findOne, findOneAndUpdate, aggregate, save
// - Measures wall-clock time
// - Logs queries exceeding threshold with:
//   collection, operation, filter (redacted), duration, index used (from explain)
// - Threshold configurable: mongodb.slowQueryThresholdMs (default: 200ms)
```

### 5D. Audit Trail Plugin (`plugins/audit-trail.plugin.ts`)

```typescript
// Applied to sensitive collections (users, organizations, rbac, security, billing)
// - Post-save/update/delete: emit audit event
// - Captures: who (from AsyncLocalStorage), what changed (diff), when
// - Writes to audit_logs collection (MongoDB control-plane audit)
```

---

## Part 6: Retry & Failover

**File:** `packages/database/src/mongo/helpers/retry.ts`

```typescript
// 1. Retryable Writes (MongoDB native — already enabled via retryWrites: true)
//    - Covers: insert, update, delete, findAndModify
//    - Automatic single-retry on transient network errors
//    - No application code needed — driver handles it

// 2. Application-Level Retry (for reads + complex operations)
async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number; // default: 3
    baseDelayMs?: number; // default: 100
    maxDelayMs?: number; // default: 5000
    retryableErrors?: MongoErrorCode[]; // default: [TIMEOUT, NETWORK, WRITE_CONFLICT]
    jitter?: boolean; // default: true (add randomness to prevent thundering herd)
  },
): Promise<T>;

// 3. Circuit Breaker (for degraded mode)
class CircuitBreaker {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  failureThreshold: number; // default: 5
  resetTimeoutMs: number; // default: 30_000
  halfOpenMaxAttempts: number; // default: 3

  async execute<T>(fn: () => Promise<T>): Promise<T>;
  // closed → open: after failureThreshold consecutive failures
  // open → half-open: after resetTimeoutMs
  // half-open → closed: on success
  // half-open → open: on failure
}

// 4. Read Preference Strategy (configured globally + per-query override)
// - primary: Strong consistency (default for writes)
// - primaryPreferred: Reads from primary, falls back to secondary (default)
// - secondary: Read scaling for analytics/reports
// - nearest: Lowest latency (good for geo-distributed)
//
// BaseModel allows per-query override:
//   await model.find(filter, { readPreference: 'secondary' });
```

**Connection-level failover** (handled by MongoConnectionManager):

- Automatic reconnection on topology changes
- `serverHeartbeatFailed` event logging
- Topology monitoring for replica set elections
- Connection pool auto-recovery (Mongoose/driver handles this natively)

---

## Part 7: Shard Key Recommendations

### Collections that need sharding (by growth trajectory):

| Collection         | Shard Key                 | Strategy        | Rationale                                                                                                                                          |
| ------------------ | ------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **conversations**  | `{ tenantId: 1, _id: 1 }` | Ranged compound | ~1M writes/day. Tenant prefix ensures colocation for tenant queries. UUID v7 `_id` provides time-ordering within tenant. Avoids monotonic hotspot. |
| **audit_logs**     | `{ tenantId: "hashed" }`  | Hashed          | High write volume. Hashed tenantId distributes evenly across shards. Time-range queries via `createdAt` index on each shard.                       |
| **contacts**       | `{ tenantId: 1, _id: 1 }` | Ranged compound | Grows with user base. Same pattern as conversations — tenant-scoped queries are the primary access pattern.                                        |
| **facts**          | `{ key: "hashed" }`       | Hashed          | Global collection, no tenantId. Hashed key distributes evenly. Point lookups by key.                                                               |
| **refresh_tokens** | `{ userId: "hashed" }`    | Hashed          | High-volume auth tokens. Hashed by user for even distribution.                                                                                     |

### Collections that DON'T need sharding (low volume, bounded growth):

- organizations, tenants, projects, rbac, workflows, api_keys, llm_config, security, compliance, billing, knowledge, sdk, deployments

### Zone Sharding (Multi-Region):

```javascript
// When deploying across regions (e.g., US, EU, APAC):
// Tag shards by region, route tenant data by tenant's region field
sh.addShardTag('shard-us-east', 'US');
sh.addShardTag('shard-eu-west', 'EU');
sh.updateZoneKeyRange(
  'abl_platform.conversations',
  { tenantId: 'us_', _id: MinKey },
  { tenantId: 'us`', _id: MaxKey }, // prefix range
  'US',
);
```

### Pre-splitting strategy:

- Pre-split conversations and audit_logs into N chunks at deployment
- Prevents initial single-shard bottleneck
- Script provided in migrations

---

## Part 8: Index Strategy

### Approach: **Indexes in Mongoose schemas + `ensureIndexes` startup reconciliation**

**Why co-located with schemas (not separate scripts):**

1. Index definitions are **tightly coupled** to query patterns — keeping them with models makes them discoverable
2. Mongoose `schema.index()` is declarative and versioned with the model code
3. The `ensureIndexes` script reads from models — single source of truth
4. CI/CD runs `ensureIndexes` as a pre-deploy step (not at app startup in prod)

**Production safety:**

- `autoIndex: false` in production (never build indexes at app startup)
- `ensureIndexes.ts` script runs as a **separate process** during deploy
- Uses `createIndex({ background: true })` for zero-downtime index builds
- Compares existing indexes vs declared → only creates missing, warns on orphaned

**File:** `packages/database/src/indexes/ensure-indexes.ts`

```typescript
// 1. Connect to MongoDB
// 2. For each registered model:
//    a. Get declared indexes from schema
//    b. Get existing indexes from collection
//    c. Create missing indexes (background: true)
//    d. Log orphaned indexes (don't auto-drop — manual decision)
// 3. Report summary
// Run: pnpm db:ensure-indexes
```

### Complete Index Catalog (all 17 collection groups):

**users** (4 collections):

```
users:
  { email: 1 }                                    UNIQUE
  { googleId: 1 }                                 UNIQUE SPARSE

refresh_tokens:
  { token: 1 }                                    UNIQUE
  { userId: 1 }
  { familyId: 1 }
  { expiresAt: 1 }                                TTL(0)

email_verification_tokens:
  { token: 1 }                                    UNIQUE
  { userId: 1 }
  { expiresAt: 1 }                                TTL(0)

password_reset_tokens:
  { token: 1 }                                    UNIQUE
  { userId: 1 }
  { expiresAt: 1 }                                TTL(0)
```

**organizations** (3 collections):

```
organizations:
  { slug: 1 }                                     UNIQUE
  { ownerId: 1 }
  { 'domainMappings.domain': 1 }                  UNIQUE SPARSE

org_members:
  { organizationId: 1, userId: 1 }                UNIQUE
  { userId: 1 }

tenant_transfers:
  { tenantId: 1 }
  { sourceOrgId: 1 }
  { targetOrgId: 1 }
  { status: 1 }
```

**tenants** (3 collections):

```
tenants:
  { slug: 1 }                                     UNIQUE
  { organizationId: 1 }
  { ownerId: 1 }
  { status: 1 }

tenant_members:
  { tenantId: 1, userId: 1 }                      UNIQUE
  { userId: 1 }
  { customRoleId: 1 }

workspace_invitations:
  { token: 1 }                                    UNIQUE
  { tenantId: 1, email: 1 }                       UNIQUE
  { email: 1 }
  { expiresAt: 1 }                                TTL(0)
```

**projects** (7 collections):

```
projects:
  { slug: 1 }                                     UNIQUE
  { tenantId: 1 }
  { ownerId: 1 }

project_agents:
  { projectId: 1, name: 1 }                       UNIQUE
  { projectId: 1 }
  { domain: 1 }

agent_versions:
  { agentId: 1, version: 1 }                      UNIQUE
  { agentId: 1, status: 1 }

project_members:
  { projectId: 1, userId: 1 }                     UNIQUE
  { userId: 1 }

model_configs:
  { projectId: 1, name: 1 }                       UNIQUE
  { projectId: 1, tier: 1 }

agent_model_configs:
  { projectId: 1, agentName: 1 }                  UNIQUE

service_nodes:
  { projectId: 1, name: 1 }                       UNIQUE
```

**rbac** (3 collections):

```
role_definitions:
  { tenantId: 1, name: 1 }                        UNIQUE
  { tenantId: 1 }

resource_permissions:
  { tenantId: 1, userId: 1, resourceType: 1, resourceId: 1 }  UNIQUE
  { tenantId: 1, userId: 1 }
  { tenantId: 1, resourceType: 1, resourceId: 1 }
  { userId: 1 }

resource_types:
  { name: 1 }                                     UNIQUE
```

**contacts:**

```
contacts:
  { tenantId: 1, identityType: 1, identity: 1 }
  { tenantId: 1, type: 1 }
  { tenantId: 1, lastSeenAt: -1 }
  { tenantId: 1, deletedAt: 1 }                   PARTIAL (deletedAt != null)
```

**conversations** (highest volume — 13 indexes):

```
conversations:
  { tenantId: 1, status: 1, lastActivityAt: -1 }  # retention sweep
  { tenantId: 1, contactId: 1 }                    # contact history
  { tenantId: 1, callerNumber: 1 }                 # voice lookup
  { tenantId: 1, workflowId: 1 }                   # workflow sessions
  { tenantId: 1, projectId: 1, environment: 1 }    # project filter
  { tenantId: 1, initiatedById: 1 }                # user sessions
  { tenantId: 1, billingPeriod: 1, isTest: 1 }     # billing queries
  { tenantId: 1, projectSlug: 1, status: 1 }       # dashboard
  { tenantId: 1, entryAgentName: 1, startedAt: -1 } # agent analytics
  { tenantId: 1, environment: 1, status: 1 }       # env filter
  { deploymentId: 1, status: 1 }                   # deployment health
  { customerId: 1 }                                 # SPARSE
  { parentId: 1 }                                   # SPARSE (sub-sessions)
```

**workflows:**

```
workflows:
  { tenantId: 1, projectId: 1, name: 1 }          UNIQUE
  { tenantId: 1, type: 1, status: 1 }
  { tenantId: 1, projectId: 1 }
```

**api_keys** (3 collections):

```
api_keys:
  { keyHash: 1 }                                   UNIQUE
  { tenantId: 1, clientId: 1 }                     UNIQUE
  { tenantId: 1 }
  { prefix: 1 }

public_api_keys:
  { keyHash: 1 }                                   UNIQUE
  { projectId: 1 }

sdk_channels:
  { tenantId: 1, projectId: 1, name: 1 }          UNIQUE
  { tenantId: 1, projectId: 1 }
  { publicApiKeyId: 1 }
```

**llm_config** (3 collections):

```
llm_credentials:
  { userId: 1, provider: 1, name: 1 }             UNIQUE
  { userId: 1 }
  { provider: 1 }
  { tenantId: 1 }

tenant_models:
  { tenantId: 1, displayName: 1 }                 UNIQUE
  { tenantId: 1, tier: 1, isActive: 1 }
  { tenantId: 1, provider: 1, isActive: 1 }

tenant_service_instances:
  { tenantId: 1, serviceType: 1, displayName: 1 } UNIQUE
  { tenantId: 1, serviceType: 1, isActive: 1 }
```

**security** (4 collections):

```
tool_secrets:
  { tenantId: 1, projectId: 1, toolName: 1, secretKey: 1, environment: 1 }  UNIQUE

end_user_oauth_tokens:
  { tenantId: 1, userId: 1, provider: 1 }         UNIQUE
  { tenantId: 1 }

org_proxy_configs:
  { tenantId: 1, name: 1, environment: 1 }        UNIQUE
  { tenantId: 1, environment: 1 }

key_versions:
  { tenantId: 1, version: 1 }                     UNIQUE
  { tenantId: 1 }
  { status: 1 }
```

**compliance:**

```
deletion_requests:
  { tenantId: 1 }
  { status: 1 }
  { subjectId: 1 }
  { slaDeadline: 1 }

archive_manifests:
  { tenantId: 1 }
  { type: 1, createdAt: -1 }
```

**billing:**

```
subscriptions:
  { organizationId: 1 }
  { tenantId: 1 }
  { status: 1 }
  { planTier: 1 }

usage_periods:
  { subscriptionId: 1, periodLabel: 1 }           UNIQUE
  { subscriptionId: 1 }
  { periodLabel: 1 }
  { invoiced: 1 }
```

**knowledge** (3 collections):

```
knowledge_bases:
  { tenantId: 1, name: 1 }                        UNIQUE
  { tenantId: 1 }
  { indexStatus: 1 }
  { sourceType: 1 }

resource_groups:
  { tenantId: 1, name: 1 }                        UNIQUE
  { tenantId: 1 }

facts:
  { key: 1 }                                      UNIQUE
  { expiresAt: 1 }                                TTL(0)
  { sourceType: 1 }
```

**sdk** (3 collections):

```
widget_configs:
  { projectId: 1 }                                UNIQUE

debug_tokens:
  { token: 1 }                                    UNIQUE
  { userId: 1 }
  { expiresAt: 1 }                                TTL(0)

device_auth_requests:
  { deviceCode: 1 }                               UNIQUE
  { userCode: 1 }                                  UNIQUE
  { expiresAt: 1 }                                TTL(0)
```

**audit_logs:**

```
audit_logs:
  { tenantId: 1, createdAt: -1 }
  { userId: 1 }
  { action: 1 }
  { createdAt: -1 }
```

**deployments:**

```
deployments:
  { endpointSlug: 1 }                             UNIQUE
  { projectId: 1, environment: 1, createdAt: -1 }
  { projectId: 1, environment: 1, status: 1 }
  { tenantId: 1 }
  { status: 1 }
```

---

## Part 9: Migration Framework

**Design:** Custom lightweight runner (not `migrate-mongo` — avoids external dependency, integrates with existing Zod config and logger patterns).

### Migration file structure:

```
packages/database/src/migrations/scripts/
  20260211_000_initial_schema_validation.ts
  20260211_001_add_conversations_billing_index.ts
  20260215_000_add_user_mfa_default.ts
  ...
```

### Migration interface:

```typescript
// types.ts
interface Migration {
  version: string; // "20260211_000" — timestamp + sequence
  description: string; // Human-readable
  up(db: Db, session?: ClientSession): Promise<void>;
  down(db: Db, session?: ClientSession): Promise<void>;
}

// Lock collection: _migration_lock (single document with TTL)
// History collection: _migration_history
//   { version, description, appliedAt, duration, status, checksum }
```

### Migration runner (`runner.ts`):

```typescript
class MigrationRunner {
  // 1. Acquire distributed lock (upsert with TTL = 5min)
  // 2. Read _migration_history to find last applied
  // 3. Discover pending migrations (sorted by version)
  // 4. For each pending:
  //    a. Run up() in a transaction (if replica set)
  //    b. Record in _migration_history
  //    c. Log success/failure
  // 5. Release lock

  async migrate(): Promise<MigrationResult>; // apply all pending
  async rollback(steps?: number): Promise<void>; // run down() for last N
  async status(): Promise<MigrationStatus[]>; // show applied/pending
}
```

### Backward-compatible migration patterns:

```typescript
// Pattern 1: Add field with default
async up(db) {
  await db.collection('tenants').updateMany(
    { newField: { $exists: false } },
    { $set: { newField: 'default_value' } }
  );
}

// Pattern 2: Rename field (dual-write → cutover → cleanup)
// Migration 1: Copy old → new
async up(db) {
  await db.collection('users').updateMany(
    { newName: { $exists: false }, oldName: { $exists: true } },
    [{ $set: { newName: '$oldName' } }]
  );
}
// Migration 2 (next release): Drop old field
async up(db) {
  await db.collection('users').updateMany({}, { $unset: { oldName: '' } });
}

// Pattern 3: Add index (background, safe for production)
async up(db) {
  await db.collection('conversations').createIndex(
    { tenantId: 1, newField: 1 },
    { background: true, name: 'idx_tenant_newfield' }
  );
}
async down(db) {
  await db.collection('conversations').dropIndex('idx_tenant_newfield');
}

// Pattern 4: Schema validation update
async up(db) {
  await db.command({
    collMod: 'conversations',
    validator: { $jsonSchema: { /* updated schema */ } },
    validationLevel: 'moderate',  // existing docs not validated, new writes are
  });
}

// Pattern 5: Backfill with batching (for large collections)
async up(db) {
  let processed = 0;
  const batchSize = 1000;
  while (true) {
    const result = await db.collection('conversations').updateMany(
      { computedField: { $exists: false }, _id: { $gt: lastId } },
      [{ $set: { computedField: { $concat: ['$tenantId', '-', '$projectId'] } } }],
      { limit: batchSize }
    );
    if (result.modifiedCount === 0) break;
    processed += result.modifiedCount;
    // Yield to prevent blocking
    await new Promise(r => setTimeout(r, 100));
  }
}
```

### CLI integration:

```
pnpm db:migrate          # Run all pending migrations
pnpm db:migrate:status   # Show migration status
pnpm db:migrate:rollback # Rollback last migration
pnpm db:migrate:create <name>  # Scaffold new migration file
```

---

## Part 10: Scaling Strategy

### Connection Pool Sizing Formula:

```
maxPoolSize = (concurrent_requests × avg_queries_per_request) / avg_query_time_ratio
```

- **Dev:** minPool=2, maxPool=10
- **Staging:** minPool=5, maxPool=25
- **Production:** minPool=10, maxPool=50-100 (per app instance)
- **Rule:** Total connections across all instances < MongoDB's `maxIncomingConnections` (default: 65536)

### Read Scaling:

- `readPreference: 'secondaryPreferred'` for dashboard/analytics queries
- `readPreference: 'primary'` for session creation and updates
- BaseModel supports per-query override: `model.find(filter, { readPreference: 'secondary' })`

### Write Scaling Path:

1. **Phase 1:** Single replica set (handles ~1M writes/day easily)
2. **Phase 2:** Shard conversations + audit_logs when approaching 10M writes/day
3. **Phase 3:** Shard contacts + facts as user base grows
4. **Phase 4:** Zone sharding for multi-region compliance

### Archival Strategy:

- Conversations older than 90 days → archive to S3/GCS (via compliance `archive_manifests`)
- TTL indexes auto-delete tokens, invitations, debug sessions
- Facts with TTL auto-expire
- Audit logs: retain 365 days in MongoDB, older → ClickHouse `audit_events`

### Document Size Management:

- Conversations: context/metadata fields capped at application level (BaseModel validation)
- Embedded arrays: bounded by design (ssoConfigs ~5, domainMappings ~10, connections ~5)
- No unbounded array growth patterns in any collection

### WiredTiger Cache:

- Default: 50% of (RAM - 1GB)
- Atlas: automatically managed
- Self-hosted: `storage.wiredTiger.engineConfig.cacheSizeGB`

---

## Part 11: Additional Modern MongoDB Features

### Schema Validation (JSON Schema on collections):

```typescript
// Applied during initial migration (20260211_000_initial_schema_validation.ts)
// Uses MongoDB's built-in $jsonSchema validator
// validationLevel: 'moderate' — validates inserts + updates, not existing docs
// validationAction: 'error' — reject invalid documents
//
// Example for conversations:
db.createCollection('conversations', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'tenantId', 'channel', 'status', 'currentAgent'],
      properties: {
        tenantId: { bsonType: 'string' },
        channel: { enum: ['voice', 'web_chat', 'whatsapp', 'sms', 'email', 'api'] },
        status: { enum: ['active', 'idle', 'completed', 'abandoned', 'escalated'] },
      },
    },
  },
});
```

### Change Streams (opt-in via BaseModel.watch()):

- Real-time session status updates → WebSocket broadcast
- Contact activity tracking → update lastSeenAt
- Deployment status changes → notify Studio UI
- Already exposed in BaseModel as `watch()` method

### Aggregation Helpers (`helpers/aggregation.ts`):

- `buildTenantPipeline(tenantId, stages)` — auto-prepend $match by tenant
- `buildDateRangePipeline(field, start, end)` — date range queries
- `buildPaginatedPipeline(filter, sort, page, limit)` — paginated aggregation
- Common patterns for billing rollups, usage summaries, agent analytics

### MongoDB Atlas Search (future):

- Text search on contacts (name, company, tags)
- Full-text search on knowledge_bases
- Defined as Atlas Search indexes, not covered in this implementation phase

---

## Implementation Order

| #   | Task                                            | Files                                                                                   | Depends On     |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------- | -------------- |
| 1   | MongoDB config schema + env mapping             | `packages/config/src/schemas/mongodb.schema.ts`, `env-mapping.ts`, `base-app.schema.ts` | —              |
| 2   | BaseDocument + base types                       | `packages/database/src/mongo/base-document.ts`                                          | —              |
| 3   | Connection Manager                              | `packages/database/src/mongo/connection.ts`                                             | #1             |
| 4   | Error handler + retry helpers                   | `packages/database/src/mongo/middleware/error-handler.ts`, `helpers/retry.ts`           | —              |
| 5   | Plugins (tenant, encryption, slow-query, audit) | `packages/database/src/mongo/plugins/*.ts`                                              | #2             |
| 6   | BaseModel abstract class                        | `packages/database/src/mongo/base-model.ts`                                             | #2, #3, #4, #5 |
| 7   | Pagination + aggregation helpers                | `packages/database/src/mongo/helpers/pagination.ts`, `aggregation.ts`                   | #6             |
| 8   | Migration framework                             | `packages/database/src/migrations/runner.ts`, `lock.ts`, `types.ts`                     | #3             |
| 9   | Initial migration (schema validation + indexes) | `migrations/scripts/20260211_000_*.ts`                                                  | #8             |
| 10  | Index reconciliation script                     | `packages/database/src/indexes/ensure-indexes.ts`                                       | #3             |
| 11  | Public API exports                              | `packages/database/src/mongo/index.ts`                                                  | All above      |

---

## Verification

1. **Unit tests:** BaseModel CRUD operations against `mongodb-memory-server`
2. **Integration tests:** Connection Manager with replica set (Docker `mongo:7` with `--replSet`)
3. **Slow query test:** Artificial delay → verify slow query log output
4. **Retry test:** Kill mongod during operation → verify retry + reconnection
5. **Migration test:** Run up → verify schema → run down → verify rollback
6. **Index test:** Run `ensureIndexes` → verify all indexes created → run again → verify idempotent
7. **Encryption test:** Create encrypted doc → verify ciphertext in DB → read back → verify plaintext

```bash
# Local dev setup
docker compose up -d mongodb
pnpm db:migrate           # Run migrations
pnpm db:ensure-indexes    # Create indexes
pnpm db:seed:mongo        # Seed data
DB_BACKEND=mongo pnpm dev:runtime   # Start runtime with MongoDB
# Health check: curl localhost:3112/health → { mongodb: 'connected' }
```
