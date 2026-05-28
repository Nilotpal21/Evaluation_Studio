import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockConnectorFindOne, mockSubscriptionFindOne, mockDecryptForTenantAuto, mockQueueAdd } =
  vi.hoisted(() => ({
    mockConnectorFindOne: vi.fn(),
    mockSubscriptionFindOne: vi.fn(),
    mockDecryptForTenantAuto: vi.fn(),
    mockQueueAdd: vi.fn(),
  }));

vi.mock('@agent-platform/database', () => ({
  ConnectorConfig: {
    findOne: (...args: unknown[]) => mockConnectorFindOne(...args),
  },
  WebhookSubscriptionConnector: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: unknown[]) => mockDecryptForTenantAuto(...args),
}));

vi.mock('../../workers/index.js', () => ({
  createQueue: vi.fn(() => ({
    add: (...args: unknown[]) => mockQueueAdd(...args),
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import webhookRouter from '../webhooks.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRouter);
  return app;
}

function buildPayload(clientState = 'client-state') {
  return {
    value: [
      {
        subscriptionId: 'sub-1',
        subscriptionExpirationDateTime: '2026-04-17T00:00:00.000Z',
        clientState,
        changeType: 'updated',
        resource: 'drives/drive-1/root',
      },
    ],
  };
}

describe('search-ai webhook audit classification', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();

    mockConnectorFindOne.mockResolvedValue({
      _id: 'connector-1',
      tenantId: 'tenant-1',
    });
    mockSubscriptionFindOne.mockResolvedValue({
      encryptedClientState: 'encrypted-client-state',
    });
    mockDecryptForTenantAuto.mockResolvedValue('client-state');
    mockQueueAdd.mockResolvedValue(undefined);
  });

  test('state-changing webhook batches queue work without duplicate connector audit', async () => {
    const response = await request(app)
      .post('/api/webhooks/connectors/connector-1/sharepoint')
      .send(buildPayload());

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      success: true,
      received: 1,
      validated: 1,
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'process-batch',
      expect.objectContaining({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
      }),
    );
  });

  test('invalid or non-actionable receipts stay operational-only', async () => {
    mockDecryptForTenantAuto.mockResolvedValue('different-client-state');

    const response = await request(app)
      .post('/api/webhooks/connectors/connector-1/sharepoint')
      .send(buildPayload());

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      success: true,
      received: 1,
      validated: 0,
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
