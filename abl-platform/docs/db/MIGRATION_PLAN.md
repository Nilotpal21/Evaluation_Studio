# Database Architecture: MongoDB + ClickHouse

## Context

The ABL Platform uses **MongoDB + ClickHouse** as its production database architecture. PostgreSQL was evaluated and rejected (see [DATA_ARCHITECTURE.md](../DATA_ARCHITECTURE.md), Section 3.5). A legacy Prisma/SQLite path exists for local development fallback only via `DB_BACKEND=prisma`, but all new development targets the MongoDB + ClickHouse path.

**Production configuration (`DB_BACKEND=mongo`):**

- **Mongoose** (MongoDB) — all metadata, control-plane, and operational data (~17 collections)
- **@clickhouse/client** — high-volume time-series data (5 tables: messages, llm_metrics, traces, logs, audit_events)

**Legacy fallback (`DB_BACKEND=prisma`):**

- Prisma/SQLite — local development only, not for production use

The target collection/table schemas are fully documented in `docs/db/`.

**Frameworks chosen:**

- **Mongoose ^8.x** — mature ODM, schema validation, middleware hooks, TypeScript support, index management, population for references. Already used by the predecessor koreserver project.
- **@clickhouse/client ^1.4.x** — official ClickHouse TypeScript client with streaming, batching, parameterized queries.

---

## Phase 1: Infrastructure

### 1A. Docker Compose

**New file:** `docker-compose.yml` (root)

```yaml
services:
  mongodb:
    image: mongo:7
    ports: ['27017:27017']
    environment: { MONGO_INITDB_DATABASE: abl_platform }
    volumes:
      - mongo_data:/data/db
      - ./scripts/mongo-init:/docker-entrypoint-initdb.d
  clickhouse:
    image: clickhouse/clickhouse-server:24.3
    ports: ['8123:8123', '9000:9000']
    environment:
      CLICKHOUSE_DB: agentic_ai
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: kore@123
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./scripts/clickhouse-init:/docker-entrypoint-initdb.d
```

### 1B. Dependencies

**Modify:** `packages/database/package.json`

- **Add:** `mongoose` ^8.x, `@clickhouse/client` ^1.4.x
- **Keep:** `@prisma/client`, `prisma` (unchanged)

Prisma and Mongoose coexist in the package. The `DB_BACKEND` env var determines which is used at runtime.

---

## Phase 2: Mongoose Models (packages/database)

Add Mongoose models alongside existing Prisma schema. Each collection maps to a Mongoose schema file.

### 2A. Directory structure

```
packages/database/
├── src/
│   ├── index.ts                    # Main exports (connect, disconnect, getDb, models)
│   ├── connection.ts               # Mongoose connection singleton
│   ├── clickhouse.ts               # ClickHouse client singleton + BufferedWriter
│   ├── models/                     # Mongoose model definitions (1 file per collection)
│   │   ├── index.ts                # Re-exports all models
│   │   ├── user.model.ts           # Users (embeds MFA, recovery codes)
│   │   ├── refresh-token.model.ts
│   │   ├── email-verification-token.model.ts
│   │   ├── password-reset-token.model.ts
│   │   ├── organization.model.ts   # Orgs (embeds SSO, domain mappings)
│   │   ├── org-member.model.ts
│   │   ├── tenant.model.ts         # Tenants (embeds LLM policy)
│   │   ├── tenant-member.model.ts
│   │   ├── workspace-invitation.model.ts
│   │   ├── tenant-transfer.model.ts
│   │   ├── project.model.ts        # Projects + agents + versions
│   │   ├── project-agent.model.ts
│   │   ├── agent-version.model.ts
│   │   ├── project-member.model.ts
│   │   ├── model-config.model.ts
│   │   ├── agent-model-config.model.ts
│   │   ├── service-node.model.ts
│   │   ├── deployment.model.ts
│   │   ├── role-definition.model.ts # RBAC
│   │   ├── resource-permission.model.ts
│   │   ├── resource-type.model.ts   # Embeds operations[]
│   │   ├── session.model.ts         # Conversations
│   │   ├── contact.model.ts
│   │   ├── workflow.model.ts        # Embeds steps[], triggers[], escalation[]
│   │   ├── api-key.model.ts
│   │   ├── public-api-key.model.ts
│   │   ├── sdk-channel.model.ts
│   │   ├── widget-config.model.ts
│   │   ├── debug-token.model.ts
│   │   ├── device-auth-request.model.ts
│   │   ├── llm-credential.model.ts
│   │   ├── tenant-model.model.ts    # Embeds connections[]
│   │   ├── tenant-service-instance.model.ts
│   │   ├── tool-secret.model.ts
│   │   ├── end-user-oauth-token.model.ts
│   │   ├── org-proxy-config.model.ts
│   │   ├── key-version.model.ts
│   │   ├── deletion-request.model.ts
│   │   ├── archive-manifest.model.ts
│   │   ├── subscription.model.ts    # Embeds tenantQuotas[].projectQuotas[]
│   │   ├── usage-period.model.ts
│   │   ├── knowledge-base.model.ts
│   │   ├── resource-group.model.ts  # Embeds members[]
│   │   ├── fact.model.ts            # TTL index on expiresAt
│   │   └── audit-log.model.ts       # Control-plane audit
│   ├── clickhouse-schemas/          # ClickHouse DDL + types
│   │   ├── index.ts
│   │   ├── messages.ts              # CREATE TABLE + insert/query helpers
│   │   ├── llm-metrics.ts           # + hourly/daily materialized views
│   │   ├── traces.ts
│   │   ├── logs.ts
│   │   └── audit-events.ts
│   ├── middleware/                   # Mongoose middleware
│   │   ├── tenant-plugin.ts         # Mongoose plugin for auto-injecting tenantId
│   │   └── audit-plugin.ts          # Auto-audit on write operations
│   └── seed.ts                      # Existing Prisma seed (unchanged)
├── seed-mongo.ts                    # New Mongoose seed script
├── prisma/                          # Existing Prisma files (unchanged)
├── package.json
└── tsconfig.json
```

### 2B. Mongoose connection singleton

**New file:** `packages/database/src/connection.ts`

```typescript
import mongoose from 'mongoose';

let connectionAttempted = false;

export async function connectMongo(url: string, dbName: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState >= 1) return mongoose;
  connectionAttempted = true;
  return mongoose.connect(url, {
    dbName,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
    retryReads: true,
  });
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState >= 1) {
    await mongoose.disconnect();
  }
  connectionAttempted = false;
}
```

### 2C. ClickHouse client singleton

**New file:** `packages/database/src/clickhouse.ts`

Same pattern as the Redis client at `apps/runtime/src/services/redis/redis-client.ts` — lazy singleton with graceful shutdown. Includes `BufferedClickHouseWriter` class for batched inserts (100 rows or 5s flush interval).

### 2D. Mongoose model pattern

Each model follows the docs/db spec. Example for `session.model.ts` (from `docs/db/mongo-conversations.md`):

```typescript
import { Schema, model, type Document } from 'mongoose';

export interface ISession extends Document {
  _id: string;
  tenantId: string;
  customerId?: string;
  anonymousId?: string;
  channel: string;
  channelHistory: string[];
  status: string;
  currentAgent: string;
  agentVersion: string;
  environment: string;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  tags: string[];
  // ... all fields from docs/db/mongo-conversations.md
  messageCount: number;
  tokenCount: number;
  estimatedCost: number;
  // ... etc
}

const sessionSchema = new Schema<ISession>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    // ... all fields
    context: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
    tags: { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: 'startedAt', updatedAt: 'lastActivityAt' },
    collection: 'sessions',
  },
);

// Indexes from docs/db/mongo-conversations.md
sessionSchema.index({ tenantId: 1, status: 1, lastActivityAt: -1 });
sessionSchema.index({ tenantId: 1, customerId: 1, status: 1 });
sessionSchema.index({ tenantId: 1, contactId: 1, status: 1 });
sessionSchema.index({ tenantId: 1, deploymentId: 1 });
sessionSchema.index({ tenantId: 1, billingPeriod: 1, isTest: 1 });
sessionSchema.index({ tenantId: 1, entryAgentName: 1, startedAt: -1 });
// TTL index
sessionSchema.index({ lastActivityAt: 1 }, { expireAfterSeconds: 7776000 });

export const Session = model<ISession>('Session', sessionSchema);
```

**Key patterns across all models (from docs/db/):**

- JSON string fields → native `Schema.Types.Mixed` objects (context, metadata, etc.)
- Embedded subdocuments where docs specify (MFA in users, SSO in orgs, connections in tenant_models, quotas in subscriptions, etc.)
- TTL indexes on tokens, invitations, facts (as specified in docs)
- Compound unique indexes where specified
- `_schemaVersion` field on all documents for future migration support

### 2E. Tenant isolation plugin

**New file:** `packages/database/src/middleware/tenant-plugin.ts`

Mongoose plugin that replaces Prisma's `prisma-rls-middleware.ts` for the MongoDB path:

- Auto-injects `tenantId` filter on all `find`, `findOne`, `countDocuments`, `aggregate` operations
- Auto-injects `tenantId` on `save`, `insertMany`, `updateOne`, `updateMany`
- Applied to tenant-scoped models (same list as current `TENANT_SCOPED_MODELS` in `prisma-rls-middleware.ts`)
- Super-admin bypass via context provider

### 2F. ClickHouse table initialization

**New file:** `scripts/clickhouse-init/01-init.sql`

All 5 tables + materialized views exactly as specified in:

- `docs/DATA_ARCHITECTURE.md`, Section 5.1 — traces table
- `docs/DATA_ARCHITECTURE.md`, Section 5.2 — messages table
- `docs/DATA_ARCHITECTURE.md`, Section 5.3 — llm_metrics + hourly/daily rollup views
- `docs/DATA_ARCHITECTURE.md`, Section 5.4 — logs table
- `docs/DATA_ARCHITECTURE.md`, Section 5.5 — audit_events table

### 2G. Mongoose seed script

**New file:** `packages/database/seed-mongo.ts` (existing `seed.ts` stays unchanged)

Same seed data as current (ResourceTypes, RoleDefinitions, dev user, dev tenant, example projects, agents from ABL files, debug token, LLM credentials, model config) but using Mongoose models instead of Prisma client.

---

## Phase 3: Config Schema Updates

### 3A. Extend database schema

**Modify:** `packages/config/src/schemas/database.schema.ts`

Keep existing `url` and `poolSize` fields for Prisma. **Add** new fields:

```typescript
export const DatabaseConfigSchema = z.object({
  // Existing Prisma fields (unchanged)
  url: z.string().optional(),
  poolSize: z.coerce.number().default(10),
  // Backend selector
  backend: z.enum(['prisma', 'mongo']).default('prisma'),
  // MongoDB (used when backend=mongo)
  mongoUrl: z.string().default('mongodb://localhost:27017'),
  mongoDatabase: z.string().default('abl_platform'),
  mongoPoolSize: z.coerce.number().default(50),
  // ClickHouse (used when backend=mongo)
  clickhouseHost: z.string().default('http://localhost:8123'),
  clickhouseUser: z.string().default('clickhouse'),
  clickhousePassword: z.string().default(''),
  clickhouseDatabase: z.string().default('agentic_ai'),
  clickhouseBatchSize: z.coerce.number().default(100),
  clickhouseFlushIntervalMs: z.coerce.number().default(5000),
});
```

### 3B. Update env mapping

**Modify:** `packages/config/src/env-mapping.ts`

Keep existing `DATABASE_URL` / `DATABASE_POOL_SIZE` mappings. **Add** new mappings:

```
DB_BACKEND → database.backend
MONGODB_URL → database.mongoUrl
MONGODB_DATABASE → database.mongoDatabase
MONGODB_POOL_SIZE → database.mongoPoolSize
CLICKHOUSE_HOST → database.clickhouseHost
CLICKHOUSE_USER → database.clickhouseUser
CLICKHOUSE_PASSWORD → database.clickhousePassword
CLICKHOUSE_DATABASE → database.clickhouseDatabase
CLICKHOUSE_BATCH_SIZE → database.clickhouseBatchSize
CLICKHOUSE_FLUSH_INTERVAL_MS → database.clickhouseFlushIntervalMs
```

### 3C. Update .env files

**Modify:** `apps/runtime/.env.example`, `apps/studio/.env.example`

Keep existing `DATABASE_URL` for Prisma. **Add** new variables (commented out by default):

```bash
# Database backend: 'prisma' (default) or 'mongo'
# DB_BACKEND=prisma

# MongoDB + ClickHouse (used when DB_BACKEND=mongo)
# MONGODB_URL=mongodb://localhost:27017
# MONGODB_DATABASE=abl_platform
# CLICKHOUSE_HOST=http://localhost:8123
# CLICKHOUSE_USER=clickhouse
# CLICKHOUSE_PASSWORD=kore@123
# CLICKHOUSE_DATABASE=agentic_ai
```

---

## Phase 4: Runtime Store Implementations

Add new Mongoose/ClickHouse store implementations alongside existing Prisma stores. Prisma stores are **not modified or deleted**.

### 4A. New MongoDB stores (parallel to existing Prisma stores)

| Existing (KEEP)                       | New File                             | Backend                             |
| ------------------------------------- | ------------------------------------ | ----------------------------------- |
| `prisma-conversation-store.ts`        | `mongo-conversation-store.ts`        | Mongoose `Session` model            |
| `prisma-message-store.ts`             | `clickhouse-message-store.ts`        | ClickHouse `messages` table         |
| `prisma-metrics-store.ts`             | `clickhouse-metrics-store.ts`        | ClickHouse `llm_metrics` table      |
| `prisma-contact-store.ts`             | `mongo-contact-store.ts`             | Mongoose `Contact` model            |
| `prisma-fact-store.ts`                | `mongo-fact-store.ts`                | Mongoose `Fact` model               |
| `prisma-workflow-definition-store.ts` | `mongo-workflow-definition-store.ts` | Mongoose `WorkflowDefinition` model |
| `prisma-agent-registry.ts`            | `mongo-agent-registry.ts`            | Mongoose `AgentVersion` model       |

All in `apps/runtime/src/services/stores/`.

### 4B. New ClickHouse stores

| New File                      | Abstract Class | ClickHouse Table                           |
| ----------------------------- | -------------- | ------------------------------------------ |
| `clickhouse-message-store.ts` | `MessageStore` | `messages` (DATA_ARCHITECTURE.md S5.2)     |
| `clickhouse-metrics-store.ts` | `MetricsStore` | `llm_metrics` (DATA_ARCHITECTURE.md S5.3)  |
| `clickhouse-trace-store.ts`   | `TraceStore`   | `traces` (DATA_ARCHITECTURE.md S5.1)       |
| `clickhouse-audit-store.ts`   | `AuditStore`   | `audit_events` (DATA_ARCHITECTURE.md S5.5) |

Key: All ClickHouse stores use `BufferedClickHouseWriter` for batched inserts. `record()`/`append()` are non-blocking — failures logged but never fail user requests.

### 4C. Store factory (config-driven)

**New file:** `apps/runtime/src/services/stores/store-factory.ts`

Selects Prisma or Mongoose/ClickHouse stores based on `DB_BACKEND`:

```typescript
export function initializeStores(backend: 'prisma' | 'mongo'): PlatformStores {
  if (backend === 'mongo') {
    const chClient = requireClickHouse();
    return {
      conversation: new MongoConversationStore(),
      message: new ClickHouseMessageStore(chClient),
      metrics: new ClickHouseMetricsStore(chClient),
      contact: new MongoContactStore(),
      fact: new MongoFactStore(),
      workflowDefinition: new MongoWorkflowDefinitionStore(),
      agentRegistry: new MongoAgentRegistry(),
      trace: new ClickHouseTraceStore(chClient),
      audit: new ClickHouseAuditStore(chClient),
      shutdown: async () => {
        /* flush ClickHouse buffers */
      },
    };
  }
  // backend === 'prisma' — use existing Prisma stores (unchanged)
  const prisma = requirePrisma();
  return {
    conversation: createPrismaConversationStore(prisma),
    message: createPrismaMessageStore(prisma),
    metrics: createPrismaMetricsStore(prisma),
    contact: createPrismaContactStore(prisma),
    fact: createPrismaFactStore(prisma),
    workflowDefinition: createPrismaWorkflowDefinitionStore(prisma),
    agentRegistry: createPrismaAgentRegistry(prisma, ''),
    trace: new InMemoryTraceStore({ type: 'memory' }),
    audit: new InMemoryAuditStore({ type: 'memory' }),
    shutdown: async () => {},
  };
}
```

### 4D. Update stores index

**Modify:** `apps/runtime/src/services/stores/index.ts` — add exports for new stores alongside existing Prisma exports

---

## Phase 5: Runtime DB Layer Update

### 5A. Extend runtime DB init

**Modify:** `apps/runtime/src/db/index.ts`

Keep existing Prisma initialization. **Add** conditional Mongoose + ClickHouse init:

```typescript
import { connectMongo, isMongoConnected, disconnectMongo } from '@agent-platform/database';
import { initClickHouse, disconnectClickHouse } from '@agent-platform/database/clickhouse';

// Existing Prisma init stays unchanged
// ...

export async function initMongoBackend(config) {
  await connectMongo(config.database.mongoUrl, config.database.mongoDatabase);
  initClickHouse({
    host: config.database.clickhouseHost,
    username: config.database.clickhouseUser,
    password: config.database.clickhousePassword,
    database: config.database.clickhouseDatabase,
  });
}

export function isDatabaseAvailable(): boolean {
  const backend = getConfig().database.backend;
  return backend === 'mongo' ? isMongoConnected() : isPrismaAvailable();
}
```

### 5B. Keep Prisma middleware

Existing `prisma-rls-middleware.ts`, `prisma-rls-extension.ts`, `read-only-client.ts` are **unchanged**. The new Mongoose tenant plugin (Phase 2E) handles tenant isolation for the MongoDB path.

### 5C. Update server.ts

**Modify:** `apps/runtime/src/server.ts`

- In `startServer()`: check `config.database.backend` — if `'mongo'`, call `await initMongoBackend(config)`, else use existing Prisma init
- Update health check to report the active backend
- Update shutdown to also call `disconnectMongo()` + `disconnectClickHouse()` + `stores.shutdown()` when using mongo backend
- **Do not remove** existing Prisma code paths — they still work when `DB_BACKEND=prisma`

---

## Phase 6: Studio DB Layer Update

### 6A. Extend Studio DB init

**Modify:** `apps/studio/src/lib/db.ts`

Keep existing Prisma lazy init. **Add** conditional Mongoose path:

```typescript
import { connectMongo } from '@agent-platform/database';

export async function getDB() {
  const backend = process.env.DB_BACKEND || 'prisma';
  if (backend === 'mongo') {
    await connectMongo(process.env.MONGODB_URL!, process.env.MONGODB_DATABASE!);
    return 'mongo';
  }
  // existing Prisma init unchanged
  return ensurePrisma();
}
```

### 6B. Add Mongoose-based Studio API routes

For each Studio API route that currently calls Prisma, add a Mongoose alternative path gated on `DB_BACKEND`. Existing Prisma routes are **not modified**.

**New service layer files** (parallel to existing Prisma-based services):

- `apps/studio/src/services/mongo-auth-service.ts`
- `apps/studio/src/services/mongo-workspace-service.ts`
- `apps/studio/src/services/retention/mongo-gdpr-store.ts`
- `apps/studio/src/services/retention/mongo-retention-store.ts`

Route handlers check `DB_BACKEND` and delegate to the appropriate service.

---

## Phase 7: Scripts & Developer Experience

### 7A. Add new package.json scripts

**Modify:** Root `package.json` — add (keep existing Prisma scripts):

```json
"db:docker": "docker compose up -d",
"db:docker:stop": "docker compose down",
"db:seed:mongo": "tsx packages/database/seed-mongo.ts",
"db:init-ch": "tsx packages/database/src/clickhouse-schemas/init.ts"
```

### 7B. New Mongoose seed script

**New file:** `packages/database/seed-mongo.ts`

Same seed data as `packages/database/seed.ts` but using Mongoose models. Existing Prisma seed script is **unchanged**.

---

## Phase 8: Local Migration Tool

**New file:** `scripts/migrate-prisma-to-mongo-ch.ts`

One-time script to move existing dev SQLite data into MongoDB + ClickHouse:

1. Initialize Prisma client (temporary, reads old SQLite)
2. Connect to MongoDB + ClickHouse
3. For each Prisma model → read all records → transform (parse JSON strings to objects) → insert into Mongoose model / ClickHouse table
4. Log counts per collection

Run: `pnpm tsx scripts/migrate-prisma-to-mongo-ch.ts`

---

## File Summary

### New Files (~60)

| Category              | Count | Key Files                                                                                                |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| Infrastructure        | 3     | `docker-compose.yml`, `scripts/mongo-init/01-init.js`, `scripts/clickhouse-init/01-init.sql`             |
| Database package core | 4     | `connection.ts`, `clickhouse.ts`, `middleware/tenant-plugin.ts`, `middleware/audit-plugin.ts`            |
| Mongoose models       | ~40   | One per collection (see Phase 2A directory listing)                                                      |
| ClickHouse schemas    | 5     | `messages.ts`, `llm-metrics.ts`, `traces.ts`, `logs.ts`, `audit-events.ts`                               |
| Runtime stores        | 7+4   | `mongo-conversation-store.ts`, `clickhouse-message-store.ts`, `clickhouse-trace-store.ts`, etc.          |
| Studio services       | 4     | `mongo-auth-service.ts`, `mongo-workspace-service.ts`, `mongo-gdpr-store.ts`, `mongo-retention-store.ts` |
| Seed + migration      | 2     | `seed-mongo.ts`, `scripts/migrate-prisma-to-mongo-ch.ts`                                                 |

### Deleted Files

**None.** All existing Prisma files and code are preserved unchanged.

### Modified Files (additive changes only)

| File                                             | Change                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/database/package.json`                 | Add Mongoose + @clickhouse/client (keep Prisma)                     |
| `packages/database/src/index.ts`                 | Add Mongoose + ClickHouse exports alongside Prisma exports          |
| `packages/config/src/schemas/database.schema.ts` | Add backend, mongo, clickhouse fields (keep existing)               |
| `packages/config/src/env-mapping.ts`             | Add new env var mappings (keep existing)                            |
| `apps/runtime/src/db/index.ts`                   | Add `initMongoBackend()` alongside existing Prisma init             |
| `apps/runtime/src/server.ts`                     | Conditional DB init based on `DB_BACKEND`, extend health + shutdown |
| `apps/runtime/src/services/stores/index.ts`      | Add exports for new stores (keep Prisma exports)                    |
| `apps/studio/src/lib/db.ts`                      | Add conditional Mongoose path (keep Prisma path)                    |
| `.env.example` files                             | Add new variables commented out (keep existing)                     |
| Root `package.json`                              | Add `db:docker`, `db:seed:mongo`, `db:init-ch` scripts              |

---

## Implementation Order

1. **Phase 1** — Docker compose + dependencies (unblocks everything)
2. **Phase 2** — Mongoose models + ClickHouse schemas in `packages/database` (the new foundation)
3. **Phase 3** — Config schemas + env mapping + `DB_BACKEND` variable
4. **Phase 5** — Runtime DB layer (add `initMongoBackend()`)
5. **Phase 4** — Runtime store implementations (mongo + clickhouse stores + factory)
6. **Phase 6** — Studio DB layer + service layer for mongo path
7. **Phase 7** — Scripts + Mongoose seed
8. **Phase 8** — Local migration tool

---

## Verification

### With `DB_BACKEND=prisma` (default — unchanged behavior)

1. `pnpm dev:runtime` → works exactly as before with SQLite
2. `pnpm dev:studio` → works exactly as before
3. All existing tests pass unchanged

### With `DB_BACKEND=mongo` (new path)

1. `docker compose up -d` → MongoDB + ClickHouse start healthy
2. `pnpm db:seed:mongo` → seed data appears in MongoDB collections
3. `DB_BACKEND=mongo pnpm dev:runtime` → server starts, `/health` shows `mongodb: connected, clickhouse: connected`
4. `DB_BACKEND=mongo pnpm dev:studio` → Studio starts, pages load from MongoDB
5. Create session via SDK → session in MongoDB `sessions`, messages in ClickHouse `messages`
6. Send chat message → LLM metric in ClickHouse `llm_metrics`, trace in `traces`
7. Studio dashboard → reads metrics from ClickHouse, sessions from MongoDB

---

## Key Reference Files

| Purpose                           | File Path                                                            |
| --------------------------------- | -------------------------------------------------------------------- |
| Collection designs (MongoDB)      | `docs/db/mongo-*.md` (17 files)                                      |
| Table designs (ClickHouse)        | `docs/db/ch-*.md` (5 files)                                          |
| Collection mapper                 | `docs/db/COLLECTION_MAPPER.md`                                       |
| Field comparison                  | `docs/db/FIELD_COMPARISON.md`                                        |
| Current Prisma schema             | `packages/database/prisma/schema.prisma` (reference for field names) |
| Current DB init pattern           | `apps/runtime/src/db/index.ts`                                       |
| Current store interfaces          | `packages/compiler/src/platform/stores/*.ts`                         |
| Current Prisma stores (reference) | `apps/runtime/src/services/stores/prisma-*.ts`                       |
| Current Redis client pattern      | `apps/runtime/src/services/redis/redis-client.ts`                    |
| Current server wiring             | `apps/runtime/src/server.ts`                                         |
| Current Studio DB                 | `apps/studio/src/lib/db.ts`                                          |
| Current seed script               | `packages/database/seed.ts`                                          |
| Current tenant RLS                | `packages/database/src/prisma-rls-middleware.ts`                     |
| Current config schema             | `packages/config/src/schemas/base-app.schema.ts`                     |
| Current env mapping               | `packages/config/src/env-mapping.ts`                                 |
