import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { Deployment } from '../models/deployment.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('Deployment model — workflowVersionManifest', () => {
  it('stores workflowVersionManifest alongside agentVersionManifest', async ({ skip }) => {
    requireMongo(skip);
    const doc = await Deployment.create({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'dev',
      agentVersionManifest: { main_agent: '1.0.0' },
      workflowVersionManifest: { order_processing: '0.1.0' },
      entryAgentName: 'main_agent',
      endpointSlug: 'test-slug-wvm-1',
      createdBy: 'user-1',
    });
    const fetched = await Deployment.findById(doc._id).lean();
    expect(fetched!.workflowVersionManifest).toEqual({ order_processing: '0.1.0' });
    expect(fetched!.agentVersionManifest).toEqual({ main_agent: '1.0.0' });
  });

  it('defaults workflowVersionManifest to empty object when not provided', async ({ skip }) => {
    requireMongo(skip);
    const doc = await Deployment.create({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'staging',
      agentVersionManifest: { main_agent: '1.0.0' },
      entryAgentName: 'main_agent',
      endpointSlug: 'test-slug-wvm-2',
      createdBy: 'user-1',
    });
    // Use hydrated document (not .lean()) to verify Mongoose default applies
    const fetched = await Deployment.findById(doc._id);
    expect(fetched!.workflowVersionManifest).toEqual({});
  });
});
