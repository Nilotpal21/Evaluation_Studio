import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mongoose before importing the module under test
const { mockEndSession, mockWithTransaction, mockSession, mockCommand, mockStartSession } =
  vi.hoisted(() => {
    const mockEndSession = vi.fn().mockResolvedValue(undefined);
    const mockWithTransaction = vi.fn(async (fn: () => Promise<void>) => {
      await fn();
    });
    const mockSession = {
      withTransaction: mockWithTransaction,
      endSession: mockEndSession,
    };
    const mockCommand = vi.fn();
    const mockStartSession = vi.fn().mockResolvedValue(mockSession);
    return {
      mockEndSession,
      mockWithTransaction,
      mockSession,
      mockCommand,
      mockStartSession,
    };
  });

vi.mock('mongoose', () => ({
  default: {
    connection: {
      db: {
        admin: () => ({ command: mockCommand }),
      },
    },
    startSession: mockStartSession,
  },
}));

// Import after mock
import { canUseTransactions, withTransaction, _resetTxCache } from '../repos/mongo-tx.js';

describe('mongo-tx', () => {
  beforeEach(() => {
    // Reset module-level cache
    _resetTxCache();

    // Reset all mock state (call counts + implementations)
    mockCommand.mockReset();
    mockEndSession.mockReset().mockResolvedValue(undefined);
    mockStartSession.mockReset().mockResolvedValue(mockSession);
    mockWithTransaction.mockReset().mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });
  });

  describe('canUseTransactions', () => {
    it('returns true for replica set (setName present)', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      expect(await canUseTransactions()).toBe(true);
    });

    it('returns true for mongos (msg: isdbgrid)', async () => {
      mockCommand.mockResolvedValueOnce({ msg: 'isdbgrid' });
      expect(await canUseTransactions()).toBe(true);
    });

    it('returns false for standalone MongoDB', async () => {
      mockCommand.mockResolvedValueOnce({ isWritablePrimary: true });
      expect(await canUseTransactions()).toBe(false);
    });

    it('returns false on command error', async () => {
      mockCommand.mockRejectedValueOnce(new Error('not connected'));
      expect(await canUseTransactions()).toBe(false);
    });

    it('caches the result within the TTL window', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      expect(await canUseTransactions()).toBe(true);
      // Second call should use cache, not call command again
      expect(await canUseTransactions()).toBe(true);
      expect(mockCommand).toHaveBeenCalledTimes(1);
    });

    it('re-checks after TTL expires', async () => {
      const dateNowSpy = vi.spyOn(Date, 'now');
      const baseTime = 1_000_000;

      // First check: standalone (false)
      dateNowSpy.mockReturnValue(baseTime);
      mockCommand.mockResolvedValueOnce({ isWritablePrimary: true });
      expect(await canUseTransactions()).toBe(false);
      expect(mockCommand).toHaveBeenCalledTimes(1);

      // Still within TTL — should use cache
      dateNowSpy.mockReturnValue(baseTime + 4 * 60 * 1000);
      expect(await canUseTransactions()).toBe(false);
      expect(mockCommand).toHaveBeenCalledTimes(1); // no new call

      // Past TTL — should re-check, now replica set
      dateNowSpy.mockReturnValue(baseTime + 5 * 60 * 1000 + 1);
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      expect(await canUseTransactions()).toBe(true);
      expect(mockCommand).toHaveBeenCalledTimes(2);

      dateNowSpy.mockRestore();
    });

    it('_resetTxCache clears the cache', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      expect(await canUseTransactions()).toBe(true);
      expect(mockCommand).toHaveBeenCalledTimes(1);

      _resetTxCache();

      mockCommand.mockResolvedValueOnce({ isWritablePrimary: true });
      expect(await canUseTransactions()).toBe(false);
      expect(mockCommand).toHaveBeenCalledTimes(2);
    });
  });

  describe('withTransaction', () => {
    it('runs fn with null session when transactions not supported', async () => {
      mockCommand.mockResolvedValueOnce({}); // standalone

      const fn = vi.fn(async (session: unknown) => {
        expect(session).toBeNull();
        return 'result';
      });
      const result = await withTransaction(fn);
      expect(result).toBe('result');
      expect(fn).toHaveBeenCalledOnce();
      expect(mockStartSession).not.toHaveBeenCalled();
    });

    it('runs fn with session using session.withTransaction() when tx supported', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });

      const fn = vi.fn(async (session: unknown) => {
        expect(session).toBe(mockSession);
        return 42;
      });
      const result = await withTransaction(fn);
      expect(result).toBe(42);
      expect(mockStartSession).toHaveBeenCalledOnce();
      expect(mockWithTransaction).toHaveBeenCalledOnce();
      expect(mockEndSession).toHaveBeenCalledOnce();
    });

    it('calls endSession even when session.withTransaction() throws', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      const error = new Error('operation failed');
      mockWithTransaction.mockRejectedValueOnce(error);

      const fn = vi.fn();
      await expect(withTransaction(fn)).rejects.toThrow('operation failed');
      expect(mockEndSession).toHaveBeenCalledOnce();
    });

    it('re-throws errors from fn through session.withTransaction()', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
      const error = new Error('callback failed');

      const fn = vi.fn(async () => {
        throw error;
      });

      await expect(withTransaction(fn)).rejects.toThrow('callback failed');
      expect(mockEndSession).toHaveBeenCalledOnce();
    });

    it('returns the value produced by fn', async () => {
      mockCommand.mockResolvedValueOnce({ setName: 'rs0' });

      const result = await withTransaction(async () => ({ id: 'abc', name: 'test' }));
      expect(result).toEqual({ id: 'abc', name: 'test' });
    });
  });
});
