/**
 * Session Repo Tenant Isolation Tests
 *
 * Verifies that all session-repo functions enforce tenantId at the repo layer,
 * preventing cross-tenant data access when callers pass empty/missing tenantId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database models
const mockFindOne = vi.fn();
const mockSelect = vi.fn().mockReturnValue({ lean: mockFindOne });
const mockFindOneAndUpdate = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockFind = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    findOne: vi.fn((..._args: unknown[]) => ({
      select: mockSelect,
      lean: mockFindOne,
    })),
    findOneAndUpdate: vi.fn((..._args: unknown[]) => ({
      lean: vi.fn().mockResolvedValue(null),
    })),
    updateOne: mockUpdateOne,
    updateMany: mockUpdateMany,
    find: vi.fn((..._args: unknown[]) => ({
      lean: vi.fn().mockResolvedValue([]),
    })),
  },
  Message: {
    find: vi.fn((..._args: unknown[]) => ({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    })),
  },
}));

vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: vi.fn().mockResolvedValue({ counts: { Session: 1 } }),
}));

import {
  findSessionById,
  findStoredSessionByAnyId,
  updateSession,
  updateSessionActivity,
  applySessionTurnUpdate,
  incrementSessionTokens,
  incrementSessionMetrics,
  unlinkContactFromSessions,
  deleteSessionsByIds,
  findMessagesForSession,
} from '../../repos/session-repo.js';

describe('session-repo tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
  });

  // ─── findSessionById ─────────────────────────────────────────────────
  describe('findSessionById', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(findSessionById('sess-1', '')).rejects.toThrow('tenantId is required');
    });

    it('accepts valid tenantId and returns result', async () => {
      mockFindOne.mockResolvedValue({ _id: 'sess-1', tenantId: 'tenant-A' });
      const result = await findSessionById('sess-1', 'tenant-A');
      expect(result).not.toBeNull();
      expect(result.id).toBe('sess-1');
    });
  });

  describe('findStoredSessionByAnyId', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(findStoredSessionByAnyId('sess-1', '')).rejects.toThrow('tenantId is required');
    });
  });

  // ─── updateSession ───────────────────────────────────────────────────
  describe('updateSession', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(updateSession('sess-1', { status: 'closed' }, '')).rejects.toThrow(
        'tenantId is required',
      );
    });
  });

  // ─── updateSessionActivity ───────────────────────────────────────────
  describe('updateSessionActivity', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(updateSessionActivity('sess-1', 1, '')).rejects.toThrow('tenantId is required');
    });
  });

  // ─── incrementSessionTokens ──────────────────────────────────────────
  describe('incrementSessionTokens', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(incrementSessionTokens('sess-1', 100, 0.5, '')).rejects.toThrow(
        'tenantId is required',
      );
    });
  });

  // ─── incrementSessionMetrics ─────────────────────────────────────────
  describe('incrementSessionMetrics', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(incrementSessionMetrics('sess-1', { traceEventCount: 1 }, '')).rejects.toThrow(
        'tenantId is required',
      );
    });
  });

  describe('applySessionTurnUpdate', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(
        applySessionTurnUpdate('sess-1', { tokenCountIncrement: 1 }, ''),
      ).rejects.toThrow('tenantId is required');
    });
  });

  // ─── unlinkContactFromSessions ───────────────────────────────────────
  describe('unlinkContactFromSessions', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(unlinkContactFromSessions('contact-1', '')).rejects.toThrow(
        'tenantId is required',
      );
    });
  });

  // ─── deleteSessionsByIds ─────────────────────────────────────────────
  describe('deleteSessionsByIds', () => {
    it('rejects empty-string tenantId', async () => {
      await expect(deleteSessionsByIds(['sess-1'], '')).rejects.toThrow('tenantId is required');
    });
  });
});
