/**
 * Runtime Lifecycle — Stale Session Reaper Tests
 *
 * Unit tests for the RuntimeExecutor's stale session reaper:
 * - startStaleReaper / stopStaleReaper
 * - reapStaleSessions / _doReap
 * - concurrency guard, memory ceiling, executing-session protection
 * - cleanup side-effects (persist, debounce timers, releaseSessionSlot, llmWiring)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock the rate-limiter dynamic import used inside _doReap
const mockReleaseSessionSlot = vi.fn().mockResolvedValue(0);
vi.mock('../middleware/rate-limiter.js', () => ({
  releaseSessionSlot: mockReleaseSessionSlot,
  __esModule: true,
  default: {},
  rateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  payloadSizeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock createLogger so the module loads without real logging infra
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock trace store (used at module level)
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn().mockReturnValue({
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    getSessionEvents: vi.fn().mockReturnValue([]),
  }),
}));

// Mock DB check (used at import time)
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(false),
}));

// Mock compiler / core — constructor calls none of these during reaper tests
vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn().mockReturnValue({ document: null, errors: [] }),
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: vi.fn(),
  DEFAULT_MESSAGES: {},
}));

// Mock adapters
vi.mock('../services/execution/noop-tool-executor.js', () => ({
  NoOpToolExecutor: class {},
}));

vi.mock('../services/adapters/index.js', () => ({
  MockToolExecutor: class {},
  TestAgentRegistry: class {},
  TestTraceManager: class {},
}));

// Mock execution sub-services so the constructor doesn't explode
vi.mock('../services/execution/llm-wiring.js', () => ({
  LLMWiringService: class {
    clearCooldown = vi.fn();
    getToolExecutor() {
      return null;
    }
  },
}));

vi.mock('../services/execution/routing-executor.js', () => ({
  RoutingExecutor: class {},
  deduplicateFanOutTasks: vi.fn(),
  formatFanOutToolResult: vi.fn(),
}));

vi.mock('../services/execution/flow-step-executor.js', () => ({
  FlowStepExecutor: class {},
}));

vi.mock('../services/execution/reasoning-executor.js', () => ({
  ReasoningExecutor: class {},
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  buildSystemPrompt: vi.fn(),
  buildTools: vi.fn(),
  isVoiceChannel: vi.fn(),
}));

vi.mock('../services/execution/constraint-checker.js', () => ({
  checkConstraints: vi.fn(),
  checkFlatConstraints: vi.fn(),
  handleConstraintViolation: vi.fn(),
  executeConstraintViolation: vi.fn(),
  setCurrentTurnInputContext: vi.fn(),
}));

vi.mock('../services/channel/channel-adapter.js', () => ({
  stripForVoice: vi.fn(),
}));

vi.mock('../services/execution/memory-integration.js', () => ({
  initializeAllMemory: vi.fn(),
}));

vi.mock('../services/stores/mongodb-fact-store.js', () => ({
  createMongoDBFactStore: vi.fn(),
}));

vi.mock('../services/execution/profile-resolver.js', () => ({
  assembleProfileContext: vi.fn(),
  resolveActiveProfiles: vi.fn(),
  buildEffectiveConfig: vi.fn(),
}));

vi.mock('../services/session/session-service.js', () => ({
  getSessionService: vi.fn().mockReturnValue({
    store: { load: vi.fn() },
    saveSession: vi.fn(),
    replaceConversation: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { RuntimeExecutor } from '../services/runtime-executor.js';
import type { RuntimeSession } from '../services/execution/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal RuntimeSession stub for testing */
function createMockSession(id: string, overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id,
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  } as RuntimeSession;
}

/** Shorthand for accessing private members */
function sessions(executor: RuntimeExecutor): Map<string, RuntimeSession> {
  return (executor as unknown as Record<string, Map<string, RuntimeSession>>).sessions;
}

function executingSet(executor: RuntimeExecutor): Set<string> {
  return (executor as unknown as Record<string, Set<string>>)._executingSessions;
}

function debounceTimers(executor: RuntimeExecutor): Map<string, NodeJS.Timeout> {
  return (executor as unknown as Record<string, Map<string, NodeJS.Timeout>>).persistDebounceTimers;
}

function voiceExecutors(executor: RuntimeExecutor): Map<string, unknown> {
  return (executor as unknown as Record<string, Map<string, unknown>>).realtimeVoiceExecutors;
}

// Stale reaper constants (mirrored from source)
const STALE_SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_IN_MEMORY_SESSIONS = 10_000;

// =============================================================================
// TESTS
// =============================================================================

describe('RuntimeExecutor — stale session reaper', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    vi.useFakeTimers();
    executor = new RuntimeExecutor();
    // Stop the auto-started reaper so tests have full control
    executor.stopStaleReaper();
  });

  afterEach(() => {
    executor.stopStaleReaper();
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockReleaseSessionSlot.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. startStaleReaper idempotency
  // -------------------------------------------------------------------------

  test('startStaleReaper is idempotent — second call does not create second timer', () => {
    // Access private startStaleReaper
    const start = (executor as unknown as { startStaleReaper: () => void }).startStaleReaper.bind(
      executor,
    );

    // First call sets the timer
    start();
    const firstTimer = (executor as unknown as Record<string, NodeJS.Timeout | null>)
      .staleReaperTimer;
    expect(firstTimer).not.toBeNull();

    // Second call should be a no-op — same timer reference
    start();
    const secondTimer = (executor as unknown as Record<string, NodeJS.Timeout | null>)
      .staleReaperTimer;
    expect(secondTimer).toBe(firstTimer);
  });

  // -------------------------------------------------------------------------
  // 2. Concurrency guard
  // -------------------------------------------------------------------------

  test('reapStaleSessions guards against concurrent reaps via _reapInProgress', async () => {
    // Manually set the flag
    (executor as unknown as Record<string, boolean>)._reapInProgress = true;

    // Spy on _doReap to confirm it is NOT called
    const doReapSpy = vi.spyOn(executor as unknown as { _doReap: () => Promise<void> }, '_doReap');

    await executor.reapStaleSessions();

    expect(doReapSpy).not.toHaveBeenCalled();

    // Reset flag
    (executor as unknown as Record<string, boolean>)._reapInProgress = false;
  });

  // -------------------------------------------------------------------------
  // 3. _reapInProgress flag resets even if _doReap throws
  // -------------------------------------------------------------------------

  test('_reapInProgress flag resets even if _doReap throws', async () => {
    vi.spyOn(
      executor as unknown as { _doReap: () => Promise<void> },
      '_doReap',
    ).mockRejectedValueOnce(new Error('boom'));

    // reapStaleSessions uses try/finally without catch, so the error propagates
    await expect(executor.reapStaleSessions()).rejects.toThrow('boom');

    expect((executor as unknown as Record<string, boolean>)._reapInProgress).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Stale threshold eviction (>30 min inactive)
  // -------------------------------------------------------------------------

  test('stale threshold evicts sessions inactive > 30 minutes', async () => {
    const staleTime = new Date(Date.now() - DEFAULT_SESSION_STALE_THRESHOLD_MS - 1);
    const freshTime = new Date();

    sessions(executor).set('stale-1', createMockSession('stale-1', { lastActivityAt: staleTime }));
    sessions(executor).set('fresh-1', createMockSession('fresh-1', { lastActivityAt: freshTime }));

    // Mock saveSessionSnapshot to avoid real persistence
    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    await executor.reapStaleSessions();

    expect(sessions(executor).has('stale-1')).toBe(false);
    expect(sessions(executor).has('fresh-1')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. maxAgeSeconds eviction (absolute lifetime)
  // -------------------------------------------------------------------------

  test('maxAgeSeconds evicts sessions older than absolute lifetime', async () => {
    const maxAgeSeconds = 60; // 1 minute lifetime
    const createdLongAgo = new Date(Date.now() - 120_000); // 2 minutes ago

    sessions(executor).set(
      'expired-1',
      createMockSession('expired-1', {
        createdAt: createdLongAgo,
        lastActivityAt: new Date(), // recently active — so stale threshold won't catch it
        maxAgeSeconds,
      }),
    );

    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    await executor.reapStaleSessions();

    expect(sessions(executor).has('expired-1')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Executing sessions are protected
  // -------------------------------------------------------------------------

  test('actively executing sessions are protected from eviction', async () => {
    const staleTime = new Date(Date.now() - DEFAULT_SESSION_STALE_THRESHOLD_MS - 1);

    sessions(executor).set(
      'executing-1',
      createMockSession('executing-1', { lastActivityAt: staleTime }),
    );
    executingSet(executor).add('executing-1');

    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    await executor.reapStaleSessions();

    // Session should still be present because it's in _executingSessions
    expect(sessions(executor).has('executing-1')).toBe(true);

    // Clean up
    executingSet(executor).delete('executing-1');
  });

  // -------------------------------------------------------------------------
  // 7. Memory ceiling eviction (over MAX_IN_MEMORY_SESSIONS)
  // -------------------------------------------------------------------------

  test('memory ceiling eviction removes oldest sessions when over limit', async () => {
    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    // Insert MAX_IN_MEMORY_SESSIONS + 5 fresh sessions (none individually stale)
    const totalSessions = MAX_IN_MEMORY_SESSIONS + 5;
    for (let i = 0; i < totalSessions; i++) {
      const id = `session-${String(i).padStart(6, '0')}`;
      // Stagger lastActivityAt so ordering is deterministic: lower i = older
      const lastActivityAt = new Date(Date.now() - (totalSessions - i));
      sessions(executor).set(id, createMockSession(id, { lastActivityAt }));
    }

    expect(sessions(executor).size).toBe(totalSessions);

    await executor.reapStaleSessions();

    // Should have evicted 5 oldest to bring count down to MAX_IN_MEMORY_SESSIONS
    expect(sessions(executor).size).toBe(MAX_IN_MEMORY_SESSIONS);

    // The 5 oldest (session-000000 through session-000004) should be gone
    for (let i = 0; i < 5; i++) {
      const id = `session-${String(i).padStart(6, '0')}`;
      expect(sessions(executor).has(id)).toBe(false);
    }

    // The newest should still exist
    const newestId = `session-${String(totalSessions - 1).padStart(6, '0')}`;
    expect(sessions(executor).has(newestId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. saveSessionSnapshot failure during reap logs warning and continues
  // -------------------------------------------------------------------------

  test('saveSessionSnapshot failure during reap logs warning and continues cleanup', async () => {
    const staleTime = new Date(Date.now() - DEFAULT_SESSION_STALE_THRESHOLD_MS - 1);

    sessions(executor).set(
      'fail-persist-1',
      createMockSession('fail-persist-1', { lastActivityAt: staleTime }),
    );
    sessions(executor).set(
      'fail-persist-2',
      createMockSession('fail-persist-2', { lastActivityAt: staleTime }),
    );

    // First call throws, second succeeds
    const snapshotSpy = vi
      .spyOn(
        executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
        'saveSessionSnapshot',
      )
      .mockRejectedValueOnce(new Error('persist failed'))
      .mockResolvedValueOnce(undefined);

    await executor.reapStaleSessions();

    // Both sessions should be cleaned up even though the first persist failed
    expect(sessions(executor).has('fail-persist-1')).toBe(false);
    expect(sessions(executor).has('fail-persist-2')).toBe(false);
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 9. releaseSessionSlot called for tenant-scoped evicted sessions
  // -------------------------------------------------------------------------

  test('releaseSessionSlot called for tenant-scoped evicted sessions', async () => {
    // Use real timers for this test — dynamic imports with .then() chains
    // interact poorly with fake timers
    vi.useRealTimers();

    const now = Date.now();
    const staleTime = new Date(now - DEFAULT_SESSION_STALE_THRESHOLD_MS - 1);

    sessions(executor).set(
      'tenant-session-1',
      createMockSession('tenant-session-1', {
        lastActivityAt: staleTime,
        tenantId: 'tenant-abc',
      }),
    );

    // Session without tenantId — should NOT trigger releaseSessionSlot
    sessions(executor).set(
      'no-tenant-session',
      createMockSession('no-tenant-session', {
        lastActivityAt: staleTime,
        tenantId: undefined,
      }),
    );

    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    await executor.reapStaleSessions();

    // Allow the dynamic import promise chain to resolve (microtask flush)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReleaseSessionSlot).toHaveBeenCalledWith('tenant-abc', 'tenant-session-1');
    // Should not have been called for the session without tenantId
    const calls = mockReleaseSessionSlot.mock.calls;
    const noTenantCalls = calls.filter((call: [string, string]) => call[1] === 'no-tenant-session');
    expect(noTenantCalls).toHaveLength(0);

    // Restore fake timers for afterEach cleanup
    vi.useFakeTimers();
  });

  // -------------------------------------------------------------------------
  // 10. Debounce timers cleared for evicted sessions
  // -------------------------------------------------------------------------

  test('debounce timers cleared for evicted sessions', async () => {
    const staleTime = new Date(Date.now() - DEFAULT_SESSION_STALE_THRESHOLD_MS - 1);

    sessions(executor).set(
      'debounce-1',
      createMockSession('debounce-1', { lastActivityAt: staleTime }),
    );

    // Set up a debounce timer for the session
    const timer = setTimeout(() => {}, 99999);
    debounceTimers(executor).set('debounce-1', timer);

    // Also add a voice executor entry to verify it's cleaned up
    voiceExecutors(executor).set('debounce-1', { close: vi.fn() });

    vi.spyOn(
      executor as unknown as { saveSessionSnapshot: (s: RuntimeSession) => Promise<void> },
      'saveSessionSnapshot',
    ).mockResolvedValue(undefined);

    await executor.reapStaleSessions();

    expect(sessions(executor).has('debounce-1')).toBe(false);
    expect(debounceTimers(executor).has('debounce-1')).toBe(false);
    expect(voiceExecutors(executor).has('debounce-1')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 11. stopStaleReaper clears the interval timer
  // -------------------------------------------------------------------------

  test('stopStaleReaper clears the interval timer', () => {
    // Start the reaper
    const start = (executor as unknown as { startStaleReaper: () => void }).startStaleReaper.bind(
      executor,
    );
    start();

    expect(
      (executor as unknown as Record<string, NodeJS.Timeout | null>).staleReaperTimer,
    ).not.toBeNull();

    executor.stopStaleReaper();

    expect(
      (executor as unknown as Record<string, NodeJS.Timeout | null>).staleReaperTimer,
    ).toBeNull();
  });
});
