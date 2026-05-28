import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInsert } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
}));

vi.mock('../services/execution/pii-audit-store-adapter.js', () => ({
  getAuditStore: () => ({
    insert: (...args: unknown[]) => mockInsert(...args),
  }),
}));

describe('PII audit shutdown', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockInsert.mockResolvedValue(undefined);
  });

  it('flushes buffered PII audit entries on shutdown', async () => {
    const { getPIIAuditLogger, shutdownPIIAuditLogger } =
      await import('../services/execution/pii-audit-singleton.js');

    getPIIAuditLogger().log({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      tokenId: 'token-1',
      piiType: 'email',
      consumer: 'llm',
      action: 'detokenize',
    });

    await shutdownPIIAuditLogger();

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        tokenId: 'token-1',
        piiType: 'email',
        consumer: 'llm',
        action: 'detokenize',
        expireAt: expect.any(Date),
      }),
    );
  });

  it('resets the singleton after shutdown so the next call gets a fresh logger', async () => {
    const { getPIIAuditLogger, shutdownPIIAuditLogger } =
      await import('../services/execution/pii-audit-singleton.js');

    const first = getPIIAuditLogger();
    await shutdownPIIAuditLogger();
    const second = getPIIAuditLogger();

    expect(second).not.toBe(first);
  });
});
