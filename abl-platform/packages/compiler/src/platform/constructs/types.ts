/**
 * Construct Executor Types
 *
 * Shared types used by all construct executors.
 * These provide the foundation for consistent execution across all runtimes.
 */

import type { AgentIR } from '../ir/schema.js';
import type { Session, Environment, TraceContext } from '../core/types.js';
import type { ConversationStore } from '../stores/conversation-store.js';
import type { MessageStore } from '../stores/message-store.js';
import type { TraceEventSink, TraceContextManager } from '../stores/trace-store.js';
import type { AuditStore } from '../stores/audit-store.js';
import type { FactStore } from '../stores/fact-store.js';
import type { ContactStore } from '../stores/contact-store.js';
import type { WorkflowDefinitionStore } from '../stores/workflow-definition-store.js';

// =============================================================================
// RUNTIME TYPES
// =============================================================================

export type RuntimeType = 'voice' | 'digital' | 'workflow';

// =============================================================================
// EXECUTION CONTEXT
// =============================================================================

/**
 * ExecutionContext provides all the context needed for construct execution.
 * Passed to every executor for consistent behavior across runtimes.
 */
export interface ExecutionContext {
  /** Current session ID */
  sessionId: string;

  /** Tenant ID — scopes all data access to the owning tenant */
  tenantId?: string;

  /** Project ID — scopes data access within a tenant's project */
  projectId?: string;

  /** Agent IR being executed */
  agentIR: AgentIR;

  /** Current agent state */
  state: AgentState;

  /** Runtime type (affects behavior) */
  runtime: RuntimeType;

  /** Trace context manager */
  trace: TraceContextManager;

  /** Store instances */
  stores: StoreContext;

  /** LLM client for intelligent operations */
  llmClient: LLMClient;

  /** Tool executor for running tools */
  toolExecutor: ToolExecutor;

  /** Agent registry for delegate/handoff operations */
  agentRegistry?: ConstructAgentRegistry;

  /** Current user input */
  userInput?: string;

  /** Detected locale (e.g. 'en', 'es', 'fr') for locale-aware extraction */
  locale?: string;

  /** Configuration */
  config: ConstructExecutionConfig;

  /** Conversation message history (for NLU context building) */
  messageHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;

  /** NLU engine instance (optional — when available, enables contextual NLU) */
  nluEngine?: NLUEngineInterface;
}

/**
 * NLU engine interface — decoupled from the concrete NLUEngine class
 * to avoid circular dependencies
 */
export interface NLUEngineInterface {
  detectIntent(
    ctx: unknown,
    candidates: unknown[],
  ): Promise<{ intent: string | null; confidence: number; source: string }>;
  classifyCategory(
    ctx: unknown,
    categories: unknown[],
  ): Promise<{ category: string | null; confidence: number; source: string }>;
  extractEntities(
    ctx: unknown,
    fields: unknown[],
  ): Promise<{
    values: Record<string, unknown>;
    missing: string[];
    confidence: Record<string, number>;
    source: string;
  }>;
  detectCorrection(
    ctx: unknown,
    collected: Record<string, unknown>,
  ): Promise<{
    detected: boolean;
    field?: string;
    newValue?: unknown;
    confidence: number;
    source: string;
  }>;
  detectDigression(
    ctx: unknown,
    digressions: unknown[],
  ): Promise<{ detected: boolean; intent?: string; confidence: number; source: string }>;
  analyzeInput(ctx: unknown, options: unknown): Promise<unknown>;
}

/**
 * Store context provides access to all stores
 */
export interface StoreContext {
  conversation: ConversationStore;
  message: MessageStore;
  fact: FactStore;
  trace: TraceEventSink;
  audit: AuditStore;
  contact?: ContactStore;
  workflowDefinition?: WorkflowDefinitionStore;
}

/**
 * Execution configuration for construct execution
 * Note: Named ConstructExecutionConfig to avoid conflict with IR ExecutionConfig
 */
export interface ConstructExecutionConfig {
  /** Environment */
  environment: Environment;

  /** Tool timeout in ms */
  toolTimeoutMs: number;

  /** LLM timeout in ms */
  llmTimeoutMs: number;

  /** Model to use */
  model: string;

  /** Maximum parallel tools */
  maxParallelTools?: number;
}

// =============================================================================
// AGENT STATE
// =============================================================================

/**
 * AgentState tracks all runtime state for the agent
 */
export interface AgentState {
  /** Arbitrary context data */
  context: Record<string, unknown>;

  /** Current conversation phase */
  conversationPhase: string;

  /** Progress on gathering fields */
  gatherProgress: Record<string, unknown>;

  /** Results of constraint checks */
  constraintResults: Record<string, boolean>;

  /** Results from last tool executions */
  lastToolResults: Record<string, unknown>;

  /** Memory state */
  memory: MemoryState;

  /** Flow state (for scripted mode) */
  flowState?: FlowState;

  /** Error state */
  errorState?: ErrorState;
}

/**
 * Memory state for session and persistent memory
 */
export interface MemoryState {
  /** Session-scoped variables */
  session: Record<string, unknown>;

  /** Cached persistent memory values */
  persistentCache: Record<string, unknown>;

  /** Pending remember triggers */
  pendingRemembers: RememberAction[];
}

/**
 * Flow state for scripted execution
 */
export interface FlowState {
  /** Current step name */
  currentStep: string;

  /** Step execution history */
  stepHistory: string[];

  /** Step results */
  stepResults: Record<string, unknown>;

  /** Whether flow is complete */
  isComplete: boolean;

  // --- Enhanced flow state for digressions and GATHER ---

  /** Step to resume after digression completes */
  pendingResumeStep?: string;

  /** Step where digression started (for context) */
  digressionSource?: string;

  /** Fields currently being collected (waiting for user input) */
  waitingForInput?: string[];

  /** Collected data from GATHER steps (progressive collection) */
  collectedData: Record<string, unknown>;

  /** Fields already collected in current GATHER step */
  gatherFieldsCollected?: string[];

  /** Last detected intent (for tracking) */
  lastIntent?: string;

  /** Whether currently in a digression */
  inDigression?: boolean;
}

/**
 * Error state for tracking errors
 */
export interface ErrorState {
  /** Error type */
  type: string;

  /** Error message */
  message: string;

  /** Stack trace if available */
  stack?: string;

  /** Retry count */
  retryCount: number;

  /** Original error */
  originalError?: unknown;
}

/**
 * Pending remember action
 */
export interface RememberAction {
  /** Target path in fact store */
  target: string;

  /** Value to store */
  value: unknown;

  /** Time-to-live */
  ttl?: number;
}

// =============================================================================
// CONSTRUCT ACTIONS (Results)
// =============================================================================

/**
 * ConstructAction represents the outcome of executing a construct.
 * The runtime uses this to determine what to do next.
 */
export type ConstructAction =
  | ContinueAction
  | RespondAction
  | EscalateAction
  | HandoffAction
  | DelegateAction
  | CompleteAction
  | RetryAction
  | BlockAction
  | CollectAction;

/**
 * Continue with normal processing
 */
export interface ContinueAction {
  type: 'continue';
  /** Optional data to merge into context */
  data?: Record<string, unknown>;
}

/**
 * Respond to the user with a message
 */
export interface RespondAction {
  type: 'respond';
  /** Message to send */
  message: string;
  /** Whether to continue processing after response */
  continueProcessing?: boolean;
  /** Voice-specific overrides for this message */
  voiceConfig?: import('../ir/schema.js').VoiceConfigIR;
}

/**
 * Escalate to human agent
 */
export interface EscalateAction {
  type: 'escalate';
  /** Reason for escalation */
  reason: string;
  /** Priority level */
  priority: 'low' | 'medium' | 'high' | 'critical';
  /** Context for human agent */
  context?: Record<string, unknown>;
  /** Skill tags for routing */
  skillTags?: string[];
  /** Queue name */
  queue?: string;
}

/**
 * Handoff to another agent
 */
export interface HandoffAction {
  type: 'handoff';
  /** Target agent name */
  target: string;
  /** Context to pass */
  context: Record<string, unknown>;
  /** Summary for target agent */
  summary?: string;
  /** Memory grants for target agent */
  memoryGrants?: string[];
  /** Whether control should return */
  returnExpected: boolean;
}

/**
 * Delegate to a sub-agent
 */
export interface DelegateAction {
  type: 'delegate';
  /** Target agent name */
  agent: string;
  /** Input for sub-agent */
  input: Record<string, unknown>;
  /** How to use the result */
  useResult: string;
  /** Timeout in ms */
  timeout?: number;
}

/**
 * Complete the session
 */
export interface CompleteAction {
  type: 'complete';
  /** Optional completion message */
  message?: string;
  /** Data to store on completion */
  store?: Record<string, unknown>;
}

/**
 * Retry after an error
 */
export interface RetryAction {
  type: 'retry';
  /** Delay before retry in ms */
  delay: number;
  /** What to retry */
  target?: string;
}

/**
 * Block the action (constraint violation)
 */
export interface BlockAction {
  type: 'block';
  /** Reason for blocking */
  reason: string;
  /** Constraint that caused the block */
  constraint?: string;
}

/**
 * Collect more information from user
 */
export interface CollectAction {
  type: 'collect';
  /** Fields to collect */
  fields: string[];
  /** Prompts for each field */
  prompts: Record<string, string>;
}

// =============================================================================
// CONSTRUCT RESULT
// =============================================================================

/**
 * ConstructResult is the unified return type for all construct executors.
 */
export interface ConstructResult {
  /** The action to take */
  action: ConstructAction;

  /** Updated state (if any) */
  stateUpdates?: Partial<AgentState>;

  /** Metadata about the execution */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// EXECUTOR INTERFACES
// =============================================================================

/**
 * Base interface for all construct executors
 */
export interface ConstructExecutorInterface {
  /**
   * Execute the construct
   */
  execute(context: ExecutionContext): Promise<ConstructResult>;

  /**
   * Check if this executor should run
   */
  shouldExecute?(context: ExecutionContext): boolean;
}

// =============================================================================
// EXTERNAL DEPENDENCIES
// =============================================================================

/**
 * Tool definition for LLM tool use
 */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
      }
    >;
    required?: string[];
  };
}

/**
 * Tool call from LLM
 */
export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to send back to LLM
 */
export interface LLMToolResult {
  tool_use_id: string;
  content: string;
}

/**
 * Result from chat with tools
 */
export interface LLMToolUseResult {
  /** Text response (if any) */
  text?: string;
  /** Tool calls requested by LLM */
  toolCalls: LLMToolCall[];
  /** Provider-normalized assistant content blocks to replay on the next turn */
  rawContent?: Array<{ type: string; [key: string]: unknown }>;
  /** Whether LLM wants to stop (end_turn) */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

/**
 * LLM client interface
 */
export interface LLMClient {
  /** Standard chat completion */
  chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): Promise<string>;

  /** Chat with tool use support */
  chatWithTools(
    systemPrompt: string,
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; [key: string]: unknown }>;
    }>,
    tools: LLMToolDefinition[],
    options: { model: string; timeoutMs: number; maxTokens?: number },
  ): Promise<LLMToolUseResult>;

  /** Chat with streaming response */
  streamChat?(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): AsyncIterable<string>;

  /** Extract structured JSON from text */
  extractJson(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs: number },
  ): Promise<Record<string, unknown>>;
}

/**
 * Tool executor interface
 */
export interface ToolExecutor {
  /** Execute a single tool */
  execute(toolName: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;

  /** Execute multiple tools in parallel */
  executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>>;
}

/**
 * Imperative memory API for code tools (sandbox/lambda).
 * Function names match the legacy product for migration compatibility.
 * Scope is auto-resolved from MEMORY declarations — no scope argument needed.
 */
export interface ToolMemoryAPI {
  /** Read a memory value by key. Returns { data: { content: <value> } } for legacy compat. */
  get_content(key: string): Promise<{ data: { content: unknown } }>;
  /** Write a memory value by key. Value is stored wrapped as { data: { content: value } }. */
  set_content(key: string, value: unknown): Promise<void>;
  /** Delete a memory value by key. Returns true if the key existed. */
  delete_content(key: string): Promise<boolean>;
}

/**
 * Agent registry interface for delegate/handoff operations
 * Note: Named ConstructAgentRegistry to avoid conflict with stores AgentRegistry
 */
export interface ConstructAgentRegistry {
  /** Get agent IR by name */
  getAgentIR(agentName: string, environment: Environment): AgentIR | null;

  /** List available agents */
  listAgents(environment: Environment): string[];

  /** Check if agent exists */
  hasAgent(agentName: string, environment: Environment): boolean;
}

// =============================================================================
// HELPER TYPES
// =============================================================================

/**
 * Provenance of an extracted value — how it was obtained
 */
export type ExtractionProvenance = 'explicit' | 'inferred' | 'default' | 'previously_collected';

/**
 * Extraction result from gather operations
 */
export interface ExtractionResult {
  /** Extracted values */
  values: Record<string, unknown>;

  /** Fields that couldn't be extracted */
  missing: string[];

  /** Confidence scores per field */
  confidence?: Record<string, number>;

  /** Validation errors */
  validationErrors?: Record<string, string>;

  /** Provenance tracking for each extracted field */
  provenance?: Record<string, ExtractionProvenance>;
}

/**
 * Constraint check result
 */
export interface ConstraintCheckResult {
  /** Whether all constraints passed */
  passed: boolean;

  /** Failed constraints */
  failures: Array<{
    constraint: string;
    action: ConstructAction;
  }>;

  /** All constraint results */
  results: Record<string, boolean>;
}

/**
 * Pattern definition for extraction
 */
export interface ExtractionPattern {
  /** Pattern type */
  type: 'regex' | 'keyword' | 'format';

  /** The pattern */
  pattern: string;

  /** Groups to extract */
  groups?: string[];

  /** Post-processing */
  transform?: (value: string) => unknown;
}

// EXTRACTION_PATTERNS removed - all extraction is now done via LLM

// =============================================================================
// FACTORY HELPERS
// =============================================================================

/**
 * Create initial agent state
 */
export function createInitialState(initialContext: Record<string, unknown> = {}): AgentState {
  return {
    context: { ...initialContext },
    conversationPhase: 'start',
    gatherProgress: {},
    constraintResults: {},
    lastToolResults: {},
    memory: {
      session: {},
      persistentCache: {},
      pendingRemembers: [],
    },
  };
}

/**
 * Create a continue action
 */
export function continueAction(data?: Record<string, unknown>): ConstructAction {
  return { type: 'continue', data };
}

/**
 * Create a respond action
 */
export function respondAction(
  message: string,
  continueProcessing = false,
  voiceConfig?: import('../ir/schema.js').VoiceConfigIR,
): ConstructAction {
  return { type: 'respond', message, continueProcessing, voiceConfig };
}

/**
 * Create an escalate action
 */
export function escalateAction(
  reason: string,
  priority: 'low' | 'medium' | 'high' | 'critical' = 'medium',
  context?: Record<string, unknown>,
): ConstructAction {
  return { type: 'escalate', reason, priority, context };
}

/**
 * Create a handoff action
 */
export function handoffAction(
  target: string,
  context: Record<string, unknown>,
  returnExpected = false,
  summary?: string,
): ConstructAction {
  return { type: 'handoff', target, context, returnExpected, summary };
}

/**
 * Create a complete action
 */
export function completeAction(message?: string, store?: Record<string, unknown>): ConstructAction {
  return { type: 'complete', message, store };
}

/**
 * Create a block action
 */
export function blockAction(reason: string, constraint?: string): ConstructAction {
  return { type: 'block', reason, constraint };
}

/**
 * Create a collect action
 */
export function collectAction(fields: string[], prompts: Record<string, string>): ConstructAction {
  return { type: 'collect', fields, prompts };
}
