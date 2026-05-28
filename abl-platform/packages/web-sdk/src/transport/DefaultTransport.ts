/**
 * DefaultTransport - Wraps SessionManager to implement SDKTransport interface.
 *
 * Translates WSServerMessage events from SessionManager into typed
 * TransportServerMessage events for transport-agnostic consumers.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type {
  WSServerMessage,
  RichContent,
  ActionSet,
  SourceChannel,
  VoiceConfig,
  SessionHealthDiagnostic,
  PreflightAuthRequirement,
  MessageMetadata,
  MessageContentEnvelope,
} from '../core/types.js';
import {
  normalizeActionSet,
  normalizeContentEnvelope,
  normalizeRichContent,
  normalizeVoiceConfig,
} from '../core/message-normalization.js';
import type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
} from './types.js';
import { getTraceEventData, getTraceEventPayload } from './trace-event-utils.js';

// ---------------------------------------------------------------------------
// Internal event map for TypedEventEmitter
// ---------------------------------------------------------------------------

interface TransportEvents {
  message: TransportServerMessage;
  connected: void;
  disconnected: string | undefined;
  error: TransportError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeResponseLocalization(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function mergeLocalizationIntoMetadata(
  metadata: unknown,
  localization: Record<string, unknown> | undefined,
): MessageMetadata | undefined {
  const normalizedMetadata = isRecord(metadata) ? ({ ...metadata } as MessageMetadata) : undefined;
  if (!localization) {
    return normalizedMetadata;
  }

  return {
    ...(normalizedMetadata ?? {}),
    localization:
      normalizedMetadata?.localization && isRecord(normalizedMetadata.localization)
        ? normalizedMetadata.localization
        : localization,
  };
}

// ---------------------------------------------------------------------------
// DefaultTransport
// ---------------------------------------------------------------------------

export class DefaultTransport extends TypedEventEmitter<TransportEvents> implements SDKTransport {
  private readonly sessionManager: SessionManager;

  readonly capabilities: TransportCapabilities = {
    supportsThoughts: true,
    supportsHandoff: true,
    supportsFileUpload: true,
    supportsVoice: true,
  };

  constructor(sessionManager: SessionManager) {
    super();
    this.sessionManager = sessionManager;
    this.setupEventTranslation();
  }

  async connect(): Promise<void> {
    return this.sessionManager.connect();
  }

  disconnect(): void {
    this.sessionManager.disconnect();
  }

  isConnected(): boolean {
    return this.sessionManager.isConnected();
  }

  send(message: TransportClientMessage): void {
    // TransportClientMessage is a strict subset of WSClientMessage;
    // spread into a plain object for SessionManager.send()
    this.sessionManager.send({ ...message });
  }

  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  getActiveLiveSessionId(): string | null {
    return this.sessionManager.getActiveLiveSessionId();
  }

  // Override the base class on() to match the SDKTransport overloaded signature.
  // The base TypedEventEmitter.on() already returns () => void so we just
  // need the overload declarations to satisfy the interface.
  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): () => void {
    return super.on(event as keyof TransportEvents, handler as never);
  }

  // ---------------------------------------------------------------------------
  // Event translation: SessionManager events -> TransportServerMessage
  // ---------------------------------------------------------------------------

  private setupEventTranslation(): void {
    // Lifecycle events
    this.sessionManager.on('connected', () => {
      this.emit('connected', undefined);
    });

    this.sessionManager.on('disconnected', () => {
      this.emit('disconnected', undefined);
    });

    this.sessionManager.on('error', ({ error }) => {
      this.emit('error', {
        code: 'SESSION_ERROR',
        message: error.message,
        recoverable: true,
      });
    });

    // Message translation
    this.sessionManager.on('message', (wsMsg: WSServerMessage) => {
      const translated = this.translateMessage(wsMsg);
      if (translated) {
        this.emit('message', translated);
      }
    });
  }

  private translateMessage(wsMsg: WSServerMessage): TransportServerMessage | null {
    const msg = wsMsg as Record<string, unknown>;
    const showActivityUpdates = this.sessionManager.getScope()?.showActivityUpdates === true;

    switch (wsMsg.type) {
      case 'response_start':
        return {
          type: 'response_start',
          messageId: (msg.messageId as string) ?? '',
        };

      case 'response_chunk':
        return {
          type: 'response_chunk',
          content: (msg.chunk as string) ?? '',
          messageId: (msg.messageId as string) ?? '',
        };

      case 'response_end': {
        const contentEnvelope = normalizeContentEnvelope(msg.contentEnvelope);
        const topLevelLocalization = normalizeResponseLocalization(msg.localization);
        const localization = contentEnvelope?.localization ?? topLevelLocalization;
        const normalizedEnvelope =
          contentEnvelope || localization
            ? ({
                ...(contentEnvelope ?? {}),
                ...(localization ? { localization } : {}),
              } as MessageContentEnvelope)
            : undefined;
        return {
          type: 'response_end',
          messageId: (msg.messageId as string) ?? '',
          content: ((msg.fullText ?? msg.text ?? normalizedEnvelope?.text) as string) ?? '',
          voiceConfig: normalizeVoiceConfig(msg.voiceConfig) ?? normalizedEnvelope?.voiceConfig,
          richContent: normalizeRichContent(msg.richContent) ?? normalizedEnvelope?.richContent,
          actions: normalizeActionSet(msg.actions) ?? normalizedEnvelope?.actions,
          localization,
          contentEnvelope: normalizedEnvelope,
          sourceChannel: (msg.sourceChannel as SourceChannel) || undefined,
          metadata: mergeLocalizationIntoMetadata(msg.metadata, localization),
          citations: Array.isArray(msg.citations) ? msg.citations : undefined,
        };
      }

      case 'thought':
        if (!showActivityUpdates) {
          return null;
        }
        return {
          type: 'thought',
          content: ((msg.thought ?? msg.content) as string) ?? '',
          metadata: {
            toolName: (msg.toolName as string) || undefined,
            agentName: ((msg.agent ?? msg.agentName) as string) || undefined,
          },
        };

      case 'handoff':
        if (!showActivityUpdates) {
          return null;
        }
        return {
          type: 'handoff',
          metadata: {
            handoffFrom: (msg.fromAgent as string) || undefined,
            handoffTo: (msg.toAgent as string) || undefined,
            agentName: (msg.toAgent as string) || undefined,
          },
        };

      case 'error':
        return {
          type: 'error',
          content: ((msg.error ?? msg.message ?? msg.content) as string) ?? '',
          metadata: {
            errorCode: (msg.code as string) || undefined,
            severity: (msg.severity as 'warning' | 'error') || 'error',
          },
        };

      case 'trace_event': {
        const event = getTraceEventPayload(msg);
        const eventData = event ? getTraceEventData(event) : null;
        if (!event || !event.type || !eventData) {
          return null;
        }
        if (event.type === 'tool_thought') {
          if (!showActivityUpdates) {
            return null;
          }
          return {
            type: 'thought',
            content:
              ((eventData.thought ??
                eventData.reasoning ??
                event.thought ??
                event.reasoning) as string) ?? '',
            metadata: {
              toolName: ((eventData.toolName ?? event.toolName) as string) || undefined,
              agentName:
                ((eventData.agentName ??
                  eventData.agent ??
                  event.agentName ??
                  event.agent) as string) || undefined,
              traceIds: event.id ? [event.id] : undefined,
            },
          };
        }
        if (event.type === 'handoff') {
          if (!showActivityUpdates) {
            return null;
          }
          return {
            type: 'handoff',
            metadata: {
              handoffFrom: ((eventData.fromAgent ?? eventData.from) as string) || undefined,
              handoffTo: ((eventData.toAgent ?? eventData.to) as string) || undefined,
              agentName: ((eventData.toAgent ?? eventData.to) as string) || undefined,
              traceIds: event.id ? [event.id] : undefined,
            },
          };
        }
        if (event.type === 'error') {
          return {
            type: 'error',
            content: ((eventData.message ?? eventData.error) as string) ?? 'An error occurred',
            metadata: {
              errorCode: (eventData.code as string) || undefined,
              severity: ((eventData.severity as 'warning' | 'error') || 'error') as
                | 'warning'
                | 'error',
              traceIds: event.id ? [event.id] : undefined,
            },
          };
        }
        if (event.type === 'status_update') {
          if (!showActivityUpdates) {
            return null;
          }
          return {
            type: 'status_update',
            text: ((eventData.text ?? event.text) as string) ?? '',
            operation: ((eventData.operation ?? event.operation) as string) || undefined,
          };
        }
        if (event.type === 'status_clear') {
          if (!showActivityUpdates) {
            return null;
          }
          return {
            type: 'status_clear',
          };
        }
        return null;
      }

      case 'auth_challenge':
        return {
          type: 'auth_challenge',
          code: typeof msg.code === 'string' ? (msg.code as 'AUTH_JIT_REQUIRED') : undefined,
          sessionId: (msg.sessionId as string) ?? '',
          toolCallId: (msg.toolCallId as string) ?? '',
          authType: (msg.authType as string) ?? '',
          authUrl: (msg.authUrl as string) || undefined,
          profileId: (msg.profileId as string) ?? '',
          profileName: (msg.profileName as string) ?? '',
          prompt: (msg.prompt as string) ?? '',
          timeoutMs: (msg.timeoutMs as number) ?? 30000,
        };

      case 'status_update':
        if (!showActivityUpdates) {
          return null;
        }
        return {
          type: 'status_update',
          text: (msg.text as string) ?? '',
          operation: (msg.operation as string) || undefined,
        };

      case 'status_clear':
        if (!showActivityUpdates) {
          return null;
        }
        return {
          type: 'status_clear',
        };

      case 'tool_warnings':
        return {
          type: 'tool_warnings',
          sessionId: (msg.sessionId as string) || undefined,
          warnings: Array.isArray(msg.warnings) ? (msg.warnings as string[]) : [],
        };

      case 'session_health':
        return {
          type: 'session_health',
          sessionId: (msg.sessionId as string) || undefined,
          health: Array.isArray(msg.health) ? (msg.health as SessionHealthDiagnostic[]) : [],
        };

      case 'auth_required':
        return {
          type: 'auth_required',
          code: typeof msg.code === 'string' ? (msg.code as 'AUTH_PREFLIGHT_REQUIRED') : undefined,
          sessionId: (msg.sessionId as string) ?? '',
          pending: Array.isArray(msg.pending) ? (msg.pending as PreflightAuthRequirement[]) : [],
          satisfied: Array.isArray(msg.satisfied)
            ? (msg.satisfied as PreflightAuthRequirement[])
            : [],
        };

      case 'message_queued':
        return {
          type: 'message_queued',
          code: typeof msg.code === 'string' ? (msg.code as 'AUTH_PREFLIGHT_REQUIRED') : undefined,
          sessionId: (msg.sessionId as string) || undefined,
          reason: (msg.reason as string) ?? 'queued',
        };

      // Feedback capture (ABLP-1068).
      case 'feedback.ack': {
        const error = msg.error as { code?: unknown; message?: unknown } | undefined;
        const errorPayload =
          error && typeof error.code === 'string' && typeof error.message === 'string'
            ? { code: error.code, message: error.message }
            : undefined;
        return {
          type: 'feedback.ack',
          messageId: (msg.messageId as string) ?? '',
          success: msg.success === true,
          ...(typeof msg.feedbackId === 'string' ? { feedbackId: msg.feedbackId } : {}),
          ...(typeof msg.actionRenderId === 'string' ? { actionRenderId: msg.actionRenderId } : {}),
          ...(errorPayload ? { error: errorPayload } : {}),
        };
      }

      default:
        // Unknown message types are silently ignored
        return null;
    }
  }
}
