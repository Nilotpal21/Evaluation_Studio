import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  mockGetNotificationConfig,
  mockUpdateNotificationConfig,
  mockTestWebhook,
  mockQueueAuditEntry,
} = vi.hoisted(() => ({
  mockGetNotificationConfig: vi.fn(),
  mockUpdateNotificationConfig: vi.fn(),
  mockTestWebhook: vi.fn(),
  mockQueueAuditEntry: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../../services/connector-notification.service.js', () => ({
  getNotificationConfig: (...args: unknown[]) => mockGetNotificationConfig(...args),
  updateNotificationConfig: (...args: unknown[]) => mockUpdateNotificationConfig(...args),
  testWebhook: (...args: unknown[]) => mockTestWebhook(...args),
}));

vi.mock('../../services/connector-audit.service.js', () => ({
  queueAuditEntry: (...args: unknown[]) => mockQueueAuditEntry(...args),
}));

vi.mock('../searchai-route-ownership.js', () => ({
  requireConnectorIndexAccessFromParams: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock('../../services/connector.service.js', () => ({
  ConnectorError: class ConnectorError extends Error {
    statusCode: number;
    code: string;

    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import notificationsRouter from '../connector-notifications.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantContext = {
      tenantId: 'tenant-1',
      userId: 'user-1',
    } as any;
    next();
  });
  app.use('/api/indexes', notificationsRouter);
  return app;
}

describe('connector notification audit routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  test('notification update emits durable connector audit', async () => {
    mockUpdateNotificationConfig.mockResolvedValue({
      emailAlertsEnabled: true,
      emailEvents: ['sync_failure'],
      webhookUrl: 'https://example.com/webhook',
      webhookEvents: ['sync_complete'],
    });

    const response = await request(app)
      .put('/api/indexes/index-1/connectors/connector-1/notifications')
      .send({
        emailAlertsEnabled: true,
        emailEvents: ['sync_failure'],
        webhookUrl: 'https://example.com/webhook',
        webhookEvents: ['sync_complete'],
      });

    expect(response.status).toBe(200);
    expect(mockUpdateNotificationConfig).toHaveBeenCalledWith('connector-1', 'tenant-1', {
      emailAlertsEnabled: true,
      emailEvents: ['sync_failure'],
      webhookUrl: 'https://example.com/webhook',
      webhookEvents: ['sync_complete'],
    });
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
        actor: 'user-1',
        event: 'notification.updated',
        category: 'config',
      }),
    );
  });

  test('test webhook emits durable connector audit without breaking the response', async () => {
    mockTestWebhook.mockResolvedValue({
      success: false,
      statusCode: 500,
      error: 'HTTP 500 Internal Server Error',
    });

    const response = await request(app)
      .post('/api/indexes/index-1/connectors/connector-1/notifications/test-webhook')
      .send({ url: 'https://example.com/webhook' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      success: false,
      statusCode: 500,
      error: 'HTTP 500 Internal Server Error',
    });
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'connector-1',
        event: 'notification.webhook_tested',
        category: 'config',
      }),
    );
  });

  test('tenant isolation is preserved for notification updates', async () => {
    mockUpdateNotificationConfig.mockResolvedValue({
      emailAlertsEnabled: false,
      emailEvents: [],
      webhookUrl: null,
      webhookEvents: [],
    });

    await request(app)
      .put('/api/indexes/index-1/connectors/connector-1/notifications')
      .send({ emailAlertsEnabled: false });

    expect(mockUpdateNotificationConfig).toHaveBeenCalledWith(
      'connector-1',
      'tenant-1',
      expect.objectContaining({ emailAlertsEnabled: false }),
    );
    expect(mockQueueAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
      }),
    );
  });
});
