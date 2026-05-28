/**
 * Execution Module — Barrel Export
 *
 * Re-exports all execution sub-modules for clean imports.
 */

// Types and helpers
export type {
  SessionDataStore,
  AgentThread,
  RuntimeSession,
  RuntimeState,
  RuntimeExecutorConfig,
  ExecutionResult,
  SubTaskResult,
  FanOutResult,
  AgentRegistryEntry,
  AgentRegistry,
  DelegateConfigIR,
  ExecutorContext,
} from './types.js';

export {
  getGatherProgress,
  setGatheredValues,
  deleteSessionValue,
  buildStateUpdates,
  getActiveThread,
  createThread,
  createInitialThread,
  syncThreadToSession,
  tryThreadReturn,
  compileToResolvedAgent,
} from './types.js';

// Value resolution (pure functions)
export {
  interpolateTemplate,
  interpolateVoiceConfig,
  resolveSetValue,
  resolveValuePath,
  getNestedValue,
} from './value-resolution.js';

// Constraint checking
export { checkConstraints, handleConstraintViolation } from './constraint-checker.js';

// Prompt building
export {
  buildSystemPrompt,
  buildTools,
  conditionToDescription,
  isVoiceChannel,
} from './prompt-builder.js';

// LLM wiring
export { LLMWiringService } from './llm-wiring.js';

// Routing
export { RoutingExecutor, executeComplete } from './routing-executor.js';
export type {
  BranchExecutionRecord,
  BranchExecutionStatus,
  BranchExecutionType,
} from './fanout/fanout-branch-state.js';
export {
  createBranchExecutionRecord,
  isBranchExecutionTerminal,
  markBranchCompleted,
  markBranchExecuting,
  markBranchFailed,
  markBranchTimedOut,
  toBranchResult,
} from './fanout/fanout-branch-state.js';
export type {
  AsyncFanOutBranchSpec,
  AsyncFanOutExecutionContext,
  FanOutParentResumeSuspensionContract,
  FanOutRemoteBranchSuspensionContract,
} from './fanout/async-fanout-coordinator.js';
export {
  buildParentResumeSuspensionContract,
  buildRemoteBranchSuspensionContract,
  createAsyncFanOutExecutionContext,
  createFanOutBranchId,
} from './fanout/async-fanout-coordinator.js';
export {
  buildFanOutResultFromBranchResults,
  formatAsyncFanOutCompletionMessage,
  storeFanOutResultOnThread,
} from './fanout/fanout-results.js';

// Flow step execution
export {
  FlowStepExecutor,
  detectIntent,
  detectCorrection,
  checkGatherComplete,
  buildGatherPrompt,
  validateField,
  evaluateOnInput,
} from './flow-step-executor.js';

// Reasoning execution (agentic loop with tool use)
export { ReasoningExecutor } from './reasoning-executor.js';
