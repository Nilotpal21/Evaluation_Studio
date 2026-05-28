/**
 * Chat Backfill Tests
 *
 * Tests hydrateBackfill dedup logic, subscribeLiveTranscript,
 * sendTypedInterrupt, and source-channel label support.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChatClient } from '../chat/ChatClient.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { Message, TranscriptItem } from '../core/types.js';
import type { TransportServerMessage, TransportClientMessage } from '../transport/types.js';

/**
 * MockTransport for ChatClient testing.
 */
class MockTransport extends TypedEventEmitter<{
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: { code: string; message: string; recoverable: boolean };
}> {
  private connected = true;
  private sessionId = 'test-session-backfill';
  capabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    // noop
  }

  send = vi.fn<(msg: TransportClientMessage) => void>();

  simulateMessage(message: TransportServerMessage): void {
    this.emit('message', message);
  }
}

/**
 * MockSessionManager for omnichannel features (subscribeLiveTranscript).
 */
class MockSessionManager {
  private transcriptHandlers: Array<(item: TranscriptItem) => void> = [];
  private messageHandlers: Array<(message: { type: string; [key: string]: unknown }) => void> = [];

  onTranscriptItem(handler: (item: TranscriptItem) => void): () => void {
    this.transcriptHandlers.push(handler);
    return () => {
      const idx = this.transcriptHandlers.indexOf(handler);
      if (idx >= 0) this.transcriptHandlers.splice(idx, 1);
    };
  }

  simulateTranscriptItem(item: TranscriptItem): void {
    for (const handler of this.transcriptHandlers) {
      handler(item);
    }
  }

  on(
    event: 'message',
    handler: (message: { type: string; [key: string]: unknown }) => void,
  ): () => void {
    if (event === 'message') {
      this.messageHandlers.push(handler);
      return () => {
        const idx = this.messageHandlers.indexOf(handler);
        if (idx >= 0) this.messageHandlers.splice(idx, 1);
      };
    }

    return () => {};
  }

  simulateMessage(message: { type: string; [key: string]: unknown }): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

function createTranscriptItem(overrides: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id: overrides.id ?? 'ti-' + Math.random().toString(36).substring(2, 8),
    sessionId: overrides.sessionId ?? 'session-1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Test message',
    ...(overrides.contentEnvelope ? { contentEnvelope: overrides.contentEnvelope } : {}),
    channel: overrides.channel ?? 'text',
    sourceChannel: overrides.sourceChannel ?? 'text',
    inputMode: overrides.inputMode ?? 'typed',
    sequence: overrides.sequence ?? 1,
    timestamp: overrides.timestamp ?? new Date('2026-03-22T10:00:00Z'),
    final: overrides.final ?? true,
  };
}

describe('Chat Backfill', () => {
  let transport: MockTransport;
  let sessionManager: MockSessionManager;
  let chatClient: ChatClient;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    transport = new MockTransport();
    sessionManager = new MockSessionManager();
    chatClient = new ChatClient(
      transport as any,
      {
        getAuthToken: async () => 'sdk-token',
        getProjectId: () => 'project-1',
        getSessionId: () => 'test-session-backfill',
        getEndpoint: () => 'http://localhost:3112',
      },
      false,
      sessionManager as any,
    );
  });

  // ===========================================================================
  // hydrateBackfill
  // ===========================================================================

  describe('hydrateBackfill', () => {
    test('adds backfill items to empty message list', () => {
      const messages: Message[] = [];
      chatClient.on('message', (msg) => messages.push(msg));

      const items: TranscriptItem[] = [
        createTranscriptItem({
          id: 'ti-1',
          content: 'Hello from voice',
          sourceChannel: 'voice',
          inputMode: 'speech',
          sequence: 1,
          timestamp: new Date('2026-03-22T10:00:00Z'),
        }),
        createTranscriptItem({
          id: 'ti-2',
          role: 'assistant',
          content: 'Hi there!',
          sourceChannel: 'voice',
          inputMode: 'system',
          sequence: 2,
          timestamp: new Date('2026-03-22T10:00:01Z'),
        }),
      ];

      chatClient.hydrateBackfill(items);

      const allMessages = chatClient.getMessages();
      expect(allMessages).toHaveLength(2);
      expect(allMessages[0].id).toBe('ti-1');
      expect(allMessages[0].content).toBe('Hello from voice');
      expect(allMessages[0].sourceChannel).toBe('voice');
      expect(allMessages[1].id).toBe('ti-2');
      expect(allMessages[1].role).toBe('assistant');

      // Events were emitted for each new message
      expect(messages).toHaveLength(2);
    });

    test('deduplicates items by id', () => {
      // First, send a response to populate the list
      transport.simulateMessage({
        type: 'response_end',
        messageId: 'existing-1',
        content: 'Already here',
      });

      // Now hydrate with a mix of new and existing items
      const items: TranscriptItem[] = [
        createTranscriptItem({
          id: 'existing-1', // duplicate
          content: 'Already here',
          sequence: 1,
          timestamp: new Date('2026-03-22T10:00:00Z'),
        }),
        createTranscriptItem({
          id: 'new-1',
          content: 'New backfill item',
          sequence: 2,
          timestamp: new Date('2026-03-22T10:00:01Z'),
        }),
      ];

      chatClient.hydrateBackfill(items);

      const allMessages = chatClient.getMessages();
      // Should have 2 messages: the original + the new one (not the duplicate)
      expect(allMessages).toHaveLength(2);
      expect(allMessages.find((m) => m.id === 'new-1')).toBeTruthy();
    });

    test('sorts messages by timestamp after hydration', () => {
      // Add a message first
      transport.simulateMessage({
        type: 'response_end',
        messageId: 'msg-recent',
        content: 'Recent message',
      });

      // Hydrate with an older item
      const items: TranscriptItem[] = [
        createTranscriptItem({
          id: 'old-item',
          content: 'Older message',
          sequence: 1,
          timestamp: new Date('2025-01-01T10:00:00Z'),
        }),
      ];

      chatClient.hydrateBackfill(items);

      const allMessages = chatClient.getMessages();
      expect(allMessages).toHaveLength(2);
      // Old item should come first (earlier timestamp)
      expect(allMessages[0].id).toBe('old-item');
      expect(allMessages[1].id).toBe('msg-recent');
    });

    test('handles empty backfill array', () => {
      chatClient.hydrateBackfill([]);
      expect(chatClient.getMessages()).toHaveLength(0);
    });

    test('hydrates rich content from transcript contentEnvelope', () => {
      chatClient.hydrateBackfill([
        createTranscriptItem({
          id: 'rich-backfill-1',
          role: 'assistant',
          content: '',
          inputMode: 'system',
          contentEnvelope: {
            text: 'Account summary',
            richContent: { markdown: '| Field | Value |' },
            actions: {
              elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
            },
            voiceConfig: { plain_text: 'Account summary' },
            localization: { domain: 'project', messageKey: 'account.summary' },
          },
        }),
      ]);

      expect(chatClient.getMessages()).toEqual([
        expect.objectContaining({
          id: 'rich-backfill-1',
          role: 'assistant',
          content: 'Account summary',
          richContent: { markdown: '| Field | Value |' },
          actions: {
            elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
          },
          voiceConfig: { plain_text: 'Account summary' },
          metadata: {
            localization: { domain: 'project', messageKey: 'account.summary' },
          },
        }),
      ]);
    });

    test('hydrates persisted session history on session_start using durable envelopes', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'persisted-user-1',
              role: 'user',
              content: 'hello',
              timestamp: '2026-03-22T10:00:00.000Z',
            },
            {
              id: 'persisted-assistant-1',
              role: 'assistant',
              content: '',
              timestamp: '2026-03-22T10:00:01.000Z',
              contentEnvelope: {
                version: 2,
                format: 'message_envelope',
                text: 'Welcome back',
                richContent: { markdown: '**Welcome back**' },
                actions: {
                  elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
                },
                voiceConfig: { plain_text: 'Welcome back' },
                localization: { domain: 'project', messageKey: 'welcome' },
              },
            },
          ],
          nextCursor: null,
          hasMore: false,
        }),
      });

      sessionManager.simulateMessage({
        type: 'session_start',
        sessionId: 'test-session-backfill',
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const messages = chatClient.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: 'persisted-user-1',
        role: 'user',
        content: 'hello',
      });
      expect(messages[1]).toMatchObject({
        id: 'persisted-assistant-1',
        role: 'assistant',
        content: 'Welcome back',
        richContent: { markdown: '**Welcome back**' },
        actions: {
          elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
        },
        voiceConfig: { plain_text: 'Welcome back' },
        metadata: {
          localization: { domain: 'project', messageKey: 'welcome' },
        },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/project-1/sessions/test-session-backfill/messages?direction=asc&limit=200',
        {
          headers: {
            'X-SDK-Token': 'sdk-token',
          },
        },
      );
    });

    test('preserves sourceChannel and inputMode on hydrated messages', () => {
      const items: TranscriptItem[] = [
        createTranscriptItem({
          id: 'voice-msg',
          content: 'Voice message',
          sourceChannel: 'voice',
          inputMode: 'speech',
        }),
        createTranscriptItem({
          id: 'text-msg',
          content: 'Text message',
          sourceChannel: 'text',
          inputMode: 'typed',
        }),
      ];

      chatClient.hydrateBackfill(items);

      const allMessages = chatClient.getMessages();
      const voiceMsg = allMessages.find((m) => m.id === 'voice-msg');
      const textMsg = allMessages.find((m) => m.id === 'text-msg');

      expect(voiceMsg?.sourceChannel).toBe('voice');
      expect(voiceMsg?.inputMode).toBe('speech');
      expect(textMsg?.sourceChannel).toBe('text');
      expect(textMsg?.inputMode).toBe('typed');
    });

    test('preserves thought role on hydrated messages', () => {
      chatClient.hydrateBackfill([
        createTranscriptItem({
          id: 'thought-msg',
          role: 'thought',
          content: 'Reviewing the available context',
          sourceChannel: 'system',
          inputMode: 'system',
        }),
      ]);

      const [message] = chatClient.getMessages();
      expect(message?.id).toBe('thought-msg');
      expect(message?.role).toBe('thought');
      expect(message?.content).toBe('Reviewing the available context');
      expect(message?.sourceChannel).toBe('system');
      expect(message?.inputMode).toBe('system');
    });
  });

  describe('replaceTranscript', () => {
    test('replaces local history with an authoritative ordered snapshot', () => {
      const replacedSnapshots: Message[][] = [];
      chatClient.on('messagesReplaced', ({ messages }) => {
        replacedSnapshots.push(messages);
      });

      transport.simulateMessage({
        type: 'response_end',
        messageId: 'stale-message',
        content: 'Stale local message',
      });
      expect(chatClient.getMessages().map((message) => message.id)).toEqual(['stale-message']);

      chatClient.replaceTranscript([
        createTranscriptItem({
          id: 'assistant-1',
          role: 'assistant',
          content: 'Second message',
          timestamp: new Date('2026-03-22T10:00:01Z'),
        }),
        createTranscriptItem({
          id: 'user-1',
          role: 'user',
          content: 'First message',
          timestamp: new Date('2026-03-22T10:00:00Z'),
        }),
        createTranscriptItem({
          id: 'assistant-1',
          role: 'assistant',
          content: 'Duplicate message',
          timestamp: new Date('2026-03-22T10:00:02Z'),
        }),
      ]);

      expect(chatClient.getMessages().map((message) => message.id)).toEqual([
        'user-1',
        'assistant-1',
      ]);
      expect(replacedSnapshots).toHaveLength(1);
      expect(replacedSnapshots[0].map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    });
  });

  // ===========================================================================
  // subscribeLiveTranscript
  // ===========================================================================

  describe('subscribeLiveTranscript', () => {
    test('subscribes to live transcript items and adds them to messages', () => {
      const receivedMessages: Message[] = [];
      chatClient.on('message', (msg) => receivedMessages.push(msg));

      const unsubscribe = chatClient.subscribeLiveTranscript();

      // Simulate a transcript item arriving
      sessionManager.simulateTranscriptItem(
        createTranscriptItem({
          id: 'live-1',
          content: 'Live voice message',
          sourceChannel: 'voice',
          inputMode: 'speech',
        }),
      );

      expect(chatClient.getMessages()).toHaveLength(1);
      expect(chatClient.getMessages()[0].id).toBe('live-1');
      expect(chatClient.getMessages()[0].sourceChannel).toBe('voice');
      expect(receivedMessages).toHaveLength(1);

      unsubscribe();

      // After unsubscribe, no more messages
      sessionManager.simulateTranscriptItem(
        createTranscriptItem({
          id: 'live-2',
          content: 'Should not appear',
        }),
      );

      expect(chatClient.getMessages()).toHaveLength(1);
    });

    test('deduplicates live transcript items by id', () => {
      chatClient.subscribeLiveTranscript();

      // Send the same item twice
      const item = createTranscriptItem({
        id: 'dup-1',
        content: 'First delivery',
      });

      sessionManager.simulateTranscriptItem(item);
      sessionManager.simulateTranscriptItem(item);

      expect(chatClient.getMessages()).toHaveLength(1);
    });
  });

  // ===========================================================================
  // sendTypedInterrupt
  // ===========================================================================

  describe('sendTypedInterrupt', () => {
    test('sends typed_interrupt transport message', () => {
      chatClient.sendTypedInterrupt('I have a question');

      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'typed_interrupt',
          text: 'I have a question',
          sessionId: 'test-session-backfill',
        }),
      );
    });

    test('adds user message to local state with text sourceChannel', () => {
      const messages: Message[] = [];
      chatClient.on('message', (msg) => messages.push(msg));

      chatClient.sendTypedInterrupt('Quick question');

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Quick question');
      expect(messages[0].sourceChannel).toBe('text');
      expect(messages[0].inputMode).toBe('typed');
    });

    test('emits messageSent event', () => {
      const sentIds: string[] = [];
      chatClient.on('messageSent', ({ messageId }) => sentIds.push(messageId));

      chatClient.sendTypedInterrupt('Hello');

      expect(sentIds).toHaveLength(1);
      expect(sentIds[0]).toMatch(/^msg_/);
    });

    test('throws when not connected', () => {
      const disconnectedTransport = new MockTransport();
      disconnectedTransport.setConnected(false);

      const client = new ChatClient(disconnectedTransport as any, undefined, false);

      expect(() => client.sendTypedInterrupt('Hello')).toThrow('Not connected');
    });
  });

  // ===========================================================================
  // Source channel on response_end
  // ===========================================================================

  describe('source channel labels', () => {
    test('response_end with sourceChannel preserves it on the message', () => {
      transport.simulateMessage({
        type: 'response_end',
        messageId: 'resp-1',
        content: 'Voice response',
        sourceChannel: 'voice',
      });

      const messages = chatClient.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].sourceChannel).toBe('voice');
    });

    test('response_end without sourceChannel has undefined sourceChannel', () => {
      transport.simulateMessage({
        type: 'response_end',
        messageId: 'resp-2',
        content: 'Regular response',
      });

      const messages = chatClient.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].sourceChannel).toBeUndefined();
    });
  });
});
