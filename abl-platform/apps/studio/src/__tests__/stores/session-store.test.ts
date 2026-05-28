/**
 * Session Store Tests
 *
 * Comprehensive tests for the Zustand session store that manages
 * chat session state including messages, agent state, streaming, and errors.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../store/session-store';
import type { SessionMessage, AgentState, AgentDetails, ConstructAction } from '../../types';

// =============================================================================
// HELPERS
// =============================================================================

function makeAgent(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    id: 'agent-1',
    name: 'test-agent',
    filePath: '',
    type: 'agent',
    mode: 'reasoning',
    toolCount: 2,
    gatherFieldCount: 1,
    isSupervisor: false,
    dsl: 'AGENT test-agent\nDOMAIN testing',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: 'Hello',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    traceIds: [],
    ...overrides,
  };
}

function makeAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    context: {},
    conversationPhase: 'start',
    gatherProgress: {},
    constraintResults: {},
    lastToolResults: {},
    memory: {
      session: {},
      persistentCache: {},
      pendingRemembers: [],
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Session Store', () => {
  beforeEach(() => {
    // Reset Zustand store to initial state before each test
    const { clearSession } = useSessionStore.getState();
    clearSession();
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state shape
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      // clearSession was called in beforeEach, which resets everything
      const state = useSessionStore.getState();

      expect(state.sessionId).toBeNull();
      expect(state.agent).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.messageSnapshotVersion).toBe(0);
      expect(state.state).toBeNull();
      expect(state.lastAction).toBeNull();
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(state.streamingContent).toBe('');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    test('all action functions are defined', () => {
      const state = useSessionStore.getState();

      expect(typeof state.setSession).toBe('function');
      expect(typeof state.clearSession).toBe('function');
      expect(typeof state.addMessage).toBe('function');
      expect(typeof state.updateMessage).toBe('function');
      expect(typeof state.clearMessages).toBe('function');
      expect(typeof state.replaceMessages).toBe('function');
      expect(typeof state.setState).toBe('function');
      expect(typeof state.updateState).toBe('function');
      expect(typeof state.setLastAction).toBe('function');
      expect(typeof state.startStreaming).toBe('function');
      expect(typeof state.appendStreamChunk).toBe('function');
      expect(typeof state.endStreaming).toBe('function');
      expect(typeof state.setLoading).toBe('function');
      expect(typeof state.setError).toBe('function');
      expect(typeof state.restoreSession).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setSession()
  // ---------------------------------------------------------------------------
  describe('setSession()', () => {
    test('sets sessionId and agent', () => {
      const agent = makeAgent();
      useSessionStore.getState().setSession('session-123', agent);

      const state = useSessionStore.getState();
      expect(state.sessionId).toBe('session-123');
      expect(state.agent).toEqual(agent);
    });

    test('resets messages to empty array', () => {
      // Add a message first
      useSessionStore.getState().setSession('session-old', makeAgent());
      useSessionStore.getState().addMessage(makeMessage({ content: 'old msg' }));
      expect(useSessionStore.getState().messages).toHaveLength(1);

      // Setting a new session resets messages
      useSessionStore.getState().setSession('session-new', makeAgent({ name: 'new-agent' }));
      expect(useSessionStore.getState().messages).toEqual([]);
    });

    test('initializes state with default AgentState', () => {
      useSessionStore.getState().setSession('session-1', makeAgent());
      const state = useSessionStore.getState().state;

      expect(state).not.toBeNull();
      expect(state!.context).toEqual({});
      expect(state!.conversationPhase).toBe('start');
      expect(state!.gatherProgress).toEqual({});
      expect(state!.constraintResults).toEqual({});
      expect(state!.lastToolResults).toEqual({});
      expect(state!.memory).toEqual({
        session: {},
        persistentCache: {},
        pendingRemembers: [],
      });
    });

    test('resets lastAction, isLoading, and error', () => {
      // Set some state first
      const store = useSessionStore.getState();
      store.setSession('session-old', makeAgent());
      store.setLastAction({ type: 'continue' });
      store.setLoading(true);
      store.setError('something failed');

      // Now set a new session
      useSessionStore.getState().setSession('session-new', makeAgent());

      const state = useSessionStore.getState();
      expect(state.lastAction).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. clearSession()
  // ---------------------------------------------------------------------------
  describe('clearSession()', () => {
    test('resets all session data to initial values', () => {
      // Set up a full session
      const store = useSessionStore.getState();
      store.setSession('session-1', makeAgent());
      store.addMessage(makeMessage());
      store.setLastAction({ type: 'respond', message: 'hi' });
      store.startStreaming('msg-stream');
      store.setLoading(true);
      store.setError('oops');
      store.setStatusMessage('working...');

      // Clear it
      useSessionStore.getState().clearSession();

      const state = useSessionStore.getState();
      expect(state.sessionId).toBeNull();
      expect(state.agent).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.state).toBeNull();
      expect(state.lastAction).toBeNull();
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(state.streamingContent).toBe('');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.statusMessage).toBeNull();
    });

    test('resets loading state during session clear', () => {
      useSessionStore.getState().setLoading(true);
      useSessionStore.getState().clearSession();

      const state = useSessionStore.getState();
      expect(state.isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. addMessage()
  // ---------------------------------------------------------------------------
  describe('addMessage()', () => {
    test('adds a message to the messages array', () => {
      const msg = makeMessage({ id: 'msg-1', content: 'Hello world' });
      useSessionStore.getState().addMessage(msg);

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    test('appends messages in order', () => {
      const msg1 = makeMessage({ id: 'msg-1', content: 'First' });
      const msg2 = makeMessage({ id: 'msg-2', content: 'Second', role: 'assistant' });
      const msg3 = makeMessage({ id: 'msg-3', content: 'Third' });

      const store = useSessionStore.getState();
      store.addMessage(msg1);
      store.addMessage(msg2);
      store.addMessage(msg3);

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(3);
      expect(messages[0].id).toBe('msg-1');
      expect(messages[1].id).toBe('msg-2');
      expect(messages[2].id).toBe('msg-3');
    });

    test('preserves message metadata', () => {
      const msg = makeMessage({
        id: 'msg-meta',
        metadata: {
          tokensIn: 50,
          tokensOut: 120,
          latencyMs: 300,
          action: { type: 'continue' },
        },
      });

      useSessionStore.getState().addMessage(msg);

      const stored = useSessionStore.getState().messages[0];
      expect(stored.metadata?.tokensIn).toBe(50);
      expect(stored.metadata?.tokensOut).toBe(120);
      expect(stored.metadata?.latencyMs).toBe(300);
      expect(stored.metadata?.action).toEqual({ type: 'continue' });
    });

    test('deduplicates messages by id', () => {
      const msg = makeMessage({ id: 'msg-dup', content: 'Hello once' });
      const store = useSessionStore.getState();

      store.addMessage(msg);
      store.addMessage({ ...msg, content: 'Hello twice' });

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello once');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. updateMessage()
  // ---------------------------------------------------------------------------
  describe('updateMessage()', () => {
    test('updates an existing message by id', () => {
      const msg = makeMessage({ id: 'msg-update', content: 'original' });
      useSessionStore.getState().addMessage(msg);

      useSessionStore.getState().updateMessage('msg-update', { content: 'updated' });

      const updated = useSessionStore.getState().messages[0];
      expect(updated.content).toBe('updated');
      expect(updated.id).toBe('msg-update');
    });

    test('preserves other fields when updating', () => {
      const msg = makeMessage({
        id: 'msg-partial',
        content: 'original',
        role: 'assistant',
        traceIds: ['trace-1'],
      });
      useSessionStore.getState().addMessage(msg);

      useSessionStore.getState().updateMessage('msg-partial', { content: 'changed' });

      const updated = useSessionStore.getState().messages[0];
      expect(updated.content).toBe('changed');
      expect(updated.role).toBe('assistant');
      expect(updated.traceIds).toEqual(['trace-1']);
    });

    test('does not modify other messages', () => {
      const msg1 = makeMessage({ id: 'msg-a', content: 'A' });
      const msg2 = makeMessage({ id: 'msg-b', content: 'B' });
      const store = useSessionStore.getState();
      store.addMessage(msg1);
      store.addMessage(msg2);

      useSessionStore.getState().updateMessage('msg-a', { content: 'A-updated' });

      const messages = useSessionStore.getState().messages;
      expect(messages[0].content).toBe('A-updated');
      expect(messages[1].content).toBe('B');
    });

    test('no-ops gracefully when id does not exist', () => {
      const msg = makeMessage({ id: 'msg-exists', content: 'original' });
      useSessionStore.getState().addMessage(msg);

      useSessionStore.getState().updateMessage('msg-nonexistent', { content: 'ghost' });

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('original');
    });

    test('can update metadata on a message', () => {
      const msg = makeMessage({ id: 'msg-meta-update' });
      useSessionStore.getState().addMessage(msg);

      useSessionStore.getState().updateMessage('msg-meta-update', {
        metadata: { tokensIn: 10, tokensOut: 20, latencyMs: 150 },
      });

      const updated = useSessionStore.getState().messages[0];
      expect(updated.metadata?.tokensIn).toBe(10);
      expect(updated.metadata?.tokensOut).toBe(20);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. clearMessages()
  // ---------------------------------------------------------------------------
  describe('clearMessages()', () => {
    test('empties the messages array', () => {
      const store = useSessionStore.getState();
      store.addMessage(makeMessage({ id: 'msg-1' }));
      store.addMessage(makeMessage({ id: 'msg-2' }));
      expect(useSessionStore.getState().messages).toHaveLength(2);

      useSessionStore.getState().clearMessages();
      expect(useSessionStore.getState().messages).toEqual([]);
    });

    test('bumps the snapshot version and resets streaming state', () => {
      const store = useSessionStore.getState();
      const beforeSnapshotVersion = store.messageSnapshotVersion;

      store.startStreaming('message-1');
      expect(useSessionStore.getState().isStreaming).toBe(true);

      useSessionStore.getState().clearMessages();

      const state = useSessionStore.getState();
      expect(state.messageSnapshotVersion).toBe(beforeSnapshotVersion + 1);
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(state.streamingContent).toBe('');
      expect(state.expandedThoughtIds.size).toBe(0);
    });

    test('also clears lastAction', () => {
      useSessionStore.getState().setLastAction({ type: 'continue' });
      expect(useSessionStore.getState().lastAction).not.toBeNull();

      useSessionStore.getState().clearMessages();
      expect(useSessionStore.getState().lastAction).toBeNull();
    });

    test('does not affect other state', () => {
      const store = useSessionStore.getState();
      store.setSession('session-1', makeAgent());
      store.addMessage(makeMessage());
      store.setError('some error');
      store.setLoading(true);

      useSessionStore.getState().clearMessages();

      const state = useSessionStore.getState();
      expect(state.messages).toEqual([]);
      expect(state.sessionId).toBe('session-1');
      expect(state.agent).not.toBeNull();
      expect(state.error).toBe('some error');
      expect(state.isLoading).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6b. replaceMessages()
  // ---------------------------------------------------------------------------
  describe('replaceMessages()', () => {
    test('replaces the current messages and bumps the snapshot version', () => {
      const store = useSessionStore.getState();
      store.addMessage(makeMessage({ id: 'old-message', content: 'stale' }));

      useSessionStore
        .getState()
        .replaceMessages([
          makeMessage({ id: 'resume-user-1', role: 'user', content: 'hello' }),
          makeMessage({ id: 'resume-assistant-1', role: 'assistant', content: 'hi there' }),
        ]);

      const state = useSessionStore.getState();
      expect(state.messageSnapshotVersion).toBe(1);
      expect(state.messages.map((message) => message.id)).toEqual([
        'resume-user-1',
        'resume-assistant-1',
      ]);
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(state.streamingContent).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. setState() / updateState()
  // ---------------------------------------------------------------------------
  describe('setState()', () => {
    test('replaces the entire state object', () => {
      const newState = makeAgentState({
        conversationPhase: 'gathering',
        context: { city: 'Paris' },
      });

      useSessionStore.getState().setState(newState);

      const state = useSessionStore.getState().state;
      expect(state).toEqual(newState);
      expect(state!.conversationPhase).toBe('gathering');
      expect(state!.context).toEqual({ city: 'Paris' });
    });

    test('overwrites previous state entirely', () => {
      const state1 = makeAgentState({ context: { a: 1, b: 2 } });
      const state2 = makeAgentState({ context: { c: 3 } });

      useSessionStore.getState().setState(state1);
      useSessionStore.getState().setState(state2);

      const state = useSessionStore.getState().state;
      expect(state!.context).toEqual({ c: 3 });
      expect(state!.context).not.toHaveProperty('a');
    });
  });

  describe('updateState()', () => {
    test('merges context shallowly', () => {
      useSessionStore.getState().setState(makeAgentState({ context: { city: 'Paris', count: 1 } }));

      useSessionStore.getState().updateState({ context: { count: 2, name: 'Alice' } });

      const context = useSessionStore.getState().state!.context;
      expect(context).toEqual({ city: 'Paris', count: 2, name: 'Alice' });
    });

    test('merges gatherProgress shallowly', () => {
      useSessionStore.getState().setState(
        makeAgentState({
          gatherProgress: { destination: { collected: true }, origin: { collected: false } },
        }),
      );

      useSessionStore.getState().updateState({
        gatherProgress: { origin: { collected: true } },
      });

      const gp = useSessionStore.getState().state!.gatherProgress;
      expect(gp.destination).toEqual({ collected: true });
      expect(gp.origin).toEqual({ collected: true });
    });

    test('merges constraintResults shallowly', () => {
      useSessionStore.getState().setState(makeAgentState({ constraintResults: { rule_a: true } }));

      useSessionStore.getState().updateState({
        constraintResults: { rule_b: false },
      });

      const cr = useSessionStore.getState().state!.constraintResults;
      expect(cr).toEqual({ rule_a: true, rule_b: false });
    });

    test('merges lastToolResults shallowly', () => {
      useSessionStore
        .getState()
        .setState(makeAgentState({ lastToolResults: { tool_a: { ok: true } } }));

      useSessionStore.getState().updateState({
        lastToolResults: { tool_b: { ok: false } },
      });

      const ltr = useSessionStore.getState().state!.lastToolResults;
      expect(ltr).toEqual({ tool_a: { ok: true }, tool_b: { ok: false } });
    });

    test('merges memory.session and memory.persistentCache shallowly', () => {
      useSessionStore.getState().setState(
        makeAgentState({
          memory: {
            session: { key1: 'val1' },
            persistentCache: { cache1: 'data1' },
            pendingRemembers: ['item-a'],
          },
        }),
      );

      useSessionStore.getState().updateState({
        memory: {
          session: { key2: 'val2' },
          persistentCache: { cache2: 'data2' },
          pendingRemembers: ['item-b'],
        },
      });

      const memory = useSessionStore.getState().state!.memory;
      expect(memory.session).toEqual({ key1: 'val1', key2: 'val2' });
      expect(memory.persistentCache).toEqual({ cache1: 'data1', cache2: 'data2' });
      // pendingRemembers comes from the update's spread, so it uses the update value
      expect(memory.pendingRemembers).toEqual(['item-b']);
    });

    test('preserves conversationPhase when updating other fields', () => {
      useSessionStore.getState().setState(makeAgentState({ conversationPhase: 'gathering' }));

      useSessionStore.getState().updateState({ context: { newField: true } });

      expect(useSessionStore.getState().state!.conversationPhase).toBe('gathering');
    });

    test('can update conversationPhase via top-level spread', () => {
      useSessionStore.getState().setState(makeAgentState({ conversationPhase: 'start' }));

      useSessionStore.getState().updateState({ conversationPhase: 'complete' });

      expect(useSessionStore.getState().state!.conversationPhase).toBe('complete');
    });

    test('no-ops when state is null', () => {
      // state is null initially
      expect(useSessionStore.getState().state).toBeNull();

      useSessionStore.getState().updateState({ context: { foo: 'bar' } });

      // Still null -- updateState guards against null state
      expect(useSessionStore.getState().state).toBeNull();
    });

    test('handles partial memory updates without losing existing keys', () => {
      useSessionStore.getState().setState(
        makeAgentState({
          memory: {
            session: { existing: 'data' },
            persistentCache: { cached: 'value' },
            pendingRemembers: [],
          },
        }),
      );

      useSessionStore.getState().updateState({
        memory: {
          session: { new: 'entry' },
          persistentCache: {},
          pendingRemembers: [],
        },
      });

      const memory = useSessionStore.getState().state!.memory;
      expect(memory.session).toEqual({ existing: 'data', new: 'entry' });
      expect(memory.persistentCache).toEqual({ cached: 'value' });
    });
  });

  // ---------------------------------------------------------------------------
  // 8. setLastAction()
  // ---------------------------------------------------------------------------
  describe('setLastAction()', () => {
    test('sets a continue action', () => {
      const action: ConstructAction = { type: 'continue' };
      useSessionStore.getState().setLastAction(action);

      expect(useSessionStore.getState().lastAction).toEqual(action);
    });

    test('sets a respond action', () => {
      const action: ConstructAction = { type: 'respond', message: 'Hello!' };
      useSessionStore.getState().setLastAction(action);

      expect(useSessionStore.getState().lastAction).toEqual(action);
    });

    test('sets a handoff action', () => {
      const action: ConstructAction = {
        type: 'handoff',
        target: 'billing-agent',
        context: { issue: 'refund' },
        returnExpected: true,
        summary: 'User needs billing help',
      };
      useSessionStore.getState().setLastAction(action);

      const stored = useSessionStore.getState().lastAction;
      expect(stored).toEqual(action);
      expect(stored!.type).toBe('handoff');
    });

    test('sets an escalate action', () => {
      const action: ConstructAction = {
        type: 'escalate',
        reason: 'User is upset',
        priority: 'high',
        context: { sentiment: 'negative' },
      };
      useSessionStore.getState().setLastAction(action);

      expect(useSessionStore.getState().lastAction).toEqual(action);
    });

    test('sets a collect action', () => {
      const action: ConstructAction = {
        type: 'collect',
        fields: ['name', 'email'],
        prompts: { name: 'What is your name?', email: 'What is your email?' },
      };
      useSessionStore.getState().setLastAction(action);

      expect(useSessionStore.getState().lastAction).toEqual(action);
    });

    test('overwrites previous action', () => {
      useSessionStore.getState().setLastAction({ type: 'continue' });
      useSessionStore.getState().setLastAction({ type: 'respond', message: 'Done' });

      expect(useSessionStore.getState().lastAction).toEqual({ type: 'respond', message: 'Done' });
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Streaming lifecycle
  // ---------------------------------------------------------------------------
  describe('streaming lifecycle', () => {
    describe('startStreaming()', () => {
      test('sets isStreaming to true and records messageId', () => {
        useSessionStore.getState().startStreaming('stream-msg-1');

        const state = useSessionStore.getState();
        expect(state.isStreaming).toBe(true);
        expect(state.streamingMessageId).toBe('stream-msg-1');
        expect(state.streamingContent).toBe('');
      });

      test('resets streamingContent to empty string', () => {
        // Simulate leftover content
        useSessionStore.getState().startStreaming('old-msg');
        useSessionStore.getState().appendStreamChunk('leftover');

        // Start a new stream
        useSessionStore.getState().startStreaming('new-msg');
        expect(useSessionStore.getState().streamingContent).toBe('');
      });
    });

    describe('appendStreamChunk()', () => {
      test('appends a chunk to streamingContent', () => {
        useSessionStore.getState().startStreaming('msg-1');
        useSessionStore.getState().appendStreamChunk('Hello');

        expect(useSessionStore.getState().streamingContent).toBe('Hello');
      });

      test('accumulates multiple chunks in order', () => {
        useSessionStore.getState().startStreaming('msg-1');
        useSessionStore.getState().appendStreamChunk('Hello');
        useSessionStore.getState().appendStreamChunk(' ');
        useSessionStore.getState().appendStreamChunk('world');
        useSessionStore.getState().appendStreamChunk('!');

        expect(useSessionStore.getState().streamingContent).toBe('Hello world!');
      });

      test('handles empty chunks', () => {
        useSessionStore.getState().startStreaming('msg-1');
        useSessionStore.getState().appendStreamChunk('A');
        useSessionStore.getState().appendStreamChunk('');
        useSessionStore.getState().appendStreamChunk('B');

        expect(useSessionStore.getState().streamingContent).toBe('AB');
      });
    });

    describe('endStreaming()', () => {
      test('adds complete assistant message when streamingMessageId is set', () => {
        useSessionStore.getState().startStreaming('stream-msg-1');
        useSessionStore.getState().appendStreamChunk('Hello world');
        useSessionStore.getState().endStreaming('Hello world');

        const state = useSessionStore.getState();
        expect(state.isStreaming).toBe(false);
        expect(state.streamingMessageId).toBeNull();
        expect(state.streamingContent).toBe('');

        expect(state.messages).toHaveLength(1);
        const msg = state.messages[0];
        expect(msg.id).toBe('stream-msg-1');
        expect(msg.role).toBe('assistant');
        expect(msg.content).toBe('Hello world');
        expect(msg.traceIds).toEqual([]);
        expect(msg.timestamp).toBeInstanceOf(Date);
      });

      test('preserves response metadata on the finalized assistant message', () => {
        useSessionStore.getState().startStreaming('stream-msg-meta');
        useSessionStore.getState().appendStreamChunk('Hello world');
        useSessionStore.getState().endStreaming('Hello world', {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        });

        const msg = useSessionStore.getState().messages[0];
        expect(msg.metadata).toEqual({
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        });
      });

      test('preserves contentEnvelope on the finalized assistant message', () => {
        useSessionStore.getState().startStreaming('stream-msg-envelope');
        useSessionStore.getState().endStreaming({
          fullText: '',
          voiceConfig: { plain_text: 'Voice fallback' },
          richContent: { markdown: '**Rendered**' },
          actions: {
            elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
          },
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        });

        const msg = useSessionStore.getState().messages[0];
        expect(msg.content).toBe('Voice fallback');
        expect(msg.contentEnvelope).toEqual({
          text: 'Voice fallback',
          voiceConfig: { plain_text: 'Voice fallback' },
          richContent: { markdown: '**Rendered**' },
          actions: {
            elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
          },
        });
      });

      test('resets streaming state without adding message when no streamingMessageId', () => {
        // Manually end streaming without starting it (no streamingMessageId)
        useSessionStore.getState().endStreaming('orphan text');

        const state = useSessionStore.getState();
        expect(state.isStreaming).toBe(false);
        expect(state.streamingMessageId).toBeNull();
        expect(state.streamingContent).toBe('');
        expect(state.messages).toEqual([]);
      });

      test('uses fullText parameter, not accumulated streamingContent', () => {
        useSessionStore.getState().startStreaming('msg-full');
        useSessionStore.getState().appendStreamChunk('partial');

        // endStreaming uses its argument, not streamingContent
        useSessionStore.getState().endStreaming('complete response text');

        const msg = useSessionStore.getState().messages[0];
        expect(msg.content).toBe('complete response text');
      });
    });

    describe('full streaming flow', () => {
      test('start -> append chunks -> end produces correct final state', () => {
        const store = useSessionStore.getState();

        // Start streaming
        store.startStreaming('flow-msg');
        expect(useSessionStore.getState().isStreaming).toBe(true);

        // Append chunks
        useSessionStore.getState().appendStreamChunk('I can ');
        useSessionStore.getState().appendStreamChunk('help you ');
        useSessionStore.getState().appendStreamChunk('with that.');

        expect(useSessionStore.getState().streamingContent).toBe('I can help you with that.');

        // End streaming
        useSessionStore.getState().endStreaming('I can help you with that.');

        const finalState = useSessionStore.getState();
        expect(finalState.isStreaming).toBe(false);
        expect(finalState.streamingMessageId).toBeNull();
        expect(finalState.streamingContent).toBe('');
        expect(finalState.messages).toHaveLength(1);
        expect(finalState.messages[0].content).toBe('I can help you with that.');
        expect(finalState.messages[0].role).toBe('assistant');
      });

      test('multiple streaming cycles add multiple messages', () => {
        // First cycle
        useSessionStore.getState().startStreaming('msg-cycle-1');
        useSessionStore.getState().appendStreamChunk('First response');
        useSessionStore.getState().endStreaming('First response');

        // Second cycle
        useSessionStore.getState().startStreaming('msg-cycle-2');
        useSessionStore.getState().appendStreamChunk('Second response');
        useSessionStore.getState().endStreaming('Second response');

        const messages = useSessionStore.getState().messages;
        expect(messages).toHaveLength(2);
        expect(messages[0].id).toBe('msg-cycle-1');
        expect(messages[0].content).toBe('First response');
        expect(messages[1].id).toBe('msg-cycle-2');
        expect(messages[1].content).toBe('Second response');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Loading and error
  // ---------------------------------------------------------------------------
  describe('setLoading()', () => {
    test('sets isLoading to true', () => {
      useSessionStore.getState().setLoading(true);
      expect(useSessionStore.getState().isLoading).toBe(true);
    });

    test('sets isLoading to false', () => {
      useSessionStore.getState().setLoading(true);
      useSessionStore.getState().setLoading(false);
      expect(useSessionStore.getState().isLoading).toBe(false);
    });
  });

  describe('setError()', () => {
    test('sets an error string', () => {
      useSessionStore.getState().setError('Connection failed');
      expect(useSessionStore.getState().error).toBe('Connection failed');
    });

    test('clears error with null', () => {
      useSessionStore.getState().setError('Some error');
      useSessionStore.getState().setError(null);
      expect(useSessionStore.getState().error).toBeNull();
    });

    test('overwrites previous error', () => {
      useSessionStore.getState().setError('first error');
      useSessionStore.getState().setError('second error');
      expect(useSessionStore.getState().error).toBe('second error');
    });
  });

  // ---------------------------------------------------------------------------
  // 11. restoreSession()
  // ---------------------------------------------------------------------------
  describe('restoreSession()', () => {
    test('restores full session state from data', () => {
      const agent = makeAgent({ name: 'restored-agent' });
      const messages = [
        makeMessage({ id: 'r-1', content: 'Hello', role: 'user' }),
        makeMessage({ id: 'r-2', content: 'Hi there!', role: 'assistant' }),
      ];
      const agentState = makeAgentState({
        conversationPhase: 'gathering',
        context: { destination: 'London' },
      });

      useSessionStore.getState().restoreSession({
        sessionId: 'restored-session-id',
        agent,
        messages,
        state: agentState,
      });

      const state = useSessionStore.getState();
      expect(state.sessionId).toBe('restored-session-id');
      expect(state.agent).toEqual(agent);
      expect(state.messages).toEqual(messages);
      expect(state.state).toEqual(agentState);
    });

    test('resets transient state on restore', () => {
      // Set up some transient state
      const store = useSessionStore.getState();
      store.setLastAction({ type: 'continue' });
      store.startStreaming('stream-before-restore');
      store.appendStreamChunk('partial...');
      store.setError('old error');

      // Restore session
      useSessionStore.getState().restoreSession({
        sessionId: 'restored-2',
        agent: makeAgent(),
        messages: [],
        state: null,
      });

      const state = useSessionStore.getState();
      expect(state.lastAction).toBeNull();
      expect(state.isStreaming).toBe(false);
      expect(state.streamingMessageId).toBeNull();
      expect(state.streamingContent).toBe('');
      expect(state.error).toBeNull();
    });

    test('handles null state in restore data', () => {
      useSessionStore.getState().restoreSession({
        sessionId: 'session-null-state',
        agent: makeAgent(),
        messages: [],
        state: null,
      });

      expect(useSessionStore.getState().state).toBeNull();
    });

    test('preserves message order from restore data', () => {
      const messages = [
        makeMessage({ id: 'first', content: '1' }),
        makeMessage({ id: 'second', content: '2' }),
        makeMessage({ id: 'third', content: '3' }),
      ];

      useSessionStore.getState().restoreSession({
        sessionId: 'order-test',
        agent: makeAgent(),
        messages,
        state: null,
      });

      const restoredMessages = useSessionStore.getState().messages;
      expect(restoredMessages).toHaveLength(3);
      expect(restoredMessages[0].id).toBe('first');
      expect(restoredMessages[1].id).toBe('second');
      expect(restoredMessages[2].id).toBe('third');
    });

    test('resets isLoading during restoreSession', () => {
      useSessionStore.getState().setLoading(true);

      useSessionStore.getState().restoreSession({
        sessionId: 'session-loading',
        agent: makeAgent(),
        messages: [],
        state: null,
      });

      expect(useSessionStore.getState().isLoading).toBe(false);
    });

    test('can restore and then continue adding messages', () => {
      const existingMessages = [makeMessage({ id: 'restored-1', content: 'Restored msg' })];

      useSessionStore.getState().restoreSession({
        sessionId: 'session-continue',
        agent: makeAgent(),
        messages: existingMessages,
        state: makeAgentState(),
      });

      useSessionStore
        .getState()
        .addMessage(makeMessage({ id: 'new-1', content: 'New message after restore' }));

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe('restored-1');
      expect(messages[1].id).toBe('new-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-cutting: interactions between actions
  // ---------------------------------------------------------------------------
  describe('cross-cutting interactions', () => {
    test('setSession then addMessage then clearSession resets everything', () => {
      useSessionStore.getState().setSession('s-1', makeAgent());
      useSessionStore.getState().addMessage(makeMessage());
      useSessionStore.getState().setState(makeAgentState({ context: { key: 'value' } }));

      useSessionStore.getState().clearSession();

      const state = useSessionStore.getState();
      expect(state.sessionId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.state).toBeNull();
    });

    test('updateState after restoreSession merges correctly', () => {
      useSessionStore.getState().restoreSession({
        sessionId: 'merge-test',
        agent: makeAgent(),
        messages: [],
        state: makeAgentState({
          context: { existing: 'value' },
          memory: {
            session: { key1: 'data1' },
            persistentCache: {},
            pendingRemembers: [],
          },
        }),
      });

      useSessionStore.getState().updateState({
        context: { newKey: 'newValue' },
        memory: {
          session: { key2: 'data2' },
          persistentCache: { cacheKey: 'cacheData' },
          pendingRemembers: [],
        },
      });

      const agentState = useSessionStore.getState().state!;
      expect(agentState.context).toEqual({ existing: 'value', newKey: 'newValue' });
      expect(agentState.memory.session).toEqual({ key1: 'data1', key2: 'data2' });
      expect(agentState.memory.persistentCache).toEqual({ cacheKey: 'cacheData' });
    });

    test('streaming + addMessage interleave correctly', () => {
      // User sends message
      useSessionStore
        .getState()
        .addMessage(makeMessage({ id: 'user-1', role: 'user', content: 'Hi' }));

      // Assistant streams response
      useSessionStore.getState().startStreaming('assistant-1');
      useSessionStore.getState().appendStreamChunk('Hello!');
      useSessionStore.getState().endStreaming('Hello!');

      // User sends another message
      useSessionStore
        .getState()
        .addMessage(makeMessage({ id: 'user-2', role: 'user', content: 'How are you?' }));

      const messages = useSessionStore.getState().messages;
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({ id: 'user-1', role: 'user' });
      expect(messages[1]).toMatchObject({ id: 'assistant-1', role: 'assistant' });
      expect(messages[2]).toMatchObject({ id: 'user-2', role: 'user' });
    });
  });
});
