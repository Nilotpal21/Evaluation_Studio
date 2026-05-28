---
name: search-ai-pipelines
description: Specialized skill for SearchAI pluggable pipeline development. Use when working on flow-based pipelines, pipeline stages, circuit breakers, provider registry, or flow selection. Covers design review, code changes during development, building new stages/providers, finding bugs, and enhancements.
---

# SearchAI Pluggable Pipelines Development

**Domain:** Flow-Based Pipeline Architecture for SearchAI Ingestion
**Version:** 2.0.0 (2026-03-11) — Synced with actual codebase
**Status:** Active Development

## When to Use This Skill

Use this skill when:

- Building or modifying flow-based pipeline features
- Adding new pipeline stages or providers (extraction, chunking, enrichment, embedding, stores, etc.)
- Implementing flow selection rules (simple, compound, CEL expressions)
- Working on circuit breaker implementation
- Reviewing pipeline code changes or designs
- Debugging pipeline execution, flow selection, or reindexing issues
- Working on the provider registry (adapters, new provider types)
- Working on the 4-checkpoint reindexing system

**Do NOT use for:**

- Legacy single-pipeline implementation (use `search-ai-development` skill)
- General SearchAI worker patterns (use `search-ai-development` skill)
- Agent architecture design (use `abl-architect` skill)
- Query pipeline / search (use `search-ai-query-engineer` skill)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Models](#data-models)
3. [Key Code Locations](#key-code-locations)
4. [Frontend UX Patterns](#frontend-ux-patterns)
5. [Backend Implementation Patterns](#backend-implementation-patterns)
6. [Design Review Checklist](#design-review-checklist)
7. [Adding New Stages and Providers](#adding-new-stages-and-providers)
8. [Debugging Guide](#debugging-guide)
9. [Anti-Patterns](#anti-patterns)
10. [Implementation Status](#implementation-status)

---

## Architecture Overview

### Core Concept: Flow-Based Pipelines

**Multiple flows per knowledge base**, each with:

- **Selection rules** (simple, compound, or CEL expressions) for flow routing
- **Stages** (ordered: extraction → chunking → enrichment → embedding)
- **Configuration** per stage (provider-specific settings)
- **Pipeline-level embedding config** shared by ALL flows

**Key Innovation:** One knowledge base can have multiple flows (e.g., PDF flow, DOCX flow, fallback flow) selected at runtime based on document properties. The 4-checkpoint reindexing system ensures minimal work when configuration changes.

### 4-Stage Pipeline

```
Extraction → Chunking → Enrichment → Embedding
(raw file    (text to    (add LLM     (generate
 to text)    chunks)     metadata)    vectors)
```

- Extraction + Chunking: `onError: "fail"` (document unusable without text)
- Enrichment: `onError: "continue"` (metadata is nice-to-have)
- Embedding: Pipeline-level `activeEmbeddingConfig` shared by all flows
- Stage types in schema: `extraction | chunking | enrichment | embedding | multimodal`
- Visual processing: vision + multimodal workers run post-enrichment (standalone, not in flow builder yet)
- LLM features: per-index config via Settings tab, tier-based model auto-selection with fallback

### Storage

- **MongoDB:** `search_pipeline_definitions` (config), `job_executions` (tracking)
- **Redis:** BullMQ Flows (orchestration), circuit breaker state (per-tenant, per-provider)

> For full narrative walkthrough and ASCII diagrams, see:
>
> - `docs/searchai/design/INGESTION-PIPELINE-GUIDE.md`
> - `docs/searchai/design/INGESTION-PIPELINE-DIAGRAMS.md`

### Reference Documents

**Guides** (Start here — narrative explanations):

- `docs/searchai/design/INGESTION-PIPELINE-GUIDE.md` — Scene-by-scene walkthrough (LegalMind use case, all 4 stages, flow selection, providers, reindexing, circuit breakers, implementation status appendix)
- `docs/searchai/design/INGESTION-PIPELINE-DIAGRAMS.md` — 10 ASCII diagrams: class, sequence, state, component

**Design Documents** (Implementation-ready):

- `docs/searchai/pipelines/design/backend/01-DATA-MODELS.md` — Mongoose schemas, validation, indexes
- `docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md` — TTL index, 90-day retention
- `docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md` — Provider-level circuit breakers
- `docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md` — React Flow UI, API specs

**RFCs** (Architecture decisions):

- `docs/searchai/pipelines/rfcs/RFC-004-FLOW-BASED-ARCHITECTURE.md` — Main architecture RFC
- `docs/searchai/pipelines/rfcs/RFC-005-Job-Tracking-Architecture.md` — Job execution tracking
- `docs/searchai/pipelines/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md` — BullMQ integration

**Status**:

- `docs/searchai/pipelines/DESIGN-REVIEW-SUMMARY.md` — Architectural review (all issues fixed)

---

## Key Code Locations

### Backend (apps/search-ai)

| Component            | Path                                                                              | Description                       |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| Pipeline model       | `packages/database/src/models/search-pipeline-definition.model.ts`                | Mongoose schema + all interfaces  |
| Job model            | `packages/database/src/models/job-execution.model.ts`                             | Flat job tracking                 |
| Provider registry    | `apps/search-ai/src/services/provider-registry/provider-registry.ts`              | Singleton, two-level Map          |
| Provider types       | `apps/search-ai/src/services/provider-registry/types.ts`                          | `PipelineStageProvider` interface |
| Circuit breaker      | `apps/search-ai/src/services/provider-registry/circuit-breaker-registry.ts`       | Per-provider thresholds           |
| Embedding providers  | `apps/search-ai/src/services/provider-registry/embedding-providers.ts`            | BGE-M3, OpenAI, Cohere, Custom    |
| Flow selection       | `apps/search-ai/src/services/flow-selection/flow-selection.service.ts`            | Priority-based, 3 rule types      |
| Flow builder         | `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`              | BullMQ Flow creation              |
| Default template     | `apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts` | Default pipeline config           |
| Change identifier    | `apps/search-ai/src/services/reindexing/change-identifier.ts`                     | Pipeline diff                     |
| Reindex router       | `apps/search-ai/src/services/reindexing/reindex-router.ts`                        | 4-checkpoint routing              |
| Reindex orchestrator | `apps/search-ai/src/services/reindexing/reindex-orchestrator.ts`                  | Checkpoint execution              |
| Pipeline routes      | `apps/search-ai/src/routes/pipeline-triggers.ts`                                  | Trigger pipeline execution        |

### Frontend (apps/studio)

| Component        | Path                                                                        | Description                     |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------- |
| Pipeline store   | `apps/studio/src/store/pipeline-store.ts`                                   | Zustand store (draft/published) |
| Pipeline API     | `apps/studio/src/api/pipelines.ts`                                          | API client functions            |
| Pipeline editor  | `apps/studio/src/components/search-ai/pipelines/PipelineEditor.tsx`         | Main editor container           |
| Flows list       | `apps/studio/src/components/search-ai/pipelines/FlowsList.tsx`              | Sidebar flow cards              |
| Stage config     | `apps/studio/src/components/search-ai/pipelines/StageConfigPanel.tsx`       | Provider selector + config      |
| Embedding config | `apps/studio/src/components/search-ai/pipelines/EmbeddingConfigSection.tsx` | Pipeline-level embedding        |
| Change embedding | `apps/studio/src/components/search-ai/pipelines/ChangeEmbeddingDialog.tsx`  | Provider switching dialog       |
| Publish dialog   | `apps/studio/src/components/search-ai/pipelines/PublishConfirmDialog.tsx`   | Publish + reindex confirmation  |
| Test selection   | `apps/studio/src/components/search-ai/pipelines/TestSelectionModal.tsx`     | Flow selection preview          |

---

## Data Models

### SearchPipelineDefinition Schema (Actual)

**Single-document model** with embedded flows (no joins).
**Model:** `packages/database/src/models/search-pipeline-definition.model.ts`
**Collection:** `search_pipeline_definitions`

```typescript
interface ISearchPipelineDefinition {
  _id: ObjectId;
  tenantId: string; // Tenant isolation
  knowledgeBaseId: string; // One pipeline per knowledge base
  name: string;
  description?: string;
  createdBy: string;

  flows: ISearchPipelineFlow[]; // 1-50 embedded flows
  activeEmbeddingConfig: IActiveEmbeddingConfig; // Pipeline-level (ALL flows share)
  sharedStages?: { enrichment?: ISearchPipelineStage[]; indexing?: ISearchPipelineStage[] };

  version: number; // Auto-increments on save
  status: 'draft' | 'active' | 'archived';
  validationStatus?: 'valid' | 'invalid' | 'pending';
  validationErrors?: ISearchValidationError[];
  previousVersion?: any; // Snapshot for reindex diff
  providerDefaults?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

interface ISearchPipelineFlow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean; // NOT "isActive"
  priority: number; // 1-100, HIGHER = evaluated FIRST
  isDefault: boolean;

  selectionRules?: ISearchRuleCondition[]; // NOT "preRules"
  stages: ISearchPipelineStage[]; // Ordered stages
  providerDefaults?: Record<string, any>;
}

interface ISearchPipelineStage {
  id: string;
  name: string;
  type: 'extraction' | 'chunking' | 'enrichment' | 'embedding' | 'multimodal';
  provider: string; // NOT "providerId" — field is "provider"
  providerConfig: any; // NOT "config"
  onError: 'fail' | 'continue'; // NOT "isRequired"
  fallbackProvider?: string;
  fallbackConfig?: any;
  description?: string;
  executionCondition?: string;
  estimatedDuration?: number;
  estimatedCost?: number;
}

interface IActiveEmbeddingConfig {
  provider: 'openai' | 'cohere' | 'bge-m3' | 'custom';
  model: string;
  dimensions: number; // min: 1
  providerConfig?: any;
}

// Three rule types (discriminated union)
interface ISearchRuleCondition {
  type: 'simple' | 'compound' | 'cel';
  // simple:
  field?: string; // 'document.extension', 'source.connector'
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches' | 'in';
  value?: any;
  // compound:
  logic?: 'AND' | 'OR';
  conditions?: ISearchRuleCondition[]; // Recursive
  // cel:
  celExpression?: string;
}
```

**CRITICAL field name differences from old RFC:**

| Old RFC / Skill v1      | Actual Code                                 | Notes                   |
| ----------------------- | ------------------------------------------- | ----------------------- |
| `isDraft`               | `status: 'draft' \| 'active' \| 'archived'` | Three-state lifecycle   |
| `isActive` (flow)       | `enabled`                                   | Boolean enable/disable  |
| `preRules`              | `selectionRules`                            | Renamed                 |
| `providerId`            | `provider`                                  | Stage field name        |
| `config`                | `providerConfig`                            | Stage field name        |
| `isRequired`            | `onError: 'fail' \| 'continue'`             | Error handling strategy |
| `priority` lower=higher | `priority` HIGHER=evaluated FIRST           | Reversed from RFC       |

**Key Constraints:**

- `flows.length`: 1-50 (array validator)
- Each flow must have >= 1 stage
- Unique index: `(tenantId, knowledgeBaseId)`
- At least one `enabled` flow required (pre-save hook)
- Embedding is pipeline-level, not per-flow

### JobExecution Schema

**Flat schema** for tracking individual stage executions.
**Model:** `packages/database/src/models/job-execution.model.ts`
**Collection:** `job_executions`

```typescript
interface IJobExecution {
  _id: ObjectId;
  tenantId: string;
  bullJobId: string;
  workerStage: WorkerStage; // 'docling-extraction', 'enrichment', etc.

  documentId: string;
  sourceId: string;
  indexId: string;

  pipelineId?: string; // BullMQ Flows context
  pipelineVersion?: number;
  flowJobId?: string;

  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  duration?: number;

  metrics?: Record<string, unknown>;
  error?: IJobExecutionError;
  traceId?: string;

  createdAt: Date; // TTL index: 90 days
  updatedAt: Date;
}
```

**Retention:** TTL index deletes after 90 days (prevents 730GB/year growth).

---

## Frontend UX Patterns

### Component Hierarchy

```
PipelineConfigPage (Route: /knowledge-bases/:id/pipeline)
  ├─ PipelineEditor (Main container)
  │   ├─ PipelineHeader (Name, version, publish button)
  │   ├─ FlowsList (Sidebar)
  │   │   └─ FlowCard[] (Reorderable, expandable)
  │   ├─ FlowCanvas (React Flow)
  │   │   ├─ StageNode[] (Custom nodes)
  │   │   └─ StageEdge[] (Connections)
  │   └─ StageConfigPanel (Slide-over)
  │       ├─ ProviderSelector (Dropdown)
  │       ├─ ConfigForm (Dynamic fields)
  │       └─ ValidationMessages (Errors/warnings)
  ├─ RuleBuilder (Modal)
  │   ├─ RuleList (Multiple conditions)
  │   └─ RuleRow (Field, operator, value)
  └─ TestSelectionModal (Flow selection preview)
      ├─ TestInput (Document properties)
      └─ FlowMatchResult (Which flow matched)
```

### State Management (Zustand)

**File:** `apps/studio/src/store/pipeline-store.ts`

```typescript
interface PipelineStore {
  // State
  draft: PipelineDefinition | null;
  published: PipelineDefinition | null;
  selectedFlowId: string | null;
  selectedStageId: string | null;
  isDirty: boolean;
  isLoading: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  validationErrors: ValidationError[];

  // Context
  projectId: string | null;
  knowledgeBaseId: string | null;

  // Panel state
  stageConfigOpen: boolean;
  ruleBuilderOpen: boolean;
  testSelectionOpen: boolean;

  // Actions - Loading
  loadPipeline: (projectId: string, kbId: string) => Promise<void>;

  // Actions - Draft editing
  updateFlow: (flowId: string, updates: Partial<PipelineFlow>) => void;
  addFlow: (flow: PipelineFlow) => void;
  removeFlow: (flowId: string) => void;
  addStage: (flowId: string, stage: PipelineStage) => void;
  updateStage: (flowId: string, stageId: string, updates: Partial<PipelineStage>) => void;
  removeStage: (flowId: string, stageId: string) => void;

  // Actions - Save/Publish
  saveDraft: () => Promise<void>;
  publish: () => Promise<void>;
  validate: () => Promise<ValidationResult | null>;

  // Embedding configuration
  embeddingProviders: EmbeddingProviderInfo[] | null;
  embeddingDialogOpen: boolean;
  openEmbeddingDialog: () => Promise<void>;
  changeEmbeddingConfig: (config: {
    provider: string;
    model: string;
    dimensions: number;
    providerConfig?: Record<string, unknown>;
  }) => Promise<void>;

  // Reindex
  reindexPending: PublishResult['reindex'] | null;
  reindexBatchId: string | null;
  confirmReindex: () => Promise<void>;
  dismissReindex: () => void;
}
```

**Key Patterns:**

- Separate `draft` and `published` state. All edits go to `draft`, only `publish()` commits.
- `loadPipeline(projectId, kbId)` requires both IDs (not just kbId).
- Embedding config changes go through `changeEmbeddingConfig` (triggers reindex analysis).
- Publish returns reindex analysis; user confirms via `confirmReindex()`.

### API Endpoints

| Method | Endpoint                                                                      | Purpose              | Permission              |
| ------ | ----------------------------------------------------------------------------- | -------------------- | ----------------------- |
| GET    | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines`                    | Get pipeline         | `knowledge-base:read`   |
| PATCH  | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id`                | Update draft         | `knowledge-base:update` |
| POST   | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/publish`        | Publish              | `knowledge-base:update` |
| POST   | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate`           | Validate config      | `knowledge-base:read`   |
| POST   | `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/test-selection` | Test flow selection  | `knowledge-base:read`   |
| GET    | `/api/projects/:projectId/pipelines/providers/:stageType/schemas`             | Get provider schemas | `project:read`          |

**Auth:** Bearer token + `requireProjectPermission()` middleware.

**File:** `docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md` (Section 4: API Specifications)

---

## Backend Implementation Patterns

### Circuit Breaker Pattern

**Scope:** Provider-level circuit breakers, per-tenant isolation.
**File:** `apps/search-ai/src/services/provider-registry/circuit-breaker-registry.ts`
**Package:** `@agent-platform/circuit-breaker` (`RedisCircuitBreaker`)

The `ProviderRegistryWithCircuitBreaker` wraps `ProviderRegistry` with per-provider circuit breakers stored in Redis. Key format: `tenantId:providerId`. Max 500 breaker instances with LRU eviction.

```typescript
// Usage
const registry = new ProviderRegistryWithCircuitBreaker(redis);

const result = await registry.executeWithProtection({
  tenantId: 'tenant-123',
  stageType: 'extraction',
  providerId: 'docling',
  input: documentBuffer,
  config: { model: 'v2' },
  fallbackProviders: ['llamaindex'], // Tried in order if primary fails
});

// Result
result.success; // boolean
result.output; // TOutput if success
result.providerId; // Which provider actually ran
result.usedFallback; // Was a fallback used?
result.circuitOpen; // Was the circuit open?
```

**Per-Provider Thresholds (from actual code):**

| Provider | Failure Threshold | Success Threshold | Cooldown (resetTimeout) |
| -------- | ----------------- | ----------------- | ----------------------- |
| Docling  | 10 failures       | 5 successes       | 120s                    |
| OpenAI   | 3 failures        | 2 successes       | 60s                     |
| BGE-M3   | 5 failures        | 3 successes       | 90s                     |
| Default  | 5 failures        | 2 successes       | 60s                     |

### Flow Selection Service

**File:** `apps/search-ai/src/services/flow-selection/flow-selection.service.ts` (implemented)
**Algorithm:** Priority-based evaluation (HIGHER priority = evaluated FIRST).

```typescript
// Usage
const service = new FlowSelectionService();
const result = await service.selectFlow(pipeline.flows, {
  document: { extension: 'pdf', mimeType: 'application/pdf', size: 1048576, name: 'doc.pdf' },
  source: { connector: 'google-drive' },
});

if (result.success) {
  console.log('Selected flow:', result.flow.name);
  console.log('Evaluated:', result.details.flowsEvaluated, 'flows');
}
```

**Algorithm:**

1. Filter `enabled` flows (NOT `isActive`)
2. Sort by `priority` descending (higher number first)
3. Evaluate `selectionRules` (NOT `preRules`) — supports `simple`, `compound`, `cel` types
4. Return first match (AND logic within a flow's rules)
5. No-rules flow = always matches (catch-all)
6. Fail-safe: if rule evaluation errors, skip to next flow

**Context Structure:**

```typescript
interface FlowContext {
  document: {
    extension: string;
    mimeType: string;
    size: number;
    name: string;
  };
  source: {
    connector: string;
  };
  [key: string]: unknown; // Extensible for CEL
}
```

**CEL:** Uses `@marcbachmann/cel-js` with 5s timeout. Tests are implemented but being enabled (Task #15).

### BullMQ Flows Integration

**Pattern:** Flow orchestration in Redis, instrumentation in MongoDB.

```typescript
export class PipelineFlowBuilder {
  buildFlow(
    pipeline: IPipelineDefinition,
    flow: IPipelineFlow,
    document: ISearchDocument,
  ): FlowJob {
    const children: FlowChildJob[] = [];

    for (const stage of flow.stages) {
      children.push({
        name: `${stage.type}:${document._id}`,
        queueName: this.getQueueForStage(stage.type),
        data: {
          documentId: document._id,
          indexId: document.indexId,
          sourceId: document.sourceId,
          tenantId: document.tenantId,
          stageConfig: stage.config,
          providerId: stage.providerId,
          // BullMQ Flows context (RFC-006)
          pipelineId: pipeline._id,
          pipelineVersion: pipeline.version,
        },
        opts: {
          ...FLOW_CHILD_DEFAULTS,
          jobId: `${stage.type}:${document.indexId}:${document._id}`,
        },
      });
    }

    return {
      name: `pipeline:${document._id}`,
      queueName: 'pipeline-orchestration',
      children,
      opts: {
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    };
  }
}

const FLOW_CHILD_DEFAULTS = {
  failParentOnFailure: true,
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400, count: 1000 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};
```

**CRITICAL:** Always set `failParentOnFailure: true` on every child (BullMQ waits forever otherwise).

**File:** See `bullmq-flows-guide` skill for full production patterns.

---

## Design Review Checklist

Use this checklist when reviewing pipeline code changes or designs.

### Security Review

- [ ] **Tenant Isolation:** All queries include `tenantId`
- [ ] **Credential Handling:** No credentials stored in pipeline config (use `credentialId` references)
- [ ] **Access Control:** All API routes use `requireProjectPermission()` middleware
- [ ] **Input Validation:** All user inputs validated with Zod schemas
- [ ] **CEL Expression Safety:** Timeout on CEL evaluation (5s max)

### Performance Review

- [ ] **Indexes:** All queries use indexes (check `explain()`)
- [ ] **Document Size:** Pipeline config stays under 16MB MongoDB limit
- [ ] **Flow Count Limit:** Validation ensures `flows.length <= 50`
- [ ] **Stage Sequence:** Validation enforces extraction → chunking → embedding order
- [ ] **TTL Index:** Job tracking has 90-day retention (prevents unbounded growth)

### Database Review

- [ ] **Consistency:** Schema matches existing patterns (ISearchDocument, IAgent)
- [ ] **Validation:** Dual-layer validation (Mongoose + Zod)
- [ ] **Indexes:** Compound indexes for common queries
- [ ] **Unique Constraints:** `(tenantId, knowledgeBaseId)` unique index

### Completeness Review

- [ ] **Error Handling:** All API endpoints return structured error responses
- [ ] **Logging:** All services use `createLogger('module')` from `@abl/compiler/platform`
- [ ] **Circuit Breaker:** Provider failures trigger fallback or graceful degradation
- [ ] **Migration:** Zero-downtime migration strategy documented
- [ ] **Monitoring:** CloudWatch metrics and alarms defined

### BullMQ Flows Review (CRITICAL)

- [ ] **Child Failure Options:** Every child has `failParentOnFailure: true`
- [ ] **Cleanup Options:** Every child has `removeOnComplete` and `removeOnFail`
- [ ] **Lock Duration:** Per-worker `lockDuration` set (not default 30s)
- [ ] **Backpressure:** Queue depth checks before adding flows
- [ ] **Validation:** FlowProducer.add() result validated (Issue #3851)

**Reference:** `docs/searchai/pipelines/DESIGN-REVIEW-SUMMARY.md`

---

## Adding New Stages and Providers

### Adding a New Provider to an Existing Stage

This is the most common enhancement — e.g., adding a new extraction provider, a store-as-stage provider, or a custom embedding endpoint.

**1. Implement the `PipelineStageProvider` interface**

```typescript
// File: apps/search-ai/src/services/provider-registry/my-provider.ts

import type { PipelineStageProvider, JSONSchema } from './types.js';
import type { SearchPipelineStageType } from '@agent-platform/database';

export class MyProvider implements PipelineStageProvider<MyInput, MyOutput, MyConfig> {
  id = 'my-provider';
  name = 'My Provider';
  type: SearchPipelineStageType = 'extraction'; // or chunking, enrichment, embedding
  version = '1.0.0';
  description = 'What this provider does';

  async execute(input: MyInput, config: MyConfig): Promise<MyOutput> {
    // Your implementation
    return {
      /* results */
    };
  }

  validateConfig(config: unknown): config is MyConfig {
    // Type narrowing validation
    return typeof config === 'object' && config !== null;
  }

  getSchema(): JSONSchema {
    // JSON Schema drives the Studio UI config form automatically
    return {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Service endpoint URL' },
        timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
      },
      required: ['endpoint'],
    };
  }
}
```

**2. Register with ProviderRegistry**

```typescript
// File: apps/search-ai/src/services/provider-registry/index.ts (or startup)

const registry = ProviderRegistry.getInstance();
registry.register(new MyProvider());
// Now available in Studio UI dropdowns via listByStageType()
```

**3. Add circuit breaker config (if custom thresholds needed)**

```typescript
// File: apps/search-ai/src/services/provider-registry/circuit-breaker-registry.ts

const PROVIDER_BREAKER_DEFAULTS: Record<string, Partial<CircuitBreakerConfig>> = {
  // ... existing
  'my-provider': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeout: 60000,
  },
};
```

**4. Add tests**

```typescript
// Test provider directly
describe('MyProvider', () => {
  it('executes successfully', async () => {
    const provider = new MyProvider();
    const result = await provider.execute(input, config);
    expect(result).toBeDefined();
  });

  it('validates config', () => {
    const provider = new MyProvider();
    expect(provider.validateConfig({ endpoint: 'http://...' })).toBe(true);
    expect(provider.validateConfig(null)).toBe(false);
  });

  it('returns valid JSON schema', () => {
    const provider = new MyProvider();
    const schema = provider.getSchema();
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
  });
});
```

**5. Update documentation**

- `docs/searchai/design/INGESTION-PIPELINE-GUIDE.md` — Add to Planned Providers table
- `docs/searchai/design/SERVICES-INVENTORY.md` — Add to services catalog
- `.claude/skills/search-ai-pipelines.md` — Update this skill

### Adding a New Stage Type

More involved — requires schema changes and a new BullMQ worker.

**1. Add to stage type enum** in `search-pipeline-definition.model.ts`:

```typescript
type: {
  type: String,
  enum: ['extraction', 'chunking', 'enrichment', 'embedding', 'multimodal', 'my-stage'],
  required: true,
}
```

**2. Add to STAGE_ORDER** in `apps/search-ai/src/services/reindexing/helpers.ts` (for reindex checkpoint routing).

**3. Create BullMQ worker** in `apps/search-ai/src/workers/`.

**4. Wire into flow builder** in `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`.

**5. Add frontend stage config** in Studio pipeline editor components.

**6. Add to reindex change identifier** if the stage affects checkpoint routing.

---

## Debugging Guide

### Common Issues and Solutions

#### Issue: Flow not being selected

**Symptoms:** Default/catch-all flow always executes, specific flow rules never match.

**Debug Steps:**

1. Check flow `enabled: true` (NOT `isActive`)
2. Check flow `priority` — HIGHER number = evaluated FIRST (not lower)
3. Check `selectionRules` (NOT `preRules`) — verify field paths match context
4. Test via `POST /api/pipelines/:id/test-selection` endpoint
5. Check `result.details.skippedFlows` for evaluation errors

**Solution:**

```typescript
const service = new FlowSelectionService();
const result = await service.selectFlow(pipeline.flows, {
  document: { extension: 'pdf', mimeType: 'application/pdf', size: 1024000, name: 'test.pdf' },
  source: { connector: 'contracts' },
});
// Check result.success, result.flow, result.details.skippedFlows
```

#### Issue: Circuit breaker stuck in OPEN state

**Symptoms:** All requests failing with CircuitOpenError, fallback provider used.

**Debug Steps:**

1. Check circuit state: `await registry.getCircuitState(tenantId, providerId)`
2. Redis key format: `tenantId:providerId` (per-tenant isolation)
3. Check cooldown: Docling=120s, OpenAI=60s, BGE-M3=90s
4. Verify provider health: Test outside circuit breaker

**Solution:**

```typescript
// Manually reset (emergency only)
await registry.resetCircuit(tenantId, 'docling');

// Or wait for automatic half-open transition after cooldown
```

#### Issue: Parent flow waiting forever

**Symptoms:** BullMQ parent job stuck in "waiting-children" state.

**Root Cause:** Missing `failParentOnFailure: true` on child job.

**Solution:**

```typescript
// ALWAYS include this on EVERY child job
const childJob = {
  name: 'extraction',
  queueName: 'extraction',
  data: {
    /* ... */
  },
  opts: {
    failParentOnFailure: true, // ← CRITICAL
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
};
```

#### Issue: Job tracking storage growing unboundedly

**Symptoms:** MongoDB `job_executions` collection size growing without limit.

**Debug Steps:**

1. Check TTL index exists: `db.job_executions.getIndexes()`
2. Verify documents have `createdAt` field
3. Check MongoDB background thread running

**Solution:**

```bash
# Verify TTL index
db.job_executions.getIndexes()
# Should show: { "createdAt": 1 }, expireAfterSeconds: 7776000

# Force TTL cleanup (if needed)
db.adminCommand({ "setParameter": 1, "ttlMonitorSleepSecs": 60 })
```

**Reference:** `docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md`

#### Issue: Stage configuration not applied

**Symptoms:** Stage uses default config instead of user-specified config.

**Debug Steps:**

1. Verify config saved in draft: Check `pipeline.flows[].stages[].providerConfig` (NOT `config`)
2. Check pipeline `status: 'active'` (NOT `isDraft: false`)
3. Verify flow selection picked correct flow (check `result.flow.id`)
4. Check worker receives config in `job.data`

**Solution:**

```typescript
// Debug in worker processor
export async function processStage(job: Job<StageJobData>) {
  logger.info('Stage config received', {
    providerConfig: job.data.stageConfig,
    provider: job.data.providerId,
  });
}
```

#### Issue: Reindex not triggered after publish

**Symptoms:** Published pipeline but documents not reprocessed.

**Debug Steps:**

1. Check `reindexPending` in pipeline store — if `null`, change analysis wasn't performed
2. Check `previousVersion` field on pipeline — if missing, no diff possible
3. Verify user confirmed reindex via `confirmReindex()` (publish alone doesn't trigger reindex)
4. Check BullMQ queues for new jobs

### Monitoring Queries

**Check pipeline usage:**

```typescript
// Most-used pipelines
db.job_executions.aggregate([
  { $match: { pipelineId: { $exists: true } } },
  { $group: { _id: '$pipelineId', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 10 },
]);
```

**Check provider health:**

```typescript
// Provider failure rates
db.job_executions.aggregate([
  { $match: { status: 'failed' } },
  { $group: { _id: '$workerStage', failures: { $sum: 1 } } },
  { $sort: { failures: -1 } },
]);
```

**Check flow selection distribution:**

```typescript
// Which flows are actually being used?
db.job_executions.aggregate([
  { $match: { pipelineId: '<pipeline-id>' } },
  { $group: { _id: '$flowJobId', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);
```

---

## Anti-Patterns

| Don't                                              | Do                                                            | Why                                                          |
| -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Use `isActive`, `preRules`, `providerId`, `config` | Use `enabled`, `selectionRules`, `provider`, `providerConfig` | Field names changed from RFC to implementation               |
| Set per-flow embedding providers                   | Use pipeline-level `activeEmbeddingConfig`                    | All flows must share same embedding for search compatibility |
| Assume lower priority = higher                     | Higher `priority` = evaluated first                           | Reversed from RFC convention                                 |
| Hardcode stage sequence                            | Use `PipelineFlow.stages[]`                                   | Flexibility for different document types                     |
| Store credentials in pipeline config               | Use `credentialId` references                                 | Security: credentials never in pipeline or Redis             |
| Skip flow count validation                         | Enforce `flows.length <= 50`                                  | Performance: document size and query speed                   |
| Omit `failParentOnFailure`                         | Always set `true` on BullMQ children                          | Parent waits forever otherwise                               |
| Use default `lockDuration` (30s)                   | Set per-worker lock duration                                  | Long jobs (Docling/LLM) stall after 30s                      |
| No TTL on job tracking                             | Use TTL index (90 days)                                       | Prevents 730GB/year storage growth                           |
| Modify active pipeline directly                    | Create new draft version, then publish                        | Versioning + rollback + reindex analysis                     |
| No fallback provider                               | Set `fallbackProvider` + `fallbackConfig` on stages           | Circuit breaker auto-routes to fallback                      |
| Use `isDraft: boolean`                             | Use `status: 'draft' \| 'active' \| 'archived'`               | Three-state lifecycle in actual model                        |

---

## Implementation Status

### What's Built Today

| Feature                                         | Status      | Notes                                                  |
| ----------------------------------------------- | ----------- | ------------------------------------------------------ |
| Pipeline data model (SearchPipelineDefinition)  | Done        | Full schema with flows, stages, rules, validation      |
| Draft -> Active lifecycle                       | Done        | Version incrementing, status transitions               |
| Flow selection (simple + compound rules)        | Done        | Priority-based evaluation                              |
| Flow selection (CEL expressions)                | Testing     | Implemented, tests being enabled (Task #15)            |
| 4-checkpoint reindexing system                  | Done        | Change identifier + router + orchestrator + handlers   |
| Pipeline editor UI (Studio)                     | Done        | Full CRUD with skeleton loading                        |
| Embedding configuration (pipeline-level)        | Done        | BGE-M3, OpenAI, Cohere, Custom providers               |
| Circuit breaker (per-provider)                  | Done        | Redis-backed, per-tenant isolation                     |
| Backpressure (queue depth checks)               | Done        | Prevents Redis OOM                                     |
| Provider registry interface                     | Done        | `PipelineStageProvider` interface + singleton registry |
| Provider registry adapters                      | In Progress | Services exist, registry adapters being built          |
| Publish confirmation UI (reindex estimates)     | Done        | Shows affected documents, checkpoints                  |
| Visual processing workers (vision + multimodal) | Done        | Standalone workers, not yet wired through flow system  |
| Multimodal stage type in flow builder           | Future      | In schema, flow system integration planned             |
| Per-index LLM feature configuration             | Done        | Tier-based auto-resolution with fallback (Settings UI) |
| Shared stages (cross-flow)                      | Future      | In schema, not implemented (Task #13)                  |
| Per-flow embedding providers                    | Future      | Pipeline-level only today                              |

### Open Tasks

- **#2:** Instrument CloudWatch metrics for monitoring
- **#13:** Add sharedStages field to pipeline schema
- **#15:** Fix and enable skipped CEL evaluation tests
- **#56:** Add multimodal stage type to STAGE_ORDER in reindexing helpers

---

## Version History

- **2.0.0** (2026-03-11): Major update — synced all interfaces, field names, thresholds, and file paths with actual codebase. Added key code locations, implementation status, corrected data model (SearchPipelineDefinition), fixed circuit breaker thresholds, updated provider guide for adding new providers/stages.
- **1.0.0** (2026-03-07): Initial release

---

**End of Skill**
