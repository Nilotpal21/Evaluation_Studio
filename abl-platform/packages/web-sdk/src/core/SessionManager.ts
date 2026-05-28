/**
 * SessionManager - WebSocket connection and session handling
 */

import { TypedEventEmitter } from './EventEmitter.js';
import type {
  SDKConfig,
  SDKSessionScope,
  WSClientMessage,
  WSServerMessage,
  WebSocketCloseEventLike,
  WebSocketConstructor,
  WebSocketLike,
  LiveSessionDiscoveryResult,
  JoinResult,
  TranscriptItem,
  Participant,
  ParticipantEvent,
  MessageMetadata,
} from './types.js';
import { TokenManager } from './TokenManager.js';
import { normalizeHttpEndpoint, normalizeWebSocketEndpoint } from './endpoint.js';
import { buildSdkWSProtocols, buildSdkWSTicketProtocols } from './websocket-auth.js';

interface SessionEvents {
  connected: void;
  disconnected: void;
  message: WSServerMessage;
  clientMessageSent: WSClientMessage;
  error: { error: Error };
}

const SESSION_READY_TIMEOUT_MS = 10_000;
const END_SESSION_CLOSE_FALLBACK_MS = 5_000;

function resolveWebSocketConstructor(config: SDKConfig): WebSocketConstructor {
  if (config.webSocketConstructor) {
    return config.webSocketConstructor;
  }

  if (typeof globalThis.WebSocket !== 'undefined') {
    return globalThis.WebSocket as unknown as WebSocketConstructor;
  }

  throw new Error(
    'WebSocket is not available in this runtime. Pass webSocketConstructor in the SDK config.',
  );
}

export class SessionManager extends TypedEventEmitter<SessionEvents> {
  private ws: WebSocketLike | null = null;
  private readonly config: SDKConfig;
  private readonly httpEndpoint: string;
  private readonly wsEndpoint: string;
  private readonly tokenManager: TokenManager;
  private readonly webSocketConstructor: WebSocketConstructor;
  private sessionId: string | null = null;
  private resolvedProjectId: string | null = null;
  private resolvedChannelId: string | null = null;
  private isSessionReady = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private pendingConnectResolve: (() => void) | null = null;
  private pendingConnectReject: ((error: Error) => void) | null = null;
  private pendingConnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private endSessionCloseTimeout: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  // Omnichannel state
  private activeLiveSessionId: string | null = null;
  private liveJoinToken: string | undefined = undefined;
  private transcriptItemHandlers = new Set<(item: TranscriptItem) => void>();
  private participantChangeHandlers = new Set<(event: ParticipantEvent) => void>();

  constructor(config: SDKConfig, tokenManager: TokenManager) {
    super();
    this.config = config;
    this.httpEndpoint = normalizeHttpEndpoint(config.endpoint);
    this.wsEndpoint = normalizeWebSocketEndpoint(config.endpoint);
    this.tokenManager = tokenManager;
    this.webSocketConstructor = resolveWebSocketConstructor(config);

    // Subscribe to our own message events for omnichannel dispatch.
    // This ensures omnichannel handlers fire regardless of whether messages
    // arrive via the WebSocket handler or are emitted directly (e.g., in tests).
    this.on('message', (message) => {
      this.handleOmnichannelMessage(message);
    });
  }

  async connect(): Promise<void> {
    if (this.isConnectionReady()) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.shouldReconnect = true;
    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearEndSessionCloseTimeout();
    this.rejectPendingConnect(new Error('Client disconnected before session_start'));
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.resetSessionState();
  }

  endSession(): void {
    this.shouldReconnect = false;
    if (!this.isConnectionReady() || !this.ws) {
      this.disconnect();
      return;
    }

    try {
      this.send({ type: 'end_session' });
      this.armEndSessionCloseFallback();
    } catch (error) {
      this.log('Failed to send end_session frame; disconnecting:', error);
      this.disconnect();
    }
  }

  send(message: WSClientMessage): void {
    if (!this.isConnectionReady() || !this.ws) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify(message));
    this.emit('clientMessageSent', message);
  }

  isConnected(): boolean {
    return this.isConnectionReady();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getProjectId(): string {
    return this.resolvedProjectId ?? this.config.projectId;
  }

  getChannelId(): string | null {
    return this.resolvedChannelId;
  }

  getScope(): SDKSessionScope | null {
    return this.tokenManager.getScope();
  }

  async getAuthToken(): Promise<string> {
    return this.tokenManager.getToken();
  }

  getEndpoint(): string {
    return this.httpEndpoint;
  }

  // ===========================================================================
  // Omnichannel Methods
  // ===========================================================================

  /**
   * Discover if a live session exists for the current SDK session.
   * Sends `discover_live_session` and waits for `live_session_discovered` response.
   * Returns null if no live session is found or timeout occurs.
   */
  async discoverLiveSession(): Promise<LiveSessionDiscoveryResult | null> {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 5000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('message', onMessage);
      };

      const onMessage = (message: WSServerMessage) => {
        if (message.type === 'live_session_discovered') {
          cleanup();
          const msg = this.asRecord(message);
          const payload = this.asRecord(msg.data);
          const source = Object.keys(payload).length > 0 ? payload : msg;
          const participants = this.parseParticipants(source.participants);
          const result: LiveSessionDiscoveryResult = {
            sessionId: (source.sessionId as string) || '',
            participants,
            liveSyncState: this.parseLiveSyncState(source.liveSyncState),
          };
          resolve(result);
        } else if (message.type === 'live_session_not_found') {
          cleanup();
          resolve(null);
        }
      };

      this.on('message', onMessage);

      this.send({
        type: 'discover_live_session',
        sessionId: this.sessionId,
      });
    });
  }

  /**
   * Join a live session by ID. Sends `join_live_session` and handles the
   * backfill response with transcript history and participant list.
   */
  async joinLiveSession(sessionId: string, joinToken?: string): Promise<JoinResult> {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Join live session timeout'));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.off('message', onMessage);
      };

      let backfillItems: TranscriptItem[] = [];

      const onMessage = (message: WSServerMessage) => {
        if (message.type === 'transcript_backfill') {
          const msg = this.asRecord(message);
          backfillItems = this.parseTranscriptItems(msg.items);
          return;
        }

        if (message.type === 'live_session_joined') {
          cleanup();
          const msg = this.asRecord(message);
          const joinedBackfill = Array.isArray(msg.backfill)
            ? this.parseTranscriptItems(msg.backfill)
            : backfillItems;
          const participants = this.parseParticipants(msg.participants);

          this.activeLiveSessionId = sessionId;
          this.liveJoinToken = joinToken;

          const result: JoinResult = {
            success: true,
            backfill: joinedBackfill,
            participants,
          };
          resolve(result);
        } else if (message.type === 'live_session_join_error') {
          cleanup();
          const msg = this.asRecord(message);
          const errorPayload = this.asRecord(msg.error);
          const errorMessage =
            (typeof msg.error === 'string' && msg.error) ||
            (typeof errorPayload.message === 'string' && errorPayload.message) ||
            'Failed to join live session';
          reject(new Error(errorMessage));
        }
      };

      this.on('message', onMessage);

      this.send({
        type: 'join_live_session',
        targetSessionId: sessionId,
        ...(joinToken ? { joinToken } : {}),
      });
    });
  }

  /**
   * Subscribe to live transcript items. Returns an unsubscribe function.
   */
  onTranscriptItem(handler: (item: TranscriptItem) => void): () => void {
    this.transcriptItemHandlers.add(handler);
    return () => {
      this.transcriptItemHandlers.delete(handler);
    };
  }

  /**
   * Publish a transcript item to all current live transcript subscribers.
   * Used by local clients (for example voice live sync) to fan out canonical
   * transcript items through the same delivery path as server transcript events.
   */
  publishTranscriptItem(item: TranscriptItem): void {
    this.emitTranscriptItem(item, 'Transcript item handler error:');
  }

  /**
   * Subscribe to participant attach/detach events. Returns an unsubscribe function.
   */
  onParticipantChange(handler: (event: ParticipantEvent) => void): () => void {
    this.participantChangeHandlers.add(handler);
    return () => {
      this.participantChangeHandlers.delete(handler);
    };
  }

  /**
   * Get the active live session ID, if any.
   */
  getActiveLiveSessionId(): string | null {
    return this.activeLiveSessionId;
  }

  /**
   * Get the preferred session target for typed interrupts.
   * Falls back to the primary SDK session when no live session is joined.
   */
  getTypedInterruptTargetSessionId(): string | null {
    return this.activeLiveSessionId ?? this.sessionId;
  }

  /**
   * Clear the active live session state (called when session ends or on disconnect).
   */
  clearLiveSession(): void {
    this.activeLiveSessionId = null;
    this.liveJoinToken = undefined;
  }

  // ===========================================================================
  // Omnichannel Parsing Helpers
  // ===========================================================================

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {};
  }

  private parseLiveSyncState(value: unknown): LiveSessionDiscoveryResult['liveSyncState'] {
    if (value === 'idle' || value === 'ended') {
      return value;
    }

    return 'active';
  }

  private normalizeSourceChannel(value: unknown): TranscriptItem['sourceChannel'] {
    if (value === 'voice') {
      return 'voice';
    }

    if (value === 'system') {
      return 'system';
    }

    return 'text';
  }

  private normalizeInputMode(
    value: unknown,
    fallbackChannel: TranscriptItem['sourceChannel'],
    role: TranscriptItem['role'] = 'user',
  ): TranscriptItem['inputMode'] {
    if (value === 'speech' || value === 'voice') {
      return 'speech';
    }

    if (value === 'typed') {
      return 'typed';
    }

    if (value === 'system' || value === 'tool') {
      return 'system';
    }

    if (role === 'assistant' || fallbackChannel === 'system') {
      return 'system';
    }

    return fallbackChannel === 'voice' ? 'speech' : 'typed';
  }

  private parseMessageMetadata(value: unknown): MessageMetadata | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as MessageMetadata;
    }

    return undefined;
  }

  private parseTranscriptItems(raw: unknown): TranscriptItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((candidate) => {
      const item = this.asRecord(candidate);
      const role =
        item.role === 'user' || item.role === 'assistant' || item.role === 'system'
          ? item.role
          : 'system';
      const sourceChannel = this.normalizeSourceChannel(item.sourceChannel ?? item.channel);
      const timestamp = item.timestamp ? new Date(item.timestamp as string | number) : new Date();
      const metadata = this.parseMessageMetadata(item.metadata);

      return {
        id: (item.id as string) || '',
        sessionId: (item.sessionId as string) || '',
        role,
        content: (item.content as string) || '',
        ...(metadata ? { metadata } : {}),
        channel: sourceChannel,
        sourceChannel,
        inputMode: this.normalizeInputMode(item.inputMode, sourceChannel, role),
        sequence: typeof item.sequence === 'number' ? item.sequence : 0,
        timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
        final: item.final !== false,
      };
    });
  }

  private parseParticipants(raw: unknown): Participant[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((candidate) => {
      const participant = this.asRecord(candidate);
      const channel = this.normalizeSourceChannel(participant.channel ?? participant.surface);
      const attachedAt = participant.attachedAt
        ? new Date(participant.attachedAt as string | number)
        : participant.joinedAt
          ? new Date(participant.joinedAt as string | number)
          : new Date();
      const surface: Participant['surface'] =
        participant.surface === 'voice' ||
        participant.surface === 'web' ||
        participant.surface === 'mobile' ||
        participant.surface === 'api'
          ? participant.surface
          : channel === 'voice'
            ? 'voice'
            : 'web';

      return {
        participantId: ((participant.participantId ?? participant.id) as string) || '',
        sessionId: (participant.sessionId as string) || '',
        contactId: (participant.contactId as string) || '',
        surface,
        channel,
        mode: this.normalizeInputMode(participant.mode, channel),
        interactive: participant.interactive !== false,
        attachedAt: Number.isNaN(attachedAt.getTime()) ? new Date() : attachedAt,
        ...(typeof participant.label === 'string' && participant.label.length > 0
          ? { label: participant.label }
          : {}),
      };
    });
  }

  private handleMessage(message: WSServerMessage): void {
    if (message.type === 'session_start') {
      const tokenScope = this.tokenManager.getScope();
      this.sessionId = message.sessionId as string;
      this.resolvedProjectId =
        typeof message.projectId === 'string' ? message.projectId : (tokenScope?.projectId ?? null);
      this.resolvedChannelId =
        typeof message.channelId === 'string' ? message.channelId : (tokenScope?.channelId ?? null);
      if (!this.isSessionReady) {
        this.isSessionReady = true;
        this.reconnectAttempts = 0;
        this.emit('connected', undefined);
        this.resolvePendingConnect();
        this.log('Connected');
      }
      this.log('Session started:', this.sessionId);
    }

    // Omnichannel messages are handled via the self-listener set up in the constructor.
    // This ensures they fire both for real WebSocket messages and test-emitted messages.
    this.emit('message', message);
  }

  private handleOmnichannelMessage(message: WSServerMessage): void {
    const msg = message as Record<string, unknown>;

    switch (message.type) {
      case 'transcript_item': {
        const items = this.parseTranscriptItems([msg.item ?? msg]);
        if (items.length > 0) {
          this.emitTranscriptItem(items[0], 'Transcript item handler error:');
        }
        break;
      }

      case 'transcript_backfill': {
        const items = this.parseTranscriptItems(msg.items);
        for (const item of items) {
          this.emitTranscriptItem(item, 'Transcript backfill handler error:');
        }
        break;
      }

      case 'participant_attached': {
        const participants = this.parseParticipants([msg.participant ?? msg]);
        if (participants.length > 0) {
          const event: ParticipantEvent = {
            type: 'attached',
            participant: participants[0],
          };
          for (const handler of this.participantChangeHandlers) {
            try {
              handler(event);
            } catch (error) {
              this.log('Participant change handler error:', error);
            }
          }
        }
        break;
      }

      case 'participant_detached': {
        const participants = this.parseParticipants([msg.participant ?? msg]);
        if (participants.length > 0) {
          const event: ParticipantEvent = {
            type: 'detached',
            participant: participants[0],
          };
          for (const handler of this.participantChangeHandlers) {
            try {
              handler(event);
            } catch (error) {
              this.log('Participant change handler error:', error);
            }
          }
        }
        break;
      }

      case 'live_session_ended':
        this.log('Live session ended:', msg.sessionId);
        this.activeLiveSessionId = null;
        this.liveJoinToken = undefined;
        break;
    }
  }

  private emitTranscriptItem(item: TranscriptItem, logPrefix: string): void {
    for (const handler of this.transcriptItemHandlers) {
      try {
        handler(item);
      } catch (error) {
        this.log(logPrefix, error);
      }
    }
  }

  private async openConnection(): Promise<void> {
    const authToken = await this.tokenManager.getToken();
    const protocols = await this.resolveWebSocketProtocols(authToken);
    const wsUrl = `${this.wsEndpoint}/ws/sdk`;

    return new Promise((resolve, reject) => {
      this.log('Connecting to', wsUrl);

      this.resetSessionState();
      this.ws = new this.webSocketConstructor(wsUrl, protocols);
      this.armPendingConnect(resolve, reject);

      this.ws.onopen = () => {
        this.log('WebSocket opened; waiting for session_start');
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as WSServerMessage;
          this.handleMessage(message);
        } catch (error) {
          this.log('Failed to parse message:', error);
        }
      };

      this.ws.onclose = (event) => {
        this.clearEndSessionCloseTimeout();
        this.ws = null;
        if (this.shouldInvalidateTokenForClose(event)) {
          this.tokenManager.invalidateToken();
        }
        this.resetSessionState();
        this.rejectPendingConnect(new Error('WebSocket closed before session_start'));
        this.emit('disconnected', undefined);
        this.log('Disconnected', event.code, event.reason);
        if (this.shouldReconnect) {
          this.attemptReconnect();
        }
      };

      this.ws.onerror = () => {
        const err = new Error('WebSocket error');
        this.emit('error', { error: err });
        this.rejectPendingConnect(err);
      };
    });
  }

  private async resolveWebSocketProtocols(authToken: string): Promise<string[]> {
    try {
      const response = await fetch(`${this.httpEndpoint}/api/v1/sdk/ws-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SDK-Token': authToken,
        },
        body: '{}',
      });

      if (!response.ok) {
        if (this.shouldUseLegacyWebSocketAuth(response.status)) {
          this.log('WebSocket ticket endpoint unavailable; using deprecated session-token auth');
          return buildSdkWSProtocols(authToken);
        }
        throw new Error(`WebSocket ticket request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('WebSocket ticket response was invalid');
      }

      const record = payload as Record<string, unknown>;
      const ticket = typeof record.ticket === 'string' ? record.ticket.trim() : '';
      if (!ticket) {
        throw new Error('WebSocket ticket response was missing ticket');
      }

      return buildSdkWSTicketProtocols(ticket);
    } catch (error) {
      this.log('WebSocket ticket request failed', error);
      throw error;
    }
  }

  private shouldUseLegacyWebSocketAuth(status: number): boolean {
    return status === 404 || status === 405 || status === 501;
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    // Capture live session state before reconnect attempt
    const previousLiveSessionId = this.activeLiveSessionId;
    const previousJoinToken = this.liveJoinToken;

    this.log('Reconnecting in', delay, 'ms (attempt', this.reconnectAttempts, ')');

    this.reconnectTimeout = setTimeout(() => {
      this.connect()
        .then(() => {
          // After successful reconnect, re-join live session if one was active
          if (previousLiveSessionId) {
            this.log('Re-joining live session after reconnect:', previousLiveSessionId);
            this.joinLiveSession(previousLiveSessionId, previousJoinToken).catch((rejoinError) => {
              const error =
                rejoinError instanceof Error ? rejoinError : new Error(String(rejoinError));
              this.log('Failed to re-join live session after reconnect:', error.message);
              this.activeLiveSessionId = null;
              this.liveJoinToken = undefined;
            });
          }
        })
        .catch((error) => {
          const reconnectError = error instanceof Error ? error : new Error(String(error));
          this.emit('error', { error: reconnectError });
          this.log('Reconnect failed:', reconnectError);
        });
    }, delay);
  }

  private isConnectionReady(): boolean {
    return this.ws?.readyState === this.webSocketConstructor.OPEN && this.isSessionReady;
  }

  private armPendingConnect(resolve: () => void, reject: (error: Error) => void): void {
    this.clearPendingConnect();
    this.pendingConnectResolve = resolve;
    this.pendingConnectReject = reject;
    this.pendingConnectTimeout = setTimeout(() => {
      const timeoutError = new Error('Timed out waiting for session_start');
      this.rejectPendingConnect(timeoutError);
      this.ws?.close();
    }, SESSION_READY_TIMEOUT_MS);
  }

  private resolvePendingConnect(): void {
    if (!this.pendingConnectResolve) {
      return;
    }

    const resolve = this.pendingConnectResolve;
    this.clearPendingConnect();
    resolve();
  }

  private rejectPendingConnect(error: Error): void {
    if (!this.pendingConnectReject) {
      return;
    }

    const reject = this.pendingConnectReject;
    this.clearPendingConnect();
    reject(error);
  }

  private clearPendingConnect(): void {
    if (this.pendingConnectTimeout) {
      clearTimeout(this.pendingConnectTimeout);
      this.pendingConnectTimeout = null;
    }
    this.pendingConnectResolve = null;
    this.pendingConnectReject = null;
  }

  private armEndSessionCloseFallback(): void {
    this.clearEndSessionCloseTimeout();
    this.endSessionCloseTimeout = setTimeout(() => {
      this.endSessionCloseTimeout = null;
      this.ws?.close(1000, 'Session ended by client');
    }, END_SESSION_CLOSE_FALLBACK_MS);
  }

  private clearEndSessionCloseTimeout(): void {
    if (this.endSessionCloseTimeout) {
      clearTimeout(this.endSessionCloseTimeout);
      this.endSessionCloseTimeout = null;
    }
  }

  private resetSessionState(): void {
    this.sessionId = null;
    this.resolvedProjectId = null;
    this.resolvedChannelId = null;
    this.isSessionReady = false;
  }

  private shouldInvalidateTokenForClose(event: WebSocketCloseEventLike): boolean {
    return event.code === 4001 || event.code === 4003 || event.code === 4010;
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[AgentSDK:Session]', ...args);
    }
  }
}
