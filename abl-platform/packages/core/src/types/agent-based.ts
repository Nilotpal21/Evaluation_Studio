/**
 * Unified Agent ABL Types
 *
 * Single agent type with per-step execution control:
 * - GOAL is mandatory on every agent
 * - Each flow step declares REASONING: true/false
 * - Agents without FLOW are reasoning-only
 */

import type { DocumentMeta, TypeDefinition } from './base.js';
import type { Expression, Condition } from './expressions.js';

// =============================================================================
// EXECUTION MODE (DEPRECATED — retained for backward-compatible deserialization)
// =============================================================================

/**
 * @deprecated MODE is deleted from ABL. Execution style is derived from
 * flow presence (hasFlow) and per-step REASONING: true/false declarations.
 * Retained only for backward-compatible deserialization of old IR blobs.
 */
export type ExecutionMode = 'reasoning' | 'scripted';

// =============================================================================
// VOICE CONFIG
// =============================================================================

/** Voice-specific overrides for a RESPOND/PROMPT message */
export interface VoiceConfigAST {
  ssml?: string; // W3C SSML markup for Google/Azure/Polly TTS
  instructions?: string; // Natural language voice style instructions (OpenAI Realtime, Gemini Live)
  plainText?: string; // Voice-optimized plaintext (ElevenLabs, fallback for all engines)
  plain_text?: string; // YAML/import compatibility alias; compiler normalizes to IR plain_text
  provider?: string; // TTS provider name (e.g., 'elevenlabs', 'google', 'azure')
  voiceId?: string; // Provider-specific voice identifier
  voice_id?: string; // YAML/import compatibility alias; compiler normalizes to IR voice_id
  speed?: number; // Speech rate multiplier (1.0 = normal)
}

// =============================================================================
// CONVERSATION BEHAVIOR
// =============================================================================

export interface ConversationBehaviorAST {
  speaking?: ConversationSpeakingAST;
  listening?: ConversationListeningAST;
  interaction?: ConversationInteractionAST;
}

export interface ConversationSpeakingAST {
  style?: string;
  tone?: string;
  emotion?: string;
  pace?: string;
  variety?: string;
  language_policy?: 'interaction_context' | 'agent_default' | 'fixed';
  fixed_language?: string;
  max_sentences?: number;
  one_thing_at_a_time?: boolean;
  tool_lead_in?: string;
  tool_results?: {
    style?: string;
    max_points?: number;
  };
  readback?: {
    numbers?: string;
    codes?: string;
    critical_details?: string;
  };
  handoffs?: {
    internal?: string;
    human?: string;
  };
  phrases_ref?: string;
  pronunciations_ref?: string;
}

export interface ConversationListeningAST {
  barge_in?: string;
  backchannels?: string;
  on_pause?: string;
  on_overlap?: string;
  on_unclear_audio?: string;
  on_self_correction?: string;
  use_audio_cues?: string;
}

export interface ConversationInteractionAST {
  answer_shape?: string;
  detail?: string;
  initiative?: string;
  grounding?: {
    mode?: string;
  };
  clarification?: {
    mode?: string;
    max_questions?: number;
    assume_when_low_risk?: boolean;
  };
  confirmation?: {
    parameters?: string;
    actions?: string;
  };
  uncertainty?: {
    mode?: string;
    offer_next_step?: boolean;
  };
  empathy?: string;
  repair?: {
    on_correction?: string;
    on_confusion?: string;
    on_misheard?: string;
    max_attempts?: number;
  };
  context?: {
    avoid_reasking?: boolean;
    remember_recent_constraints?: boolean;
  };
  closure?: string;
  assumption_handling?: string;
  guidance?: Record<string, unknown>;
  failure_recovery?: Record<string, unknown>;
  adaptation?: Record<string, unknown>;
  flow_mode?: string;
}

// =============================================================================
// RICH CONTENT (Multi-Format Output)
// =============================================================================

// Re-export rich content template AST sub-types
export type {
  QuickReplyAST,
  ListTemplateAST,
  ListItemAST,
  MediaContentAST,
  FileContentAST,
  KPITemplateAST,
  TableTemplateAST,
  TableColumnAST,
  ChartTemplateAST,
  ChartDataPointAST,
  FormTemplateAST,
  ProgressTemplateAST,
  FeedbackTemplateAST,
  RichContentCollectionAST,
} from './rich-content-ast.js';

import type {
  QuickReplyAST,
  ListTemplateAST,
  MediaContentAST,
  FileContentAST,
  KPITemplateAST,
  TableTemplateAST,
  ChartTemplateAST,
  FormTemplateAST,
  ProgressTemplateAST,
  FeedbackTemplateAST,
  RichContentCollectionAST,
} from './rich-content-ast.js';

/** Rich content format variants for multi-channel output */
export interface RichContentAST {
  markdown?: string; // Formatted markdown text
  adaptiveCard?: string; // JSON string (Microsoft Adaptive Cards)
  html?: string; // HTML content
  slack?: string; // JSON string (Slack Block Kit)
  agUi?: string; // JSON string (AG-UI / CopilotKit events)
  whatsapp?: string; // JSON string (WhatsApp interactive message)
  carousel?: CarouselAST; // Carousel of cards
  // Template types (Tier 1)
  quickReplies?: RichContentCollectionAST<QuickReplyAST>;
  list?: ListTemplateAST;
  image?: MediaContentAST;
  video?: MediaContentAST;
  audio?: MediaContentAST;
  file?: FileContentAST;
  // Template types (Tier 2)
  kpi?: KPITemplateAST;
  table?: TableTemplateAST;
  chart?: ChartTemplateAST;
  form?: FormTemplateAST;
  progress?: ProgressTemplateAST;
  feedback?: FeedbackTemplateAST;
}

/** Single card in a carousel (AST) */
export interface CarouselCardAST {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  defaultActionUrl?: string;
  buttons?: ActionElementAST[];
}

/** Carousel of cards (AST) */
export interface CarouselAST {
  cards: RichContentCollectionAST<CarouselCardAST>;
}

// =============================================================================
// INTERACTIVE ACTIONS
// =============================================================================

/** Interactive action element (button, select, input) */
export interface ActionElementAST {
  id: string; // Unique action identifier (used in ON_ACTION)
  type: 'button' | 'select' | 'input';
  label: string;
  value?: string; // Hidden value sent on interaction
  description?: string; // Subtitle (for list items)
  options?: RichContentCollectionAST<{
    // For 'select' type
    id: string;
    label: string;
    description?: string;
  }>;
  inputType?: 'text' | 'number' | 'date' | 'time' | 'email'; // For 'input' type
  placeholder?: string;
  required?: boolean;
}

/** Set of interactive actions attached to a RESPOND */
export interface ActionSetAST {
  elements: ActionElementAST[];
  submitLabel?: string; // Label for form submit button (when inputs present)
  submitId?: string; // Action ID for form submission
  renderId?: string; // Runtime-issued correlation id for rendered action sets
}

/** Ordered action within an ON_ACTION handler DO block */
export interface ActionHandlerActionAST {
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  set?: Record<string, string>;
  clear?: string[];
  call?: string;
  resultKey?: string;
  callSpec?: ToolInvocationAST;
  handoff?: string;
  delegate?: string;
  return?: boolean;
  onReturn?: DigressionOnReturnAST;
  goto?: string;
  complete?: boolean;
}

/** Handler for a user action (within ON_ACTION block) */
export interface ActionHandlerAST {
  actionId: string; // Which action element triggered this
  condition?: string; // Optional value-based condition
  do?: ActionHandlerActionAST[];
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  set?: Record<string, string>;
  transition?: string; // GOTO step
}

// =============================================================================
// FLOW (Optional — agents with FLOW are flow-based, without are reasoning-only)
// =============================================================================

/**
 * SET assignment — variable = expression, resolved at execution time
 */
export interface SetAssignment {
  variable: string; // LHS — supports dot notation: "user.name"
  expression: string; // RHS — raw string, resolved at execution time via resolveValue()
}

/**
 * Canonical tool invocation shape shared across authored surfaces.
 *
 * Legacy `call`, `callWith`, and `callAs` fields are preserved on some nodes for
 * backward compatibility, but new parser/compiler/runtime logic should prefer
 * this structured representation.
 */
export interface ToolInvocationAST {
  tool: string;
  with?: Record<string, unknown>;
  as?: string;
}

/**
 * TRANSFORM pipeline configuration — filter/map/sort/limit an array
 */
export interface TransformConfig {
  source: string; // dot-path to source array
  itemVar: string; // explicit loop variable name (the "AS xxx" part)
  target: string; // output variable name (the "INTO xxx" part)
  filter?: string; // condition using itemVar (e.g. "account.active == true")
  map?: Record<string, string>; // field: expression using itemVar
  sortBy?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}

/**
 * Input branch for conditional handling in flow steps (legacy)
 */
export interface InputBranch {
  condition?: string; // IF condition (undefined = ELSE branch)
  respond?: string; // Optional response
  messageKey?: string; // Locale catalog key for respond
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  set?: Record<string, string>; // Variable assignments (SET field = value)
  call?: string; // Optional tool call
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  then: string; // Next step
}

/**
 * GATHER field within a flow step
 */
export interface FlowGatherField {
  name: string;
  /** Reference to a named entity */
  entityRef?: string;
  type?: string; // string, number, date, email, phone, etc.
  required?: boolean; // default: true
  default?: unknown;
  prompt?: string; // Individual prompt for this field
  messageKey?: string; // Locale catalog key for prompt
  validation?: string; // Validation expression
  /** Validation process type: REGEX, CODE, or LLM */
  validationProcess?: 'REGEX' | 'CODE' | 'LLM';
  /** Custom prompt for re-collection when validation fails */
  retryPrompt?: string;
  /** Max validation retry attempts */
  maxRetries?: number;
  extractionHints?: string[]; // Hints for LLM extraction
  infer?: boolean; // Allow LLM to infer (true) or require grounding (false)
  /** Minimum confidence for LLM inference acceptance (default: 0.8) */
  inferConfidence?: number;
  /** Whether to confirm inferred values with user (default: true) */
  inferConfirm?: boolean;
  /** Supplemental metadata describing what the value represents */
  semantics?: GatherFieldSemantics;
  /** Allowed values for enum type fields */
  options?: string[];
  /** Collect as range {low, high} instead of scalar */
  range?: boolean;
  /** Collect as array instead of scalar */
  list?: boolean;
  /** Categorize into accept/desire/avoid/refuse preference sets */
  preferences?: boolean;
  /** Activation mode: required (default), optional, progressive, or data-driven */
  activation?: GatherActivation;
  /** Field names that must be collected before this field activates */
  dependsOn?: string[];
  /** Whether prompt is for user-facing ask or LLM extraction only */
  promptMode?: 'ask' | 'extract_only';
  /** Rich content format variants for the field prompt */
  richContent?: RichContentAST;
  /** Whether this field carries sensitive data (PII) */
  sensitive?: boolean;
  /** Display mode for sensitive values outside gather context */
  sensitiveDisplay?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitiveDisplay: 'mask') */
  maskConfig?: { showFirst: number; showLast: number; char: string };
  /**
   * Explicit PII type hint. Used when the field name is non-canonical
   * (contact_info, customer_number, dob) so the redactor can produce
   * a shape-preserving mask (e.g. email @domain preservation).
   */
  piiType?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
  /** Whether value should be cleared after session ends */
  transient?: boolean;
}

/**
 * GATHER configuration within a FLOW step
 */
export interface FlowGatherConfig {
  fields: FlowGatherField[];
  strategy?: 'llm' | 'pattern' | 'hybrid';
  prompt?: string; // Prompt template for collecting
  messageKey?: string; // Locale catalog key for prompt
}

/**
 * Digression: intent-based escape from current step
 */
export interface DigressionOnReturnAST {
  map?: Record<string, string>;
}

/**
 * Ordered digression action within a canonical DO block
 */
export interface DigressionActionAST {
  respond?: string;
  messageKey?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  set?: Record<string, string>;
  clear?: string[];
  call?: string;
  callSpec?: ToolInvocationAST;
  delegate?: string;
  return?: boolean;
  onReturn?: DigressionOnReturnAST;
  resume?: boolean;
  goto?: string;
}

export interface Digression {
  intent: string; // Intent pattern to match
  keywords?: string[]; // Explicit keywords for matching
  condition?: string; // Optional condition
  do?: DigressionActionAST[]; // Canonical ordered actions
  respond?: string; // Response message before handling
  messageKey?: string; // Locale catalog key for respond
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  goto?: string; // Target step
  delegate?: string; // Agent to delegate to
  call?: string; // Tool to call
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  resume?: boolean; // Resume current step after handling
  clear?: string[]; // Variables to clear before resuming
}

/**
 * Sub-intent: scoped intent valid only within a step
 */
export interface SubIntent {
  intent: string; // Intent pattern
  respond?: string; // Response message
  messageKey?: string; // Locale catalog key for respond
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  clear?: string[]; // Variables to clear (triggers re-collection)
  set?: Record<string, string>; // Variables to set
  call?: string; // Tool to call
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  resume?: boolean; // Stay in current step (default: true)
}

/**
 * Conditional branch within ON_SUCCESS / ON_FAILURE
 */
export interface CallResultBranchAST {
  condition?: string; // IF condition (undefined = ELSE/default)
  respond?: string; // Response message
  messageKey?: string; // Locale catalog key for respond
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  set?: Record<string, string>; // Variable assignments
  call?: string; // Optional nested tool call
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  then?: string; // Next step
}

/**
 * AWAIT_ATTACHMENT configuration within a FLOW step.
 * Pauses execution until the user provides an attachment (file upload).
 */
export interface AwaitAttachmentAST {
  /** Variable name to store the attachment ID */
  name: string;
  /** User-facing prompt text requesting the attachment */
  prompt: string;
  /** Attachment category filter */
  category?: 'image' | 'document' | 'audio' | 'video';
  /** Whether the attachment is required (default: true) */
  required?: boolean;
  /** Timeout in seconds before transitioning to on_timeout step */
  timeout?: number;
  /** Step name to transition to on timeout */
  onTimeout?: string;
}

/**
 * Flow step definition
 */
export interface FlowStep {
  name: string;

  // --- Execution mode (REQUIRED on every step) ---
  /** Whether this step uses LLM reasoning (REQUIRED — REASONING: true/false) */
  reasoning?: boolean;

  /** LLM reasoning goal for this step (overrides agent GOAL when reasoning: true) */
  goal?: string;

  /** Tools available for reasoning in this step (subset of agent tools) */
  availableTools?: string[];

  /** Condition to exit the reasoning loop (evaluated after each turn) */
  exitWhen?: string;

  /** Max reasoning turns before forcing exit (default: 10) */
  maxTurns?: number;

  /** Constraints specific to this reasoning zone */
  stepConstraints?: string[];

  // --- Entry guard ---
  when?: string; // Step-level entry condition (e.g., "user.role == 'Holder' AND channel == 'WEB'")

  // --- Attempt limiting ---
  maxAttempts?: number; // Maximum number of attempts for this step
  onExhausted?: string; // Step to go to after max attempts exhausted

  // --- Enhanced multi-field collection (GATHER within FLOW) ---
  gather?: FlowGatherConfig; // GATHER-style flexible collection
  present?: string; // Presentation template before collection
  corrections?: boolean; // Allow natural corrections
  completeWhen?: string; // Condition for step completion

  // --- Attachment collection ---
  awaitAttachment?: AwaitAttachmentAST; // AWAIT_ATTACHMENT: pause for user file upload

  // --- Computed assignments ---
  set?: SetAssignment[]; // SET variable = expression (resolved at execution time)
  clear?: string[]; // CLEAR variable paths to delete from session

  // --- Data transformation ---
  transform?: TransformConfig; // TRANSFORM array pipeline (filter/map/sort/limit)

  // --- Actions ---
  call?: string; // Tool to execute
  callWith?: Record<string, string>; // CALL WITH: explicit key-value parameters
  callAs?: string; // CALL AS: variable name for tool result binding
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  check?: string; // Constraint phase to run
  respond?: string; // Response shown after call/action (with results)
  messageKey?: string; // Locale catalog key for respond
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  onAction?: ActionHandlerAST[]; // Handlers for interactive action callbacks
  onFail?: string; // Step on failure (simple case)
  then?: string; // Next step on success (default path)

  // --- Call result branches (for CALL steps with ON_SUCCESS/ON_FAIL blocks) ---
  onSuccess?: {
    respond?: string; // Response on success (simple case)
    messageKey?: string; // Locale catalog key for respond
    voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
    richContent?: RichContentAST; // Rich content format variants for respond
    actions?: ActionSetAST; // Interactive actions for respond
    set?: Record<string, string>; // Variable assignments for simple ON_SUCCESS blocks
    then?: string; // Next step on success (simple case)
    branches?: CallResultBranchAST[]; // Conditional branches (IF/ELSE)
  };
  onFailure?: {
    respond?: string; // Response on failure (simple case)
    messageKey?: string; // Locale catalog key for respond
    voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
    richContent?: RichContentAST; // Rich content format variants for respond
    actions?: ActionSetAST; // Interactive actions for respond
    set?: Record<string, string>; // Variable assignments for simple ON_FAIL blocks
    then?: string; // Next step on failure (simple case)
    branches?: CallResultBranchAST[]; // Conditional branches (IF/ELSE)
  };

  // --- Multi-way branching on tool results or deterministic flow context ---
  onResult?: InputBranch[]; // ON_RESULT after CALL, or no-CALL deterministic gates using session vars/input

  // --- Branching ---
  onInput?: InputBranch[]; // Conditional branches based on user input (legacy)

  // --- Intent handling ---
  digressions?: Digression[]; // Intent-based escapes
  subIntents?: SubIntent[]; // Scoped intents within this step

  // --- Step-level error handling ---
  /** Step-level error handlers (override agent-level for this step) */
  onError?: ErrorHandler[];
}

/**
 * Complete flow definition
 */
export interface FlowDefinition {
  steps: string[]; // step1 -> step2 -> step3
  definitions: Record<string, FlowStep>;
  entryPoint?: string; // Explicit entry_point from ABL
  globalDigressions?: Digression[]; // Digressions available in all steps
}

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * Agent goal definition
 */
export interface AgentGoal {
  description: string;
  measurable?: boolean;
}

/**
 * Agent persona (multi-line description)
 */
export interface AgentPersona {
  description: string;
}

/**
 * Agent limitation
 */
export interface AgentLimitation {
  description: string;
}

// =============================================================================
// TOOLS
// =============================================================================

/**
 * Tool parameter with validation
 */
export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
  validate?: string;
  /** Nested object fields — present when type is 'object' and parameters: block defines sub-fields */
  properties?: ToolParam[];
  /** Array item schema — present when type ends with '[]' and parameters: block defines items: */
  items?: { type: string; properties?: ToolParam[] };
}

/**
 * Tool return type (can be complex object)
 */
export interface ToolReturn {
  type: string;
  fields?: Record<string, ToolReturn>;
  items?: ToolReturn;
  optional?: boolean;
}

/**
 * Tool hints for execution optimization
 */
export interface ToolHintsAST {
  cacheable?: boolean;
  latency?: 'fast' | 'medium' | 'slow';
  side_effects?: boolean;
  requires_auth?: boolean;
  timeout?: number;
}

// =============================================================================
// TOOL BINDINGS
// =============================================================================

/**
 * Tool execution type — determines how the tool is executed at runtime
 */
export type ToolType =
  | 'http'
  | 'mcp'
  | 'lambda'
  | 'sandbox'
  | 'async_webhook'
  | 'workflow'
  | 'searchai';

/**
 * Async webhook tool binding — sends an HTTP request with a callback URL injected.
 * The external system processes the request and POSTs the result to the callback URL.
 */
export interface AsyncWebhookBindingAST {
  endpoint: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  /** Where in the body to inject the callback URL (dot path). Defaults to "callbackUrl". */
  callbackUrlField: string;
  /** Timeout in seconds for the async callback. Defaults to 3600 (1 hour). */
  timeoutSeconds: number;
}

/**
 * Authentication type for tool bindings
 */
export type ToolAuthType =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_client'
  | 'oauth2_user'
  | 'saml'
  | 'custom';

/**
 * HTTP tool binding — REST API call configuration
 */
export interface HttpBindingAST {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth?: ToolAuthType;
  authConfig?: {
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string; // {{secrets.X}} placeholder
    scopes?: string;
    headerName?: string;
    apiKey?: string; // {{secrets.X}} or {{env.X}} placeholder for api_key auth
    token?: string; // {{secrets.X}} or {{env.X}} placeholder for bearer auth
    provider?: string;
    customHeaders?: Record<string, string>;
  };
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyType?: 'json' | 'form' | 'xml' | 'text';
  bodyTemplate?: string;
  rateLimit?: number;
  circuitBreaker?: { threshold: number; resetMs: number };
  /** Protocol discriminator — 'rest' is the default and byte-identical to prior behavior */
  protocol?: 'rest' | 'soap';
  /** SOAP version — required when protocol === 'soap'; defaults to '1.1' */
  soapVersion?: '1.1' | '1.2';
  /** SOAPAction header (1.1) or media-type action parameter (1.2) */
  soapAction?: string;
  /** How to handle <soap:Fault> responses — 'error' throws, 'data' returns the fault payload */
  onSoapFault?: 'error' | 'data';
}

/**
 * MCP tool binding — connects to an external MCP server
 */
export interface McpBindingAST {
  server: string; // MCP server name (resolved from runtime config)
  tool?: string; // Tool name on the MCP server (defaults to tool name)
  headers?: Record<string, string>; // Per-call headers (may contain {{secrets.X}}, {{session.X}} templates)
}

/**
 * Lambda tool binding — cloud serverless function
 */
export interface LambdaBindingAST {
  function: string; // Logical function name (resolved to ARN/URL at runtime)
  runtime?: string; // e.g. "nodejs20", "python3.12"
  timeout?: number; // Override timeout for this function
}

/**
 * Sandbox tool binding — user-uploaded code in isolated execution
 */
export interface SandboxBindingAST {
  runtime: 'javascript' | 'python'; // Sandbox language runtime
  code?: string; // Full code content (pipe syntax: `code: |`)
  timeout?: number; // Max execution time (ms)
  memoryMb?: number; // Memory limit
}

/**
 * Tool import from a .tools.abl file
 */
export interface ToolImport {
  source: string; // File path to .tools.abl
  toolNames: string[]; // Specific tools to import
}

/**
 * Tool definition for agent-based ABL
 */
export interface AgentTool {
  name: string;
  description?: string;
  parameters: ToolParam[];
  returns: ToolReturn;
  hints?: ToolHintsAST;
  type?: ToolType; // 'http' | 'mcp' | 'lambda' | 'sandbox' | undefined (contract-only)
  httpBinding?: HttpBindingAST; // Present when type: http
  mcpBinding?: McpBindingAST; // Present when type: mcp
  lambdaBinding?: LambdaBindingAST; // Present when type: lambda
  sandboxBinding?: SandboxBindingAST; // Present when type: sandbox
  sourceFile?: string; // Which .tools.abl it came from
  storeResult?: boolean; // Whether to store raw result blob (default: true)
  onResult?: { set: Record<string, string> }; // Variable mappings on success
  onError?: { set: Record<string, string> }; // Variable mappings on error
  /** Declarative context access for HTTP tools (auto-inject reads, auto-apply writes) */
  contextAccess?: { read: string[]; write: string[] };
  /** Tool result compaction hints */
  compaction?: ToolCompactionConfigAST;
  /** Tool confirmation configuration */
  confirmation?: {
    require: 'always' | 'never' | 'when_side_effects';
    immutableParams?: string[];
    consentRequiredIn?: 'conversation' | 'explicit_prompt';
    consentScope?: string[];
    consentAction?: string;
    consentFallback?: 'explicit_prompt' | 'block';
  };
  /** PII access level for this tool */
  piiAccess?: 'tools' | 'user' | 'logs' | 'llm';
  /** Minimum identity verification tier required to execute this tool (0=anonymous, 1=basic, 2=verified) */
  identityTierRequired?: 0 | 1 | 2;
  /** Auth profile reference name (resolved at runtime via resolveByName()) */
  authProfile?: string;
  /** Just-in-time auth flag */
  authJit?: boolean;
  /** Consent configuration for the tool */
  consent?: unknown;
  /** Connection reference for the tool */
  connection?: string;
}

// =============================================================================
// GATHER (Information Collection)
// =============================================================================

/** Supplemental metadata describing what a gather field value represents (AST) */
export interface GatherFieldSemantics {
  format?: string;
  components?: string[];
  unit?: string;
  lookup?: string;
  convertTo?: string;
  locale?: string;
  koreEntityType?: string;
  /**
   * Allowed enumeration values for the field. Alternative DSL location to
   * top-level `options`; the compiler normalizes this into the parent
   * field's `enum_values` so runtime consumers have a single source of
   * truth. Parsed from DSL key `enum_set:` inside the `SEMANTICS:` block.
   */
  enumSet?: string[];
}

/** Activation mode for progressive/dynamic gather fields (AST) */
export type GatherActivation = 'required' | 'optional' | 'progressive' | { when: string };

/**
 * Field to gather from user
 */
export interface GatherField {
  name: string;
  /** Reference to a named entity — inherits type, values, synonyms, validation from the entity */
  entityRef?: string;
  prompt: string;
  /** Locale catalog key for prompt */
  messageKey?: string;
  type: string;
  required: boolean;
  default?: unknown;
  validate?: string;
  /** Validation process type: REGEX, CODE, or LLM */
  validationProcess?: 'REGEX' | 'CODE' | 'LLM';
  /** Custom prompt for re-collection when validation fails */
  retryPrompt?: string;
  /** Max validation retry attempts */
  maxRetries?: number;
  infer?: boolean;
  /** Minimum confidence for LLM inference acceptance (default: 0.8) */
  inferConfidence?: number;
  /** Whether to confirm inferred values with user (default: true) */
  inferConfirm?: boolean;
  /** Supplemental metadata describing what the value represents */
  semantics?: GatherFieldSemantics;
  /** Allowed values for enum type fields */
  options?: string[];
  /** Collect as range {low, high} instead of scalar */
  range?: boolean;
  /** Collect as array instead of scalar */
  list?: boolean;
  /** Categorize into accept/desire/avoid/refuse preference sets */
  preferences?: boolean;
  /** Activation mode: required (default), optional, progressive, or data-driven */
  activation?: GatherActivation;
  /** Field names that must be collected before this field activates */
  dependsOn?: string[];
  /** Whether prompt is for user-facing ask or LLM extraction only */
  promptMode?: 'ask' | 'extract_only';
  /** Whether this field carries PII */
  sensitive?: boolean;
  /** Display mode for sensitive values outside gather context */
  sensitiveDisplay?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitiveDisplay: 'mask') */
  maskConfig?: { showFirst: number; showLast: number; char: string };
  /**
   * Explicit PII type hint. Used when the field name is non-canonical
   * so the redactor can produce a shape-preserving mask.
   */
  piiType?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
  /** Whether PII auto-cleans after gather completes */
  transient?: boolean;
  /** Custom regex pattern for value extraction */
  extractionPattern?: string;
  /** Capture group index for extraction_pattern (default: 0) */
  extractionGroup?: number;
}

// =============================================================================
// ATTACHMENTS (File/Media Collection)
// =============================================================================

/** Category of attachment content */
export type AttachmentCategory = 'image' | 'document' | 'audio' | 'video';

/**
 * Attachment field — file/media upload collection from user
 */
export interface AttachmentFieldAST {
  name: string;
  prompt: string;
  category: AttachmentCategory;
  required: boolean;
  maxFileSizeMb?: number;
  allowedMimeTypes?: string[];
  ocrEnabled?: boolean;
  transcriptionEnabled?: boolean;
  keyFrameExtraction?: boolean;
}

// =============================================================================
// DESTINATIONS (Outbound HTTP Targets)
// =============================================================================

/**
 * Destination — outbound HTTP target for delivering data/notifications
 */
export interface DestinationAST {
  name: string;
  url: string;
  method?: string;
  auth?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// MEMORY
// =============================================================================

/**
 * Session memory variable
 */
export interface SessionMemoryVar {
  name: string;
  description?: string;
  /** Value type for runtime validation and PASS field resolution */
  type?: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  initial_value?: unknown;
  /** When to reset: per_session (default), per_step, or never */
  reset?: 'per_session' | 'per_step' | 'never';
}

/**
 * Persistent memory path
 */
export interface PersistentMemoryPath {
  path: string; // e.g., "user.preferred_chains"
  description?: string;
  /** Ownership scope: user (default), project (shared across all users), or execution_tree */
  scope?: 'user' | 'project' | 'execution_tree';
  /** Access direction when declared via READS/WRITES/ACCESS */
  access?: 'read' | 'write' | 'readwrite';
  /** Value type for runtime validation */
  type?: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  /** Unit of the stored value (e.g. 'USD', 'km') */
  unit?: string;
  /** Default value when no fact exists */
  defaultValue?: unknown;
  /** Whether this persistent path carries sensitive data */
  sensitive?: boolean;
  /** Display mode for sensitive values outside gather context */
  sensitiveDisplay?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitiveDisplay: 'mask') */
  maskConfig?: { showFirst: number; showLast: number; char: string };
}

/**
 * Remember trigger condition
 */
export interface RememberTrigger {
  when: string; // Condition expression
  store: {
    value: string; // Value expression
    target: string; // Target path
  };
  ttl?: string; // Time-to-live
}

/** Concrete action for RECALL instructions (AST) */
export type RecallAction =
  | { type: 'inject_context'; paths: string[] }
  | { type: 'load_memory'; domain?: string }
  | { type: 'prompt_llm'; instruction: string };

/**
 * Recall instruction
 */
export interface RecallInstruction {
  event: string; // ON_START, ON_SEARCH, etc.
  instruction: string;
  /** Concrete action to execute (defaults to prompt_llm with instruction) */
  action?: RecallAction;
}

/**
 * Complete memory configuration
 */
export interface MemoryConfig {
  session: SessionMemoryVar[];
  persistent: PersistentMemoryPath[];
  remember: RememberTrigger[];
  recall: RecallInstruction[];
}

// =============================================================================
// CONSTRAINTS
// =============================================================================

/** Rich ON_FAIL block for structured control flow in constraints (AST) */
export interface ConstraintOnFailBlock {
  respond?: string;
  collect?: string[];
  goto?: string;
  retry?: boolean;
  then?: 'continue' | 'retry';
}

/**
 * Constraint before target — specifies what action a constraint applies before
 */
export interface ConstraintBeforeTarget {
  kind: 'tool_call' | 'respond' | 'unsupported';
  raw: string;
  target?: string;
}

/**
 * Constraint requirement
 */
export interface ConstraintRequirement {
  condition: string; // e.g., "check_blackout_dates.allowed == true"
  onFail: string | ConstraintAction | ConstraintOnFailBlock;
  /** 'error' (REQUIRE) blocks execution; 'warning' (WARN) emits a warning but continues */
  severity?: 'error' | 'warning';
  /** Constraint kind: require, limit, restrict */
  kind?: 'require' | 'limit' | 'restrict';
  /** When clause — condition under which the constraint applies */
  when?: string;
  /** Before clause — constraint applies before a specific action */
  before?: ConstraintBeforeTarget;
}

/**
 * Constraint action types
 */
export type ConstraintAction =
  | { type: 'respond'; message: string }
  | { type: 'escalate'; reason?: string }
  | { type: 'handoff'; target: string }
  | { type: 'block' }
  | { type: 'collect_field'; collectFields: string[]; thenAction?: 'continue' | 'retry' }
  | { type: 'goto_step'; thenStep: string; respond?: string }
  | { type: 'retry_step' };

/**
 * Constraint phase
 */
export interface ConstraintPhase {
  name: string; // pre_search, pre_booking, always, etc.
  requirements: ConstraintRequirement[];
}

// =============================================================================
// GUARDRAILS
// =============================================================================

/**
 * Guardrail definition for input/output safety checks
 */
export interface GuardrailDefinition {
  /** Unique name for the guardrail */
  name: string;
  /** When to apply: input (before LLM), output (after LLM), both, or tool/handoff scopes */
  kind: 'input' | 'output' | 'both' | 'tool_input' | 'tool_output' | 'handoff';
  /** Check expression to evaluate (optional — model/llm tiers don't use CEL) */
  check?: string;
  /** Action to take when check fails */
  action: 'block' | 'warn' | 'redact' | 'escalate' | 'fix' | 'reask' | 'filter';
  /** Human-readable message when triggered */
  message?: string;
  /** Priority (lower = higher priority, default: 100) */
  priority?: number;
  // ── Tier 2: Model-based ──
  /** Provider name from registry (e.g., 'openai_moderation') */
  provider?: string;
  /** Safety taxonomy category (e.g., 'hate', 'violence') */
  category?: string;
  /** Score threshold (0.0-1.0) */
  threshold?: number;
  // ── Tier 3: LLM-based ──
  /** Natural language check prompt */
  llm_check?: string;
  // ── Graduated actions ──
  /** Per-severity action overrides */
  severity_actions?: Record<string, string>;
  // ── Fix strategy ──
  /** Fix strategy: truncate, strip_html, redact_pii, normalize, custom */
  fix_strategy?: string;
  /** CEL expression for custom fix strategy */
  fix_expression?: string;
  // ── Reask config ──
  /** Max reask attempts (default: 2) */
  max_reasks?: number;
  // ── Filter config ──
  /** Minimum content length after filtering (below this → block) */
  filter_min_length?: number;
  // ── Streaming ──
  /** Enable mid-stream evaluation */
  streaming?: boolean;
  /** Streaming evaluation interval: token, sentence, chunk_size */
  streaming_interval?: string;
}

// =============================================================================
// DELEGATE
// =============================================================================

/**
 * Remote agent location configuration (parsed from DSL)
 */
export interface RemoteAgentConfig {
  location: 'local' | 'remote';
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  auth?: {
    type: 'api_key' | 'bearer';
    header?: string;
  };
  timeout?: string;
}

export type CustomerExperienceMode =
  | 'shared_voice_handoff'
  | 'visible_handoff'
  | 'silent_delegate'
  | 'human_escalation';

/**
 * Delegate to sub-agent configuration
 */
export interface DelegateConfig {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  useResult: string;
  timeout?: string;
  onFailure?: string | DelegateFailureAction;
  remote?: RemoteAgentConfig;
  experienceMode?: CustomerExperienceMode;
}

export type DelegateFailureAction =
  | { type: 'respond'; message: string }
  | { type: 'continue' }
  | { type: 'escalate' }
  | { type: 'retry'; count: number };

export type HandoffFailureAction =
  | { type: 'respond'; message: string }
  | { type: 'continue' }
  | { type: 'escalate' };

export type HandoffHistoryMode = 'auto' | 'none' | 'summary_only' | 'full' | 'last_n';
export type HandoffHistoryLegacyLastN = `last_${number}`;

export interface HandoffHistoryConfigObject {
  mode: HandoffHistoryMode;
  count?: number;
}

export type HandoffHistoryConfig =
  | Exclude<HandoffHistoryMode, 'last_n'>
  | HandoffHistoryLegacyLastN
  | HandoffHistoryConfigObject;

// =============================================================================
// HANDOFF
// =============================================================================

/**
 * Handoff context configuration
 */
export interface HandoffContext {
  pass: string[]; // Fields to pass
  summary: string; // Summary template
  memoryGrants?: Array<{
    path: string;
    access?: 'read' | 'readwrite';
  }>;
  history?: HandoffHistoryConfig; // History strategy: auto | none | summary_only | full | { mode: last_n, count }
}

export interface HandoffOnReturnConfig {
  action?: string;
  handler?: string;
  map?: Record<string, string>; // Structured return mapping (child key → parent key)
}

/**
 * Handoff on-return AST surface.
 *
 * The legacy string form is still accepted as a compatibility lane for older
 * `ON_RETURN: handler_name` / `on_return: handler_name` authored bundles.
 * The compiler later resolves whether that string means a built-in action or
 * a named return handler.
 */
export type HandoffOnReturnAST = string | HandoffOnReturnConfig;

/**
 * Handoff configuration
 */
export interface HandoffConfig {
  to: string;
  when: string;
  priority?: number; // Evaluation priority (lower = evaluated first)
  context: HandoffContext;
  return: boolean;
  onFailure?: string | HandoffFailureAction;
  onReturn?: HandoffOnReturnAST;
  remote?: RemoteAgentConfig;
  async?: boolean; // Use async dispatch with push notifications for remote agents
  asyncTimeout?: number; // Timeout for async handoff in seconds
  experienceMode?: CustomerExperienceMode;
}

/**
 * Named parent-resume handler for RETURN:true handoffs.
 *
 * The handler runs on the parent after the child returns.
 * `resumeIntent` replays the parent's last user message, while `continue`
 * leaves the parent waiting for the next user turn.
 */
export interface ReturnHandlerDefinition {
  respond?: string;
  clear?: string[];
  continue?: boolean;
  resumeIntent?: boolean;
}

// =============================================================================
// ESCALATE
// =============================================================================

/**
 * Escalation trigger
 */
export interface EscalateTrigger {
  when: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical' | number;
  tags?: string[];
}

/**
 * Context item for human agent
 */
export interface EscalateContextItem {
  name: string;
  template?: string;
  include?: string[];
}

/**
 * Post-human action
 */
export interface OnHumanCompleteAction {
  condition: string;
  action: string | { type: string; [key: string]: unknown };
}

/**
 * Escalation configuration
 */
export interface EscalateConfig {
  triggers: EscalateTrigger[];
  contextForHuman: EscalateContextItem[];
  routing?: Record<string, unknown>;
  onHumanComplete: OnHumanCompleteAction[];
  /** Optional connector action name for ITSM integration */
  connectorAction?: string;
}

// =============================================================================
// COMPLETE
// =============================================================================

/**
 * Completion condition
 */
export interface CompleteCondition {
  when: string;
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  store?: string;
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Error handler
 */
export interface ErrorHandler {
  type: string; // tool_timeout, tool_error, invalid_input, etc.
  /** Error subtypes for fine-grained matching */
  subtypes?: string[];
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  retry?: number;
  retryDelay?: number;
  /** Backoff strategy for retries */
  retryBackoff?: 'fixed' | 'exponential' | 'linear';
  /** Max delay between retries */
  retryMaxDelay?: number;
  then?: string | { type: string; [key: string]: unknown };
  /** Target step for backtrack action */
  backtrackTo?: string;
}

// =============================================================================
// LIFECYCLE HANDLERS
// =============================================================================

/**
 * ON_START handler - executed when a session initializes, before any user input
 */
export interface StartHandler {
  respond?: string; // Greeting/welcome message
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides for respond
  richContent?: RichContentAST; // Rich content format variants for respond
  actions?: ActionSetAST; // Interactive actions for respond
  call?: string; // Tool to call (e.g., check_returning_user)
  callSpec?: ToolInvocationAST; // Canonical tool invocation
  set?: Record<string, string>; // Variables to set (e.g., session_initialized = true)
  delegate?: string; // Agent to delegate to
}

// =============================================================================
// EXECUTION CONFIGURATION
// =============================================================================

/**
 * Declarative execution configuration (parsed from EXECUTION: block)
 */
interface ExecutionPipelineShortCircuitAST {
  enabled?: boolean;
  confidenceThreshold?: number;
}

interface ExecutionPipelineToolFilterAST {
  enabled?: boolean;
  maxTools?: number;
}

interface ExecutionPipelineKeywordVetoAST {
  enabled?: boolean;
  keywords?: string[];
}

interface ExecutionPipelineIntentBridgeAST {
  enabled?: boolean;
  programmaticThreshold?: number;
  guidedThreshold?: number;
  outOfScopeDecline?: boolean;
  multiIntentSignal?: boolean;
}

interface ExecutionPipelineConfigAST {
  enabled?: boolean;
  mode?: 'parallel' | 'sequential';
  model?: string;
  shortCircuit?: ExecutionPipelineShortCircuitAST;
  toolFilter?: ExecutionPipelineToolFilterAST;
  keywordVeto?: ExecutionPipelineKeywordVetoAST;
  intentBridge?: ExecutionPipelineIntentBridgeAST;
}

export type ToolResultCompactionStrategyAST = 'none' | 'truncate' | 'structured' | 'summarize';

export type PriorTurnCompactionStrategyAST = 'none' | 'placeholder' | 'compact' | 'summarize';

export interface ToolResultCompactionConfigAST {
  strategy?: ToolResultCompactionStrategyAST;
  max_chars?: number;
  structured_threshold?: number;
  keep_recent?: number;
  essential_fields?: Record<string, string[]>;
  max_description_length?: number;
  summarize_prompt?: string;
}

export interface PriorTurnCompactionConfigAST {
  strategy?: PriorTurnCompactionStrategyAST;
  assistant_preview_chars?: number;
}

export interface CompactionPolicyOverrideAST {
  model?: string;
  tool_results?: ToolResultCompactionConfigAST;
  prior_turns?: PriorTurnCompactionConfigAST;
}

export interface ToolCompactionConfigAST {
  essential_fields?: string[];
  max_description_length?: number;
}

export interface ExecutionConfigAST {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tool_timeout?: number;
  llm_timeout?: number;
  session_idle_timeout?: number;
  max_reasoning_iterations?: number;
  max_flow_iterations?: number;
  voice_latency_target?: number;
  fallback_model?: string;
  operation_models?: Record<string, string>;
  /** Enable extended thinking (Anthropic Claude) */
  enable_thinking?: boolean;
  /** Token budget for extended thinking */
  thinking_budget?: number;
  /** Context-usage ratio (0–1) at which auto-compaction triggers */
  compaction_threshold?: number;
  /** LLM-context compaction policy overrides */
  compaction?: CompactionPolicyOverrideAST;
  /** When true, gather fields are collected inline during conversation rather than as a separate phase */
  inline_gather?: boolean;
  /** Opt-in pre-classification and tool-filter pipeline for supervisors */
  pipeline?: ExecutionPipelineConfigAST;
  /** Number of conversation history messages to include in context */
  conversation_history_window?: number;
  /** Voice configuration from EXECUTION: voice: block */
  voice?: VoiceConfigAST;
}

// =============================================================================
// MESSAGES CONFIGURATION
// =============================================================================

/**
 * Configurable agent messages (parsed from MESSAGES: block)
 */
export interface AgentMessages {
  error_default?: string;
  constraint_blocked?: string;
  gather_prompt?: string;
  escalation_format?: string;
  conversation_complete?: string;
  invalid_handoff?: string;
  self_handoff?: string;
  tool_fallback_desc?: string;
  [key: string]: string | undefined;
}

// =============================================================================
// TEMPLATES
// =============================================================================

/**
 * Named response template definition (parsed from TEMPLATES: block or standalone TEMPLATE)
 */
export interface TemplateDefinition {
  name: string; // Template name (used in TEMPLATE(name) references)
  content: string; // Template body with {{}} interpolation
  formats?: RichContentAST; // Multi-format variants (MARKDOWN, ADAPTIVE_CARD, etc.)
  voiceConfig?: VoiceConfigAST; // Voice-specific overrides attached to this template
  actions?: ActionSetAST; // Interactive actions attached to this template
}

// =============================================================================
// HOOKS CONFIGURATION
// =============================================================================

/**
 * Hook action definition
 */
export interface HookAction {
  call?: string;
  callSpec?: ToolInvocationAST;
  set?: Record<string, string>;
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  /** If true, hook failure aborts the turn. Default false — log warning and continue. */
  critical?: boolean;
}

/**
 * Lifecycle hooks configuration (parsed from HOOKS: block)
 */
export interface HooksConfig {
  before_agent?: HookAction;
  after_agent?: HookAction;
  before_turn?: HookAction;
  after_turn?: HookAction;
}

// =============================================================================
// LOOKUP TABLES
// =============================================================================

/**
 * Lookup table definition for reference-based field validation (AST)
 */
export interface LookupTableDefinition {
  source: 'inline' | 'collection' | 'api';
  values?: string[];
  /** Logical table name for collection source (platform resolves to tenant-scoped storage) */
  tableName?: string;
  /** HTTP endpoint URL (for source='api') */
  endpoint?: string;
  /** Field within the external source to match against */
  field?: string;
  /** Timeout in ms for api source (default: 5000) */
  timeoutMs?: number;
  /** Custom HTTP headers for API source (e.g. Authorization, API keys) */
  headers?: Record<string, string>;
  /** Case-sensitive matching (default: false) */
  caseSensitive: boolean;
  /** Enable fuzzy matching (default: false) */
  fuzzyMatch: boolean;
  /** Fuzzy match similarity threshold 0-1 (default: 0.85) */
  fuzzyThreshold?: number;
}

// =============================================================================
// MAIN DOCUMENT
// =============================================================================

/**
 * Complete Unified Agent ABL Document
 */
export interface AgentBasedDocument {
  meta: DocumentMeta;

  /**
   * @deprecated MODE is deleted from ABL. Retained for backward-compatible
   * deserialization only. Execution style is derived from flow presence
   * and per-step REASONING declarations.
   */
  mode?: ExecutionMode;

  // Language directive
  language?: string; // e.g., "es-EC" for Ecuadorian Spanish

  // Execution configuration
  execution?: ExecutionConfigAST;

  // Identity
  name: string;
  goal: AgentGoal; // GOAL is mandatory on every agent
  persona: AgentPersona;
  limitations: AgentLimitation[];

  // Capabilities
  tools: AgentTool[];
  toolImports?: ToolImport[];
  gather: GatherField[];

  // Attachment collection
  attachments?: AttachmentFieldAST[];

  // Outbound destinations
  destinations?: DestinationAST[];

  // Memory
  memory: MemoryConfig;

  // Constraints (legacy phase-based constraints)
  constraints: ConstraintPhase[];

  // Guardrails (input/output safety checks - parsed from GUARDRAILS section)
  guardrails?: GuardrailDefinition[];

  // Flow (optional — agents with FLOW are flow-based, without are reasoning-only)
  flow?: FlowDefinition;

  // Multi-agent
  delegate: DelegateConfig[];
  handoff: HandoffConfig[];
  returnHandlers?: Record<string, ReturnHandlerDefinition>;
  escalate?: EscalateConfig;

  // Completion
  complete: CompleteCondition[];

  // Error handling
  onError: ErrorHandler[];

  // Lifecycle handlers
  onStart?: StartHandler;

  // Configurable messages
  messages?: AgentMessages;

  // Conversation behavior
  conversation?: ConversationBehaviorAST;

  // Named response templates
  templates?: TemplateDefinition[];

  // Lifecycle hooks
  hooks?: HooksConfig;

  // Custom system prompt template
  systemPrompt?: string;

  // NLU configuration
  nlu?: NLUDefinition;

  /** Top-level entity definitions (from ENTITIES: section) */
  entities?: EntityDefinition[];

  // Multi-intent configuration
  multiIntent?: MultiIntentConfig;

  // Lookup tables for reference-based field validation
  lookupTables?: Record<string, LookupTableDefinition>;

  // Behavior profiles
  behaviorProfile?: BehaviorProfileAST;
  useBehaviorProfiles?: string[];
  /** Inline BEHAVIOR_PROFILE sections defined within an agent file */
  inlineBehaviorProfiles?: Array<BehaviorProfileAST & { name: string }>;

  // Agent-level action handlers (from ACTION_HANDLERS: DSL block)
  actionHandlers?: ActionHandlerAST[];

  // Intent category declarations (from INTENTS: block in supervisor files)
  intents?: IntentDefinition[];
  intentConfig?: IntentSectionConfig;
}

/**
 * An intent category declared in the INTENTS: section of a supervisor.
 * Format in ABL:
 *   INTENTS:
 *     LEXICAL_FALLBACK: when_unavailable
 *     category_name: "Optional description"
 *     category_name_2
 */
export interface IntentDefinition {
  /** Category name — must be a valid identifier (alphanumeric + underscore) */
  name: string;
  /** Optional human-readable description */
  description?: string;
}

export type IntentLexicalFallbackMode = 'never' | 'when_unavailable' | 'always';

export interface IntentSectionConfig {
  /** Controls whether supervisor routing can rescue gather interrupts lexically. */
  lexicalFallback?: IntentLexicalFallbackMode;
}

// =============================================================================
// ENTITY DEFINITIONS (top-level ENTITIES: section)
// =============================================================================

/**
 * Entity definition from the top-level ENTITIES: section.
 *
 * Entities define reusable semantic types with extraction methods and
 * intrinsic validation. They are consumed by both NLU (for recognition)
 * and GATHER (for collection via entity_ref).
 */
export interface EntityDefinition {
  /** Entity name — must be unique within the agent */
  name: string;
  /** Entity type from the unified type system */
  type:
    | 'string'
    | 'text'
    | 'free_text'
    | 'number'
    | 'integer'
    | 'float'
    | 'currency'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'email'
    | 'phone'
    | 'enum'
    | 'pattern'
    | 'location';
  /** Allowed values for enum entities */
  values?: string[];
  /** Synonym map — canonical value → alternative forms */
  synonyms?: Record<string, string[]>;
  /** Regex pattern for pattern-type entities */
  pattern?: string;
  /** Intrinsic validation expression */
  validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
}

// =============================================================================
// NLU CONFIGURATION
// =============================================================================

/**
 * NLU intent definition
 */
export interface NLUIntentDefinition {
  name: string;
  patterns: string[];
  examples?: string[];
  examplesFile?: string;
  entities?: string[];
}

/**
 * NLU category definition
 */
export interface NLUCategoryDefinition {
  name: string;
  patterns: string[];
}

/**
 * NLU entity definition
 */
export interface NLUEntityDefinition {
  name: string;
  type: 'enum' | 'pattern' | 'location' | 'date' | 'number' | 'free_text';
  values?: string[];
  synonyms?: Record<string, string[]>;
  pattern?: string;
  validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
}

/**
 * NLU model configuration
 */
export interface NLUModelConfig {
  fast?: string;
  balanced?: string;
}

/**
 * NLU evaluation configuration
 */
export interface NLUEvalConfig {
  logPredictions?: boolean;
  abTest?: boolean;
  confidenceThreshold?: number;
}

/**
 * NLU embeddings configuration
 */
export interface NLUEmbeddingsConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  threshold?: number;
  cacheTtl?: number;
}

/**
 * Complete NLU definition (parsed from NLU: section)
 */
export interface NLUDefinition {
  models?: NLUModelConfig;
  languages?: string[];
  defaultLanguage?: string;
  allowCodeSwitching?: boolean;
  languageModels?: Record<string, string>;
  intents: NLUIntentDefinition[];
  categories: NLUCategoryDefinition[];
  entities: NLUEntityDefinition[];
  glossary: string[];
  evaluation?: NLUEvalConfig;
  embeddings?: NLUEmbeddingsConfig;
  configFile?: string;
}

// =============================================================================
// MULTI-INTENT CONFIGURATION
// =============================================================================

/** Multi-intent configuration (parsed from MULTI_INTENT: section) */
export interface MultiIntentConfig {
  strategy?: string; // 'sequential' | 'parallel' | 'primary_queue' | 'disambiguate' | 'auto'
  max_intents?: number; // default: 3
  confidence_threshold?: number; // default: 0.6
  queue_max_age_ms?: number; // default: 600000
  enabled?: boolean; // default: true
}

// =============================================================================
// BEHAVIOR PROFILES
// =============================================================================

/**
 * Behavior Profile AST — parsed from BEHAVIOR_PROFILE documents
 */
export interface BehaviorProfileAST {
  priority: number;
  when: string;
  instructions?: string;
  conversation?: ConversationBehaviorAST;
  constraints?: string[];
  response?: BehaviorProfileResponseAST;
  voice?: { ssml?: string; instructions?: string; plain_text?: string };
  tools?: { hide?: string[]; add?: AgentTool[] };
  gather?: BehaviorProfileGatherAST;
  flow?: BehaviorProfileFlowAST;
}

/**
 * Response rules for a behavior profile
 */
export interface BehaviorProfileResponseAST {
  max_buttons?: number;
  fallback_format?: string;
  media_types?: string[];
  max_response_length?: number;
}

/**
 * Gather behavior overrides for a behavior profile
 */
export interface BehaviorProfileGatherAST {
  validation_style?: string;
  confirmation?: string;
  field_overrides?: Record<
    string,
    {
      prompt?: string;
      extraction_hints?: string[];
      skip?: boolean;
      required?: boolean;
      validation?: string;
    }
  >;
}

/**
 * Flow overrides for a behavior profile
 */
export interface BehaviorProfileFlowAST {
  skip?: string[];
  overrides?: Record<
    string,
    {
      respond?: string;
      voice?: { ssml?: string; instructions?: string; plain_text?: string };
      rich_content?: { type: string; payload: Record<string, unknown> };
      transition?: string;
    }
  >;
  /** Inserted steps — uses Record<string, unknown> because AST step shape is compiled to IR FlowStep separately */
  insertions?: Array<{
    position: 'before' | 'after';
    target_step: string;
    step: Record<string, unknown>;
  }>;
  replace?: string;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an empty agent-based document
 */
export function createAgentBasedDocument(name: string, goal: string): AgentBasedDocument {
  const now = new Date();
  return {
    meta: {
      id: crypto.randomUUID(),
      kind: 'agent-based',
      version: '1.0.0',
      name,
      createdAt: now,
      updatedAt: now,
    },
    name,
    goal: { description: goal },
    persona: { description: '' },
    limitations: [],
    tools: [],
    gather: [],
    memory: {
      session: [],
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: [],
    flow: undefined,
    delegate: [],
    handoff: [],
    escalate: undefined,
    complete: [],
    onError: [],
  };
}

/**
 * Create a tool definition
 */
export function createTool(name: string, params: ToolParam[], returns: ToolReturn): AgentTool {
  return { name, parameters: params, returns };
}

/**
 * Create a gather field
 */
export function createGatherField(
  name: string,
  prompt: string,
  type: string,
  required: boolean = true,
): GatherField {
  return { name, prompt, type, required };
}

/**
 * Create a constraint requirement
 */
export function createConstraint(condition: string, onFail: string): ConstraintRequirement {
  return { condition, onFail };
}

/**
 * Create a handoff configuration
 */
export function createHandoff(
  to: string,
  when: string,
  context: HandoffContext,
  returnAllowed: boolean = false,
): HandoffConfig {
  return { to, when, context, return: returnAllowed };
}

/**
 * Create a delegate configuration
 */
export function createDelegate(
  agent: string,
  when: string,
  purpose: string,
  input: Record<string, string>,
  returns: Record<string, string>,
  useResult: string,
): DelegateConfig {
  return { agent, when, purpose, input, returns, useResult };
}
