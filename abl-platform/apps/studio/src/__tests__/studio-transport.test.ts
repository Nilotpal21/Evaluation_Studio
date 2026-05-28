/**
 * Studio Transport Tests
 *
 * Tests the useStudioTransport hook's message translation and filtering logic.
 * Since useStudioTransport is a React hook, we test the pure translation function
 * indirectly via the hook's behavior, and the pure translateMessage function directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import type { ServerMessage } from '../types';
import type { TransportServerMessage } from '@agent-platform/web-sdk';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSendMessage = vi.fn();
const mockSend = vi.fn();
const mockSubscribeChatMessage = vi.fn();
let mockIsConnected = true;

vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    sendMessage: mockSendMessage,
    send: mockSend,
    isConnected: mockIsConnected,
    subscribeChatMessage: mockSubscribeChatMessage,
  }),
}));

let mockSessionId: string | null = 'session-1';
vi.mock('../store/session-store', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ sessionId: mockSessionId }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

// We need a minimal import. Since the hook requires React context,
// we'll test the transport contract behavior.
import { useStudioTransport } from '../adapters/useStudioTransport';

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('useStudioTransport', () => {
  let chatMessageHandler: ((msg: ServerMessage) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected = true;
    mockSessionId = 'session-1';
    chatMessageHandler = null;

    // Capture the handler passed to subscribeChatMessage
    mockSubscribeChatMessage.mockImplementation((handler: (msg: ServerMessage) => void) => {
      chatMessageHandler = handler;
      return () => {
        chatMessageHandler = null;
      };
    });
  });

  it('returns a valid SDKTransport object', () => {
    const { result } = renderHook(() => useStudioTransport());

    const transport = result.current;
    expect(transport.connect).toBeInstanceOf(Function);
    expect(transport.disconnect).toBeInstanceOf(Function);
    expect(transport.isConnected).toBeInstanceOf(Function);
    expect(transport.send).toBeInstanceOf(Function);
    expect(transport.on).toBeInstanceOf(Function);
    expect(transport.getSessionId).toBeInstanceOf(Function);
    expect(transport.capabilities).toBeDefined();
  });

  it('reports correct capabilities', () => {
    const { result } = renderHook(() => useStudioTransport());

    expect(result.current.capabilities).toEqual({
      supportsThoughts: true,
      supportsHandoff: true,
      supportsFileUpload: true,
      supportsVoice: false,
    });
  });

  it('connect resolves immediately', async () => {
    const { result } = renderHook(() => useStudioTransport());
    await expect(result.current.connect()).resolves.toBeUndefined();
  });

  it('disconnect is a no-op', () => {
    const { result } = renderHook(() => useStudioTransport());
    expect(() => result.current.disconnect()).not.toThrow();
  });

  it('getSessionId returns current session ID', () => {
    const { result } = renderHook(() => useStudioTransport());
    expect(result.current.getSessionId()).toBe('session-1');
  });

  it('isConnected delegates to WebSocketContext', () => {
    const { result } = renderHook(() => useStudioTransport());
    expect(result.current.isConnected()).toBe(true);
  });

  it('subscribes to chat messages via subscribeChatMessage', () => {
    renderHook(() => useStudioTransport());
    expect(mockSubscribeChatMessage).toHaveBeenCalledTimes(1);
    expect(chatMessageHandler).toBeInstanceOf(Function);
  });

  describe('lifecycle bridging', () => {
    it('emits disconnected and connected on websocket state transitions', () => {
      const { result, rerender } = renderHook(() => useStudioTransport());
      const connectedHandler = vi.fn();
      const disconnectedHandler = vi.fn();

      act(() => {
        result.current.on('connected', connectedHandler);
        result.current.on('disconnected', disconnectedHandler);
      });

      expect(connectedHandler).not.toHaveBeenCalled();
      expect(disconnectedHandler).not.toHaveBeenCalled();

      mockIsConnected = false;
      act(() => {
        rerender();
      });

      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
      expect(disconnectedHandler).toHaveBeenLastCalledWith(undefined);
      expect(connectedHandler).not.toHaveBeenCalled();

      act(() => {
        rerender();
      });

      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
      expect(connectedHandler).not.toHaveBeenCalled();

      mockIsConnected = true;
      act(() => {
        rerender();
      });

      expect(connectedHandler).toHaveBeenCalledTimes(1);
      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
    });

    it('emits only connected on session switches while the websocket stays connected', () => {
      const { result, rerender } = renderHook(() => useStudioTransport());
      const connectedHandler = vi.fn();
      const disconnectedHandler = vi.fn();

      act(() => {
        result.current.on('connected', connectedHandler);
        result.current.on('disconnected', disconnectedHandler);
      });

      mockSessionId = 'session-2';
      act(() => {
        rerender();
      });

      expect(disconnectedHandler).not.toHaveBeenCalled();
      expect(connectedHandler).toHaveBeenCalledTimes(1);
    });

    it('prefers the real websocket disconnect when session and connection change together', () => {
      const { result, rerender } = renderHook(() => useStudioTransport());
      const connectedHandler = vi.fn();
      const disconnectedHandler = vi.fn();

      act(() => {
        result.current.on('connected', connectedHandler);
        result.current.on('disconnected', disconnectedHandler);
      });

      mockSessionId = 'session-2';
      mockIsConnected = false;
      act(() => {
        rerender();
      });

      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
      expect(disconnectedHandler).toHaveBeenLastCalledWith(undefined);
      expect(connectedHandler).not.toHaveBeenCalled();
    });

    it('does not emit connected when the active session is cleared', () => {
      const { result, rerender } = renderHook(() => useStudioTransport());
      const connectedHandler = vi.fn();
      const disconnectedHandler = vi.fn();

      act(() => {
        result.current.on('connected', connectedHandler);
        result.current.on('disconnected', disconnectedHandler);
      });

      mockSessionId = null;
      act(() => {
        rerender();
      });

      expect(disconnectedHandler).toHaveBeenCalledTimes(1);
      expect(disconnectedHandler).toHaveBeenLastCalledWith('session_switch');
      expect(connectedHandler).not.toHaveBeenCalled();
    });
  });

  describe('message translation', () => {
    it('translates response_start to TransportServerMessage', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-1',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'response_start',
        messageId: 'msg-1',
      });
    });

    it('translates response_chunk with chunk→content mapping', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-1',
          chunk: 'Hello ',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'response_chunk',
        content: 'Hello ',
        messageId: 'msg-1',
      });
    });

    it('translates response_end with fullText→content mapping and localization', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];
      const localization = {
        locale: 'en-US',
        source: 'template',
        bundleId: 'support-responses',
      };

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: 'Hello world!',
          voiceConfig: { plain_text: 'Hello world for voice' },
          localization,
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'response_end',
        messageId: 'msg-1',
        content: 'Hello world!',
        voiceConfig: { plain_text: 'Hello world for voice' },
        localization,
      });
    });

    it('forwards response_end provenance metadata', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: 'Hello world!',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'response_end',
        messageId: 'msg-1',
        content: 'Hello world!',
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      });
    });

    it('translates top-level error messages to SDK errors', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'error',
          message: 'Runtime request timed out',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'error',
        content: 'Runtime request timed out',
        metadata: {
          errorCode: 'runtime_error',
          severity: 'error',
        },
      });
    });

    it('translates trace_event tool_thought to SDK thought', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'trace_event',
          sessionId: 'session-1',
          event: {
            id: 'trace-1',
            sessionId: 'session-1',
            type: 'tool_thought',
            timestamp: new Date(),
            data: {
              thought: 'I should search the database',
              toolName: 'search_db',
              agentName: 'helper',
            },
          },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'thought',
        content: 'I should search the database',
        metadata: {
          toolName: 'search_db',
          agentName: 'helper',
          traceIds: ['trace-1'],
        },
      });
    });

    it('translates auth_challenge messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'auth_challenge',
          code: 'AUTH_JIT_REQUIRED',
          sessionId: 'session-1',
          toolCallId: 'tc-1',
          authType: 'oauth2',
          authUrl: 'https://example.com/oauth',
          profileId: 'p-1',
          profileName: 'Google',
          prompt: 'Please authorize',
          timeoutMs: 60000,
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'auth_challenge',
        code: 'AUTH_JIT_REQUIRED',
        toolCallId: 'tc-1',
        authType: 'oauth2',
        profileName: 'Google',
      });
    });

    it('translates status_update messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'status_update',
          sessionId: 'session-1',
          text: 'Searching...',
          operation: 'search',
          transient: true,
          index: 0,
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'status_update',
        text: 'Searching...',
        operation: 'search',
      });
    });

    it('translates status_clear messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'status_clear',
          sessionId: 'session-1',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: 'status_clear' });
    });

    it('translates tool_warnings messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'tool_warnings',
          sessionId: 'session-1',
          warnings: ['Calendar credentials missing'],
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'tool_warnings',
        sessionId: 'session-1',
        warnings: ['Calendar credentials missing'],
      });
    });

    it('translates session_health messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'session_health',
          sessionId: 'session-1',
          health: [
            {
              category: 'llm',
              severity: 'error',
              code: 'MODEL_MISSING',
              message: 'No model available',
            },
          ],
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'session_health',
        sessionId: 'session-1',
        health: [
          {
            category: 'llm',
            severity: 'error',
            code: 'MODEL_MISSING',
            message: 'No model available',
          },
        ],
      });
    });

    it('translates auth_required messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'auth_required',
          code: 'AUTH_PREFLIGHT_REQUIRED',
          sessionId: 'session-1',
          pending: [
            {
              connector: 'google',
              authProfileRef: 'google_auth',
              connectionMode: 'per_user',
            },
          ],
          satisfied: [],
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'auth_required',
        code: 'AUTH_PREFLIGHT_REQUIRED',
        sessionId: 'session-1',
        pending: [
          {
            connector: 'google',
            authProfileRef: 'google_auth',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      });
    });

    it('translates message_queued messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'message_queued',
          code: 'AUTH_PREFLIGHT_REQUIRED',
          sessionId: 'session-1',
          reason: 'auth_gate_active',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'message_queued',
        code: 'AUTH_PREFLIGHT_REQUIRED',
        sessionId: 'session-1',
        reason: 'auth_gate_active',
      });
    });
  });

  describe('message filtering', () => {
    it('filters out state_update messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'state_update',
          sessionId: 'session-1',
          state: {} as any,
          updates: {},
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('filters out action_taken messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'action_taken',
          sessionId: 'session-1',
          action: {} as any,
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('filters out context_injected messages', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'context_injected',
          sessionId: 'session-1',
          updatedValues: {},
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('filters out dsl_collect trace events', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'trace_event',
          sessionId: 'session-1',
          event: {
            id: 'trace-1',
            sessionId: 'session-1',
            type: 'dsl_collect',
            timestamp: new Date(),
            data: {},
          },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('ignores trace_event errors when the turn later succeeds', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'trace_event',
          sessionId: 'session-1',
          event: {
            id: 'trace-error-1',
            sessionId: 'session-1',
            type: 'error',
            timestamp: new Date(),
            data: {
              message: 'First tool attempt failed',
              code: 'TOOL_FAILURE',
            },
          },
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: 'Tool execution succeeded after retry.',
        } as ServerMessage);
      });

      expect(messages).toEqual([
        {
          type: 'response_end',
          messageId: 'msg-1',
          content: 'Tool execution succeeded after retry.',
        },
      ]);
    });
  });

  describe('transfer_active suppression', () => {
    it('suppresses response_end entirely when transfer_active and no chunks buffered', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-transfer-1',
          fullText: '',
          actions: [{ type: 'transfer_active' }],
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('suppresses response_end when transfer_active and only whitespace was buffered', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-1',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-1',
          chunk: '   ',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: '   ',
          actions: [{ type: 'transfer_active' }],
        } as ServerMessage);
      });

      // response_start and response_chunk are always forwarded, but no response_end
      // should be dispatched when the buffer holds only whitespace.
      expect(messages.some((m) => m.type === 'response_end')).toBe(false);
    });

    it('synthesizes clean response_end from buffered chunks when transfer_active', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-1',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-1',
          chunk: 'Connecting you to ',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-1',
          chunk: 'a human agent.',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: 'Connecting you to a human agent.',
          actions: [{ type: 'transfer_active' }],
        } as ServerMessage);
      });

      // response_start forwarded, then one synthetic response_end from buffered content
      const responseEnd = messages.find((m) => m.type === 'response_end');
      expect(responseEnd).toMatchObject({
        type: 'response_end',
        messageId: 'msg-1',
        content: 'Connecting you to a human agent.',
      });
      // transfer_active action must NOT be forwarded to SDK
      expect((responseEnd as Record<string, unknown>)?.actions).toBeUndefined();
    });

    it('forwards rich fields from original response_end in synthetic transfer response', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-1',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-1',
          chunk: 'Escalating.',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-1',
          fullText: 'Escalating.',
          actions: [{ type: 'transfer_active' }],
          metadata: { isLlmGenerated: true },
        } as ServerMessage);
      });

      const responseEnd = messages.find((m) => m.type === 'response_end');
      expect(responseEnd).toMatchObject({
        type: 'response_end',
        content: 'Escalating.',
        metadata: { isLlmGenerated: true },
      });
    });

    it('does not suppress normal response_end after a transfer turn', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      // Transfer turn — suppressed
      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-transfer',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_chunk',
          sessionId: 'session-1',
          messageId: 'msg-transfer',
          chunk: 'Transferring.',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-transfer',
          fullText: 'Transferring.',
          actions: [{ type: 'transfer_active' }],
        } as ServerMessage);
      });

      // Normal subsequent turn
      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-2',
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'response_end',
          sessionId: 'session-1',
          messageId: 'msg-2',
          fullText: 'Back with AI.',
        } as ServerMessage);
      });

      const responseEnds = messages.filter((m) => m.type === 'response_end');
      // First: synthetic from transfer turn. Second: normal AI response.
      expect(responseEnds).toHaveLength(2);
      expect(responseEnds[1]).toMatchObject({ content: 'Back with AI.' });
    });
  });

  describe('agent transfer message extraction', () => {
    it('extracts agent:message content from the message field', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: { message: 'Hello from agent' } },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'response_end', content: 'Hello from agent' });
    });

    it('falls back to text field when message is absent', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: { text: 'Template text content' } },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'response_end', content: 'Template text content' });
    });

    it('falls back to body field when message and text are absent', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: { body: 'Body field content' } },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'response_end', content: 'Body field content' });
    });

    it('suppresses agent:message when all content fields are empty', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: {} },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('suppresses agent:message when provider content fields are not strings', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: {
            type: 'agent:message',
            data: {
              message: { text: 'nested provider payload' },
              text: ['array payload'],
            },
          },
        } as unknown as ServerMessage);
      });

      expect(messages).toHaveLength(0);
    });

    it('assigns unique ids to agent messages delivered in the same millisecond', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];
      const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_770_000_000_000);

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: { message: 'First' } },
        } as ServerMessage);
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:message', data: { message: 'Second' } },
        } as ServerMessage);
      });

      dateSpy.mockRestore();

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('response_end');
      expect(messages[1].type).toBe('response_end');
      expect(messages[0].messageId).not.toBe(messages[1].messageId);
    });

    it('translates agent:disconnected to response_end with disconnect message', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      act(() => {
        result.current.on('message', (msg) => messages.push(msg));
      });

      act(() => {
        chatMessageHandler?.({
          type: 'agent_transfer_event',
          sessionId: 'session-1',
          event: { type: 'agent:disconnected', data: {} },
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'response_end',
        content: 'Human agent has disconnected. You are now back with the AI assistant.',
      });
    });
  });

  describe('send delegation', () => {
    it('delegates chat_message to sendMessage with the SDK message id', () => {
      const { result } = renderHook(() => useStudioTransport());

      act(() => {
        result.current.send({
          type: 'chat_message',
          text: 'Hello',
          messageId: 'sdk-msg-1',
          attachmentIds: ['att-1'],
        });
      });

      expect(mockSendMessage).toHaveBeenCalledWith('Hello', {
        attachmentIds: ['att-1'],
        messageId: 'sdk-msg-1',
      });
    });

    it('delegates auth_response to send', () => {
      const { result } = renderHook(() => useStudioTransport());

      act(() => {
        result.current.send({
          type: 'auth_response',
          toolCallId: 'tc-1',
          status: 'completed',
        });
      });

      expect(mockSend).toHaveBeenCalledWith({
        type: 'auth_response',
        toolCallId: 'tc-1',
        status: 'completed',
      });
    });

    it('delegates action_submit as a real websocket action event with the full action envelope', () => {
      const { result } = renderHook(() => useStudioTransport());

      act(() => {
        result.current.send({
          type: 'action_submit',
          actionId: 'agent_a',
          value: 'agent_a',
          formData: { choice: 'agent_a', confidence: 0.92 },
          renderId: 'render-123',
        });
      });

      expect(mockSend).toHaveBeenCalledWith({
        type: 'action_submit',
        sessionId: 'session-1',
        actionId: 'agent_a',
        value: 'agent_a',
        formData: { choice: 'agent_a', confidence: 0.92 },
        renderId: 'render-123',
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('event subscription', () => {
    it('on() returns an unsubscribe function', () => {
      const { result } = renderHook(() => useStudioTransport());
      const messages: TransportServerMessage[] = [];

      let unsub: () => void;
      act(() => {
        unsub = result.current.on('message', (msg) => messages.push(msg));
      });

      // Should receive message
      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-1',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);

      // Unsubscribe and verify no more messages
      act(() => {
        unsub!();
      });

      act(() => {
        chatMessageHandler?.({
          type: 'response_start',
          sessionId: 'session-1',
          messageId: 'msg-2',
        } as ServerMessage);
      });

      expect(messages).toHaveLength(1);
    });
  });
});
