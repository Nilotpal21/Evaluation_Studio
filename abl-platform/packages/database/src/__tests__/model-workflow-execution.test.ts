import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { EXECUTION_STATUSES, WorkflowExecution } from '../models/workflow-execution.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

const validExecution = () => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  workflowId: 'wf-1',
  triggerType: 'studio' as const,
  status: 'running' as const,
  input: { orderId: 'ORD-123' },
  context: {},
  startedAt: new Date(),
});

describe('WorkflowExecution', () => {
  it('sets default fields on instantiation', () => {
    const exec = new WorkflowExecution(validExecution());
    expect(exec._id).toBeDefined();
    expect(exec.tenantId).toBe('tenant-1');
    expect(exec.projectId).toBe('proj-1');
    expect(exec.workflowId).toBe('wf-1');
    expect(exec.triggerType).toBe('studio');
    expect(exec.status).toBe('running');
    expect(exec.input).toEqual({ orderId: 'ORD-123' });
    expect(exec.context).toEqual({});
  });

  it('requires tenantId', () => {
    const data = validExecution();
    delete (data as any).tenantId;
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.tenantId).toBeDefined();
  });

  it('requires projectId', () => {
    const data = validExecution();
    delete (data as any).projectId;
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.projectId).toBeDefined();
  });

  it('requires workflowId', () => {
    const data = validExecution();
    delete (data as any).workflowId;
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.workflowId).toBeDefined();
  });

  it('requires triggerType', () => {
    const data = validExecution();
    delete (data as any).triggerType;
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerType).toBeDefined();
  });

  it('does not require restateWorkflowId (optional)', () => {
    const data = validExecution();
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeUndefined();
  });

  it('requires startedAt', () => {
    const data = validExecution();
    delete (data as any).startedAt;
    const err = new WorkflowExecution(data).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.startedAt).toBeDefined();
  });

  it('validates triggerType enum', () => {
    const err = new WorkflowExecution({
      ...validExecution(),
      triggerType: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.triggerType).toBeDefined();
  });

  it('accepts valid triggerType values', () => {
    for (const triggerType of ['webhook', 'cron', 'event', 'studio', 'agent']) {
      const err = new WorkflowExecution({ ...validExecution(), triggerType }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('validates status enum', () => {
    const err = new WorkflowExecution({
      ...validExecution(),
      status: 'invalid',
    }).validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });

  it('accepts valid status values', () => {
    for (const status of EXECUTION_STATUSES) {
      const err = new WorkflowExecution({ ...validExecution(), status }).validateSync();
      expect(err).toBeUndefined();
    }
  });

  it('stores execution error metadata', () => {
    const exec = new WorkflowExecution({
      ...validExecution(),
      status: 'failed',
      error: { code: 'NODE_FAILED', message: 'A step failed' },
    });
    expect(exec.error?.code).toBe('NODE_FAILED');
  });

  it('stores optional restateWorkflowId', () => {
    const exec = new WorkflowExecution({
      ...validExecution(),
      restateWorkflowId: 'restate-exec-abc',
    });
    expect(exec.restateWorkflowId).toBe('restate-exec-abc');
  });

  it('stores input and output as Mixed', () => {
    const exec = new WorkflowExecution({
      ...validExecution(),
      input: { complex: { nested: [1, 2, 3] } },
      output: { result: 'success', data: { count: 42 } },
    });
    expect(exec.input).toEqual({ complex: { nested: [1, 2, 3] } });
    expect(exec.output).toEqual({ result: 'success', data: { count: 42 } });
  });

  it('defaults input and context to empty objects', () => {
    const exec = new WorkflowExecution({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: 'wf-1',
      triggerType: 'studio',
      startedAt: new Date(),
    });
    expect(exec.input).toEqual({});
    expect(exec.context).toEqual({});
  });

  it('enforces unique restateWorkflowId per tenant', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await WorkflowExecution.create({
      ...validExecution(),
      restateWorkflowId: 'restate-unique-1',
    });
    await expect(
      WorkflowExecution.create({
        ...validExecution(),
        restateWorkflowId: 'restate-unique-1',
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('allows same restateWorkflowId for different tenants', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await WorkflowExecution.create({
      ...validExecution(),
      restateWorkflowId: 'restate-cross-tenant',
    });
    const doc = await WorkflowExecution.create({
      ...validExecution(),
      tenantId: 'tenant-2',
      restateWorkflowId: 'restate-cross-tenant',
    });
    expect(doc.tenantId).toBe('tenant-2');
  });

  it('allows multiple executions with different restateWorkflowIds per tenant', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    // The compound unique index { tenantId, restateWorkflowId } allows different
    // restateWorkflowIds within the same tenant.
    const exec1 = await WorkflowExecution.create({
      ...validExecution(),
      restateWorkflowId: 'restate-a',
    });
    const exec2 = await WorkflowExecution.create({
      ...validExecution(),
      restateWorkflowId: 'restate-b',
    });
    expect(exec1._id).not.toBe(exec2._id);
  });
});
