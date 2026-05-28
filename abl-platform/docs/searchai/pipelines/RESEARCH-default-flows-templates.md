# Research: Default Flows Instantiation and Template Strategy

**Task:** Research #35 - Default flows instantiation and template strategy
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

When a new search index is created, a **default pipeline with 3 pre-configured flows** is automatically instantiated to provide out-of-the-box functionality. The default flows cover **PDF documents** (priority 10), **Office documents** (priority 20), and a **catch-all default** (priority 99). Each flow includes a complete stage configuration with sensible defaults that users can customize. The instantiation follows the **smart defaults pattern** used by LLM configuration, with templates stored as JSON objects and applied at index creation time.

---

## 1. Default Flows Strategy

### Overview

```
Index Creation → Create Default Pipeline → Instantiate 3 Default Flows → User Customizes (optional)
```

### Default Pipeline Structure

```typescript
const DEFAULT_PIPELINE = {
  name: 'Default Pipeline',
  description: 'Auto-generated pipeline with common document processing flows',
  flows: [
    {
      id: 'flow-pdf-docling',
      name: 'PDF Documents (Docling)',
      priority: 10,
      selectionRules: "contentType == 'application/pdf'",
      stages: [
        /* PDF-specific stages */
      ],
    },
    {
      id: 'flow-office-docs',
      name: 'Office Documents (Docling)',
      priority: 20,
      selectionRules:
        "contentType.startsWith('application/vnd.openxmlformats') || contentType.startsWith('application/vnd.ms')",
      stages: [
        /* Office-specific stages */
      ],
    },
    {
      id: 'flow-default',
      name: 'Default (All Others)',
      priority: 99,
      selectionRules: null, // Matches all documents
      stages: [
        /* Minimal processing stages */
      ],
    },
  ],
  sharedStages: [],
  version: 1,
  status: 'active',
};
```

**Key Decisions:**

- **3 default flows**: PDF (priority 10), Office (priority 20), Default (priority 99)
- **Priority ordering**: Lower number = higher priority
- **Selection rules**: CEL expressions based on MIME type
- **Catch-all default**: No selection rules (matches all documents)
- **User customization**: Users can edit, disable, or delete default flows

---

## 2. Default Flow Templates

### Template 1: PDF Documents (Docling)

```typescript
export const DEFAULT_FLOW_PDF_DOCLING = {
  id: 'flow-pdf-docling',
  name: 'PDF Documents (Docling)',
  priority: 10,
  selectionRules: "contentType == 'application/pdf'",
  stages: [
    {
      id: 'stage-1',
      type: 'extraction',
      name: 'Docling Extraction',
      provider: 'docling',
      config: {
        extractTables: true,
        extractImages: true,
        extractCharts: true,
        ocrFallback: false,
        preferOcr: false,
      },
      onError: 'fail', // Fail document if extraction fails
    },
    {
      id: 'stage-2',
      type: 'chunking',
      name: 'Semantic Chunking',
      provider: 'tree-builder',
      config: {
        targetChunkSize: 512,
        maxChunkSize: 1024,
        minChunkSize: 128,
        similarityThreshold: 0.7,
        enableSemanticSplitting: true,
      },
      onError: 'fail',
    },
    {
      id: 'stage-3',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      config: {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        batchSize: 100,
      },
      onError: 'fail',
    },
    {
      id: 'stage-4',
      type: 'enrichment',
      name: 'Progressive Summarization',
      provider: 'llm',
      config: {
        useCase: 'progressiveSummarization',
        maxTokens: 300,
        enableDocumentSummary: true,
        documentSummaryMaxTokens: 500,
      },
      onError: 'continue', // Non-critical, continue if fails
    },
    {
      id: 'stage-5',
      type: 'enrichment',
      name: 'Question Synthesis',
      provider: 'llm',
      config: {
        useCase: 'questionSynthesis',
        questionsPerChunk: 3,
        maxTokens: 150,
        enableEmbedding: true,
      },
      onError: 'continue',
    },
    {
      id: 'stage-6',
      type: 'knowledge-graph',
      name: 'Entity Extraction',
      provider: 'llm',
      config: {
        useCase: 'knowledgeGraph',
        enableCoOccurrence: true,
      },
      onError: 'continue',
    },
  ],
};
```

**Why this flow?**

- **PDFs are the most common document type** (60-80% of ingestion workload)
- **Docling extraction** provides high-quality text, tables, and images
- **Tree-builder chunking** preserves document structure (headings, sections)
- **Progressive summarization** and **question synthesis** improve retrieval quality
- **Knowledge graph** enriches with entities and relationships

---

### Template 2: Office Documents (Docling)

```typescript
export const DEFAULT_FLOW_OFFICE_DOCS = {
  id: 'flow-office-docs',
  name: 'Office Documents (Docling)',
  priority: 20,
  selectionRules:
    "contentType.startsWith('application/vnd.openxmlformats') || contentType.startsWith('application/vnd.ms')",
  stages: [
    {
      id: 'stage-1',
      type: 'extraction',
      name: 'Docling Extraction',
      provider: 'docling',
      config: {
        extractTables: true,
        extractImages: true,
        extractCharts: true,
        ocrFallback: false,
        preferOcr: false,
      },
      onError: 'fail',
    },
    {
      id: 'stage-2',
      type: 'chunking',
      name: 'Semantic Chunking',
      provider: 'tree-builder',
      config: {
        targetChunkSize: 512,
        maxChunkSize: 1024,
        minChunkSize: 128,
        similarityThreshold: 0.7,
        enableSemanticSplitting: true,
      },
      onError: 'fail',
    },
    {
      id: 'stage-3',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      config: {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        batchSize: 100,
      },
      onError: 'fail',
    },
    {
      id: 'stage-4',
      type: 'enrichment',
      name: 'Progressive Summarization',
      provider: 'llm',
      config: {
        useCase: 'progressiveSummarization',
        maxTokens: 300,
        enableDocumentSummary: true,
        documentSummaryMaxTokens: 500,
      },
      onError: 'continue',
    },
    {
      id: 'stage-5',
      type: 'enrichment',
      name: 'Question Synthesis',
      provider: 'llm',
      config: {
        useCase: 'questionSynthesis',
        questionsPerChunk: 3,
        maxTokens: 150,
        enableEmbedding: true,
      },
      onError: 'continue',
    },
  ],
};
```

**Why this flow?**

- **Office documents** (Word, Excel, PowerPoint) are the second most common type
- **Identical stages to PDF flow** (Office docs are structurally similar)
- **No knowledge graph** (Office docs often contain transient data like reports, presentations)
- **Separated from PDF flow** for future customization (users might want different enrichment)

---

### Template 3: Default (All Others)

```typescript
export const DEFAULT_FLOW_CATCHALL = {
  id: 'flow-default',
  name: 'Default (All Others)',
  priority: 99,
  selectionRules: null, // Matches all documents
  stages: [
    {
      id: 'stage-1',
      type: 'extraction',
      name: 'Tika Extraction',
      provider: 'tika',
      config: {
        extractMetadata: true,
        detectLanguage: true,
      },
      onError: 'fail',
    },
    {
      id: 'stage-2',
      type: 'chunking',
      name: 'Simple Chunking',
      provider: 'fixed-size',
      config: {
        chunkSize: 512,
        chunkOverlap: 50,
      },
      onError: 'fail',
    },
    {
      id: 'stage-3',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      config: {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        batchSize: 100,
      },
      onError: 'fail',
    },
  ],
};
```

**Why this flow?**

- **Catch-all for everything else** (HTML, Markdown, text files, images, etc.)
- **Apache Tika extraction** (universal extractor for 1000+ file types)
- **Simple fixed-size chunking** (no semantic splitting, faster and simpler)
- **No enrichment** (save cost on less common file types)
- **Minimal processing** to ensure all documents can be ingested

---

## 3. Instantiation Strategy

### On Index Creation

```typescript
async function createIndex(indexData: CreateIndexInput): Promise<ISearchIndex> {
  // 1. Create index record
  const index = await SearchIndex.create({
    tenantId: indexData.tenantId,
    projectId: indexData.projectId,
    slug: indexData.slug,
    name: indexData.name,
    // ... other fields
  });

  // 2. Create default pipeline with 3 flows
  const defaultPipeline = await createDefaultPipeline(index._id, index.tenantId);

  // 3. Return index (with pipeline ID for reference)
  return index;
}

async function createDefaultPipeline(
  indexId: string,
  tenantId: string,
): Promise<IPipelineDefinition> {
  const pipeline = await PipelineDefinition.create({
    tenantId,
    indexId,
    name: 'Default Pipeline',
    description: 'Auto-generated pipeline with common document processing flows',
    flows: [DEFAULT_FLOW_PDF_DOCLING, DEFAULT_FLOW_OFFICE_DOCS, DEFAULT_FLOW_CATCHALL],
    sharedStages: [],
    version: 1,
    status: 'active',
  });

  return pipeline;
}
```

**Key Points:**

- **Automatic instantiation**: No user action required
- **Single pipeline**: One default pipeline per index
- **Immediate activation**: Pipeline status is 'active' (ready to use)
- **User customization**: Users can edit, disable, or delete flows after creation

---

## 4. Template Configuration System

### Template Storage

```typescript
// Location: packages/searchai-pipeline/src/templates/default-flows.ts

export interface FlowTemplate {
  id: string;
  name: string;
  priority: number;
  selectionRules: string | null;
  stages: StageTemplate[];
  description?: string;
  tags?: string[];
}

export interface StageTemplate {
  id: string;
  type: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  onError: 'fail' | 'continue' | 'skip';
  description?: string;
}

export const DEFAULT_FLOW_TEMPLATES: FlowTemplate[] = [
  DEFAULT_FLOW_PDF_DOCLING,
  DEFAULT_FLOW_OFFICE_DOCS,
  DEFAULT_FLOW_CATCHALL,
];

/**
 * Get default flow templates for a new index.
 * Returns cloned templates with unique IDs.
 */
export function getDefaultFlowTemplates(): FlowTemplate[] {
  return DEFAULT_FLOW_TEMPLATES.map((template) => ({
    ...template,
    id: `flow-${uuidv7()}`, // Generate unique ID
    stages: template.stages.map((stage) => ({
      ...stage,
      id: `stage-${uuidv7()}`, // Generate unique ID
    })),
  }));
}

/**
 * Get a specific flow template by name.
 */
export function getFlowTemplate(name: string): FlowTemplate | undefined {
  return DEFAULT_FLOW_TEMPLATES.find((t) => t.name === name);
}
```

### Template Customization Hooks

```typescript
/**
 * Customize flow templates based on index configuration.
 * Allows defaults to adapt to user preferences.
 */
export function customizeFlowTemplates(
  templates: FlowTemplate[],
  indexConfig: IndexConfig,
): FlowTemplate[] {
  const customized = templates.map((flow) => ({
    ...flow,
    stages: flow.stages.map((stage) => {
      // Override embedding model if index specifies a different default
      if (stage.type === 'embedding' && indexConfig.embeddingModel) {
        return {
          ...stage,
          config: {
            ...stage.config,
            model: indexConfig.embeddingModel,
            dimensions: indexConfig.embeddingDimensions || 1536,
          },
        };
      }

      // Override LLM provider if index has specific credential
      if (stage.type === 'enrichment' && indexConfig.preferredLLMProvider) {
        return {
          ...stage,
          config: {
            ...stage.config,
            provider: indexConfig.preferredLLMProvider,
          },
        };
      }

      return stage;
    }),
  }));

  return customized;
}
```

---

## 5. Smart Defaults Pattern (Following LLM Config)

### Hierarchy

```
1. User-defined pipeline (if exists)
2. Default pipeline with customized config (index-level overrides)
3. Default pipeline templates (this file)
```

### Index-Level Overrides

```typescript
interface IndexConfig {
  // Override embedding model for all flows
  embeddingModel?: string;
  embeddingDimensions?: number;

  // Override LLM provider preference
  preferredLLMProvider?: 'anthropic' | 'openai' | 'google';

  // Disable specific enrichment stages
  disableEnrichment?: boolean;
  disableKnowledgeGraph?: boolean;
  disableVision?: boolean;

  // Custom default flow priorities
  flowPriorities?: {
    pdf?: number;
    office?: number;
    default?: number;
  };
}
```

### Resolution Example

```typescript
async function resolveFlowTemplates(indexId: string): Promise<FlowTemplate[]> {
  // 1. Load index config
  const index = await SearchIndex.findById(indexId);

  // 2. Get base templates
  const baseTemplates = getDefaultFlowTemplates();

  // 3. Apply index-level customizations
  const customized = customizeFlowTemplates(baseTemplates, {
    embeddingModel: index.embeddingModel,
    embeddingDimensions: index.embeddingDimensions,
    // ... other overrides
  });

  // 4. Return customized templates
  return customized;
}
```

---

## 6. Alternative Flow Templates (Future)

### Template 4: Large PDFs (>50MB) - Optimized

```typescript
export const LARGE_PDF_FLOW = {
  id: 'flow-large-pdf',
  name: 'Large PDFs (Optimized)',
  priority: 5,
  selectionRules: "contentType == 'application/pdf' && contentSizeBytes > 52428800",
  stages: [
    {
      id: 'stage-1',
      type: 'extraction',
      name: 'Docling Extraction',
      provider: 'docling',
      config: {
        extractTables: false, // Skip tables for large docs
        extractImages: false, // Skip images for large docs
        extractCharts: false,
        ocrFallback: false,
      },
      onError: 'fail',
    },
    {
      id: 'stage-2',
      type: 'chunking',
      name: 'Fixed-Size Chunking',
      provider: 'fixed-size',
      config: {
        chunkSize: 1024, // Larger chunks for large docs
        chunkOverlap: 100,
      },
      onError: 'fail',
    },
    {
      id: 'stage-3',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      config: {
        model: 'text-embedding-3-small',
        dimensions: 1536,
        batchSize: 200, // Larger batch for efficiency
      },
      onError: 'fail',
    },
    // No enrichment (save cost on large docs)
  ],
};
```

### Template 5: Legal Documents - High Quality

```typescript
export const LEGAL_DOCS_FLOW = {
  id: 'flow-legal-docs',
  name: 'Legal Documents (High Quality)',
  priority: 15,
  selectionRules: "classification != null && classification.department == 'legal'",
  stages: [
    {
      id: 'stage-1',
      type: 'extraction',
      name: 'Docling Extraction',
      provider: 'docling',
      config: {
        extractTables: true,
        extractImages: true,
        extractCharts: true,
        ocrFallback: true, // Enable OCR for scanned documents
        preferOcr: false,
      },
      onError: 'fail',
    },
    {
      id: 'stage-2',
      type: 'chunking',
      name: 'Semantic Chunking',
      provider: 'tree-builder',
      config: {
        targetChunkSize: 768, // Larger chunks for legal docs
        maxChunkSize: 1536,
        minChunkSize: 256,
        similarityThreshold: 0.8, // Higher threshold for precise boundaries
        enableSemanticSplitting: true,
      },
      onError: 'fail',
    },
    {
      id: 'stage-3',
      type: 'embedding',
      name: 'Generate Embeddings',
      provider: 'openai',
      config: {
        model: 'text-embedding-3-large', // Higher quality for legal
        dimensions: 3072,
        batchSize: 50,
      },
      onError: 'fail',
    },
    {
      id: 'stage-4',
      type: 'enrichment',
      name: 'Legal Entity Extraction',
      provider: 'llm',
      config: {
        useCase: 'knowledgeGraph',
        enableCoOccurrence: true,
        modelTier: 'powerful', // Use strongest model for legal
      },
      onError: 'continue',
    },
  ],
};
```

---

## 7. Template Selection Strategy

### Current: Single Default Pipeline

For MVP, **all indexes get the same 3-flow default pipeline**.

**Pros:**

- Simple to implement
- Predictable behavior
- Easy to document

**Cons:**

- Not optimized for specific use cases
- Users must customize if defaults don't fit

### Future: Smart Template Selection

Based on index metadata, select different default templates:

```typescript
function selectDefaultFlowTemplates(indexConfig: IndexConfig): FlowTemplate[] {
  // Legal index → Legal-optimized flows
  if (indexConfig.department === 'legal') {
    return [LEGAL_DOCS_FLOW, DEFAULT_FLOW_CATCHALL];
  }

  // High-volume index → Cost-optimized flows
  if (indexConfig.expectedVolume === 'high') {
    return [LARGE_PDF_FLOW, DEFAULT_FLOW_OFFICE_DOCS, DEFAULT_FLOW_CATCHALL];
  }

  // Default
  return [DEFAULT_FLOW_PDF_DOCLING, DEFAULT_FLOW_OFFICE_DOCS, DEFAULT_FLOW_CATCHALL];
}
```

**Recommendation:** Start with single default, add smart selection in Phase 2 based on user feedback.

---

## 8. User Customization Workflows

### Workflow 1: Disable Default Flow

```typescript
// User disables Office docs flow (don't process Office files)
await PipelineDefinition.findOneAndUpdate(
  { _id: pipelineId, tenantId },
  {
    $set: { 'flows.$[flow].disabled': true },
  },
  {
    arrayFilters: [{ 'flow.id': 'flow-office-docs' }],
  },
);
```

### Workflow 2: Customize Stage Config

```typescript
// User changes embedding model from text-embedding-3-small to text-embedding-3-large
await PipelineDefinition.findOneAndUpdate(
  { _id: pipelineId, tenantId },
  {
    $set: {
      'flows.$[flow].stages.$[stage].config.model': 'text-embedding-3-large',
      'flows.$[flow].stages.$[stage].config.dimensions': 3072,
    },
  },
  {
    arrayFilters: [{ 'flow.id': 'flow-pdf-docling' }, { 'stage.type': 'embedding' }],
  },
);
```

### Workflow 3: Add New Flow

```typescript
// User adds custom flow for SharePoint documents
await PipelineDefinition.findOneAndUpdate(
  { _id: pipelineId, tenantId },
  {
    $push: {
      flows: {
        id: `flow-${uuidv7()}`,
        name: 'SharePoint Documents',
        priority: 25,
        selectionRules: "sourceType == 'sharepoint'",
        stages: [
          /* custom stages */
        ],
      },
    },
  },
);
```

### Workflow 4: Clone and Modify

```typescript
// UI provides "Clone Flow" button
// User clones PDF flow, changes priority and selection rules
const clonedFlow = {
  ...originalFlow,
  id: `flow-${uuidv7()}`,
  name: 'PDF Documents (Large)',
  priority: 8,
  selectionRules: "contentType == 'application/pdf' && contentSizeBytes > 10485760",
};

await PipelineDefinition.findOneAndUpdate(
  { _id: pipelineId, tenantId },
  { $push: { flows: clonedFlow } },
);
```

---

## 9. Testing Strategy

### Unit Tests

```typescript
describe('Default Flow Templates', () => {
  it('should return 3 default flows', () => {
    const templates = getDefaultFlowTemplates();
    expect(templates).toHaveLength(3);
  });

  it('should generate unique IDs for each flow', () => {
    const templates1 = getDefaultFlowTemplates();
    const templates2 = getDefaultFlowTemplates();
    expect(templates1[0].id).not.toBe(templates2[0].id);
  });

  it('should customize embedding model', () => {
    const templates = getDefaultFlowTemplates();
    const customized = customizeFlowTemplates(templates, {
      embeddingModel: 'text-embedding-3-large',
      embeddingDimensions: 3072,
    });

    const embeddingStage = customized[0].stages.find((s) => s.type === 'embedding');
    expect(embeddingStage?.config.model).toBe('text-embedding-3-large');
    expect(embeddingStage?.config.dimensions).toBe(3072);
  });
});
```

### Integration Tests

```typescript
describe('Default Pipeline Creation', () => {
  it('should create default pipeline on index creation', async () => {
    const index = await SearchIndex.create({
      tenantId: 'test-tenant',
      projectId: 'test-project',
      slug: 'test-index',
      name: 'Test Index',
    });

    const pipeline = await PipelineDefinition.findOne({ indexId: index._id });
    expect(pipeline).toBeDefined();
    expect(pipeline.flows).toHaveLength(3);
    expect(pipeline.flows[0].priority).toBe(10);
    expect(pipeline.flows[1].priority).toBe(20);
    expect(pipeline.flows[2].priority).toBe(99);
  });

  it('should allow users to customize default flows', async () => {
    const pipeline = await PipelineDefinition.findOne({ indexId: 'test-index-id' });
    pipeline.flows[0].stages[0].config.extractTables = false;
    await pipeline.save();

    const updated = await PipelineDefinition.findById(pipeline._id);
    expect(updated.flows[0].stages[0].config.extractTables).toBe(false);
  });
});
```

---

## 10. Recommendations

### For MVP (Phase 1)

1. **Single default pipeline**: All indexes get same 3-flow pipeline
2. **3 default flows**: PDF (priority 10), Office (priority 20), Default (priority 99)
3. **User customization**: Allow editing, disabling, and deleting flows
4. **No smart selection**: Same defaults for all indexes

### For Phase 2

1. **Smart template selection**: Different defaults based on index metadata (legal, high-volume, etc.)
2. **More flow templates**: Add templates for large PDFs, images, web content, etc.
3. **Template marketplace**: Allow users to share custom flow templates
4. **Index-level overrides**: Allow index config to override default settings

### For Phase 3

1. **A/B testing**: Track which flows perform best for retrieval quality
2. **Auto-optimization**: Suggest flow improvements based on usage patterns
3. **Cost optimization**: Recommend cheaper flows based on budget constraints
4. **Template versioning**: Allow users to update flows when new templates released

---

## Conclusion

**Key Decisions:**

1. ✅ **3 default flows**: PDF (priority 10), Office (priority 20), Default (priority 99)
2. ✅ **Automatic instantiation**: Default pipeline created on index creation
3. ✅ **Smart defaults pattern**: Follow LLM config hierarchy (user > index > template)
4. ✅ **Template storage**: JSON objects in `packages/searchai-pipeline/src/templates/`
5. ✅ **User customization**: Allow editing, disabling, and deleting flows
6. ✅ **Unique IDs**: Generate unique flow/stage IDs on instantiation
7. ✅ **Index-level overrides**: Customize templates based on index config (embedding model, etc.)
8. ✅ **Priority ordering**: 10 (PDF), 20 (Office), 99 (Default)

**Next:** Implement default flow templates in design phase.

---

**Research complete.** Ready for design phase.
