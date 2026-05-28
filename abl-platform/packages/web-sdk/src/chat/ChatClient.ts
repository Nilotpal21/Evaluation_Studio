/**
 * ChatClient - Text messaging with streaming support
 *
 * Accepts an SDKTransport for transport-agnostic messaging.
 * Optional ChatUploadConfig for HTTP file uploads.
 * Optional SessionManager for omnichannel features (live transcript).
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type {
  Message,
  ChatEvents,
  SendMessageOptions,
  AuthChallengeMessage,
  TranscriptItem,
  PreflightAuthRequirement,
  SessionHealthDiagnostic,
  ActionSubmitOptions,
  MessageContentEnvelope,
  WSServerMessage,
  MessageMetadata,
} from '../core/types.js';
import type { SDKTransport, TransportServerMessage } from '../transport/types.js';
import {
  normalizeActionSet,
  normalizeContentEnvelope,
  normalizeRichContent,
  normalizeVoiceConfig,
} from '../core/message-normalization.js';

/**
 * Configuration for HTTP-based file upload.
 * Separated from SDKTransport because uploads are HTTP, not WebSocket.
 */
export interface ChatUploadConfig {
  getAuthToken: () => Promise<string>;
  getProjectId: () => string;
  getSessionId?: () => string | null;
  getEndpoint: () => string;
}

/** Maximum number of messages retained in the local history. */
const MAX_MESSAGES = 10_000;
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_PAGES = 20;
const EMPTY_RESPONSE_ERROR = "I'm having trouble completing that request. Please try again.";

type ChatActivityState =
  | { kind: 'idle' }
  | { kind: 'typing' }
  | { kind: 'status'; message: string; operation: string };

interface PersistedHistoryMessageRecord {
  id: string;
  role: Message['role'];
  content: string;
  timestamp: Date;
  contentEnvelope?: MessageContentEnvelope;
  metadata?: MessageMetadata;
}

interface PersistedHistoryPage {
  messages: PersistedHistoryMessageRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is Message['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'thought';
}

function parsePersistedHistoryEnvelope(value: unknown): MessageContentEnvelope | undefined {
  return normalizeContentEnvelope(value);
}

function parseMessageMetadata(value: unknown): MessageMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value as MessageMetadata;
}

function mergeMessageMetadata(
  metadata?: MessageMetadata,
  localization?: Record<string, unknown>,
): MessageMetadata | undefined {
  if (!metadata && !localization) {
    return undefined;
  }

  return {
    ...(metadata ?? {}),
    ...(localization ? { localization } : {}),
  };
}

function parsePersistedHistoryMessage(value: unknown): PersistedHistoryMessageRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isMessageRole(value.role)) {
    return null;
  }

  const contentEnvelope = parsePersistedHistoryEnvelope(value.contentEnvelope);
  const metadata = parseMessageMetadata(value.metadata);
  const timestamp = new Date(
    typeof value.timestamp === 'string' || value.timestamp instanceof Date ? value.timestamp : '',
  );

  return {
    id: value.id,
    role: value.role,
    content:
      typeof value.content === 'string'
        ? value.content
        : typeof contentEnvelope?.text === 'string'
          ? contentEnvelope.text
          : '',
    timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
    ...(contentEnvelope ? { contentEnvelope } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parsePersistedHistoryPage(value: unknown): PersistedHistoryPage {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return {
      messages: [],
      nextCursor: null,
      hasMore: false,
    };
  }

  return {
    messages: value.messages
      .map((message) => parsePersistedHistoryMessage(message))
      .filter((message): message is PersistedHistoryMessageRecord => message !== null),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    hasMore: value.hasMore === true,
  };
}

function formatAuthRequiredMessage(pending: PreflightAuthRequirement[]): string {
  const labels = pending
    .map((requirement) => requirement.connector || requirement.authProfileRef)
    .filter((label) => label.trim().length > 0);
  if (labels.length === 0) {
    return 'Authorization is required before the agent can continue.';
  }
  return `Authorization is required before the agent can continue: ${labels.join(', ')}.`;
}

function formatMessageQueuedMessage(reason: string): string {
  if (reason === 'auth_gate_active') {
    return 'Your message is queued until the required authorization is completed.';
  }
  return 'Your message has been queued.';
}

function formatToolWarningMessage(warning: string): string {
  return `Tool warning: ${warning}`;
}

function formatSessionHealthMessage(entry: SessionHealthDiagnostic): string {
  return entry.message;
}

function transcriptItemToMessage(item: TranscriptItem): Message {
  const metadata = mergeMessageMetadata(item.metadata, item.contentEnvelope?.localization);

  return {
    id: item.id,
    role: item.role,
    content: item.content.trim().length > 0 ? item.content : (item.contentEnvelope?.text ?? ''),
    timestamp: item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp),
    sourceChannel: item.sourceChannel,
    inputMode: item.inputMode,
    ...(item.contentEnvelope?.voiceConfig ? { voiceConfig: item.contentEnvelope.voiceConfig } : {}),
    ...(item.contentEnvelope?.richContent ? { richContent: item.contentEnvelope.richContent } : {}),
    ...(item.contentEnvelope?.actions ? { actions: item.contentEnvelope.actions } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export class ChatClient extends TypedEventEmitter<ChatEvents> {
  private readonly transport: SDKTransport;
  private readonly uploadConfig?: ChatUploadConfig;
  private readonly sessionManager?: SessionManager;
  private readonly debug: boolean;
  private messages: Message[] = [];
  private readonly messageIds = new Set<string>();
  private activity: ChatActivityState = { kind: 'idle' };
  private authChallengeTimer: ReturnType<typeof setTimeout> | null = null;
  private transportUnsubscribe: (() => void) | null = null;
  private disconnectUnsubscribe: (() => void) | null = null;
  private sessionMessageUnsubscribe: (() => void) | null = null;
  private historyHydrationPromise: Promise<void> | null = null;
  private historyHydrationSessionId: string | null = null;
  private historyHydrationGeneration = 0;
  /**
   * Pending feedback submissions awaiting an ack from the runtime.
   * Keyed by `${messageId}|${actionRenderId ?? ''}` so multiple rich-template
   * surfaces on the same message (each with their own renderId) can submit
   * independently without colliding.
   */
  private readonly pendingFeedback = new Map<
    string,
    {
      resolve: (value: { feedbackId: string }) => void;
      reject: (err: Error & { code?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    transport: SDKTransport,
    uploadConfig?: ChatUploadConfig,
    debug?: boolean,
    sessionManager?: SessionManager,
  ) {
    super();
    this.transport = transport;
    this.uploadConfig = uploadConfig;
    this.debug = debug ?? false;
    this.sessionManager = sessionManager;
    this.setupMessageHandlers();
  }

  /**
   * Send a text message, optionally with pre-uploaded attachment IDs
   */
  async send(text: string, options?: SendMessageOptions): Promise<string> {
    if (!this.transport.isConnected()) {
      throw new Error('Not connected to the platform');
    }

    const messageId = this.generateId();

    // Add user message to local state
    const userMessage: Message = {
      id: messageId,
      role: 'user',
      content: text,
      timestamp: new Date(),
      metadata: options?.metadata,
    };
    this.addMessage(userMessage);
    this.emit('message', userMessage);
    this.emit('messageSent', { messageId });

    // Send via transport
    this.transport.send({
      type: 'chat_message',
      text,
      messageId,
      sessionId: this.transport.getSessionId() ?? undefined,
      attachmentIds: options?.attachmentIds,
      metadata: options?.metadata,
    });

    this.log(
      'Sent message:',
      text.substring(0, 50),
      options?.attachmentIds?.length ? `(+${options.attachmentIds.length} attachments)` : '',
    );
    return messageId;
  }

  /**
   * Upload a file attachment to the platform.
   * Returns the attachment ID that can be passed to send() via options.attachmentIds.
   * Requires ChatUploadConfig to be provided at construction time.
   */
  async uploadAttachment(file: File): Promise<string> {
    if (!this.uploadConfig) {
      throw new Error(
        'uploadAttachment requires ChatUploadConfig — provide uploadConfig to ChatClient constructor',
      );
    }

    const endpoint = this.uploadConfig.getEndpoint();
    const sessionId = this.uploadConfig.getSessionId?.() ?? null;
    if (!sessionId) {
      throw new Error('No active session — send a message or wait for session_start');
    }

    const formData = new FormData();
    formData.append('file', file);

    const authToken = await this.uploadConfig.getAuthToken();
    const projectId = this.uploadConfig.getProjectId();
    const response = await fetch(
      `${endpoint}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
      {
        method: 'POST',
        body: formData,
        headers: {
          'X-SDK-Token': authToken,
        },
      },
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Upload failed');
      this.emit('attachmentError', { filename: file.name, error: errorBody });
      throw new Error(`Attachment upload failed: ${response.status} ${errorBody}`);
    }

    const result = (await response.json()) as { attachmentId: string };
    this.emit('attachmentUploaded', { attachmentId: result.attachmentId, filename: file.name });
    this.log('Uploaded attachment:', file.name, '→', result.attachmentId);
    return result.attachmentId;
  }

  /**
   * Get all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Check if agent is typing
   */
  getIsTyping(): boolean {
    return this.activity.kind === 'typing';
  }

  /**
   * Clear message history
   */
  clearMessages(): void {
    this.messages = [];
    this.messageIds.clear();
    this.emit('messagesReplaced', { messages: [] });
  }

  /**
   * Replace the local transcript with an authoritative ordered snapshot.
   * Intended for reconnect/session-switch restore flows where the caller has
   * the full transcript for the active session and wants the SDK to own the
   * replacement instead of manually clearing and replaying messages.
   */
  replaceTranscript(items: TranscriptItem[]): void {
    this.resetEphemeralSessionState();
    this.messages = this.buildTranscriptMessages(items);
    this.evictOldMessages();
    this.syncMessageIds();
    this.emit('messagesReplaced', { messages: this.getMessages() });
    this.log('Replaced transcript with', this.messages.length, 'items');
  }

  /**
   * Submit an action (button click, select change, form submit) back to the agent.
   * The server-side sdk-handler routes this through executeMessage with an actionEvent.
   */
  submitAction(actionId: string, value?: string | ActionSubmitOptions): void {
    if (!this.transport.isConnected()) return;
    const payload: ActionSubmitOptions = typeof value === 'string' ? { value } : (value ?? {});

    this.transport.send({
      type: 'action_submit',
      actionId,
      ...payload,
    });

    this.log('Action submitted:', actionId, value);
  }

  /**
   * Submit feedback (thumbs / star / text) on a persisted assistant message.
   *
   * Sends `feedback.submit` over the transport and resolves when the runtime
   * responds with `feedback.ack { success: true }`. Failure acks reject with
   * an error whose `code` matches the runtime's failure code
   * (DUPLICATE_FEEDBACK / INVALID_TARGET / INVALID_INPUT / STORAGE_FAILURE).
   *
   * Times out after `timeoutMs` (default 10s) with code `FEEDBACK_TIMEOUT`.
   *
   * @param input.messageId        Persisted assistant message id to rate.
   * @param input.ratingType       'thumbs' | 'star' | 'text'.
   * @param input.ratingValue      0/1 for thumbs, 1-5 for star, 0 for text.
   * @param input.feedbackText     Optional free-text (≤ 5000 chars; required for ratingType='text').
   * @param input.actionRenderId   Optional opaque id from a rich-template surface; echoed in the ack.
   * @param input.timeoutMs        Optional override for the ack timeout.
   */
  submitFeedback(input: {
    messageId: string;
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText?: string;
    actionRenderId?: string;
    timeoutMs?: number;
  }): Promise<{ feedbackId: string }> {
    if (!this.transport.isConnected()) {
      const err = new Error('Not connected to the platform') as Error & { code: string };
      err.code = 'NOT_CONNECTED';
      return Promise.reject(err);
    }

    const key = this.feedbackKey(input.messageId, input.actionRenderId);
    if (this.pendingFeedback.has(key)) {
      const err = new Error('Feedback already pending for this message') as Error & {
        code: string;
      };
      err.code = 'FEEDBACK_PENDING';
      return Promise.reject(err);
    }

    const timeoutMs = input.timeoutMs ?? 10_000;
    return new Promise<{ feedbackId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingFeedback.get(key);
        if (!pending) return;
        this.pendingFeedback.delete(key);
        const err = new Error(`Feedback ack timed out after ${timeoutMs}ms`) as Error & {
          code: string;
        };
        err.code = 'FEEDBACK_TIMEOUT';
        pending.reject(err);
      }, timeoutMs);
      this.pendingFeedback.set(key, {
        resolve,
        reject,
        timer,
      });

      try {
        this.transport.send({
          type: 'feedback.submit',
          messageId: input.messageId,
          ratingType: input.ratingType,
          ratingValue: input.ratingValue,
          ...(input.feedbackText !== undefined ? { feedbackText: input.feedbackText } : {}),
          ...(input.actionRenderId !== undefined ? { actionRenderId: input.actionRenderId } : {}),
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingFeedback.delete(key);
        const wrapped = (err instanceof Error ? err : new Error(String(err))) as Error & {
          code?: string;
        };
        if (!wrapped.code) wrapped.code = 'TRANSPORT_ERROR';
        reject(wrapped);
      }
    });
  }

  /** Internal: composite key for the pending registry. */
  private feedbackKey(messageId: string, actionRenderId?: string): string {
    return `${messageId}|${actionRenderId ?? ''}`;
  }

  /** Internal: resolve or reject a pending feedback promise on ack. */
  private handleFeedbackAck(ack: {
    messageId: string;
    success: boolean;
    feedbackId?: string;
    actionRenderId?: string;
    error?: { code: string; message: string };
  }): void {
    const key = this.feedbackKey(ack.messageId, ack.actionRenderId);
    const pending = this.pendingFeedback.get(key);
    // Always emit the ack event so non-promise consumers can observe.
    this.emit('feedbackAck', {
      messageId: ack.messageId,
      success: ack.success,
      ...(ack.feedbackId ? { feedbackId: ack.feedbackId } : {}),
      ...(ack.actionRenderId ? { actionRenderId: ack.actionRenderId } : {}),
      ...(ack.error ? { error: ack.error } : {}),
    });
    if (!pending) return;
    this.pendingFeedback.delete(key);
    clearTimeout(pending.timer);
    if (ack.success && ack.feedbackId) {
      pending.resolve({ feedbackId: ack.feedbackId });
      return;
    }
    const message = ack.error?.message ?? 'Feedback rejected';
    const err = new Error(message) as Error & { code: string };
    err.code = ack.error?.code ?? 'FEEDBACK_REJECTED';
    pending.reject(err);
  }

  /**
   * Send an auth response for a JIT auth challenge (Phase 5).
   * Call this from your `onAuthChallenge` handler after the user completes or cancels auth.
   */
  sendAuthResponse(toolCallId: string, status: 'completed' | 'cancelled'): void {
    this.transport.send({
      type: 'auth_response',
      toolCallId,
      status,
    });
    this.log('Auth response sent:', toolCallId, status);
  }

  // ===========================================================================
  // Omnichannel Methods
  // ===========================================================================

  /**
   * Hydrate backfill items into the message list with dedup by id.
   * Items already present (by id) are skipped. New items are inserted
   * in sequence order and marked with their source channel.
   *
   * Note: This method operates on the local message array and does not
   * require SessionManager.
   */
  hydrateBackfill(items: TranscriptItem[]): void {
    const existingIds = this.buildMessageIdSet();
    const hydratedMessages = this.buildTranscriptMessages(items);

    const newMessages: Message[] = [];
    for (const message of hydratedMessages) {
      if (existingIds.has(message.id)) {
        continue;
      }
      existingIds.add(message.id);
      newMessages.push(message);
    }

    if (newMessages.length === 0) return;

    // Insert into messages list maintaining sequence order
    this.messages = [...this.messages, ...newMessages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    this.evictOldMessages();
    this.syncMessageIds();

    // Emit each new message so UI can render them
    for (const msg of newMessages) {
      this.emit('message', msg);
    }

    this.log('Hydrated', newMessages.length, 'backfill items');
  }

  /**
   * Subscribe to live transcript items from the session manager.
   * Incoming transcript items are converted to Messages and appended
   * to the message list with dedup by id.
   * Returns an unsubscribe function.
   *
   * Requires SessionManager — use AgentSDK or provide sessionManager to constructor.
   */
  subscribeLiveTranscript(): () => void {
    if (!this.sessionManager) {
      throw new Error(
        'subscribeLiveTranscript requires SessionManager — use AgentSDK or provide sessionManager',
      );
    }

    const unsubscribe = this.sessionManager.onTranscriptItem((item: TranscriptItem) => {
      const existingIds = this.buildMessageIdSet();
      if (existingIds.has(item.id)) return;

      const message = transcriptItemToMessage(item);

      this.addMessage(message);
      this.emit('message', message);
    });

    this.log('Live transcript subscription started');
    return unsubscribe;
  }

  /**
   * Send a typed interrupt message. This sends text input that can
   * interrupt an ongoing voice interaction in a live session.
   */
  sendTypedInterrupt(text: string): void {
    if (!this.transport.isConnected()) {
      throw new Error('Not connected to the platform');
    }

    const sessionId = this.resolveTypedInterruptSessionId();
    if (!sessionId) {
      throw new Error('No active session');
    }

    const messageId = this.generateId();

    // Add user message to local state with text source channel
    const userMessage: Message = {
      id: messageId,
      role: 'user',
      content: text,
      timestamp: new Date(),
      sourceChannel: 'text',
      inputMode: 'typed',
    };
    this.addMessage(userMessage);
    this.emit('message', userMessage);
    this.emit('messageSent', { messageId });

    this.transport.send({
      type: 'typed_interrupt',
      messageId,
      text,
      sessionId,
    });

    this.log('Typed interrupt sent:', text.substring(0, 50));
  }

  /**
   * Permanently clean up transport subscriptions, listeners, and timers.
   * Call this only when the owning integration is done with the ChatClient
   * instance. Temporary UI cleanup should unsubscribe its own listeners
   * instead of disposing a shared SDK-owned client.
   */
  dispose(): void {
    if (this.transportUnsubscribe) {
      this.transportUnsubscribe();
      this.transportUnsubscribe = null;
    }
    if (this.disconnectUnsubscribe) {
      this.disconnectUnsubscribe();
      this.disconnectUnsubscribe = null;
    }
    if (this.sessionMessageUnsubscribe) {
      this.sessionMessageUnsubscribe();
      this.sessionMessageUnsubscribe = null;
    }
    if (this.authChallengeTimer !== null) {
      clearTimeout(this.authChallengeTimer);
      this.authChallengeTimer = null;
    }
    this.removeAllListeners();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private setupMessageHandlers(): void {
    this.transportUnsubscribe = this.transport.on('message', (message) => {
      this.handleServerMessage(message);
    });
    this.disconnectUnsubscribe = this.transport.on('disconnected', (reason) => {
      this.resetTransportSessionState(reason);
    });
    if (this.sessionManager) {
      this.sessionMessageUnsubscribe = this.sessionManager.on(
        'message',
        (message: WSServerMessage) => {
          if (message.type === 'session_start') {
            void this.hydratePersistedHistory();
          }
        },
      );
    }
  }

  async hydratePersistedHistory(): Promise<void> {
    if (!this.uploadConfig) {
      return;
    }

    const sessionId = this.resolveHistorySessionId();
    if (!sessionId) {
      return;
    }

    if (this.historyHydrationPromise && this.historyHydrationSessionId === sessionId) {
      return this.historyHydrationPromise;
    }

    const generation = this.historyHydrationGeneration;
    this.historyHydrationSessionId = sessionId;
    this.historyHydrationPromise = this.fetchPersistedHistory(sessionId)
      .then((messages) => {
        if (
          generation !== this.historyHydrationGeneration ||
          sessionId !== this.resolveHistorySessionId()
        ) {
          return;
        }
        this.mergeHydratedMessages(messages);
      })
      .catch((error) => {
        this.log(
          'Persisted history hydration skipped:',
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (generation === this.historyHydrationGeneration) {
          this.historyHydrationPromise = null;
          this.historyHydrationSessionId = null;
        }
      });

    return this.historyHydrationPromise;
  }

  private resolveTypedInterruptSessionId(): string | null {
    const sessionManagerTarget = this.sessionManager?.getTypedInterruptTargetSessionId?.();
    if (sessionManagerTarget) {
      return sessionManagerTarget;
    }

    const liveSessionId = this.transport.getActiveLiveSessionId?.();
    if (liveSessionId) {
      return liveSessionId;
    }

    return this.transport.getSessionId();
  }

  private handleServerMessage(message: TransportServerMessage): void {
    switch (message.type) {
      case 'response_start':
        if (this.activity.kind !== 'status') {
          this.setActivity({ kind: 'typing' });
        }
        break;

      case 'response_chunk':
        // Map transport content -> ChatEvents messageChunk.chunk for backwards compat
        this.emit('messageChunk', {
          messageId: message.messageId,
          chunk: message.content,
        });
        break;

      case 'response_end': {
        this.setActivity({ kind: 'idle' });

        const contentEnvelope = normalizeContentEnvelope(message.contentEnvelope);
        const messageLocalization = isRecord(message.localization)
          ? message.localization
          : undefined;
        const localization = contentEnvelope?.localization ?? messageLocalization;
        const responseContentEnvelope =
          contentEnvelope || localization
            ? ({
                ...(contentEnvelope ?? {}),
                ...(localization ? { localization } : {}),
              } as MessageContentEnvelope)
            : undefined;
        const voiceConfig =
          normalizeVoiceConfig(message.voiceConfig) ?? responseContentEnvelope?.voiceConfig;
        const richContent =
          normalizeRichContent(message.richContent) ?? responseContentEnvelope?.richContent;
        const actions = normalizeActionSet(message.actions) ?? responseContentEnvelope?.actions;
        const metadata = mergeMessageMetadata(message.metadata, localization);
        const fallbackVoiceText =
          typeof voiceConfig?.plain_text === 'string' ? voiceConfig.plain_text.trim() : '';
        const resolvedContent =
          message.content.trim().length > 0
            ? message.content
            : responseContentEnvelope?.text?.trim()
              ? responseContentEnvelope.text
              : fallbackVoiceText;
        const hasTextContent = resolvedContent.trim().length > 0;
        const hasRenderablePayload =
          hasTextContent || richContent !== undefined || actions !== undefined;

        if (!hasRenderablePayload) {
          const errorMessage: Message = {
            id: this.generateId(),
            role: 'system',
            content: EMPTY_RESPONSE_ERROR,
            timestamp: new Date(),
            metadata: {
              errorCode: 'empty_response',
              severity: 'error',
            },
          };
          this.addMessage(errorMessage);
          this.emit('message', errorMessage);
          this.emit('error', { error: new Error(EMPTY_RESPONSE_ERROR) });
          break;
        }

        const assistantMessage: Message = {
          id: message.messageId,
          role: 'assistant',
          content: resolvedContent,
          timestamp: new Date(),
          voiceConfig,
          richContent,
          actions,
          contentEnvelope: responseContentEnvelope,
          sourceChannel: message.sourceChannel,
          metadata,
          citations: message.citations,
        };
        this.addMessage(assistantMessage);
        this.emit('message', assistantMessage);
        break;
      }

      case 'thought': {
        const thoughtMessage: Message = {
          id: this.generateId(),
          role: 'thought',
          content: message.content,
          timestamp: new Date(),
          metadata: message.metadata,
        };
        this.addMessage(thoughtMessage);
        this.emit('message', thoughtMessage);
        break;
      }

      case 'handoff': {
        const handoffMessage: Message = {
          id: this.generateId(),
          role: 'system',
          content: `Handed off from ${message.metadata.handoffFrom ?? 'unknown'} to ${message.metadata.handoffTo ?? 'unknown'}`,
          timestamp: new Date(),
          metadata: message.metadata,
        };
        this.addMessage(handoffMessage);
        this.emit('message', handoffMessage);
        break;
      }

      case 'auth_challenge': {
        // Clear any previous auth challenge timer
        if (this.authChallengeTimer !== null) {
          clearTimeout(this.authChallengeTimer);
          this.authChallengeTimer = null;
        }

        const challenge: AuthChallengeMessage = {
          type: 'auth_challenge',
          code: message.code,
          sessionId: message.sessionId,
          toolCallId: message.toolCallId,
          authType: message.authType,
          authUrl: message.authUrl,
          profileId: message.profileId,
          profileName: message.profileName,
          prompt: message.prompt,
          timeoutMs: message.timeoutMs,
        };
        this.emit('authChallenge', challenge);

        // If no handler registered, use default behavior:
        // log the URL and auto-cancel after timeout
        if (this.listenerCount('authChallenge') === 0) {
          this.log('Tool requires authorization. Visit:', challenge.authUrl ?? '(no URL provided)');
          this.authChallengeTimer = setTimeout(() => {
            this.authChallengeTimer = null;
            this.transport.send({
              type: 'auth_response',
              toolCallId: challenge.toolCallId,
              status: 'cancelled',
            });
          }, challenge.timeoutMs);
        }
        break;
      }

      case 'auth_required': {
        const authMessage: Message = {
          id: this.generateId(),
          role: 'system',
          content: formatAuthRequiredMessage(message.pending),
          timestamp: new Date(),
          metadata: {
            errorCode: 'auth_required',
            authCode: message.code,
            severity: 'warning',
            pending: message.pending,
            satisfied: message.satisfied,
          },
        };
        this.addMessage(authMessage);
        this.emit('message', authMessage);
        this.emit('authRequired', {
          sessionId: message.sessionId,
          pending: message.pending,
          satisfied: message.satisfied,
        });
        break;
      }

      case 'message_queued': {
        const queuedMessage: Message = {
          id: this.generateId(),
          role: 'system',
          content: formatMessageQueuedMessage(message.reason),
          timestamp: new Date(),
          metadata: {
            errorCode: 'message_queued',
            authCode: message.code,
            severity: 'warning',
            reason: message.reason,
          },
        };
        this.addMessage(queuedMessage);
        this.emit('message', queuedMessage);
        this.emit('messageQueued', {
          sessionId: message.sessionId,
          reason: message.reason,
        });
        break;
      }

      case 'tool_warnings': {
        for (const warning of message.warnings) {
          const warningMessage: Message = {
            id: this.generateId(),
            role: 'system',
            content: formatToolWarningMessage(warning),
            timestamp: new Date(),
            metadata: {
              errorCode: 'tool_warning',
              severity: 'warning',
            },
          };
          this.addMessage(warningMessage);
          this.emit('message', warningMessage);
        }
        break;
      }

      case 'session_health': {
        let emittedError = false;
        for (const entry of message.health) {
          const healthMessage: Message = {
            id: this.generateId(),
            role: 'system',
            content: formatSessionHealthMessage(entry),
            timestamp: new Date(),
            metadata: {
              errorCode: entry.code,
              severity: entry.severity === 'warning' ? 'warning' : 'error',
              category: entry.category,
            },
          };
          this.addMessage(healthMessage);
          this.emit('message', healthMessage);
          if (entry.severity !== 'warning') {
            emittedError = true;
          }
        }
        if (emittedError) {
          this.emit('error', { error: new Error('Session health issues detected') });
        }
        break;
      }

      case 'status_update':
        this.setActivity({
          kind: 'status',
          message: message.text,
          operation: message.operation ?? 'general',
        });
        this.emit('statusUpdate', {
          text: message.text,
          operation: message.operation ?? 'general',
        });
        break;

      case 'status_clear':
        if (this.activity.kind === 'status') {
          this.setActivity({ kind: 'idle' });
        } else {
          this.emit('statusClear', undefined);
        }
        break;

      case 'error': {
        // Create a visible error message in the chat history (HLD Concern #5)
        const errorMessage: Message = {
          id: this.generateId(),
          role: 'system',
          content: message.content,
          timestamp: new Date(),
          metadata: {
            errorCode: message.metadata?.errorCode ?? 'transport_error',
            severity: message.metadata?.severity ?? 'error',
            ...(message.metadata?.traceIds ? { traceIds: message.metadata.traceIds } : {}),
          },
        };
        this.addMessage(errorMessage);
        this.emit('message', errorMessage);
        // Also emit error event for programmatic handlers
        this.emit('error', { error: new Error(message.content) });
        break;
      }

      case 'feedback.ack':
        this.handleFeedbackAck(message);
        break;
    }
  }

  /** Add a message to the local history with size-bound eviction. */
  private addMessage(message: Message): void {
    if (message.role !== 'user') {
      this.setActivity({ kind: 'idle' });
    }

    if (this.messageIds.has(message.id)) {
      return;
    }
    this.messages.push(message);
    this.messageIds.add(message.id);
    this.evictOldMessages();
  }

  private resolveHistorySessionId(): string | null {
    return this.uploadConfig?.getSessionId?.() ?? this.transport.getSessionId();
  }

  private buildHistoryUrl(sessionId: string, cursor?: string): string {
    if (!this.uploadConfig) {
      throw new Error('History hydration requires upload configuration');
    }

    const endpoint = this.uploadConfig.getEndpoint();
    const projectId = this.uploadConfig.getProjectId();
    const url = new URL(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      endpoint,
    );
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('limit', String(HISTORY_PAGE_SIZE));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }
    return url.toString();
  }

  private async fetchPersistedHistory(sessionId: string): Promise<Message[]> {
    if (!this.uploadConfig) {
      return [];
    }

    const authToken = await this.uploadConfig.getAuthToken();
    const hydratedMessages: Message[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const response = await fetch(this.buildHistoryUrl(sessionId, cursor), {
        headers: {
          'X-SDK-Token': authToken,
        },
      });

      if (!response.ok) {
        throw new Error(`History request failed: ${response.status}`);
      }

      const parsed = parsePersistedHistoryPage(await response.json());
      hydratedMessages.push(
        ...parsed.messages.map((message) => {
          const metadata = mergeMessageMetadata(
            message.metadata,
            message.contentEnvelope?.localization,
          );

          return {
            id: message.id,
            role: message.role,
            content:
              message.content.trim().length > 0
                ? message.content
                : (message.contentEnvelope?.text ?? ''),
            timestamp: message.timestamp,
            ...(message.contentEnvelope?.voiceConfig
              ? { voiceConfig: message.contentEnvelope.voiceConfig }
              : {}),
            ...(message.contentEnvelope?.richContent
              ? { richContent: message.contentEnvelope.richContent }
              : {}),
            ...(message.contentEnvelope?.actions
              ? { actions: message.contentEnvelope.actions }
              : {}),
            ...(metadata ? { metadata } : {}),
          };
        }),
      );

      if (!parsed.hasMore || !parsed.nextCursor) {
        break;
      }
      cursor = parsed.nextCursor;
    }

    return hydratedMessages;
  }

  private mergeHydratedMessages(messages: Message[]): void {
    if (messages.length === 0) {
      return;
    }

    const existingIds = this.buildMessageIdSet();
    const existingFingerprints = new Set(
      this.messages.map((message) => this.buildMessageFingerprint(message)),
    );
    const newMessages = messages.filter((message) => {
      if (existingIds.has(message.id)) {
        return false;
      }
      const fingerprint = this.buildMessageFingerprint(message);
      if (existingFingerprints.has(fingerprint)) {
        return false;
      }
      existingIds.add(message.id);
      existingFingerprints.add(fingerprint);
      return true;
    });

    if (newMessages.length === 0) {
      return;
    }

    this.messages = [...this.messages, ...newMessages].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
    this.evictOldMessages();
    this.syncMessageIds();
    for (const message of newMessages) {
      this.emit('message', message);
    }
  }

  /** Evict oldest messages when the history exceeds MAX_MESSAGES. */
  private evictOldMessages(): void {
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
      this.syncMessageIds();
    }
  }

  /** Build a transient Set of existing message IDs for dedup checks. */
  private buildMessageIdSet(): Set<string> {
    return new Set(this.messageIds);
  }

  /** Keep the bounded message ID mirror aligned with the retained history window. */
  private syncMessageIds(): void {
    this.messageIds.clear();
    for (const message of this.messages) {
      this.messageIds.add(message.id);
    }
  }

  private buildTranscriptMessages(items: TranscriptItem[]): Message[] {
    const sortedItems = [...items].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    );
    const seenIds = new Set<string>();
    const messages: Message[] = [];

    for (const item of sortedItems) {
      if (seenIds.has(item.id)) {
        continue;
      }
      seenIds.add(item.id);
      messages.push(transcriptItemToMessage(item));
    }

    return messages;
  }

  private buildMessageFingerprint(message: Message): string {
    return JSON.stringify({
      role: message.role,
      content: message.content,
      voiceConfig: message.voiceConfig ?? null,
      richContent: message.richContent ?? null,
      actions: message.actions ?? null,
      localization:
        message.metadata && isRecord(message.metadata.localization)
          ? message.metadata.localization
          : null,
    });
  }

  private generateId(): string {
    return 'msg_' + Math.random().toString(36).substring(2, 15);
  }

  private resetTransportSessionState(reason?: string): void {
    // For session_switch the server-side session has ended; clear the local
    // message list so the UI starts clean for the incoming session.
    // For transient drops (network blip, server restart) messages are
    // intentionally preserved — Studio's SessionHistoryBridge calls
    // replaceTranscript() on reconnect if the authoritative transcript differs.
    if (reason === 'session_switch') {
      this.clearMessages();
    }

    this.resetEphemeralSessionState();
  }

  private resetEphemeralSessionState(): void {
    this.historyHydrationGeneration += 1;
    this.historyHydrationPromise = null;
    this.historyHydrationSessionId = null;

    if (this.authChallengeTimer !== null) {
      clearTimeout(this.authChallengeTimer);
      this.authChallengeTimer = null;
    }

    this.setActivity({ kind: 'idle' }, { emitStatusClear: false });
  }

  private setActivity(next: ChatActivityState, options: { emitStatusClear?: boolean } = {}): void {
    const previous = this.activity;
    if (previous.kind === next.kind) {
      if (
        next.kind !== 'status' ||
        (previous.kind === 'status' &&
          previous.message === next.message &&
          previous.operation === next.operation)
      ) {
        return;
      }
    }

    this.activity = next;

    if (previous.kind === 'typing' && next.kind !== 'typing') {
      this.emit('typing', { isTyping: false });
    }
    if (previous.kind === 'status' && next.kind !== 'status' && options.emitStatusClear !== false) {
      this.emit('statusClear', undefined);
    }
    if (next.kind === 'typing' && previous.kind !== 'typing') {
      this.emit('typing', { isTyping: true });
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[AgentSDK:Chat]', ...args);
    }
  }
}
