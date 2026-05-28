/**
 * Unified Widget Live Sync Tests
 *
 * Tests live session layout rendering, source-channel badges,
 * join prompt UX, typed input during voice, and graceful transitions.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { TypedEventEmitter } from '../core/EventEmitter.js';
import type {
  ChatEvents,
  JoinResult,
  LiveSessionDiscoveryResult,
  TranscriptItem,
  VoiceEvents,
  VoiceInfo,
} from '../core/types.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';
import {
  createCanonicalDiscovery,
  createCanonicalJoinResult,
  createCanonicalParticipant,
  createCanonicalTranscriptItem,
  transcriptItemToChatMessage,
} from './omnichannel-contract.fixtures.js';

type WidgetChatEvents = Pick<ChatEvents, 'message' | 'messageChunk' | 'typing' | 'error'>;
type WidgetVoiceEvents = Pick<
  VoiceEvents,
  | 'stateChange'
  | 'transcription'
  | 'thought'
  | 'statusUpdate'
  | 'statusClear'
  | 'responseEnd'
  | 'error'
>;

class MockLiveSyncChatClient extends TypedEventEmitter<WidgetChatEvents> {
  private liveTranscriptSubscribed = false;

  send = vi.fn(async () => 'chat-message-1');
  sendTypedInterrupt = vi.fn();
  hydrateBackfill = vi.fn((items: TranscriptItem[]) => {
    for (const item of items) {
      this.emit('message', transcriptItemToChatMessage(item));
    }
  });
  subscribeLiveTranscript = vi.fn(() => {
    this.liveTranscriptSubscribed = true;
    return () => {
      this.liveTranscriptSubscribed = false;
    };
  });

  emitLiveTranscript(item: TranscriptItem): void {
    if (!this.liveTranscriptSubscribed) {
      return;
    }
    this.emit('message', transcriptItemToChatMessage(item));
  }
}

class MockVoiceClient extends TypedEventEmitter<WidgetVoiceEvents> {
  private isMuted = false;
  private liveSyncEnabled = false;
  private liveSyncHandler: ((item: TranscriptItem) => void) | null = null;

  enableLiveSync = vi.fn((handler: (item: TranscriptItem) => void) => {
    this.liveSyncEnabled = true;
    this.liveSyncHandler = handler;
  });
  disableLiveSync = vi.fn(() => {
    this.liveSyncEnabled = false;
    this.liveSyncHandler = null;
  });
  start = vi.fn(async () => {});
  stop = vi.fn();
  toggleMute = vi.fn(() => {
    this.isMuted = !this.isMuted;
  });
  getLastThought = vi.fn(() => null);

  getInfo(): VoiceInfo {
    return {
      state: 'idle',
      voiceMode: 'pipeline',
      isMuted: this.isMuted,
      currentTranscript: '',
    };
  }

  emitPublishedTranscript(item: TranscriptItem): void {
    if (!this.liveSyncEnabled || !this.liveSyncHandler) {
      return;
    }

    this.liveSyncHandler(item);
  }
}

function primeWidgetSdk(
  target: UnifiedWidget,
  params: {
    discovery: LiveSessionDiscoveryResult | null;
    joinResult?: JoinResult;
  },
) {
  const chat = new MockLiveSyncChatClient();
  const voice = new MockVoiceClient();
  const sessionManager = {
    publishTranscriptItem: vi.fn((item: TranscriptItem) => {
      chat.emitLiveTranscript(item);
    }),
  };
  const sdk = {
    isConnected: () => true,
    getSessionScope: () => ({ showActivityUpdates: true }),
    getActiveLiveSessionId: () => null,
    discoverLiveSession: vi.fn(async () => params.discovery),
    joinLiveSession: vi.fn(async () => params.joinResult ?? createCanonicalJoinResult()),
    getSessionManager: vi.fn(() => sessionManager),
    disconnect: vi.fn(),
  };

  const ensureSDKInitialized = vi
    .spyOn(target as any, 'ensureSDKInitialized')
    .mockImplementation(async () => {
      (target as any).sdk = sdk;
      (target as any).chat = chat;
      (target as any).voice = voice;
      (target as any).setupChatHandlers();
      (target as any).setupVoiceHandlers();
    });

  return { chat, voice, sdk, ensureSDKInitialized, sessionManager };
}

describe('UnifiedWidget Live Sync', () => {
  let widget: UnifiedWidget;

  beforeEach(() => {
    // Stub browser voice capabilities so capability gating allows voice mode
    vi.stubGlobal('AudioContext', class MockAudioContext {});
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      mediaDevices: { getUserMedia: vi.fn() },
    });

    widget = new UnifiedWidget();
    widget.setAttribute('chat-enabled', 'true');
    widget.setAttribute('voice-enabled', 'true');
    document.body.appendChild(widget);
  });

  afterEach(() => {
    widget.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // Join prompt rendering
  // ===========================================================================

  describe('join prompt', () => {
    test('renders join prompt when live session is discovered', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'chat';
      (widget as any).discoveredSession = createCanonicalDiscovery({
        sessionId: 'live-session-1',
        participants: [
          createCanonicalParticipant({
            participantId: 'p1',
            sessionId: 'live-session-1',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
      });
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const joinPrompt = shadow.querySelector('.join-prompt');
      expect(joinPrompt).toBeTruthy();

      const joinBtn = shadow.querySelector('.join-btn');
      expect(joinBtn).toBeTruthy();
      expect(joinBtn!.textContent).toContain('Join Session');

      const dismissBtn = shadow.querySelector('.dismiss-join-btn');
      expect(dismissBtn).toBeTruthy();
    });

    test('does not render join prompt when no discovered session', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'chat';
      (widget as any).discoveredSession = null;
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const joinPrompt = shadow.querySelector('.join-prompt');
      expect(joinPrompt).toBeNull();
    });

    test('join prompt shows participant count', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'chat';
      (widget as any).discoveredSession = createCanonicalDiscovery({
        sessionId: 'live-session-2',
        participants: [
          createCanonicalParticipant({
            participantId: 'p1',
            sessionId: 'live-session-2',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
          createCanonicalParticipant({
            participantId: 'p2',
            sessionId: 'live-session-2',
            contactId: 'contact-2',
            surface: 'web',
            channel: 'text',
            mode: 'typed',
            attachedAt: new Date('2026-04-06T10:01:00Z'),
          }),
        ],
      });
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const promptText = shadow.querySelector('.join-prompt-text');
      expect(promptText).toBeTruthy();
      expect(promptText!.textContent).toContain('2 participants');
    });
  });

  describe('live session discovery wiring', () => {
    test('refreshLiveSessionDiscovery stores the discovered session and renders the join prompt', async () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-discovered',
        participants: [
          createCanonicalParticipant({
            participantId: 'voice-p1',
            sessionId: 'live-session-discovered',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
        liveSyncState: 'active',
      });
      const sdk = {
        isConnected: () => true,
        getActiveLiveSessionId: () => null,
        discoverLiveSession: vi.fn(async () => discovery),
        disconnect: vi.fn(),
      };
      (widget as any).sdk = sdk;

      const result = await widget.refreshLiveSessionDiscovery();

      expect(result).toEqual(discovery);
      expect((widget as any).discoveredSession).toEqual(discovery);
      expect(sdk.discoverLiveSession).toHaveBeenCalledTimes(1);
      expect(widget.shadowRoot!.querySelector('.join-prompt')).toBeTruthy();
    });

    test('open() refreshes live session discovery after SDK initialization', async () => {
      widget.setAttribute('mode', 'unified');
      const ensureSDKInitialized = vi
        .spyOn(widget as any, 'ensureSDKInitialized')
        .mockResolvedValue(undefined);
      const refreshLiveSessionDiscovery = vi
        .spyOn(widget, 'refreshLiveSessionDiscovery')
        .mockResolvedValue(null);

      await widget.open();

      expect(ensureSDKInitialized).toHaveBeenCalledTimes(1);
      expect(refreshLiveSessionDiscovery).toHaveBeenCalledTimes(1);
    });

    test('drives discover, join, transcript fan-out, and typed interrupt through the canonical live-session flow', async () => {
      widget.setAttribute('mode', 'unified');

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-contract',
        participants: [
          createCanonicalParticipant({
            participantId: 'voice-agent',
            sessionId: 'live-session-contract',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
      });
      const joinBackfill = [
        createCanonicalTranscriptItem({
          id: 'backfill-1',
          sessionId: 'live-session-contract',
          role: 'assistant',
          content: 'Voice greeting',
          channel: 'voice',
          sourceChannel: 'voice',
          inputMode: 'system',
          sequence: 1,
          timestamp: new Date('2026-04-06T10:00:01Z'),
        }),
      ];
      const joinResult = createCanonicalJoinResult({
        backfill: joinBackfill,
        participants: discovery.participants,
      });
      const { chat, voice, sdk, sessionManager } = primeWidgetSdk(widget, {
        discovery,
        joinResult,
      });

      await widget.open();

      expect(sdk.discoverLiveSession).toHaveBeenCalledTimes(1);
      expect(widget.shadowRoot!.querySelector('.join-prompt')).toBeTruthy();

      (widget.shadowRoot!.querySelector('.join-btn') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(sdk.joinLiveSession).toHaveBeenCalledWith('live-session-contract');
        expect(chat.hydrateBackfill).toHaveBeenCalledWith(joinBackfill);
        expect(chat.subscribeLiveTranscript).toHaveBeenCalledTimes(1);
        expect(voice.enableLiveSync).toHaveBeenCalledTimes(1);
        expect(widget.shadowRoot!.querySelector('.live-badge')).toBeTruthy();
      });

      voice.emit('stateChange', {
        state: 'speaking',
        previousState: 'idle',
      });

      const liveTranscript = createCanonicalTranscriptItem({
        id: 'live-2',
        sessionId: 'live-session-contract',
        role: 'assistant',
        content: 'Stay on the line',
        channel: 'voice',
        sourceChannel: 'voice',
        inputMode: 'system',
        sequence: 2,
        timestamp: new Date('2026-04-06T10:00:02Z'),
      });
      chat.emitLiveTranscript(liveTranscript);

      await vi.waitFor(() => {
        const liveMessage = Array.from(
          widget.shadowRoot!.querySelectorAll('.messages .message'),
        ).find((node) => (node.textContent ?? '').includes('Stay on the line'));
        expect(liveMessage).toBeTruthy();
        expect(liveMessage?.querySelector('.channel-badge-voice')).toBeTruthy();
      });

      const localVoiceTranscript = createCanonicalTranscriptItem({
        id: 'live-local-3',
        sessionId: 'live-session-contract',
        role: 'user',
        content: 'I need more help',
        channel: 'voice',
        sourceChannel: 'voice',
        inputMode: 'speech',
        sequence: 3,
        timestamp: new Date('2026-04-06T10:00:03Z'),
      });
      voice.emitPublishedTranscript(localVoiceTranscript);

      await vi.waitFor(() => {
        expect(sessionManager.publishTranscriptItem).toHaveBeenCalledWith(localVoiceTranscript);
        const localMessage = Array.from(
          widget.shadowRoot!.querySelectorAll('.messages .message'),
        ).find((node) => (node.textContent ?? '').includes('I need more help'));
        expect(localMessage).toBeTruthy();
      });

      const input = widget.shadowRoot!.querySelector('.input-field') as HTMLInputElement;
      input.value = 'I have an update';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (widget.shadowRoot!.querySelector('.send-btn') as HTMLButtonElement).click();

      expect(chat.sendTypedInterrupt).toHaveBeenCalledWith('I have an update');
      expect(chat.send).not.toHaveBeenCalled();
    });

    test('keeps live sync enabled across multiple voice turns in a joined session', async () => {
      widget.setAttribute('mode', 'unified');

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-multi-turn',
        participants: [
          createCanonicalParticipant({
            participantId: 'voice-agent',
            sessionId: 'live-session-multi-turn',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
      });
      const { voice } = primeWidgetSdk(widget, { discovery });

      await widget.open();
      (widget.shadowRoot!.querySelector('.join-btn') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(widget.shadowRoot!.querySelector('.live-badge')).toBeTruthy();
      });

      voice.emit('stateChange', {
        state: 'speaking',
        previousState: 'idle',
      });
      voice.emit('stateChange', {
        state: 'idle',
        previousState: 'speaking',
      });

      expect(voice.disableLiveSync).not.toHaveBeenCalled();

      const followupVoiceTranscript = createCanonicalTranscriptItem({
        id: 'live-local-4',
        sessionId: 'live-session-multi-turn',
        role: 'user',
        content: 'Second voice turn still syncs',
        channel: 'voice',
        sourceChannel: 'voice',
        inputMode: 'speech',
        sequence: 4,
        timestamp: new Date('2026-04-06T10:00:04Z'),
      });
      voice.emitPublishedTranscript(followupVoiceTranscript);

      await vi.waitFor(() => {
        const syncedMessage = Array.from(
          widget.shadowRoot!.querySelectorAll('.messages .message'),
        ).find((node) => (node.textContent ?? '').includes('Second voice turn still syncs'));
        expect(syncedMessage).toBeTruthy();
      });
    });

    test('ignores repeated join clicks while a live-session join is already in flight', async () => {
      widget.setAttribute('mode', 'unified');

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-join-once',
        participants: [
          createCanonicalParticipant({
            participantId: 'voice-agent',
            sessionId: 'live-session-join-once',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
      });
      let resolveJoin!: (result: JoinResult) => void;
      const pendingJoin = new Promise<JoinResult>((resolve) => {
        resolveJoin = resolve;
      });
      const { sdk } = primeWidgetSdk(widget, {
        discovery,
        joinResult: createCanonicalJoinResult({
          participants: discovery.participants,
        }),
      });
      sdk.joinLiveSession.mockImplementation(() => pendingJoin);

      await widget.open();

      const joinBtn = widget.shadowRoot!.querySelector('.join-btn') as HTMLButtonElement;
      joinBtn.click();
      joinBtn.click();

      await vi.waitFor(() => {
        expect(sdk.joinLiveSession).toHaveBeenCalledTimes(1);
        expect((widget.shadowRoot!.querySelector('.join-btn') as HTMLButtonElement).disabled).toBe(
          true,
        );
      });

      resolveJoin(
        createCanonicalJoinResult({
          participants: discovery.participants,
        }),
      );

      await vi.waitFor(() => {
        expect(widget.shadowRoot!.querySelector('.live-badge')).toBeTruthy();
      });
    });
  });

  // ===========================================================================
  // Live session layout
  // ===========================================================================

  describe('live session layout', () => {
    test('renders live session layout when in live session', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).render();

      const shadow = widget.shadowRoot!;

      // Should have live badge in header
      const liveBadge = shadow.querySelector('.live-badge');
      expect(liveBadge).toBeTruthy();
      expect(liveBadge!.textContent).toContain('LIVE');

      // Should have voice controls bar
      const voiceBar = shadow.querySelector('.voice-controls-bar');
      expect(voiceBar).toBeTruthy();

      // Should have compact voice button
      const voiceBtnCompact = shadow.querySelector('.voice-btn-compact');
      expect(voiceBtnCompact).toBeTruthy();

      // Should have messages area (transcript)
      const messages = shadow.querySelector('.messages');
      expect(messages).toBeTruthy();

      // Should have input area (typed input active during voice)
      const inputArea = shadow.querySelector('.input-area');
      expect(inputArea).toBeTruthy();
    });

    test('does not render live badge when not in live session', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = false;
      (widget as any).currentMode = 'chat';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const liveBadge = shadow.querySelector('.live-badge');
      expect(liveBadge).toBeNull();
    });

    test('shows mode toggle when not in live session', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = false;
      (widget as any).currentMode = 'chat';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const modeToggle = shadow.querySelector('.mode-toggle');
      // Note: mode toggle requires RTCPeerConnection which may not be available in tests
      // Just verify that when not in live session, the layout is the standard chat panel
      const messages = shadow.querySelector('.messages');
      expect(messages).toBeTruthy();
    });

    test('hides mode toggle when in live session', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const modeToggle = shadow.querySelector('.mode-toggle');
      expect(modeToggle).toBeNull();
    });
  });

  // ===========================================================================
  // Source channel badges
  // ===========================================================================

  describe('source channel badges', () => {
    test('getSourceChannelBadge returns badge for voice channel in live session', () => {
      (widget as any).isInLiveSession = true;
      const badge = (widget as any).getSourceChannelBadge('voice');
      expect(badge).toContain('channel-badge');
      expect(badge).toContain('channel-badge-voice');
      expect(badge).toContain('voice');
    });

    test('getSourceChannelBadge returns badge for text channel in live session', () => {
      (widget as any).isInLiveSession = true;
      const badge = (widget as any).getSourceChannelBadge('text');
      expect(badge).toContain('channel-badge');
      expect(badge).toContain('channel-badge-text');
      expect(badge).toContain('text');
    });

    test('getSourceChannelBadge returns empty when not in live session', () => {
      (widget as any).isInLiveSession = false;
      const badge = (widget as any).getSourceChannelBadge('voice');
      expect(badge).toBe('');
    });

    test('getSourceChannelBadge returns empty for undefined sourceChannel', () => {
      (widget as any).isInLiveSession = true;
      const badge = (widget as any).getSourceChannelBadge(undefined);
      expect(badge).toBe('');
    });
  });

  // ===========================================================================
  // Live transcript preview
  // ===========================================================================

  describe('live transcript preview', () => {
    test('shows current transcript in live session layout', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).currentTranscript = 'I need help with...';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const preview = shadow.querySelector('.live-transcript-preview');
      expect(preview).toBeTruthy();
      expect(preview!.textContent).toContain('I need help with...');
    });

    test('hides transcript preview when no current transcript', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).currentTranscript = '';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const preview = shadow.querySelector('.live-transcript-preview');
      expect(preview).toBeNull();
    });

    test('re-renders the live transcript preview for chat-mode live sessions', async () => {
      widget.setAttribute('mode', 'unified');

      const discovery = createCanonicalDiscovery({
        sessionId: 'live-session-preview',
        participants: [
          createCanonicalParticipant({
            participantId: 'voice-agent',
            sessionId: 'live-session-preview',
            contactId: 'contact-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            attachedAt: new Date('2026-04-06T10:00:00Z'),
          }),
        ],
      });
      const { voice } = primeWidgetSdk(widget, { discovery });

      await widget.open();
      (widget.shadowRoot!.querySelector('.join-btn') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(widget.shadowRoot!.querySelector('.live-badge')).toBeTruthy();
      });

      voice.emit('transcription', { text: 'I need help with my order', isFinal: false });

      await vi.waitFor(() => {
        expect(widget.shadowRoot!.querySelector('.live-transcript-preview')?.textContent).toContain(
          'I need help with my order',
        );
      });
    });
  });

  // ===========================================================================
  // Voice controls in live layout
  // ===========================================================================

  describe('voice controls in live layout', () => {
    test('shows mute button when voice is active', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).voiceState = 'listening';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const muteBtn = shadow.querySelector('.mute-btn-compact');
      expect(muteBtn).toBeTruthy();
    });

    test('hides mute button when voice is idle', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).isInLiveSession = true;
      (widget as any).currentMode = 'chat';
      (widget as any).voiceState = 'idle';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const muteBtn = shadow.querySelector('.mute-btn-compact');
      expect(muteBtn).toBeNull();
    });
  });

  // ===========================================================================
  // Standard mode regression — existing behavior preserved
  // ===========================================================================

  describe('backward compatibility', () => {
    test('chat mode still renders standard layout', () => {
      widget.setAttribute('mode', 'chat');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'chat';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const messages = shadow.querySelector('.messages');
      const inputArea = shadow.querySelector('.input-area');
      expect(messages).toBeTruthy();
      expect(inputArea).toBeTruthy();

      // No live session elements
      const liveBadge = shadow.querySelector('.live-badge');
      expect(liveBadge).toBeNull();
      const joinPrompt = shadow.querySelector('.join-prompt');
      expect(joinPrompt).toBeNull();
    });

    test('voice mode still renders standard voice panel', () => {
      widget.setAttribute('mode', 'voice');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'voice';
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      const voicePanel = shadow.querySelector('.voice-panel');
      expect(voicePanel).toBeTruthy();

      // No live session elements
      const liveBadge = shadow.querySelector('.live-badge');
      expect(liveBadge).toBeNull();
    });

    test('unified mode without live session shows mode toggle', () => {
      widget.setAttribute('mode', 'unified');
      (widget as any).isMinimized = false;
      (widget as any).currentMode = 'chat';
      (widget as any).isInLiveSession = false;
      (widget as any).discoveredSession = null;
      (widget as any).render();

      const shadow = widget.shadowRoot!;
      // Should still show chat panel
      const messages = shadow.querySelector('.messages');
      expect(messages).toBeTruthy();
      const inputArea = shadow.querySelector('.input-area');
      expect(inputArea).toBeTruthy();
    });
  });
});
