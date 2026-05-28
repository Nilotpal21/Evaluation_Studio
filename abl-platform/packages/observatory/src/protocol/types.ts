/**
 * Debug Protocol Types
 *
 * Defines the WebSocket protocol for debug client-server communication.
 */

import { ExtendedTraceEvent, TraceEventType } from '../schema/trace-events.js';
import { Span, TraceContext } from '../schema/spans.js';

// ============================================
// Debug Sessions
// ============================================

/**
 * A debug session represents an active agent execution
 */
export interface DebugSession {
  /** Unique session identifier */
  id: string;

  /** Session name (e.g., "User 12345 - Flight Booking") */
  name: string;

  /** Current agent being executed */
  currentAgent: string;

  /** Session state */
  state: DebugSessionState;

  /** When the session started */
  startedAt: Date;

  /** Last activity timestamp */
  lastActivityAt: Date;

  /** Number of turns/messages processed */
  turnCount: number;

  /** Whether a debugger is attached */
  debuggerAttached: boolean;
}

export type DebugSessionState =
  | 'running' // Session is actively executing
  | 'paused' // Paused at breakpoint or by user
  | 'waiting' // Waiting for user input
  | 'completed' // Session finished
  | 'error'; // Session errored

// ============================================
// Breakpoints
// ============================================

/**
 * Breakpoint specification
 */
export type BreakpointSpec =
  | AgentBreakpoint
  | StepBreakpoint
  | EventBreakpoint
  | ConditionalBreakpoint;

export interface AgentBreakpoint {
  type: 'agent';
  /** Agent name to break on */
  name: string;
  /** When to break: entry, exit, or both */
  on?: 'entry' | 'exit' | 'both';
}

export interface StepBreakpoint {
  type: 'step';
  /** Agent name (for scripted agents) */
  agent: string;
  /** Step name/ID to break on */
  step: string;
}

export interface EventBreakpoint {
  type: 'event';
  /** Event type to break on */
  eventType: TraceEventType;
}

export interface ConditionalBreakpoint {
  type: 'condition';
  /** Expression to evaluate (e.g., "gather.budget > 5000") */
  expr: string;
}

/**
 * A configured breakpoint
 */
export interface Breakpoint {
  /** Unique breakpoint ID */
  id: string;

  /** Breakpoint specification */
  spec: BreakpointSpec;

  /** Whether the breakpoint is enabled */
  enabled: boolean;

  /** Hit count */
  hitCount: number;

  /** Created timestamp */
  createdAt: Date;
}

/**
 * Context when a breakpoint is hit
 */
export interface BreakpointContext {
  /** The breakpoint that was hit */
  breakpoint: Breakpoint;

  /** Current session */
  sessionId: string;

  /** Current agent */
  agentName: string;

  /** Current step (for scripted agents) */
  stepName?: string;

  /** Current trace event (if event breakpoint) */
  traceEvent?: ExtendedTraceEvent;

  /** Current state snapshot */
  stateSnapshot: Record<string, unknown>;

  /** Call stack (agent hierarchy) */
  callStack: AgentStackFrame[];
}

/**
 * Agent call stack frame
 */
export interface AgentStackFrame {
  agentName: string;
  mode: 'scripted' | 'reasoning';
  enteredAt: Date;
  currentStep?: string;
  trigger: 'routing' | 'handoff' | 'delegate' | 'initial';
}

// ============================================
// Debug Commands (Client -> Server)
// ============================================

export type DebugCommand =
  | ConnectCommand
  | SessionsCommand
  | AttachCommand
  | DetachCommand
  | BreakCommand
  | UnbreakCommand
  | BreaksCommand
  | PauseCommand
  | ResumeCommand
  | StepCommand
  | StateCommand
  | TraceCommand
  | StackCommand
  | ExplainCommand
  | EvaluateCommand
  | FollowCommand;

export interface ConnectCommand {
  cmd: 'connect';
  /** Optional auth token */
  auth?: string;
  /** Client identifier */
  clientId?: string;
}

export interface SessionsCommand {
  cmd: 'sessions';
  /** Filter by state */
  filter?: DebugSessionState;
}

export interface AttachCommand {
  cmd: 'attach';
  /** Session ID to attach to */
  sessionId: string;
}

export interface DetachCommand {
  cmd: 'detach';
}

export interface BreakCommand {
  cmd: 'break';
  /** Breakpoint specification */
  spec: BreakpointSpec;
}

export interface UnbreakCommand {
  cmd: 'unbreak';
  /** Breakpoint ID to remove */
  id: string;
}

export interface BreaksCommand {
  cmd: 'breaks';
}

export interface PauseCommand {
  cmd: 'pause';
}

export interface ResumeCommand {
  cmd: 'resume';
}

export interface StepCommand {
  cmd: 'step';
  /** Step type */
  type?: 'over' | 'into' | 'out';
}

export interface StateCommand {
  cmd: 'state';
  /** Optional path to specific state key */
  path?: string;
}

export interface TraceCommand {
  cmd: 'trace';
  /** Number of events to return */
  limit?: number;
  /** Filter by event type */
  filter?: TraceEventType[];
}

export interface StackCommand {
  cmd: 'stack';
}

export interface ExplainCommand {
  cmd: 'explain';
  /** Event ID to explain (default: last decision) */
  eventId?: string;
}

export interface EvaluateCommand {
  cmd: 'evaluate';
  /** Expression to evaluate */
  expr: string;
}

export interface FollowCommand {
  cmd: 'follow';
  /** Auto-attach to new sessions */
  enabled: boolean;
}

// ============================================
// Debug Events (Server -> Client)
// ============================================

export type DebugEvent =
  | ConnectedEvent
  | SessionsEvent
  | AttachedEvent
  | DetachedEvent
  | SessionCreatedEvent
  | SessionEndedEvent
  | BreakpointHitEvent
  | PausedEvent
  | ResumedEvent
  | TraceEventEvent
  | StateEvent
  | StackEvent
  | BreaksEvent
  | ExplainEvent
  | EvaluateResultEvent
  | ErrorEvent;

export interface ConnectedEvent {
  type: 'connected';
  /** Server version */
  version: string;
  /** Server capabilities */
  capabilities: string[];
}

export interface SessionsEvent {
  type: 'sessions';
  /** List of debug sessions */
  list: DebugSession[];
}

export interface AttachedEvent {
  type: 'attached';
  /** The attached session */
  session: DebugSession;
}

export interface DetachedEvent {
  type: 'detached';
  /** Session ID that was detached */
  sessionId: string;
}

export interface SessionCreatedEvent {
  type: 'session_created';
  /** The new session */
  session: DebugSession;
}

export interface SessionEndedEvent {
  type: 'session_ended';
  /** Session ID that ended */
  sessionId: string;
  /** Reason for ending */
  reason: string;
}

export interface BreakpointHitEvent {
  type: 'breakpoint_hit';
  /** The breakpoint that was hit */
  breakpoint: Breakpoint;
  /** Context at breakpoint */
  context: BreakpointContext;
}

export interface PausedEvent {
  type: 'paused';
  /** Reason for pause */
  reason: 'breakpoint' | 'step' | 'user' | 'error';
  /** Context at pause point */
  context: BreakpointContext;
}

export interface ResumedEvent {
  type: 'resumed';
}

export interface TraceEventEvent {
  type: 'trace';
  /** The trace event */
  event: ExtendedTraceEvent;
}

export interface StateEvent {
  type: 'state';
  /** State data */
  data: Record<string, unknown>;
  /** Session state */
  sessionState: DebugSessionState;
}

export interface StackEvent {
  type: 'stack';
  /** Call stack */
  frames: AgentStackFrame[];
}

export interface BreaksEvent {
  type: 'breaks';
  /** List of breakpoints */
  breakpoints: Breakpoint[];
}

export interface ExplainEvent {
  type: 'explain';
  /** Event being explained */
  eventId: string;
  /** Explanation text */
  explanation: string;
  /** Related events */
  relatedEvents: string[];
}

export interface EvaluateResultEvent {
  type: 'evaluate_result';
  /** Expression that was evaluated */
  expr: string;
  /** Result value */
  result: unknown;
  /** Error if evaluation failed */
  error?: string;
}

export interface ErrorEvent {
  type: 'error';
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
}

// ============================================
// Protocol Helpers
// ============================================

/**
 * Server capabilities
 */
export const SERVER_CAPABILITIES = [
  'breakpoints',
  'step',
  'state',
  'trace',
  'stack',
  'explain',
  'evaluate',
  'follow',
] as const;

export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];

/**
 * Protocol version
 */
export const PROTOCOL_VERSION = '1.0.0';

/**
 * Parse a debug command from JSON
 */
export function parseDebugCommand(json: string): DebugCommand | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && 'cmd' in parsed) {
      return parsed as DebugCommand;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize a debug event to JSON
 */
export function serializeDebugEvent(event: DebugEvent): string {
  return JSON.stringify(event);
}

/**
 * Create a breakpoint ID
 */
export function createBreakpointId(): string {
  return `bp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

/**
 * Format a breakpoint for display
 */
export function formatBreakpoint(bp: Breakpoint): string {
  const { spec } = bp;
  switch (spec.type) {
    case 'agent':
      return `agent:${spec.name}${spec.on ? `:${spec.on}` : ''}`;
    case 'step':
      return `step:${spec.agent}:${spec.step}`;
    case 'event':
      return `event:${spec.eventType}`;
    case 'condition':
      return `cond:"${spec.expr}"`;
  }
}

/**
 * Parse a breakpoint spec from CLI-style string
 */
export function parseBreakpointSpec(input: string): BreakpointSpec | null {
  // agent:Sales_Chat or agent:Sales_Chat:entry
  const agentMatch = input.match(/^agent:([^:]+)(?::(entry|exit|both))?$/);
  if (agentMatch) {
    return {
      type: 'agent',
      name: agentMatch[1],
      on: (agentMatch[2] as 'entry' | 'exit' | 'both') || 'both',
    };
  }

  // step:AgentName:StepName
  const stepMatch = input.match(/^step:([^:]+):(.+)$/);
  if (stepMatch) {
    return {
      type: 'step',
      agent: stepMatch[1],
      step: stepMatch[2],
    };
  }

  // event:handoff
  const eventMatch = input.match(/^event:(.+)$/);
  if (eventMatch) {
    return {
      type: 'event',
      eventType: eventMatch[1] as TraceEventType,
    };
  }

  // cond:"budget > 5000"
  const condMatch = input.match(/^cond:"(.+)"$/);
  if (condMatch) {
    return {
      type: 'condition',
      expr: condMatch[1],
    };
  }

  return null;
}
