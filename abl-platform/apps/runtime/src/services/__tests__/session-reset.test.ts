import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCommand, mockRemoveSession, mockFlushMessageQueue } = vi.hoisted(() => ({
  mockCommand: vi.fn(),
  mockRemoveSession: vi.fn(),
  mockFlushMessageQueue: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    command: mockCommand,
  }),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: () => false,
}));

vi.mock('../../repos/session-repo.js', () => ({
  updateSession: vi.fn(),
}));

vi.mock('../stores/index.js', () => ({
  getStores: () => ({
    message: {
      deleteBySession: vi.fn(),
    },
  }),
}));

vi.mock('../trace-store.js', () => ({
  getTraceStore: () => ({
    clearSession: vi.fn(),
    removeSession: mockRemoveSession,
  }),
}));

vi.mock('../message-persistence-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../message-persistence-queue.js')>()),
  flushMessageQueue: mockFlushMessageQueue,
}));

vi.mock('../execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: () => ({
    cancelSession: vi.fn(),
  }),
  isCoordinatorAvailable: () => false,
}));

import { finalizeSessionReset } from '../session-reset.js';

describe('finalizeSessionReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommand.mockResolvedValue(undefined);
    mockRemoveSession.mockResolvedValue(undefined);
    mockFlushMessageQueue.mockResolvedValue(undefined);
    process.env.USE_MONGO_CLICKHOUSE = 'true';
  });

  it('waits for ClickHouse reset deletes before returning', async () => {
    await finalizeSessionReset({
      sessionId: 'session-1',
      tenantId: 'tenant-1',
    });

    expect(mockCommand).toHaveBeenCalledTimes(3);
    for (const call of mockCommand.mock.calls) {
      expect(call[0].query).toContain('SETTINGS mutations_sync = 1');
    }
    expect(mockCommand.mock.calls.map((call) => call[0].query)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ALTER TABLE abl_platform.messages DELETE'),
        expect.stringContaining('ALTER TABLE abl_platform.platform_events DELETE'),
        expect.stringContaining('ALTER TABLE abl_platform.platform_events_by_session DELETE'),
      ]),
    );
  });
});
