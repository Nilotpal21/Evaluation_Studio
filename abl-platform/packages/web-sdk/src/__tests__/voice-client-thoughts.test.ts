import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceClient } from '../voice/VoiceClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { WSServerMessage } from '../core/types.js';

/**
 * Mock SessionManager that exposes message dispatch for testing.
 */
class MockSessionManager extends TypedEventEmitter<{
  connected: void;
  disconnected: void;
  message: WSServerMessage;
  error: { error: Error };
}> {
  private connected = true;
  private sessionId = 'test-session-123';
  private showActivityUpdates = true;

  isConnected(): boolean {
    return this.connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getApiKey(): string {
    return 'pk_test';
  }

  getEndpoint(): string {
    return 'http://localhost:3112';
  }

  getScope(): { showActivityUpdates: boolean } {
    return { showActivityUpdates: this.showActivityUpdates };
  }

  setShowActivityUpdates(value: boolean): void {
    this.showActivityUpdates = value;
  }

  send(_msg: unknown): void {
    // noop for tests
  }

  /** Helper to simulate a server message reaching VoiceClient */
  simulateMessage(message: WSServerMessage): void {
    this.emit('message', message);
  }
}

function attachMessageHandlers(client: VoiceClient): void {
  (client as unknown as { setupMessageHandlers: () => void }).setupMessageHandlers();
}

describe('VoiceClient trace_event handling', () => {
  let sessionManager: MockSessionManager;
  let voiceClient: VoiceClient;

  beforeEach(() => {
    sessionManager = new MockSessionManager();
    voiceClient = new VoiceClient(sessionManager as any, false);
  });

  afterEach(async () => {
    await voiceClient.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('constructor does not subscribe to sessionManager messages until start or explicit attachment', () => {
    expect(sessionManager.listenerCount('message')).toBe(0);
  });

  test('4-U1: canonical trace_event with tool_thought data emits thought event', () => {
    attachMessageHandlers(voiceClient);
    const handler = vi.fn();
    voiceClient.on('thought', handler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'product_search',
          thought: 'User wants red sneakers under $50',
          reasoning: 'Extracting price constraint and product category',
          agentName: 'shopping-agent',
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      toolName: 'product_search',
      thought: 'User wants red sneakers under $50',
      reasoning: 'Extracting price constraint and product category',
      agent: 'shopping-agent',
    });
  });

  test('4-U2: canonical trace_event with status_update data emits statusUpdate event', () => {
    attachMessageHandlers(voiceClient);
    const handler = vi.fn();
    voiceClient.on('statusUpdate', handler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_update',
        data: {
          text: 'Searching for products...',
          operation: 'tool_call',
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      text: 'Searching for products...',
      operation: 'tool_call',
    });
  });

  test('legacy flattened trace_event payload still emits thought event', () => {
    attachMessageHandlers(voiceClient);
    const handler = vi.fn();
    voiceClient.on('thought', handler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      eventType: 'tool_thought',
      toolName: 'legacy_search',
      thought: 'Legacy flat thought',
      reasoning: 'Legacy flat reasoning',
      agentName: 'legacy-agent',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      toolName: 'legacy_search',
      thought: 'Legacy flat thought',
      reasoning: 'Legacy flat reasoning',
      agent: 'legacy-agent',
    });
  });

  test('4-U3: trace_event with status_clear emits statusClear event', () => {
    attachMessageHandlers(voiceClient);
    const handler = vi.fn();
    voiceClient.on('statusClear', handler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_clear',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('4-U4: unknown trace event type is ignored', () => {
    attachMessageHandlers(voiceClient);
    const thoughtHandler = vi.fn();
    const statusHandler = vi.fn();
    const clearHandler = vi.fn();
    const errorHandler = vi.fn();

    voiceClient.on('thought', thoughtHandler);
    voiceClient.on('statusUpdate', statusHandler);
    voiceClient.on('statusClear', clearHandler);
    voiceClient.on('error', errorHandler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'unknown_event_type',
        data: 'some data',
      },
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(statusHandler).not.toHaveBeenCalled();
    expect(clearHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  test('4-U5: malformed trace_event (no event field) is ignored without crash', () => {
    attachMessageHandlers(voiceClient);
    const thoughtHandler = vi.fn();
    const errorHandler = vi.fn();

    voiceClient.on('thought', thoughtHandler);
    voiceClient.on('error', errorHandler);

    // No event field at all
    sessionManager.simulateMessage({
      type: 'trace_event',
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();

    // event is null
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: null,
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();

    // event has no type
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: { data: 'something' },
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  test('suppresses trace activity events when the session scope disables them', () => {
    attachMessageHandlers(voiceClient);
    const thoughtHandler = vi.fn();
    const statusHandler = vi.fn();
    sessionManager.setShowActivityUpdates(false);

    voiceClient.on('thought', thoughtHandler);
    voiceClient.on('statusUpdate', statusHandler);

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'search',
          thought: 'Hidden thought',
        },
      },
    });
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_update',
        data: {
          text: 'Hidden status',
        },
      },
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(statusHandler).not.toHaveBeenCalled();
  });

  test('voice_error reads the runtime message field when error is not present', () => {
    attachMessageHandlers(voiceClient);
    const handler = vi.fn();
    voiceClient.on('error', handler);

    sessionManager.simulateMessage({
      type: 'voice_error',
      message: 'Voice session failed',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].error.message).toBe('Voice session failed');
  });

  test('4-U6: thought event stores latest thought accessible via getLastThought', () => {
    attachMessageHandlers(voiceClient);
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'search',
          thought: 'First thought',
          reasoning: 'r1',
          agentName: 'agent-a',
        },
      },
    });

    expect(voiceClient.getLastThought()).toEqual({
      toolName: 'search',
      thought: 'First thought',
      reasoning: 'r1',
      agent: 'agent-a',
    });

    // Second thought replaces first
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'calculate',
          thought: 'Second thought',
          reasoning: 'r2',
          agentName: 'agent-b',
        },
      },
    });

    expect(voiceClient.getLastThought()).toEqual({
      toolName: 'calculate',
      thought: 'Second thought',
      reasoning: 'r2',
      agent: 'agent-b',
    });
  });

  test('trace_event with status_update stores latest status accessible via getStatusMessage', () => {
    attachMessageHandlers(voiceClient);
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_update',
        data: {
          text: 'Looking things up...',
          operation: 'tool_call',
        },
      },
    });

    expect(voiceClient.getStatusMessage()).toBe('Looking things up...');

    // status_clear resets it
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_clear',
      },
    });

    expect(voiceClient.getStatusMessage()).toBeNull();
  });

  test('dispose releases each VoiceClient sessionManager listener without affecting siblings', async () => {
    const sharedSessionManager = new MockSessionManager();
    const firstVoiceClient = new VoiceClient(sharedSessionManager as any, false);
    const secondVoiceClient = new VoiceClient(sharedSessionManager as any, false);

    expect(sharedSessionManager.listenerCount('message')).toBe(0);

    attachMessageHandlers(firstVoiceClient);
    attachMessageHandlers(secondVoiceClient);

    expect(sharedSessionManager.listenerCount('message')).toBe(2);

    await firstVoiceClient.dispose();
    expect(sharedSessionManager.listenerCount('message')).toBe(1);

    await secondVoiceClient.dispose();
    expect(sharedSessionManager.listenerCount('message')).toBe(0);
  });

  test('stop revokes any pending pipeline audio blob URL', async () => {
    class MockURL extends URL {
      static createObjectURL = vi.fn(() => 'blob:voice-response');
      static revokeObjectURL = vi.fn();
    }

    vi.stubGlobal('URL', MockURL);

    const pause = vi.fn();
    const audioElement = {
      pause,
      src: 'blob:voice-response',
      onended: vi.fn(),
      onerror: vi.fn(),
    } as unknown as HTMLAudioElement;

    (voiceClient as any).pipelineAudioElement = audioElement;
    (voiceClient as any).pipelineAudioUrl = 'blob:voice-response';
    (voiceClient as any).isPipelinePlaying = true;
    (voiceClient as any).state = 'speaking';

    await voiceClient.stop();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(audioElement.src).toBe('');
    expect(MockURL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-response');
    expect((voiceClient as any).pipelineAudioElement).toBeNull();
    expect((voiceClient as any).pipelineAudioUrl).toBeNull();
  });
});
