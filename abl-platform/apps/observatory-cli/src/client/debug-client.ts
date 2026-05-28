/**
 * Debug Client
 *
 * WebSocket client for connecting to the Debug Server
 */

import WebSocket from 'ws';
import {
  DebugCommand,
  DebugEvent,
  DebugSession,
  Breakpoint,
  BreakpointSpec,
  BreakpointContext,
  AgentStackFrame,
  serializeDebugEvent,
} from '@agent-platform/observatory';
import { EventEmitter } from 'events';

export interface DebugClientConfig {
  host: string;
  port: number;
  token?: string;
}

export interface DebugClientEvents {
  connected: (version: string, capabilities: string[]) => void;
  disconnected: () => void;
  error: (error: string) => void;
  sessions: (sessions: DebugSession[]) => void;
  attached: (session: DebugSession) => void;
  detached: (sessionId: string) => void;
  session_created: (session: DebugSession) => void;
  session_ended: (sessionId: string, reason: string) => void;
  breakpoint_hit: (breakpoint: Breakpoint, context: BreakpointContext) => void;
  paused: (reason: string, context: BreakpointContext) => void;
  resumed: () => void;
  trace: (event: any) => void;
  state: (data: Record<string, unknown>, sessionState: string) => void;
  stack: (frames: AgentStackFrame[]) => void;
  breaks: (breakpoints: Breakpoint[]) => void;
  explain: (eventId: string, explanation: string, relatedEvents: string[]) => void;
  evaluate_result: (expr: string, result: unknown, error?: string) => void;
}

/**
 * WebSocket client for debug server
 */
export class DebugClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: DebugClientConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(config: DebugClientConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to the debug server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.config.host}:${this.config.port}`;

      try {
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          this.reconnectAttempts = 0;
          // Send connect command with auth
          this.sendCommand({
            cmd: 'connect',
            auth: this.config.token,
          });
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.ws = null;
          this.emit('disconnected');
        });

        this.ws.on('error', (err) => {
          reject(err);
        });

        // Wait for connected event
        this.once('connected', () => resolve());
        this.once('error', (err) => reject(new Error(err)));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the debug server
   */
  disconnect(): void {
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

  // ============================================
  // Commands
  // ============================================

  /**
   * Get list of sessions
   */
  sessions(): void {
    this.sendCommand({ cmd: 'sessions' });
  }

  /**
   * Attach to a session
   */
  attach(sessionId: string): void {
    this.sendCommand({ cmd: 'attach', sessionId });
  }

  /**
   * Detach from current session
   */
  detach(): void {
    this.sendCommand({ cmd: 'detach' });
  }

  /**
   * Add a breakpoint
   */
  addBreakpoint(spec: BreakpointSpec): void {
    this.sendCommand({ cmd: 'break', spec });
  }

  /**
   * Remove a breakpoint
   */
  removeBreakpoint(id: string): void {
    this.sendCommand({ cmd: 'unbreak', id });
  }

  /**
   * List all breakpoints
   */
  listBreakpoints(): void {
    this.sendCommand({ cmd: 'breaks' });
  }

  /**
   * Pause execution
   */
  pause(): void {
    this.sendCommand({ cmd: 'pause' });
  }

  /**
   * Resume execution
   */
  resume(): void {
    this.sendCommand({ cmd: 'resume' });
  }

  /**
   * Step execution
   */
  step(type?: 'over' | 'into' | 'out'): void {
    this.sendCommand({ cmd: 'step', type });
  }

  /**
   * Get current state
   */
  getState(path?: string): void {
    this.sendCommand({ cmd: 'state', path });
  }

  /**
   * Get trace events
   */
  getTrace(limit?: number): void {
    this.sendCommand({ cmd: 'trace', limit });
  }

  /**
   * Get call stack
   */
  getStack(): void {
    this.sendCommand({ cmd: 'stack' });
  }

  /**
   * Explain an event
   */
  explain(eventId?: string): void {
    this.sendCommand({ cmd: 'explain', eventId });
  }

  /**
   * Evaluate an expression
   */
  evaluate(expr: string): void {
    this.sendCommand({ cmd: 'evaluate', expr });
  }

  /**
   * Enable/disable follow mode
   */
  follow(enabled: boolean): void {
    this.sendCommand({ cmd: 'follow', enabled });
  }

  // ============================================
  // Internal
  // ============================================

  private sendCommand(command: DebugCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit('error', 'Not connected');
      return;
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleMessage(data: string): void {
    try {
      const event = JSON.parse(data) as DebugEvent;

      switch (event.type) {
        case 'connected':
          this.emit('connected', event.version, event.capabilities);
          break;
        case 'sessions':
          this.emit('sessions', event.list);
          break;
        case 'attached':
          this.emit('attached', event.session);
          break;
        case 'detached':
          this.emit('detached', event.sessionId);
          break;
        case 'session_created':
          this.emit('session_created', event.session);
          break;
        case 'session_ended':
          this.emit('session_ended', event.sessionId, event.reason);
          break;
        case 'breakpoint_hit':
          this.emit('breakpoint_hit', event.breakpoint, event.context);
          break;
        case 'paused':
          this.emit('paused', event.reason, event.context);
          break;
        case 'resumed':
          this.emit('resumed');
          break;
        case 'trace':
          this.emit('trace', event.event);
          break;
        case 'state':
          this.emit('state', event.data, event.sessionState);
          break;
        case 'stack':
          this.emit('stack', event.frames);
          break;
        case 'breaks':
          this.emit('breaks', event.breakpoints);
          break;
        case 'explain':
          this.emit('explain', event.eventId, event.explanation, event.relatedEvents);
          break;
        case 'evaluate_result':
          this.emit('evaluate_result', event.expr, event.result, event.error);
          break;
        case 'error':
          this.emit('error', event.message);
          break;
      }
    } catch (err) {
      this.emit('error', `Failed to parse message: ${err}`);
    }
  }
}
