# Pipeline Seed & Setup Script Design

## Goal

Create an idempotent setup script for initializing pipeline infrastructure and seed data during fresh platform deployments. The script handles ClickHouse analytics DDL, MongoDB pipeline definitions, and default pipeline configs.

## Scope

- ClickHouse analytics tables + materialized views (via existing `initAnalyticsTables`)
- 3 built-in pipeline definitions in MongoDB (`pipeline_definitions` collection)
- Default pipeline configs per tenant in MongoDB (`pipeline_configs` collection)
- No sample conversation data

## Architecture

### File: `scripts/seed-pipelines.ts`

Standalone script that can run independently or be called from `seed-mongo.ts`.

**Entry points:**

1. CLI: `pnpm tsx scripts/seed-pipelines.ts` (uses `TENANT_ID` env var or `tenant-dev-001` default)
2. Programmatic: `seedPipelines(tenantId?, ownerId?)` exported function called from `seed-mongo.ts`

### Execution Steps

1. **Connect to MongoDB** (shared connection if called from seed-mongo)
2. **Initialize ClickHouse analytics tables** — calls `initAnalyticsTables()` from pipeline-engine (IF NOT EXISTS semantics)
3. **Upsert 3 built-in pipeline definitions** — imports from `pipeline-engine/definitions/*`, writes to `pipeline_definitions` with `_id` as filter key
4. **Upsert default pipeline configs** — one per pipeline type for the tenant, `enabled: false`, empty config, `backfillStatus: 'idle'`

### Pipeline Definitions Seeded

| ID                              | Type          | Steps                                 |
| ------------------------------- | ------------- | ------------------------------------- |
| `builtin:sentiment-analysis`    | Kafka trigger | read-conversation → compute-sentiment |
| `builtin:intent-classification` | Kafka trigger | read-conversation → compute-intent    |
| `builtin:quality-evaluation`    | Kafka trigger | read-conversation → compute-quality   |

### Default Pipeline Configs

For each tenant, 3 configs with:

- `pipelineType`: `sentiment_analysis` / `intent_classification` / `quality_evaluation`
- `enabled: false` (tenant must explicitly enable)
- `config: {}` (uses pipeline defaults)
- `version: 1`
- `backfillStatus: 'idle'`
- `projectId: null` (tenant-level defaults)

### Idempotency

- ClickHouse: `CREATE TABLE IF NOT EXISTS`, `ADD INDEX IF NOT EXISTS`
- MongoDB pipeline definitions: `findOneAndUpdate` with `upsert: true`, filter on `_id`
- MongoDB pipeline configs: `findOneAndUpdate` with `upsert: true`, filter on `{ tenantId, pipelineType, projectId: null }`
- Definition fields that change (description, steps) go to `$set`; immutable fields (\_id, tenantId, createdBy) go to `$setOnInsert`

### Integration with seed-mongo.ts

Add as step 15 in `seed-mongo.ts`, after prompt templates:

```typescript
const { seedPipelines } = await import('../../scripts/seed-pipelines.js');
await seedPipelines(tenantId, userId);
```

### Environment Variables

| Variable         | Default                    | Purpose                            |
| ---------------- | -------------------------- | ---------------------------------- |
| `TENANT_ID`      | `tenant-dev-001`           | Target tenant for pipeline configs |
| `MONGODB_URL`    | localhost:27018 connection | MongoDB connection                 |
| `CLICKHOUSE_URL` | (optional)                 | ClickHouse for analytics DDL       |

### Error Handling

- MongoDB connection failure: exit with error
- ClickHouse unavailable: skip analytics DDL with warning (pipeline definitions still seeded)
- Individual upsert failures: log and continue (partial success is acceptable)
