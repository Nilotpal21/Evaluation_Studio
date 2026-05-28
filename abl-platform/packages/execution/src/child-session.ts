import crypto from 'crypto';

/**
 * Creates a unique execution ID for fan-out coordination.
 * Used to correlate all trace events, child sessions, and results
 * within a single fan-out execution.
 */
export function createExecutionId(): string {
  return `exec-${crypto.randomUUID()}`;
}

type ChildSessionShape = {
  activeThreadIndex: number;
  isComplete?: boolean;
  isEscalated?: boolean;
  handoffStack?: string[];
  delegateStack?: string[];
  threadStack?: number[];
  handoffReturnInfo?: unknown;
  intentQueue?: unknown;
  _pinnedIntent?: unknown;
  pendingContentBlocks?: unknown;
  currentAttachmentIds?: unknown;
  threads: Array<{
    conversationHistory: unknown[];
    state: unknown;
    data: unknown;
    agentName: string;
    agentIR: unknown;
    activationAuthContext?: unknown;
    currentFlowStep?: string;
    waitingForInput?: unknown;
    pendingResponse?: string;
  }>;
  conversationHistory: unknown[];
  state: unknown;
  data: unknown;
  agentName: string;
  agentIR: unknown;
  _activationAuthContext?: unknown;
  currentFlowStep?: string;
  waitingForInput?: unknown;
  pendingResponse?: string;
};

function cloneSafely<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function cloneThreadData<T>(data: T): T {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const record = data as Record<string, unknown>;
  const clonedRecord: Record<string, unknown> = { ...record };

  if ('values' in record) {
    clonedRecord.values = cloneSafely(record.values);
  }
  if (record.gatheredKeys instanceof Set) {
    clonedRecord.gatheredKeys = new Set(record.gatheredKeys);
  }

  return clonedRecord as T;
}

function cloneActiveThread<T extends ChildSessionShape['threads'][number]>(thread: T): T {
  return {
    ...thread,
    conversationHistory: cloneSafely(thread.conversationHistory),
    state: cloneSafely(thread.state),
    data: cloneThreadData(thread.data),
    activationAuthContext: cloneSafely(thread.activationAuthContext),
    waitingForInput: Array.isArray(thread.waitingForInput)
      ? [...thread.waitingForInput]
      : thread.waitingForInput,
  };
}

/**
 * Creates a shallow-copy child session from a parent session,
 * pointing to a specific thread index.
 *
 * Syncs conversationHistory, state, and data from the child thread
 * to the session copy (by reference) so downstream code sees the
 * child thread's data. After execution, the caller should sever
 * these shared references to prevent corruption from detached
 * child executions.
 *
 * Generic over session type to avoid coupling to RuntimeSession.
 */
function createBaseChildSession<T extends ChildSessionShape>(
  session: T,
  childIndex: number,
  options?: { isolateActiveThread?: boolean },
): T {
  if (childIndex < 0 || childIndex >= session.threads.length) {
    throw new Error(
      `Thread index ${childIndex} out of bounds (session has ${session.threads.length} threads)`,
    );
  }
  const thread = session.threads[childIndex];
  const activeThread = options?.isolateActiveThread ? cloneActiveThread(thread) : thread;
  const threads = [...session.threads];
  threads[childIndex] = activeThread;

  return {
    ...session,
    activeThreadIndex: childIndex,
    // Clone the thread list so detached children can't mutate stack membership.
    threads,
    ...(session.handoffStack ? { handoffStack: [...session.handoffStack] } : {}),
    ...(session.delegateStack ? { delegateStack: [...session.delegateStack] } : {}),
    ...(session.threadStack ? { threadStack: [...session.threadStack] } : {}),
    // Reset terminal flags — child execution must not inherit parent completion state
    isComplete: false,
    isEscalated: false,
    // Sync session-level fields to the child thread.
    agentName: activeThread.agentName,
    agentIR: activeThread.agentIR,
    conversationHistory: activeThread.conversationHistory,
    state: activeThread.state,
    data: activeThread.data,
    _activationAuthContext: cloneSafely(
      activeThread.activationAuthContext ?? session._activationAuthContext,
    ),
    currentFlowStep: activeThread.currentFlowStep,
    waitingForInput: activeThread.waitingForInput,
    pendingResponse: activeThread.pendingResponse,
  };
}

function sanitizeNestedChildSession<T extends ChildSessionShape>(childSession: T): T {
  return {
    ...childSession,
    handoffReturnInfo: undefined,
    intentQueue: undefined,
    _pinnedIntent: undefined,
    pendingContentBlocks: undefined,
    currentAttachmentIds: undefined,
  };
}

/**
 * Creates a child session for fan-out execution.
 *
 * Fan-out children must not inherit routing authority or queued intent state
 * from the parent because they execute independently from the parent router.
 */
export function createChildSessionForFanOut<T extends ChildSessionShape>(
  session: T,
  childIndex: number,
): T {
  return sanitizeNestedChildSession(createBaseChildSession(session, childIndex));
}

/**
 * Creates a child session for handoff execution.
 *
 * This currently uses the same sanitization rules as fan-out children so the
 * active child agent never inherits parent routing authority by accident.
 */
export function createChildSessionForHandoff<T extends ChildSessionShape>(
  session: T,
  childIndex: number,
): T {
  return sanitizeNestedChildSession(createBaseChildSession(session, childIndex));
}

/**
 * Creates a child session for delegate execution.
 *
 * Delegate auth/context chaining is handled outside this helper; this factory
 * only guarantees control-plane state is sanitized for nested execution.
 */
export function createChildSessionForDelegate<T extends ChildSessionShape>(
  session: T,
  childIndex: number,
): T {
  return sanitizeNestedChildSession(
    createBaseChildSession(session, childIndex, { isolateActiveThread: true }),
  );
}

/**
 * Backward-compatible alias.
 *
 * Existing call sites should move to purpose-specific factories so intent is
 * explicit, but the default remains the safe fan-out sanitization behavior.
 */
export function createChildSession<T extends ChildSessionShape>(session: T, childIndex: number): T {
  return createChildSessionForFanOut(session, childIndex);
}
