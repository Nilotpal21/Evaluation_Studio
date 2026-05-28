/**
 * Voice Client Integration Tests (I-4.1 to I-4.4)
 *
 * Tests real VoiceClient with mock WebSocket (no vi.mock of VoiceClient internals).
 * Validates trace_event handling for thoughts, status updates, and unknown types.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceClient } from '../voice/VoiceClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  WSServerMessage,
  ThoughtEventData,
  StatusUpdateEventData,
  VoiceMode,
  VoiceSessionCapabilities,
} from '../core/types.js';

/**
 * Mock SessionManager that exposes message dispatch for testing.
 */
class MockSessionManager extends TypedEventEmitter<{
  connected: void;
  disconnected: void;
  message: WSServerMessage;
  error: { error: Error };
}> {
  readonly sentMessages: unknown[] = [];
  private connected = true;
  private sessionId = 'test-session-integration';
  private voiceStartMode: VoiceMode = 'pipeline';
  private voiceStartCapabilities: VoiceSessionCapabilities | undefined;
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

  setVoiceStartMode(voiceMode: VoiceMode): void {
    this.voiceStartMode = voiceMode;
  }

  setVoiceStartCapabilities(capabilities: VoiceSessionCapabilities | undefined): void {
    this.voiceStartCapabilities = capabilities;
  }

  send(message: unknown): void {
    this.sentMessages.push(message);

    if ((message as { type?: string }).type === 'voice_start') {
      queueMicrotask(() => {
        this.simulateMessage({
          type: 'voice_started',
          sessionId: this.sessionId,
          voiceMode: this.voiceStartMode,
          ...(this.voiceStartCapabilities ? { capabilities: this.voiceStartCapabilities } : {}),
        });
      });
    }
  }

  simulateMessage(message: WSServerMessage): void {
    this.emit('message', message);
  }
}

function installRealtimeVoiceBrowserMocks(
  closeImplementation: () => Promise<void> = async () => undefined,
): {
  closeMock: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  trackStop: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn(async function (this: {
    state: 'running' | 'suspended' | 'closed';
  }): Promise<void> {
    await closeImplementation();
    this.state = 'closed';
  });
  const trackStop = vi.fn();
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: trackStop }],
  }));

  class MockAudioContext {
    state: 'running' | 'suspended' | 'closed' = 'running';

    constructor(_options?: unknown) {
      // noop
    }

    resume = vi.fn(async () => {
      this.state = 'running';
    });

    close = closeMock;
  }

  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia,
    },
  });

  return { closeMock, getUserMedia, trackStop };
}

function attachMessageHandlers(client: VoiceClient): void {
  (client as unknown as { setupMessageHandlers: () => void }).setupMessageHandlers();
}

describe('Voice Client Integration (I-4.1 to I-4.4)', () => {
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

  // ===========================================================================
  // I-4.1: trace_event with tool_thought → thought event emitted
  // ===========================================================================

  test('I-4.1: canonical trace_event with tool_thought data emits thought event with correct shape', () => {
    attachMessageHandlers(voiceClient);
    const receivedEvents: ThoughtEventData[] = [];
    voiceClient.on('thought', (data) => receivedEvents.push(data));

    // Send multiple tool_thought events to verify integration across a conversation
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

    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'inventory_check',
          thought: 'Checking stock for 3 matching products',
          reasoning: 'Verifying availability before showing results',
          agentName: 'shopping-agent',
        },
      },
    });

    expect(receivedEvents).toHaveLength(2);

    expect(receivedEvents[0]).toEqual({
      toolName: 'product_search',
      thought: 'User wants red sneakers under $50',
      reasoning: 'Extracting price constraint and product category',
      agent: 'shopping-agent',
    });

    expect(receivedEvents[1]).toEqual({
      toolName: 'inventory_check',
      thought: 'Checking stock for 3 matching products',
      reasoning: 'Verifying availability before showing results',
      agent: 'shopping-agent',
    });

    // getLastThought returns the most recent
    expect(voiceClient.getLastThought()).toEqual(receivedEvents[1]);
  });

  // ===========================================================================
  // I-4.2: trace_event with status_update → statusUpdate event
  // ===========================================================================

  test('I-4.2: canonical trace_event with status_update data emits statusUpdate event', () => {
    attachMessageHandlers(voiceClient);
    const receivedEvents: StatusUpdateEventData[] = [];
    voiceClient.on('statusUpdate', (data) => receivedEvents.push(data));

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

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual({
      text: 'Searching for products...',
      operation: 'tool_call',
    });

    // getStatusMessage reflects latest status
    expect(voiceClient.getStatusMessage()).toBe('Searching for products...');

    // Status clear resets it
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: { type: 'status_clear' },
    });

    expect(voiceClient.getStatusMessage()).toBeNull();
  });

  // ===========================================================================
  // I-4.3: trace_event with unknown type → no crash, no event emitted
  // ===========================================================================

  test('I-4.3: trace_event with unknown type does not crash or emit events', () => {
    attachMessageHandlers(voiceClient);
    const thoughtHandler = vi.fn();
    const statusHandler = vi.fn();
    const clearHandler = vi.fn();
    const errorHandler = vi.fn();

    voiceClient.on('thought', thoughtHandler);
    voiceClient.on('statusUpdate', statusHandler);
    voiceClient.on('statusClear', clearHandler);
    voiceClient.on('error', errorHandler);

    // Unknown event type
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'some_future_event_type',
        data: { payload: { key: 'value' } },
      },
    });

    // Malformed event — missing event field
    sessionManager.simulateMessage({
      type: 'trace_event',
    });

    // event is null
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: null,
    });

    // event has no type field
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: { data: 'something' },
    });

    expect(thoughtHandler).not.toHaveBeenCalled();
    expect(statusHandler).not.toHaveBeenCalled();
    expect(clearHandler).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // I-4.4: React useVoice() updates thought state
  // ===========================================================================

  test('I-4.4: thought and status state update correctly through event flow', () => {
    attachMessageHandlers(voiceClient);
    // Since useVoice() is a React hook that depends on AgentProvider + AgentSDK + real WebSocket,
    // we verify the underlying contract that useVoice relies on:
    // VoiceClient emits 'thought' event → AgentProvider calls setThought(data)
    // VoiceClient emits 'statusUpdate' event → AgentProvider calls setStatusMessage(text)
    // VoiceClient emits 'statusClear' event → AgentProvider calls setStatusMessage(null)

    // Verify the full sequence that useVoice would see
    let latestThought: ThoughtEventData | null = null;
    let latestStatus: string | null = null;

    // Simulate what AgentProvider does with the voice client
    voiceClient.on('thought', (data) => {
      latestThought = data;
    });
    voiceClient.on('statusUpdate', ({ text }) => {
      latestStatus = text;
    });
    voiceClient.on('statusClear', () => {
      latestStatus = null;
    });

    // Initial state
    expect(latestThought).toBeNull();
    expect(latestStatus).toBeNull();

    // 1. Status update arrives
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'status_update',
        data: {
          text: 'Looking things up...',
          operation: 'reasoning',
        },
      },
    });
    expect(latestStatus).toBe('Looking things up...');
    expect(voiceClient.getStatusMessage()).toBe('Looking things up...');

    // 2. Thought arrives
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: {
        type: 'tool_thought',
        data: {
          toolName: 'analyze',
          thought: 'Analyzing the data',
          reasoning: 'Need to parse the results',
          agentName: 'data-agent',
        },
      },
    });
    expect(latestThought).toEqual({
      toolName: 'analyze',
      thought: 'Analyzing the data',
      reasoning: 'Need to parse the results',
      agent: 'data-agent',
    });
    expect(voiceClient.getLastThought()).toEqual(latestThought);

    // 3. Status clear
    sessionManager.simulateMessage({
      type: 'trace_event',
      event: { type: 'status_clear' },
    });
    expect(latestStatus).toBeNull();
    expect(voiceClient.getStatusMessage()).toBeNull();

    // 4. Thought persists after status clear (independent state)
    expect(latestThought).not.toBeNull();
    expect(voiceClient.getLastThought()).not.toBeNull();
  });

  test('lifecycle: stop awaits realtime audio player destroy before resolving', async () => {
    let resolveClose: () => void = () => {};
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const { closeMock, getUserMedia, trackStop } = installRealtimeVoiceBrowserMocks(
      () => closePromise,
    );

    sessionManager.setVoiceStartMode('realtime');
    expect(sessionManager.listenerCount('message')).toBe(0);

    await voiceClient.start();

    expect(voiceClient.getState()).toBe('ready');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(sessionManager.listenerCount('message')).toBe(1);
    ((voiceClient as any).realtimePlayer as { _isSpeaking: boolean })._isSpeaking = true;

    let stopResolved = false;
    const stopPromise = voiceClient.stop().then(() => {
      stopResolved = true;
    });

    expect(voiceClient.getState()).toBe('idle');
    expect(sessionManager.listenerCount('message')).toBe(0);
    expect(
      sessionManager.sentMessages.filter(
        (message) => (message as { type?: string }).type === 'voice_stop',
      ),
    ).toHaveLength(1);
    expect(stopResolved).toBe(false);

    await Promise.resolve();

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(voiceClient.getState()).toBe('idle');

    resolveClose();
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(voiceClient.getState()).toBe('idle');
    expect(sessionManager.listenerCount('message')).toBe(0);
  });

  test('lifecycle: voice_started capabilities are preserved in getInfo()', async () => {
    installRealtimeVoiceBrowserMocks();
    sessionManager.setVoiceStartMode('realtime');
    sessionManager.setVoiceStartCapabilities({
      localBargeIn: true,
      remoteTypedInterrupt: true,
      dtmf: false,
      returnToParent: true,
      activeAgentSync: false,
    });

    await voiceClient.start();

    expect(voiceClient.getVoiceMode()).toBe('realtime');
    expect(voiceClient.getInfo()).toMatchObject({
      state: 'ready',
      voiceMode: 'realtime',
      capabilities: {
        localBargeIn: true,
        remoteTypedInterrupt: true,
        dtmf: false,
        returnToParent: true,
        activeAgentSync: false,
      },
    });
  });

  test('protocol: voice_barge_in_ack interrupts realtime playback state', () => {
    attachMessageHandlers(voiceClient);
    const interrupt = vi.fn();
    (voiceClient as any).voiceMode = 'realtime';
    (voiceClient as any).state = 'speaking';
    (voiceClient as any).realtimePlayer = { interrupt };

    sessionManager.simulateMessage({ type: 'voice_barge_in_ack' });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(voiceClient.getState()).toBe('ready');
  });

  test('lifecycle: multiple realtime start/stop cycles reattach exactly one session listener', async () => {
    const { closeMock, getUserMedia, trackStop } = installRealtimeVoiceBrowserMocks();

    expect(sessionManager.listenerCount('message')).toBe(0);

    for (let cycle = 0; cycle < 2; cycle++) {
      sessionManager.setVoiceStartMode('realtime');

      await voiceClient.start();

      expect(voiceClient.getState()).toBe('ready');
      expect(sessionManager.listenerCount('message')).toBe(1);

      await voiceClient.stop();

      expect(voiceClient.getState()).toBe('idle');
      expect(sessionManager.listenerCount('message')).toBe(0);
    }

    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(trackStop).toHaveBeenCalledTimes(2);
    expect(
      sessionManager.sentMessages.filter(
        (message) => (message as { type?: string }).type === 'voice_start',
      ),
    ).toHaveLength(2);
    expect(
      sessionManager.sentMessages.filter(
        (message) => (message as { type?: string }).type === 'voice_stop',
      ),
    ).toHaveLength(2);
  });
});
