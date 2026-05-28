/**
 * Session Manager Omnichannel Tests
 *
 * Tests live session discovery, join, transcript subscription,
 * participant change events, and reconnection re-join logic.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../core/SessionManager.js';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  WSServerMessage,
  TranscriptItem,
  ParticipantEvent,
  SDKConfig,
} from '../core/types.js';
import {
  createCanonicalDiscovery,
  createCanonicalParticipant,
  createCanonicalTranscriptItem,
  createLiveSessionDiscoveredWireMessage,
  createLiveSessionJoinedWireMessage,
  createParticipantEventWireMessage,
  createTranscriptItemWireMessage,
} from './omnichannel-contract.fixtures.js';

// Mock TokenManager
class MockTokenManager {
  async getToken(): Promise<string> {
    return 'test-token';
  }
}

// Mock WebSocket for testing
class MockWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send = vi.fn();
  close = vi.fn();
}

function createSessionManager(): {
  sessionManager: SessionManager;
  mockWS: MockWebSocket;
} {
  const config: SDKConfig = {
    projectId: 'test-project',
    apiKey: 'pk_test',
    endpoint: 'http://localhost:3112',
    debug: false,
    webSocketConstructor: MockWebSocket as unknown as SDKConfig['webSocketConstructor'],
  };

  const tokenManager = new MockTokenManager();
  const sessionManager = new SessionManager(
    config,
    tokenManager as unknown as ConstructorParameters<typeof SessionManager>[1],
  );

  return { sessionManager, mockWS: new MockWebSocket() };
}

/**
 * Helper: directly access SessionManager's internal event emitter
 * to simulate server messages without needing a real WebSocket connection.
 */
function simulateMessage(sessionManager: SessionManager, message: WSServerMessage): void {
  // SessionManager is a TypedEventEmitter, so we can emit 'message' directly
  (sessionManager as unknown as TypedEventEmitter<{ message: WSServerMessage }>).emit(
    'message',
    message,
  );
}

describe('SessionManager Omnichannel', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    const result = createSessionManager();
    sessionManager = result.sessionManager;
  });

  // ===========================================================================
  // discoverLiveSession
  // ===========================================================================

  describe('discoverLiveSession', () => {
    test('returns null when not connected', async () => {
      // SessionManager starts disconnected (no ws connected)
      await expect(sessionManager.discoverLiveSession()).rejects.toThrow('Not connected');
    });

    test('returns discovery result when live_session_discovered received', async () => {
      // Mock isConnected and send
      Object.defineProperty(sessionManager, 'ws', {
        value: { readyState: 1 },
        writable: true,
      });
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-123',
        participants: [
          createCanonicalParticipant({
            participantId: 'p1',
            sessionId: 'live-session-123',
            contactId: 'contact-123',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          }),
        ],
        liveSyncState: 'active',
      });

      // Start discovery and simulate response
      const discoveryPromise = sessionManager.discoverLiveSession();

      // Simulate server response
      setTimeout(() => {
        simulateMessage(sessionManager, createLiveSessionDiscoveredWireMessage(discovery));
      }, 10);

      const result = await discoveryPromise;
      expect(result).toEqual(discovery);
    });

    test('accepts legacy discovery payloads wrapped in data', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const discoveryPromise = sessionManager.discoverLiveSession();

      setTimeout(() => {
        simulateMessage(sessionManager, {
          type: 'live_session_discovered',
          data: {
            sessionId: 'legacy-live-123',
            participants: [
              {
                id: 'legacy-p1',
                sessionId: 'legacy-live-123',
                contactId: 'contact-legacy',
                channel: 'voice',
                joinedAt: '2026-03-22T10:00:00Z',
              },
            ],
            liveSyncState: 'active',
          },
        });
      }, 10);

      const result = await discoveryPromise;
      expect(result?.sessionId).toBe('legacy-live-123');
      expect(result?.participants[0].participantId).toBe('legacy-p1');
      expect(result?.participants[0].channel).toBe('voice');
      expect(result?.participants[0].surface).toBe('voice');
      expect(result?.participants[0].contactId).toBe('contact-legacy');
    });

    test('returns null when live_session_not_found received', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const discoveryPromise = sessionManager.discoverLiveSession();

      setTimeout(() => {
        simulateMessage(sessionManager, {
          type: 'live_session_not_found',
        });
      }, 10);

      const result = await discoveryPromise;
      expect(result).toBeNull();
    });

    test('returns null on timeout', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      vi.useFakeTimers();

      const discoveryPromise = sessionManager.discoverLiveSession();

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await discoveryPromise;
      expect(result).toBeNull();

      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // joinLiveSession
  // ===========================================================================

  describe('joinLiveSession', () => {
    test('rejects when not connected', async () => {
      await expect(sessionManager.joinLiveSession('session-123')).rejects.toThrow('Not connected');
    });

    test('returns join result with backfill and participants', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const backfill = [
        createCanonicalTranscriptItem({
          id: 'ti-1',
          sessionId: 'live-session-123',
          role: 'user',
          content: 'Hello from voice',
          channel: 'voice',
          sourceChannel: 'voice',
          inputMode: 'speech',
          sequence: 1,
          timestamp: new Date('2026-03-22T10:00:00Z'),
        }),
        createCanonicalTranscriptItem({
          id: 'ti-2',
          sessionId: 'live-session-123',
          role: 'assistant',
          content: 'Hi there!',
          channel: 'voice',
          sourceChannel: 'voice',
          inputMode: 'system',
          sequence: 2,
          timestamp: new Date('2026-03-22T10:00:01Z'),
        }),
      ];
      const participants = [
        createCanonicalParticipant({
          participantId: 'p1',
          sessionId: 'live-session-123',
          contactId: 'contact-voice-1',
          surface: 'voice',
          channel: 'voice',
          mode: 'speech',
          attachedAt: new Date('2026-03-22T10:00:00Z'),
        }),
      ];

      const joinPromise = sessionManager.joinLiveSession('live-session-123', 'token-abc');

      setTimeout(() => {
        simulateMessage(
          sessionManager,
          createLiveSessionJoinedWireMessage({
            sessionId: 'live-session-123',
            participantId: 'p-self',
            backfill,
            participants,
          }),
        );
      }, 10);

      const result = await joinPromise;
      expect(result).toEqual({
        success: true,
        backfill,
        participants,
      });

      // Active live session should be tracked
      expect(sessionManager.getActiveLiveSessionId()).toBe('live-session-123');
    });

    test('accepts legacy transcript_backfill before joined', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const joinPromise = sessionManager.joinLiveSession('live-session-legacy');

      setTimeout(() => {
        simulateMessage(sessionManager, {
          type: 'transcript_backfill',
          items: [
            {
              id: 'legacy-ti-1',
              sessionId: 'live-session-legacy',
              role: 'assistant',
              content: 'Legacy backfill',
              channel: 'voice',
              sourceChannel: 'voice',
              inputMode: 'system',
              sequence: 1,
              timestamp: '2026-03-22T10:00:00Z',
              final: true,
            },
          ],
        });
        simulateMessage(sessionManager, {
          type: 'live_session_joined',
          sessionId: 'live-session-legacy',
          participantId: 'p-self',
          participants: [],
        });
      }, 10);

      const result = await joinPromise;
      expect(result.backfill).toHaveLength(1);
      expect(result.backfill[0].id).toBe('legacy-ti-1');
    });

    test('rejects on join error with structured payload', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      const joinPromise = sessionManager.joinLiveSession('live-session-123');

      setTimeout(() => {
        simulateMessage(sessionManager, {
          type: 'live_session_join_error',
          error: {
            code: 'SESSION_NOT_ACTIVE',
            message: 'Session not found or access denied',
          },
        });
      }, 10);

      await expect(joinPromise).rejects.toThrow('Session not found or access denied');
    });

    test('getTypedInterruptTargetSessionId prefers the joined live session over the primary session', async () => {
      Object.defineProperty(sessionManager, 'sessionId', {
        value: 'sdk-session-123',
        writable: true,
      });
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      expect(sessionManager.getTypedInterruptTargetSessionId()).toBe('sdk-session-123');

      const joinPromise = sessionManager.joinLiveSession('live-session-typed');

      setTimeout(() => {
        simulateMessage(
          sessionManager,
          createLiveSessionJoinedWireMessage({
            sessionId: 'live-session-typed',
            participantId: 'p-self',
          }),
        );
      }, 10);

      await joinPromise;

      expect(sessionManager.getTypedInterruptTargetSessionId()).toBe('live-session-typed');
    });
  });

  // ===========================================================================
  // onTranscriptItem
  // ===========================================================================

  describe('onTranscriptItem', () => {
    test('receives transcript items from server messages', () => {
      const receivedItems: TranscriptItem[] = [];
      const unsubscribe = sessionManager.onTranscriptItem((item) => {
        receivedItems.push(item);
      });

      const transcriptItem = createCanonicalTranscriptItem({
        id: 'ti-100',
        sessionId: 'session-1',
        role: 'user',
        content: 'What is the weather?',
        channel: 'text',
        sourceChannel: 'text',
        inputMode: 'typed',
        sequence: 5,
        timestamp: new Date('2026-03-22T10:05:00Z'),
      });

      simulateMessage(sessionManager, createTranscriptItemWireMessage(transcriptItem));

      expect(receivedItems).toHaveLength(1);
      expect(receivedItems[0]).toEqual(transcriptItem);

      unsubscribe();

      // After unsubscribe, no more events
      simulateMessage(
        sessionManager,
        createTranscriptItemWireMessage({
          id: 'ti-101',
          sessionId: 'session-1',
          role: 'assistant',
          content: 'Response',
          channel: 'text',
          sourceChannel: 'text',
          inputMode: 'system',
          sequence: 6,
          timestamp: new Date('2026-03-22T10:05:01Z'),
        }),
      );

      expect(receivedItems).toHaveLength(1);
    });

    test('handles transcript_backfill with multiple items', () => {
      const receivedItems: TranscriptItem[] = [];
      sessionManager.onTranscriptItem((item) => {
        receivedItems.push(item);
      });

      const backfillItems = [
        createCanonicalTranscriptItem({
          id: 'ti-1',
          sessionId: 's1',
          role: 'user',
          content: 'First message',
          channel: 'voice',
          sourceChannel: 'voice',
          inputMode: 'speech',
          sequence: 1,
          timestamp: new Date('2026-03-22T10:00:00Z'),
        }),
        createCanonicalTranscriptItem({
          id: 'ti-2',
          sessionId: 's1',
          role: 'assistant',
          content: 'First response',
          channel: 'voice',
          sourceChannel: 'voice',
          inputMode: 'system',
          sequence: 2,
          timestamp: new Date('2026-03-22T10:00:01Z'),
        }),
      ];

      simulateMessage(sessionManager, {
        type: 'transcript_backfill',
        items: JSON.parse(JSON.stringify(backfillItems)),
      });

      expect(receivedItems).toEqual(backfillItems);
    });

    test('publishes locally generated transcript items through the same subscriber fan-out', () => {
      const receivedItems: TranscriptItem[] = [];
      sessionManager.onTranscriptItem((item) => {
        receivedItems.push(item);
      });

      const localTranscriptItem = createCanonicalTranscriptItem({
        id: 'ti-local-1',
        sessionId: 'live-session-local',
        role: 'user',
        content: 'Local voice transcript',
        channel: 'voice',
        sourceChannel: 'voice',
        inputMode: 'speech',
        sequence: 7,
        timestamp: new Date('2026-03-22T10:05:02Z'),
      });

      sessionManager.publishTranscriptItem(localTranscriptItem);

      expect(receivedItems).toEqual([localTranscriptItem]);
    });
  });

  // ===========================================================================
  // onParticipantChange
  // ===========================================================================

  describe('onParticipantChange', () => {
    test('receives participant attached events', () => {
      const events: ParticipantEvent[] = [];
      const unsubscribe = sessionManager.onParticipantChange((event) => {
        events.push(event);
      });

      const participant = createCanonicalParticipant({
        participantId: 'p2',
        sessionId: 'live-session-123',
        contactId: 'contact-123',
        surface: 'web',
        channel: 'text',
        mode: 'typed',
        attachedAt: new Date('2026-03-22T10:10:00Z'),
      });

      simulateMessage(
        sessionManager,
        createParticipantEventWireMessage('participant_attached', participant),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'attached',
        participant,
      });

      unsubscribe();
    });

    test('receives participant detached events', () => {
      const events: ParticipantEvent[] = [];
      sessionManager.onParticipantChange((event) => {
        events.push(event);
      });

      const participant = createCanonicalParticipant({
        participantId: 'p1',
        sessionId: 'live-session-123',
        contactId: 'contact-voice-1',
        surface: 'voice',
        channel: 'voice',
        mode: 'speech',
        interactive: false,
        attachedAt: new Date('2026-03-22T10:00:00Z'),
      });

      simulateMessage(
        sessionManager,
        createParticipantEventWireMessage('participant_detached', participant),
      );

      expect(events).toEqual([
        {
          type: 'detached',
          participant,
        },
      ]);
    });
  });

  // ===========================================================================
  // Live session lifecycle
  // ===========================================================================

  describe('live session lifecycle', () => {
    test('clearLiveSession resets active session state', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      // Join a session first
      const joinPromise = sessionManager.joinLiveSession('live-123');
      setTimeout(() => {
        simulateMessage(
          sessionManager,
          createLiveSessionJoinedWireMessage({
            sessionId: 'live-123',
            participantId: 'self',
          }),
        );
      }, 10);
      await joinPromise;

      expect(sessionManager.getActiveLiveSessionId()).toBe('live-123');

      sessionManager.clearLiveSession();
      expect(sessionManager.getActiveLiveSessionId()).toBeNull();
    });

    test('live_session_ended clears active session', async () => {
      vi.spyOn(sessionManager, 'isConnected').mockReturnValue(true);
      vi.spyOn(sessionManager, 'send').mockImplementation(() => {});

      // Join a session first
      const joinPromise = sessionManager.joinLiveSession('live-456');
      setTimeout(() => {
        simulateMessage(
          sessionManager,
          createLiveSessionJoinedWireMessage({
            sessionId: 'live-456',
            participantId: 'self',
          }),
        );
      }, 10);
      await joinPromise;

      expect(sessionManager.getActiveLiveSessionId()).toBe('live-456');

      // Simulate session end
      simulateMessage(sessionManager, {
        type: 'live_session_ended',
        sessionId: 'live-456',
        reason: 'ended',
      });

      expect(sessionManager.getActiveLiveSessionId()).toBeNull();
    });
  });
});
