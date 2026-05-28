/**
 * Digital Runtime
 *
 * Omni-channel runtime for web chat, WhatsApp, SMS, email, API.
 * Key characteristics:
 * - Persistent sessions across channels
 * - Checkpointing for resume capability
 * - Full context preservation
 * - Parallel agent and tool execution
 * - Integration with IR-based state management
 *
 * Now integrated with ConstructExecutor for consistent DSL construct execution.
 * Extends BaseRuntime for shared infrastructure (stores, agent registration,
 * execution context building, trace lifecycle, tenant isolation).
 */

import type { AgentIR, SupervisorIR, ToolDefinition } from '../ir/schema.js';
import type { Session, Message, Channel, Environment, CallDisposition } from '../core/types.js';
import type { ConversationStore } from '../stores/conversation-store.js';
import type { MessageStore } from '../stores/message-store.js';
import type { TraceProvider, TraceContextManager } from '../stores/trace-store.js';
import type { AuditStore } from '../stores/audit-store.js';
import type { FactStore } from '../stores/fact-store.js';
import {
  createInitialState,
  interpolateMessage,
  type ExecutionContext,
  type AgentState,
  type LLMClient as ConstructLLMClient,
  type ToolExecutor as ConstructToolExecutor,
  type RuntimeType,
} from '../constructs/index.js';
import {
  BaseRuntime,
  type BaseRuntimeConfig,
  type BaseRuntimeOptions,
  type BuildContextParams,
  type TenantContext,
} from './base-runtime.js';
import { NLUEngine } from '../nlu/index.js';
import { DEFAULT_MESSAGES } from '../constants.js';
import { createLogger, redactSensitive } from '../logger.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface DigitalRuntimeConfig extends BaseRuntimeConfig {
  /** Session idle timeout (ms) */
  sessionTimeoutMs: number;

  /** Enable state checkpointing */
  checkpointEnabled: boolean;

  /** Max conversation history to include */
  maxHistoryMessages: number;
}

export interface DigitalInput {
  /** User message text */
  text: string;

  /** Attachments (images, files) */
  attachments?: Attachment[];

  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  type: 'image' | 'file' | 'audio';
  url?: string;
  data?: Buffer;
  mimeType: string;
  filename?: string;
}

export interface DigitalOutput {
  /** Response text */
  text: string;

  /** Quick replies/suggestions */
  quickReplies?: string[];

  /** Rich cards/components */
  cards?: Card[];

  /** Handoff info if transferring */
  handoff?: HandoffInfo;

  /** Session state */
  sessionComplete: boolean;

  /** Action type for additional handling */
  actionType?: 'response' | 'escalation' | 'handoff' | 'complete' | 'collect';
}

export interface Card {
  type: 'info' | 'action' | 'list';
  title: string;
  subtitle?: string;
  imageUrl?: string;
  actions?: CardAction[];
  items?: CardItem[];
}

export interface CardAction {
  label: string;
  action: string;
  payload?: string;
}

export interface CardItem {
  title: string;
  subtitle?: string;
  value?: string;
}

export interface HandoffInfo {
  toAgent: string;
  reason: string;
  context: Record<string, unknown>;
  returnExpected: boolean;
}

export interface Checkpoint {
  sessionId: string;
  timestamp: Date;
  agentName: string;
  state: AgentState;
  pendingActions: PendingAction[];
}

export interface PendingAction {
  type: 'delegate' | 'handoff' | 'escalate' | 'complete';
  target?: string;
  params: Record<string, unknown>;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string): Promise<Checkpoint | null>;
  delete(sessionId: string): Promise<void>;
}

export interface LLMClient {
  chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): Promise<string>;

  extractJson(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs: number },
  ): Promise<Record<string, unknown>>;

  streamChat?(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): AsyncIterable<string>;
}

export interface ToolExecutor {
  execute(toolName: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;

  executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>>;
}

// =============================================================================
// DIGITAL RUNTIME
// =============================================================================

export class DigitalRuntime extends BaseRuntime {
  private readonly log = createLogger('digital-runtime');
  private checkpointStore?: CheckpointStore;
  private supervisorIR?: SupervisorIR;
  private llmClient: LLMClient;
  private toolExecutor: ToolExecutor;

  constructor(
    config: DigitalRuntimeConfig,
    conversationStore: ConversationStore,
    messageStore: MessageStore,
    traceStore: TraceProvider,
    auditStore: AuditStore,
    factStore: FactStore,
    llmClient: LLMClient,
    toolExecutor: ToolExecutor,
    checkpointStore?: CheckpointStore,
    options?: Omit<BaseRuntimeOptions, 'constructExecutor'>,
  ) {
    super(config, conversationStore, messageStore, traceStore, auditStore, factStore, options);
    this.checkpointStore = checkpointStore;
    this.llmClient = llmClient;
    this.toolExecutor = toolExecutor;
  }

  /** Runtime type identifier */
  get runtimeType(): RuntimeType {
    return 'digital';
  }

  /** Digital-specific config accessor */
  protected get digitalConfig(): DigitalRuntimeConfig {
    return this.config as DigitalRuntimeConfig;
  }

  // ===========================================================================
  // SUPERVISOR RESOLUTION
  // ===========================================================================

  /**
   * Find the supervisor agent from registered agents (has routing configured).
   */
  private resolveSupervisor(): SupervisorIR | undefined {
    if (this.supervisorIR) return this.supervisorIR;
    for (const [, ir] of this.agentIRs) {
      if (ir.routing) {
        this.supervisorIR = ir as SupervisorIR;
        return this.supervisorIR;
      }
    }
    return undefined;
  }

  /**
   * Start or resume a session
   */
  async getOrCreateSession(
    customerId: string | undefined,
    channel: Channel,
    sessionId?: string,
  ): Promise<Session> {
    // Try to resume existing session
    if (sessionId) {
      const session = await this.conversationStore.getSession(sessionId);
      if (session && session.status === 'active') {
        return this.conversationStore.updateSession(sessionId, { channel });
      }
    }

    // Try to find recent session for customer
    if (customerId) {
      const resumed = await this.conversationStore.resumeSession({
        customerId,
        channel,
        maxAgeMs: this.digitalConfig.sessionTimeoutMs,
      });

      if (resumed) {
        this.emit('session:resumed', { sessionId: resumed.id, channel });
        return resumed;
      }
    }

    // Create new session
    this.resolveSupervisor();
    const startAgent = this.supervisorIR?.metadata.name || 'default';
    const agentVersion = this.supervisorIR?.metadata.version || '1.0.0';

    const session = await this.conversationStore.createSession({
      customerId,
      channel,
      environment: this.config.environment,
      agentName: startAgent,
      agentVersion,
    });

    this.emit('session:started', { sessionId: session.id, channel });

    return session;
  }

  /**
   * Process a message in a session
   */
  async processMessage(sessionId: string, input: DigitalInput): Promise<DigitalOutput> {
    const session = await this.conversationStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Load checkpoint if enabled
    let state = await this.loadOrCreateState(sessionId);

    // Start trace
    const trace = this.traceStore.startTrace({
      sessionId,
      agentName: session.currentAgent,
      agentVersion: session.agentVersion,
      environment: session.environment,
    });

    try {
      // Store user message
      await this.messageStore.addMessage({
        sessionId,
        role: 'user',
        content: input.text,
        channel: session.channel,
        traceId: trace.traceId,
        metadata: input.metadata,
      });

      // Get current agent IR
      let agentIR = this.agentIRs.get(session.currentAgent);

      // If supervisor, route first
      let handoffContext: Record<string, unknown> | undefined;
      if (this.supervisorIR && session.currentAgent === this.supervisorIR.metadata.name) {
        const routingResult = await this.routeWithSupervisor(session, input, state, trace);

        if (routingResult.handoff) {
          // Update session to new agent
          await this.conversationStore.updateSession(sessionId, {
            currentAgent: routingResult.handoff.toAgent,
          });

          agentIR = this.agentIRs.get(routingResult.handoff.toAgent);
          handoffContext = routingResult.handoff.context;

          await trace.emitDecision({
            decisionKind: 'handoff',
            decision: routingResult.handoff.toAgent,
            reasoning: routingResult.handoff.reason,
            contextSnapshot: state.context,
          });
        }
      }

      if (!agentIR) {
        throw new Error(`Agent ${session.currentAgent} not found`);
      }

      // Execute agent logic using ConstructExecutor
      const result = await this.executeAgent(session, agentIR, input, state, trace, handoffContext);

      // Save checkpoint
      await this.saveCheckpoint(sessionId, session.currentAgent, result.state);

      // Store assistant message
      await this.messageStore.addMessage({
        sessionId,
        role: 'assistant',
        content: result.text,
        channel: session.channel,
        traceId: trace.traceId,
      });

      // Update session context
      await this.conversationStore.updateSession(sessionId, {
        context: result.state.context,
      });

      // Handle completion
      if (result.sessionComplete) {
        await this.endSession(sessionId, 'completed');
      }

      return result;
    } catch (error) {
      await trace.logError(
        'processing_error',
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined,
      );

      return {
        text: DEFAULT_MESSAGES.error_default,
        sessionComplete: false,
      };
    } finally {
      await trace.end();
    }
  }

  /**
   * Route using supervisor
   */
  private async routeWithSupervisor(
    session: Session,
    input: DigitalInput,
    state: AgentState,
    trace: TraceContextManager,
  ): Promise<{ handoff?: HandoffInfo }> {
    if (!this.supervisorIR) {
      return {};
    }

    const history = await this.messageStore.getMessages({
      sessionId: session.id,
      limit: 5,
    });

    const intentPrompt = `Classify the user's intent based on their message and conversation history.

Available categories: ${this.supervisorIR.routing.intent_classification.categories.join(', ')}

Routing rules:
${this.supervisorIR.routing.rules.map((r) => `- ${r.to}: ${r.description}`).join('\n')}

Respond with JSON: {"category": "...", "confidence": 0.0-1.0, "target_agent": "..."}`;

    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: input.text },
    ];

    try {
      const intentResult = await this.llmClient.extractJson(
        intentPrompt,
        messages,
        '{"category": "string", "confidence": "number", "target_agent": "string"}',
        { model: this.config.model, timeoutMs: this.config.llmTimeoutMs },
      );

      const confidence = typeof intentResult.confidence === 'number' ? intentResult.confidence : 0;
      const targetAgent = intentResult.target_agent as string;

      if (
        confidence >= this.supervisorIR.routing.intent_classification.min_confidence &&
        targetAgent
      ) {
        const rule = this.supervisorIR.routing.rules.find((r) => r.to === targetAgent);

        if (rule) {
          return {
            handoff: {
              toAgent: targetAgent,
              reason: rule.description,
              context: state.context,
              returnExpected: false,
            },
          };
        }
      }

      const defaultAgent = this.supervisorIR.routing.default_agent;
      if (!defaultAgent) {
        return {};
      }

      return {
        handoff: {
          toAgent: defaultAgent,
          reason: 'No confident intent match',
          context: state.context,
          returnExpected: false,
        },
      };
    } catch (error) {
      this.log.warn('Supervisor intent classification failed, routing to default agent', {
        error: error instanceof Error ? error.message : String(error),
        defaultAgent: this.supervisorIR.routing.default_agent,
      });
      const defaultAgent = this.supervisorIR.routing.default_agent;
      if (!defaultAgent) {
        return {};
      }
      return {
        handoff: {
          toAgent: defaultAgent,
          reason: 'Intent classification failed',
          context: state.context,
          returnExpected: false,
        },
      };
    }
  }

  /**
   * Execute agent logic using ConstructExecutor
   */
  private async executeAgent(
    session: Session,
    agentIR: AgentIR,
    input: DigitalInput,
    state: AgentState,
    trace: TraceContextManager,
    handoffContext?: Record<string, unknown>,
  ): Promise<DigitalOutput & { state: AgentState }> {
    // Fetch message history for NLU context
    const history = await this.messageStore.getMessages({
      sessionId: session.id,
      limit: this.digitalConfig.maxHistoryMessages,
    });
    const messageHistory = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Create NLU engine from agent IR (uses ABL NLU config if available, else zero-config)
    const nluEngine = NLUEngine.fromAgentIR(agentIR, this.adaptLLMClient());

    // Build execution context via base class
    const executionContext = super.buildExecutionContext({
      sessionId: session.id,
      agentIR,
      state,
      userInput: input.text,
      trace,
      runtimeType: this.runtimeType,
      nluEngine,
      messageHistory,
      handoffContext,
    });

    // Execute all constructs
    const executionResult = await this.constructExecutor.execute(executionContext);

    // Get the final state
    const finalState = executionResult.state;

    // Handle the action result
    const action = executionResult.action;

    switch (action.type) {
      case 'escalate':
        await trace.logEscalation(action.reason, action.priority, finalState.context);

        return {
          text: `I'm connecting you with a specialist. ${action.reason}`,
          sessionComplete: false,
          handoff: {
            toAgent: 'Live_Agent_Transfer',
            reason: action.reason,
            context: finalState.context,
            returnExpected: false,
          },
          actionType: 'escalation',
          state: finalState,
        };

      case 'handoff':
        await trace.logHandoff(action.target, action.summary || 'Agent transfer', action.context);

        return {
          text: action.summary || `Transferring you to ${action.target}`,
          sessionComplete: false,
          handoff: {
            toAgent: action.target,
            reason: action.summary || '',
            context: action.context,
            returnExpected: action.returnExpected,
          },
          actionType: 'handoff',
          state: finalState,
        };

      case 'complete':
        return {
          text:
            action.message ||
            agentIR?.messages?.conversation_complete ||
            DEFAULT_MESSAGES.conversation_complete,
          sessionComplete: true,
          actionType: 'complete',
          state: finalState,
        };

      case 'respond':
        return {
          text: action.message,
          sessionComplete: false,
          quickReplies: this.generateQuickReplies(agentIR, finalState),
          actionType: 'response',
          state: finalState,
        };

      case 'collect':
        // Generate a prompt for collecting missing fields
        const collectPrompt = this.generateCollectPrompt(
          agentIR,
          action.fields,
          action.prompts,
          finalState,
        );
        return {
          text: collectPrompt,
          sessionComplete: false,
          quickReplies: this.generateQuickReplies(agentIR, finalState),
          actionType: 'collect',
          state: finalState,
        };

      case 'block':
        return {
          text:
            action.reason ||
            agentIR?.messages?.constraint_blocked ||
            DEFAULT_MESSAGES.constraint_blocked,
          sessionComplete: false,
          state: finalState,
        };

      case 'continue':
      default:
        // Generate response using LLM
        const response = await this.generateResponse(agentIR, session, input, finalState, trace);
        return {
          ...response,
          sessionComplete: false,
          state: finalState,
        };
    }
  }

  // ===========================================================================
  // ADAPTER HOOKS (required by BaseRuntime)
  // ===========================================================================

  /**
   * Adapt LLM client to ConstructExecutor interface
   */
  protected adaptLLMClient(): ConstructLLMClient {
    return {
      chat: (systemPrompt, messages, options) =>
        this.llmClient.chat(systemPrompt, messages, options),
      chatWithTools: async (systemPrompt, messages, tools, options) => {
        // Delegate to the underlying provider's LLMClient if available via extractJson fallback
        const text = await this.llmClient.chat(
          systemPrompt,
          messages.map((m) => ({
            role: typeof m.content === 'string' ? m.role : m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          options,
        );
        return { text, toolCalls: [], stopReason: 'end_turn' as const };
      },
      extractJson: (systemPrompt, messages, schema, options) =>
        this.llmClient.extractJson(systemPrompt, messages, schema, options),
      streamChat: this.llmClient.streamChat?.bind(this.llmClient),
    };
  }

  /**
   * Adapt tool executor to ConstructExecutor interface
   */
  protected adaptToolExecutor(): ConstructToolExecutor {
    return {
      execute: (toolName, params, timeoutMs) =>
        this.toolExecutor.execute(toolName, params, timeoutMs),
      executeParallel: (calls, timeoutMs) => this.toolExecutor.executeParallel(calls, timeoutMs),
    };
  }

  // ===========================================================================
  // DIGITAL-SPECIFIC HELPERS
  // ===========================================================================

  /**
   * Generate collect prompt for missing fields
   */
  private generateCollectPrompt(
    agentIR: AgentIR,
    fields: string[],
    prompts: Record<string, string>,
    state: AgentState,
  ): string {
    if (fields.length === 0) {
      return agentIR?.messages?.greeting || DEFAULT_MESSAGES.greeting;
    }

    // For digital, we can ask for multiple fields
    const fieldPrompts = fields.map((f) => prompts[f] || `Your ${f}`);

    if (fieldPrompts.length === 1) {
      return fieldPrompts[0];
    }

    return `I need a few more details. Could you provide:\n${fieldPrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
  }

  /**
   * Generate response using LLM
   */
  private async generateResponse(
    agentIR: AgentIR,
    session: Session,
    input: DigitalInput,
    state: AgentState,
    trace: TraceContextManager,
  ): Promise<{ text: string; quickReplies?: string[]; cards?: Card[] }> {
    const history = await this.messageStore.getMessages({
      sessionId: session.id,
      limit: this.digitalConfig.maxHistoryMessages,
    });

    // Find missing required fields
    const missingFields = agentIR.gather.fields
      .filter((f) => f.required && !state.gatherProgress[f.name])
      .map((f) => f.name);

    // Build prompt
    let systemPrompt = agentIR.identity.system_prompt.template;

    if (missingFields.length > 0) {
      systemPrompt += `\n\nYou need to collect: ${missingFields.join(', ')}`;
      const nextField = agentIR.gather.fields.find((f) => f.name === missingFields[0]);
      if (nextField) {
        systemPrompt += `\nAsk about: ${nextField.prompt}`;
      }
    }

    systemPrompt += `\n\nCurrent context: ${JSON.stringify(redactSensitive(state.context))}`;

    const messages = history.map((m) => ({ role: m.role, content: m.content }));

    const response = await this.llmClient.chat(systemPrompt, messages, {
      model: this.config.model,
      timeoutMs: this.config.llmTimeoutMs,
    });

    const quickReplies = this.generateQuickReplies(agentIR, state);

    return {
      text: response,
      quickReplies: quickReplies.length > 0 ? quickReplies : undefined,
    };
  }

  /**
   * Generate quick reply suggestions
   */
  private generateQuickReplies(agentIR: AgentIR, state: AgentState): string[] {
    const replies: string[] = [];

    // Suggest options from the next pending gather field with defined values
    if (agentIR.gather?.fields) {
      for (const field of agentIR.gather.fields) {
        const fieldValues = (field as any).values;
        if (!state.gatherProgress[field.name] && fieldValues && fieldValues.length > 0) {
          replies.push(...fieldValues.slice(0, 4));
          break; // Only suggest for the first missing field
        }
      }
    }

    return replies.slice(0, 4);
  }

  // ==========================================================================
  // STATE MANAGEMENT
  // ==========================================================================

  private async loadOrCreateState(sessionId: string): Promise<AgentState> {
    if (this.checkpointStore && this.digitalConfig.checkpointEnabled) {
      const checkpoint = await this.checkpointStore.load(sessionId);
      if (checkpoint) {
        return checkpoint.state;
      }
    }

    return createInitialState();
  }

  private async saveCheckpoint(
    sessionId: string,
    agentName: string,
    state: AgentState,
  ): Promise<void> {
    if (this.checkpointStore && this.digitalConfig.checkpointEnabled) {
      await this.checkpointStore.save({
        sessionId,
        timestamp: new Date(),
        agentName,
        state,
        pendingActions: [],
      });
    }
  }

  /**
   * End a session
   */
  async endSession(sessionId: string, disposition: CallDisposition): Promise<void> {
    const session = await this.conversationStore.getSession(sessionId);
    if (!session) return;

    await this.conversationStore.endSession(sessionId, disposition);

    if (this.checkpointStore) {
      await this.checkpointStore.delete(sessionId);
    }

    this.emit('session:ended', { sessionId, disposition });
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createDigitalRuntime(
  config: DigitalRuntimeConfig,
  conversationStore: ConversationStore,
  messageStore: MessageStore,
  traceStore: TraceProvider,
  auditStore: AuditStore,
  factStore: FactStore,
  llmClient: LLMClient,
  toolExecutor: ToolExecutor,
  checkpointStore?: CheckpointStore,
): DigitalRuntime {
  return new DigitalRuntime(
    config,
    conversationStore,
    messageStore,
    traceStore,
    auditStore,
    factStore,
    llmClient,
    toolExecutor,
    checkpointStore,
  );
}
