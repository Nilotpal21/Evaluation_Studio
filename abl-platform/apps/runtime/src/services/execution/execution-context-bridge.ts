/**
 * Execution Context Bridge
 *
 * Maps between RuntimeSession (runtime layer) and ExecutionContext (compiler/construct layer).
 * This is the foundation for delegating execution to construct executors without
 * leaking runtime internals into the compiler package.
 *
 * Mapping table:
 *   RuntimeSession.id                    → ExecutionContext.sessionId
 *   RuntimeSession.tenantId              → ExecutionContext.tenantId
 *   RuntimeSession.projectId             → ExecutionContext.projectId
 *   RuntimeSession.agentIR               → ExecutionContext.agentIR (must be non-null)
 *   RuntimeSession.state.gatherProgress  → ExecutionContext.state.gatherProgress
 *   RuntimeSession.state.conversationPhase → ExecutionContext.state.conversationPhase
 *   RuntimeSession.state.context + data.values → ExecutionContext.state.context (merged, data wins)
 *   RuntimeSession.data.gatheredKeys→values → ExecutionContext.state.gatherProgress
 *   RuntimeSession.conversationHistory   → ExecutionContext.messageHistory
 *   RuntimeSession.channelType           → ExecutionContext.runtime ('voice' | 'digital')
 *   BridgeDeps.toolExecutor              → ExecutionContext.toolExecutor
 *   BridgeDeps.llmClient                 → ExecutionContext.llmClient
 */

import type {
  ExecutionContext,
  ConstructResult,
  AgentState,
  ToolExecutor,
  LLMClient,
  RuntimeType,
} from '@abl/compiler';
import type { TraceContextManager } from '@abl/compiler/platform/stores/trace-store.js';
import type { StoreContext } from '@abl/compiler/platform/constructs/types.js';
import type { RuntimeSession } from './types.js';
import type { TraceStoreInterface } from '../trace-store.js';
import { createTraceForwarder } from './trace-forwarder.js';
import { getConfig, isConfigLoaded } from '../../config/index.js';

export interface BridgeDeps {
  toolExecutor?: ToolExecutor;
  llmClient?: LLMClient;
  /** Trace context manager — when provided, wired into the execution context */
  trace?: TraceContextManager;
  /** Store instances — when provided, wired into the execution context (partial allowed) */
  stores?: Partial<StoreContext>;
  /** Runtime trace store — when provided and no explicit trace dep, creates a forwarding TraceContextManager */
  traceStore?: TraceStoreInterface;
}

/**
 * Create a Proxy-based no-op stub for a given interface type.
 *
 * Using `{} as T` is unsafe because calling any method on the empty object
 * would throw a confusing "not a function" error. This stub returns a Proxy
 * that throws a descriptive error for any property access that leads to a
 * function call, making the root cause immediately obvious in logs.
 */
function createNoopStub<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      // Return a no-op function that throws with context
      return () => {
        throw new Error(
          `${label}.${String(prop)}() called but no real implementation was provided. ` +
            `Wire the dependency via BridgeDeps to fix this.`,
        );
      };
    },
  });
}

/**
 * Build an ExecutionContext from a RuntimeSession and external dependencies.
 * Throws if agentIR is null — callers must ensure the session has a compiled agent.
 */
export function buildExecutionContext(session: RuntimeSession, deps: BridgeDeps): ExecutionContext {
  if (!session.agentIR) {
    throw new Error('agentIR is required to build an ExecutionContext');
  }

  // Compute gatherProgress from the data store (only gathered keys)
  const gatherProgress: Record<string, unknown> = {};
  for (const key of session.data.gatheredKeys) {
    if (key in session.data.values) {
      gatherProgress[key] = session.data.values[key];
    }
  }

  // Merge state.context with data.values (data store wins on conflict)
  const mergedContext: Record<string, unknown> = {
    ...session.state.context,
    ...session.data.values,
  };

  // Determine runtime type from channel
  const runtime: RuntimeType = session.channelType?.startsWith('voice') ? 'voice' : 'digital';

  // Map conversation history to messageHistory format
  const messageHistory: Array<{ role: 'user' | 'assistant'; content: string }> =
    session.conversationHistory
      .filter((msg) => typeof msg.content === 'string')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content as string,
      }));

  // Build AgentState for the construct layer
  const state: AgentState = {
    context: mergedContext,
    conversationPhase: session.state.conversationPhase,
    gatherProgress: { ...session.state.gatherProgress, ...gatherProgress },
    constraintResults: {},
    lastToolResults: {},
    memory: {
      session: {},
      persistentCache: {},
      pendingRemembers: [],
    },
  };

  // Wire trace from deps, forwarder, or fall back to a no-op stub.
  // When the session has a Tracer, pass it to the forwarder so construct-layer
  // spans inherit the runtime traceId via AsyncLocalStorage.
  const trace: ExecutionContext['trace'] = deps.trace
    ? deps.trace
    : deps.traceStore
      ? (createTraceForwarder({
          sessionId: session.id,
          traceStore: deps.traceStore,
          tracer: session.tracer,
        }) as unknown as ExecutionContext['trace'])
      : ({
          startSpan: () => ({ end: () => {} }),
          getCurrentSpan: () => undefined,
          addEvent: () => {},
          logConstraintCheck: () => {},
        } as unknown as ExecutionContext['trace']);

  // Wire stores: merge dep-provided stores with session fact stores, stub the rest.
  // Stubs use Proxy-based no-ops that throw descriptive errors on method calls
  // instead of the old `{} as T` pattern which crashed with "not a function".
  const stores: ExecutionContext['stores'] = {
    conversation:
      deps.stores?.conversation ??
      createNoopStub<StoreContext['conversation']>('ConversationStore'),
    message: deps.stores?.message ?? createNoopStub<StoreContext['message']>('MessageStore'),
    fact:
      deps.stores?.fact ??
      (session.factStore as StoreContext['fact']) ??
      createNoopStub<StoreContext['fact']>('FactStore'),
    trace: deps.stores?.trace ?? createNoopStub<StoreContext['trace']>('TraceStore'),
    audit: deps.stores?.audit ?? createNoopStub<StoreContext['audit']>('AuditStore'),
  };

  // Resolve model: session.resolvedModelId → agentIR.model → config fallback
  const resolvedModel =
    session.resolvedModelId ??
    session.agentIR?.execution?.model ??
    (isConfigLoaded() ? getConfig().llm.defaultModel : 'claude-sonnet-4-20250514');

  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    projectId: session.projectId,
    agentIR: session.agentIR,
    state,
    runtime,
    trace,
    stores,
    llmClient: deps.llmClient ?? createNoopStub<LLMClient>('LLMClient'),
    toolExecutor: deps.toolExecutor ?? createNoopStub<ToolExecutor>('ToolExecutor'),
    messageHistory,
    config: {
      environment: isConfigLoaded()
        ? ((getConfig() as any).environment ?? process.env.NODE_ENV ?? 'dev')
        : (process.env.NODE_ENV ?? 'dev'),
      toolTimeoutMs: isConfigLoaded()
        ? ((getConfig() as any).execution?.toolTimeoutMs ?? 30_000)
        : 30_000,
      llmTimeoutMs: isConfigLoaded()
        ? ((getConfig() as any).execution?.llmTimeoutMs ?? 60_000)
        : 60_000,
      model: resolvedModel,
    },
  };
}

/**
 * Apply a ConstructResult back to a RuntimeSession.
 * Updates session state, data store, and action flags (isComplete, isEscalated).
 */
export function applyExecutionResult(session: RuntimeSession, result: ConstructResult): void {
  // Apply action-level side effects
  if (result.action.type === 'complete') {
    session.isComplete = true;
  } else if (result.action.type === 'escalate') {
    session.isEscalated = true;
    if ('reason' in result.action) {
      session.escalationReason = result.action.reason;
    }
  }

  // Apply state updates
  if (!result.stateUpdates) return;

  const updates = result.stateUpdates;

  if (updates.conversationPhase !== undefined) {
    session.state.conversationPhase = updates.conversationPhase;
  }

  if (updates.gatherProgress !== undefined) {
    session.state.gatherProgress = updates.gatherProgress;
    // Sync gathered values into the data store
    for (const [key, value] of Object.entries(updates.gatherProgress)) {
      session.data.values[key] = value;
      session.data.gatheredKeys.add(key);
    }
  }

  if (updates.context !== undefined) {
    session.state.context = { ...session.state.context, ...updates.context };
    // Sync context values into the data store
    Object.assign(session.data.values, updates.context);
  }
}
