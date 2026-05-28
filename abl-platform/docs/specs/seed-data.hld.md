# High-Level Design: Seed Data Infrastructure

**Feature:** [Seed Data Infrastructure](../features/seed-data.md)
**Status:** ALPHA
**Created:** 2026-03-23
**Last Updated:** 2026-04-03

---

## 1. Overview

The seed data infrastructure initializes the ABL Platform's databases with foundational records required for operation. The current design now splits platform/core seed, targeted tenant bootstrap, and dev-only fixtures into separate flows, while leaving validation, dry-run, and richer reporting for follow-on iterations.

### Current State

```
packages/database/seed-mongo.ts (main)
  ├── default: platform/core only
  │   ├── ResourceTypes (10 types, 40+ operations)
  │   ├── PromptTemplates (via packages/database/seed-prompt-templates.ts)
  │   └── PipelineDefinitions (via packages/database/seed-pipelines.ts)
  ├── --tenant / --workspace-email: tenant bootstrap only
  │   ├── RoleDefinitions (5 system roles)
  │   ├── TenantLLMPolicy
  │   └── PipelineConfigs (via packages/pipeline-engine/src/pipeline/seed-defaults.ts)
  └── --dev: dev fixtures only
      ├── Dev + E2E workspaces and memberships
      ├── DebugToken
      ├── Optional env-backed LLMCredentials + TenantModels
      └── Curated example projects + tools (via seed-examples.ts + seed-inline-tools.ts)

scripts/seed-secrets.ts (standalone)
  └── AWS Secrets Manager entries

scripts/rbac-tool-permissions.ts (standalone)
  └── RBAC permission alignment

apps/studio workspace creation paths
  ├── createTenant()/createWorkspaceWithOwner()
  └── dev-login attach flow
      └── seedTenantBootstrapDefaults() + seedTenantPipelineConfigs()
```

### Next Iteration

```
packages/database/src/seed/
  ├── orchestrator.ts          -- Unified entry point
  ├── upsert-helpers.ts        -- Shared upsert logic
  ├── validators.ts            -- Zod schemas for seed payloads
  ├── seed-version.ts          -- _seed_meta tracking
  ├── categories/
  │   ├── rbac.ts              -- ResourceTypes, RoleDefinitions
  │   ├── identity.ts          -- Users, Tenants, TenantMembers
  │   ├── llm.ts               -- LLMCredentials, TenantModels, TenantLLMPolicy
  │   ├── projects.ts          -- Projects, ProjectAgents, ProjectSettings, ProjectLLMConfig
  │   ├── tools.ts             -- ProjectTools (DSL extraction)
  │   ├── prompts.ts           -- PromptTemplates
  │   └── pipelines.ts         -- PipelineDefinitions, PipelineConfigs
  └── fixtures/
      └── seed-mock-responses.ts
```

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    CLI / CI Entry Points                  │
│  pnpm seed:core | pnpm seed:dev | db:init | seed-mongo.ts --tenant │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  Seed Entrypoint + Helpers               │
│  - Parses --fresh, --dev, --tenant, --workspace-email   │
│  - Seeds platform core by default                        │
│  - Adds tenant bootstrap or dev fixtures explicitly      │
│  - Tracks seed version via _seed_meta                    │
│  - Logs results to console                               │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼───────────────┐
              ▼            ▼               ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │ Platform Core │ │ Tenant   │ │ Dev Fixtures  │
     │ (ResourceType,│ │ Bootstrap│ │ (Users,       │
     │ Prompt, Defn) │ │ (RBAC,   │ │ examples,     │
     │               │ │ policy,  │ │ debug token,  │
     │               │ │ configs) │ │ LLM fixtures) │
     └──────┬───────┘ └────┬─────┘ └──────┬───────┘
            │              │               │
            ▼              ▼               ▼
     ┌──────────────────────────────────────────────┐
     │           Shared Upsert Layer                 │
     │       upsertOne() + targeted seed helpers     │
     └──────────────────────┬───────────────────────┘
                            │
                            ▼
     ┌──────────────────────────────────────────────┐
     │         MongoDB (Mongoose Models)             │
     └──────────────────────────────────────────────┘
```

### 2.2 Execution Order (Dependency Graph)

Categories must execute in dependency order (later categories reference IDs from earlier ones):

```
1. rbac         -- ResourceTypes (no dependencies)
2. identity     -- Users, Tenants, TenantMembers (references nothing)
3. llm          -- LLMCredentials, TenantModels, TenantLLMPolicy (references identity)
4. projects     -- Projects, ProjectAgents, ProjectSettings (references identity, llm)
5. tools        -- ProjectTools (references projects)
6. prompts      -- PromptTemplates (references nothing, but runs after identity for tenant context)
7. pipelines    -- PipelineDefinitions, PipelineConfigs (references identity)
```

### 2.3 Runtime API Architecture

```
Studio                          Runtime
┌──────────┐   GET /api/projects/:id/settings   ┌──────────────────────────────┐
│ Studio   │───────────────────────────────────▶│ /api/projects/:id/settings   │
│ Advanced │                                    │  ├── authMiddleware           │
│ Settings │◀──────────── JSON response ────────│  ├── project RBAC            │
└──────────┘                                    │  ├── ProjectSettings lookup   │
                                                │  └── PromptCatalog defaults   │
                                                └──────────────────────────────┘
```

## 3. Data Model

### 3.1 Seed Payload Validation Schemas

All seed data will be validated with Zod before DB writes. Key schemas:

```typescript
// ID fields use z.string().min(1), never .cuid() or .cuid2()
const seedUserSchema = z.object({
  _id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  avatarUrl: z.string().url().nullable(),
  googleId: z.string().min(1),
  authProvider: z.enum(['google', 'github', 'saml']),
});

const seedTenantSchema = z.object({
  _id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  ownerId: z.string().min(1),
  status: z.enum(['active', 'suspended', 'deleted']),
});

const seedResourceTypeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  isSystem: z.boolean(),
  operations: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string().nullable().optional(),
      isSystem: z.boolean(),
    }),
  ),
});
```

### 3.2 Seed Metadata Collection

```typescript
// _seed_meta collection (unmanaged by Mongoose)
interface SeedMetaRecord {
  key: 'seed_version';
  value: string; // e.g., "v3"
  appliedAt: Date;
}
```

### 3.3 Collections Affected

| Collection             | Seed Script  | Records    | Idempotent                                      |
| ---------------------- | ------------ | ---------- | ----------------------------------------------- |
| `resource_types`       | rbac         | 10         | Yes (upsert by name)                            |
| `role_definitions`     | rbac         | 5/tenant   | Yes (upsert by tenantId+name)                   |
| `users`                | identity     | 2+         | Yes (upsert by email)                           |
| `tenants`              | identity     | 1          | Yes (upsert by \_id)                            |
| `tenant_members`       | identity     | 2+         | Yes (upsert by tenantId+userId)                 |
| `llm_credentials`      | llm          | 0-2        | Yes (upsert by tenantId+provider+scope)         |
| `tenant_models`        | llm          | 0-2        | Yes (upsert by tenantId+displayName)            |
| `tenant_llm_policies`  | llm          | 1          | Yes (upsert by tenantId)                        |
| `projects`             | projects     | 11 curated | Yes (upsert by \_id)                            |
| `project_agents`       | projects     | ~40        | Yes (upsert by projectId+name)                  |
| `project_settings`     | projects     | 1          | Yes (upsert by projectId+tenantId)              |
| `project_llm_configs`  | projects     | 1          | Yes (upsert by projectId+tenantId)              |
| `model_configs`        | projects     | 1          | Yes (upsert by \_id)                            |
| `project_tools`        | tools        | ~60        | Yes (upsert by tenantId+projectId+name)         |
| `prompt_templates`     | prompts      | ~100       | Yes (upsert by key)                             |
| `pipeline_definitions` | pipelines    | ~10        | Yes (upsert by \_id)                            |
| `pipeline_configs`     | pipelines    | ~10/tenant | Yes (upsert by tenantId+pipelineType+projectId) |
| `debug_tokens`         | identity     | 1          | Yes (upsert by \_id)                            |
| `subscriptions`        | migration    | 1          | Yes (checked via migration runner)              |
| `_seed_meta`           | orchestrator | 1          | Yes (upsert by key)                             |

## 4. Twelve Architectural Concerns

### 4.1 Security

- **Credential handling:** LLM API keys from env vars are written as-is in dev. In production, encryption at rest via MongoDB field-level encryption or KMS.
- **Wipe guard:** `NODE_ENV=production` blocks `--fresh`. Additional guard: refuse wipe if `DEPLOYMENT_ENV=prod` env var is set.
- **Secret seeding:** `seed-secrets.ts` uses AWS Secrets Manager with proper IAM role. No secrets stored in code.
- **Auth on project settings API:** `authMiddleware`, project scope, RBAC, and tenant rate limiting are enforced.

### 4.2 Tenant Isolation

- Every seed record includes `tenantId` where applicable.
- `seed-mongo.ts` can target an existing workspace via `--workspace-email`, resolving `tenantId` from the user's membership before seeding tenant-scoped records. `SEED_EMAIL` remains as a deprecated compatibility path.
- Cross-tenant queries are impossible because upsert filters always include `tenantId`.
- The runtime project settings API is authenticated and project-scoped -- requires valid session plus project access.

### 4.3 Performance

- Seed scripts run sequentially within categories, in parallel across independent categories (future optimization).
- `upsertOne()` uses `findOneAndUpdate` with `upsert: true` -- single atomic operation per record.
- `seedNodeTypes()` uses `bulkWrite` for batch operations (36 node types).
- Full seed completes in ~10-15 seconds against local MongoDB.

### 4.4 Scalability

- Seed data is bounded: ~250 records total for a full dev environment.
- Per-tenant seeding adds ~70 records per tenant.
- ClickHouse DDL is idempotent (`CREATE IF NOT EXISTS`).
- No scalability concern at current data volumes.

### 4.5 Observability

- Each category logs start/end with record counts.
- Console logging exists today. Structured reporting is still a future enhancement.
- Errors logged with full context (collection, filter, error message).
- Seed version tracked in `_seed_meta` for auditing.

### 4.6 Error Handling

- Zod validation failures: log error, skip record, continue seeding (non-fatal).
- MongoDB connection failure: fatal, exit with code 1.
- Individual upsert failure: log error with record details, continue (non-fatal unless `--strict` flag).
- ClickHouse DDL failure: log warning, skip analytics setup (non-fatal).

### 4.7 Data Consistency

- All upserts are atomic (`findOneAndUpdate` with `upsert: true`).
- `$setOnInsert` for immutable fields (`_id`), `$set` for mutable fields.
- Re-runs never overwrite tenant customizations (pipeline configs, enabled flags).
- `--fresh` mode drops entire database before seeding -- only for dev/staging.

### 4.8 Compliance

- No PII in seed data (dev email `dev@kore.ai` is synthetic).
- LLM API keys from env vars, not hardcoded.
- Audit trail via `_seed_meta` collection (version, timestamp).
- Right to erasure: seed data can be fully dropped via `--fresh`.

### 4.9 Backward Compatibility

- `seed-mongo.ts` remains the public entry point, with `seed:all` retained as a backward-compatible alias for `pnpm seed:dev`.
- Studio workspace creation and dev-login now proactively ensure tenant bootstrap defaults instead of relying on the dev seed path.
- Studio prompt defaults are now returned by `GET /api/projects/:projectId/settings` instead of a standalone seed-data endpoint.

### 4.10 Testing

- See [Test Spec](../testing/seed-data.md) for full coverage matrix.
- 10 E2E scenarios, 15 integration scenarios, 34 unit tests.
- MongoMemoryReplSet for integration tests.
- Real server on random port for E2E tests.

### 4.11 Deployment

- **Local dev:** `pnpm db:init` (migrations + `pnpm seed:dev`).
- **Tenant bootstrap:** `pnpm tsx packages/database/seed-mongo.ts --tenant <tenantId>` or `--workspace-email <email>`.
- **ArgoCD PreSync / init jobs:** `SEED_VERSION=$CHART_VERSION pnpm seed:core` (version-gated).
- **Fresh dev bootstrap:** `pnpm tsx packages/database/seed-mongo.ts --fresh --dev` (wipe + re-seed, non-prod only).

### 4.12 Extensibility

- New seed categories can still be extracted incrementally from the entrypoint into helper modules.
- Zod validators and richer `--scope` controls remain planned follow-on work.
- Plugin architecture (future): seed data from external packages.

## 5. Alternatives Considered

### 5.1 Prisma Seed Mechanism

**Rejected.** The platform migrated from Prisma to Mongoose. Prisma's seed mechanism (`prisma db seed`) is tied to Prisma Client, which is no longer used.

### 5.2 MongoDB Atlas Data Federation

**Rejected.** Adds external dependency. Seed data is small enough for direct MongoDB writes.

### 5.3 JSON Fixture Files with mongoimport

**Rejected.** Loses the conditional logic (env-var-dependent credentials, dynamic IDs). TypeScript scripts provide programmatic flexibility.

### 5.4 Migration-Based Seeding

**Considered.** Some seed data (like the enterprise subscription) is already handled via migrations (`20260311_013_seed_dev_enterprise_subscription.ts`). However, migrations are version-ordered and non-repeatable, while seed data needs to be idempotent and re-runnable. The hybrid approach (migrations for schema changes, seed scripts for data) is the correct split.

## 6. API Changes

### 6.1 Project Settings `promptDefaults`

**Current:**

```
GET /api/projects/:projectId/settings
→ {
     success: true,
     settings: { ... },
     promptDefaults: {
       "tool_description.shared.thought": "...",
       "llm_prompt.entity_extraction": "...",
       "escalation.digital": "..."
     }
   }
```

**Notes:**

```
The prompt defaults surface is intentionally curated for the Advanced Settings UI.
It is not a general seed-data API.
```

The runtime still resolves execution prompts through DB overrides first, then PromptCatalog fallback.

### 6.2 Validation Strictness

Zod validation failures are handled differently by category criticality:

- **Fatal categories** (rbac, identity): Validation failure aborts the category and returns exit code 1. These records are required for platform operation.
- **Non-fatal categories** (tools, prompts): Validation failure logs a warning, skips the record, and continues. These records are supplementary.

### 6.3 Nested Schema Validation

Complex nested structures like `TenantModel.connections` require dedicated Zod schemas:

```typescript
const connectionSchema = z.object({
  id: z.string().min(1),
  credentialId: z.string().min(1),
  connectionType: z.enum(['http', 'grpc', 'sdk']),
  isActive: z.boolean(),
  isPrimary: z.boolean(),
  healthStatus: z.enum(['healthy', 'unhealthy', 'unchecked']),
  createdBy: z.string().min(1),
});

const seedTenantModelSchema = z.object({
  _id: z.string().min(1),
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  modelId: z.string().min(1),
  provider: z.string().min(1),
  connections: z.array(connectionSchema).min(1),
  // ... other fields
});
```

## 7. Migration Plan

1. **Phase 1 (completed):** Extract shared `upsert-helpers.ts`, split `seed-mongo.ts` into platform core vs tenant bootstrap vs dev fixtures, and move Studio prompt defaults to the project settings API.
2. **Phase 2 (next):** Add validation, `--dry-run`, and richer reporting to the remaining seed flows.
3. **Phase 3 (next):** Add optional `--scope` controls and stronger CLI ergonomics around targeted tenant bootstrap.
4. **Phase 4:** Expand integration + E2E coverage and CI usage of the separated seed paths.
