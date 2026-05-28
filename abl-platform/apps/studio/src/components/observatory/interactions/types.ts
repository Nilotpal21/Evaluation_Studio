/**
 * Interactions Tab — Type Definitions
 *
 * All types for the interaction-centric trace explorer.
 * Used by event-processor.ts and all interaction components.
 */

import type { ExtendedTraceEvent } from '../../../types';

export type InteractionStepType =
  | 'user_input'
  | 'input_guard'
  | 'llm_call'
  | 'gather'
  | 'flow_transition'
  | 'flow_graph'
  | 'tool_call'
  | 'parallel_tools'
  | 'retry'
  | 'output_guard'
  | 'agent_response'
  | 'memory_diff'
  | 'decision'
  | 'error';

export interface InteractionStep {
  id: string;
  type: InteractionStepType;
  timestamp: Date;
  durationMs?: number;
  agentName: string;
  flowStepName?: string;
  flowStepType?: string;
  flowStepRunId?: string;
  flowIteration?: number;
  events: ExtendedTraceEvent[];
  data: Record<string, unknown>;
}

export interface ToolCallStepItem {
  id: string;
  tool: string;
  input?: unknown;
  result?: unknown;
  status: 'success' | 'failed';
  error?: unknown;
  durationMs?: number;
  url?: string;
  method?: string;
  authType?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  headerNames?: string[];
  queryParams?: Record<string, string>;
  eventIds: string[];
}

export type LifecycleBannerKind =
  | 'agent_enter'
  | 'agent_exit'
  | 'delegate_start'
  | 'delegate_complete'
  | 'handoff_return_handler'
  | 'resume_intent'
  | 'thread_resume'
  | 'return_to_parent'
  | 'thread_return';

export interface LifecycleBanner {
  id: string;
  timestamp: Date;
  kind: LifecycleBannerKind;
  agentName: string;
  targetAgent?: string;
  parentAgent?: string;
  event: ExtendedTraceEvent;
  reason: string;
  reasonDetail?: string;
  trigger?: string;
  result?: string;
  status?: string;
  durationMs?: number;
  causeEventId?: string;
  causeLabel?: string;
  reasonCode?: string;
  phase?: string;
  agentRunId?: string;
}

export interface SessionResolution {
  timestamp: Date;
  outcome: string;
  reason?: string;
  finalAgent?: string;
  durationMs?: number;
}

export interface Interaction {
  id: string;
  index: number;
  agentName: string;
  entryAgentName?: string;
  agentMode: 'reasoning' | 'scripted' | 'unknown';
  status: 'ok' | 'warning' | 'error';
  startTime: Date;
  endTime: Date;
  durationMs: number;
  steps: InteractionStep[];
  banners: LifecycleBanner[];
}

export interface SessionSummary {
  sessionId: string;
  status: 'running' | 'completed' | 'failed';
  interactionCount: number;
  agentCount: number;
  llmCallCount: number;
  toolCallCount: number;
  totalDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  /** Largest context window size seen across all LLM calls (from trace data) */
  maxContextWindowSize: number;
}

export interface AgentPathNode {
  agentName: string;
  mode: 'reasoning' | 'scripted' | 'unknown';
}

export interface AgentPathEdge {
  label: string;
}

export interface AgentSwitch {
  fromAgent: string;
  toAgent: string;
  fromMode: 'reasoning' | 'scripted' | 'unknown';
  toMode: 'reasoning' | 'scripted' | 'unknown';
  reason?: string;
  afterInteractionIndex: number;
}

export interface ProcessedInteractions {
  interactions: Interaction[];
  summary: SessionSummary;
  agentPath: AgentPathNode[];
  agentSwitches: AgentSwitch[];
  resolution: SessionResolution | null;
}
