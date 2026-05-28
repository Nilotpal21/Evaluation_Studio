/**
 * Interactions Tab — Public Exports
 */

export { InteractionsTab, useInteractionCount } from './InteractionsTab';
export { InteractionsErrorBoundary } from './ErrorBoundary';
export { processEventsToInteractions } from './event-processor';
export { ConfidenceBar } from './ConfidenceBar';
export { ContextWindowBar } from './ContextWindowBar';
export { TokenGrid } from './TokenGrid';
export { TokenBadge, aggregateTokens } from './TokenBadge';
export { GuardrailPanel, extractGuardrailChecks, type GuardrailCheck } from './GuardrailPanel';
export { GuardrailCompact } from './GuardrailCompact';
export { MemoryDiff, computeMemoryDiff } from './MemoryDiff';
export { DiffLine } from './DiffLine';
export { SwimLaneTimeline, detectParallelTools } from './SwimLaneTimeline';
export { RetryBadge } from './RetryBadge';
export { FlowBreadcrumb, extractFlowSteps } from './FlowBreadcrumb';
export { MiniFlowGraph } from './MiniFlowGraph';
export { VariableResolution } from './VariableResolution';
export { TransitionEvaluation } from './TransitionEvaluation';
export { GatherConfidence } from './GatherConfidence';
export { LifecycleBannerComponent } from './LifecycleBanner';
export { SessionResolutionFooter } from './SessionResolutionFooter';
export { EVENT_LABELS, LIFECYCLE_EVENTS, SESSION_EVENTS } from './constants';
export type {
  Interaction,
  InteractionStep,
  InteractionStepType,
  SessionSummary,
  AgentPathNode,
  AgentSwitch,
  ProcessedInteractions,
  LifecycleBanner,
  LifecycleBannerKind,
  SessionResolution,
} from './types';
