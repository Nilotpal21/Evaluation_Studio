import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { SearchPipelineDefinition } from '../models/search-pipeline-definition.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validPipeline = () => ({
  tenantId: 'tenant-1',
  knowledgeBaseId: 'kb-1',
  name: 'Default Pipeline',
  description: 'Test pipeline',
  createdBy: 'user-1',
  flows: [
    {
      id: 'flow-1',
      name: 'PDF Flow',
      description: 'Flow for PDF documents',
      enabled: true,
      priority: 10,
      stages: [
        {
          id: 'stage-1',
          name: 'Extract Text',
          type: 'extraction' as const,
          provider: 'docling',
          providerConfig: { model: 'v2' },
          onError: 'fail' as const,
        },
      ],
    },
  ],
});

describe('SearchPipelineDefinition', () => {
  it('sets default fields on instantiation', () => {
    const pipeline = new SearchPipelineDefinition(validPipeline());
    expect(pipeline._id).toBeDefined();
    expect(pipeline.tenantId).toBe('tenant-1');
    expect(pipeline.knowledgeBaseId).toBe('kb-1');
    expect(pipeline.name).toBe('Default Pipeline');
    expect(pipeline.description).toBe('Test pipeline');
    expect(pipeline.createdBy).toBe('user-1');
    expect(pipeline.version).toBe(1);
    expect(pipeline.status).toBe('draft');
    expect(pipeline.flows).toHaveLength(1);
    expect(pipeline.flows[0].id).toBe('flow-1');
    // activeEmbeddingConfig defaults to BGE-M3
    expect(pipeline.activeEmbeddingConfig).toBeDefined();
    expect(pipeline.activeEmbeddingConfig.provider).toBe('bge-m3');
    expect(pipeline.activeEmbeddingConfig.model).toBe('bge-m3');
    expect(pipeline.activeEmbeddingConfig.dimensions).toBe(1024);
  });

  it('requires tenantId', () => {
    const data = validPipeline();
    delete (data as any).tenantId;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires knowledgeBaseId', () => {
    const data = validPipeline();
    delete (data as any).knowledgeBaseId;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.knowledgeBaseId).toBeDefined();
  });

  it('requires name', () => {
    const data = validPipeline();
    delete (data as any).name;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.name).toBeDefined();
  });

  it('requires createdBy', () => {
    const data = validPipeline();
    delete (data as any).createdBy;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.createdBy).toBeDefined();
  });

  it('validates status enum', () => {
    const err = new SearchPipelineDefinition({
      ...validPipeline(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    for (const status of ['draft', 'active', 'archived']) {
      const pipeline = new SearchPipelineDefinition({ ...validPipeline(), status });
      const err = pipeline.validateSync();
      expect(err).toBeUndefined();
      expect(pipeline.status).toBe(status);
    }
  });

  it('accepts valid validationStatus values', () => {
    for (const validationStatus of ['valid', 'invalid', 'pending']) {
      const pipeline = new SearchPipelineDefinition({ ...validPipeline(), validationStatus });
      const err = pipeline.validateSync();
      expect(err).toBeUndefined();
      expect(pipeline.validationStatus).toBe(validationStatus);
    }
  });

  it('requires at least one flow', () => {
    const data = validPipeline();
    data.flows = [];
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.flows).toBeDefined();
  });

  it('enforces max 50 flows', () => {
    const data = validPipeline();
    data.flows = Array.from({ length: 51 }, (_, i) => ({
      id: `flow-${i}`,
      name: `Flow ${i}`,
      enabled: true,
      priority: i,
      stages: [
        {
          id: `stage-${i}`,
          name: `Stage ${i}`,
          type: 'extraction' as const,
          provider: 'docling',
          providerConfig: {},
          onError: 'fail' as const,
        },
      ],
    }));
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.flows).toBeDefined();
  });

  it('requires at least one stage per flow', () => {
    const data = validPipeline();
    data.flows[0].stages = [];
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['flows.0.stages']).toBeDefined();
  });

  it('validates stage type enum', () => {
    const data = validPipeline();
    data.flows[0].stages[0].type = 'invalid' as any;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['flows.0.stages.0.type']).toBeDefined();
  });

  it('accepts valid stage types', () => {
    const types = ['extraction', 'chunking', 'enrichment', 'embedding', 'multimodal'];
    for (const type of types) {
      const data = validPipeline();
      data.flows[0].stages[0].type = type as any;
      const err = new SearchPipelineDefinition(data).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates onError enum', () => {
    const data = validPipeline();
    data.flows[0].stages[0].onError = 'invalid' as any;
    const err = new SearchPipelineDefinition(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['flows.0.stages.0.onError']).toBeDefined();
  });

  it('accepts valid onError values', () => {
    for (const onError of ['fail', 'continue']) {
      const data = validPipeline();
      data.flows[0].stages[0].onError = onError as any;
      const err = new SearchPipelineDefinition(data).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('stores rule conditions with simple type', () => {
    const data = validPipeline();
    data.flows[0].selectionRules = [
      {
        type: 'simple' as const,
        field: 'document.extension',
        operator: 'eq' as const,
        value: 'pdf',
      },
    ];
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.flows[0].selectionRules).toHaveLength(1);
    expect(pipeline.flows[0].selectionRules![0].type).toBe('simple');
    expect(pipeline.flows[0].selectionRules![0].field).toBe('document.extension');
  });

  it('stores rule conditions with compound type', () => {
    const data = validPipeline();
    data.flows[0].selectionRules = [
      {
        type: 'compound' as const,
        logic: 'AND' as const,
        conditions: [
          {
            type: 'simple' as const,
            field: 'document.extension',
            operator: 'eq' as const,
            value: 'pdf',
          },
          {
            type: 'simple' as const,
            field: 'document.size',
            operator: 'lt' as const,
            value: 10000000,
          },
        ],
      },
    ];
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.flows[0].selectionRules).toHaveLength(1);
    expect(pipeline.flows[0].selectionRules![0].type).toBe('compound');
    expect(pipeline.flows[0].selectionRules![0].logic).toBe('AND');
    expect(pipeline.flows[0].selectionRules![0].conditions).toHaveLength(2);
  });

  it('stores rule conditions with cel type', () => {
    const data = validPipeline();
    data.flows[0].selectionRules = [
      {
        type: 'cel' as const,
        celExpression: 'document.extension == "pdf" && document.size < 10000000',
      },
    ];
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.flows[0].selectionRules).toHaveLength(1);
    expect(pipeline.flows[0].selectionRules![0].type).toBe('cel');
    expect(pipeline.flows[0].selectionRules![0].celExpression).toBe(
      'document.extension == "pdf" && document.size < 10000000',
    );
  });

  it('stores validation errors', () => {
    const data = validPipeline();
    data.validationErrors = [
      {
        code: 'INVALID_STAGE_SEQUENCE',
        message: 'Embedding before chunking',
        severity: 'error' as const,
        path: 'flows.0.stages.1',
      },
    ];
    const pipeline = new SearchPipelineDefinition(data);
    expect(pipeline.validationErrors).toHaveLength(1);
    expect(pipeline.validationErrors![0].code).toBe('INVALID_STAGE_SEQUENCE');
    expect(pipeline.validationErrors![0].severity).toBe('error');
  });

  it('stores optional stage fields', () => {
    const data = validPipeline();
    data.flows[0].stages[0].fallbackProvider = 'docling-v1';
    data.flows[0].stages[0].fallbackConfig = { model: 'v1' };
    data.flows[0].stages[0].executionCondition = 'document.size > 1000';
    data.flows[0].stages[0].requiredProviderVersion = '>=2.0.0';
    data.flows[0].stages[0].description = 'Extract text from PDF';
    data.flows[0].stages[0].estimatedDuration = 5000;
    data.flows[0].stages[0].estimatedCost = 0.01;

    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.flows[0].stages[0].fallbackProvider).toBe('docling-v1');
    expect(pipeline.flows[0].stages[0].fallbackConfig).toEqual({ model: 'v1' });
    expect(pipeline.flows[0].stages[0].executionCondition).toBe('document.size > 1000');
    expect(pipeline.flows[0].stages[0].description).toBe('Extract text from PDF');
  });

  it('stores sharedStages with enrichment', () => {
    const data = validPipeline();
    data.sharedStages = {
      enrichment: [
        {
          id: 'shared-1',
          name: 'Shared Enrichment',
          type: 'enrichment' as const,
          provider: 'llm',
          providerConfig: {},
          onError: 'continue' as const,
        },
      ],
      indexing: [
        {
          id: 'shared-2',
          name: 'Shared Indexing',
          type: 'embedding' as const,
          provider: 'bge-m3',
          providerConfig: {},
          onError: 'fail' as const,
        },
      ],
    };
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.sharedStages!.enrichment).toHaveLength(1);
    expect(pipeline.sharedStages!.enrichment![0].name).toBe('Shared Enrichment');
    expect(pipeline.sharedStages!.indexing).toHaveLength(1);
  });

  it('increments version on update', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const pipeline = await SearchPipelineDefinition.create(validPipeline());
    expect(pipeline.version).toBe(1);

    pipeline.name = 'Updated Pipeline';
    await pipeline.save();
    expect(pipeline.version).toBe(2);

    pipeline.description = 'Updated description';
    await pipeline.save();
    expect(pipeline.version).toBe(3);
  });

  it('enforces unique tenantId+knowledgeBaseId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await SearchPipelineDefinition.create(validPipeline());
    await expect(SearchPipelineDefinition.create(validPipeline())).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it('allows same knowledgeBaseId for different tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await SearchPipelineDefinition.create(validPipeline());
    const otherTenant = {
      ...validPipeline(),
      tenantId: 'tenant-2',
    };
    const doc = await SearchPipelineDefinition.create(otherTenant);
    expect(doc.tenantId).toBe('tenant-2');
    expect(doc.knowledgeBaseId).toBe('kb-1');
  });

  it('requires at least one enabled flow on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const data = validPipeline();
    data.flows[0].enabled = false;

    await expect(SearchPipelineDefinition.create(data)).rejects.toThrow(
      /Pipeline must have at least one enabled flow/i,
    );
  });

  it('allows multiple flows with different priorities', () => {
    const data = validPipeline();
    data.flows.push({
      id: 'flow-2',
      name: 'DOCX Flow',
      enabled: true,
      priority: 20,
      stages: [
        {
          id: 'stage-2',
          name: 'Extract DOCX',
          type: 'extraction' as const,
          provider: 'docling',
          providerConfig: {},
          onError: 'fail' as const,
        },
      ],
    });

    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.flows).toHaveLength(2);
    expect(pipeline.flows[0].priority).toBe(10);
    expect(pipeline.flows[1].priority).toBe(20);
  });

  it('stores providerDefaults at pipeline level', () => {
    const data = validPipeline();
    data.providerDefaults = {
      docling: { timeout: 30000 },
      'bge-m3': { batchSize: 100 },
    };

    const pipeline = new SearchPipelineDefinition(data);
    expect(pipeline.providerDefaults).toEqual({
      docling: { timeout: 30000 },
      'bge-m3': { batchSize: 100 },
    });
  });

  it('stores providerDefaults at flow level', () => {
    const data = validPipeline();
    data.flows[0].providerDefaults = {
      docling: { model: 'v2' },
    };

    const pipeline = new SearchPipelineDefinition(data);
    expect(pipeline.flows[0].providerDefaults).toEqual({
      docling: { model: 'v2' },
    });
  });

  it('sets timestamps on flows', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const pipeline = await SearchPipelineDefinition.create(validPipeline());
    expect(pipeline.flows[0].createdAt).toBeInstanceOf(Date);
    expect(pipeline.flows[0].updatedAt).toBeInstanceOf(Date);
  });

  // ─── activeEmbeddingConfig tests ────────────────────────────────────────

  it('accepts custom activeEmbeddingConfig', () => {
    const data = {
      ...validPipeline(),
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
    };
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.activeEmbeddingConfig.provider).toBe('openai');
    expect(pipeline.activeEmbeddingConfig.model).toBe('text-embedding-3-small');
    expect(pipeline.activeEmbeddingConfig.dimensions).toBe(1536);
  });

  it('accepts all valid embedding provider types', () => {
    for (const provider of ['openai', 'cohere', 'bge-m3', 'custom']) {
      const data = {
        ...validPipeline(),
        activeEmbeddingConfig: {
          provider,
          model: 'test-model',
          dimensions: 512,
        },
      };
      const pipeline = new SearchPipelineDefinition(data);
      const err = pipeline.validateSync();
      expect(err).toBeUndefined();
      expect(pipeline.activeEmbeddingConfig.provider).toBe(provider);
    }
  });

  it('rejects invalid embedding provider type', () => {
    const data = {
      ...validPipeline(),
      activeEmbeddingConfig: {
        provider: 'invalid-provider',
        model: 'test',
        dimensions: 512,
      },
    };
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['activeEmbeddingConfig.provider']).toBeDefined();
  });

  it('rejects dimensions less than 1', () => {
    const data = {
      ...validPipeline(),
      activeEmbeddingConfig: {
        provider: 'bge-m3',
        model: 'bge-m3',
        dimensions: 0,
      },
    };
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['activeEmbeddingConfig.dimensions']).toBeDefined();
  });

  it('stores optional providerConfig in activeEmbeddingConfig', () => {
    const data = {
      ...validPipeline(),
      activeEmbeddingConfig: {
        provider: 'custom',
        model: 'my-model',
        dimensions: 768,
        providerConfig: { baseUrl: 'http://my-service:8000', timeout: 30000 },
      },
    };
    const pipeline = new SearchPipelineDefinition(data);
    const err = pipeline.validateSync();
    expect(err).toBeUndefined();
    expect(pipeline.activeEmbeddingConfig.providerConfig).toEqual({
      baseUrl: 'http://my-service:8000',
      timeout: 30000,
    });
  });

  it('persists activeEmbeddingConfig to database', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const data = {
      ...validPipeline(),
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      },
    };
    const created = await SearchPipelineDefinition.create(data);
    const found = await SearchPipelineDefinition.findOne({
      tenantId: 'tenant-1',
      knowledgeBaseId: 'kb-1',
    });
    expect(found).toBeDefined();
    expect(found!.activeEmbeddingConfig.provider).toBe('openai');
    expect(found!.activeEmbeddingConfig.model).toBe('text-embedding-3-large');
    expect(found!.activeEmbeddingConfig.dimensions).toBe(3072);
  });
});
