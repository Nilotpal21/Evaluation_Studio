/**
 * Session Service — Comprehensive Unit Tests
 *
 * Covers:
 * - SessionService: hash computation, session lifecycle, IR/compilation caching,
 *   agent registry, execution locks, conversation management, config access
 * - MemorySessionStore: full CRUD, conversation ops, IR/compilation caching,
 *   registry, locking, TTL touch, version-based concurrency
 * - RedisSessionStore: serialization/deserialization, key layout, gzip round-trips,
 *   encryption integration, lock owner semantics, TTL management
 * - LRU cache (internal): eviction, hit promotion, size limits
 * - Factory functions: getSessionService, createSessionService, resetSessionService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionData, HydratedSession } from '../../services/session/types.js';
import { DEFAULT_SESSION_CONFIG } from '../../services/session/types.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';

const mockIsTenantEncryptionReady = vi.hoisted(() => vi.fn(() => true));
const mockEncryptForTenantAuto = vi.hoisted(() => vi.fn(async (plaintext: string) => plaintext));
const mockDecryptForTenantAuto = vi.hoisted(() => vi.fn(async (ciphertext: string) => ciphertext));

vi.mock('@agent-platform/shared/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared/encryption')>();
  return {
    ...actual,
    isTenantEncryptionReady: mockIsTenantEncryptionReady,
    encryptForTenantAuto: mockEncryptForTenantAuto,
    decryptForTenantAuto: mockDecryptForTenantAuto,
  };
});

import {
  SessionService,
  configureSessionServiceDefaults,
  createSessionService,
  ensureSessionService,
  getSessionService,
  resetSessionService,
  SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR,
  SESSION_SERVICE_SYNC_REDIS_INIT_ERROR,
} from '../../services/session/session-service.js';

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createMockAgentIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test-agent', version: '1.0', description: 'A test agent' },
    execution: { mode: 'reasoning' },
    identity: { persona: 'helpful assistant', goal: 'help users' },
    tools: [],
    messages: {},
    ...overrides,
  } as AgentIR;
}

function createDifferentAgentIR(): AgentIR {
  return createMockAgentIR({
    metadata: { name: 'different-agent', version: '2.0', description: 'A different agent' },
    execution: { mode: 'scripted' },
  } as Partial<AgentIR>);
}

function createMockCompilationOutput(agentName = 'test-agent'): CompilationOutput {
  const ir = createMockAgentIR({
    metadata: { name: agentName, version: '1.0', description: agentName },
  } as Partial<AgentIR>);
  return {
    version: '1.0',
    compiled_at: '2025-01-01T00:00:00Z',
    agents: { [agentName]: ir },
    entry_agent: agentName,
  } as CompilationOutput;
}

function createDifferentCompilationOutput(): CompilationOutput {
  return createMockCompilationOutput('different-agent');
}

const DEFAULT_CREATE_PARAMS = {
  id: 'sess-001',
  agentName: 'test-agent',
  agentIR: createMockAgentIR(),
  compilationOutput: createMockCompilationOutput(),
};

// =============================================================================
// SessionService — Hash Utilities
// =============================================================================

describe('SessionService', () => {
  let store: MemorySessionStore;
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionService();
    store = new MemorySessionStore();
    service = new SessionService(store);
  });

  // =========================================================================
  // computeIRHash
  // =========================================================================

  describe('computeIRHash', () => {
    it('returns a 16-character hex string', () => {
      const hash = service.computeIRHash(createMockAgentIR());
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('returns the same hash for identical IR objects', () => {
      const ir = createMockAgentIR();
      const hash1 = service.computeIRHash(ir);
      const hash2 = service.computeIRHash(ir);
      expect(hash1).toBe(hash2);
    });

    it('returns the same hash for structurally identical IR objects', () => {
      const ir1 = createMockAgentIR();
      const ir2 = createMockAgentIR();
      expect(service.computeIRHash(ir1)).toBe(service.computeIRHash(ir2));
    });

    it('returns different hashes for different IR objects', () => {
      const ir1 = createMockAgentIR();
      const ir2 = createDifferentAgentIR();
      expect(service.computeIRHash(ir1)).not.toBe(service.computeIRHash(ir2));
    });

    it('is sensitive to minor field changes', () => {
      const ir1 = createMockAgentIR();
      const ir2 = createMockAgentIR({
        metadata: { name: 'test-agent', version: '1.1', description: 'A test agent' },
      } as Partial<AgentIR>);
      expect(service.computeIRHash(ir1)).not.toBe(service.computeIRHash(ir2));
    });

    it('handles empty tools array', () => {
      const ir = createMockAgentIR({ tools: [] } as Partial<AgentIR>);
      const hash = service.computeIRHash(ir);
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  // =========================================================================
  // computeCompilationHash
  // =========================================================================

  describe('computeCompilationHash', () => {
    it('returns a 16-character hex string', () => {
      const hash = service.computeCompilationHash(createMockCompilationOutput());
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('returns the same hash for identical compilation outputs', () => {
      const co = createMockCompilationOutput();
      const hash1 = service.computeCompilationHash(co);
      const hash2 = service.computeCompilationHash(co);
      expect(hash1).toBe(hash2);
    });

    it('returns the same hash for structurally identical outputs', () => {
      const co1 = createMockCompilationOutput();
      const co2 = createMockCompilationOutput();
      expect(service.computeCompilationHash(co1)).toBe(service.computeCompilationHash(co2));
    });

    it('returns different hashes for different compilation outputs', () => {
      const co1 = createMockCompilationOutput();
      const co2 = createDifferentCompilationOutput();
      expect(service.computeCompilationHash(co1)).not.toBe(service.computeCompilationHash(co2));
    });
  });

  // =========================================================================
  // createSession
  // =========================================================================

  describe('createSession', () => {
    it('creates a session with all required fields', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);

      expect(session.id).toBe('sess-001');
      expect(session.agentName).toBe('test-agent');
      expect(session.version).toBe(0);
      expect(session.isComplete).toBe(false);
      expect(session.isEscalated).toBe(false);
      expect(session.conversationHistory).toEqual([]);
      expect(session.threads).toEqual([]);
      expect(session.activeThreadIndex).toBe(0);
      expect(session.threadStack).toEqual([]);
      expect(session.initialized).toBe(false);
    });

    it('returns a HydratedSession with agentIR and compilationOutput', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);

      expect(session.agentIR).toBeDefined();
      expect(session.agentIR!.metadata.name).toBe('test-agent');
      expect(session.compilationOutput).toBeDefined();
      expect(session.compilationOutput!.entry_agent).toBe('test-agent');
    });

    it('computes and stores IR hash', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);

      expect(session.irSourceHash).toMatch(/^[a-f0-9]{16}$/);
      // Should be retrievable from store
      const storedIR = await store.getAgentIR(session.irSourceHash);
      expect(storedIR).toBeDefined();
    });

    it('computes and stores compilation hash', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);

      expect(session.compilationHash).toMatch(/^[a-f0-9]{16}$/);
      const storedComp = await store.getCompilationOutput(session.compilationHash!);
      expect(storedComp).toBeDefined();
    });

    it('persists session to the store', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);

      const loaded = await store.load('sess-001');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('sess-001');
    });

    it('sets handoffStack to the agent name when not provided', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      expect(session.handoffStack).toEqual(['test-agent']);
    });

    it('uses provided handoffStack when specified', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        handoffStack: ['supervisor', 'test-agent'],
      });
      expect(session.handoffStack).toEqual(['supervisor', 'test-agent']);
    });

    it('sets channel in dataValues from initialContext', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        initialContext: { session: { channel: 'web-sdk' }, custom: 'value' },
      });
      expect(session.dataValues).toEqual({ session: { channel: 'web-sdk' }, custom: 'value' });
    });

    it('defaults channel to digital when no initialContext or channel', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      expect(session.dataValues).toEqual({ session: { channel: 'digital' } });
    });

    it('uses provided channel when no initialContext', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        channel: 'voice',
      });
      expect(session.dataValues).toEqual({ session: { channel: 'voice' } });
    });

    it('sets currentFlowStep when isFlowMode is true', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        isFlowMode: true,
        entryPoint: 'welcome_step',
      });
      expect(session.currentFlowStep).toBe('welcome_step');
    });

    it('does not set currentFlowStep when isFlowMode is false', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        isFlowMode: false,
        entryPoint: 'welcome_step',
      });
      expect(session.currentFlowStep).toBeUndefined();
    });

    it('does not set currentFlowStep when isFlowMode is not provided', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      expect(session.currentFlowStep).toBeUndefined();
    });

    it('stores tenantId, authToken, userId, deploymentId, environment', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        tenantId: 'org-123',
        authToken: 'secret-token',
        userId: 'user-456',
        deploymentId: 'deploy-789',
        environment: 'production',
      });
      expect(session.tenantId).toBe('org-123');
      expect(session.authToken).toBe('secret-token');
      expect(session.userId).toBe('user-456');
      expect(session.deploymentId).toBe('deploy-789');
      expect(session.environment).toBe('production');
    });

    it('stores agentVersions when provided', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        agentVersions: { 'test-agent': 3, 'helper-agent': 1 },
      });
      expect(session.agentVersions).toEqual({ 'test-agent': 3, 'helper-agent': 1 });
    });

    it('sets createdAt and lastActivityAt to current timestamp', async () => {
      const before = Date.now();
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      const after = Date.now();

      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(after);
      expect(session.lastActivityAt).toBe(session.createdAt);
    });

    it('handles null agentIR', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        agentIR: null,
      });
      expect(session.irSourceHash).toBe('');
      expect(session.agentIR).toBeNull();
    });

    it('handles null compilationOutput', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        compilationOutput: null,
      });
      expect(session.compilationHash).toBeNull();
      expect(session.compilationOutput).toBeNull();
    });

    it('handles both null agentIR and compilationOutput', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        agentIR: null,
        compilationOutput: null,
      });
      expect(session.irSourceHash).toBe('');
      expect(session.compilationHash).toBeNull();
      expect(session.agentIR).toBeNull();
      expect(session.compilationOutput).toBeNull();
    });

    it('initializes state with default gatherProgress, conversationPhase, and context', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      expect(session.state).toEqual({
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      });
    });

    it('initializes dataGatheredKeys as empty array', async () => {
      const session = await service.createSession(DEFAULT_CREATE_PARAMS);
      expect(session.dataGatheredKeys).toEqual([]);
    });
  });

  // =========================================================================
  // loadSession
  // =========================================================================

  describe('loadSession', () => {
    it('loads a previously created session', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const session = await service.loadSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.id).toBe('sess-001');
      expect(session!.agentName).toBe('test-agent');
    });

    it('returns null for a non-existent session', async () => {
      const session = await service.loadSession('nonexistent');
      expect(session).toBeNull();
    });

    it('resolves agentIR from L1 cache', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const session = await service.loadSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.agentIR).toBeDefined();
      expect(session!.agentIR!.metadata.name).toBe('test-agent');
    });

    it('resolves compilationOutput from L1 cache', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const session = await service.loadSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.compilationOutput).toBeDefined();
      expect(session!.compilationOutput!.entry_agent).toBe('test-agent');
    });

    it('falls back to L2 (store) when L1 is empty', async () => {
      // Create session — this populates both L1 and L2
      const created = await service.createSession(DEFAULT_CREATE_PARAMS);

      // Create a new service with the same store but empty L1
      const service2 = new SessionService(store);
      const session = await service2.loadSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.agentIR).toBeDefined();
      expect(session!.agentIR!.metadata.name).toBe('test-agent');
    });

    it('falls back to L2 for compilationOutput when L1 is empty', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);

      const service2 = new SessionService(store);
      const session = await service2.loadSession('sess-001');

      expect(session).not.toBeNull();
      expect(session!.compilationOutput).toBeDefined();
    });

    it('warns when IR hash exists but IR is not found', async () => {
      const { setLogHandler } = await import('@abl/compiler/platform');
      const logEntries: Array<{ level: string; message: string }> = [];
      setLogHandler((entry) => logEntries.push(entry));
      try {
        // Manually create session data with a hash that has no IR in cache
        const sessionData: SessionData = {
          id: 'sess-orphan',
          agentName: 'orphan-agent',
          irSourceHash: 'nonexistent-hash',
          compilationHash: null,
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          version: 0,
          isComplete: false,
          isEscalated: false,
          handoffStack: ['orphan-agent'],
          initialized: false,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          threads: [],
          activeThreadIndex: 0,
          threadStack: [],
        };
        await store.create(sessionData);

        const session = await service.loadSession('sess-orphan');
        expect(session).not.toBeNull();
        expect(session!.agentIR).toBeNull();
        expect(
          logEntries.find(
            (entry) =>
              entry.level === 'warn' &&
              entry.message.includes('IR not found for hash "nonexistent-hash"'),
          ),
        ).toBeDefined();
      } finally {
        setLogHandler(null);
      }
    });

    it('warns when compilation hash exists but output is not found', async () => {
      const { setLogHandler } = await import('@abl/compiler/platform');
      const logEntries: Array<{ level: string; message: string }> = [];
      setLogHandler((entry) => logEntries.push(entry));
      try {
        const sessionData: SessionData = {
          id: 'sess-orphan-comp',
          agentName: 'orphan-agent',
          irSourceHash: '',
          compilationHash: 'nonexistent-comp-hash',
          conversationHistory: [],
          state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
          dataValues: {},
          dataGatheredKeys: [],
          version: 0,
          isComplete: false,
          isEscalated: false,
          handoffStack: ['orphan-agent'],
          initialized: false,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          threads: [],
          activeThreadIndex: 0,
          threadStack: [],
        };
        await store.create(sessionData);

        const session = await service.loadSession('sess-orphan-comp');
        expect(session).not.toBeNull();
        expect(session!.compilationOutput).toBeNull();
        expect(
          logEntries.find(
            (entry) =>
              entry.level === 'warn' &&
              entry.message.includes(
                'CompilationOutput not found for hash "nonexistent-comp-hash"',
              ),
          ),
        ).toBeDefined();
      } finally {
        setLogHandler(null);
      }
    });

    it('returns agentIR as null when irSourceHash is empty', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        agentIR: null,
      });

      const loaded = await service.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.agentIR).toBeNull();
    });

    it('returns compilationOutput as null when compilationHash is null', async () => {
      const session = await service.createSession({
        ...DEFAULT_CREATE_PARAMS,
        compilationOutput: null,
      });

      const loaded = await service.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.compilationOutput).toBeNull();
    });
  });

  // =========================================================================
  // saveSession
  // =========================================================================

  describe('saveSession', () => {
    it('saves session and increments version', async () => {
      const created = await service.createSession(DEFAULT_CREATE_PARAMS);
      const success = await service.saveSession(created);

      expect(success).toBe(true);

      const loaded = await service.loadSession('sess-001');
      expect(loaded!.version).toBe(1);
    });

    it('updates lastActivityAt', async () => {
      const created = await service.createSession(DEFAULT_CREATE_PARAMS);
      const originalTimestamp = created.lastActivityAt;

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.saveSession(created);

      const loaded = await service.loadSession('sess-001');
      expect(loaded!.lastActivityAt).toBeGreaterThanOrEqual(originalTimestamp);
    });

    it('returns false for non-existent session', async () => {
      const fakeSession: SessionData = {
        id: 'nonexistent',
        agentName: 'test-agent',
        irSourceHash: '',
        compilationHash: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        version: 1,
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        initialized: false,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };
      const success = await service.saveSession(fakeSession);
      expect(success).toBe(false);
    });

    it('supports optimistic concurrency — second save with stale version fails', async () => {
      const created = await service.createSession(DEFAULT_CREATE_PARAMS);

      // First save succeeds
      const success1 = await service.saveSession(created);
      expect(success1).toBe(true);

      // Second save with same version object fails (stale version)
      const success2 = await service.saveSession(created);
      expect(success2).toBe(false);
    });

    it('persists modified fields', async () => {
      const created = await service.createSession(DEFAULT_CREATE_PARAMS);
      created.isComplete = true;
      created.escalationReason = 'user requested';

      await service.saveSession(created);

      const loaded = await service.loadSession('sess-001');
      expect(loaded!.isComplete).toBe(true);
      expect(loaded!.escalationReason).toBe('user requested');
    });
  });

  // =========================================================================
  // deleteSession
  // =========================================================================

  describe('deleteSession', () => {
    it('removes session from store', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      await service.deleteSession('sess-001');

      const loaded = await service.loadSession('sess-001');
      expect(loaded).toBeNull();
    });

    it('does not throw for non-existent session', async () => {
      await expect(service.deleteSession('nonexistent')).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // appendToConversation
  // =========================================================================

  describe('appendToConversation', () => {
    it('appends messages to the session conversation', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);

      await service.appendToConversation('sess-001', [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);

      const history = await store.getConversationHistory('sess-001');
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });

    it('trims conversation to configured window size', async () => {
      const smallWindowService = new SessionService(store, { conversationWindow: 3 });
      await smallWindowService.createSession(DEFAULT_CREATE_PARAMS);

      // Append system message first, then more than window allows
      await smallWindowService.appendToConversation('sess-001', [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'resp1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'resp2' },
      ]);

      const history = await store.getConversationHistory('sess-001');
      // After trim: first message (system) + last 2
      expect(history.length).toBeLessThanOrEqual(3);
    });
  });

  // =========================================================================
  // cacheAgentIR / resolveAgentIR
  // =========================================================================

  describe('cacheAgentIR / resolveAgentIR', () => {
    it('caches IR and returns its hash', async () => {
      const ir = createMockAgentIR();
      const hash = await service.cacheAgentIR(ir);

      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('resolves cached IR by hash', async () => {
      const ir = createMockAgentIR();
      const hash = await service.cacheAgentIR(ir);

      const resolved = await service.resolveAgentIR(hash);
      expect(resolved).toBeDefined();
      expect(resolved!.metadata.name).toBe('test-agent');
    });

    it('returns null for unknown hash', async () => {
      const resolved = await service.resolveAgentIR('unknown-hash');
      expect(resolved).toBeNull();
    });

    it('returns null for empty hash', async () => {
      const resolved = await service.resolveAgentIR('');
      expect(resolved).toBeNull();
    });

    it('resolves from L2 after L1 miss', async () => {
      const ir = createMockAgentIR();
      const hash = await service.cacheAgentIR(ir);

      // New service with same store but empty L1
      const service2 = new SessionService(store);
      const resolved = await service2.resolveAgentIR(hash);
      expect(resolved).toBeDefined();
      expect(resolved!.metadata.name).toBe('test-agent');
    });

    it('promotes to L1 after L2 resolve', async () => {
      const ir = createMockAgentIR();
      const hash = await service.cacheAgentIR(ir);

      const service2 = new SessionService(store);
      // First call — L1 miss, L2 hit
      await service2.resolveAgentIR(hash);

      // Delete from L2 store
      // @ts-expect-error — accessing internal for test
      store['irCache'].delete(hash);

      // Second call — should hit L1
      const resolved = await service2.resolveAgentIR(hash);
      expect(resolved).toBeDefined();
    });
  });

  // =========================================================================
  // cacheCompilationOutput / resolveCompilationOutput
  // =========================================================================

  describe('cacheCompilationOutput / resolveCompilationOutput', () => {
    it('caches compilation output and returns its hash', async () => {
      const co = createMockCompilationOutput();
      const hash = await service.cacheCompilationOutput(co);

      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('resolves cached compilation by hash', async () => {
      const co = createMockCompilationOutput();
      const hash = await service.cacheCompilationOutput(co);

      const resolved = await service.resolveCompilationOutput(hash);
      expect(resolved).toBeDefined();
      expect(resolved!.entry_agent).toBe('test-agent');
    });

    it('returns null for unknown hash', async () => {
      const resolved = await service.resolveCompilationOutput('unknown');
      expect(resolved).toBeNull();
    });

    it('returns null for empty hash', async () => {
      const resolved = await service.resolveCompilationOutput('');
      expect(resolved).toBeNull();
    });

    it('resolves from L2 after L1 miss', async () => {
      const co = createMockCompilationOutput();
      const hash = await service.cacheCompilationOutput(co);

      const service2 = new SessionService(store);
      const resolved = await service2.resolveCompilationOutput(hash);
      expect(resolved).toBeDefined();
    });

    it('promotes to L1 after L2 resolve', async () => {
      const co = createMockCompilationOutput();
      const hash = await service.cacheCompilationOutput(co);

      const service2 = new SessionService(store);
      await service2.resolveCompilationOutput(hash);

      // @ts-expect-error — accessing internal for test
      store['compilationCache'].delete(hash);

      const resolved = await service2.resolveCompilationOutput(hash);
      expect(resolved).toBeDefined();
    });
  });

  // =========================================================================
  // Agent Registry
  // =========================================================================

  describe('setAgentRegistry / getAgentRegistry', () => {
    it('stores and retrieves agent registry', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const registry = { 'agent-a': 'hash-a', 'agent-b': 'hash-b' };

      await service.setAgentRegistry('sess-001', registry);
      const result = await service.getAgentRegistry('sess-001');

      expect(result).toEqual(registry);
    });

    it('returns null when no registry set', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const result = await service.getAgentRegistry('sess-001');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Execution Lock
  // =========================================================================

  describe('acquireLock / releaseLock', () => {
    it('acquires lock successfully', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);
      const acquired = await service.acquireLock('sess-001');
      expect(acquired).toBe(true);
    });

    it('fails to acquire lock when already held', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);

      const first = await service.acquireLock('sess-001');
      expect(first).toBe(true);

      const second = await service.acquireLock('sess-001');
      expect(second).toBe(false);
    });

    it('can acquire lock after release', async () => {
      await service.createSession(DEFAULT_CREATE_PARAMS);

      await service.acquireLock('sess-001');
      await service.releaseLock('sess-001');

      const reacquired = await service.acquireLock('sess-001');
      expect(reacquired).toBe(true);
    });
  });

  // =========================================================================
  // Config Access
  // =========================================================================

  describe('getConfig', () => {
    it('returns default config when none provided', () => {
      const config = service.getConfig();
      expect(config).toEqual(DEFAULT_SESSION_CONFIG);
    });

    it('returns merged config when partial config provided', () => {
      const customService = new SessionService(store, {
        conversationWindow: 20,
        lockTtlMs: 10000,
      });
      const config = customService.getConfig();
      expect(config.conversationWindow).toBe(20);
      expect(config.lockTtlMs).toBe(10000);
      // defaults preserved
      expect(config.irCacheMaxEntries).toBe(DEFAULT_SESSION_CONFIG.irCacheMaxEntries);
      expect(config.store).toBe('memory');
    });
  });

  // =========================================================================
  // Store access
  // =========================================================================

  describe('store property', () => {
    it('exposes the session store', () => {
      expect(service.store).toBe(store);
    });

    it('defaults to MemorySessionStore when no store provided', () => {
      const defaultService = new SessionService();
      expect(defaultService.store).toBeInstanceOf(MemorySessionStore);
    });

    it('treats default memory-backed services as non-distributed', () => {
      const defaultService = new SessionService();
      expect(defaultService.isDistributed()).toBe(false);
    });
  });
});

// =============================================================================
// MemorySessionStore
// =============================================================================

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;

  function makeSession(id: string, overrides: Partial<SessionData> = {}): SessionData {
    return {
      id,
      agentName: 'test-agent',
      irSourceHash: 'hash-123',
      compilationHash: 'comp-123',
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
      dataValues: {},
      dataGatheredKeys: [],
      version: 0,
      isComplete: false,
      isEscalated: false,
      handoffStack: ['test-agent'],
      initialized: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      threads: [],
      activeThreadIndex: 0,
      threadStack: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  // =========================================================================
  // Session CRUD
  // =========================================================================

  describe('create / load', () => {
    it('creates and loads a session', async () => {
      const session = makeSession('s1');
      await store.create(session);

      const loaded = await store.load('s1');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('s1');
      expect(loaded!.agentName).toBe('test-agent');
    });

    it('returns null for unknown session', async () => {
      const loaded = await store.load('unknown');
      expect(loaded).toBeNull();
    });

    it('returns a copy, not a reference', async () => {
      const session = makeSession('s1');
      await store.create(session);

      const loaded1 = await store.load('s1');
      const loaded2 = await store.load('s1');
      expect(loaded1).not.toBe(loaded2);
    });

    it('stores conversation history separately', async () => {
      const session = makeSession('s1', {
        conversationHistory: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      });
      await store.create(session);

      const loaded = await store.load('s1');
      expect(loaded!.conversationHistory).toHaveLength(2);
    });
  });

  describe('save', () => {
    it('saves session with correct version', async () => {
      await store.create(makeSession('s1'));

      const toSave = makeSession('s1', { version: 1, isComplete: true });
      const success = await store.save(toSave);
      expect(success).toBe(true);

      const loaded = await store.load('s1');
      expect(loaded!.isComplete).toBe(true);
      expect(loaded!.version).toBe(1);
    });

    it('rejects save on version conflict', async () => {
      await store.create(makeSession('s1', { version: 0 }));

      // version should be 1 (current + 1), but we supply 5
      const success = await store.save(makeSession('s1', { version: 5 }));
      expect(success).toBe(false);
    });

    it('rejects save for nonexistent session', async () => {
      const success = await store.save(makeSession('no-such'));
      expect(success).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes session and all associated data', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [{ role: 'user', content: 'hi' }]);
      await store.setAgentRegistry('s1', { a: 'hash' });

      await store.delete('s1');

      expect(await store.load('s1')).toBeNull();
      expect(await store.getConversationHistory('s1')).toEqual([]);
      expect(await store.getAgentRegistry('s1')).toBeNull();
    });
  });

  // =========================================================================
  // Conversation History
  // =========================================================================

  describe('appendMessages / getConversationHistory', () => {
    it('appends messages to conversation', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);

      const history = await store.getConversationHistory('s1');
      expect(history).toHaveLength(2);
    });

    it('appends multiple batches', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [{ role: 'user', content: 'one' }]);
      await store.appendMessages('s1', [{ role: 'user', content: 'two' }]);

      const history = await store.getConversationHistory('s1');
      expect(history).toHaveLength(2);
    });

    it('silently drops messages for unknown session', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await store.appendMessages('unknown', [{ role: 'user', content: 'x' }]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('appendMessages called for unknown session'),
      );
      consoleSpy.mockRestore();
    });

    it('limits history when limit is specified', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'resp1' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'resp2' },
      ]);

      const limited = await store.getConversationHistory('s1', 3);
      expect(limited).toHaveLength(3);
      // First message preserved (system), plus last 2
      expect(limited[0]).toEqual({ role: 'system', content: 'system' });
      expect(limited[2]).toEqual({ role: 'assistant', content: 'resp2' });
    });

    it('returns all messages when limit exceeds count', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [{ role: 'user', content: 'one' }]);

      const history = await store.getConversationHistory('s1', 100);
      expect(history).toHaveLength(1);
    });
  });

  describe('trimConversation', () => {
    it('trims conversation preserving first message', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'resp1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'resp2' },
        { role: 'user', content: 'msg3' },
      ]);

      await store.trimConversation('s1', 3);

      const history = await store.getConversationHistory('s1');
      expect(history).toHaveLength(3);
      expect(history[0]).toEqual({ role: 'system', content: 'system prompt' });
    });

    it('does nothing when conversation is within limit', async () => {
      await store.create(makeSession('s1'));
      await store.appendMessages('s1', [{ role: 'user', content: 'one' }]);

      await store.trimConversation('s1', 10);

      const history = await store.getConversationHistory('s1');
      expect(history).toHaveLength(1);
    });
  });

  // =========================================================================
  // IR / Compilation Cache
  // =========================================================================

  describe('AgentIR cache', () => {
    it('sets and gets AgentIR', async () => {
      const ir = createMockAgentIR();
      await store.setAgentIR('hash-1', ir);

      const retrieved = await store.getAgentIR('hash-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.metadata.name).toBe('test-agent');
    });

    it('returns null for unknown hash', async () => {
      const retrieved = await store.getAgentIR('unknown');
      expect(retrieved).toBeNull();
    });
  });

  describe('CompilationOutput cache', () => {
    it('sets and gets CompilationOutput', async () => {
      const co = createMockCompilationOutput();
      await store.setCompilationOutput('hash-1', co);

      const retrieved = await store.getCompilationOutput('hash-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.entry_agent).toBe('test-agent');
    });

    it('returns null for unknown hash', async () => {
      const retrieved = await store.getCompilationOutput('unknown');
      expect(retrieved).toBeNull();
    });
  });

  // =========================================================================
  // Agent Registry
  // =========================================================================

  describe('Agent registry', () => {
    it('sets and gets registry', async () => {
      await store.setAgentRegistry('s1', { a: 'hash-a' });
      const reg = await store.getAgentRegistry('s1');
      expect(reg).toEqual({ a: 'hash-a' });
    });

    it('returns null when no registry set', async () => {
      const reg = await store.getAgentRegistry('unknown');
      expect(reg).toBeNull();
    });

    it('stores a copy of the registry', async () => {
      const orig = { a: 'hash-a' };
      await store.setAgentRegistry('s1', orig);
      orig.a = 'modified';

      const reg = await store.getAgentRegistry('s1');
      expect(reg!.a).toBe('hash-a');
    });
  });

  // =========================================================================
  // Execution Lock
  // =========================================================================

  describe('Execution lock', () => {
    it('acquires lock and blocks second acquire', async () => {
      expect(await store.acquireLock('s1')).toBe(true);
      expect(await store.acquireLock('s1')).toBe(false);
    });

    it('releases lock allowing re-acquire', async () => {
      await store.acquireLock('s1');
      await store.releaseLock('s1');
      expect(await store.acquireLock('s1')).toBe(true);
    });

    it('allows independent locks per session', async () => {
      expect(await store.acquireLock('s1')).toBe(true);
      expect(await store.acquireLock('s2')).toBe(true);
    });

    it('release is idempotent', async () => {
      await store.releaseLock('nonexistent');
      // Should not throw
    });
  });

  // =========================================================================
  // TTL Touch
  // =========================================================================

  describe('touch', () => {
    it('updates lastActivityAt', async () => {
      const session = makeSession('s1', { lastActivityAt: 1000 });
      await store.create(session);

      await store.touch('s1');

      const loaded = await store.load('s1');
      expect(loaded!.lastActivityAt).toBeGreaterThan(1000);
    });

    it('does not throw for unknown session', async () => {
      await expect(store.touch('unknown')).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // Testing Helpers
  // =========================================================================

  describe('testing helpers', () => {
    it('getSessionCount returns count', async () => {
      expect(store.getSessionCount()).toBe(0);
      await store.create(makeSession('s1'));
      expect(store.getSessionCount()).toBe(1);
      await store.create(makeSession('s2'));
      expect(store.getSessionCount()).toBe(2);
    });

    it('getIRCacheSize returns count', async () => {
      expect(store.getIRCacheSize()).toBe(0);
      await store.setAgentIR('h1', createMockAgentIR());
      expect(store.getIRCacheSize()).toBe(1);
    });

    it('clear empties all maps', async () => {
      await store.create(makeSession('s1'));
      await store.setAgentIR('h1', createMockAgentIR());
      await store.setCompilationOutput('c1', createMockCompilationOutput());
      await store.setAgentRegistry('s1', { a: 'b' });
      await store.acquireLock('s1');

      store.clear();

      expect(store.getSessionCount()).toBe(0);
      expect(store.getIRCacheSize()).toBe(0);
      expect(await store.getCompilationOutput('c1')).toBeNull();
      expect(await store.getAgentRegistry('s1')).toBeNull();
      expect(await store.acquireLock('s1')).toBe(true); // lock cleared
    });
  });
});

// =============================================================================
// LRU Cache (internal, tested via SessionService behavior)
// =============================================================================

describe('LRU Cache behavior (via SessionService)', () => {
  it('evicts least recently used entries when cache is full', async () => {
    const store = new MemorySessionStore();
    const service = new SessionService(store, { irCacheMaxEntries: 2 });

    const ir1 = createMockAgentIR({
      metadata: { name: 'agent-1', version: '1', description: '' },
    } as Partial<AgentIR>);
    const ir2 = createMockAgentIR({
      metadata: { name: 'agent-2', version: '1', description: '' },
    } as Partial<AgentIR>);
    const ir3 = createMockAgentIR({
      metadata: { name: 'agent-3', version: '1', description: '' },
    } as Partial<AgentIR>);

    const hash1 = await service.cacheAgentIR(ir1);
    const hash2 = await service.cacheAgentIR(ir2);
    const hash3 = await service.cacheAgentIR(ir3); // evicts ir1 from L1

    // ir1 not in L1 but still in L2 (store)
    // Clear L2 to test L1 directly
    // @ts-expect-error — accessing internal
    store['irCache'].clear();

    // ir1 was evicted from L1, and L2 is cleared — should be null
    const resolved1 = await service.resolveAgentIR(hash1);
    expect(resolved1).toBeNull();

    // ir3 should still be in L1
    const resolved3 = await service.resolveAgentIR(hash3);
    expect(resolved3).toBeDefined();
    expect(resolved3!.metadata.name).toBe('agent-3');
  });

  it('promotes accessed entries to most-recently-used', async () => {
    const store = new MemorySessionStore();
    const service = new SessionService(store, { irCacheMaxEntries: 2 });

    const ir1 = createMockAgentIR({
      metadata: { name: 'agent-1', version: '1', description: '' },
    } as Partial<AgentIR>);
    const ir2 = createMockAgentIR({
      metadata: { name: 'agent-2', version: '1', description: '' },
    } as Partial<AgentIR>);
    const ir3 = createMockAgentIR({
      metadata: { name: 'agent-3', version: '1', description: '' },
    } as Partial<AgentIR>);

    const hash1 = await service.cacheAgentIR(ir1);
    const hash2 = await service.cacheAgentIR(ir2);

    // Access ir1 to promote it (make ir2 the LRU)
    await service.resolveAgentIR(hash1);

    // Cache ir3 — should evict ir2 (LRU), not ir1
    const hash3 = await service.cacheAgentIR(ir3);

    // Clear L2
    // @ts-expect-error — accessing internal
    store['irCache'].clear();

    // ir1 should be in L1 (was promoted)
    const resolved1 = await service.resolveAgentIR(hash1);
    expect(resolved1).toBeDefined();
    expect(resolved1!.metadata.name).toBe('agent-1');

    // ir2 was evicted
    const resolved2 = await service.resolveAgentIR(hash2);
    expect(resolved2).toBeNull();
  });
});

// =============================================================================
// RedisSessionStore — Serialization Tests (No real Redis)
// =============================================================================

describe('RedisSessionStore', () => {
  let mockRedis: Record<string, any>;
  let redisPipeline: Record<string, any>;
  let RedisSessionStore: any;

  beforeEach(async () => {
    // Create mock pipeline
    redisPipeline = {
      hmset: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      rpush: vi.fn().mockReturnThis(),
      hgetall: vi.fn().mockReturnThis(),
      lrange: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };

    // Create mock Redis client
    mockRedis = {
      pipeline: vi.fn(() => redisPipeline),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      getBuffer: vi.fn().mockResolvedValue(null),
      hgetall: vi.fn().mockResolvedValue({}),
      hmset: vi.fn().mockResolvedValue('OK'),
      hmget: vi.fn().mockResolvedValue([null, null]),
      expire: vi.fn().mockResolvedValue(1),
      eval: vi.fn().mockResolvedValue(1),
      lrange: vi.fn().mockResolvedValue([]),
    };

    // Dynamically import
    const mod = await import('../../services/session/redis-session-store.js');
    RedisSessionStore = mod.RedisSessionStore;
  });

  describe('constructor', () => {
    it('creates with default options', () => {
      const store = new RedisSessionStore(mockRedis);
      expect(store).toBeDefined();
    });

    it('creates with custom TTL options', () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: 60,
        irTtlMinutes: 240,
      });
      expect(store).toBeDefined();
    });
  });

  describe('create', () => {
    it('calls pipeline with correct session key prefix', async () => {
      const store = new RedisSessionStore(mockRedis);
      const sessionData: SessionData = {
        id: 's1',
        agentName: 'test-agent',
        irSourceHash: 'hash-123',
        compilationHash: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        version: 0,
        isComplete: false,
        isEscalated: false,
        handoffStack: ['test-agent'],
        initialized: false,
        tenantId: 'org-1',
        createdAt: 1000,
        lastActivityAt: 1000,
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };

      await store.create(sessionData);

      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(redisPipeline.hmset).toHaveBeenCalled();
      expect(redisPipeline.expire).toHaveBeenCalled();
      // Should also store reverse lookup
      expect(redisPipeline.set).toHaveBeenCalled();
      expect(redisPipeline.exec).toHaveBeenCalled();
    });

    it('stores conversation history when non-empty', async () => {
      const store = new RedisSessionStore(mockRedis);
      const sessionData: SessionData = {
        id: 's1',
        agentName: 'test-agent',
        irSourceHash: '',
        compilationHash: null,
        conversationHistory: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        version: 0,
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        initialized: false,
        tenantId: 'org-1',
        createdAt: 1000,
        lastActivityAt: 1000,
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };

      await store.create(sessionData);

      // rpush called for each message
      expect(redisPipeline.rpush).toHaveBeenCalledTimes(2);
    });
  });

  describe('load', () => {
    it('returns null when session not found', async () => {
      const store = new RedisSessionStore(mockRedis);
      redisPipeline.exec.mockResolvedValue([
        [null, {}],
        [null, []],
      ]);

      const loaded = await store.load('nonexistent');
      expect(loaded).toBeNull();
    });

    it('returns null when pipeline returns null', async () => {
      const store = new RedisSessionStore(mockRedis);
      redisPipeline.exec.mockResolvedValue(null);

      const loaded = await store.load('s1');
      expect(loaded).toBeNull();
    });

    it('returns null on hash error', async () => {
      const store = new RedisSessionStore(mockRedis);
      redisPipeline.exec.mockResolvedValue([
        [new Error('Redis error'), null],
        [null, []],
      ]);

      const loaded = await store.load('s1');
      expect(loaded).toBeNull();
    });

    it('deserializes session hash data correctly', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      redisPipeline.exec.mockResolvedValue([
        [
          null,
          {
            id: 's1',
            agentName: 'test-agent',
            irSourceHash: 'hash-123',
            version: '2',
            isComplete: 'false',
            isEscalated: 'true',
            escalationReason: 'user angry',
            initialized: 'true',
            createdAt: '1000',
            lastActivityAt: '2000',
            activeThreadIndex: '1',
            tenantId: 'org-1',
            deploymentId: 'dep-1',
            userId: 'user-1',
            environment: 'production',
            state: JSON.stringify({
              gatherProgress: {},
              conversationPhase: 'active',
              context: { key: 'val' },
            }),
            handoffStack: JSON.stringify(['supervisor', 'test-agent']),
            dataValues: JSON.stringify({ session: { channel: 'web' } }),
            dataGatheredKeys: JSON.stringify(['name', 'email']),
            threads: JSON.stringify([]),
            threadStack: JSON.stringify([]),
            agentVersions: JSON.stringify({ 'test-agent': 3 }),
          },
        ],
        [
          null,
          [
            JSON.stringify({ role: 'user', content: 'hello' }),
            JSON.stringify({ role: 'assistant', content: 'hi there' }),
          ],
        ],
      ]);

      const loaded = await store.load('s1');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('s1');
      expect(loaded!.agentName).toBe('test-agent');
      expect(loaded!.version).toBe(2);
      expect(loaded!.isComplete).toBe(false);
      expect(loaded!.isEscalated).toBe(true);
      expect(loaded!.escalationReason).toBe('user angry');
      expect(loaded!.initialized).toBe(true);
      expect(loaded!.createdAt).toBe(1000);
      expect(loaded!.lastActivityAt).toBe(2000);
      expect(loaded!.activeThreadIndex).toBe(1);
      expect(loaded!.tenantId).toBe('org-1');
      expect(loaded!.deploymentId).toBe('dep-1');
      expect(loaded!.userId).toBe('user-1');
      expect(loaded!.environment).toBe('production');
      expect(loaded!.state.conversationPhase).toBe('active');
      expect(loaded!.state.context).toEqual({ key: 'val' });
      expect(loaded!.handoffStack).toEqual(['supervisor', 'test-agent']);
      expect(loaded!.dataValues).toEqual({ session: { channel: 'web' } });
      expect(loaded!.dataGatheredKeys).toEqual(['name', 'email']);
      expect(loaded!.agentVersions).toEqual({ 'test-agent': 3 });
      expect(loaded!.conversationHistory).toHaveLength(2);
      expect(loaded!.conversationHistory[0]).toEqual({ role: 'user', content: 'hello' });
    });

    it('handles missing JSON fields with defaults', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      redisPipeline.exec.mockResolvedValue([
        [
          null,
          {
            id: 's1',
            agentName: 'test-agent',
            version: '0',
            createdAt: '1000',
            lastActivityAt: '1000',
          },
        ],
        [null, []],
      ]);

      const loaded = await store.load('s1');
      expect(loaded).not.toBeNull();
      expect(loaded!.state).toEqual({
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      });
      expect(loaded!.handoffStack).toEqual([]);
      expect(loaded!.dataValues).toEqual({});
      expect(loaded!.dataGatheredKeys).toEqual([]);
      expect(loaded!.threads).toEqual([]);
      expect(loaded!.threadStack).toEqual([]);
      expect(loaded!.isComplete).toBe(false);
      expect(loaded!.isEscalated).toBe(false);
      expect(loaded!.initialized).toBe(false);
      expect(loaded!.activeThreadIndex).toBe(0);
    });

    it('handles corrupted JSON gracefully', async () => {
      const { setLogHandler } = await import('@abl/compiler/platform');
      const logEntries: Array<{ level: string; message: string }> = [];
      setLogHandler((entry) => logEntries.push(entry));
      try {
        const store = new RedisSessionStore(mockRedis);
        mockRedis.get.mockResolvedValue('org-1');
        redisPipeline.exec.mockResolvedValue([
          [
            null,
            {
              id: 's1',
              agentName: 'test-agent',
              version: '0',
              createdAt: '1000',
              lastActivityAt: '1000',
              state: 'NOT VALID JSON{{{',
            },
          ],
          [null, []],
        ]);

        const loaded = await store.load('s1');
        expect(loaded).not.toBeNull();
        // Falls back to default state
        expect(loaded!.state).toEqual({
          gatherProgress: {},
          conversationPhase: 'start',
          context: {},
        });
        const warnEntry = logEntries.find(
          (e) => e.level === 'warn' && e.message.includes('corrupted JSON field'),
        );
        expect(warnEntry).toBeDefined();
      } finally {
        setLogHandler(null);
      }
    });

    it('skips corrupted conversation messages', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      redisPipeline.exec.mockResolvedValue([
        [
          null,
          {
            id: 's1',
            agentName: 'test-agent',
            version: '0',
            createdAt: '1000',
            lastActivityAt: '1000',
          },
        ],
        [
          null,
          [
            JSON.stringify({ role: 'user', content: 'valid' }),
            'NOT{VALID}JSON',
            JSON.stringify({ role: 'assistant', content: 'also valid' }),
          ],
        ],
      ]);

      const loaded = await store.load('s1');
      expect(loaded!.conversationHistory).toHaveLength(2);
      expect(loaded!.conversationHistory[0].content).toBe('valid');
      expect(loaded!.conversationHistory[1].content).toBe('also valid');
      consoleSpy.mockRestore();
    });
  });

  describe('save', () => {
    it('uses Lua script for atomic version check', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.eval.mockResolvedValue(1);

      const sessionData: SessionData = {
        id: 's1',
        agentName: 'test-agent',
        irSourceHash: '',
        compilationHash: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        version: 1, // SessionService already incremented
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        tenantId: 'org-1',
        initialized: false,
        createdAt: 1000,
        lastActivityAt: 1000,
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };

      const success = await store.save(sessionData);
      expect(success).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('returns false on version conflict', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.eval.mockResolvedValue(0); // conflict

      const sessionData: SessionData = {
        id: 's1',
        agentName: 'test-agent',
        irSourceHash: '',
        compilationHash: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: {},
        dataGatheredKeys: [],
        version: 1,
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        tenantId: 'org-1',
        initialized: false,
        createdAt: 1000,
        lastActivityAt: 1000,
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };

      const success = await store.save(sessionData);
      expect(success).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes all associated keys', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1'); // reverse lookup

      await store.delete('s1');

      expect(mockRedis.del).toHaveBeenCalledWith(
        'sess:org-1:s1',
        'sess:org-1:s1:conv',
        'registry:org-1:s1',
        'lock:exec:org-1:s1',
        'sess-tid:s1',
      );
    });

    it('handles explicit empty-tenant reverse lookup for legacy sessions', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue(''); // explicit empty-tenant reverse lookup

      await store.delete('s1');

      expect(mockRedis.del).toHaveBeenCalledWith(
        'sess::s1',
        'sess::s1:conv',
        'registry::s1',
        'lock:exec::s1',
        'sess-tid:s1',
      );
    });
  });

  describe('appendMessages', () => {
    it('does nothing for empty messages array', async () => {
      const store = new RedisSessionStore(mockRedis);
      await store.appendMessages('s1', []);
      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });

    it('pushes each message to the conversation list', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');

      await store.appendMessages('s1', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);

      expect(redisPipeline.rpush).toHaveBeenCalledTimes(2);
      expect(redisPipeline.expire).toHaveBeenCalled();
      expect(redisPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('AgentIR gzip cache', () => {
    it('stores gzipped IR and retrieves it', async () => {
      const { gzipSync } = await import('zlib');
      const store = new RedisSessionStore(mockRedis);
      const ir = createMockAgentIR();

      // Test setAgentIR
      await store.setAgentIR('hash-1', ir);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'ir:hash-1',
        expect.any(Buffer),
        'EX',
        expect.any(Number),
      );

      // Test getAgentIR
      const compressed = gzipSync(JSON.stringify(ir));
      mockRedis.getBuffer.mockResolvedValue(compressed);

      const retrieved = await store.getAgentIR('hash-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.metadata.name).toBe('test-agent');
    });

    it('returns null when buffer not found', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.getBuffer.mockResolvedValue(null);

      const retrieved = await store.getAgentIR('missing');
      expect(retrieved).toBeNull();
    });

    it('returns null on decompression error', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.getBuffer.mockResolvedValue(Buffer.from('not gzipped'));

      const retrieved = await store.getAgentIR('corrupt');
      expect(retrieved).toBeNull();
    });
  });

  describe('CompilationOutput gzip cache', () => {
    it('stores gzipped compilation and retrieves it', async () => {
      const { gzipSync } = await import('zlib');
      const store = new RedisSessionStore(mockRedis);
      const co = createMockCompilationOutput();

      await store.setCompilationOutput('hash-1', co);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'comp:hash-1',
        expect.any(Buffer),
        'EX',
        expect.any(Number),
      );

      const compressed = gzipSync(JSON.stringify(co));
      mockRedis.getBuffer.mockResolvedValue(compressed);

      const retrieved = await store.getCompilationOutput('hash-1');
      expect(retrieved).toBeDefined();
      expect(retrieved!.entry_agent).toBe('test-agent');
    });

    it('returns null when buffer not found', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.getBuffer.mockResolvedValue(null);

      const retrieved = await store.getCompilationOutput('missing');
      expect(retrieved).toBeNull();
    });

    it('returns null on decompression error', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.getBuffer.mockResolvedValue(Buffer.from('corrupt'));

      const retrieved = await store.getCompilationOutput('corrupt');
      expect(retrieved).toBeNull();
    });
  });

  describe('Agent registry', () => {
    it('sets registry with hmset and expire', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');

      await store.setAgentRegistry('s1', { 'agent-a': 'hash-a' });

      expect(mockRedis.hmset).toHaveBeenCalledWith('registry:org-1:s1', { 'agent-a': 'hash-a' });
      expect(mockRedis.expire).toHaveBeenCalled();
    });

    it('skips setting empty registry', async () => {
      const store = new RedisSessionStore(mockRedis);
      await store.setAgentRegistry('s1', {});
      expect(mockRedis.hmset).not.toHaveBeenCalled();
    });

    it('returns null when registry is empty', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.hgetall.mockResolvedValue({});

      const reg = await store.getAgentRegistry('s1');
      expect(reg).toBeNull();
    });

    it('returns registry data when present', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.hgetall.mockResolvedValue({ 'agent-a': 'hash-a' });

      const reg = await store.getAgentRegistry('s1');
      expect(reg).toEqual({ 'agent-a': 'hash-a' });
    });
  });

  describe('Execution lock', () => {
    it('acquires lock with NX and PX', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.set.mockResolvedValue('OK');

      const acquired = await store.acquireLock('s1', 3000);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'lock:exec:org-1:s1',
        expect.any(String),
        'PX',
        3000,
        'NX',
      );
      expect(acquired).toBe(true);
    });

    it('returns false when lock already held', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.set.mockResolvedValue(null); // lock not acquired

      const acquired = await store.acquireLock('s1');
      expect(acquired).toBe(false);
    });

    it('uses default 5000ms TTL when none specified', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');
      mockRedis.set.mockResolvedValue('OK');

      await store.acquireLock('s1');

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'PX',
        5000,
        'NX',
      );
    });

    it('releases lock using Lua CAS script', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');

      await store.releaseLock('s1');

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET'"),
        1,
        'lock:exec:org-1:s1',
        expect.any(String),
      );
    });
  });

  describe('TTL touch', () => {
    it('refreshes TTL on all session-related keys', async () => {
      const store = new RedisSessionStore(mockRedis);
      mockRedis.get.mockResolvedValue('org-1');

      await store.touch('s1');

      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(redisPipeline.expire).toHaveBeenCalledTimes(4);
      expect(redisPipeline.exec).toHaveBeenCalled();
    });
  });

  describe('encryption integration', () => {
    it('encrypts sensitive fields when EncryptionService provided', async () => {
      const mockEncryption = {
        encryptForTenant: vi.fn((value: string, _tenantId: string) => `ENCRYPTED:${value}`),
        decryptForTenant: vi.fn((value: string, _tenantId: string) =>
          value.replace('ENCRYPTED:', ''),
        ),
      };

      const store = new RedisSessionStore(mockRedis, {
        encryptionService: mockEncryption as any,
      });

      const sessionData: SessionData = {
        id: 's1',
        agentName: 'test-agent',
        irSourceHash: '',
        compilationHash: null,
        conversationHistory: [],
        state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
        dataValues: { key: 'value' },
        dataGatheredKeys: [],
        version: 0,
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        initialized: false,
        tenantId: 'org-1',
        authToken: 'secret-token',
        createdAt: 1000,
        lastActivityAt: 1000,
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
      };

      await store.create(sessionData);

      // Verify encryption was called for sensitive fields
      expect(mockEncryption.encryptForTenant).toHaveBeenCalled();

      // Check that authToken, state, dataValues were encrypted
      const hmsetCall = redisPipeline.hmset.mock.calls[0][1];
      expect(hmsetCall.authToken).toContain('enc:');
      expect(hmsetCall.state).toContain('enc:');
      expect(hmsetCall.dataValues).toContain('enc:');
    });

    it('encrypts conversation messages when EncryptionService provided', async () => {
      const mockEncryption = {
        encryptForTenant: vi.fn((value: string, _tenantId: string) => `ENC:${value}`),
        decryptForTenant: vi.fn((value: string, _tenantId: string) => value.replace('ENC:', '')),
      };

      const store = new RedisSessionStore(mockRedis, {
        encryptionService: mockEncryption as any,
      });
      mockRedis.get.mockResolvedValue('org-1');

      await store.appendMessages('s1', [{ role: 'user', content: 'secret message' }]);

      const rpushCall = redisPipeline.rpush.mock.calls[0];
      expect(rpushCall[1]).toContain('enc:');
    });

    it('decrypts fields on load when encrypted prefix present', async () => {
      const mockEncryption = {
        encryptForTenant: vi.fn((value: string) => `ENC:${value}`),
        decryptForTenant: vi.fn((value: string) => value.replace('ENC:', '')),
      };

      const store = new RedisSessionStore(mockRedis, {
        encryptionService: mockEncryption as any,
      });
      mockRedis.get.mockResolvedValue('org-1');

      redisPipeline.exec.mockResolvedValue([
        [
          null,
          {
            id: 's1',
            agentName: 'test-agent',
            version: '0',
            tenantId: 'org-1',
            authToken: 'enc:ENC:my-secret',
            state:
              'enc:ENC:' +
              JSON.stringify({ gatherProgress: {}, conversationPhase: 'start', context: {} }),
            dataValues: 'enc:ENC:' + JSON.stringify({ key: 'val' }),
            createdAt: '1000',
            lastActivityAt: '1000',
          },
        ],
        [null, []],
      ]);

      const loaded = await store.load('s1');
      expect(loaded).not.toBeNull();
      expect(mockEncryption.decryptForTenant).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Factory Functions
// =============================================================================

describe('Factory functions', () => {
  beforeEach(() => {
    resetSessionService();
  });

  describe('createSessionService', () => {
    it('creates a new SessionService with the given store', () => {
      const store = new MemorySessionStore();
      const service = createSessionService(store);

      expect(service).toBeInstanceOf(SessionService);
      expect(service.store).toBe(store);
    });

    it('accepts partial config', () => {
      const store = new MemorySessionStore();
      const service = createSessionService(store, { conversationWindow: 10 });

      expect(service.getConfig().conversationWindow).toBe(10);
    });
  });

  describe('ensureSessionService', () => {
    it('throws instead of creating a memory singleton when the effective config requires Redis', () => {
      configureSessionServiceDefaults({ store: 'redis' });

      expect(() => getSessionService()).toThrow(SESSION_SERVICE_SYNC_REDIS_INIT_ERROR);
    });

    it('upgrades an eagerly created memory singleton when Redis-backed storage is requested', async () => {
      vi.doMock('../../services/redis/redis-client.js', () => ({
        ensureRedisInitialized: vi.fn().mockResolvedValue(undefined),
        isRedisAvailable: vi.fn(() => true),
        getRedisClient: vi.fn(() => ({ status: 'ready' })),
      }));
      vi.doMock('../../services/session/redis-session-store.js', () => ({
        RedisSessionStore: class MockRedisSessionStore extends MemorySessionStore {},
      }));

      const earlyService = getSessionService();
      expect(earlyService.isDistributed()).toBe(false);

      const upgradedService = await ensureSessionService({
        store: 'redis',
        coldStorageEnabled: false,
      });

      expect(upgradedService).not.toBe(earlyService);
      expect(upgradedService.isDistributed()).toBe(true);
    });

    it('throws instead of silently falling back to memory when Redis bootstrap fails', async () => {
      vi.doMock('../../services/redis/redis-client.js', () => ({
        ensureRedisInitialized: vi.fn().mockResolvedValue(undefined),
        isRedisAvailable: vi.fn(() => false),
        getRedisClient: vi.fn(() => null),
      }));

      await expect(
        ensureSessionService({
          store: 'redis',
          coldStorageEnabled: false,
        }),
      ).rejects.toThrow(SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR);
    });

    it('allows explicit opportunistic fallback to memory for non-critical upgrades', async () => {
      vi.doMock('../../services/redis/redis-client.js', () => ({
        ensureRedisInitialized: vi.fn().mockResolvedValue(undefined),
        isRedisAvailable: vi.fn(() => false),
        getRedisClient: vi.fn(() => null),
      }));

      const service = await ensureSessionService(
        {
          store: 'redis',
          coldStorageEnabled: false,
        },
        { allowFallbackToMemory: true },
      );

      expect(service.isDistributed()).toBe(false);
    });
  });

  describe('resetSessionService', () => {
    it('does not throw when called multiple times', () => {
      expect(() => {
        resetSessionService();
        resetSessionService();
        resetSessionService();
      }).not.toThrow();
    });
  });

  afterEach(() => {
    vi.doUnmock('../services/redis/redis-client.js');
    vi.doUnmock('../services/session/redis-session-store.js');
  });
});

// =============================================================================
// Integration: Full session lifecycle via SessionService + MemorySessionStore
// =============================================================================

describe('Integration: Full session lifecycle', () => {
  let service: SessionService;

  beforeEach(() => {
    resetSessionService();
    service = new SessionService(new MemorySessionStore());
  });

  it('create -> load -> save -> load round-trip', async () => {
    // Create
    const created = await service.createSession({
      id: 'lifecycle-1',
      agentName: 'lifecycle-agent',
      agentIR: createMockAgentIR(),
      compilationOutput: createMockCompilationOutput(),
      channel: 'web-sdk',
      tenantId: 'org-1',
      userId: 'user-1',
    });
    expect(created.version).toBe(0);

    // Load
    const loaded1 = await service.loadSession('lifecycle-1');
    expect(loaded1!.agentName).toBe('lifecycle-agent');
    expect(loaded1!.agentIR).toBeDefined();

    // Modify and save
    loaded1!.isComplete = true;
    loaded1!.state.conversationPhase = 'completed';
    const saved = await service.saveSession(loaded1!);
    expect(saved).toBe(true);

    // Load again
    const loaded2 = await service.loadSession('lifecycle-1');
    expect(loaded2!.version).toBe(1);
    expect(loaded2!.isComplete).toBe(true);
    expect(loaded2!.state.conversationPhase).toBe('completed');
  });

  it('create -> append conversation -> load preserves messages', async () => {
    await service.createSession({
      id: 'conv-1',
      agentName: 'conv-agent',
      agentIR: createMockAgentIR(),
      compilationOutput: null,
    });

    await service.appendToConversation('conv-1', [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ]);

    const loaded = await service.loadSession('conv-1');
    expect(loaded!.conversationHistory).toHaveLength(3);
  });

  it('create -> delete -> load returns null', async () => {
    await service.createSession({
      id: 'del-1',
      agentName: 'del-agent',
      agentIR: null,
      compilationOutput: null,
    });

    await service.deleteSession('del-1');

    const loaded = await service.loadSession('del-1');
    expect(loaded).toBeNull();
  });

  it('multiple sessions are independent', async () => {
    await service.createSession({
      id: 'multi-1',
      agentName: 'agent-a',
      agentIR: createMockAgentIR(),
      compilationOutput: null,
    });

    await service.createSession({
      id: 'multi-2',
      agentName: 'agent-b',
      agentIR: createDifferentAgentIR(),
      compilationOutput: null,
    });

    const s1 = await service.loadSession('multi-1');
    const s2 = await service.loadSession('multi-2');

    expect(s1!.agentName).toBe('agent-a');
    expect(s2!.agentName).toBe('agent-b');
    expect(s1!.irSourceHash).not.toBe(s2!.irSourceHash);
  });

  it('lock prevents concurrent save', async () => {
    await service.createSession({
      id: 'lock-1',
      agentName: 'lock-agent',
      agentIR: null,
      compilationOutput: null,
    });

    const acquired1 = await service.acquireLock('lock-1');
    expect(acquired1).toBe(true);

    const acquired2 = await service.acquireLock('lock-1');
    expect(acquired2).toBe(false);

    await service.releaseLock('lock-1');

    const acquired3 = await service.acquireLock('lock-1');
    expect(acquired3).toBe(true);
  });

  it('agent registry is session-scoped', async () => {
    await service.createSession({
      id: 'reg-1',
      agentName: 'reg-agent',
      agentIR: null,
      compilationOutput: null,
    });
    await service.createSession({
      id: 'reg-2',
      agentName: 'reg-agent',
      agentIR: null,
      compilationOutput: null,
    });

    await service.setAgentRegistry('reg-1', { 'agent-x': 'hash-x' });
    await service.setAgentRegistry('reg-2', { 'agent-y': 'hash-y' });

    const reg1 = await service.getAgentRegistry('reg-1');
    const reg2 = await service.getAgentRegistry('reg-2');

    expect(reg1).toEqual({ 'agent-x': 'hash-x' });
    expect(reg2).toEqual({ 'agent-y': 'hash-y' });
  });
});
