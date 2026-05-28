import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { ArchIntegrationDraft } from '../models/arch-integration-draft.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('IntegrationDraft new fields', () => {
  test('persists connectionIds[]', async () => {
    if (!isMongoReady()) return;

    const draft = await ArchIntegrationDraft.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      title: 'Slack Integration',
      providerKey: 'slack',
      source: 'in_project',
      status: 'draft',
      createdBy: 'user-1',
      connectionIds: ['conn_1', 'conn_2'],
    });
    const reloaded = await ArchIntegrationDraft.findOne({
      _id: draft._id,
      tenantId: 't1',
    });
    expect(reloaded?.connectionIds).toEqual(['conn_1', 'conn_2']);
  });

  test('persists test status fields', async () => {
    if (!isMongoReady()) return;

    const at = new Date();
    const draft = await ArchIntegrationDraft.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      title: 'Slack Integration',
      providerKey: 'slack',
      source: 'in_project',
      status: 'ready_to_test',
      createdBy: 'user-1',
      lastTestStatus: 'pass',
      lastTestAt: at,
      lastTestError: null,
      testHistory: [{ at, status: 'pass' }],
    });
    const reloaded = await ArchIntegrationDraft.findOne({
      _id: draft._id,
      tenantId: 't1',
    });
    expect(reloaded?.lastTestStatus).toBe('pass');
    expect(reloaded?.testHistory?.length).toBe(1);
  });

  test('caps testHistory at 5 entries with FIFO eviction', async () => {
    if (!isMongoReady()) return;

    const entries = Array.from({ length: 6 }, (_, i) => ({
      at: new Date(Date.now() - (6 - i) * 1000),
      status: i % 2 === 0 ? ('pass' as const) : ('fail' as const),
    }));
    const draft = await ArchIntegrationDraft.create({
      tenantId: 't1',
      projectId: 'p1',
      sessionId: 's1',
      title: 'Slack Integration',
      providerKey: 'slack',
      source: 'in_project',
      status: 'ready_to_test',
      createdBy: 'user-1',
      testHistory: entries,
    });
    expect(draft.testHistory?.length).toBe(5);
    expect(draft.testHistory?.[0]?.at.getTime()).toBe(entries[1].at.getTime());
  });
});
