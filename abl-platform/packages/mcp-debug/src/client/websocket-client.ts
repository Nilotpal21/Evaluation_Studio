/**
 * WebSocket Client for Test Server
 *
 * Connects to the test server WebSocket and handles message routing.
 */

import WebSocket from 'ws';
import type {
  ClientMessage,
  ServerMessage,
  TraceEventWithId,
  AgentState,
  AgentDetails,
  ConstructAction,
  SessionInfo,
} from '../types.js';
import { DEFAULT_WS_URL } from '../constants.js';
import { buildWebDebugWSProtocols } from '../utils/websocket-auth.js';
import { ARCH_MCP_LOG_PREFIX } from '../tools/persona.js';

export type MessageHandler = (message: ServerMessage) => void;

/** Default connection timeout (10 seconds) */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export interface ConnectionOptions {
  url?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  connectionTimeoutMs?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private reconnect: boolean;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private connectionTimeoutMs: number;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;

  // Event-specific callbacks
  public onTraceEvent?: (sessionId: string, event: TraceEventWithId) => void;
  public onStateUpdate?: (sessionId: string, state: AgentState) => void;
  public onAgentLoaded?: (sessionId: string, agent: AgentDetails) => void;
  public onAgentLoadError?: (error: string) => void;
  public onResponseStart?: (sessionId: string, messageId: string) => void;
  public onResponseChunk?: (sessionId: string, messageId: string, chunk: string) => void;
  public onResponseEnd?: (sessionId: string, messageId: string, fullText: string) => void;
  public onActionTaken?: (sessionId: string, action: ConstructAction) => void;
  public onError?: (message: string) => void;
  public onInfo?: (message: string, configured: boolean) => void;
  public onConnected?: () => void;
  public onDisconnected?: () => void;

  // Subscription-specific callbacks
  public onTraceReplay?: (
    sessionId: string,
    events: TraceEventWithId[],
    totalBuffered: number,
  ) => void;
  public onSubscribed?: (sessionId: string, eventCount: number) => void;
  public onUnsubscribed?: (sessionId: string) => void;
  public onSessionList?: (sessions: SessionInfo[]) => void;
  public onSessionEnded?: (sessionId: string) => void;
  public onSessionExpired?: (sessionId: string, reason: string) => void;

  private authToken: string | null = null;

  constructor(options: ConnectionOptions = {}) {
    this.url = options.url || DEFAULT_WS_URL || '';
    this.reconnect = options.reconnect ?? false;
    this.reconnectInterval = options.reconnectInterval ?? 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  /**
   * Set auth token for authenticated connections
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise; // Already connecting
    }

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      let settled = false;
      let connectionTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        fn();
      };

      try {
        if (!this.authToken?.trim()) {
          const error = new Error(
            'Internal runtime WebSocket connections require setAuthToken() before connect().',
          );
          this.onError?.(error.message);
          reject(error);
          return;
        }

        this.ws = new WebSocket(this.url, buildWebDebugWSProtocols(this.authToken));

        // Connection timeout — rejects + closes socket if open/error never fires
        connectionTimer = setTimeout(() => {
          settle(() => {
            this.isConnecting = false;
            const timeoutSec = Math.round(this.connectionTimeoutMs / 1000);
            const error = new Error(
              `WebSocket connection timed out after ${timeoutSec}s connecting to ${this.url}`,
            );
            error.name = 'ConnectionTimeoutError';
            if (this.ws) {
              this.ws.removeAllListeners();
              this.ws.close();
              this.ws = null;
            }
            this.onError?.(error.message);
            reject(error);
          });
        }, this.connectionTimeoutMs);

        this.ws.on('open', () => {
          settle(() => {
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.onConnected?.();
            resolve();
          });
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.isConnecting = false;
          this.onDisconnected?.();
          if (this.reconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
              this.connect().catch((err) => {
                console.error(
                  `${ARCH_MCP_LOG_PREFIX} Reconnect failed:`,
                  err instanceof Error ? err.message : err,
                );
              });
            }, this.reconnectInterval);
          }
        });

        this.ws.on('error', (error) => {
          settle(() => {
            this.isConnecting = false;
            this.onError?.(error.message);
            reject(error);
          });
        });
      } catch (error) {
        settle(() => {
          this.isConnecting = false;
          reject(error);
        });
      }
    });

    return this.connectionPromise;
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.reconnect = false; // Prevent auto-reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a message to the server
   */
  send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Load an agent
   */
  loadAgent(agentPath: string, projectId: string): void {
    this.send({ type: 'load_agent', agentPath, projectId });
  }

  /**
   * Send a message to the agent
   */
  sendMessage(sessionId: string, text: string): void {
    this.send({ type: 'send_message', sessionId, text });
  }

  /**
   * Get current state
   */
  getState(sessionId: string): void {
    this.send({ type: 'get_state', sessionId });
  }

  /**
   * Run a test
   */
  runTest(sessionId: string, testId: string): void {
    this.send({ type: 'run_test', sessionId, testId });
  }

  /**
   * Subscribe to a session's traces (for external observation)
   * Will receive trace_replay with buffered events, then live trace_event messages
   */
  subscribeSession(sessionId: string): void {
    this.send({ type: 'subscribe_session', sessionId });
  }

  /**
   * Unsubscribe from a session
   */
  unsubscribeSession(sessionId: string): void {
    this.send({ type: 'unsubscribe_session', sessionId });
  }

  /**
   * List all active sessions available for subscription
   */
  listSessions(): void {
    this.send({ type: 'list_sessions' });
  }

  /**
   * Add a generic message handler
   */
  addMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Remove a message handler
   */
  removeMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as ServerMessage;

      // Call generic handlers
      for (const handler of this.messageHandlers) {
        handler(message);
      }

      // Call specific handlers
      switch (message.type) {
        case 'trace_event':
          this.onTraceEvent?.(message.sessionId, message.event);
          break;
        case 'state_update':
          this.onStateUpdate?.(message.sessionId, message.state);
          break;
        case 'agent_loaded':
          this.onAgentLoaded?.(message.sessionId, message.agent);
          break;
        case 'agent_load_error':
          this.onAgentLoadError?.(message.error);
          break;
        case 'response_start':
          this.onResponseStart?.(message.sessionId, message.messageId);
          break;
        case 'response_chunk':
          this.onResponseChunk?.(message.sessionId, message.messageId, message.chunk);
          break;
        case 'response_end':
          this.onResponseEnd?.(message.sessionId, message.messageId, message.fullText);
          break;
        case 'action_taken':
          this.onActionTaken?.(message.sessionId, message.action);
          break;
        case 'error':
          this.onError?.(message.message);
          break;
        case 'info':
          this.onInfo?.(message.message, message.configured);
          break;
        // Subscription-related messages
        case 'trace_replay':
          this.onTraceReplay?.(message.sessionId, message.events, message.totalBuffered);
          break;
        case 'subscribed':
          this.onSubscribed?.(message.sessionId, message.eventCount);
          break;
        case 'unsubscribed':
          this.onUnsubscribed?.(message.sessionId);
          break;
        case 'session_list':
          this.onSessionList?.(message.sessions);
          break;
        case 'session_ended':
          this.onSessionEnded?.(message.sessionId);
          break;
        case 'session_expired':
          this.onSessionExpired?.(message.sessionId, message.reason);
          break;
      }
    } catch (error) {
      const message = `Failed to parse WebSocket message: ${error instanceof Error ? error.message : error}`;
      console.error(`${ARCH_MCP_LOG_PREFIX} ${message}`);
      this.onError?.(message);
    }
  }

  /**
   * Set WebSocket URL
   */
  setUrl(url: string): void {
    this.url = url;
  }

  /**
   * Get WebSocket URL
   */
  getUrl(): string {
    return this.url;
  }
}
