/**
 * Base Runtime
 *
 * Abstract base class for all runtimes (Digital, Voice, Workflow).
 * Provides shared infrastructure:
 * - Store management (conversation, trace, audit, fact)
 * - Agent IR registration and lookup
 * - Execution context building
 * - Trace lifecycle management
 * - Tenant isolation context
 * - Rate limiting hooks
 */

import { EventEmitter } from 'events';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import type { AgentIR } from '../ir/schema.js';
import type { Environment } from '../core/types.js';
import type { ConversationStore } from '../stores/conversation-store.js';
import type { MessageStore } from '../stores/message-store.js';
import type { TraceProvider, TraceContextManager } from '../stores/trace-store.js';
import type { AuditStore } from '../stores/audit-store.js';
import type { FactStore } from '../stores/fact-store.js';
import type { ContactStore } from '../stores/contact-store.js';
import type { WorkflowDefinitionStore } from '../stores/workflow-definition-store.js';
import {
  createInitialState,
  type ExecutionContext,
  type ConstructResult,
  type ConstructAction,
  type AgentState,
  type LLMClient as ConstructLLMClient,
  type ToolExecutor as ConstructToolExecutor,
  type StoreContext,
  type RuntimeType,
  type ConstructExecutionConfig,
  type NLUEngineInterface,
} from '../constructs/index.js';

/**
 * @deprecated Legacy interface — execution has moved to apps/runtime.
 * Minimal type for the construct executor that legacy runtimes depend on.
 */
export interface LegacyConstructExecutor {
  execute(
    context: ExecutionContext,
    options?: Record<string, unknown>,
  ): Promise<{
    action: ConstructAction;
    state: AgentState;
    phaseResults: Record<string, ConstructResult | null>;
    metadata: Record<string, unknown>;
  }>;
  executeConstraints?(context: ExecutionContext): Promise<ConstructResult>;
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface BaseRuntimeConfig {
  /** Environment */
  environment: Environment;

  /** Tool execution timeout (ms) */
  toolTimeoutMs: number;

  /** LLM call timeout (ms) */
  llmTimeoutMs: number;

  /** Default model */
  model: string;

  /** Tenant ID for isolation */
  tenantId?: string;

  /** Per-tenant rate limit configuration */
  rateLimiting?: RuntimeRateLimitConfig;
}

export interface RuntimeRateLimitConfig {
  /** API requests per minute */
  requestsPerMinute: number;

  /** LLM tokens per minute */
  tokensPerMinute: number;

  /** Max concurrent sessions */
  concurrentSessions: number;

  /** Tool calls per minute */
  toolCallsPerMinute: number;
}

export interface TenantContext {
  tenantId: string;
  userId?: string;
  projectId?: string;
  permissions?: string[];
}

export interface BuildContextParams {
  sessionId: string;
  agentIR: AgentIR;
  state: AgentState;
  userInput?: string;
  trace: TraceContextManager;
  runtimeType: RuntimeType;
  extraConfig?: Partial<ConstructExecutionConfig>;
  /** NLU engine instance (optional — when available, enables contextual NLU) */
  nluEngine?: NLUEngineInterface;
  /** Conversation message history for NLU context building */
  messageHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Context from supervisor handoff to merge into child agent state */
  handoffContext?: Record<string, unknown>;
}

// =============================================================================
// RUNTIME OPTIONS
// =============================================================================

export interface BaseRuntimeOptions {
  contactStore?: ContactStore;
  workflowDefinitionStore?: WorkflowDefinitionStore;
  constructExecutor?: LegacyConstructExecutor;
}

// =============================================================================
// ABSTRACT BASE RUNTIME
// =============================================================================

export abstract class BaseRuntime extends EventEmitter {
  protected readonly config: BaseRuntimeConfig;
  protected readonly conversationStore: ConversationStore;
  protected readonly messageStore: MessageStore;
  protected readonly traceStore: TraceProvider;
  protected readonly auditStore: AuditStore;
  protected readonly factStore: FactStore;
  protected readonly constructExecutor: LegacyConstructExecutor;
  protected readonly contactStore?: ContactStore;
  protected readonly workflowDefinitionStore?: WorkflowDefinitionStore;
  protected readonly agentIRs: Map<string, AgentIR> = new Map();
  protected readonly tenantContext?: TenantContext;

  constructor(
    config: BaseRuntimeConfig,
    conversationStore: ConversationStore,
    messageStore: MessageStore,
    traceStore: TraceProvider,
    auditStore: AuditStore,
    factStore: FactStore,
    options?: BaseRuntimeOptions,
  ) {
    super();
    this.config = config;
    this.conversationStore = conversationStore;
    this.messageStore = messageStore;
    this.traceStore = traceStore;
    this.auditStore = auditStore;
    this.factStore = factStore;
    if (!options?.constructExecutor) {
      throw new Error(
        'constructExecutor is required — ConstructExecutor class has been removed. Inject an executor via options.',
      );
    }
    this.constructExecutor = options.constructExecutor;
    this.contactStore = options?.contactStore;
    this.workflowDefinitionStore = options?.workflowDefinitionStore;

    if (config.tenantId) {
      this.tenantContext = { tenantId: config.tenantId };
    }
  }

  /** Runtime type identifier */
  abstract get runtimeType(): RuntimeType;

  // ===========================================================================
  // AGENT REGISTRATION
  // ===========================================================================

  /**
   * Register a single agent IR
   */
  registerAgent(ir: AgentIR): void {
    this.agentIRs.set(ir.metadata.name, ir);
  }

  /**
   * Register multiple agent IRs
   */
  registerAgents(agents: Record<string, AgentIR>): void {
    for (const [name, ir] of Object.entries(agents)) {
      this.agentIRs.set(name, ir);
    }
  }

  /**
   * Get a registered agent IR by name
   */
  getAgentIR(name: string): AgentIR | undefined {
    return this.agentIRs.get(name);
  }

  // ===========================================================================
  // EXECUTION CONTEXT
  // ===========================================================================

  /**
   * Build a standard ExecutionContext for ConstructExecutor.
   * Shared across all runtimes — each runtime passes its specific params.
   */
  protected buildExecutionContext(params: BuildContextParams): ExecutionContext {
    const storeContext: StoreContext = {
      conversation: this.conversationStore,
      message: this.messageStore,
      fact: this.factStore,
      trace: this.traceStore,
      audit: this.auditStore,
      contact: this.contactStore,
      workflowDefinition: this.workflowDefinitionStore,
    };

    // Merge handoff context into agent state if provided (supervisor → child agent)
    const state =
      params.handoffContext && Object.keys(params.handoffContext).length > 0
        ? { ...params.state, context: { ...params.state.context, ...params.handoffContext } }
        : params.state;

    return {
      sessionId: params.sessionId,
      agentIR: params.agentIR,
      state,
      runtime: params.runtimeType,
      trace: params.trace,
      stores: storeContext,
      llmClient: this.adaptLLMClient(),
      toolExecutor: this.adaptToolExecutor(),
      agentRegistry: {
        getAgentIR: (name) => this.agentIRs.get(name) || null,
        listAgents: () => Array.from(this.agentIRs.keys()),
        hasAgent: (name) => this.agentIRs.has(name),
      },
      userInput: params.userInput,
      config: {
        environment: this.config.environment,
        toolTimeoutMs: this.config.toolTimeoutMs,
        llmTimeoutMs: this.config.llmTimeoutMs,
        model: this.config.model,
        ...params.extraConfig,
      },
      nluEngine: params.nluEngine,
      messageHistory: params.messageHistory,
    };
  }

  /**
   * Create initial agent state with optional context
   */
  protected createInitialAgentState(initialContext?: Record<string, unknown>): AgentState {
    return createInitialState(initialContext);
  }

  // ===========================================================================
  // TRACE LIFECYCLE
  // ===========================================================================

  /**
   * Start a trace for a session/agent pair
   */
  protected startTrace(
    sessionId: string,
    agentName: string,
    agentVersion: string,
  ): TraceContextManager {
    return this.traceStore.startTrace({
      sessionId,
      agentName,
      agentVersion,
      environment: this.config.environment,
    });
  }

  /**
   * Execute a function within a trace lifecycle (start → execute → end/error)
   */
  protected async withTraceLifecycle<T>(
    params: { sessionId: string; agentName: string; agentVersion: string },
    fn: (trace: TraceContextManager) => Promise<T>,
    onError?: (trace: TraceContextManager, error: unknown) => Promise<T>,
  ): Promise<T> {
    const trace = this.startTrace(params.sessionId, params.agentName, params.agentVersion);

    try {
      const result = await fn(trace);
      return result;
    } catch (error) {
      await trace.logError(
        'processing_error',
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined,
      );

      if (onError) {
        return onError(trace, error);
      }
      throw error;
    } finally {
      await trace.end();
    }
  }

  // ===========================================================================
  // ADAPTER HOOKS (subclasses can override for runtime-specific adapters)
  // ===========================================================================

  /**
   * Adapt the runtime's LLM client to the ConstructExecutor interface.
   * Subclasses MUST override this to provide their LLM client adaptation.
   */
  protected abstract adaptLLMClient(): ConstructLLMClient;

  /**
   * Adapt the runtime's tool executor to the ConstructExecutor interface.
   * Subclasses MUST override this to provide their tool executor adaptation.
   */
  protected abstract adaptToolExecutor(): ConstructToolExecutor;

  // ===========================================================================
  // TENANT ISOLATION
  // ===========================================================================

  /**
   * Assert that the current tenant has access to a resource
   */
  protected assertTenantAccess(resourceTenantId: string): void {
    if (!this.tenantContext) return; // No tenant isolation configured
    if (this.tenantContext.tenantId !== resourceTenantId) {
      throw new TenantAccessError('access', this.tenantContext.tenantId, resourceTenantId);
    }
  }

  /**
   * Scope a query object to the current tenant
   */
  protected scopeToTenant<T extends Record<string, unknown>>(query: T): T & { tenantId: string } {
    if (!this.tenantContext) {
      return query as T & { tenantId: string };
    }
    return { ...query, tenantId: this.tenantContext.tenantId };
  }

  /**
   * Check rate limits for an operation (no-op if rate limiting not configured)
   */
  protected async checkRateLimit(operation: string): Promise<void> {
    if (!this.config.rateLimiting || !this.tenantContext) return;
    // Rate limit checking is delegated to the platform middleware layer.
    // This hook exists so runtimes can integrate with external rate limiters.
    this.emit('rateLimit:check', {
      tenantId: this.tenantContext.tenantId,
      operation,
      config: this.config.rateLimiting,
    });
  }
}

// =============================================================================
// TENANT ACCESS ERROR
// =============================================================================

export class TenantAccessError extends AppError {
  public readonly operation: string;
  public readonly tenantId: string;
  public readonly resourceId: string;

  constructor(operation: string, tenantId: string, resourceId: string) {
    super(
      `Tenant ${tenantId} cannot ${operation} resource ${resourceId}: cross-tenant access denied`,
      {
        ...ErrorCodes.TENANT_ACCESS_DENIED,
      },
    );
    this.operation = operation;
    this.tenantId = tenantId;
    this.resourceId = resourceId;
  }
}
