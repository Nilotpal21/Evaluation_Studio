/**
 * Tool Audit Logger Tests
 *
 * CRITICAL: Tests security audit trail for all tool executions.
 * Audit logs must never throw errors - failed logging should not break tool execution.
 * Endpoint redaction must protect PII and sensitive data.
 */

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ToolAuditLoggerImpl } from '../../services/tool-audit-logger.js';
import type { ToolAuditEntry } from '@abl/compiler/platform';

// ─── Mock Setup ──────────────────────────────────────────────────────────

const mockAuditStore: { log: Mock } = {
  log: vi.fn(),
};

// Mock redactEndpoint and createLogger from @abl/compiler/platform
vi.mock('@abl/compiler/platform', async () => {
  const actual = await vi.importActual('@abl/compiler/platform');
  return {
    ...actual,
    redactEndpoint: vi.fn((url: string) => url.replace(/token=[^&]+/, 'token=***')),
    createLogger: () => ({
      error: vi.fn(),
    }),
  };
});

// Get reference to the mocked function after the mock is set up
import { redactEndpoint } from '@abl/compiler/platform';
const mockRedactEndpoint = redactEndpoint as unknown as Mock;

// ─── Test Data Helper ────────────────────────────────────────────────────

const TIMESTAMP = '2024-01-01T00:00:00.000Z';

describe('ToolAuditLoggerImpl (AuditStore-backed)', () => {
  let logger: ToolAuditLoggerImpl;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    logger = new ToolAuditLoggerImpl(mockAuditStore as any);
  });

  describe('Successful Audit Logging', () => {
    test('logs tool execution with all metadata', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'weather_api',
        toolType: 'http',
        success: true,
        latencyMs: 123,
        inputHash: 'abc123',
        authType: 'bearer',
        sessionId: 'session-1',
        tenantId: 'tenant-a',
        userId: 'user-1',
        endpoint: 'https://api.weather.com/current',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith({
        eventType: 'tool.executed',
        actor: 'user-1',
        actorType: 'user',
        resourceType: 'tool',
        resourceId: 'weather_api',
        environment: 'dev',
        action: 'tool:weather_api',
        metadata: {
          toolType: 'http',
          success: true,
          latencyMs: 123,
          inputHash: 'abc123',
          authType: 'bearer',
          sessionId: 'session-1',
          tenantId: 'tenant-a',
          source: undefined,
          callerContext: undefined,
          workflowId: undefined,
          workflowVersionId: undefined,
          workflowVersion: undefined,
          endpoint: 'https://api.weather.com/current',
          errorMessage: undefined,
        },
      });
    });

    test('uses the resolved runtime environment label', async () => {
      process.env.NODE_ENV = 'production';

      await logger.logToolAudit({
        toolName: 'env_probe',
        toolType: 'http',
        success: true,
        latencyMs: 10,
        inputHash: 'hash-env',
        authType: 'bearer',
        sessionId: 'session-env',
        tenantId: 'tenant-env',
        timestamp: TIMESTAMP,
      });

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: 'production',
        }),
      );
    });

    test('uses "system" as actor when userId is undefined', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'background_job',
        toolType: 'http',
        success: true,
        latencyMs: 50,
        inputHash: 'hash1',
        authType: 'api_key',
        sessionId: 'session-2',
        tenantId: 'tenant-b',
        userId: undefined,
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'system',
          actorType: 'system',
        }),
      );
    });

    test('uses "system" as actor when userId is null', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'scheduled_task',
        toolType: 'sandbox',
        success: true,
        latencyMs: 200,
        inputHash: 'hash2',
        authType: 'oauth2',
        sessionId: 'session-3',
        tenantId: 'tenant-c',
        userId: null as any,
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'system',
          actorType: 'system',
        }),
      );
    });

    test('formats action as "tool:<toolName>"', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'email_sender',
        toolType: 'http',
        success: true,
        latencyMs: 100,
        inputHash: 'hash3',
        authType: 'api_key',
        sessionId: 'session-4',
        tenantId: 'tenant-d',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tool:email_sender',
        }),
      );
    });

    test('sets eventType to "tool.executed"', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'data_processor',
        toolType: 'sandbox',
        success: true,
        latencyMs: 300,
        inputHash: 'hash4',
        authType: 'oauth2',
        sessionId: 'session-5',
        tenantId: 'tenant-e',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tool.executed',
        }),
      );
    });

    test('sets resourceType to "tool" and resourceId to toolName', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'slack_notifier',
        toolType: 'http',
        success: true,
        latencyMs: 80,
        inputHash: 'hash5',
        authType: 'bearer',
        sessionId: 'session-6',
        tenantId: 'tenant-f',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'tool',
          resourceId: 'slack_notifier',
        }),
      );
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('Endpoint Redaction', () => {
    test('redacts endpoint when provided', async () => {
      mockRedactEndpoint.mockReturnValue('https://api.example.com?token=***');

      const entry: ToolAuditEntry = {
        toolName: 'api_caller',
        toolType: 'http',
        success: true,
        latencyMs: 100,
        inputHash: 'hash6',
        authType: 'api_key',
        sessionId: 'session-7',
        tenantId: 'tenant-g',
        endpoint: 'https://api.example.com?token=secret123',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            endpoint: 'https://api.example.com?token=***',
          }),
        }),
      );
    });

    test('skips local unauthenticated tools without endpoints', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'local_tool',
        toolType: 'sandbox',
        success: true,
        latencyMs: 50,
        inputHash: 'hash7',
        authType: 'none',
        sessionId: 'session-8',
        tenantId: 'tenant-h',
        endpoint: undefined,
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    test('does not throw when AuditStore.log fails', async () => {
      mockAuditStore.log.mockRejectedValue(new Error('ClickHouse connection failed'));

      const entry: ToolAuditEntry = {
        toolName: 'critical_tool',
        toolType: 'http',
        success: true,
        latencyMs: 100,
        inputHash: 'hash8',
        authType: 'bearer',
        sessionId: 'session-9',
        tenantId: 'tenant-i',
        timestamp: TIMESTAMP,
      };

      await expect(logger.logToolAudit(entry)).resolves.not.toThrow();
    });

    test('catches and suppresses errors from AuditStore', async () => {
      mockAuditStore.log.mockRejectedValue(new Error('Network timeout'));

      const entry: ToolAuditEntry = {
        toolName: 'important_tool',
        toolType: 'http',
        success: false,
        latencyMs: 5000,
        inputHash: 'hash9',
        authType: 'none',
        sessionId: 'session-10',
        tenantId: 'tenant-j',
        errorMessage: 'Timeout exceeded',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      // Should not throw, even though mockAuditStore.log rejects
      expect(mockAuditStore.log).toHaveBeenCalled();
    });
  });

  describe('Failed Tool Execution', () => {
    test('logs failed tool execution with error message', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'failing_tool',
        toolType: 'http',
        success: false,
        latencyMs: 200,
        inputHash: 'hash12',
        authType: 'bearer',
        sessionId: 'session-13',
        tenantId: 'tenant-m',
        errorMessage: 'Connection refused: ECONNREFUSED',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            success: false,
            errorMessage: 'Connection refused: ECONNREFUSED',
          }),
        }),
      );
    });

    test('logs failed execution without error message', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'timeout_tool',
        toolType: 'http',
        success: false,
        latencyMs: 30000,
        inputHash: 'hash13',
        authType: 'none',
        sessionId: 'session-14',
        tenantId: 'tenant-n',
        errorMessage: undefined,
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            success: false,
            errorMessage: undefined,
          }),
        }),
      );
    });
  });

  describe('Metadata Completeness', () => {
    test('includes all provided metadata fields', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'comprehensive_tool',
        toolType: 'mcp',
        success: true,
        latencyMs: 456,
        inputHash: 'hash14',
        authType: 'oauth2',
        sessionId: 'session-15',
        tenantId: 'tenant-o',
        userId: 'user-o',
        endpoint: 'https://api.example.com/mcp',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            toolType: 'mcp',
            success: true,
            latencyMs: 456,
            inputHash: 'hash14',
            authType: 'oauth2',
            sessionId: 'session-15',
            tenantId: 'tenant-o',
            source: undefined,
            callerContext: undefined,
            workflowId: undefined,
            workflowVersionId: undefined,
            workflowVersion: undefined,
            endpoint: expect.any(String),
            errorMessage: undefined,
          },
        }),
      );
    });

    test('includes workflow version metadata when provided', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'workflow_tool',
        toolType: 'workflow',
        success: true,
        latencyMs: 250,
        inputHash: 'hash-workflow',
        authType: 'oauth2',
        sessionId: 'session-workflow',
        tenantId: 'tenant-workflow',
        workflowId: 'wf-1',
        workflowVersionId: 'wfv-2',
        workflowVersion: 'v2.0.0',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workflowId: 'wf-1',
            workflowVersionId: 'wfv-2',
            workflowVersion: 'v2.0.0',
          }),
        }),
      );
    });

    test('includes callerContext fields in audit entry when provided', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'caller_context_tool',
        toolType: 'http',
        success: true,
        latencyMs: 100,
        inputHash: 'hash-cc',
        authType: 'bearer',
        sessionId: 'session-cc',
        tenantId: 'tenant-cc',
        userId: 'user-cc',
        timestamp: TIMESTAMP,
        source: 'production',
        callerContext: {
          channel: 'web',
          identityTier: 2,
          verificationMethod: 'otp',
          contactId: 'contact-123',
          customerId: 'customer-456',
        },
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionId: 'session-cc',
            tenantId: 'tenant-cc',
            source: 'production',
            callerContext: {
              channel: 'web',
              identityTier: 2,
              verificationMethod: 'otp',
              contactId: 'contact-123',
              customerId: 'customer-456',
            },
          }),
        }),
      );
    });

    test('omits callerContext when not provided', async () => {
      const entry: ToolAuditEntry = {
        toolName: 'no_caller_context',
        toolType: 'http',
        success: true,
        latencyMs: 50,
        inputHash: 'hash-no-cc',
        authType: 'bearer',
        sessionId: 'session-no-cc',
        tenantId: 'tenant-no-cc',
        timestamp: TIMESTAMP,
      };

      await logger.logToolAudit(entry);

      expect(mockAuditStore.log).toHaveBeenCalled();
      const calledEntry = mockAuditStore.log.mock.calls[0][0];
      expect(calledEntry.metadata.callerContext).toBeUndefined();
    });
  });
});
