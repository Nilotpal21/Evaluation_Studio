import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { JobExecution } from '../models/job-execution.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validJobExecution = () => ({
  tenantId: 'tenant-1',
  bullJobId: 'bull-123',
  workerStage: 'docling-extraction' as const,
  documentId: 'doc-1',
  sourceId: 'source-1',
  indexId: 'index-1',
  status: 'pending' as const,
  startedAt: new Date(),
});

describe('JobExecution', () => {
  it('sets default fields on instantiation', () => {
    const job = new JobExecution(validJobExecution());
    expect(job._id).toBeDefined();
    expect(job.tenantId).toBe('tenant-1');
    expect(job.bullJobId).toBe('bull-123');
    expect(job.workerStage).toBe('docling-extraction');
    expect(job.documentId).toBe('doc-1');
    expect(job.sourceId).toBe('source-1');
    expect(job.indexId).toBe('index-1');
    expect(job.status).toBe('pending');
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it('requires tenantId', () => {
    const data = validJobExecution();
    delete (data as any).tenantId;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires bullJobId', () => {
    const data = validJobExecution();
    delete (data as any).bullJobId;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.bullJobId).toBeDefined();
  });

  it('requires workerStage', () => {
    const data = validJobExecution();
    delete (data as any).workerStage;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.workerStage).toBeDefined();
  });

  it('requires documentId', () => {
    const data = validJobExecution();
    delete (data as any).documentId;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.documentId).toBeDefined();
  });

  it('requires sourceId', () => {
    const data = validJobExecution();
    delete (data as any).sourceId;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.sourceId).toBeDefined();
  });

  it('requires indexId', () => {
    const data = validJobExecution();
    delete (data as any).indexId;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.indexId).toBeDefined();
  });

  it('validates workerStage enum', () => {
    const data = validJobExecution();
    data.workerStage = 'invalid' as any;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.workerStage).toBeDefined();
  });

  it('accepts valid workerStage values', () => {
    const stages = [
      'connector-discovery',
      'connector-ingestion',
      'docling-extraction',
      'tree-building',
      'embedding',
      'enrichment',
      'multimodal',
      'storage',
    ];

    for (const stage of stages) {
      const data = validJobExecution();
      data.workerStage = stage as any;
      const err = new JobExecution(data).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates status enum', () => {
    const data = validJobExecution();
    data.status = 'invalid' as any;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    for (const status of ['pending', 'running', 'completed', 'failed']) {
      const data = validJobExecution();
      data.status = status as any;
      const job = new JobExecution(data);
      const err = job.validateSync();
      expect(err).toBeUndefined();
      expect(job.status).toBe(status);
    }
  });

  it('defaults status to pending', () => {
    const data = validJobExecution();
    delete (data as any).status;
    const job = new JobExecution(data);
    expect(job.status).toBe('pending');
  });

  it('stores optional completedAt and duration', () => {
    const data = validJobExecution();
    data.completedAt = new Date();
    data.duration = 5000;

    const job = new JobExecution(data);
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.duration).toBe(5000);
  });

  it('validates duration is non-negative', () => {
    const data = validJobExecution();
    data.duration = -100;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.duration).toBeDefined();
  });

  it('stores error object with code, message, and stack', () => {
    const data = validJobExecution();
    data.error = {
      code: 'EXTRACTION_FAILED',
      message: 'Failed to extract text from PDF',
      stack: 'Error: Failed...\n  at extractText...',
    };

    const job = new JobExecution(data);
    const err = job.validateSync();
    expect(err).toBeUndefined();
    expect(job.error!.code).toBe('EXTRACTION_FAILED');
    expect(job.error!.message).toBe('Failed to extract text from PDF');
    expect(job.error!.stack).toBeDefined();
  });

  it('stores error object without optional stack', () => {
    const data = validJobExecution();
    data.error = {
      code: 'TIMEOUT',
      message: 'Job timed out after 30s',
    };

    const job = new JobExecution(data);
    expect(job.error!.code).toBe('TIMEOUT');
    expect(job.error!.message).toBe('Job timed out after 30s');
    expect(job.error!.stack).toBeUndefined();
  });

  it('stores metrics as arbitrary object', () => {
    const data = validJobExecution();
    data.metrics = {
      pagesExtracted: 10,
      avgConfidence: 0.95,
      processingTime: 5000,
    };

    const job = new JobExecution(data);
    expect(job.metrics).toEqual({
      pagesExtracted: 10,
      avgConfidence: 0.95,
      processingTime: 5000,
    });
  });

  it('stores optional traceId', () => {
    const data = validJobExecution();
    data.traceId = 'trace-abc-123';

    const job = new JobExecution(data);
    expect(job.traceId).toBe('trace-abc-123');
  });

  it('stores BullMQ Flows fields', () => {
    const data = validJobExecution();
    data.pipelineId = 'pipeline-1';
    data.pipelineVersion = 2;
    data.flowJobId = 'flow-job-123';

    const job = new JobExecution(data);
    const err = job.validateSync();
    expect(err).toBeUndefined();
    expect(job.pipelineId).toBe('pipeline-1');
    expect(job.pipelineVersion).toBe(2);
    expect(job.flowJobId).toBe('flow-job-123');
  });

  it('validates pipelineVersion is positive', () => {
    const data = validJobExecution();
    data.pipelineVersion = 0;
    const err = new JobExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.pipelineVersion).toBeDefined();
  });

  it('sets timestamps on creation', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const job = await JobExecution.create(validJobExecution());
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.updatedAt).toBeInstanceOf(Date);
    expect(job.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('enforces unique tenantId+bullJobId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await JobExecution.create(validJobExecution());
    await expect(JobExecution.create(validJobExecution())).rejects.toThrow(/duplicate key/i);
  });

  it('allows same bullJobId for different tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await JobExecution.create(validJobExecution());
    const otherTenant = {
      ...validJobExecution(),
      tenantId: 'tenant-2',
    };
    const job = await JobExecution.create(otherTenant);
    expect(job.tenantId).toBe('tenant-2');
    expect(job.bullJobId).toBe('bull-123');
  });

  it('has TTL index on createdAt field', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const indexes = await JobExecution.collection.indexes();
    const ttlIndex = indexes.find((index) => index.name === 'ttl_createdAt_90days');

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex!.key).toEqual({ createdAt: 1 });
    expect(ttlIndex!.expireAfterSeconds).toBe(7776000); // 90 days
  });

  it('has unique index on tenantId+bullJobId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const indexes = await JobExecution.collection.indexes();
    const uniqueIndex = indexes.find(
      (index) => index.key.tenantId === 1 && index.key.bullJobId === 1 && index.unique === true,
    );

    expect(uniqueIndex).toBeDefined();
  });

  it('has compound index for document history', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const indexes = await JobExecution.collection.indexes();
    const docHistoryIndex = indexes.find(
      (index) =>
        index.key.tenantId === 1 && index.key.documentId === 1 && index.key.createdAt === -1,
    );

    expect(docHistoryIndex).toBeDefined();
  });

  it('has compound index for source summary', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const indexes = await JobExecution.collection.indexes();
    const sourceIndex = indexes.find(
      (index) => index.key.tenantId === 1 && index.key.sourceId === 1 && index.key.status === 1,
    );

    expect(sourceIndex).toBeDefined();
  });

  it('has BullMQ Flows indexes', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    const indexes = await JobExecution.collection.indexes();

    // Index 1: (pipelineId, flowJobId)
    const flowIndex = indexes.find(
      (index) => index.key.pipelineId === 1 && index.key.flowJobId === 1,
    );
    expect(flowIndex).toBeDefined();

    // Index 2: (pipelineId, pipelineVersion, status)
    const pipelineIndex = indexes.find(
      (index) =>
        index.key.pipelineId === 1 && index.key.pipelineVersion === 1 && index.key.status === 1,
    );
    expect(pipelineIndex).toBeDefined();
  });

  it('allows querying jobs by documentId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await JobExecution.create({ ...validJobExecution(), bullJobId: 'job-1' });
    await JobExecution.create({
      ...validJobExecution(),
      bullJobId: 'job-2',
      documentId: 'doc-2',
    });

    const jobs = await JobExecution.find({ tenantId: 'tenant-1', documentId: 'doc-1' }).sort({
      createdAt: -1,
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].documentId).toBe('doc-1');
  });

  it('allows querying jobs by sourceId and status', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await JobExecution.create({
      ...validJobExecution(),
      bullJobId: 'job-1',
      status: 'completed',
    });
    await JobExecution.create({ ...validJobExecution(), bullJobId: 'job-2', status: 'failed' });

    const completedJobs = await JobExecution.find({
      tenantId: 'tenant-1',
      sourceId: 'source-1',
      status: 'completed',
    });

    expect(completedJobs).toHaveLength(1);
    expect(completedJobs[0].status).toBe('completed');
  });

  it('allows querying flows by pipelineId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();

    await JobExecution.create({
      ...validJobExecution(),
      bullJobId: 'job-1',
      pipelineId: 'pipeline-1',
      flowJobId: 'flow-123',
    });
    await JobExecution.create({
      ...validJobExecution(),
      bullJobId: 'job-2',
      pipelineId: 'pipeline-2',
      flowJobId: 'flow-456',
    });

    const pipelineJobs = await JobExecution.find({ pipelineId: 'pipeline-1' });

    expect(pipelineJobs).toHaveLength(1);
    expect(pipelineJobs[0].pipelineId).toBe('pipeline-1');
    expect(pipelineJobs[0].flowJobId).toBe('flow-123');
  });
});
