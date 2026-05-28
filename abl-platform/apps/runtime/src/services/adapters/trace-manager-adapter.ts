/**
 * Trace Manager Adapter
 *
 * Implements TraceContextManager-like interface to emit trace events
 * compatible with the Platform Observatory panel.
 *
 * Note: This is a standalone implementation that follows the same pattern
 * as the platform TraceContextManager but is designed for server use.
 */

// =============================================================================
// TYPES
// =============================================================================

import type { TraceEvent as BaseTraceEvent } from '@agent-platform/shared-kernel';

/** Adapter trace event — uses ISO string timestamps for serialization */
export interface TraceEvent extends Omit<BaseTraceEvent, 'type' | 'timestamp'> {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type TraceEventCallback = (event: TraceEvent) => void;

// =============================================================================
// TRACE MANAGER ADAPTER
// =============================================================================

export class TestTraceManager {
  private onTraceEvent?: TraceEventCallback;
  private sessionId: string;
  private agentName: string;
  private events: TraceEvent[] = [];

  constructor(sessionId: string, agentName: string, onTraceEvent?: TraceEventCallback) {
    this.sessionId = sessionId;
    this.agentName = agentName;
    this.onTraceEvent = onTraceEvent;
  }

  /**
   * Emit a trace event
   */
  private emit(type: string, data: Record<string, unknown>): void {
    const event: TraceEvent = {
      type,
      data: {
        ...data,
        sessionId: this.sessionId,
        agentName: this.agentName,
      },
      timestamp: new Date().toISOString(),
    };

    this.events.push(event);
    this.onTraceEvent?.(event);
  }

  /**
   * Log a tool call
   */
  async logToolCall(
    tool: string,
    params: Record<string, unknown>,
    result?: unknown,
  ): Promise<void> {
    this.emit('tool_call', { tool, params });

    if (result !== undefined) {
      this.emit('tool_result', { tool, result });
    }
  }

  /**
   * Log an error
   */
  async logError(
    errorType: string,
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.emit('error', {
      errorType,
      message,
      context: context || {},
    });
  }

  /**
   * Log a state transition
   */
  async logStateTransition(
    from: string,
    to: string,
    trigger: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.emit('state_transition', {
      from,
      to,
      trigger,
      context: context || {},
    });
  }

  /**
   * Log a constraint check
   */
  async logConstraintCheck(
    constraint: string,
    passed: boolean,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this.emit('constraint_check', {
      constraint,
      passed,
      details: details || {},
    });
  }

  /**
   * Log flow step entry
   */
  logFlowStepEnter(stepName: string, input?: string, context?: Record<string, unknown>): void {
    this.emit('flow_step_enter', {
      stepName,
      input: input || '',
      context: context || {},
    });
  }

  /**
   * Log flow step exit
   */
  logFlowStepExit(stepName: string, durationMs: number, result: string): void {
    this.emit('flow_step_exit', {
      stepName,
      durationMs,
      result,
    });
  }

  /**
   * Log flow transition
   */
  logFlowTransition(fromStep: string, toStep: string, condition: string): void {
    this.emit('flow_transition', {
      fromStep,
      toStep,
      condition,
    });
  }

  /**
   * Log ABL construct execution
   */
  logDSLConstruct(
    constructType:
      | 'collect'
      | 'call'
      | 'respond'
      | 'check'
      | 'on_input'
      | 'gather'
      | 'digression'
      | 'sub_intent',
    stepName: string,
    data: Record<string, unknown>,
  ): void {
    this.emit(`dsl_${constructType}`, {
      stepName,
      ...data,
    });
  }

  /**
   * Log LLM call
   */
  logLLMCall(
    purpose: string,
    model: string,
    durationMs: number,
    tokenUsage?: { input: number; output: number },
  ): void {
    this.emit('llm_call', {
      purpose,
      model,
      durationMs,
      tokenUsage,
    });
  }

  /**
   * Log user message
   */
  logUserMessage(message: string): void {
    this.emit('user_message', { message });
  }

  /**
   * Log assistant response
   */
  logAssistantResponse(response: string): void {
    this.emit('assistant_response', { response });
  }

  /**
   * Get all collected events
   */
  getEvents(): TraceEvent[] {
    return [...this.events];
  }

  /**
   * Clear collected events
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Update the event callback
   */
  setEventCallback(callback: TraceEventCallback): void {
    this.onTraceEvent = callback;
  }
}
