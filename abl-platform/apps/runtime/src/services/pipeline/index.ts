/**
 * Pipeline Module — Re-exports
 *
 * Individual pipeline components (classifier, tool filter, routing resolver,
 * intent bridge, tiered resolver) are orchestrated by the reasoning executor.
 * This module re-exports them for convenience and exposes extractToolNames()
 * as a shared utility.
 */

import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';

/**
 * Extract non-system, non-routing tool names from the tool definitions.
 */
export function extractToolNames(tools: ToolDefinition[]): string[] {
  return tools
    .filter(
      (t) =>
        !t.name.startsWith('__') &&
        !t.name.startsWith('handoff_to_') &&
        !t.name.startsWith('delegate_to_'),
    )
    .map((t) => t.name);
}

// Pipeline components
export { classify, shouldShortCircuit, checkKeywordVeto } from './classifier.js';
export type {
  AgentScopeContext,
  ClassifierMode,
  ClassifierRequest,
  GatherScopedClassifierRequest,
  GlobalClassifierRequest,
} from './classifier.js';
export { filterTools } from './tool-filter.js';
export { resolveRouting } from './routing-resolver.js';
export {
  bridgeSupervisorToolCallToDetectedIntent,
  bridgeIntentsToSessionState,
  bridgeToDetectedMultiIntent,
  bridgeToMultiIntentResult,
  resolveHighConfidenceMultiIntentMode,
  SUPERVISOR_TOOL_CALL_INTENT_SUMMARY,
} from './intent-bridge.js';
export { resolveTieredAction } from './tiered-resolver.js';
export { resolvePipelineConfig } from './config.js';
export { mergeResponses } from './merge.js';
export { resolvePipelineModel } from './model-resolver.js';
export {
  canDeriveRouteFromIntentText,
  isSupervisorToolCallRouteIntent,
  MAX_CLASSIFIER_CONTEXT_MESSAGES,
  resolveClassifierRuntimeContext,
  shouldRunPipelineClassifier,
} from './runtime-contract.js';
export type {
  ClassifierConversationTurn,
  ClassifierRuntimeContext,
  PipelineClassifierDecision,
  PipelineClassifierDecisionReason,
} from './runtime-contract.js';

// Types
export type {
  PipelineConfig,
  PipelineResult,
  PipelineIntentState,
  ClassifiedIntent,
  ClassifierResult,
  RoutingMatch,
  OnTraceEvent,
  TieredAction,
  IntentBridgeConfig,
} from './types.js';
export { DEFAULT_PIPELINE_CONFIG } from './types.js';
