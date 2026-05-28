# Data Models Design - Pipeline System

**Task:** Backend Design #39 - Data models (PipelineDefinition, PipelineFlow schemas)
**Status:** In Progress
**Date:** 2026-03-07

---

## Executive Summary

This document specifies the complete MongoDB data models for the flow-based pipeline system. It includes Mongoose schemas, TypeScript interfaces, validation rules, indexes, and migration strategies.

**Key Models:**

1. **PipelineDefinition** - Main pipeline configuration (one per knowledge base)
2. **PipelineFlow** - Flow within pipeline (nested subdocument)
3. **PipelineStage** - Stage within flow (nested subdocument)
4. **RuleCondition** - Flow selection rules (nested subdocument)

**Design Principles:**

- **Single-document model** - PipelineDefinition embeds flows (no separate collection)
- **Tenant isolation** - Every query includes `tenantId`
- **Versioning** - Auto-increment version on updates
- **Validation** - Mongoose + Zod validation layers
- **Indexes** - Optimized for common queries

---

## Table of Contents

1. [PipelineDefinition Model](#pipelinedefinition-model)
2. [PipelineFlow Model](#pipelineflow-model)
3. [PipelineStage Model](#pipelinestage-model)
4. [RuleCondition Model](#rulecondition-model)
5. [Supporting Types](#supporting-types)
6. [Indexes](#indexes)
7. [Validation Rules](#validation-rules)
8. [Migration Strategy](#migration-strategy)
9. [Example Documents](#example-documents)

---

## PipelineDefinition Model

### TypeScript Interface

```typescript
import { ObjectId } from 'mongodb';

export interface IPipelineDefinition {
  _id: ObjectId;
  tenantId: string;
  knowledgeBaseId: string; // ONE pipeline per KB

  name: string;
  description: string;
  version: number; // Auto-incremented on update
  status: 'draft' | 'active' | 'archived';

  // Multiple flows (embedded subdocuments)
  flows: IPipelineFlow[];

  // Shared stages (optional, inherited by flows)
  sharedStages?: {
    enrichment?: IPipelineStage[];
    indexing?: IPipelineStage[]; // At least one indexing stage required
  };

  // Provider-level default configurations (optional)
  providerDefaults?: Record<string, Record<string, unknown>>;

  // Metadata
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeployedAt?: Date;

  // Validation cache (populated by validation service)
  validationErrors?: IValidationError[];
  validationStatus?: 'valid' | 'invalid' | 'pending';
  lastValidatedAt?: Date;
}
```

### Mongoose Schema

```typescript
import mongoose, { Schema, Document } from 'mongoose';

// Subdocument schemas (defined below)
const PipelineFlowSchema = new Schema({...});
const PipelineStageSchema = new Schema({...});

const PipelineDefinitionSchema = new Schema<IPipelineDefinition>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    knowledgeBaseId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'archived'],
      default: 'draft',
      required: true,
    },
    flows: {
      type: [PipelineFlowSchema],
      required: true,
      validate: [
        {
          validator: (flows: IPipelineFlow[]) => flows.length > 0,
          message: 'Pipeline must have at least one flow',
        },
        {
          validator: (flows: IPipelineFlow[]) => flows.length <= 50,
          message: 'Pipeline cannot exceed 50 flows (performance limit)',
        },
      ],
    },
    sharedStages: {
      type: {
        enrichment: [PipelineStageSchema],
        indexing: {
          type: [PipelineStageSchema],
          validate: {
            validator: (stages: IPipelineStage[]) => !stages || stages.length > 0,
            message: 'Indexing stages array must not be empty if provided',
          },
        },
      },
      required: false,
    },
    providerDefaults: {
      type: Map,
      of: Schema.Types.Mixed,
      required: false,
    },
    createdBy: {
      type: String,
      required: true,
    },
    lastDeployedAt: {
      type: Date,
      required: false,
    },
    validationErrors: {
      type: [
        {
          code: String,
          message: String,
          severity: {
            type: String,
            enum: ['error', 'warning', 'info'],
          },
          path: String,
        },
      ],
      required: false,
    },
    validationStatus: {
      type: String,
      enum: ['valid', 'invalid', 'pending'],
      required: false,
    },
    lastValidatedAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true, // Auto-creates createdAt and updatedAt
    collection: 'pipeline_definitions',
  },
);

// Indexes
PipelineDefinitionSchema.index({ tenantId: 1, knowledgeBaseId: 1 }, { unique: true });
PipelineDefinitionSchema.index({ tenantId: 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, 'flows.id': 1 });

// Pre-save middleware - increment version on update
PipelineDefinitionSchema.pre('save', function (next) {
  if (!this.isNew) {
    this.version += 1;
  }
  next();
});

// Pre-save middleware - ensure at least one active flow
PipelineDefinitionSchema.pre('save', function (next) {
  const hasActiveFlow = this.flows.some((flow) => flow.enabled);
  if (!hasActiveFlow) {
    return next(new Error('Pipeline must have at least one enabled flow'));
  }
  next();
});

export const PipelineDefinition = mongoose.model<IPipelineDefinition & Document>(
  'PipelineDefinition',
  PipelineDefinitionSchema,
);
```

### Field Descriptions

| Field              | Type               | Required | Description                                                     |
| ------------------ | ------------------ | -------- | --------------------------------------------------------------- |
| `_id`              | ObjectId           | Yes      | Auto-generated MongoDB ID                                       |
| `tenantId`         | string             | Yes      | Tenant identifier (for multi-tenancy isolation)                 |
| `knowledgeBaseId`  | string             | Yes      | Knowledge base ID (unique per tenant)                           |
| `name`             | string             | Yes      | Pipeline name (1-200 chars)                                     |
| `description`      | string             | No       | Pipeline description (max 1000 chars)                           |
| `version`          | number             | Yes      | Version number (auto-incremented on update, starts at 1)        |
| `status`           | enum               | Yes      | Pipeline status: 'draft', 'active', 'archived' (default: draft) |
| `flows`            | IPipelineFlow[]    | Yes      | Array of flows (at least 1 required)                            |
| `sharedStages`     | object             | No       | Shared stages inherited by all flows                            |
| `providerDefaults` | Map                | No       | Provider-level default configs (provider_id -> config)          |
| `createdBy`        | string             | Yes      | User ID who created the pipeline                                |
| `createdAt`        | Date               | Yes      | Creation timestamp (auto-managed by Mongoose)                   |
| `updatedAt`        | Date               | Yes      | Last update timestamp (auto-managed by Mongoose)                |
| `lastDeployedAt`   | Date               | No       | Last deployment timestamp (when status changed to 'active')     |
| `validationErrors` | IValidationError[] | No       | Cached validation errors (populated by validation service)      |
| `validationStatus` | enum               | No       | Validation status: 'valid', 'invalid', 'pending'                |
| `lastValidatedAt`  | Date               | No       | Last validation timestamp                                       |

### Constraints

1. **Unique pipeline per KB:** `(tenantId, knowledgeBaseId)` unique index
2. **Flow count limits:** `1 <= flows.length <= 50` (performance limit)
3. **At least one enabled flow:** `flows.some(f => f.enabled)`
4. **Flow IDs unique within pipeline:** Validated by application logic
5. **Priority uniqueness:** Flow priorities should be unique (validated by application)

---

## PipelineFlow Model

### TypeScript Interface

```typescript
export interface IPipelineFlow {
  id: string; // UUID or short ID (e.g., 'flow-pdf-docling')
  name: string;
  description?: string;
  enabled: boolean;

  // Selection (document routing)
  selectionRules?: IRuleCondition[]; // Optional (default flow has no rules)
  priority: number; // 1-100, higher = evaluated first

  // Flow-specific stages (extraction → chunking)
  stages: IPipelineStage[];

  // Override shared stages (optional)
  customEnrichment?: IPipelineStage[];
  customIndexing?: IPipelineStage[];

  // Provider-level overrides (optional)
  providerDefaults?: Record<string, Record<string, unknown>>;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
```

### Mongoose Subdocument Schema

```typescript
const RuleConditionSchema = new Schema({...}); // Defined below
const PipelineStageSchema = new Schema({...}); // Defined below

const PipelineFlowSchema = new Schema<IPipelineFlow>(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    enabled: {
      type: Boolean,
      required: true,
      default: true,
    },
    selectionRules: {
      type: [RuleConditionSchema],
      required: false,
    },
    priority: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    stages: {
      type: [PipelineStageSchema],
      required: true,
      validate: {
        validator: (stages: IPipelineStage[]) => stages.length > 0,
        message: 'Flow must have at least one stage',
      },
    },
    customEnrichment: {
      type: [PipelineStageSchema],
      required: false,
    },
    customIndexing: {
      type: [PipelineStageSchema],
      required: false,
    },
    providerDefaults: {
      type: Map,
      of: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: true,
    _id: false, // Don't create separate _id for subdocuments
  },
);

// Validation: Ensure flow ID is unique within pipeline (application-level check)
// Validation: Ensure stage IDs are unique within flow (application-level check)
```

### Field Descriptions

| Field              | Type             | Required | Description                                                        |
| ------------------ | ---------------- | -------- | ------------------------------------------------------------------ |
| `id`               | string           | Yes      | Flow identifier (unique within pipeline, e.g., 'flow-pdf-docling') |
| `name`             | string           | Yes      | Flow name (1-200 chars)                                            |
| `description`      | string           | No       | Flow description (max 1000 chars)                                  |
| `enabled`          | boolean          | Yes      | Whether flow is enabled (default: true)                            |
| `selectionRules`   | IRuleCondition[] | No       | CEL-based selection rules (optional for default/fallback flow)     |
| `priority`         | number           | Yes      | Priority (1-100, higher = evaluated first)                         |
| `stages`           | IPipelineStage[] | Yes      | Flow-specific stages (at least 1 required)                         |
| `customEnrichment` | IPipelineStage[] | No       | Override shared enrichment stages                                  |
| `customIndexing`   | IPipelineStage[] | No       | Override shared indexing stages                                    |
| `providerDefaults` | Map              | No       | Flow-level provider default configs                                |
| `createdAt`        | Date             | Yes      | Creation timestamp                                                 |
| `updatedAt`        | Date             | Yes      | Last update timestamp                                              |

### Constraints

1. **At least one stage:** `stages.length >= 1`
2. **Flow ID unique:** Within parent PipelineDefinition
3. **Priority range:** 1-100
4. **Selection rules:** Optional (default/fallback flow has no rules)

---

## PipelineStage Model

### TypeScript Interface

```typescript
export type PipelineStageType =
  | 'extraction'
  | 'chunking'
  | 'enrichment'
  | 'embedding'
  | 'knowledge-graph'
  | 'multimodal';

export interface IPipelineStage {
  id: string; // UUID or short ID (e.g., 'stage-extract-1')
  name: string;
  type: PipelineStageType;
  provider: string; // Provider ID (e.g., 'docling', 'openai', 'bge-m3')
  providerConfig: Record<string, unknown>; // Provider-specific configuration

  // Error handling
  onError: 'fail' | 'continue'; // 'fail' = fail entire flow, 'continue' = skip stage

  // Optional fallback provider
  fallbackProvider?: string;
  fallbackConfig?: Record<string, unknown>;

  // Optional execution condition (CEL expression)
  executionCondition?: string; // e.g., "output.confidence < 0.8" (run OCR if extraction confidence low)

  // Optional required provider version (semver)
  requiredProviderVersion?: string; // e.g., "^1.2.0"

  // Metadata
  description?: string;
  estimatedDuration?: number; // Estimated duration in milliseconds (for UI)
  estimatedCost?: number; // Estimated cost in USD (for UI)
}
```

### Mongoose Subdocument Schema

```typescript
const PipelineStageSchema = new Schema<IPipelineStage>(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    type: {
      type: String,
      enum: ['extraction', 'chunking', 'enrichment', 'embedding', 'knowledge-graph', 'multimodal'],
      required: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    providerConfig: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    onError: {
      type: String,
      enum: ['fail', 'continue'],
      required: true,
      default: 'fail',
    },
    fallbackProvider: {
      type: String,
      trim: true,
      required: false,
    },
    fallbackConfig: {
      type: Schema.Types.Mixed,
      required: false,
    },
    executionCondition: {
      type: String,
      trim: true,
      required: false,
    },
    requiredProviderVersion: {
      type: String,
      trim: true,
      required: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    estimatedDuration: {
      type: Number,
      min: 0,
      required: false,
    },
    estimatedCost: {
      type: Number,
      min: 0,
      required: false,
    },
  },
  {
    _id: false, // Don't create separate _id for subdocuments
  },
);
```

### Field Descriptions

| Field                     | Type   | Required | Description                                                                  |
| ------------------------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `id`                      | string | Yes      | Stage identifier (unique within flow)                                        |
| `name`                    | string | Yes      | Stage name (1-200 chars)                                                     |
| `type`                    | enum   | Yes      | Stage type (extraction, chunking, enrichment, embedding, kg, multimodal)     |
| `provider`                | string | Yes      | Provider ID (e.g., 'docling', 'openai')                                      |
| `providerConfig`          | object | Yes      | Provider-specific configuration (default: {})                                |
| `onError`                 | enum   | Yes      | Error handling: 'fail' (fail flow) or 'continue' (skip stage, default: fail) |
| `fallbackProvider`        | string | No       | Fallback provider ID (if primary fails)                                      |
| `fallbackConfig`          | object | No       | Fallback provider configuration                                              |
| `executionCondition`      | string | No       | CEL expression for conditional execution                                     |
| `requiredProviderVersion` | string | No       | Required provider version (semver, e.g., "^1.2.0")                           |
| `description`             | string | No       | Stage description (max 1000 chars)                                           |
| `estimatedDuration`       | number | No       | Estimated duration in ms (for UI cost preview)                               |
| `estimatedCost`           | number | No       | Estimated cost in USD (for UI cost preview)                                  |

### Constraints

1. **Stage ID unique:** Within parent PipelineFlow
2. **Provider exists:** Validated by application (provider registry lookup)
3. **Provider config valid:** Validated against provider's JSON Schema
4. **Fallback provider different:** `fallbackProvider !== provider` (if provided)

---

## RuleCondition Model

### TypeScript Interface

```typescript
export type RuleConditionType = 'simple' | 'compound' | 'cel';

export interface IRuleCondition {
  type: RuleConditionType;
  description?: string;

  // Simple condition (field operator value)
  field?: string; // e.g., 'doc.contentType', 'doc.fileSize'
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches' | 'in';
  value?: unknown; // string, number, boolean, array

  // Compound condition (AND/OR logic)
  logic?: 'AND' | 'OR';
  conditions?: IRuleCondition[];

  // CEL expression (most flexible)
  celExpression?: string; // e.g., "doc.contentType == 'application/pdf' && doc.fileSize > 1000000"
}
```

### Mongoose Subdocument Schema

```typescript
// Recursive schema (conditions can contain conditions)
const RuleConditionSchema: Schema = new Schema<IRuleCondition>(
  {
    type: {
      type: String,
      enum: ['simple', 'compound', 'cel'],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    // Simple condition fields
    field: {
      type: String,
      trim: true,
      required: function (this: IRuleCondition) {
        return this.type === 'simple';
      },
    },
    operator: {
      type: String,
      enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'matches', 'in'],
      required: function (this: IRuleCondition) {
        return this.type === 'simple';
      },
    },
    value: {
      type: Schema.Types.Mixed,
      required: function (this: IRuleCondition) {
        return this.type === 'simple';
      },
    },
    // Compound condition fields
    logic: {
      type: String,
      enum: ['AND', 'OR'],
      required: function (this: IRuleCondition) {
        return this.type === 'compound';
      },
    },
    conditions: {
      type: [this], // Recursive reference
      required: function (this: IRuleCondition) {
        return this.type === 'compound';
      },
    },
    // CEL expression field
    celExpression: {
      type: String,
      trim: true,
      required: function (this: IRuleCondition) {
        return this.type === 'cel';
      },
    },
  },
  {
    _id: false,
  },
);
```

### Field Descriptions

| Field           | Type             | Required                 | Description                                       |
| --------------- | ---------------- | ------------------------ | ------------------------------------------------- |
| `type`          | enum             | Yes                      | Rule type: 'simple', 'compound', 'cel'            |
| `description`   | string           | No                       | Rule description (max 500 chars)                  |
| `field`         | string           | Yes (if type='simple')   | Field path (e.g., 'doc.contentType')              |
| `operator`      | enum             | Yes (if type='simple')   | Comparison operator                               |
| `value`         | unknown          | Yes (if type='simple')   | Comparison value                                  |
| `logic`         | enum             | Yes (if type='compound') | Logical operator: 'AND' or 'OR'                   |
| `conditions`    | IRuleCondition[] | Yes (if type='compound') | Nested conditions                                 |
| `celExpression` | string           | Yes (if type='cel')      | CEL expression (e.g., "doc.contentType == 'pdf'") |

### Examples

**Simple condition:**

```json
{
  "type": "simple",
  "field": "doc.contentType",
  "operator": "eq",
  "value": "application/pdf",
  "description": "PDF documents"
}
```

**Compound condition (AND):**

```json
{
  "type": "compound",
  "logic": "AND",
  "conditions": [
    {
      "type": "simple",
      "field": "doc.contentType",
      "operator": "eq",
      "value": "application/pdf"
    },
    {
      "type": "simple",
      "field": "doc.fileSize",
      "operator": "gt",
      "value": 10000000
    }
  ],
  "description": "Large PDFs (>10MB)"
}
```

**CEL expression:**

```json
{
  "type": "cel",
  "celExpression": "doc.contentType == 'application/pdf' && doc.fileSize > 10000000",
  "description": "Large PDFs (>10MB)"
}
```

---

## Supporting Types

### ValidationError

```typescript
export interface IValidationError {
  code: string; // Error code (e.g., 'MISSING_PROVIDER', 'INVALID_CEL_EXPRESSION')
  message: string; // Human-readable error message
  severity: 'error' | 'warning' | 'info';
  path: string; // JSONPath to the invalid field (e.g., 'flows[0].stages[1].provider')
  context?: Record<string, unknown>; // Additional context (e.g., { providerId: 'invalid-provider' })
}
```

---

## Indexes

### PipelineDefinition Indexes

```typescript
// 1. Unique index: One pipeline per KB
PipelineDefinitionSchema.index({ tenantId: 1, knowledgeBaseId: 1 }, { unique: true });

// 2. Tenant + status (for listing pipelines)
PipelineDefinitionSchema.index({ tenantId: 1, status: 1 });

// 3. Tenant + flow ID (for flow-specific queries)
PipelineDefinitionSchema.index({ tenantId: 1, 'flows.id': 1 });

// 4. Tenant + updated timestamp (for recent pipelines)
PipelineDefinitionSchema.index({ tenantId: 1, updatedAt: -1 });
```

### Query Patterns

```typescript
// Find pipeline by KB ID
await PipelineDefinition.findOne({ tenantId, knowledgeBaseId });

// List all active pipelines for tenant
await PipelineDefinition.find({ tenantId, status: 'active' }).sort({ updatedAt: -1 });

// Find pipeline with specific flow ID
await PipelineDefinition.findOne({ tenantId, 'flows.id': flowId });
```

---

## Validation Rules

### Application-Level Validation

**Beyond Mongoose schema validation, the application must validate:**

1. **Flow ID uniqueness within pipeline**
   - All `flows[].id` must be unique

2. **Stage ID uniqueness within flow**
   - All `stages[].id` must be unique within each flow

3. **Priority uniqueness** (recommended)
   - All `flows[].priority` should be unique (warn if duplicates)

4. **Provider existence**
   - All `provider` and `fallbackProvider` must exist in provider registry

5. **Provider config validation**
   - Validate `providerConfig` against provider's JSON Schema

6. **CEL expression validation**
   - Validate all `celExpression` and `executionCondition` using CEL library

7. **Circular flow references**
   - Ensure no circular dependencies in stage sequences

8. **At least one enabled flow**
   - Pipeline must have at least one `enabled: true` flow

9. **Default/fallback flow**
   - Recommend having one flow with no `selectionRules` (catches all unmatched docs)

10. **Stage sequence validation**
    - Extraction before chunking (if both present)
    - Chunking before embedding (if both present)
    - No duplicate stage types of same kind (warn)

**Implementation:**

```typescript
function validateStageSequence(stages: IPipelineStage[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const typeIndexMap = new Map<string, number>();

  stages.forEach((stage, index) => {
    typeIndexMap.set(stage.type, index);
  });

  // Rule 1: Extraction must come before chunking
  const extractionIndex = typeIndexMap.get('extraction');
  const chunkingIndex = typeIndexMap.get('chunking');
  if (
    extractionIndex !== undefined &&
    chunkingIndex !== undefined &&
    extractionIndex > chunkingIndex
  ) {
    errors.push({
      code: 'INVALID_STAGE_SEQUENCE',
      message: 'Extraction stage must come before chunking stage',
      severity: 'error',
      path: `stages[${chunkingIndex}]`,
    });
  }

  // Rule 2: Chunking must come before embedding
  const embeddingIndex = typeIndexMap.get('embedding');
  if (
    chunkingIndex !== undefined &&
    embeddingIndex !== undefined &&
    chunkingIndex > embeddingIndex
  ) {
    errors.push({
      code: 'INVALID_STAGE_SEQUENCE',
      message: 'Chunking stage must come before embedding stage',
      severity: 'error',
      path: `stages[${embeddingIndex}]`,
    });
  }

  // Rule 3: Warn on duplicate stage types (same provider is OK)
  const typeCounts = new Map<string, number>();
  stages.forEach((stage) => {
    typeCounts.set(stage.type, (typeCounts.get(stage.type) || 0) + 1);
  });

  typeCounts.forEach((count, type) => {
    if (count > 1) {
      errors.push({
        code: 'DUPLICATE_STAGE_TYPE',
        message: `Multiple stages of type '${type}' found (${count}). This may be intentional but should be reviewed.`,
        severity: 'warning',
        path: 'stages',
      });
    }
  });

  return errors;
}
```

11. **Flow count limit**
    - Maximum 50 flows per pipeline (performance limit)
    - Prevents excessive document size and routing overhead

### Zod Schema (Request Validation)

```typescript
import { z } from 'zod';

const RuleConditionSchema: z.ZodType<IRuleCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('simple'),
      field: z.string(),
      operator: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'matches', 'in']),
      value: z.unknown(),
      description: z.string().optional(),
    }),
    z.object({
      type: z.literal('compound'),
      logic: z.enum(['AND', 'OR']),
      conditions: z.array(RuleConditionSchema),
      description: z.string().optional(),
    }),
    z.object({
      type: z.literal('cel'),
      celExpression: z.string().min(1),
      description: z.string().optional(),
    }),
  ]),
);

const PipelineStageSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  type: z.enum([
    'extraction',
    'chunking',
    'enrichment',
    'embedding',
    'knowledge-graph',
    'multimodal',
  ]),
  provider: z.string(),
  providerConfig: z.record(z.unknown()),
  onError: z.enum(['fail', 'continue']).default('fail'),
  fallbackProvider: z.string().optional(),
  fallbackConfig: z.record(z.unknown()).optional(),
  executionCondition: z.string().optional(),
  requiredProviderVersion: z.string().optional(),
  description: z.string().max(1000).optional(),
  estimatedDuration: z.number().min(0).optional(),
  estimatedCost: z.number().min(0).optional(),
});

const PipelineFlowSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  selectionRules: z.array(RuleConditionSchema).optional(),
  priority: z.number().min(1).max(100),
  stages: z.array(PipelineStageSchema).min(1),
  customEnrichment: z.array(PipelineStageSchema).optional(),
  customIndexing: z.array(PipelineStageSchema).optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});

export const CreatePipelineDefinitionSchema = z.object({
  knowledgeBaseId: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  flows: z.array(PipelineFlowSchema).min(1),
  sharedStages: z
    .object({
      enrichment: z.array(PipelineStageSchema).optional(),
      indexing: z.array(PipelineStageSchema).min(1).optional(),
    })
    .optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});

export const UpdatePipelineDefinitionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  flows: z.array(PipelineFlowSchema).min(1).optional(),
  sharedStages: z
    .object({
      enrichment: z.array(PipelineStageSchema).optional(),
      indexing: z.array(PipelineStageSchema).min(1).optional(),
    })
    .optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});
```

---

## Migration Strategy

### From Legacy Pipeline

**Legacy System:**

- Single hardcoded pipeline in `apps/search-ai/src/workers/`
- MIME type routing in code
- No user customization

**Migration Approach:**

1. **Default pipeline creation (auto-migration)**
   - When KB is created or upgraded, create default PipelineDefinition
   - 4 default flows (PDF, Image, Plain Text, Fallback)
   - Status: 'active'

2. **Background migration script**
   - Find all existing KBs without pipeline
   - Create default pipeline for each
   - Log migration results

3. **Dual-mode operation (transition period)**
   - Check if KB has pipeline
   - If yes: Use pipeline system
   - If no: Use legacy system + create default pipeline

4. **Legacy code removal (after migration)**
   - Remove hardcoded pipeline logic
   - Remove MIME type routing code

### Migration Script

```typescript
export async function migrateLegacyPipelines() {
  const kbs = await KnowledgeBase.find({ 'pipeline._id': { $exists: false } });

  for (const kb of kbs) {
    const defaultPipeline = await createDefaultPipeline(kb.tenantId, kb._id.toString());

    console.log(`Created default pipeline for KB ${kb._id}: ${defaultPipeline._id}`);
  }

  console.log(`Migrated ${kbs.length} knowledge bases`);
}
```

---

## Example Documents

### Complete Pipeline Definition

```json
{
  "_id": "65f1a3b4c8d9e2f0a1b2c3d4",
  "tenantId": "tenant-123",
  "knowledgeBaseId": "kb-456",
  "name": "Medical Documents Processing",
  "description": "Pipeline for processing medical records with HIPAA compliance",
  "version": 1,
  "status": "active",
  "flows": [
    {
      "id": "flow-pdf-hipaa",
      "name": "PDF Medical Records",
      "description": "Process PDF medical records with encryption",
      "enabled": true,
      "priority": 90,
      "selectionRules": [
        {
          "type": "compound",
          "logic": "AND",
          "conditions": [
            {
              "type": "simple",
              "field": "doc.contentType",
              "operator": "eq",
              "value": "application/pdf"
            },
            {
              "type": "simple",
              "field": "doc.metadata.documentType",
              "operator": "eq",
              "value": "medical_record"
            }
          ]
        }
      ],
      "stages": [
        {
          "id": "stage-extract-1",
          "name": "Docling Extraction",
          "type": "extraction",
          "provider": "docling",
          "providerConfig": {
            "extractTables": true,
            "extractImages": false,
            "preserveLayout": true
          },
          "onError": "fail",
          "fallbackProvider": "llamaindex",
          "fallbackConfig": {
            "chunkSize": 512
          }
        },
        {
          "id": "stage-chunk-1",
          "name": "Semantic Chunking",
          "type": "chunking",
          "provider": "tree-builder",
          "providerConfig": {
            "targetChunkSize": 512,
            "minChunkSize": 100,
            "maxChunkSize": 1024
          },
          "onError": "fail"
        },
        {
          "id": "stage-embed-1",
          "name": "Generate Embeddings",
          "type": "embedding",
          "provider": "openai",
          "providerConfig": {
            "model": "text-embedding-3-small",
            "dimensions": 1536
          },
          "onError": "fail",
          "fallbackProvider": "bge-m3",
          "fallbackConfig": {
            "dimensions": 1024
          }
        }
      ],
      "customEnrichment": [
        {
          "id": "stage-enrich-1",
          "name": "HIPAA-Compliant Entity Extraction",
          "type": "enrichment",
          "provider": "anthropic",
          "providerConfig": {
            "model": "claude-3-sonnet-20240229",
            "useCase": "entityExtraction",
            "temperature": 0
          },
          "onError": "continue",
          "description": "Extract medical entities with HIPAA-compliant provider"
        }
      ]
    },
    {
      "id": "flow-default",
      "name": "Default Fallback",
      "description": "Catches all unmatched documents",
      "enabled": true,
      "priority": 1,
      "selectionRules": [],
      "stages": [
        {
          "id": "stage-extract-default",
          "name": "Default Extraction",
          "type": "extraction",
          "provider": "docling",
          "providerConfig": {},
          "onError": "fail"
        },
        {
          "id": "stage-chunk-default",
          "name": "Default Chunking",
          "type": "chunking",
          "provider": "token-based",
          "providerConfig": {
            "chunkSize": 512,
            "overlap": 50
          },
          "onError": "fail"
        },
        {
          "id": "stage-embed-default",
          "name": "Default Embedding",
          "type": "embedding",
          "provider": "bge-m3",
          "providerConfig": {
            "dimensions": 1024
          },
          "onError": "fail"
        }
      ]
    }
  ],
  "sharedStages": {
    "enrichment": [
      {
        "id": "shared-enrich-1",
        "name": "Progressive Summarization",
        "type": "enrichment",
        "provider": "openai",
        "providerConfig": {
          "model": "gpt-4",
          "useCase": "progressiveSummarization",
          "temperature": 0
        },
        "onError": "continue"
      }
    ],
    "indexing": [
      {
        "id": "shared-index-1",
        "name": "OpenSearch Indexing",
        "type": "embedding",
        "provider": "opensearch",
        "providerConfig": {
          "indexName": "kb-456"
        },
        "onError": "fail"
      }
    ]
  },
  "providerDefaults": {
    "openai": {
      "temperature": 0,
      "maxTokens": 4096
    },
    "docling": {
      "timeout": 120000
    }
  },
  "createdBy": "user-789",
  "createdAt": "2026-03-07T10:00:00Z",
  "updatedAt": "2026-03-07T10:00:00Z",
  "lastDeployedAt": "2026-03-07T10:05:00Z",
  "validationStatus": "valid",
  "lastValidatedAt": "2026-03-07T10:04:00Z"
}
```

---

## Summary

This document specifies the complete data models for the flow-based pipeline system:

✅ **PipelineDefinition** - Main model with embedded flows
✅ **PipelineFlow** - Nested subdocument with stages
✅ **PipelineStage** - Stage configuration with provider settings
✅ **RuleCondition** - Recursive selection rules

**Key Design Decisions:**

1. **Single-document model** - All flows embedded (no joins, atomic updates)
2. **Tenant isolation** - All queries include `tenantId`
3. **Version control** - Auto-increment on updates
4. **Flexible validation** - Mongoose + Zod + application-level
5. **Optimized indexes** - For common query patterns

**Next Steps:**

- Task #40: Flow selection service implementation
- Task #41: Provider registry implementation
- Task #42: BullMQ Flows integration (FlowBuilder)
