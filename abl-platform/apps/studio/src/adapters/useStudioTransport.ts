/**
 * useStudioTransport — React hook that bridges WebSocketContext to SDKTransport.
 *
 * Provides an SDKTransport instance backed by Studio's existing WebSocket connection.
 * Used by StudioChatPanel to feed SDK components via AgentProvider's transport prop (Path B).
 *
 * Key behavior:
 * - connect() resolves immediately (WebSocketContext manages the WS lifecycle)
 * - disconnect() is a no-op
 * - Subscribes to chat-relevant messages via subscribeChatMessage()
 * - Translates Studio ServerMessage to TransportServerMessage
 * - Filters OUT Studio-only message types (state_update, action_taken, dsl_collect, etc.)
 * - Keeps trace_event error diagnostics in Studio observability; terminal
 *   failures still arrive through response_end / top-level error messages
 * - Emits connected on session switch so SDK consumers pick up the new session ID
 * - Leaves transcript replacement to the authoritative Studio snapshot restore
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useWebSocketContext } from '../contexts/WebSocketContext';
import { useSessionStore } from '../store/session-store';
import type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
  RichContent,
  ActionSet,
  SourceChannel,
  VoiceConfig,
} from '@agent-platform/web-sdk';
import type { ServerMessage } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TransportEvent = 'message' | 'connected' | 'disconnected' | 'error';
type MessageHandler = (msg: TransportServerMessage) => void;
type ConnectedHandler = () => void;
type DisconnectedHandler = (reason?: string) => void;
type ErrorHandler = (error: TransportError) => void;

let agentTransferMessageSequence = 0;

function nextAgentTransferMessageId(prefix: string): string {
  agentTransferMessageSequence = (agentTransferMessageSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now()}-${agentTransferMessageSequence}`;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Translate Studio ServerMessage → TransportServerMessage
// Returns null for messages that should NOT be forwarded to the SDK ChatClient.
// ---------------------------------------------------------------------------

function translateMessage(msg: ServerMessage): TransportServerMessage | null {
  switch (msg.type) {
    case 'response_start':
      return { type: 'response_start', messageId: msg.messageId };

    case 'response_chunk':
      return { type: 'response_chunk', content: msg.chunk, messageId: msg.messageId };

    case 'response_end':
      return {
        type: 'response_end',
        messageId: msg.messageId,
        content: msg.fullText,
        ...(msg.voiceConfig ? { voiceConfig: msg.voiceConfig as VoiceConfig } : {}),
        ...(msg.richContent ? { richContent: msg.richContent as RichContent } : {}),
        ...(msg.actions ? { actions: msg.actions as ActionSet } : {}),
        ...(msg.localization ? { localization: msg.localization } : {}),
        ...(msg.sourceChannel ? { sourceChannel: msg.sourceChannel as SourceChannel } : {}),
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
        ...(msg.citations?.length ? { citations: msg.citations } : {}),
      };

    case 'trace_event': {
      // Only forward tool_thought events as SDK 'thought' messages
      if (
        msg.event.type === 'tool_thought' &&
        msg.event.data &&
        (msg.event.data.thought || msg.event.data.reasoning)
      ) {
        const content =
          (msg.event.data.thought as string) || (msg.event.data.reasoning as string) || '';
        return {
          type: 'thought',
          content,
          metadata: {
            toolName: msg.event.data.toolName as string | undefined,
            agentName:
              (msg.event.data.agentName as string) || (msg.event.data.agent as string) || undefined,
            traceIds: [msg.event.id],
          },
        };
      }

      // Forward handoff events
      if (msg.event.type === 'handoff' && msg.event.data) {
        const data = msg.event.data as { from?: string; to?: string };
        return {
          type: 'handoff',
          metadata: {
            handoffFrom: data.from,
            handoffTo: data.to,
            traceIds: [msg.event.id],
          },
        };
      }

      // Keep trace_event errors in observability only. Terminal user-visible
      // failures already arrive through response_end or top-level error
      // messages, so forwarding trace errors would leave stale SDK bubbles
      // behind when a retry later succeeds.
      //
      // All other trace_event subtypes (dsl_collect, entity_extraction,
      // step_thought, dsl_set, error, etc.) are Studio-only — do not forward.
      return null;
    }

    case 'error':
      return {
        type: 'error',
        content: msg.message,
        metadata: {
          errorCode: 'runtime_error',
          severity: 'error',
        },
      };

    case 'auth_challenge':
      return {
        type: 'auth_challenge',
        code: msg.code,
        sessionId: msg.sessionId,
        toolCallId: msg.toolCallId,
        authType: msg.authType,
        authUrl: msg.authUrl,
        profileId: msg.profileId,
        profileName: msg.profileName,
        prompt: msg.prompt,
        timeoutMs: msg.timeoutMs,
      };

    case 'status_update':
      return {
        type: 'status_update',
        text: msg.text,
        operation: msg.operation,
      };

    case 'status_clear':
      return { type: 'status_clear' };

    case 'tool_warnings':
      return {
        type: 'tool_warnings',
        sessionId: msg.sessionId,
        warnings: msg.warnings,
      };

    case 'session_health':
      return {
        type: 'session_health',
        sessionId: msg.sessionId,
        health: msg.health,
      };

    case 'auth_required':
      return {
        type: 'auth_required',
        code: msg.code,
        sessionId: msg.sessionId,
        pending: msg.pending,
        satisfied: msg.satisfied,
      };

    case 'message_queued':
      return {
        type: 'message_queued',
        code: msg.code,
        sessionId: msg.sessionId,
        reason: msg.reason,
      };

    case 'agent_transfer_event': {
      // Inbound message from human agent via webhook — render as assistant message
      const evt = msg.event as {
        type: string;
        data?: {
          message?: string;
          text?: string;
          body?: string;
          agentInfo?: Record<string, unknown>;
        };
      };
      if (evt.type === 'agent:message') {
        // Mirror the same field extraction order used by WebSocketContext so
        // template-style messages (text/body fields) reach the SDK ChatPanel too.
        const content = firstNonEmptyString(evt.data?.message, evt.data?.text, evt.data?.body);
        if (content) {
          return {
            type: 'response_end',
            messageId: nextAgentTransferMessageId('agent-transfer'),
            content,
          };
        }
      }
      if (evt.type === 'agent:disconnected') {
        return {
          type: 'response_end',
          messageId: nextAgentTransferMessageId('agent-transfer-disconnect'),
          content: 'Human agent has disconnected. You are now back with the AI assistant.',
        };
      }
      return null;
    }

    // Studio-only types — filter out, do not forward to SDK
    case 'agent_loaded':
    case 'agent_load_error':
    case 'state_update':
    case 'action_taken':
    case 'session_resumed':
    case 'session_expired':
    case 'info':
    case 'context_injected':
    case 'tool_mock_set':
    case 'context_injection_error':
    case 'auth_gate_updated':
    case 'auth_gate_satisfied':
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStudioTransport(): SDKTransport {
  const { sendMessage, send, isConnected, subscribeChatMessage } = useWebSocketContext();
  const sessionId = useSessionStore((s) => s.sessionId);

  // Stable listener sets — ref-based to avoid re-creating the transport object
  const messageListeners = useRef(new Set<MessageHandler>());
  const connectedListeners = useRef(new Set<ConnectedHandler>());
  const disconnectedListeners = useRef(new Set<DisconnectedHandler>());
  const errorListeners = useRef(new Set<ErrorHandler>());

  // Track previous transport identity for lifecycle detection
  const prevSessionIdRef = useRef<string | null>(sessionId);
  const prevIsConnectedRef = useRef(isConnected);

  const emitConnected = useCallback(() => {
    for (const handler of connectedListeners.current) {
      try {
        handler();
      } catch (err) {
        console.warn('[StudioTransport] connected listener error', err);
      }
    }
  }, []);

  const emitDisconnected = useCallback((reason?: string) => {
    for (const handler of disconnectedListeners.current) {
      try {
        handler(reason);
      } catch (err) {
        console.warn('[StudioTransport] disconnected listener error', err);
      }
    }
  }, []);

  // Bridge both session switches and real websocket connectivity changes into
  // the SDKTransport lifecycle contract without double-emitting when both move
  // in the same render. Session switches are no longer modeled as transport
  // disconnects because Studio now restores the authoritative transcript via
  // replaceTranscript(); emitting a synthetic disconnect would clear that
  // snapshot immediately after restore.
  useEffect(() => {
    const previousSessionId = prevSessionIdRef.current;
    const previousIsConnected = prevIsConnectedRef.current;
    const sessionChanged = previousSessionId !== sessionId;
    const connectionChanged = previousIsConnected !== isConnected;

    if (!sessionChanged && !connectionChanged) {
      return;
    }

    if (connectionChanged) {
      if (isConnected) {
        emitConnected();
      } else {
        emitDisconnected();
      }
    } else if (sessionChanged) {
      if (sessionId && isConnected) {
        emitConnected();
      } else if (!sessionId) {
        emitDisconnected('session_switch');
      }
    }

    prevSessionIdRef.current = sessionId;
    prevIsConnectedRef.current = isConnected;
  }, [emitConnected, emitDisconnected, isConnected, sessionId]);

  // Subscribe to chat messages from WebSocketContext
  useEffect(() => {
    // Buffer streamed chunks so that when a transfer_active response_end arrives,
    // we can finalize the SDK ChatClient with the actual streamed content. Without
    // this, the SDK ChatClient sees an empty response_end and emits the
    // "empty response" error message into the chat transcript.
    let chunkBuffer = '';

    const dispatchToListeners = (translated: TransportServerMessage) => {
      for (const handler of messageListeners.current) {
        try {
          handler(translated);
        } catch (err) {
          console.warn('[StudioTransport] message listener error', err);
        }
      }
    };

    const unsubscribe = subscribeChatMessage((msg: ServerMessage) => {
      if (msg.type === 'response_start') {
        chunkBuffer = '';
      } else if (msg.type === 'response_chunk') {
        chunkBuffer += msg.chunk;
      } else if (msg.type === 'response_end') {
        const rawActions = msg.actions as unknown;
        const isTransferActive =
          Array.isArray(rawActions) &&
          (rawActions as Array<{ type?: string }>).some((a) => a.type === 'transfer_active');

        if (isTransferActive) {
          const buffered = chunkBuffer;
          chunkBuffer = '';
          if (buffered.trim()) {
            // Finalize the SDK ChatClient with the escalation message streamed before transfer.
            // Forward all non-action fields from the original response_end so rich content,
            // voice config, source channel and metadata are not silently dropped.
            dispatchToListeners({
              type: 'response_end',
              messageId: msg.messageId,
              content: buffered,
              ...(msg.voiceConfig ? { voiceConfig: msg.voiceConfig as VoiceConfig } : {}),
              ...(msg.richContent ? { richContent: msg.richContent as RichContent } : {}),
              ...(msg.sourceChannel ? { sourceChannel: msg.sourceChannel as SourceChannel } : {}),
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(msg.citations?.length ? { citations: msg.citations } : {}),
            });
          }
          // Suppress the transfer_active signal entirely — it is a control marker,
          // not a bot response. If no chunks were buffered (SDK was never streaming),
          // there is nothing to finalize and no message should appear.
          return;
        }

        chunkBuffer = '';
      }

      const translated = translateMessage(msg);
      if (translated) {
        dispatchToListeners(translated);
      }
    });
    return unsubscribe;
  }, [emitConnected, emitDisconnected, subscribeChatMessage]);

  // Keep a stable ref for sendMessage and send
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const sendRef = useRef(send);
  sendRef.current = send;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;

  const capabilities: TransportCapabilities = useMemo(
    () => ({
      supportsThoughts: true,
      supportsHandoff: true,
      supportsFileUpload: true,
      supportsVoice: false,
    }),
    [],
  );

  const transport: SDKTransport = useMemo(() => {
    const on: SDKTransport['on'] = ((
      event: TransportEvent,
      handler: MessageHandler | ConnectedHandler | DisconnectedHandler | ErrorHandler,
    ) => {
      switch (event) {
        case 'message':
          messageListeners.current.add(handler as MessageHandler);
          return () => {
            messageListeners.current.delete(handler as MessageHandler);
          };
        case 'connected':
          connectedListeners.current.add(handler as ConnectedHandler);
          return () => {
            connectedListeners.current.delete(handler as ConnectedHandler);
          };
        case 'disconnected':
          disconnectedListeners.current.add(handler as DisconnectedHandler);
          return () => {
            disconnectedListeners.current.delete(handler as DisconnectedHandler);
          };
        case 'error':
          errorListeners.current.add(handler as ErrorHandler);
          return () => {
            errorListeners.current.delete(handler as ErrorHandler);
          };
        default:
          return () => {};
      }
    }) as SDKTransport['on'];

    return {
      connect: async () => {
        // WebSocketContext manages the connection lifecycle — resolve immediately
      },
      disconnect: () => {
        // No-op — WebSocketContext manages the connection lifecycle
      },
      isConnected: () => isConnectedRef.current,
      send: (message: TransportClientMessage) => {
        switch (message.type) {
          case 'chat_message': {
            const currentSessionId = sessionIdRef.current;
            if (!currentSessionId) return;
            sendMessageRef.current(message.text, {
              attachmentIds: message.attachmentIds,
              ...(message.messageId ? { messageId: message.messageId } : {}),
            });
            break;
          }
          case 'action_submit': {
            const actionSessionId = sessionIdRef.current;
            if (!actionSessionId) return;
            sendRef.current({
              type: 'action_submit',
              sessionId: actionSessionId,
              actionId: message.actionId,
              ...(message.value !== undefined ? { value: message.value } : {}),
              ...(message.formData !== undefined ? { formData: message.formData } : {}),
              ...(message.renderId !== undefined ? { renderId: message.renderId } : {}),
            });
            break;
          }
          case 'auth_response':
            sendRef.current({
              type: 'auth_response',
              toolCallId: message.toolCallId,
              status: message.status,
            });
            break;
          case 'typed_interrupt':
            sendRef.current({
              type: 'send_message',
              sessionId: message.sessionId,
              text: message.text,
              messageId: message.messageId,
            });
            break;
        }
      },
      on,
      getSessionId: () => sessionIdRef.current,
      capabilities,
    };
  }, [capabilities]);

  return transport;
}
