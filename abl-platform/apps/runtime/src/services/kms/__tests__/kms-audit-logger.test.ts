import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockWriteAuditEvent } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockWriteAuditEvent: vi.fn<(event: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('../../audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(),
  writeAuditEvent: mockWriteAuditEvent,
}));

import {
  setKMSAuditClickHouseAvailable,
  logKMSAuditEvent,
  logKMSAuditEvents,
  type KMSAuditEvent,
} from '../kms-audit-logger.js';

function makeEvent(overrides: Partial<KMSAuditEvent> = {}): KMSAuditEvent {
  return {
    tenantId: 'tenant-1',
    operation: 'encrypt',
    keyId: 'key-123',
    providerType: 'aes-256-gcm',
    success: true,
    latencyMs: 42,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('KMSAuditLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setKMSAuditClickHouseAvailable(false);
    mockWriteAuditEvent.mockResolvedValue(undefined);
  });

  describe('logKMSAuditEvent', () => {
    it('should skip when the audit backend is unavailable', async () => {
      logKMSAuditEvent(makeEvent());
      await flushPromises();

      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'KMS audit event (audit pipeline unavailable)',
        expect.objectContaining({
          _audit: true,
          operation: 'encrypt',
          keyId: 'key-123',
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should emit a kms audit event when the backend is available', async () => {
      setKMSAuditClickHouseAvailable(true);

      logKMSAuditEvent(makeEvent());
      await flushPromises();

      expect(mockWriteAuditEvent).toHaveBeenCalledOnce();
      expect(mockWriteAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: 'kms',
          source: 'runtime-store',
          eventType: 'kms.encrypt',
          action: 'encrypt',
          tenantId: 'tenant-1',
          resourceType: 'kms_key',
          resourceId: 'key-123',
          actorId: 'system',
          actorType: 'system',
          metadataEncoding: 'object',
          retentionClass: 'indefinite',
          metadata: expect.objectContaining({
            keyVersion: 0,
            keyPurpose: '',
            providerType: 'aes-256-gcm',
            success: true,
            latencyMs: 42,
          }),
        }),
      );
    });

    it('should map extended KMS fields into the emitted audit event', async () => {
      setKMSAuditClickHouseAvailable(true);

      logKMSAuditEvent(
        makeEvent({
          tenantId: 'tenant-a',
          operation: 'rotate',
          keyId: 'key-99',
          keyVersion: 3,
          keyPurpose: 'encryption',
          providerType: 'vault',
          projectId: 'project-7',
          environment: 'production',
          dekId: 'dek-1',
          actorId: 'user-5',
          actorType: 'user',
          actorIp: '10.0.0.1',
          success: false,
          errorMessage: 'timeout',
          latencyMs: 200,
          metadata: { initiator: 'admin-ui' },
        }),
      );
      await flushPromises();

      expect(mockWriteAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: 'kms',
          eventType: 'kms.rotate',
          action: 'rotate',
          tenantId: 'tenant-a',
          projectId: 'project-7',
          environment: 'production',
          actorId: 'user-5',
          actorType: 'user',
          ipAddress: '10.0.0.1',
          resourceId: 'key-99',
          metadata: expect.objectContaining({
            keyVersion: 3,
            keyPurpose: 'encryption',
            providerType: 'vault',
            environment: 'production',
            dekId: 'dek-1',
            success: false,
            errorMessage: 'timeout',
            latencyMs: 200,
            initiator: 'admin-ui',
          }),
        }),
      );
    });

    it('should never throw even when audit emission fails', async () => {
      setKMSAuditClickHouseAvailable(true);
      mockWriteAuditEvent.mockRejectedValueOnce(new Error('kafka unavailable'));

      expect(() => logKMSAuditEvent(makeEvent())).not.toThrow();
      await flushPromises();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'KMS audit write failed, backing off audit pipeline writes',
        expect.objectContaining({
          operation: 'encrypt',
          keyId: 'key-123',
          error: 'kafka unavailable',
          retryInMs: 60_000,
        }),
      );
    });

    it('should back off audit writes after an emission failure', async () => {
      setKMSAuditClickHouseAvailable(true);
      mockWriteAuditEvent.mockRejectedValueOnce(new Error('kafka unavailable'));

      logKMSAuditEvent(makeEvent());
      await flushPromises();
      mockWriteAuditEvent.mockClear();

      logKMSAuditEvent(makeEvent({ operation: 'decrypt' }));
      await flushPromises();

      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'KMS audit event (audit pipeline unavailable)',
        expect.objectContaining({
          _audit: true,
          operation: 'decrypt',
          keyId: 'key-123',
        }),
      );
    });
  });

  describe('logKMSAuditEvents (batch)', () => {
    it('should skip when the backend is unavailable', async () => {
      logKMSAuditEvents([makeEvent(), makeEvent()]);
      await flushPromises();

      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });

    it('should skip when events array is empty', async () => {
      setKMSAuditClickHouseAvailable(true);
      logKMSAuditEvents([]);
      await flushPromises();

      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });

    it('should emit each event through the audit pipeline', async () => {
      setKMSAuditClickHouseAvailable(true);

      logKMSAuditEvents([
        makeEvent({ operation: 'encrypt' }),
        makeEvent({ operation: 'decrypt' }),
        makeEvent({ operation: 'rotate' }),
      ]);
      await flushPromises();

      expect(mockWriteAuditEvent).toHaveBeenCalledTimes(3);
      expect(mockWriteAuditEvent.mock.calls[0]?.[0]).toMatchObject({ eventType: 'kms.encrypt' });
      expect(mockWriteAuditEvent.mock.calls[1]?.[0]).toMatchObject({ eventType: 'kms.decrypt' });
      expect(mockWriteAuditEvent.mock.calls[2]?.[0]).toMatchObject({ eventType: 'kms.rotate' });
    });
  });

  describe('setKMSAuditClickHouseAvailable', () => {
    it('should toggle backend availability', async () => {
      setKMSAuditClickHouseAvailable(true);
      logKMSAuditEvent(makeEvent());
      await flushPromises();
      expect(mockWriteAuditEvent).toHaveBeenCalledOnce();

      mockWriteAuditEvent.mockClear();

      setKMSAuditClickHouseAvailable(false);
      logKMSAuditEvent(makeEvent());
      await flushPromises();
      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });
  });
});
