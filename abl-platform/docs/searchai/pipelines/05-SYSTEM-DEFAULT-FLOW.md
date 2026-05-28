# System Default Flow Design

**Date:** 2026-03-10
**Status:** DRAFT - Awaiting Approval
**Related Tasks:** #10 (FlowSelection integration), #16 (System default flow)

---

## Overview

Every pipeline has a system default flow that cannot be deleted. It encodes the platform's built-in extraction knowledge. Users customize it (embeddings, LLMs, stage config) but cannot remove it. User-created flows take priority; the default catches everything that doesn't match.

---

## Problem Statement

### Current State: Two Disconnected Routing Systems

**System 1 — Hardcoded MIME routing** (`document-upload.ts`):

```typescript
const DOCLING_SUPPORTED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  '.docx',
  '.pptx',
  '.ppt',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/bmp',
  'image/webp',
]);
const LEGACY_TYPES = new Set(['text/plain', 'text/markdown']);

function routeDocument(contentType: string): 'docling' | 'legacy' {
  if (DOCLING_SUPPORTED_TYPES.has(contentType)) return 'docling';
  if (LEGACY_TYPES.has(contentType)) return 'legacy';
  return 'docling';
}
```

Runs at upload time. No pipeline awareness. Sends directly to `QUEUE_DOCLING_EXTRACTION` or `QUEUE_EXTRACTION`.

**System 2 — Pipeline flow selection** (`flow-selection.service.ts`):

Evaluates CEL rules and priority. Returns `{ success: false }` when no flow matches. Document is dropped.

**Problems:**

1. No default flow. Unmatched documents are dropped silently.
2. Hardcoded MIME knowledge is invisible to users and not configurable.
3. Upload routing and pipeline flow selection can contradict each other.
4. Validation does not enforce that a catch-all flow exists.

### Target State: Single Pipeline-Driven Routing

```
Document arrives
     |
     v
Evaluate user flows (highest priority first)
     |
     +---> Flow "PDF Heavy"    (priority 20, rule: mimeType in [pdf, docx])
     +---> Flow "Web Content"  (priority 15, rule: source == 'web-crawler')
     +---> ... more user flows ...
     |
     v
No match
     |
     v
System Default Flow (priority 0, no rules, always matches)
```

One routing system. Explicit. Configurable. No document dropped.

---

## Data Model

### IPipelineFlow Addition

```typescript
export interface IPipelineFlow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  selectionRules?: IRuleCondition[];
  stages: IPipelineStage[];
  isDefault: boolean; // NEW

  customEnrichment?: IPipelineStage[];
  customIndexing?: IPipelineStage[];
  providerDefaults?: Record<string, Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
}
```

### Mongoose Schema Addition

```typescript
// In PipelineFlowSchema
isDefault: {
  type: Boolean,
  required: true,
  default: false,
},
```

### Constraints on Default Flow

| Field            | Constraint                                   | Enforced By        |
| ---------------- | -------------------------------------------- | ------------------ |
| `isDefault`      | Exactly one flow per pipeline must be `true` | Validation service |
| `selectionRules` | Must be empty (`[]` or `undefined`)          | Validation service |
| `enabled`        | Must be `true`                               | Validation service |
| `priority`       | Must be `0`                                  | Validation service |
| Delete           | Cannot be deleted                            | API handler        |
| Disable          | Cannot be disabled                           | API handler + UI   |

---

## Default Pipeline Template

When a knowledge base is created, the pipeline is seeded with this template. It encodes the current hardcoded MIME knowledge as explicit, editable configuration.

```typescript
// apps/search-ai/src/services/pipeline-orchestration/default-pipeline-template.ts

import type { IPipelineDefinition } from '@agent-platform/database';

export function createDefaultPipeline(
  tenantId: string,
  knowledgeBaseId: string,
  createdBy: string,
): Partial<IPipelineDefinition> {
  return {
    tenantId,
    knowledgeBaseId,
    name: 'Ingestion Pipeline',
    description:
      'Default ingestion pipeline. Customize stages or add flows for specific document types.',
    version: 1,
    status: 'active',
    createdBy,

    activeEmbeddingConfig: {
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    },

    flows: [
      {
        id: 'flow-system-default',
        name: 'Default Processing',
        description:
          'Processes all documents. Uses Docling for rich formats (PDF, DOCX, PPTX, HTML, images) with LlamaIndex fallback for plain text.',
        enabled: true,
        priority: 0,
        isDefault: true,
        selectionRules: [],

        stages: [
          {
            id: 'stage-extraction',
            name: 'Document Extraction',
            type: 'extraction',
            provider: 'docling',
            providerConfig: {
              fallbackToLegacy: true,
              supportedMimeTypes: [
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/vnd.ms-powerpoint',
                'text/html',
                'image/png',
                'image/jpeg',
                'image/tiff',
                'image/bmp',
                'image/webp',
              ],
              legacyMimeTypes: ['text/plain', 'text/markdown'],
            },
            onError: 'fail',
            fallbackProvider: 'llamaindex',
            fallbackConfig: {},
          },
          {
            id: 'stage-chunking',
            name: 'Tree Building',
            type: 'chunking',
            provider: 'tree-builder',
            providerConfig: {
              maxChunkTokens: 512,
              overlap: 50,
            },
            onError: 'fail',
          },
          {
            id: 'stage-enrichment',
            name: 'LLM Enrichment',
            type: 'enrichment',
            provider: 'llm-enrichment',
            providerConfig: {},
            onError: 'continue',
          },
          {
            id: 'stage-embedding',
            name: 'Embedding',
            type: 'embedding',
            provider: 'bge-m3',
            providerConfig: {
              model: 'bge-m3',
              dimensions: 1024,
            },
            onError: 'fail',
          },
        ],

        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}
```

### Extraction Provider Behavior

The default flow uses a single Docling extraction stage with `fallbackProvider: 'llamaindex'`. The extraction provider handles MIME routing internally:

```
Document arrives at extraction stage
     |
     v
Is mimeType in supportedMimeTypes?
     |
  Yes: Docling extracts (PDF, DOCX, PPTX, HTML, images)
     |
  No: Is mimeType in legacyMimeTypes?
       |
    Yes: LlamaIndex extracts (plain text, markdown)
       |
    No: Docling attempts anyway (quality-first default)
         If Docling fails: fallbackProvider (LlamaIndex) handles it
```

This keeps the flow simple (one flow, one extraction stage) while preserving MIME-aware routing inside the provider. Users who want explicit per-type flows can add their own.

---

## Validation Rules

```typescript
// apps/search-ai/src/services/pipeline-validation/validation.service.ts

function validateDefaultFlow(pipeline: IPipelineDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const defaultFlows = pipeline.flows.filter((f) => f.isDefault);

  // Rule 1: Exactly one default flow
  if (defaultFlows.length === 0) {
    errors.push({
      code: 'PIPELINE_NO_DEFAULT_FLOW',
      message: 'Pipeline must have a default flow. The default flow cannot be deleted.',
      severity: 'error',
      path: 'flows',
    });
    return errors;
  }

  if (defaultFlows.length > 1) {
    errors.push({
      code: 'PIPELINE_MULTIPLE_DEFAULT_FLOWS',
      message: 'Pipeline can only have one default flow.',
      severity: 'error',
      path: 'flows',
    });
  }

  const defaultFlow = defaultFlows[0];

  // Rule 2: No selection rules
  if (defaultFlow.selectionRules && defaultFlow.selectionRules.length > 0) {
    errors.push({
      code: 'DEFAULT_FLOW_HAS_RULES',
      message: 'Default flow cannot have selection rules. It catches all unmatched documents.',
      severity: 'error',
      path: `flows[${defaultFlow.id}].selectionRules`,
    });
  }

  // Rule 3: Must be enabled
  if (!defaultFlow.enabled) {
    errors.push({
      code: 'DEFAULT_FLOW_DISABLED',
      message: 'Default flow cannot be disabled. Disabling it would drop unmatched documents.',
      severity: 'error',
      path: `flows[${defaultFlow.id}].enabled`,
    });
  }

  // Rule 4: Priority must be 0 (always evaluated last)
  if (defaultFlow.priority !== 0) {
    errors.push({
      code: 'DEFAULT_FLOW_PRIORITY',
      message:
        'Default flow priority must be 0. User flows with higher priority are evaluated first.',
      severity: 'error',
      path: `flows[${defaultFlow.id}].priority`,
    });
  }

  return errors;
}
```

---

## API Behavior

### Pipeline PATCH — Prevent Default Flow Deletion

```typescript
// apps/search-ai/src/routes/pipelines.ts — PATCH handler

// Detect if update removes the default flow
if (updates.flows) {
  const existingDefault = existing.flows.find((f) => f.isDefault);
  const updatedDefault = updates.flows.find((f) => f.isDefault);

  if (existingDefault && !updatedDefault) {
    res.status(400).json({
      success: false,
      error: {
        code: 'CANNOT_DELETE_DEFAULT_FLOW',
        message: 'The default flow cannot be deleted. It can only be customized.',
      },
    });
    return;
  }
}
```

### KB Creation — Seed Default Pipeline

```typescript
// When a KB is created, automatically seed the default pipeline

async function createKnowledgeBase(req, res) {
  // ... create KB ...

  const defaultPipeline = createDefaultPipeline(tenantId, kb._id, userId);
  await PipelineDefinition.create(defaultPipeline);

  // ... return KB ...
}
```

### What Users Can Customize on the Default Flow

| Action                      | Allowed? | Example                                       |
| --------------------------- | -------- | --------------------------------------------- |
| Change extraction provider  | Yes      | Switch from Docling to LlamaIndex             |
| Change extraction config    | Yes      | Add OCR settings, change supported MIME types |
| Change chunking provider    | Yes      | Switch from tree-builder to fixed-size        |
| Change chunking config      | Yes      | Change max tokens, overlap                    |
| Change enrichment provider  | Yes      | Switch LLM model                              |
| Remove enrichment stage     | Yes      | Skip enrichment entirely                      |
| Add enrichment stage        | Yes      | Add KG enrichment                             |
| Change embedding provider   | Yes      | Via embedding config endpoint                 |
| Change embedding dimensions | Yes      | Via embedding config endpoint                 |
| Change flow name            | Yes      | Rename to "My Custom Default"                 |
| Add selection rules         | No       | Default flow must catch everything            |
| Disable flow                | No       | Default flow must be enabled                  |
| Delete flow                 | No       | Default flow must exist                       |

---

## Flow Selection Algorithm (Updated)

No changes to the algorithm itself. The default flow works because:

1. Flows are sorted by priority (highest first)
2. Default flow has priority 0 (always evaluated last)
3. Default flow has no selection rules
4. A flow with no rules always matches (line 112 in flow-selection.service.ts)

```
selectFlow(flows, context):
  enabledFlows = flows.filter(f => f.enabled)
  sortedFlows = enabledFlows.sort(f => f.priority DESC)

  for flow in sortedFlows:
    if flow has no rules:
      return flow                    // <-- Default flow always matches here

    if flow rules match context:
      return flow

  return { success: false }          // <-- Never reached if default flow exists
```

The validation rules guarantee a default flow exists and is enabled, so the `success: false` path becomes unreachable.

---

## Upload Route Migration

### Current (Hardcoded)

```typescript
// apps/search-ai/src/routes/document-upload.ts

const route = routeDocument(contentType);   // 'docling' or 'legacy'
const queueName = route === 'docling' ? QUEUE_DOCLING_EXTRACTION : QUEUE_EXTRACTION;
await extractionQueue.add(`${route}-extract:${document._id}`, { ... });
```

### Target (Pipeline-Driven)

```typescript
// apps/search-ai/src/routes/document-upload.ts

// Upload only creates the document record and enqueues to ingestion
await ingestionQueue.add(`ingest:${document._id}`, {
  documentId: document._id,
  tenantId,
  indexId,
  knowledgeBaseId,
});
```

```typescript
// apps/search-ai/src/workers/ingestion-worker.ts

async function processIngestionJob(job) {
  const { documentId, tenantId, knowledgeBaseId, indexId } = job.data;

  // 1. Load document metadata
  const document = await SearchDocument.findOne({ _id: documentId, tenantId }).lean();

  // 2. Load active pipeline
  const pipeline = await PipelineDefinition.findOne({
    tenantId,
    knowledgeBaseId,
    status: 'active',
  }).lean();

  // 3. Build flow (flow selection happens inside)
  const flowBuilder = new PipelineFlowBuilder();
  const result = await flowBuilder.buildFlow(pipeline, {
    documentId,
    tenantId,
    sourceId: document.sourceId,
    indexId,
    document: {
      extension: document.extension,
      mimeType: document.mimeType,
      size: document.size,
      name: document.name,
    },
    source: {
      connector: document.sourceConnector,
    },
  });

  // 4. Flow selection guaranteed to succeed (default flow catches everything)
  // 5. First stage in selected flow determines extraction queue
  await safeAddFlow(flowProducer, result.flow, parentQueue);
}
```

### Migration Path

The hardcoded routing (`DOCLING_SUPPORTED_TYPES`, `LEGACY_TYPES`, `routeDocument()`) is removed after:

1. Task #10 complete (FlowSelection integrated in builder)
2. Task #16 complete (default pipeline seeded for all KBs)
3. Existing KBs migrated (default flow added to existing pipelines)

Until then, both systems coexist. The hardcoded routing serves as the safety net during migration.

---

## Migration: Existing Knowledge Bases

Existing KBs do not have pipelines with a default flow. Migration script:

```typescript
// scripts/migrate-default-flow.ts

async function migrateExistingPipelines() {
  const pipelines = await PipelineDefinition.find({});

  for (const pipeline of pipelines) {
    const hasDefault = pipeline.flows.some((f) => f.isDefault);
    if (hasDefault) continue;

    // Add default flow to existing pipeline
    const defaultFlow = createDefaultPipeline('', '', '').flows[0];
    pipeline.flows.push(defaultFlow);
    await pipeline.save();

    logger.info('Added default flow to pipeline', {
      pipelineId: pipeline._id,
      knowledgeBaseId: pipeline.knowledgeBaseId,
    });
  }

  // KBs without any pipeline: create one
  const kbsWithoutPipeline = await KnowledgeBase.find({
    _id: { $nin: await PipelineDefinition.distinct('knowledgeBaseId') },
  });

  for (const kb of kbsWithoutPipeline) {
    const defaultPipeline = createDefaultPipeline(kb.tenantId, kb._id, 'migration');
    await PipelineDefinition.create(defaultPipeline);

    logger.info('Created default pipeline for KB', {
      knowledgeBaseId: kb._id,
      tenantId: kb.tenantId,
    });
  }
}
```

---

## UI Behavior

### FlowsList Component

Default flow renders at the bottom with a system badge:

```
┌─────────────────────────────────────────┐
│ Flows (3)                      [+ Add]  │
├─────────────────────────────────────────┤
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ PDF Heavy              P:20      │  │  <- User flow (deletable)
│  │ rule: mimeType in [pdf, docx]    │  │
│  │ Docling -> Enrichment -> BGE-M3  │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ Web Content             P:15     │  │  <- User flow (deletable)
│  │ rule: source == web-crawler      │  │
│  │ Docling -> Enrichment -> BGE-M3  │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ [gear] Default Processing   P:0  │  │  <- System flow
│  │ Catches all unmatched documents  │  │     No delete button
│  │ Docling -> TreeBuilder ->        │  │     No disable toggle
│  │ Enrichment -> BGE-M3             │  │     Can edit stages
│  └───────────────────────────────────┘  │
│                                         │
└─────────────────────────────────────────┘
```

### FlowsList Changes

```typescript
// apps/studio/src/components/search-ai/pipelines/FlowsList.tsx

function FlowCard({ flow }: { flow: PipelineFlow }) {
  return (
    <div className={flow.isDefault ? 'border-dashed border-muted' : 'border-default'}>
      <div className="flex items-center gap-2">
        {flow.isDefault && (
          <span className="text-xs px-1.5 py-0.5 bg-background-muted rounded text-muted">
            System
          </span>
        )}
        <span className="font-medium">{flow.name}</span>
        <span className="text-xs text-muted">P:{flow.priority}</span>
      </div>

      {flow.isDefault ? (
        <span className="text-xs text-muted">Catches all unmatched documents</span>
      ) : (
        <span className="text-xs text-muted">
          {flow.selectionRules?.length || 0} rules
        </span>
      )}

      {/* No delete button for default flow */}
      {!flow.isDefault && (
        <button onClick={() => removeFlow(flow.id)}>Delete</button>
      )}
    </div>
  );
}
```

### FlowDetail Changes

When default flow is selected, disable rule-related controls:

```typescript
// apps/studio/src/components/search-ai/pipelines/FlowDetail.tsx

function FlowDetail({ flow }: { flow: PipelineFlow }) {
  return (
    <div>
      {/* Name: editable */}
      <input value={flow.name} onChange={...} />

      {/* Selection rules: hidden for default flow */}
      {!flow.isDefault && (
        <RuleBuilderPanel flowId={flow.id} />
      )}

      {/* Stages: always editable */}
      <StagesList stages={flow.stages} />

      {/* Enable/disable: hidden for default flow */}
      {!flow.isDefault && (
        <Toggle checked={flow.enabled} onChange={...} />
      )}
    </div>
  );
}
```

---

## Frontend Types

```typescript
// apps/studio/src/api/pipelines.ts

export interface PipelineFlow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  stages: PipelineStage[];
  selectionRules: RuleCondition[];
  isDefault: boolean; // NEW
}
```

---

## Testing

```typescript
describe('Default Flow Validation', () => {
  it('rejects pipeline with no default flow', async () => {
    const pipeline = createPipeline({ flows: [userFlowWithRules] });
    const result = await validationService.validate(pipeline);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'PIPELINE_NO_DEFAULT_FLOW' }),
    );
  });

  it('rejects default flow with selection rules', async () => {
    const pipeline = createPipeline({
      flows: [{ ...defaultFlow, selectionRules: [someRule] }],
    });
    const result = await validationService.validate(pipeline);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DEFAULT_FLOW_HAS_RULES' }),
    );
  });

  it('rejects disabled default flow', async () => {
    const pipeline = createPipeline({
      flows: [{ ...defaultFlow, enabled: false }],
    });
    const result = await validationService.validate(pipeline);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'DEFAULT_FLOW_DISABLED' }),
    );
  });

  it('rejects deleting default flow via PATCH', async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}/knowledge-bases/${kbId}/pipelines/${pipelineId}`)
      .send({ flows: [userFlowOnly] }); // Default flow removed

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_DELETE_DEFAULT_FLOW');
  });
});

describe('Flow Selection with Default Flow', () => {
  it('selects user flow when rules match', async () => {
    const result = await flowSelection.selectFlow(
      [userPDFFlow, defaultFlow],
      { document: { mimeType: 'application/pdf', extension: 'pdf', size: 1000, name: 'test.pdf' } },
    );
    expect(result.flow.id).toBe(userPDFFlow.id);
  });

  it('falls back to default flow when no user flow matches', async () => {
    const result = await flowSelection.selectFlow(
      [userPDFFlow, defaultFlow],
      { document: { mimeType: 'text/csv', extension: 'csv', size: 500, name: 'data.csv' } },
    );
    expect(result.flow.id).toBe(defaultFlow.id);
    expect(result.flow.isDefault).toBe(true);
  });

  it('never returns success: false when default flow exists', async () => {
    const result = await flowSelection.selectFlow(
      [defaultFlow],
      { document: { mimeType: 'application/x-unknown', extension: 'xyz', size: 1, name: 'file.xyz' } },
    );
    expect(result.success).toBe(true);
  });
});

describe('Default Pipeline Template', () => {
  it('creates pipeline with one default flow', () => {
    const pipeline = createDefaultPipeline('tenant-1', 'kb-1', 'user-1');
    expect(pipeline.flows).toHaveLength(1);
    expect(pipeline.flows[0].isDefault).toBe(true);
    expect(pipeline.flows[0].selectionRules).toEqual([]);
    expect(pipeline.flows[0].priority).toBe(0);
  });

  it('default flow has extraction with Docling + LlamaIndex fallback', () => {
    const pipeline = createDefaultPipeline('tenant-1', 'kb-1', 'user-1');
    const extraction = pipeline.flows[0].stages.find((s) => s.type === 'extraction');
    expect(extraction.provider).toBe('docling');
    expect(extraction.fallbackProvider).toBe('llamaindex');
  });

  it('default flow has all four stage types', () => {
    const pipeline = createDefaultPipeline('tenant-1', 'kb-1', 'user-1');
    const types = pipeline.flows[0].stages.map((s) => s.type);
    expect(types).toEqual(['extraction', 'chunking', 'enrichment', 'embedding']);
  });
});

describe('KB Creation Seeds Pipeline', () => {
  it('creates default pipeline when KB is created', async () => {
    const kb = await createKnowledgeBase({ name: 'Test KB' });

    const pipeline = await PipelineDefinition.findOne({
      knowledgeBaseId: kb._id,
    });

    expect(pipeline).toBeDefined();
    expect(pipeline.flows[0].isDefault).toBe(true);
    expect(pipeline.status).toBe('active');
  });
});

describe('Migration', () => {
  it('adds default flow to existing pipeline without one', async () => {
    const pipeline = await PipelineDefinition.create({
      flows: [{ id: 'user-flow', isDefault: false, selectionRules: [rule], ... }],
    });

    await migrateExistingPipelines();

    const updated = await PipelineDefinition.findById(pipeline._id);
    expect(updated.flows).toHaveLength(2);
    expect(updated.flows.some((f) => f.isDefault)).toBe(true);
  });
});
```

---

## Approval Checklist

- [ ] Architecture: Default flow as a regular flow with constraints, not a separate entity
- [ ] Product: Users can customize but not delete default flow
- [ ] Data model: `isDefault` field on IPipelineFlow
- [ ] Validation: 4 rules (exists, no rules, enabled, priority 0)
- [ ] Template: Encodes current MIME knowledge (Docling + LlamaIndex fallback)
- [ ] Migration: Existing KBs get default flow added
- [ ] UI: System badge, no delete, no disable, stages editable
- [ ] Upload migration: Hardcoded routing replaced by pipeline-driven routing

### After Approval

1. Update `01-DATA-MODELS.md` with `isDefault` field
2. Update `UX-PIPELINE-CONFIGURATION.md` with default flow UI behavior
3. Begin implementation following Task #16
