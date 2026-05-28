import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { WorkflowExecution } from '../models/workflow-execution.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('WorkflowExecution model — version tracking', () => {
  it('stores restateWorkflowId for execution correlation', async ({ skip }) => {
    requireMongo(skip);
    const doc = await WorkflowExecution.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: 'wf-1',
      triggerType: 'studio',
      restateWorkflowId: 'rst-version-track-1',
      startedAt: new Date(),
    });
    const fetched = await WorkflowExecution.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();
    expect(fetched!.restateWorkflowId).toBe('rst-version-track-1');
  });

  it('allows omitting restateWorkflowId', async ({ skip }) => {
    requireMongo(skip);
    const doc = await WorkflowExecution.create({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      workflowId: 'wf-1',
      triggerType: 'studio',
      startedAt: new Date(),
    });
    const fetched = await WorkflowExecution.findOne({
      _id: doc._id,
      tenantId: 'tenant-1',
    }).lean();
    expect(fetched!.restateWorkflowId).toBeUndefined();
  });
});
