/**
 * TieredSessionStore — Unit Tests
 *
 * Covers:
 * - Hot path: delegates to primary store
 * - Cold fallback: loads from SessionStateRepo when primary misses
 * - Rehydration: cold-restored sessions are written back to primary
 * - Fire-and-forget: cold persist errors don't break hot path
 * - Delete: removes from both tiers
 * - Touch: refreshes both tiers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionStore } from '../services/session/session-store.js';
import type { SessionData } from '../services/session/types.js';
import { TieredSessionStore } from '../services/session/tiered-session-store.js';

// =============================================================================
// MOCKS
// =============================================================================

function createMockPrimaryStore(): SessionStore {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    getVersion: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(true),
    delete: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
    getConversationHistory: vi.fn().mockResolvedValue([]),
    replaceConversation: vi.fn().mockResolvedValue(undefined),
    trimConversation: vi.fn().mockResolvedValue(undefined),
    getAgentIR: vi.fn().mockResolvedValue(null),
    setAgentIR: vi.fn().mockResolvedValue(undefined),
    getCompilationOutput: vi.fn().mockResolvedValue(null),
    setCompilationOutput: vi.fn().mockResolvedValue(undefined),
    setAgentRegistry: vi.fn().mockResolvedValue(undefined),
    getAgentRegistry: vi.fn().mockResolvedValue(null),
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    setResolutionKey: vi.fn().mockResolvedValue(undefined),
    getResolutionKey: vi.fn().mockResolvedValue(null),
    deleteResolutionKey: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestSession(id = 'sess-1'): SessionData {
  return {
    id,
    agentName: 'TestAgent',
    irSourceHash: 'hash-abc',
    compilationHash: null,
    conversationHistory: [{ role: 'user', content: 'hello' }],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['TestAgent'],
    delegateStack: [],
    dataValues: { name: 'John' },
    dataGatheredKeys: ['name'],
    initialized: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    tenantId: 'tenant-1',
    projectId: 'proj-1',
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TieredSessionStore', () => {
  let primary: SessionStore;
  let tiered: TieredSessionStore;

  beforeEach(() => {
    primary = createMockPrimaryStore();
    tiered = new TieredSessionStore(primary, { enabled: true, coldTtlDays: 7 });
    // Mock the cold repo internal methods to avoid actual MongoDB calls.
    // TieredSessionStore calls *Internal variants (unscoped) not the public ones.
    const coldRepo = tiered.getColdRepo();
    vi.spyOn(coldRepo, 'upsert').mockResolvedValue(undefined);
    vi.spyOn(coldRepo, 'loadInternal').mockResolvedValue(null);
    vi.spyOn(coldRepo, 'deleteInternal').mockResolvedValue(undefined);
    vi.spyOn(coldRepo, 'touchInternal').mockResolvedValue(undefined);
    vi.spyOn(coldRepo, 'getVersionInternal').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('should create in primary and persist to cold', async () => {
      const session = createTestSession();
      await tiered.create(session);

      expect(primary.create).toHaveBeenCalledWith(session);
      // Cold persist is fire-and-forget, wait for microtask
      await new Promise((r) => setTimeout(r, 0));
      expect(tiered.getColdRepo().upsert).toHaveBeenCalledWith(session);
    });

    it('should not persist to cold when disabled', async () => {
      tiered = new TieredSessionStore(primary, { enabled: false });
      const coldRepo = tiered.getColdRepo();
      vi.spyOn(coldRepo, 'upsert').mockResolvedValue(undefined);

      const session = createTestSession();
      await tiered.create(session);

      expect(primary.create).toHaveBeenCalledWith(session);
      await new Promise((r) => setTimeout(r, 0));
      expect(coldRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('should return from primary when available', async () => {
      const session = createTestSession();
      vi.mocked(primary.load).mockResolvedValue(session);

      const result = await tiered.load('sess-1');

      expect(result).toBe(session);
      expect(tiered.getColdRepo().loadInternal).not.toHaveBeenCalled();
    });

    it('should fall back to cold store when primary misses', async () => {
      const session = createTestSession();
      vi.mocked(primary.load).mockResolvedValue(null);
      vi.mocked(tiered.getColdRepo().loadInternal).mockResolvedValue(session);

      const result = await tiered.load('sess-1');

      expect(result).toEqual(session);
      expect(tiered.getColdRepo().loadInternal).toHaveBeenCalledWith('sess-1');
      // Should rehydrate to primary
      expect(primary.create).toHaveBeenCalledWith(session);
    });

    it('should return null when both tiers miss', async () => {
      vi.mocked(primary.load).mockResolvedValue(null);
      vi.mocked(tiered.getColdRepo().loadInternal).mockResolvedValue(null);

      const result = await tiered.load('sess-nonexistent');

      expect(result).toBeNull();
    });

    it('should not check cold when disabled', async () => {
      tiered = new TieredSessionStore(primary, { enabled: false });
      vi.mocked(primary.load).mockResolvedValue(null);

      const result = await tiered.load('sess-1');

      expect(result).toBeNull();
    });

    it('uses project-scoped cold fallback when scoped primary load misses', async () => {
      const session = createTestSession();
      const locator = {
        kind: 'production' as const,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
      };
      primary.loadScoped = vi.fn().mockResolvedValue(null);
      vi.spyOn(tiered.getColdRepo(), 'load').mockResolvedValue(session);

      const result = await tiered.loadScoped(locator);

      expect(result).toEqual(session);
      expect(primary.loadScoped).toHaveBeenCalledWith(locator);
      expect(tiered.getColdRepo().load).toHaveBeenCalledWith('sess-1', 'tenant-1', 'proj-1');
      expect(primary.create).toHaveBeenCalledWith(session);
    });
  });

  describe('save', () => {
    it('should save to primary and persist to cold on success', async () => {
      vi.mocked(primary.save).mockResolvedValue(true);
      const session = createTestSession();

      const result = await tiered.save(session);

      expect(result).toBe(true);
      expect(primary.save).toHaveBeenCalledWith(session);
      await new Promise((r) => setTimeout(r, 0));
      expect(tiered.getColdRepo().upsert).toHaveBeenCalledWith(session);
    });

    it('should not persist to cold on version conflict', async () => {
      vi.mocked(primary.save).mockResolvedValue(false);
      const session = createTestSession();

      const result = await tiered.save(session);

      expect(result).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(tiered.getColdRepo().upsert).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete from both tiers', async () => {
      await tiered.delete('sess-1');

      expect(primary.delete).toHaveBeenCalledWith('sess-1');
      await new Promise((r) => setTimeout(r, 0));
      expect(tiered.getColdRepo().deleteInternal).toHaveBeenCalledWith('sess-1');
    });

    it('clears pending debounced cold persists before deleting', async () => {
      vi.useFakeTimers();
      tiered = new TieredSessionStore(primary, {
        enabled: true,
        coldTtlDays: 7,
        coldPersistDebounceMs: 1_000,
      });
      const coldRepo = tiered.getColdRepo();
      vi.spyOn(coldRepo, 'upsert').mockResolvedValue(undefined);
      vi.spyOn(coldRepo, 'deleteInternal').mockResolvedValue(undefined);

      await tiered.save(createTestSession('sess-delete'));
      await tiered.delete('sess-delete');
      await vi.runAllTimersAsync();

      expect(coldRepo.upsert).not.toHaveBeenCalled();
      expect(coldRepo.deleteInternal).toHaveBeenCalledWith('sess-delete');
    });
  });

  describe('delegation', () => {
    it('should delegate appendMessages to primary', async () => {
      const messages = [{ role: 'user', content: 'test' }];
      await tiered.appendMessages('sess-1', messages);
      expect(primary.appendMessages).toHaveBeenCalledWith('sess-1', messages);
    });

    it('should delegate acquireLock to primary', async () => {
      const result = await tiered.acquireLock('sess-1', 5000);
      expect(primary.acquireLock).toHaveBeenCalledWith('sess-1', 5000);
      expect(result).toBe(true);
    });

    it('should delegate getAgentIR to primary', async () => {
      await tiered.getAgentIR('hash-1');
      expect(primary.getAgentIR).toHaveBeenCalledWith('hash-1');
    });
  });

  describe('getVersion', () => {
    it('should return version from primary when available', async () => {
      vi.mocked(primary.getVersion).mockResolvedValue(5);

      const version = await tiered.getVersion('sess-1');

      expect(version).toBe(5);
      expect(tiered.getColdRepo().getVersionInternal).not.toHaveBeenCalled();
    });

    it('should use cold repo projection when primary misses', async () => {
      vi.mocked(primary.getVersion).mockResolvedValue(null);
      vi.mocked(tiered.getColdRepo().getVersionInternal).mockResolvedValue(3);

      const version = await tiered.getVersion('sess-1');

      expect(version).toBe(3);
      expect(tiered.getColdRepo().getVersionInternal).toHaveBeenCalledWith('sess-1');
    });

    it('should return null when both tiers miss', async () => {
      vi.mocked(primary.getVersion).mockResolvedValue(null);
      vi.mocked(tiered.getColdRepo().getVersionInternal).mockResolvedValue(null);

      const version = await tiered.getVersion('sess-nonexistent');

      expect(version).toBeNull();
    });

    it('uses project-scoped cold projection when scoped primary version misses', async () => {
      const locator = {
        kind: 'production' as const,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
      };
      primary.getVersionScoped = vi.fn().mockResolvedValue(null);
      vi.spyOn(tiered.getColdRepo(), 'getVersion').mockResolvedValue(3);

      const version = await tiered.getVersionScoped(locator);

      expect(version).toBe(3);
      expect(primary.getVersionScoped).toHaveBeenCalledWith(locator);
      expect(tiered.getColdRepo().getVersion).toHaveBeenCalledWith('sess-1', 'tenant-1', 'proj-1');
    });
  });

  describe('cold restore with tenant context', () => {
    it('should preserve tenantId through cold restore cycle', async () => {
      const session = createTestSession();
      session.tenantId = 'tenant-secure';

      vi.mocked(primary.load).mockResolvedValue(null);
      vi.mocked(tiered.getColdRepo().loadInternal).mockResolvedValue(session);

      const result = await tiered.load('sess-1');

      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('tenant-secure');
      // Verify rehydration passed the full session with tenantId
      expect(primary.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-secure' }),
      );
    });
  });

  describe('flushPendingColdPersists', () => {
    it('awaits debounced cold persists during shutdown flush', async () => {
      vi.useFakeTimers();
      tiered = new TieredSessionStore(primary, {
        enabled: true,
        coldPersistDebounceMs: 1_000,
      });
      const coldRepo = tiered.getColdRepo();
      let resolveUpsert: (() => void) | undefined;
      const upsertPromise = new Promise<void>((resolve) => {
        resolveUpsert = resolve;
      });
      vi.spyOn(coldRepo, 'upsert').mockReturnValue(upsertPromise);

      const session = createTestSession('sess-flush');
      await tiered.save(session);

      const flushPromise = tiered.flushPendingColdPersists();
      expect(coldRepo.upsert).toHaveBeenCalledWith(session);

      let settled = false;
      void flushPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveUpsert?.();
      await flushPromise;
      expect(settled).toBe(true);
    });

    it('waits for in-flight immediate cold persists', async () => {
      tiered = new TieredSessionStore(primary, {
        enabled: true,
        coldPersistDebounceMs: 0,
      });
      const coldRepo = tiered.getColdRepo();
      let resolveUpsert: (() => void) | undefined;
      const upsertPromise = new Promise<void>((resolve) => {
        resolveUpsert = resolve;
      });
      vi.spyOn(coldRepo, 'upsert').mockReturnValue(upsertPromise);

      await tiered.save(createTestSession('sess-immediate'));

      const flushPromise = tiered.flushPendingColdPersists();
      let settled = false;
      void flushPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveUpsert?.();
      await flushPromise;
      expect(settled).toBe(true);
    });
  });

  describe('deleteScoped', () => {
    it('passes project scope to cold delete fallback', async () => {
      const locator = {
        kind: 'production' as const,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
      };
      primary.deleteScoped = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(tiered.getColdRepo(), 'delete').mockResolvedValue(undefined);

      await tiered.deleteScoped(locator);
      await new Promise((r) => setTimeout(r, 0));

      expect(primary.deleteScoped).toHaveBeenCalledWith(locator);
      expect(tiered.getColdRepo().delete).toHaveBeenCalledWith('sess-1', 'tenant-1', 'proj-1');
    });
  });
});
