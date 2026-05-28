import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockShutdownAuditLogs,
  mockShutdownPIIAuditLogger,
  mockPeekSessionService,
  mockGetSessionService,
} = vi.hoisted(() => ({
  mockShutdownAuditLogs: vi.fn(),
  mockShutdownPIIAuditLogger: vi.fn(),
  mockPeekSessionService: vi.fn(),
  mockGetSessionService: vi.fn(),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  shutdownAuditLogs: () => mockShutdownAuditLogs(),
}));

vi.mock('../services/execution/pii-audit-singleton.js', () => ({
  getPIIAuditLogger: vi.fn(),
  shutdownPIIAuditLogger: () => mockShutdownPIIAuditLogger(),
}));

vi.mock('../services/session/session-service.js', () => ({
  peekSessionService: () => mockPeekSessionService(),
  getSessionService: () => mockGetSessionService(),
}));

import { flushBufferedPersistenceOnShutdown } from '../services/runtime-shutdown-flush.js';

describe('flushBufferedPersistenceOnShutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes audit logs and pending cold persists when available', async () => {
    const flushPendingColdPersists = vi.fn().mockResolvedValue(undefined);
    mockPeekSessionService.mockReturnValue({
      store: { flushPendingColdPersists },
    });

    await flushBufferedPersistenceOnShutdown();

    expect(mockShutdownAuditLogs).toHaveBeenCalledTimes(1);
    expect(mockShutdownPIIAuditLogger).toHaveBeenCalledTimes(1);
    expect(flushPendingColdPersists).toHaveBeenCalledTimes(1);
  });

  it('flushes audit logs even when session service is not initialized', async () => {
    mockPeekSessionService.mockReturnValue(null);

    await flushBufferedPersistenceOnShutdown();

    expect(mockShutdownAuditLogs).toHaveBeenCalledTimes(1);
    expect(mockShutdownPIIAuditLogger).toHaveBeenCalledTimes(1);
  });

  it('skips cold persist flushing when the store does not support it', async () => {
    mockPeekSessionService.mockReturnValue({
      store: {},
    });

    await flushBufferedPersistenceOnShutdown();

    expect(mockShutdownAuditLogs).toHaveBeenCalledTimes(1);
    expect(mockShutdownPIIAuditLogger).toHaveBeenCalledTimes(1);
  });
});
