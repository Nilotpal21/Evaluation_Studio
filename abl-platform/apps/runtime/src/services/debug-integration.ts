/**
 * Debug Integration
 *
 * Integrates the Observatory debug server with the RuntimeExecutor.
 * Provides breakpoint support, extended tracing, and pause/resume flow control.
 */

import type {
  DebugServer,
  ExtendedTraceEvent,
  BreakpointContext,
} from '@agent-platform/observatory';
import type { RuntimeSession, RuntimeExecutor, ExecutionResult } from './runtime-executor.js';
import { compileToResolvedAgent } from './runtime-executor.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

// Generate IDs compatible with OpenTelemetry
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Debug context for a session
 */
interface SessionDebugContext {
  traceId: string;
  spanStack: string[]; // Stack of span IDs for hierarchy
  agentStack: Array<{
    agentName: string;
    spanId: string;
    mode: 'scripted' | 'reasoning';
    enteredAt: Date;
  }>;
}

/**
 * Debug-enabled wrapper for RuntimeExecutor
 */
export class DebugRuntimeExecutor {
  private executor: RuntimeExecutor;
  private debugServer: DebugServer | null = null;
  private debugContexts: Map<string, SessionDebugContext> = new Map();

  constructor(executor: RuntimeExecutor) {
    this.executor = executor;
  }

  /**
   * Attach debug server for remote debugging
   */
  setDebugServer(server: DebugServer): void {
    this.debugServer = server;
  }

  /**
   * Check if debug server is attached
   */
  hasDebugServer(): boolean {
    return this.debugServer !== null;
  }

  /**
   * Create a debug-enabled session
   */
  createSession(dsl: string, agentName: string): RuntimeSession {
    // Tool resolution intentionally skipped — debug sessions have no tenant/project context.
    // Tools will use NoOpToolExecutor. See resolveProjectTools for production path.
    const session = this.executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], agentName),
    );

    // Initialize debug context
    const traceId = generateTraceId();
    const rootSpanId = generateSpanId();

    this.debugContexts.set(session.id, {
      traceId,
      spanStack: [rootSpanId],
      agentStack: [],
    });

    // Notify debug server
    if (this.debugServer) {
      this.debugServer.onSessionCreated(
        session.id,
        `${agentName} - ${new Date().toISOString()}`,
        agentName,
      );

      // Emit session_start event
      this.emitExtendedEvent(session.id, {
        type: 'session_start',
        agentName,
        data: {
          mode: session.agentIR?.execution?.mode || 'reasoning',
          hasFlow: !!session.agentIR?.flow,
        },
      });
    }

    return session;
  }

  /**
   * Execute message with debug support
   */
  async executeMessage(
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult> {
    const session = this.executor.getSession(sessionId);
    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
    }

    const ctx = this.debugContexts.get(sessionId);
    if (!ctx) {
      // No debug context, run without debugging
      return this.executor.executeMessage(sessionId, userMessage, onChunk, onTraceEvent);
    }

    // Wait if paused by debugger
    if (this.debugServer) {
      // pauseExecution() and waitIfPaused() share the same pause gate inside the
      // observatory session manager, so this await cannot orphan a breakpoint hit.
      await this.debugServer.waitIfPaused(sessionId);
    }

    // Emit agent_enter if this is a new agent context
    const isNewAgent =
      ctx.agentStack.length === 0 ||
      ctx.agentStack[ctx.agentStack.length - 1].agentName !== session.agentName;

    if (isNewAgent) {
      this.enterAgent(sessionId, session);
    }

    // Create trace event wrapper that adds debug support
    const wrappedOnTraceEvent = this.createWrappedTraceHandler(sessionId, session, onTraceEvent);

    try {
      const result = await this.executor.executeMessage(
        sessionId,
        userMessage,
        onChunk,
        wrappedOnTraceEvent,
      );

      // Check for handoff/complete/escalate
      if (result.action.type === 'complete') {
        this.exitAgent(sessionId, session, 'complete');
      } else if (result.action.type === 'escalate') {
        this.exitAgent(sessionId, session, 'escalate');
      } else if (result.action.type === 'handoff') {
        this.exitAgent(sessionId, session, 'handoff');
      }

      return result;
    } catch (error) {
      // Emit error event
      this.emitExtendedEvent(sessionId, {
        type: 'error',
        agentName: session.agentName,
        data: {
          errorType: 'execution_error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        },
      });

      throw error;
    }
  }

  /**
   * Initialize session with debug support (handles both flow and reasoning modes).
   */
  async initializeSession(
    sessionId: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<ExecutionResult | null> {
    const session = this.executor.getSession(sessionId);
    if (!session) return null;

    // Enter agent context
    this.enterAgent(sessionId, session);

    // Create wrapped handler
    const wrappedOnTraceEvent = this.createWrappedTraceHandler(sessionId, session, onTraceEvent);

    return this.executor.initializeSession(sessionId, onChunk, wrappedOnTraceEvent);
  }

  /**
   * Destroy a session
   */
  destroySession(sessionId: string): void {
    const session = this.executor.getSession(sessionId);

    if (this.debugServer && session) {
      // Emit session_end
      const ctx = this.debugContexts.get(sessionId);
      this.emitExtendedEvent(sessionId, {
        type: 'session_end',
        agentName: session.agentName,
        data: {
          reason: session.isComplete
            ? 'completed'
            : session.isEscalated
              ? 'escalated'
              : 'destroyed',
          totalTurns: session.conversationHistory.length / 2,
        },
      });

      this.debugServer.onSessionDestroyed(sessionId);
    }

    this.debugContexts.delete(sessionId);
  }

  // ============================================
  // Private Methods
  // ============================================

  private enterAgent(sessionId: string, session: RuntimeSession): void {
    const ctx = this.debugContexts.get(sessionId);
    if (!ctx || !this.debugServer) return;

    const spanId = generateSpanId();
    const mode = session.agentIR?.flow ? 'scripted' : 'reasoning';

    ctx.agentStack.push({
      agentName: session.agentName,
      spanId,
      mode,
      enteredAt: new Date(),
    });
    ctx.spanStack.push(spanId);

    // Notify debug server
    this.debugServer.onAgentEnter(
      sessionId,
      session.agentName,
      mode,
      ctx.agentStack.length === 1 ? 'initial' : 'handoff',
    );

    // Emit agent_enter event
    this.emitExtendedEvent(sessionId, {
      type: 'agent_enter',
      agentName: session.agentName,
      spanId,
      data: {
        mode,
        trigger: ctx.agentStack.length === 1 ? 'initial' : 'handoff',
      },
    });
  }

  private exitAgent(
    sessionId: string,
    session: RuntimeSession,
    result: 'complete' | 'handoff' | 'escalate' | 'error',
  ): void {
    const ctx = this.debugContexts.get(sessionId);
    if (!ctx || !this.debugServer) return;

    const agentFrame = ctx.agentStack.pop();
    ctx.spanStack.pop();

    if (agentFrame) {
      // Notify debug server
      this.debugServer.onAgentExit(sessionId);

      // Emit agent_exit event
      const duration = new Date().getTime() - agentFrame.enteredAt.getTime();
      this.emitExtendedEvent(sessionId, {
        type: 'agent_exit',
        agentName: agentFrame.agentName,
        spanId: agentFrame.spanId,
        durationMs: duration,
        data: {
          mode: agentFrame.mode,
          result,
        },
      });
    }
  }

  private createWrappedTraceHandler(
    sessionId: string,
    session: RuntimeSession,
    originalHandler?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): (event: { type: string; data: Record<string, unknown> }) => void {
    return async (event) => {
      // Call original handler first
      if (originalHandler) {
        originalHandler(event);
      }

      // Convert to extended trace event and emit
      await this.handleTraceEvent(sessionId, session, event);
    };
  }

  private async handleTraceEvent(
    sessionId: string,
    session: RuntimeSession,
    event: { type: string; data: Record<string, unknown> },
  ): Promise<void> {
    const ctx = this.debugContexts.get(sessionId);
    if (!ctx || !this.debugServer) return;

    // Map internal event types to extended types
    const extendedType = this.mapEventType(event.type);

    // Emit extended trace event
    const extendedEvent = this.emitExtendedEvent(sessionId, {
      type: extendedType,
      agentName: session.agentName,
      stepName: session.currentFlowStep,
      data: event.data,
    });

    // Update session state in debug server
    this.debugServer.onStateUpdate(sessionId, session.state as unknown as Record<string, unknown>);

    // Handle flow step events
    if (event.type === 'flow_step' && event.data.step) {
      this.debugServer.onStepEnter(sessionId, String(event.data.step));
    }

    // Check breakpoints
    const bpContext = this.debugServer.checkBreakpoint(
      sessionId,
      extendedEvent,
      session.state as unknown as Record<string, unknown>,
    );

    if (bpContext) {
      // Breakpoint hit - pause execution on the same gate used by waitIfPaused().
      await this.debugServer.pauseExecution(sessionId, bpContext);
    }
  }

  private mapEventType(internalType: string): string {
    const typeMap: Record<string, string> = {
      user_message: 'decision',
      llm_call: 'llm_call',
      tool_call: 'tool_call',
      tool_result: 'tool_call',
      handoff: 'handoff',
      delegate_call: 'delegate_start',
      delegate_result: 'delegate_complete',
      escalation: 'escalation',
      complete: 'decision',
      error: 'error',
      flow_input: 'flow_step_enter',
      flow_step: 'flow_step_enter',
      flow_response: 'flow_step_exit',
      flow_transition: 'flow_transition',
      flow_branch: 'flow_transition',
      condition_check: 'constraint_check',
      routing_decision: 'decision',
    };

    return typeMap[internalType] || 'decision';
  }

  private emitExtendedEvent(
    sessionId: string,
    partial: {
      type: string;
      agentName: string;
      spanId?: string;
      stepName?: string;
      durationMs?: number;
      data: Record<string, unknown>;
    },
  ): ExtendedTraceEvent {
    const ctx = this.debugContexts.get(sessionId);
    const spanId = partial.spanId ?? ctx?.spanStack[ctx.spanStack.length - 1] ?? generateSpanId();
    const parentSpanId =
      ctx?.spanStack.length && ctx.spanStack.length > 1
        ? ctx.spanStack[ctx.spanStack.length - 2]
        : undefined;

    const event: ExtendedTraceEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: partial.type as ExtendedTraceEvent['type'],
      timestamp: new Date(),
      durationMs: partial.durationMs,
      traceId: ctx?.traceId ?? generateTraceId(),
      spanId,
      parentSpanId,
      sessionId,
      agentName: partial.agentName,
      stepName: partial.stepName,
      data: partial.data,
    };

    // Emit to debug server
    if (this.debugServer) {
      this.debugServer.onTraceEvent(sessionId, event);
    }

    return event;
  }
}

/**
 * Create a debug-enabled runtime executor
 */
export function createDebugExecutor(executor: RuntimeExecutor): DebugRuntimeExecutor {
  return new DebugRuntimeExecutor(executor);
}
