/**
 * Transport Layer Types
 *
 * Defines the SDKTransport interface and typed message unions for
 * transport-agnostic chat communication.
 */

import type {
  RichContent,
  ActionSet,
  ActionSubmitOptions,
  SourceChannel,
  VoiceConfig,
  SessionHealthDiagnostic,
  PreflightAuthRequirement,
  MessageContentEnvelope,
} from '../core/types.js';

import type { MessageMetadata } from '../core/types.js';

// ---------------------------------------------------------------------------
// Transport Interface
// ---------------------------------------------------------------------------

export interface SDKTransport {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  send(message: TransportClientMessage): void;
  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  getSessionId(): string | null;
  getActiveLiveSessionId?(): string | null;
  capabilities: TransportCapabilities;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface TransportCapabilities {
  supportsThoughts: boolean;
  supportsHandoff: boolean;
  supportsFileUpload: boolean;
  supportsVoice: boolean;
}

// ---------------------------------------------------------------------------
// Client Messages (SDK -> Server)
// ---------------------------------------------------------------------------

export type TransportClientMessage =
  | {
      type: 'chat_message';
      text: string;
      messageId?: string;
      sessionId?: string;
      attachmentIds?: string[];
      metadata?: Record<string, unknown>;
    }
  | ({ type: 'action_submit'; actionId: string } & ActionSubmitOptions)
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' }
  | { type: 'typed_interrupt'; text: string; messageId: string; sessionId: string }
  | { type: 'end_session'; sessionId?: string }
  // Feedback capture (ABLP-1068). Sent in response to thumbs / star / text
  // ratings on a persisted assistant message. The runtime acks via
  // `feedback.ack` below.
  | {
      type: 'feedback.submit';
      messageId: string;
      ratingType: 'thumbs' | 'star' | 'text';
      ratingValue: number;
      feedbackText?: string;
      actionRenderId?: string;
    };

// ---------------------------------------------------------------------------
// Server Messages (Server -> SDK)
// ---------------------------------------------------------------------------
// Omnichannel live-session events are delivered through SessionManager's raw
// WSServerMessage stream and stay intentionally outside this transport union.

export type TransportServerMessage =
  | { type: 'response_start'; messageId: string }
  | { type: 'response_chunk'; content: string; messageId: string }
  | {
      type: 'response_end';
      messageId: string;
      content: string;
      voiceConfig?: VoiceConfig;
      richContent?: RichContent;
      actions?: ActionSet;
      contentEnvelope?: MessageContentEnvelope;
      localization?: Record<string, unknown>;
      sourceChannel?: SourceChannel;
      metadata?: MessageMetadata;
      citations?: Array<{
        index: number;
        title: string;
        url: string;
        sourceType: 'connector' | 'upload' | 'crawled';
        pageNumber?: number;
      }>;
    }
  | { type: 'thought'; content: string; metadata: MessageMetadata }
  | { type: 'handoff'; metadata: MessageMetadata }
  | { type: 'error'; content: string; metadata: MessageMetadata }
  | {
      type: 'auth_challenge';
      code?: 'AUTH_JIT_REQUIRED';
      sessionId: string;
      toolCallId: string;
      authType: string;
      authUrl?: string;
      profileId: string;
      profileName: string;
      prompt: string;
      timeoutMs: number;
    }
  | { type: 'status_update'; text: string; operation?: string }
  | { type: 'status_clear' }
  | { type: 'tool_warnings'; sessionId?: string; warnings: string[] }
  | { type: 'session_health'; sessionId?: string; health: SessionHealthDiagnostic[] }
  | {
      type: 'auth_required';
      code?: 'AUTH_PREFLIGHT_REQUIRED';
      sessionId: string;
      pending: PreflightAuthRequirement[];
      satisfied: PreflightAuthRequirement[];
    }
  | {
      type: 'message_queued';
      code?: 'AUTH_PREFLIGHT_REQUIRED';
      sessionId?: string;
      reason: string;
    }
  // Feedback ack (ABLP-1068). Server-side response to `feedback.submit` and
  // to `action_submit(actionId='feedback')`.
  | {
      type: 'feedback.ack';
      messageId: string;
      success: boolean;
      feedbackId?: string;
      actionRenderId?: string;
      error?: { code: string; message: string };
    };

// ---------------------------------------------------------------------------
// Transport Error
// ---------------------------------------------------------------------------

export interface TransportError {
  code: string;
  message: string;
  recoverable: boolean;
}
