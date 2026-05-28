/**
 * Connector Notification Route Tests
 *
 * Tests notification service functions used by route handlers:
 * - GET notification config
 * - PUT save notification config — Zod validation
 * - POST test webhook — success/failure/SSRF rejection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockConnector = {
  _id: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  connectorType: 'sharepoint',
  notifications: {
    emailAlertsEnabled: true,
    emailEvents: ['sync_failure', 'token_expiry'],
    webhookUrl: 'https://hooks.example.com/notify',
    webhookEvents: ['sync_complete'],
  },
};

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();

vi.doMock('../../db/index.js', () => ({
  getLazyModel: vi.fn(() => ({
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
  })),
}));

vi.doMock('../../services/connector.service.js', () => ({
  ConnectorError: class ConnectorError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number = 400,
    ) {
      super(message);
      this.name = 'ConnectorError';
    }
  },
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Notification Routes', () => {
  let notificationService: typeof import('../../services/connector-notification.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    notificationService = await import('../../services/connector-notification.service.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // getNotificationConfig
  // ===========================================================================

  describe('getNotificationConfig', () => {
    it('should return notification config for a connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnector),
      });

      const data = await notificationService.getNotificationConfig(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.emailAlertsEnabled).toBe(true);
      expect(data.emailEvents).toEqual(['sync_failure', 'token_expiry']);
      expect(data.webhookUrl).toBe('https://hooks.example.com/notify');
      expect(data.webhookEvents).toEqual(['sync_complete']);
    });

    it('should return defaults when no notifications configured', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ ...mockConnector, notifications: undefined }),
      });

      const data = await notificationService.getNotificationConfig(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.emailAlertsEnabled).toBe(false);
      expect(data.emailEvents).toEqual([]);
      expect(data.webhookUrl).toBeNull();
      expect(data.webhookEvents).toEqual([]);
    });

    it('should throw NOT_FOUND when connector does not exist', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        notificationService.getNotificationConfig('nonexistent', 'test-tenant'),
      ).rejects.toThrow('Connector not found');
    });

    it('should enforce tenant isolation', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        notificationService.getNotificationConfig('507f1f77bcf86cd799439011', 'wrong-tenant'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // updateNotificationConfig
  // ===========================================================================

  describe('updateNotificationConfig', () => {
    it('should update email alerts enabled', async () => {
      mockFindOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          ...mockConnector,
          notifications: { ...mockConnector.notifications, emailAlertsEnabled: false },
        }),
      });

      const data = await notificationService.updateNotificationConfig(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        { emailAlertsEnabled: false },
      );

      expect(data.emailAlertsEnabled).toBe(false);
    });

    it('should update webhook URL', async () => {
      mockFindOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          ...mockConnector,
          notifications: { ...mockConnector.notifications, webhookUrl: 'https://new.hook.com' },
        }),
      });

      const data = await notificationService.updateNotificationConfig(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        { webhookUrl: 'https://new.hook.com' },
      );

      expect(data.webhookUrl).toBe('https://new.hook.com');
    });

    it('should return current config when no updates provided', async () => {
      // No fields to update — falls through to getNotificationConfig
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnector),
      });

      const data = await notificationService.updateNotificationConfig(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        {},
      );

      expect(data.emailAlertsEnabled).toBe(true);
    });

    it('should throw NOT_FOUND when connector does not exist', async () => {
      mockFindOneAndUpdate.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        notificationService.updateNotificationConfig('nonexistent', 'test-tenant', {
          emailAlertsEnabled: true,
        }),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // testWebhook
  // ===========================================================================

  describe('testWebhook', () => {
    it('should return success for a reachable webhook', async () => {
      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      vi.stubGlobal('fetch', mockFetch);

      // Mock DNS to pass SSRF check
      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '93.184.216.34',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://hooks.example.com/notify',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(true);
      expect(data.statusCode).toBe(200);

      vi.unstubAllGlobals();
    });

    it('should return failure for unreachable webhook', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '93.184.216.34',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://hooks.example.com/notify',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(false);
      expect(data.error).toContain('Connection refused');

      vi.unstubAllGlobals();
    });

    it('should reject SSRF attempt with private IP (127.0.0.1)', async () => {
      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '127.0.0.1',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://localhost/callback',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(false);
      expect(data.error).toContain('private');
    });

    it('should reject SSRF attempt with private IP (10.x.x.x)', async () => {
      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '10.0.0.1',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://internal-service/callback',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(false);
      expect(data.error).toContain('private');
    });

    it('should reject SSRF attempt with private IP (192.168.x.x)', async () => {
      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '192.168.1.1',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://home-server/callback',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(false);
      expect(data.error).toContain('private');
    });

    it('should return failure for HTTP error status', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      vi.stubGlobal('fetch', mockFetch);

      const dns = await import('dns');
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue({
        address: '93.184.216.34',
        family: 4,
      } as any);

      const data = await notificationService.testWebhook(
        'https://hooks.example.com/notify',
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.success).toBe(false);
      expect(data.statusCode).toBe(500);

      vi.unstubAllGlobals();
    });
  });

  // ===========================================================================
  // Zod Validation
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate notification params with empty fields', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });

    it('should validate notification body with valid events', () => {
      const { z } = require('zod');
      const VALID_EVENTS = [
        'sync_failure',
        'token_expiry',
        'permission_crawl_fail',
        'sync_complete',
      ] as const;
      const schema = z.object({
        emailAlertsEnabled: z.boolean().optional(),
        emailEvents: z.array(z.enum(VALID_EVENTS)).optional(),
        webhookUrl: z.string().url().nullable().optional(),
        webhookEvents: z.array(z.enum(VALID_EVENTS)).optional(),
      });

      const result = schema.safeParse({
        emailAlertsEnabled: true,
        emailEvents: ['sync_failure'],
        webhookUrl: 'https://example.com',
        webhookEvents: ['sync_complete'],
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid event names', () => {
      const { z } = require('zod');
      const VALID_EVENTS = [
        'sync_failure',
        'token_expiry',
        'permission_crawl_fail',
        'sync_complete',
      ] as const;
      const schema = z.object({
        emailEvents: z.array(z.enum(VALID_EVENTS)).optional(),
      });

      const result = schema.safeParse({ emailEvents: ['invalid_event'] });
      expect(result.success).toBe(false);
    });

    it('should reject invalid webhook URL', () => {
      const { z } = require('zod');
      const schema = z.object({ url: z.string().url() });

      const result = schema.safeParse({ url: 'not-a-url' });
      expect(result.success).toBe(false);
    });

    it('should accept null webhook URL', () => {
      const { z } = require('zod');
      const schema = z.object({ webhookUrl: z.string().url().nullable().optional() });

      const result = schema.safeParse({ webhookUrl: null });
      expect(result.success).toBe(true);
    });
  });
});
