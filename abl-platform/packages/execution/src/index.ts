export type {
  ExecutionUnit,
  ExecutionPlan,
  ExecutionUnitResult,
  ExecutionRuntime,
  Semaphore,
  ExecutionConfig,
  SuspensionReason,
  ResumeData,
  Execution,
  ExecutionStatus,
  CreateExecutionInput,
} from './types.js';

export { createExecution } from './types.js';

export type { ExecutionQueue } from './execution-queue.js';
export { InMemoryExecutionQueue } from './execution-queue.js';

export { CountingSemaphore } from './semaphore.js';
export {
  createChildSession,
  createChildSessionForDelegate,
  createChildSessionForFanOut,
  createChildSessionForHandoff,
  createExecutionId,
} from './child-session.js';
export { InProcessExecutionRuntime } from './in-process-runtime.js';

// Suspension types
export type {
  SuspendedExecution,
  SuspendedContinuation,
  FanOutContinuation,
  FanOutContinuationOwner,
  ChannelBinding,
  SuspensionStatus,
} from './suspension.js';
export { getFanOutContinuationOwner } from './suspension.js';

// Suspension store
export type { SuspensionStore } from './suspension-store.js';

// Callback registry
export type { CallbackRegistry, CallbackRegistryEntry } from './callback-registry.js';
export { InMemoryCallbackRegistry } from './in-memory-callback-registry.js';
export { RedisCallbackRegistry } from './redis-callback-registry.js';
export type { RedisClient } from './redis-callback-registry.js';

// Fan-out barrier
export type {
  FanOutBarrier,
  FanOutBarrierStore,
  BranchResult,
  BranchResultStatus,
  FanOutBarrierStatus,
  BranchCompletionDisposition,
  BranchCompletionDecision,
  BranchCompletionOutcome,
} from './fan-out-barrier.js';
export {
  classifyBranchCompletionAttempt,
  getBranchResultKey,
  isBarrierClosed,
} from './fan-out-barrier.js';
export { InMemoryFanOutBarrierStore } from './in-memory-fan-out-barrier.js';
export { RedisFanOutBarrierStore } from './redis-fan-out-barrier.js';
