# Data Model Patterns Analysis

**Task:** Pre-Check #56 - Explore existing data model patterns and dual-database architecture
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

The ABL Platform uses a **dual-database architecture** for SearchAI with a robust ModelRegistry system. Pipeline models should be stored in the **platform database** (configuration/metadata) with `'platform'` affinity, not the content database.

---

## 1. Dual-Database Architecture

### Database Affinity

```typescript
export type DatabaseAffinity = 'platform' | 'searchaicontent';
```

**Platform DB (`abl_platform`):**

- Application configuration
- Knowledge Base metadata
- Pipeline definitions ← **OUR MODELS GO HERE**
- User models, tenant models
- LLM credentials, connector configs

**Content DB (`search_ai`):**

- Search chunks
- Search documents
- Embeddings
- Extracted content

### ModelRegistry Pattern

**Location:** `packages/database/src/model-registry.ts`

```typescript
// Register models with affinity
ModelRegistry.registerModelDefinition(
  'SearchSource', // Model name
  SearchSourceSchema, // Mongoose schema
  'searchaicontent', // Database affinity
);

// SearchAI binds models to connections at startup
const models = ModelRegistry.bindModelsForSearchAI(
  platformConn, // abl_platform connection
  searchaiContentConn, // search_ai connection
);
```

**Key Insight:** Pipeline configuration is metadata, not content → Use **'platform'** affinity.

---

## 2. Model Definition Pattern

### Standard Structure

**Example:** `packages/database/src/models/search-source.model.ts`

```typescript
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISearchSource {
  _id: string;
  tenantId: string;
  indexId: string;
  name: string;
  // ... fields
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SearchSourceSchema = new Schema<ISearchSource>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    name: { type: String, required: true },
    // ... fields
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true, // Auto-manage createdAt/updatedAt
    collection: 'search_sources', // Explicit collection name
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchSourceSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SearchSourceSchema.index({ tenantId: 1, indexId: 1 });
SearchSourceSchema.index({ indexId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('SearchSource', SearchSourceSchema, 'searchaicontent');

export const SearchSource =
  (mongoose.models.SearchSource as any) || model<ISearchSource>('SearchSource', SearchSourceSchema);
```

---

## 3. Naming Conventions

| Element        | Convention   | Example                                                  |
| -------------- | ------------ | -------------------------------------------------------- |
| **Interface**  | `ISearchX`   | `ISearchSource`, `ISearchChunk`                          |
| **Schema**     | `XSchema`    | `SearchSourceSchema`, `PipelineDefinitionSchema`         |
| **Model**      | `X`          | `SearchSource`, `PipelineDefinition`                     |
| **Collection** | `snake_case` | `search_sources`, `pipeline_definitions`                 |
| **File**       | `x.model.ts` | `search-source.model.ts`, `pipeline-definition.model.ts` |

---

## 4. Required Plugins

### tenantIsolationPlugin

**Location:** `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts`

**Purpose:** Auto-inject `tenantId` filter on all queries using AsyncLocalStorage.

```typescript
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

schema.plugin(tenantIsolationPlugin);
```

**Behavior:**

- Pre-hook on find/update/delete → inject `{ tenantId }` filter
- Pre-validate on save → set `tenantId` from context
- Works with AsyncLocalStorage (no manual tenantId passing)

**CRITICAL:** All models with `tenantId` field MUST use this plugin.

### Other Available Plugins

| Plugin             | Purpose                                 | When to Use                 |
| ------------------ | --------------------------------------- | --------------------------- |
| `auditTrailPlugin` | Log all CRUD operations                 | Compliance-sensitive models |
| `encryptionPlugin` | Field-level encryption                  | Credentials, secrets        |
| `leanIdPlugin`     | Convert `_id` to string in lean queries | (Auto-applied globally)     |
| `slowQueryPlugin`  | Log queries >100ms                      | (Auto-applied globally)     |

---

## 5. ID Generation

**Use `uuidv7()`** - Time-sortable UUIDs (RFC 9562)

```typescript
import { uuidv7 } from '../mongo/base-document.js';

const schema = new Schema({
  _id: { type: String, default: uuidv7 },
  // ...
});
```

**Benefits:**

- Time-sortable (like ObjectId)
- Globally unique (no coordination needed)
- Shard-safe (random component)
- URL-safe strings

---

## 6. Index Patterns

### Compound Indexes for Tenant Isolation

```typescript
// ALWAYS index tenantId first (most selective filter)
schema.index({ tenantId: 1, indexId: 1 });
schema.index({ tenantId: 1, status: 1, createdAt: -1 });

// For queries within single index
schema.index({ indexId: 1, priority: -1 });
```

### TTL Indexes

```typescript
// Auto-delete after 90 days
schema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
```

### Unique Indexes

```typescript
// Unique within tenant
schema.index({ tenantId: 1, name: 1 }, { unique: true });
```

---

## 7. Validation Patterns

### Schema-Level Validation

```typescript
const schema = new Schema({
  name: {
    type: String,
    required: true,
    minlength: 1,
    maxlength: 100,
    trim: true,
  },
  priority: {
    type: Number,
    required: true,
    min: 1,
    max: 100,
    validate: {
      validator: Number.isInteger,
      message: 'Priority must be an integer',
    },
  },
  status: {
    type: String,
    required: true,
    enum: ['active', 'inactive', 'deleted'],
    default: 'active',
  },
});
```

### Custom Validators

```typescript
schema.path('flows').validate(function (flows: any[]) {
  return flows.length > 0;
}, 'Pipeline must have at least one flow');
```

---

## 8. Nested Schema Pattern

For arrays of objects (e.g., flows within pipeline):

```typescript
// Define nested schema separately
const FlowSchema = new Schema(
  {
    id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    priority: { type: Number, required: true },
    selectionRules: { type: String, default: null },
    stages: [{ type: Schema.Types.Mixed }], // Or define StageSchema
  },
  { _id: false },
); // Disable auto _id for subdocuments

// Use in parent schema
const PipelineDefinitionSchema = new Schema({
  _id: { type: String, default: uuidv7 },
  tenantId: { type: String, required: true },
  flows: [FlowSchema], // Array of nested schemas
  sharedStages: [{ type: Schema.Types.Mixed }],
  // ...
});
```

---

## 9. Version Field Pattern

All models include `_v` (schema version) for migrations:

```typescript
{
  _v: { type: Number, default: 1 }
}
```

**Usage:** Increment on breaking schema changes, handle in code:

```typescript
if (doc._v === 1) {
  // Migrate v1 → v2 lazily
  doc.newField = deriveFromOldField(doc.oldField);
  doc._v = 2;
  await doc.save();
}
```

---

## 10. SearchAI Dual-Connection

**Location:** `apps/search-ai/src/db/dual-connection.ts`

```typescript
// At SearchAI startup
const dualConnection = await SearchAIDualConnection.initialize({
  platformDb: platformDbConfig,
  contentDb: contentDbConfig,
});

// Bind models to connections
const models = ModelRegistry.bindModelsForSearchAI(
  dualConnection.getPlatformConnection(),
  dualConnection.getContentConnection(),
);

// Access models
const PipelineDefinition = models['PipelineDefinition']; // Uses platform DB
const SearchChunk = models['SearchChunk']; // Uses content DB
```

---

## 11. Recommendations for Pipeline Models

### Database Affinity

```typescript
// ✅ CORRECT - Pipeline config is metadata
ModelRegistry.registerModelDefinition(
  'PipelineDefinition',
  PipelineDefinitionSchema,
  'platform', // ← App config database
);

// ❌ WRONG - Don't put in content DB
ModelRegistry.registerModelDefinition(
  'PipelineDefinition',
  PipelineDefinitionSchema,
  'searchaicontent', // ← Only for chunks/documents
);
```

### Required Plugins

```typescript
PipelineDefinitionSchema.plugin(tenantIsolationPlugin); // REQUIRED
```

### Indexes

```typescript
// Primary query: list pipelines for index
PipelineDefinitionSchema.index({ tenantId: 1, indexId: 1 });

// Flow selection lookup
PipelineDefinitionSchema.index({ tenantId: 1, indexId: 1, 'flows.priority': -1 });

// Pipeline by name
PipelineDefinitionSchema.index({ tenantId: 1, indexId: 1, name: 1 }, { unique: true });
```

---

## 12. Model Template

```typescript
/**
 * Pipeline Definition Model
 *
 * Represents a pipeline configuration with multiple flows for an index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPipelineFlow {
  id: string;
  name: string;
  priority: number;
  selectionRules: string | null;
  stages: any[];
}

export interface IPipelineDefinition {
  _id: string;
  tenantId: string;
  indexId: string;
  name: string;
  description: string | null;
  flows: IPipelineFlow[];
  sharedStages: any[];
  version: number;
  status: 'active' | 'inactive';
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Nested Schemas ──────────────────────────────────────────────────────

const FlowSchema = new Schema<IPipelineFlow>(
  {
    id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    priority: { type: Number, required: true, min: 1 },
    selectionRules: { type: String, default: null },
    stages: [{ type: Schema.Types.Mixed }],
  },
  { _id: false },
);

// ─── Main Schema ─────────────────────────────────────────────────────────

const PipelineDefinitionSchema = new Schema<IPipelineDefinition>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    flows: [FlowSchema],
    sharedStages: [{ type: Schema.Types.Mixed }],
    version: { type: Number, default: 1 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'pipeline_definitions',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

PipelineDefinitionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

PipelineDefinitionSchema.index({ tenantId: 1, indexId: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, indexId: 1, name: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('PipelineDefinition', PipelineDefinitionSchema, 'platform');

export const PipelineDefinition =
  (mongoose.models.PipelineDefinition as any) ||
  model<IPipelineDefinition>('PipelineDefinition', PipelineDefinitionSchema);
```

---

## Conclusion

**Key Decisions:**

1. ✅ Use **'platform'** database affinity (config, not content)
2. ✅ Apply **tenantIsolationPlugin** (required for all tenant-scoped models)
3. ✅ Use **uuidv7()** for \_id generation
4. ✅ Follow naming: `IPipelineDefinition`, `PipelineDefinitionSchema`, `PipelineDefinition`
5. ✅ Nested schemas for flows with `_id: false`
6. ✅ Compound indexes: `{ tenantId, indexId }` as primary
7. ✅ Register with ModelRegistry before binding
8. ✅ Location: `packages/database/src/models/pipeline-definition.model.ts`

**Next:** Proceed to Task #39 (Backend Design: Data models) with this template.

---

**Analysis complete.** Ready for design implementation.
