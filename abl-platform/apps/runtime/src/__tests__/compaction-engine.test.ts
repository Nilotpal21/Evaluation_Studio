/**
 * CompactionEngine — Unit Tests
 *
 * Covers:
 * - autoCompact skips when disabled
 * - autoCompact skips when under threshold
 * - autoCompact triggers when over threshold
 * - compactThread splits and summarizes correctly
 * - Extractive fallback when LLM is unavailable
 * - Trace events are emitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactionEngine } from '../services/session/compaction-engine.js';
import type { RuntimeSession, AgentThread } from '../services/execution/types.js';

// Mock the config module
vi.mock('../../config/index.js', () => ({
  isConfigLoaded: vi.fn().mockReturnValue(false),
  getConfig: vi.fn().mockReturnValue({ session: {} }),
}));

// =============================================================================
// HELPERS
// =============================================================================

function createMockThread(messageCount: number): AgentThread {
  const history: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < messageCount; i++) {
    history.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(200)}`,
    });
  }

  return {
    agentName: 'TestAgent',
    agentIR: null,
    conversationHistory: history,
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: {
      values: { name: 'John', city: 'Paris' },
      gatheredKeys: new Set(['name', 'city']),
    },
    startedAt: Date.now(),
    returnExpected: false,
    status: 'active',
  };
}

function createMockSession(messageCount: number): RuntimeSession {
  const thread = createMockThread(messageCount);
  return {
    id: 'sess-test',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: thread.conversationHistory,
    state: thread.state,
    data: thread.data,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['TestAgent'],
    delegateStack: [],
    initialized: true,
    threads: [thread],
    activeThreadIndex: 0,
    threadStack: [],
    storeVersion: 1,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  } as RuntimeSession;
}

// =============================================================================
// TESTS
// =============================================================================

describe('CompactionEngine', () => {
  describe('autoCompact', () => {
    it('should skip when compaction is disabled', async () => {
      const engine = new CompactionEngine({ compactionEnabled: false });
      const session = createMockSession(50);

      const result = await engine.autoCompact(session);

      expect(result).toBeNull();
    });

    it('should skip when under threshold', async () => {
      const engine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.8,
      });
      // Small conversation: 5 messages ≈ ~300 tokens, well under 128K * 0.8
      const session = createMockSession(5);

      const result = await engine.autoCompact(session);

      expect(result).toBeNull();
    });

    it('should trigger when token estimate exceeds threshold', async () => {
      const engine = new CompactionEngine({
        compactionEnabled: true,
        // Very low threshold so 50 messages (~2625 tokens) exceeds 128000 * 0.01 = 1280
        autoCompactThreshold: 0.01,
      });
      const session = createMockSession(50);

      const result = await engine.autoCompact(session);

      expect(result).not.toBeNull();
      expect(result!.compacted).toBe(true);
      expect(result!.messagesCompacted).toBeGreaterThan(0);
      expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    });

    it('should emit trace event on compaction', async () => {
      const engine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.01,
      });
      const session = createMockSession(50);

      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) =>
        traceEvents.push(e);

      await engine.autoCompact(session, onTraceEvent);

      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].type).toBe('auto_compact');
      expect(traceEvents[0].data.agentName).toBe('TestAgent');
    });

    it('should use model context window from MODEL_REGISTRY', async () => {
      const engine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.8,
      });
      // 50 messages ≈ 2773 tokens. With gpt-4o (128K), threshold = 102400 → no compact.
      // With a hypothetical small model, it would compact.
      const session = createMockSession(50);
      // Set model to gpt-4o (128K context) — 2773 tokens is well under 102400 threshold
      session.agentIR = {
        ir_version: '1.0',
        metadata: { name: 'test', version: '1.0', description: '' },
        execution: { mode: 'reasoning', model: 'gpt-4o' },
        identity: { persona: '', goal: '' },
        tools: [],
        messages: {},
      } as any;

      const result = await engine.autoCompact(session);
      // Should NOT trigger — 2773 tokens is way under 128000 * 0.8 = 102400
      expect(result).toBeNull();
    });

    it('should compact sooner for models with smaller context windows', async () => {
      const engine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.8,
      });
      // 50 messages ≈ 2773 tokens
      const session = createMockSession(50);
      // Set model to open-mistral-7b (32K context) — threshold = 32000 * 0.8 = 25600
      // 2773 < 25600, still no compact. But with threshold 0.05 → 32000 * 0.05 = 1600
      // 2773 > 1600 → should compact
      session.agentIR = {
        ir_version: '1.0',
        metadata: { name: 'test', version: '1.0', description: '' },
        execution: { mode: 'reasoning', model: 'open-mistral-7b' },
        identity: { persona: '', goal: '' },
        tools: [],
        messages: {},
      } as any;

      // With default 0.8 threshold on 32K model → 25600 threshold, 2773 tokens → no compact
      const noCompact = await engine.autoCompact(session);
      expect(noCompact).toBeNull();

      // With low threshold on 32K model → should compact
      const aggressiveEngine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.05, // 32000 * 0.05 = 1600
      });
      const result = await aggressiveEngine.autoCompact(session);
      expect(result).not.toBeNull();
      expect(result!.compacted).toBe(true);
    });

    it('should use session.resolvedCompactionThreshold over global config', async () => {
      // Global config uses a high threshold (0.8) — 50 messages (~2773 tokens) would NOT compact
      const engine = new CompactionEngine({
        compactionEnabled: true,
        autoCompactThreshold: 0.8,
      });
      const session = createMockSession(50);

      // Without resolved threshold: no compaction (2773 < 128000 * 0.8 = 102400)
      const noCompact = await engine.autoCompact(session);
      expect(noCompact).toBeNull();

      // Set per-agent resolved threshold to a very low value
      session.resolvedCompactionThreshold = 0.01; // 128000 * 0.01 = 1280 → 2773 > 1280

      const result = await engine.autoCompact(session);
      expect(result).not.toBeNull();
      expect(result!.compacted).toBe(true);
    });
  });

  describe('compactThread', () => {
    it('should not compact when fewer messages than minimum window', async () => {
      const engine = new CompactionEngine({ compactionEnabled: true });
      const session = createMockSession(5);

      const result = await engine.compactThread(session, 0);

      expect(result.compacted).toBe(false);
      expect(result.messagesCompacted).toBe(0);
    });

    it('should compact and produce summary with extractive fallback', async () => {
      const engine = new CompactionEngine({ compactionEnabled: true });
      const session = createMockSession(30);

      const result = await engine.compactThread(session, 0);

      expect(result.compacted).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary).toContain('TestAgent');
      // Conversation should be shorter now
      const thread = session.threads[0];
      expect(thread.conversationHistory.length).toBeLessThan(30);
      // First message should be the summary
      expect(thread.conversationHistory[0].role).toBe('system');
      expect(typeof thread.conversationHistory[0].content === 'string').toBe(true);
      expect(thread.conversationHistory[0].content as string).toContain('[Conversation Summary]');
    });

    it('preserves structured envelope references in the retained active window', async () => {
      const engine = new CompactionEngine({ compactionEnabled: true });
      const session = createMockSession(30);
      const retainedEnvelope = {
        contentEnvelope: {
          version: 1,
          blocks: [{ type: 'text', text: 'structured active-window response' }],
          metadata: { traceId: 'trace-active-1' },
        },
      };
      session.threads[0].conversationHistory[29] = {
        role: 'assistant',
        content: retainedEnvelope,
      } as any;

      const result = await engine.compactThread(session, 0);

      expect(result.compacted).toBe(true);
      expect(session.threads[0].conversationHistory).toContainEqual({
        role: 'assistant',
        content: retainedEnvelope,
      });
    });
  });
});
