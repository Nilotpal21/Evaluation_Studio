/**
 * Session Fork — Unit Tests
 *
 * Covers:
 * - Fork creates a new session with cloned state
 * - Fork at specific thread boundary
 * - Fork preserves parent conversation history
 * - Fork gets independent session ID
 * - Fork validates thread index
 * - Parent session is unaffected by fork
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionStore } from '../../services/session/session-store.js';
import type { SessionData, AgentThreadData } from '../../services/session/types.js';
import { SessionService } from '../../services/session/session-service.js';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { forkSession } from '../../services/session/session-operations.js';

// =============================================================================
// HELPERS
// =============================================================================

function createTestThread(
  agentName: string,
  status: AgentThreadData['status'] = 'active',
): AgentThreadData {
  return {
    agentName,
    irSourceHash: `hash-${agentName}`,
    conversationHistory: [
      { role: 'user', content: `Hello from ${agentName}` },
      { role: 'assistant', content: `Hi! I'm ${agentName}` },
    ],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    dataValues: { agent: agentName },
    dataGatheredKeys: ['agent'],
    startedAt: Date.now(),
    returnExpected: false,
    status,
  };
}

function createTestSession(): SessionData {
  return {
    id: 'sess-parent',
    agentName: 'SalesAgent',
    irSourceHash: 'hash-SalesAgent',
    compilationHash: 'comp-hash-1',
    conversationHistory: [
      { role: 'user', content: 'I want a hotel' },
      { role: 'assistant', content: 'Great! Where?' },
    ],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    version: 5,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['SalesAgent', 'PaymentAgent'],
    delegateStack: [],
    dataValues: { destination: 'Paris', guests: 2 },
    dataGatheredKeys: ['destination', 'guests'],
    initialized: true,
    createdAt: Date.now() - 60000,
    lastActivityAt: Date.now(),
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    environment: 'dev',
    threads: [
      createTestThread('SalesAgent', 'waiting'),
      createTestThread('PaymentAgent', 'active'),
    ],
    activeThreadIndex: 1,
    threadStack: [0],
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('forkSession', () => {
  let store: SessionStore;
  let sessionService: SessionService;

  beforeEach(() => {
    store = new MemorySessionStore();
    sessionService = new SessionService(store);
  });

  it('should create a forked session with a new ID', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);

    expect(result.sessionId).toBeDefined();
    expect(result.sessionId).not.toBe(parent.id);
    expect(result.parentSessionId).toBe('sess-parent');
    expect(result.sessionId).toMatch(/^fork-/);
  });

  it('should fork at the active thread by default', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);

    // Should include both threads (active is at index 1)
    expect(result.forkPoint).toBe(1);

    const forked = await store.load(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.threads).toHaveLength(2);
    expect(forked!.activeThreadIndex).toBe(1);
  });

  it('should fork at a specific thread boundary', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent, {
      forkAtThreadIndex: 0,
    });

    expect(result.forkPoint).toBe(0);

    const forked = await store.load(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.threads).toHaveLength(1);
    expect(forked!.threads[0].agentName).toBe('SalesAgent');
    expect(forked!.activeThreadIndex).toBe(0);
  });

  it('should clone data values independently', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    // Modify fork's data
    forked!.dataValues.destination = 'London';
    await store.save(forked!);

    // Parent should be unaffected
    expect(parent.dataValues.destination).toBe('Paris');
  });

  it('should clone conversation history independently', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    // Fork should have its own conversation
    expect(forked!.threads[0].conversationHistory).toHaveLength(2);
    expect(forked!.threads[0].conversationHistory).not.toBe(parent.threads[0].conversationHistory);
  });

  it('should preserve tenant and project context', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    expect(forked!.tenantId).toBe('tenant-1');
    expect(forked!.projectId).toBe('proj-1');
    expect(forked!.environment).toBe('dev');
  });

  it('should preserve PII vault and redaction context', async () => {
    const parent = createTestSession();
    parent.piiVaultData = 'encrypted-pii-vault';
    parent.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    expect(forked!.piiVaultData).toBe('encrypted-pii-vault');
    expect(forked!.piiRedactionConfig).toEqual({
      enabled: true,
      redactInput: true,
      redactOutput: true,
    });
  });

  it('should start with version 0', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    expect(forked!.version).toBe(0);
  });

  it('should accept a custom fork session ID', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent, {
      forkSessionId: 'my-custom-fork-id',
    });

    expect(result.sessionId).toBe('my-custom-fork-id');
    const forked = await store.load('my-custom-fork-id');
    expect(forked).not.toBeNull();
  });

  it('should throw on invalid thread index', async () => {
    const parent = createTestSession();

    await expect(forkSession(sessionService, parent, { forkAtThreadIndex: 99 })).rejects.toThrow(
      'Invalid fork thread index',
    );
  });

  it('should throw on negative thread index', async () => {
    const parent = createTestSession();

    await expect(forkSession(sessionService, parent, { forkAtThreadIndex: -1 })).rejects.toThrow(
      'Invalid fork thread index',
    );
  });

  it('should reset isComplete and isEscalated', async () => {
    const parent = createTestSession();

    const result = await forkSession(sessionService, parent);
    const forked = await store.load(result.sessionId);

    expect(forked!.isComplete).toBe(false);
    expect(forked!.isEscalated).toBe(false);
  });

  it('should filter threadStack to valid indices', async () => {
    const parent = createTestSession();
    // threadStack has [0], forking at thread 0 should keep it
    const result = await forkSession(sessionService, parent, {
      forkAtThreadIndex: 0,
    });
    const forked = await store.load(result.sessionId);

    expect(forked!.threadStack).toEqual([0]);
  });
});
