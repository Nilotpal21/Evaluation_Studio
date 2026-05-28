/**
 * Debug Server
 *
 * WebSocket server for remote debugging of Agent DSL execution.
 * Listens on a configurable port (default 9229) separate from the main server.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { ExtendedTraceEvent } from '../schema/trace-events.js';
import {
  DebugCommand,
  DebugEvent,
  DebugSession,
  Breakpoint,
  BreakpointContext,
  AgentStackFrame,
  parseDebugCommand,
  serializeDebugEvent,
  PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
} from './types.js';
import { BreakpointManager, EvaluationContext } from './breakpoints.js';
import { SessionManager } from './session-manager.js';

/**
 * Debug server configuration
 */
export interface DebugServerConfig {
  /** Port to listen on (default: 9229) */
  port?: number;

  /** Optional auth token for connecting */
  authToken?: string;

  /** Host to bind to (default: localhost) */
  host?: string;
}

/**
 * Connected client state
 */
interface ConnectedClient {
  ws: WebSocket;
  authenticated: boolean;
  attachedSessionId?: string;
  followMode: boolean;
}

/**
 * WebSocket Debug Server
 */
export class DebugServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, ConnectedClient> = new Map();
  private config: Required<DebugServerConfig>;

  private sessionManager = new SessionManager();
  private breakpointManager = new BreakpointManager();

  constructor(config: DebugServerConfig = {}) {
    this.config = {
      port: config.port ?? 9229,
      authToken: config.authToken ?? '',
      host: config.host ?? 'localhost',
    };

    // Subscribe to session events
    this.sessionManager.onEvent((sessionId, event) => {
      this.handleSessionEvent(sessionId, event);
    });
  }

  /**
   * Start the debug server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.config.port,
          host: this.config.host,
        });

        this.wss.on('connection', (ws) => this.handleConnection(ws));

        this.wss.on('listening', () => {
          console.log(`Debug server listening on ${this.config.host}:${this.config.port}`);
          resolve();
        });

        this.wss.on('error', (err) => {
          console.error('Debug server error:', err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the debug server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      // Close all client connections
      for (const [ws] of this.clients) {
        ws.close();
      }
      this.clients.clear();

      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }

  // ============================================
  // Runtime Integration Points
  // ============================================

  /**
   * Called by runtime when a new session is created
   */
  onSessionCreated(sessionId: string, name: string, initialAgent: string): void {
    this.sessionManager.registerSession(sessionId, name, initialAgent);
  }

  /**
   * Called by runtime when a session ends
   */
  onSessionDestroyed(sessionId: string): void {
    this.sessionManager.unregisterSession(sessionId);
  }

  /**
   * Called by runtime to emit a trace event
   */
  onTraceEvent(sessionId: string, event: ExtendedTraceEvent): void {
    // Update session state
    this.sessionManager.updateState(sessionId, {
      currentAgent: event.agentName,
    });

    // Broadcast to attached clients
    this.broadcastToSession(sessionId, {
      type: 'trace',
      event,
    });
  }

  /**
   * Called by runtime to update session state
   */
  onStateUpdate(sessionId: string, state: Record<string, unknown>): void {
    this.sessionManager.updateState(sessionId, { stateSnapshot: state });
  }

  /**
   * Called by runtime when entering an agent
   */
  onAgentEnter(
    sessionId: string,
    agentName: string,
    mode: 'scripted' | 'reasoning',
    trigger: 'routing' | 'handoff' | 'delegate' | 'initial',
  ): void {
    this.sessionManager.pushAgent(sessionId, agentName, mode, trigger);
  }

  /**
   * Called by runtime when exiting an agent
   */
  onAgentExit(sessionId: string): void {
    this.sessionManager.popAgent(sessionId);
  }

  /**
   * Called by runtime when entering a flow step
   */
  onStepEnter(sessionId: string, stepName: string): void {
    this.sessionManager.updateCurrentStep(sessionId, stepName);
  }

  /**
   * Check if execution should pause at a breakpoint
   * Returns context if should pause, null otherwise
   */
  checkBreakpoint(
    sessionId: string,
    event: ExtendedTraceEvent,
    state: Record<string, unknown>,
  ): BreakpointContext | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.debuggerAttached) return null;

    const callStack = this.sessionManager.getCallStack(sessionId);
    const topFrame = callStack[callStack.length - 1];

    const context: EvaluationContext = {
      sessionId,
      agentName: event.agentName,
      stepName: topFrame?.currentStep,
      traceEvent: event,
      state,
      callStack,
    };

    const bpContext = this.breakpointManager.checkBreakpoints(context);

    // Also check if stepping
    const stepping = this.sessionManager.isStepping(sessionId);
    if (stepping.stepping) {
      const shouldStop = this.checkStepCondition(stepping.type, event, callStack);
      if (shouldStop) {
        this.sessionManager.markStepComplete(sessionId);
        // Create a synthetic breakpoint context for step
        return {
          breakpoint: {
            id: '__step__',
            spec: { type: 'event', eventType: event.type },
            enabled: true,
            hitCount: 0,
            createdAt: new Date(),
          },
          sessionId,
          agentName: event.agentName,
          stepName: topFrame?.currentStep,
          traceEvent: event,
          stateSnapshot: state,
          callStack,
        };
      }
    }

    return bpContext;
  }

  /**
   * Pause execution and wait for resume
   */
  async pauseExecution(sessionId: string, context: BreakpointContext): Promise<void> {
    // Notify clients
    this.broadcastToSession(sessionId, {
      type: 'breakpoint_hit',
      breakpoint: context.breakpoint,
      context,
    });

    // Wait for resume on the shared pause gate used by waitIfPaused().
    await this.sessionManager.pause(sessionId);
  }

  /**
   * Check if execution should wait (called by runtime in execution loop)
   */
  async waitIfPaused(sessionId: string): Promise<void> {
    // This must await the same pause gate as pauseExecution() so a later
    // execution-loop check cannot orphan the original breakpoint waiter.
    await this.sessionManager.waitIfPaused(sessionId);
  }

  /**
   * Get the debug server port
   */
  getPort(): number {
    return this.config.port;
  }

  // ============================================
  // WebSocket Handlers
  // ============================================

  private handleConnection(ws: WebSocket): void {
    const client: ConnectedClient = {
      ws,
      authenticated: !this.config.authToken, // Auto-auth if no token required
      followMode: false,
    };
    this.clients.set(ws, client);

    ws.on('message', (data) => {
      try {
        const message = data.toString();
        const command = parseDebugCommand(message);
        if (command) {
          this.handleCommand(client, command);
        }
      } catch (err) {
        this.sendEvent(ws, {
          type: 'error',
          message: `Invalid message: ${err}`,
        });
      }
    });

    ws.on('close', () => {
      // Detach from any attached session
      if (client.attachedSessionId) {
        this.sessionManager.detachDebugger(client.attachedSessionId);
      }
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('Client WebSocket error:', err);
    });
  }

  private handleCommand(client: ConnectedClient, command: DebugCommand): void {
    // Handle connect first (may include auth)
    if (command.cmd === 'connect') {
      this.handleConnect(client, command);
      return;
    }

    // All other commands require authentication
    if (!client.authenticated) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not authenticated',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    switch (command.cmd) {
      case 'sessions':
        this.handleSessions(client, command);
        break;
      case 'attach':
        this.handleAttach(client, command);
        break;
      case 'detach':
        this.handleDetach(client);
        break;
      case 'break':
        this.handleBreak(client, command);
        break;
      case 'unbreak':
        this.handleUnbreak(client, command);
        break;
      case 'breaks':
        this.handleBreaks(client);
        break;
      case 'pause':
        this.handlePause(client);
        break;
      case 'resume':
        this.handleResume(client);
        break;
      case 'step':
        this.handleStep(client, command);
        break;
      case 'state':
        this.handleState(client, command);
        break;
      case 'trace':
        this.handleTrace(client, command);
        break;
      case 'stack':
        this.handleStack(client);
        break;
      case 'explain':
        this.handleExplain(client, command);
        break;
      case 'evaluate':
        this.handleEvaluate(client, command);
        break;
      case 'follow':
        this.handleFollow(client, command);
        break;
      default:
        this.sendEvent(client.ws, {
          type: 'error',
          message: `Unknown command: ${(command as DebugCommand).cmd}`,
        });
    }
  }

  private handleConnect(client: ConnectedClient, command: { auth?: string }): void {
    // Check auth if required
    if (this.config.authToken) {
      if (command.auth !== this.config.authToken) {
        this.sendEvent(client.ws, {
          type: 'error',
          message: 'Invalid auth token',
          code: 'AUTH_FAILED',
        });
        return;
      }
    }

    client.authenticated = true;

    this.sendEvent(client.ws, {
      type: 'connected',
      version: PROTOCOL_VERSION,
      capabilities: [...SERVER_CAPABILITIES],
    });
  }

  private handleSessions(client: ConnectedClient, command: { filter?: string }): void {
    const sessions = this.sessionManager.getAllSessions();
    this.sendEvent(client.ws, {
      type: 'sessions',
      list: sessions,
    });
  }

  private handleAttach(client: ConnectedClient, command: { sessionId: string }): void {
    // Detach from current if attached
    if (client.attachedSessionId) {
      this.sessionManager.detachDebugger(client.attachedSessionId);
    }

    const success = this.sessionManager.attachDebugger(command.sessionId);
    if (!success) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: `Session not found: ${command.sessionId}`,
      });
      return;
    }

    client.attachedSessionId = command.sessionId;
    const session = this.sessionManager.getSession(command.sessionId)!;

    this.sendEvent(client.ws, {
      type: 'attached',
      session,
    });
  }

  private handleDetach(client: ConnectedClient): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    const sessionId = client.attachedSessionId;
    this.sessionManager.detachDebugger(sessionId);
    client.attachedSessionId = undefined;

    this.sendEvent(client.ws, {
      type: 'detached',
      sessionId,
    });
  }

  private handleBreak(client: ConnectedClient, command: { spec: any }): void {
    const bp = this.breakpointManager.addBreakpoint(command.spec);
    this.sendEvent(client.ws, {
      type: 'breaks',
      breakpoints: this.breakpointManager.getAllBreakpoints(),
    });
  }

  private handleUnbreak(client: ConnectedClient, command: { id: string }): void {
    this.breakpointManager.removeBreakpoint(command.id);
    this.sendEvent(client.ws, {
      type: 'breaks',
      breakpoints: this.breakpointManager.getAllBreakpoints(),
    });
  }

  private handleBreaks(client: ConnectedClient): void {
    this.sendEvent(client.ws, {
      type: 'breaks',
      breakpoints: this.breakpointManager.getAllBreakpoints(),
    });
  }

  private handlePause(client: ConnectedClient): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    // Fire-and-forget pause request; runtime callers await the shared pause gate.
    void this.sessionManager.pause(client.attachedSessionId);
  }

  private handleResume(client: ConnectedClient): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    this.sessionManager.resume(client.attachedSessionId);
    this.sendEvent(client.ws, { type: 'resumed' });
  }

  private handleStep(client: ConnectedClient, command: { type?: 'over' | 'into' | 'out' }): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    this.sessionManager.step(client.attachedSessionId, command.type);
  }

  private handleState(client: ConnectedClient, command: { path?: string }): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    const state = this.sessionManager.getStateSnapshot(client.attachedSessionId);
    const session = this.sessionManager.getSession(client.attachedSessionId)!;

    // If path specified, get nested value
    let data = state;
    if (command.path) {
      const parts = command.path.split('.');
      for (const part of parts) {
        if (data && typeof data === 'object') {
          data = (data as Record<string, unknown>)[part] as Record<string, unknown>;
        } else {
          data = {};
          break;
        }
      }
    }

    this.sendEvent(client.ws, {
      type: 'state',
      data: data as Record<string, unknown>,
      sessionState: session.state,
    });
  }

  private handleTrace(
    client: ConnectedClient,
    command: { limit?: number; filter?: string[] },
  ): void {
    // This would need trace storage - for now just acknowledge
    this.sendEvent(client.ws, {
      type: 'error',
      message: 'Trace history not yet implemented - use follow mode for live events',
    });
  }

  private handleStack(client: ConnectedClient): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    const frames = this.sessionManager.getCallStack(client.attachedSessionId);
    this.sendEvent(client.ws, {
      type: 'stack',
      frames,
    });
  }

  private handleExplain(client: ConnectedClient, command: { eventId?: string }): void {
    // Explain would need LLM integration - for now acknowledge
    this.sendEvent(client.ws, {
      type: 'error',
      message: 'Explain not yet implemented',
    });
  }

  private handleEvaluate(client: ConnectedClient, command: { expr: string }): void {
    if (!client.attachedSessionId) {
      this.sendEvent(client.ws, {
        type: 'error',
        message: 'Not attached to any session',
      });
      return;
    }

    const state = this.sessionManager.getStateSnapshot(client.attachedSessionId);

    try {
      // Simple evaluation - same as conditional breakpoints
      const result = this.evaluateExpression(command.expr, state);
      this.sendEvent(client.ws, {
        type: 'evaluate_result',
        expr: command.expr,
        result,
      });
    } catch (err) {
      this.sendEvent(client.ws, {
        type: 'evaluate_result',
        expr: command.expr,
        result: null,
        error: String(err),
      });
    }
  }

  private handleFollow(client: ConnectedClient, command: { enabled: boolean }): void {
    client.followMode = command.enabled;
  }

  // ============================================
  // Helpers
  // ============================================

  private sendEvent(ws: WebSocket, event: DebugEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeDebugEvent(event));
    }
  }

  private broadcastToSession(sessionId: string, event: DebugEvent): void {
    for (const [ws, client] of this.clients) {
      if (client.attachedSessionId === sessionId || client.followMode) {
        this.sendEvent(ws, event);
      }
    }
  }

  private handleSessionEvent(
    sessionId: string,
    event: 'created' | 'updated' | 'ended' | 'paused' | 'resumed',
  ): void {
    const session = this.sessionManager.getSession(sessionId);

    for (const [ws, client] of this.clients) {
      // Notify clients in follow mode about new sessions
      if (event === 'created' && client.followMode && session) {
        this.sendEvent(ws, {
          type: 'session_created',
          session,
        });
      }

      // Notify attached clients about session end
      if (event === 'ended' && client.attachedSessionId === sessionId) {
        this.sendEvent(ws, {
          type: 'session_ended',
          sessionId,
          reason: 'completed',
        });
        client.attachedSessionId = undefined;
      }

      // Notify about pause/resume
      if (event === 'paused' && client.attachedSessionId === sessionId) {
        this.sendEvent(ws, {
          type: 'paused',
          reason: 'user',
          context: {
            breakpoint: {
              id: '__manual__',
              spec: { type: 'event', eventType: 'decision' },
              enabled: true,
              hitCount: 0,
              createdAt: new Date(),
            },
            sessionId,
            agentName: session?.currentAgent ?? 'unknown',
            stateSnapshot: this.sessionManager.getStateSnapshot(sessionId),
            callStack: this.sessionManager.getCallStack(sessionId),
          },
        });
      }

      if (event === 'resumed' && client.attachedSessionId === sessionId) {
        this.sendEvent(ws, { type: 'resumed' });
      }
    }
  }

  private checkStepCondition(
    stepType: 'over' | 'into' | 'out' | undefined,
    event: ExtendedTraceEvent,
    callStack: AgentStackFrame[],
  ): boolean {
    // Step over: stop at next event at same or higher level
    if (stepType === 'over') {
      return true; // Stop at any event
    }

    // Step into: stop at next event (including inside delegates/handoffs)
    if (stepType === 'into') {
      return event.type === 'delegate_start' || event.type === 'handoff';
    }

    // Step out: stop when exiting current agent
    if (stepType === 'out') {
      return event.type === 'agent_exit';
    }

    return true;
  }

  private evaluateExpression(expr: string, state: Record<string, unknown>): unknown {
    // Simple path-based evaluation
    const parts = expr.split('.');
    let current: unknown = state;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
