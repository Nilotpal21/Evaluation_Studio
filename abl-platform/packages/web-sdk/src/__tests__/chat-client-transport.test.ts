/**
 * ChatClient Transport Tests (INT-4, INT-5)
 *
 * Tests ChatClient with MockTransport.
 * Validates message flow: send, response_start/chunk/end, thought, handoff, error.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { Message } from '../core/types.js';
import type {
  TransportServerMessage,
  TransportClientMessage,
  TransportError,
} from '../transport/types.js';

/**
 * MockTransport for ChatClient testing.
 */
class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: TransportError;
}> {
  private connected = true;
  private sessionId = 'test-session-cct';
  private activeLiveSessionId: string | null = null;
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };
  sentMessages: TransportClientMessage[] = [];

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(c: boolean): void {
    this.connected = c;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getActiveLiveSessionId(): string | null {
    return this.activeLiveSessionId;
  }

  setActiveLiveSessionId(sessionId: string | null): void {
    this.activeLiveSessionId = sessionId;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    // noop
  }

  send(msg: TransportClientMessage): void {
    this.sentMessages.push(msg);
  }

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

describe('ChatClient with transport - message sending', () => {
  let transport: MockTransport;
  let chatClient: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chatClient = new ChatClient(transport as any, undefined, false);
  });

  test('send() emits user message, messageSent, and sends via transport', async () => {
    const messages: Message[] = [];
    const sentIds: string[] = [];

    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('messageSent', ({ messageId }) => sentIds.push(messageId));

    const messageId = await chatClient.send('Hello world');

    // User message was emitted
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello world');
    expect(messages[0].id).toBe(messageId);

    // messageSent event
    expect(sentIds).toHaveLength(1);
    expect(sentIds[0]).toBe(messageId);

    // Transport received the message
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual(
      expect.objectContaining({
        type: 'chat_message',
        text: 'Hello world',
        messageId,
        sessionId: 'test-session-cct',
      }),
    );
  });

  test('send() with attachment IDs', async () => {
    await chatClient.send('See attached', { attachmentIds: ['att-1', 'att-2'] });

    expect(transport.sentMessages[0]).toEqual(
      expect.objectContaining({
        type: 'chat_message',
        text: 'See attached',
        attachmentIds: ['att-1', 'att-2'],
      }),
    );
  });

  test('send() forwards per-message metadata to local state and transport', async () => {
    const metadata = {
      source: 'web-sdk-test',
      locale: 'en-US',
      nested: { plan: 'enterprise' },
    };
    const messages: Message[] = [];

    chatClient.on('message', (msg) => messages.push(msg));

    await chatClient.send('Hello with metadata', { metadata });

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata).toEqual(metadata);
    expect(transport.sentMessages[0]).toEqual(
      expect.objectContaining({
        type: 'chat_message',
        text: 'Hello with metadata',
        sessionId: 'test-session-cct',
        metadata,
      }),
    );
  });

  test('send() throws when not connected', async () => {
    transport.setConnected(false);
    await expect(chatClient.send('Hello')).rejects.toThrow('Not connected');
  });

  test('submitAction() sends action_submit via transport', () => {
    chatClient.submitAction('btn-1', 'confirm');

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual(
      expect.objectContaining({
        type: 'action_submit',
        actionId: 'btn-1',
        value: 'confirm',
      }),
    );
  });

  test('submitAction() sends structured formData and renderId when provided', () => {
    chatClient.submitAction('form-submit', {
      value: JSON.stringify({ target: 'Agent_A' }),
      formData: { target: 'Agent_A' },
      renderId: 'render-123',
    });

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual({
      type: 'action_submit',
      actionId: 'form-submit',
      value: JSON.stringify({ target: 'Agent_A' }),
      formData: { target: 'Agent_A' },
      renderId: 'render-123',
    });
  });

  test('sendAuthResponse() sends auth_response via transport', () => {
    chatClient.sendAuthResponse('tc-1', 'completed');

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual({
      type: 'auth_response',
      toolCallId: 'tc-1',
      status: 'completed',
    });
  });

  test('sendTypedInterrupt() targets the active live session when the transport exposes one', () => {
    transport.setActiveLiveSessionId('live-session-cct');

    chatClient.sendTypedInterrupt('Need to cut in');

    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0]).toEqual(
      expect.objectContaining({
        type: 'typed_interrupt',
        text: 'Need to cut in',
        sessionId: 'live-session-cct',
      }),
    );
  });
});

describe('ChatClient with transport - response handling', () => {
  let transport: MockTransport;
  let chatClient: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chatClient = new ChatClient(transport as any, undefined, false);
  });

  test('response_start sets typing', () => {
    const typingStates: boolean[] = [];
    chatClient.on('typing', ({ isTyping }) => typingStates.push(isTyping));

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });

    expect(typingStates).toEqual([true]);
    expect(chatClient.getIsTyping()).toBe(true);
  });

  test('response_chunk emits messageChunk with content mapped to chunk', () => {
    const chunks: Array<{ messageId: string; chunk: string }> = [];
    chatClient.on('messageChunk', (data) => chunks.push(data));

    transport.simulateMessage({
      type: 'response_chunk',
      content: 'Hello ',
      messageId: 'msg-1',
    });
    transport.simulateMessage({
      type: 'response_chunk',
      content: 'world',
      messageId: 'msg-1',
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ messageId: 'msg-1', chunk: 'Hello ' });
    expect(chunks[1]).toEqual({ messageId: 'msg-1', chunk: 'world' });
  });

  test('response_end creates assistant message and clears typing', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Hello world',
      richContent: { markdown: '**Hello** world' },
      sourceChannel: 'text',
    });

    expect(chatClient.getIsTyping()).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Hello world');
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].richContent).toEqual({ markdown: '**Hello** world' });
    expect(messages[0].sourceChannel).toBe('text');

    // Message is in the history
    expect(chatClient.getMessages()).toHaveLength(1);
  });

  test('response_end preserves top-level localization on assistant messages', () => {
    const messages: Message[] = [];
    const localization = {
      locale: 'en-US',
      source: 'template',
      bundleId: 'support-responses',
    };
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-localized',
      content: 'Localized answer',
      localization,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].contentEnvelope?.localization).toEqual(localization);
    expect(messages[0].metadata?.localization).toEqual(localization);
  });

  test('duplicate response_end messages with the same id do not duplicate history entries', () => {
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-dup',
      content: 'Hello world',
    });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-dup',
      content: 'Hello world',
    });

    expect(chatClient.getMessages()).toHaveLength(1);
    expect(chatClient.getMessages()[0].id).toBe('msg-dup');
  });

  test('empty response_end surfaces a visible system error instead of a blank assistant message', () => {
    const errors: Error[] = [];
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('error', ({ error }) => errors.push(error));

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-empty' });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-empty',
      content: '',
    });

    expect(chatClient.getIsTyping()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("I'm having trouble completing that request. Please try again.");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].metadata?.errorCode).toBe('empty_response');
    expect(messages[0].content).toBe(
      "I'm having trouble completing that request. Please try again.",
    );
  });

  test('response_end with rich content but empty text still creates an assistant message', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-rich',
      content: '',
      richContent: { markdown: '**Structured** output' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].richContent).toEqual({ markdown: '**Structured** output' });
  });

  test('response_end uses voiceConfig.plain_text when chat text is empty', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-voice-text',
      content: '',
      voiceConfig: {
        plain_text: 'Speak this reply aloud.',
        instructions: 'Warm and concise',
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Speak this reply aloud.');
    expect(messages[0].voiceConfig).toEqual({
      plain_text: 'Speak this reply aloud.',
      plainText: 'Speak this reply aloud.',
      instructions: 'Warm and concise',
    });
  });

  test('response_end with voiceConfig but no plain_text still surfaces an empty-response error', () => {
    const errors: Error[] = [];
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('error', ({ error }) => errors.push(error));

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-voice-only',
      content: '',
      voiceConfig: {
        instructions: 'Warm and concise',
        ssml: '<speak>Hello there</speak>',
      },
    });

    expect(errors).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].metadata?.errorCode).toBe('empty_response');
  });

  test('full response cycle: start → chunks → end', () => {
    const chunks: string[] = [];
    const messages: Message[] = [];

    chatClient.on('messageChunk', ({ chunk }) => chunks.push(chunk));
    chatClient.on('message', (msg) => {
      if (msg.role === 'assistant') messages.push(msg);
    });

    transport.simulateMessage({ type: 'response_start', messageId: 'msg-1' });
    transport.simulateMessage({ type: 'response_chunk', content: 'Hi', messageId: 'msg-1' });
    transport.simulateMessage({ type: 'response_chunk', content: ' there', messageId: 'msg-1' });
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Hi there',
    });

    expect(chunks).toEqual(['Hi', ' there']);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hi there');
  });

  test('keeps receiving transport messages after a disconnect and reconnect when not disposed', () => {
    const assistantMessages: Message[] = [];
    chatClient.on('message', (msg) => {
      if (msg.role === 'assistant') {
        assistantMessages.push(msg);
      }
    });

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'before-reconnect',
      content: 'Before reconnect',
    });

    transport.setConnected(false);
    transport.emit('disconnected', 'temporary_network_issue');
    transport.setConnected(true);
    transport.emit('connected', undefined as unknown as void);

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'after-reconnect',
      content: 'After reconnect',
    });

    expect(assistantMessages.map((message) => message.content)).toEqual([
      'Before reconnect',
      'After reconnect',
    ]);
    // Transient drops preserve the message list (ABLP-002 UX fix — no empty-chat
    // flash). Studio's SessionHistoryBridge replaces the transcript on reconnect
    // if the server transcript differs. In standalone usage both messages remain.
    expect(chatClient.getMessages()).toHaveLength(2);
    expect(chatClient.getMessages()[0].content).toBe('Before reconnect');
    expect(chatClient.getMessages()[1].content).toBe('After reconnect');
  });
});

describe('ChatClient with transport - thought/handoff/error handling', () => {
  let transport: MockTransport;
  let chatClient: ChatClient;

  beforeEach(() => {
    transport = new MockTransport();
    chatClient = new ChatClient(transport as any, undefined, false);
  });

  test('thought message creates message with role=thought and metadata', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'thought',
      content: 'I should use the search tool',
      metadata: { toolName: 'search', agentName: 'assistant' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('thought');
    expect(messages[0].content).toBe('I should use the search tool');
    expect(messages[0].metadata?.toolName).toBe('search');
    expect(messages[0].metadata?.agentName).toBe('assistant');

    // In history
    expect(chatClient.getMessages()).toHaveLength(1);
    expect(chatClient.getMessages()[0].role).toBe('thought');
  });

  test('handoff message creates system message with metadata and adds to history', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'handoff',
      metadata: { handoffFrom: 'triage', handoffTo: 'billing' },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('triage');
    expect(messages[0].content).toContain('billing');
    expect(messages[0].metadata?.handoffFrom).toBe('triage');
    expect(messages[0].metadata?.handoffTo).toBe('billing');

    // Verify in history (TC-5)
    const history = chatClient.getMessages();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('triage');
    expect(history[0].content).toContain('billing');
  });

  test('error message emits error event and adds system message to history', () => {
    const errors: Error[] = [];
    const messages: Message[] = [];
    chatClient.on('error', ({ error }) => errors.push(error));
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'error',
      content: 'Rate limit exceeded',
      metadata: { errorCode: 'RATE_LIMIT', severity: 'error' },
    });

    // Error event emitted
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Rate limit exceeded');

    // System message added to history (TC-4)
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('Rate limit exceeded');
    expect(messages[0].metadata?.errorCode).toBe('RATE_LIMIT');
    expect(messages[0].metadata?.severity).toBe('error');

    const history = chatClient.getMessages();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('system');
  });

  test('auth_challenge emits authChallenge event', () => {
    const challenges: unknown[] = [];
    chatClient.on('authChallenge', (c) => challenges.push(c));

    transport.simulateMessage({
      type: 'auth_challenge',
      code: 'AUTH_JIT_REQUIRED',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      authType: 'oauth2',
      authUrl: 'https://auth.example.com',
      profileId: 'prof-1',
      profileName: 'Google',
      prompt: 'Authorize',
      timeoutMs: 60000,
    });

    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toEqual({
      type: 'auth_challenge',
      code: 'AUTH_JIT_REQUIRED',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      authType: 'oauth2',
      authUrl: 'https://auth.example.com',
      profileId: 'prof-1',
      profileName: 'Google',
      prompt: 'Authorize',
      timeoutMs: 60000,
    });
  });

  test('auth_required creates a visible system message and emits authRequired', () => {
    const messages: Message[] = [];
    const authRequiredEvents: Array<{
      sessionId: string;
      pending: unknown[];
      satisfied: unknown[];
    }> = [];
    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('authRequired', (event) => authRequiredEvents.push(event));

    transport.simulateMessage({
      type: 'auth_required',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'Google Drive',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Authorization is required');
    expect(messages[0].metadata?.errorCode).toBe('auth_required');
    expect(messages[0].metadata?.authCode).toBe('AUTH_PREFLIGHT_REQUIRED');
    expect(authRequiredEvents).toEqual([
      {
        sessionId: 'sess-1',
        pending: [
          {
            connector: 'google_drive',
            authProfileRef: 'Google Drive',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      },
    ]);
  });

  test('message_queued creates a visible system message and emits messageQueued', () => {
    const messages: Message[] = [];
    const queuedEvents: Array<{ sessionId?: string; reason: string }> = [];
    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('messageQueued', (event) => queuedEvents.push(event));

    transport.simulateMessage({
      type: 'message_queued',
      code: 'AUTH_PREFLIGHT_REQUIRED',
      sessionId: 'sess-1',
      reason: 'auth_gate_active',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('queued');
    expect(messages[0].metadata?.errorCode).toBe('message_queued');
    expect(messages[0].metadata?.authCode).toBe('AUTH_PREFLIGHT_REQUIRED');
    expect(queuedEvents).toEqual([{ sessionId: 'sess-1', reason: 'auth_gate_active' }]);
  });

  test('tool_warnings create warning system messages', () => {
    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    transport.simulateMessage({
      type: 'tool_warnings',
      sessionId: 'sess-1',
      warnings: ['Slack token missing'],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Tool warning');
    expect(messages[0].metadata?.severity).toBe('warning');
  });

  test('session_health creates visible system messages and emits an error for error-level health', () => {
    const messages: Message[] = [];
    const errors: Error[] = [];
    chatClient.on('message', (msg) => messages.push(msg));
    chatClient.on('error', ({ error }) => errors.push(error));

    transport.simulateMessage({
      type: 'session_health',
      sessionId: 'sess-1',
      health: [
        {
          category: 'llm',
          severity: 'error',
          code: 'LLM_WIRING_FAILED',
          message: 'No model available',
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('No model available');
    expect(messages[0].metadata?.errorCode).toBe('LLM_WIRING_FAILED');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Session health issues');
  });

  test('clearMessages() empties the message history', async () => {
    await chatClient.send('Hello');

    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Hi',
    });

    expect(chatClient.getMessages().length).toBeGreaterThan(0);

    chatClient.clearMessages();
    expect(chatClient.getMessages()).toHaveLength(0);
  });
});

describe('ChatClient uploadAttachment without config', () => {
  test('throws when no uploadConfig provided', async () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    const file = new File(['test'], 'test.txt', { type: 'text/plain' });
    await expect(chatClient.uploadAttachment(file)).rejects.toThrow(
      'uploadAttachment requires ChatUploadConfig',
    );
  });
});

describe('ChatClient uploadAttachment with canonical sessionId', () => {
  test('uses canonical getSessionId for attachment uploads', async () => {
    const transport = new MockTransport();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ attachmentId: 'att-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const chatClient = new ChatClient(
        transport as any,
        {
          getAuthToken: async () => 'sdk-token',
          getProjectId: () => 'proj-1',
          getSessionId: () => 'session-1',
          getEndpoint: () => 'http://localhost:3112',
        },
        false,
      );

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      await expect(chatClient.uploadAttachment(file)).resolves.toBe('att-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/session-1/attachments',
        expect.objectContaining({
          method: 'POST',
          headers: { 'X-SDK-Token': 'sdk-token' },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// TC-1: ChatClient.dispose() cleanup
// ---------------------------------------------------------------------------
describe('ChatClient dispose()', () => {
  test('stops receiving messages after dispose', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    const messages: Message[] = [];
    chatClient.on('message', (msg) => messages.push(msg));

    // Verify messages are received before dispose
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-1',
      content: 'Before dispose',
    });
    expect(messages).toHaveLength(1);

    chatClient.dispose();

    // After dispose, messages should not be received
    transport.simulateMessage({
      type: 'response_end',
      messageId: 'msg-2',
      content: 'After dispose',
    });
    expect(messages).toHaveLength(1); // Still 1, not 2
  });

  test('clears auth challenge timer on dispose', () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const chatClient = new ChatClient(transport as any, undefined, false);

      // Emit auth_challenge with no listener — starts auto-cancel timer
      transport.simulateMessage({
        type: 'auth_challenge',
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        authType: 'oauth2',
        authUrl: 'https://auth.example.com',
        profileId: 'prof-1',
        profileName: 'Google',
        prompt: 'Authorize',
        timeoutMs: 5000,
      });

      // Dispose before timer fires
      chatClient.dispose();

      // Advance past timeout — should NOT send cancelled auth_response
      vi.advanceTimersByTime(6000);
      const authResponses = transport.sentMessages.filter((m) => m.type === 'auth_response');
      expect(authResponses).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('dispose unsubscribes from transport message and disconnect handlers', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    expect(transport.listenerCount('message')).toBe(1);
    expect(transport.listenerCount('disconnected')).toBe(1);

    chatClient.dispose();

    expect(transport.listenerCount('message')).toBe(0);
    expect(transport.listenerCount('disconnected')).toBe(0);
  });

  test('dispose is idempotent', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);
    expect(() => {
      chatClient.dispose();
      chatClient.dispose();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-3: auth_challenge auto-cancel timeout
// ---------------------------------------------------------------------------
describe('ChatClient auth_challenge auto-cancel', () => {
  test('auto-cancels after timeout when no listener is registered', () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const chatClient = new ChatClient(transport as any, undefined, false);

      transport.simulateMessage({
        type: 'auth_challenge',
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        authType: 'oauth2',
        authUrl: 'https://auth.example.com',
        profileId: 'prof-1',
        profileName: 'Google',
        prompt: 'Authorize',
        timeoutMs: 3000,
      });

      // Before timeout — no auth_response sent
      vi.advanceTimersByTime(2999);
      expect(transport.sentMessages.filter((m) => m.type === 'auth_response')).toHaveLength(0);

      // After timeout — cancelled auth_response sent
      vi.advanceTimersByTime(1);
      const authResponses = transport.sentMessages.filter((m) => m.type === 'auth_response');
      expect(authResponses).toHaveLength(1);
      expect(authResponses[0]).toEqual({
        type: 'auth_response',
        toolCallId: 'tc-1',
        status: 'cancelled',
      });

      chatClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not auto-cancel when listener is registered', () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const chatClient = new ChatClient(transport as any, undefined, false);

      // Register a listener before the challenge arrives
      chatClient.on('authChallenge', () => {
        // App handles the challenge
      });

      transport.simulateMessage({
        type: 'auth_challenge',
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        authType: 'oauth2',
        authUrl: 'https://auth.example.com',
        profileId: 'prof-1',
        profileName: 'Google',
        prompt: 'Authorize',
        timeoutMs: 3000,
      });

      // Advance well past timeout
      vi.advanceTimersByTime(10000);

      // No auto-cancel sent — the listener is responsible
      expect(transport.sentMessages.filter((m) => m.type === 'auth_response')).toHaveLength(0);

      chatClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('second auth_challenge clears first timer', () => {
    vi.useFakeTimers();
    try {
      const transport = new MockTransport();
      const chatClient = new ChatClient(transport as any, undefined, false);

      const challenge = {
        type: 'auth_challenge' as const,
        sessionId: 'sess-1',
        authType: 'oauth2',
        authUrl: 'https://auth.example.com',
        profileId: 'prof-1',
        profileName: 'Google',
        prompt: 'Authorize',
        timeoutMs: 5000,
      };

      transport.simulateMessage({ ...challenge, toolCallId: 'tc-1' });

      // Advance 3s — first timer still pending
      vi.advanceTimersByTime(3000);
      expect(transport.sentMessages.filter((m) => m.type === 'auth_response')).toHaveLength(0);

      // Second challenge arrives at t=3000 — resets timer
      transport.simulateMessage({ ...challenge, toolCallId: 'tc-2' });

      // Advance 4999ms — second timer not yet fired (needs 5000ms from t=3000)
      vi.advanceTimersByTime(4999);
      expect(transport.sentMessages.filter((m) => m.type === 'auth_response')).toHaveLength(0);

      // Advance 1 more ms — second timer fires at t=8000 (5000ms from second challenge)
      vi.advanceTimersByTime(1);
      const authResponses = transport.sentMessages.filter((m) => m.type === 'auth_response');
      expect(authResponses).toHaveLength(1);
      expect(authResponses[0]).toEqual({
        type: 'auth_response',
        toolCallId: 'tc-2',
        status: 'cancelled',
      });

      chatClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// TC-2: MAX_MESSAGES eviction
// ---------------------------------------------------------------------------
describe('ChatClient message eviction', () => {
  test('evicts oldest messages when exceeding MAX_MESSAGES (10000)', () => {
    const transport = new MockTransport();
    const chatClient = new ChatClient(transport as any, undefined, false);

    // Pump 10002 response_end messages through the transport
    for (let i = 0; i < 10002; i++) {
      transport.simulateMessage({
        type: 'response_end',
        messageId: `msg-${i}`,
        content: `Message ${i}`,
      });
    }

    const history = chatClient.getMessages();
    expect(history).toHaveLength(10000);
    // Oldest messages (msg-0, msg-1) should be evicted
    expect(history[0].id).toBe('msg-2');
    // Newest message should be at the end
    expect(history[history.length - 1].id).toBe('msg-10001');

    chatClient.dispose();
  });
});
