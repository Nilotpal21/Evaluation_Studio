/**
 * Agent Intermediate Representation (IR) Schema
 *
 * This is the framework-agnostic output of the DSL compiler.
 * All runtimes (voice, digital, workflow) consume this IR format.
 */

import type { AgentSessionLifecycleConfig } from '../core/types.js';
import type { GuardrailAction, SeverityLevel } from './guardrail-action.js';

// Re-export guardrail action types for convenience
export type {
  GuardrailAction,
  GuardrailActionType,
  SeverityLevel,
  FixStrategy,
} from './guardrail-action.js';

// =============================================================================
// VOICE CONFIG
// =============================================================================

/** Voice-specific overrides (IR representation, snake_case) */
export interface VoiceConfigIR {
  ssml?: string;
  instructions?: string;
  plain_text?: string;
  /** TTS provider name (e.g., 'elevenlabs', 'google', 'azure') */
  provider?: string;
  /** Provider-specific voice identifier */
  voice_id?: string;
  /** Speech rate multiplier (1.0 = normal) */
  speed?: number;
}

// =============================================================================
// RICH CONTENT (Multi-Format Output)
// =============================================================================

// --- Rich Content Template IR Sub-Types ---

export interface QuickReplyIR {
  id: string;
  label: string;
  icon_url?: string;
}

export interface RichContentCollectionBindingIR<TItem> {
  from: string;
  template?: TItem;
}

export type RichContentCollectionIR<TItem> = TItem[];

export interface ListTemplateIR {
  title?: string;
  items: RichContentCollectionIR<ListItemIR>;
}

export interface ListItemIR {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action_url?: string;
}

export interface MediaContentIR {
  url: string;
  alt?: string;
  thumbnail_url?: string;
  caption?: string;
}

export interface FileContentIR {
  url: string;
  filename: string;
  size_bytes?: number;
  mime_type?: string;
}

export interface KPITemplateIR {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  icon_url?: string;
}

export interface TableTemplateIR {
  columns: RichContentCollectionIR<TableColumnIR>;
  rows: RichContentCollectionIR<Record<string, string | number>>;
  max_visible_rows?: number;
}

export interface TableColumnIR {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
}

export interface ChartTemplateIR {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  data: RichContentCollectionIR<ChartDataPointIR>;
}

export interface ChartDataPointIR {
  label: string;
  value: string | number;
  color?: string;
}

export interface FormTemplateIR {
  title?: string;
  fields: RichContentCollectionIR<ActionElementIR>;
  submit_label?: string;
}

export interface ProgressTemplateIR {
  label?: string;
  value: number;
  max?: number;
  variant?: 'bar' | 'circle';
}

export interface FeedbackTemplateIR {
  prompt: string;
  type: 'thumbs' | 'stars' | 'scale';
  max?: number;
}

/** Rich content format variants (IR, snake_case) */
export interface RichContentIR {
  markdown?: string;
  adaptive_card?: string;
  html?: string;
  slack?: string;
  ag_ui?: string;
  whatsapp?: string;
  carousel?: CarouselIR;
  // Template types (Tier 1)
  quick_replies?: RichContentCollectionIR<QuickReplyIR>;
  list?: ListTemplateIR;
  image?: MediaContentIR;
  video?: MediaContentIR;
  audio?: MediaContentIR;
  file?: FileContentIR;
  // Template types (Tier 2)
  kpi?: KPITemplateIR;
  table?: TableTemplateIR;
  chart?: ChartTemplateIR;
  form?: FormTemplateIR;
  progress?: ProgressTemplateIR;
  feedback?: FeedbackTemplateIR;
}

/** Single card in a carousel (IR) */
export interface CarouselCardIR {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action_url?: string;
  buttons?: ActionElementIR[];
}

/** Carousel of cards (IR) */
export interface CarouselIR {
  cards: RichContentCollectionIR<CarouselCardIR>;
}

// =============================================================================
// INTERACTIVE ACTIONS
// =============================================================================

/** Interactive action element (IR) */
export interface ActionElementIR {
  id: string;
  type: 'button' | 'select' | 'input';
  label: string;
  value?: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  input_type?: 'text' | 'number' | 'date' | 'time' | 'email';
  placeholder?: string;
  required?: boolean;
}

/** Set of interactive actions (IR) */
export interface ActionSetIR {
  elements: ActionElementIR[];
  submit_label?: string;
  submit_id?: string;
  renderId?: string;
}

/** Ordered action within an ON_ACTION handler DO block (IR) */
export interface ActionHandlerActionIR {
  respond?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  set?: Record<string, string>;
  clear?: string[];
  call?: string;
  result_key?: string;
  call_spec?: ToolInvocationIR;
  handoff?: string;
  delegate?: string;
  return?: boolean;
  on_return?: DigressionOnReturn;
  goto?: string;
  complete?: boolean;
}

/** Handler for user action (IR) */
export interface ActionHandlerIR {
  action_id: string;
  condition?: string;
  /** Canonical ordered action sequence. New post-processing should prefer this field. */
  do?: ActionHandlerActionIR[];
  /** Compatibility mirror of the legacy RESPOND authoring surface. */
  respond?: string;
  /** Compatibility mirror of the legacy RESPOND voice surface. */
  voice_config?: VoiceConfigIR;
  /** Compatibility mirror of the legacy RESPOND rich-content surface. */
  rich_content?: RichContentIR;
  /** Compatibility mirror of the legacy RESPOND actions surface. */
  actions?: ActionSetIR;
  /** Compatibility mirror of the legacy SET authoring surface. */
  set?: Record<string, string>;
  /** Compatibility mirror of the legacy TRANSITION/GOTO authoring surface. */
  transition?: string;
}

// =============================================================================
// CORE IR TYPES
// =============================================================================

export type RuntimeModelSourceIR = 'system' | 'project' | 'tenant' | 'default';

export interface RuntimePromptOverrideRefIR {
  promptId: string;
  versionId: string;
  promptName?: string;
  versionNumber?: number;
}

export interface RuntimeFillerConfigIR {
  enabled?: boolean;
  chatEnabled?: boolean;
  voiceEnabled?: boolean;
  chatDelayMs?: number;
  voiceDelayMs?: number;
  cooldownMs?: number;
  maxPerTurn?: number;
  piggybackEnabled?: boolean;
  pipelineGenerationEnabled?: boolean;
  modelSource?: RuntimeModelSourceIR;
  modelId?: string;
  tenantModelId?: string;
  promptRef?: RuntimePromptOverrideRefIR;
}

/** Partial compaction policy accepted from project or agent-level overrides */
export interface CompactionPolicyOverride {
  /** LLM model for 'summarize' strategies */
  model?: string;
  /** Tool result compaction overrides */
  tool_results?: Partial<ToolResultCompactionConfig>;
  /** Prior-turn compaction overrides */
  prior_turns?: Partial<PriorTurnCompactionConfig>;
}

/** Project-level runtime configuration baked at compile time */
export interface ProjectRuntimeConfigIR {
  extraction_strategy: ExtractionStrategy;
  nlu_provider: NluProvider;
  advanced_sidecar_url?: string;
  advanced_sidecar_timeout_ms?: number;
  advanced_sidecar_circuit_breaker_threshold?: number;
  correction_detection?: CorrectionDetectionStrategy;
  sidecar_timeout_ms?: number;
  sidecar_circuit_breaker_threshold?: number;
  multi_intent: {
    enabled: boolean;
    strategy: MultiIntentStrategy;
    max_intents: number;
    confidence_threshold: number;
    queue_max_age_ms: number;
  };
  inference: {
    confidence: number;
    confirm: boolean;
    model_tier: string;
    max_fields_per_pass: number;
  };
  conversion: {
    currency_mode: 'static' | 'live';
    currency_api_url?: string;
  };
  lookup_tables: LookupTableIR[];
  compaction?: CompactionPolicyOverride;

  /** Opt-in classification and tool filtering pipeline (project-level) */
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    /** @deprecated Use modelSource + tenantModelId */
    model?: string;
    modelSource?: 'default' | 'tenant';
    tenantModelId?: string;
    shortCircuit?: {
      enabled?: boolean;
      confidenceThreshold?: number;
    };
    toolFilter?: {
      enabled?: boolean;
      maxTools?: number;
    };
    keywordVeto?: {
      enabled?: boolean;
      keywords?: string[];
    };
    intentBridge?: {
      enabled?: boolean;
      programmaticThreshold?: number;
      guidedThreshold?: number;
      outOfScopeDecline?: boolean;
      multiIntentSignal?: boolean;
    };
  };

  /** Project-level filler/status message configuration */
  filler?: RuntimeFillerConfigIR;
}

/**
 * Complete Agent IR - the output of DSL compilation
 */
export interface AgentIR {
  /** IR format version for compatibility checking */
  ir_version: '1.0';

  /** Agent metadata */
  metadata: AgentMetadata;

  /** Execution configuration */
  execution: ExecutionConfig;

  /** Agent identity and behavior */
  identity: AgentIdentity;

  /** Tools available to the agent */
  tools: ToolDefinition[];

  /** Information gathering configuration */
  gather: GatherConfig;

  /** Attachment/file collection configuration */
  attachments?: AttachmentFieldIR[];

  /** Memory configuration */
  memory: MemoryConfig;

  /** Constraints and guardrails */
  constraints: ConstraintConfig;

  /** Multi-agent coordination */
  coordination: CoordinationConfig;

  /** Completion conditions */
  completion: CompletionConfig;

  /** Error handling */
  error_handling: ErrorHandlingConfig;

  /** Flow definition (for scripted mode) */
  flow?: FlowConfig;

  /** ON_START lifecycle configuration */
  on_start?: StartConfig;

  /** Configurable messages */
  messages?: AgentMessages;

  /** Lifecycle hooks */
  hooks?: HooksConfig;

  /** NLU engine configuration (from NLU: section) */
  nlu?: NLUIRConfig;

  /** Canonical entity registry — all entities from ENTITIES, NLU.entities, and inline GATHER */
  entities?: EntityDefinitionIR[];

  /** Multi-intent handling configuration */
  intent_handling?: IntentHandlingConfig;

  /** Named response templates (for tooling/IDE support; content also inlined into respond fields) */
  templates?: Record<string, string>;

  /** Routing configuration (present when agent acts as supervisor/router) */
  routing?: RoutingConfig;

  /** Available agents for routing (populated from handoff targets) */
  available_agents?: string[];

  /** Project-level runtime config (baked at compile time from ProjectRuntimeConfig) */
  project_runtime_config?: ProjectRuntimeConfigIR;

  /** Agent-level lookup tables for reference-based field validation */
  lookup_tables?: Record<string, LookupTableIR>;

  /** Behavior profiles for context-dependent agent behavior */
  behavior_profiles?: BehaviorProfileIR[];

  /** Conversation behavior contract for prompt building and runtime resolution */
  conversation_behavior?: ConversationBehaviorIR;

  /** Outbound HTTP destinations (webhooks, APIs) */
  destinations?: DestinationIR[];

  /** Omnichannel policy for cross-channel session continuity */
  omnichannel?: OmnichannelPolicyIR;

  /** Agent-level action handlers (from ACTION_HANDLERS: DSL block) */
  action_handlers?: ActionHandlerIR[];
}

// =============================================================================
// OMNICHANNEL POLICY IR
// =============================================================================

/** Omnichannel session continuity policy declared in agent DSL */
export interface OmnichannelPolicyIR {
  enabled: boolean;
  recall?: {
    enabled: boolean;
    mode: 'on_demand' | 'disabled';
    maxMessages?: number;
    maxAgeDays?: number;
  };
  identity?: {
    explicitVerificationRequired: boolean;
    strongMethods?: string[];
  };
  liveSync?: {
    enabled: boolean;
    transcriptMode: 'final_only';
    joinPolicy?: {
      autoJoinWithVerifiedLink: boolean;
      otherwisePrompt: boolean;
    };
  };
}

// =============================================================================
// DESTINATIONS IR
// =============================================================================

/** Outbound HTTP destination (webhook, API target) */
export interface DestinationIR {
  name: string;
  url: string;
  method?: string;
  auth?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// BEHAVIOR PROFILE IR
// =============================================================================

/** A composable behavior profile that modifies agent behavior based on context */
export interface BehaviorProfileIR {
  /** Profile identifier */
  name: string;
  /** Priority for conflict resolution (higher wins) */
  priority: number;
  /** CEL expression evaluated against ProfileContext at runtime */
  when: string;

  /** Additional instructions appended to base agent identity */
  instructions?: string;
  /** Voice config overrides (merged with base) */
  voice?: VoiceConfigIR;
  /** Response formatting rules (override base per-field) */
  response_rules?: ResponseRulesIR;
  /** Constraints added to base constraint set */
  constraints?: Constraint[];

  /** Tool names to remove from base tool set */
  tools_hide?: string[];
  /** Tools to add to base tool set */
  tools_add?: ToolDefinition[];

  /** Gather field overrides (deep merge per field) */
  gather_overrides?: GatherProfileOverrides;

  /** Flow step modifications (skip, override, insert) -- mutually exclusive with flow_replace */
  flow_modifications?: FlowModificationsIR;
  /** Named flow that completely replaces the base flow -- mutually exclusive with flow_modifications */
  flow_replace?: string;

  /** Conversation behavior overrides applied when the profile is active */
  conversation_behavior?: ConversationBehaviorIR;
}

// =============================================================================
// CONVERSATION BEHAVIOR IR
// =============================================================================

export interface ConversationBehaviorIR {
  speaking?: ConversationSpeakingIR;
  listening?: ConversationListeningIR;
  interaction?: ConversationInteractionIR;
}

export interface ConversationSpeakingIR {
  style?: string;
  tone?: string;
  emotion?: string;
  pace?: string;
  language_policy?: 'interaction_context' | 'agent_default' | 'fixed';
  fixed_language?: string;
  max_sentences?: number;
  one_thing_at_a_time?: boolean;
  tool_lead_in?: string;
  readback?: {
    numbers?: string;
    codes?: string;
    critical_details?: string;
  };
  phrases_ref?: string;
  pronunciations_ref?: string;
  tool_results?: {
    style?: string;
    max_points?: number;
  };
  handoffs?: {
    internal?: string;
    human?: string;
  };
}

export interface ConversationListeningIR {
  barge_in?: string;
  on_pause?: string;
  on_overlap?: string;
  on_unclear_audio?: string;
  on_self_correction?: string;
}

export interface ConversationInteractionIR {
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
}

export interface ResponseRulesIR {
  max_buttons?: number;
  fallback_format?: 'plain_text' | 'markdown' | 'html';
  media_types?: string[];
  max_response_length?: number;
}

export interface GatherProfileOverrides {
  validation_style?: 'strict' | 'lenient';
  confirmation?: 'always' | 'never' | 'on_change';
  field_overrides?: Record<string, GatherFieldProfileOverride>;
}

export interface GatherFieldProfileOverride {
  prompt?: string;
  extraction_hints?: string[];
  skip?: boolean;
  required?: boolean;
  validation?: string;
}

export interface FlowModificationsIR {
  skip?: string[];
  overrides?: Record<string, FlowStepOverrideIR>;
  insertions?: FlowInsertionIR[];
}

export interface FlowStepOverrideIR {
  respond?: string;
  voice?: VoiceConfigIR;
  rich_content?: RichContentIR;
  transition?: string;
  actions?: ActionSetIR;
}

export interface FlowInsertionIR {
  position: 'before' | 'after';
  target_step: string;
  step: FlowStep;
}

// =============================================================================
// METADATA
// =============================================================================

export interface AgentMetadata {
  /** Unique agent identifier */
  name: string;

  /** Semantic version */
  version: string;

  /** Agent type */
  type: 'agent' | 'supervisor';

  /** Compilation timestamp */
  compiled_at: string;

  /** Source DSL hash for change detection */
  source_hash: string;

  /** Compiler version that produced this IR */
  compiler_version: string;

  /** Hash of config variables used by this agent, for cache invalidation */
  config_hash?: string;
}

/** Location and connection details for a remote agent */
export interface RemoteAgentLocation {
  location: 'local' | 'remote';
  endpoint?: string;
  protocol?: 'a2a' | 'rest';
  auth?: {
    type: 'api_key' | 'bearer';
    header?: string;
  };
  timeout?: string;
}

// =============================================================================
// EXECUTION CONFIG
// =============================================================================

/** Per-operation model overrides */
export interface OperationModelMap {
  extraction?: string;
  validation?: string;
  tool_selection?: string;
  response_gen?: string;
  summarization?: string;
  reasoning?: string;
  realtime_voice?: string;
  coordination?: string;
}

// =============================================================================
// COMPACTION POLICY
// =============================================================================

/** Strategy for compacting tool results in conversation history */
export type ToolResultCompactionStrategy = 'none' | 'truncate' | 'structured' | 'summarize';

/** Strategy for compacting prior-turn content */
export type PriorTurnCompactionStrategy = 'none' | 'placeholder' | 'compact' | 'summarize';

/** Tool result compaction configuration */
export interface ToolResultCompactionConfig {
  /** Strategy: none=passthrough, truncate=char-cap, structured=strip fields+cap, summarize=LLM */
  strategy: ToolResultCompactionStrategy;
  /** Maximum characters per tool result before truncation */
  max_chars: number;
  /** Threshold above which structured compression is attempted */
  structured_threshold: number;
  /** Number of most-recent tool iterations to keep intact */
  keep_recent: number;
  /** Per-tool-name field allowlists for structured compression */
  essential_fields?: Record<string, string[]>;
  /** Maximum description/text field length for structured compression */
  max_description_length?: number;
  /** Custom system prompt for 'summarize' strategy. Platform default if omitted. */
  summarize_prompt?: string;
}

/** Prior-turn compaction configuration */
export interface PriorTurnCompactionConfig {
  /** Strategy: none=keep all, placeholder=replace tool results, compact=+preview, summarize=LLM */
  strategy: PriorTurnCompactionStrategy;
  /** Characters to keep from assistant response as preview (used by 'compact') */
  assistant_preview_chars: number;
}

/** Unified compaction policy — configurable at project and agent level */
export interface CompactionPolicy {
  /** LLM model for 'summarize' strategies (resolved: agent → project → platform default) */
  model?: string;
  /** Tool result compaction configuration */
  tool_results: ToolResultCompactionConfig;
  /** Prior-turn compaction configuration */
  prior_turns: PriorTurnCompactionConfig;
}

/** Tool-level compaction hints — declared per tool definition */
export interface ToolCompactionConfig {
  /** Fields to preserve during structured compression */
  essential_fields?: string[];
  /** Max length for description/text fields */
  max_description_length?: number;
}

export interface ExecutionConfig {
  /**
   * @deprecated MODE is deleted from ABL. Execution style is derived from
   * flow presence and per-step reasoning_zone declarations. Retained for
   * backward-compatible deserialization of old IR blobs.
   */
  mode?: 'reasoning' | 'scripted';

  /** Runtime hints for optimization */
  hints: RuntimeHints;

  /** Timeout configurations */
  timeouts: TimeoutConfig;

  /**
   * Preferred agent-level lifecycle override shape for timeout/disconnect policy.
   * Additive to `timeouts.session_timeout_ms` during the compatibility rollout.
   */
  sessionLifecycle?: AgentSessionLifecycleConfig;

  /** Model to use for LLM calls */
  model?: string;

  /** Temperature for LLM calls */
  temperature?: number;

  /** Max tokens for LLM responses */
  max_tokens?: number;

  /** Max reasoning iterations */
  max_iterations?: number;

  /** Max flow iterations */
  max_flow_iterations?: number;

  /** Fallback model if primary fails */
  fallback_model?: string;

  /** Reasoning effort for o-series / GPT-5 models ('low' | 'medium' | 'high') */
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Enable extended thinking (Anthropic Claude) */
  enable_thinking?: boolean;
  /** Token budget for extended thinking (Anthropic Claude) */
  thinking_budget?: number;
  /** Context-usage ratio (0–1) at which auto-compaction triggers */
  compaction_threshold?: number;

  /** Compaction policy — overrides project-level and platform defaults */
  compaction?: CompactionPolicyOverride;

  /** Custom pipeline execution order */
  pipeline_order?: string[];

  /** Per-operation model overrides (from DSL MODELS: block) */
  operation_models?: OperationModelMap;

  /** Concurrency strategy for message processing (default: serial) */
  concurrency?: 'serial' | 'preemptive' | 'parallel';

  /** Maximum pending messages in queue (default: 10) */
  max_queue_depth?: number;

  /** Maximum concurrent message executions for parallel mode (default: 3) */
  max_concurrent_messages?: number;

  /** Opt-in classification and tool filtering pipeline (disabled by default) */
  pipeline?: {
    enabled?: boolean;
    mode?: 'parallel' | 'sequential';
    /** @deprecated Use modelSource + tenantModelId */
    model?: string;
    modelSource?: 'default' | 'tenant';
    tenantModelId?: string;
    shortCircuit?: {
      enabled?: boolean;
      confidenceThreshold?: number;
    };
    toolFilter?: {
      enabled?: boolean;
      maxTools?: number;
    };
    keywordVeto?: {
      enabled?: boolean;
      keywords?: string[];
    };
    intentBridge?: {
      enabled?: boolean;
      programmaticThreshold?: number;
      guidedThreshold?: number;
      outOfScopeDecline?: boolean;
      multiIntentSignal?: boolean;
    };
  };

  /**
   * Inline gather mode: merge _extract_entities into the reasoning tool set
   * instead of running a separate pre-pass LLM call.
   * Saves ~1.4s per turn by eliminating a forced-toolChoice extraction call.
   * Default: false (backward-compatible — existing agents use separate pre-pass).
   */
  inline_gather?: boolean;

  /** Voice configuration resolved from DSL EXECUTION: voice: block */
  voice?: VoiceConfigIR;
}

export interface RuntimeHints {
  /** Suitable for low-latency voice */
  voice_optimized: boolean;

  /** Requires state persistence */
  requires_persistence: boolean;

  /** May need human-in-the-loop */
  supports_hitl: boolean;

  /** Can execute tools in parallel */
  parallel_tools: boolean;

  /** Estimated complexity for routing */
  complexity: 'simple' | 'moderate' | 'complex';
}

export interface TimeoutConfig {
  /** Default tool timeout in ms */
  tool_timeout_ms: number;

  /** LLM call timeout in ms */
  llm_timeout_ms: number;

  /** Session idle timeout in ms */
  session_timeout_ms: number;

  /** Voice-specific: max response latency */
  voice_latency_target_ms?: number;
}

// =============================================================================
// IDENTITY
// =============================================================================

export interface AgentIdentity {
  /** Agent's primary goal */
  goal: string;

  /** Persona description for LLM context */
  persona: string;

  /** Prompt-level limitations / behavioral boundaries */
  limitations: string[];

  /** System prompt components */
  system_prompt: SystemPromptConfig;

  /** Voice channel response formatting rules */
  voice_response_rules?: string;

  /** Agent language from DSL LANGUAGE: directive (e.g., "es-EC") */
  language?: string;
}

export interface SystemPromptConfig {
  /** Core instruction template */
  template: string;

  /** Whether the template was explicitly provided by the user (SYSTEM_PROMPT: in DSL) */
  custom?: boolean;

  /** Dynamic sections to inject */
  sections: {
    context?: boolean;
    tools?: boolean;
    constraints?: boolean;
    history?: boolean;
  };

  /** Optional reference to a prompt library item + version used to produce this template */
  libraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash: string;
  };
}

// =============================================================================
// TOOLS
// =============================================================================

export interface ToolDefinition {
  /** Tool name (function name) */
  name: string;

  /** Human-readable description */
  description: string;

  /** Parameter definitions */
  parameters: ToolParameter[];

  /** Return type specification */
  returns: ToolReturnType;

  /** Execution hints */
  hints: ToolHints;

  /** Whether this is a system-injected tool (e.g., __handoff__, __complete__) */
  system?: boolean;

  /** Tool execution type — determines how the tool is executed */
  tool_type?:
    | 'http'
    | 'mcp'
    | 'sandbox'
    | 'lambda'
    | 'connector'
    | 'workflow'
    | 'searchai'
    | 'async_webhook';

  /** HTTP binding configuration */
  http_binding?: HttpBindingIR;

  /** MCP binding configuration */
  mcp_binding?: McpBindingIR;

  /** Sandbox binding configuration */
  sandbox_binding?: SandboxBindingIR;

  /** Whether to store the raw result blob in session.data.values (default: true if no on_result, false if on_result defined) */
  store_result?: boolean;

  /** Variable mappings to apply when the tool succeeds */
  on_result?: { set: Record<string, string> };

  /** Variable mappings to apply when the tool returns an error */
  on_error?: { set: Record<string, string> };

  /** Connector binding configuration */
  connector_binding?: ConnectorBindingIR;

  /** Workflow binding configuration */
  workflow_binding?: WorkflowBindingIR;

  /** SearchAI KB binding configuration */
  searchai_binding?: SearchAIBindingIR;

  /** Declarative context access for HTTP tools (auto-inject reads, auto-apply writes) */
  context_access?: ToolContextAccess;

  /** Tool confirmation configuration — requires user approval before execution */
  confirmation?: {
    /** When to require confirmation */
    require: 'always' | 'never' | 'when_side_effects';
    /** Parameters locked after user confirms — prevents tampering between confirmation and execution */
    immutable_params?: string[];
    /** Where consent can be satisfied before prompting. Defaults to explicit prompt only. */
    consent_required_in?: 'conversation' | 'explicit_prompt';
    /** Parameters that scope the consent, e.g. order_id or refund_amount. */
    consent_scope?: string[];
    /** Optional canonical action phrase used for conversation-consent matching. */
    consent_action?: string;
    /** What to do when scoped conversation consent is missing. */
    consent_fallback?: 'explicit_prompt' | 'block';
  };

  /** PII access level — determines what the tool sees for PII values.
   *  Default: 'tools' (the safe redacted tool view). Override per tool when stricter or broader access is intentional. */
  pii_access?: 'original' | 'tools' | 'user' | 'logs' | 'llm';

  /** Compaction hints for this tool's results (essential fields, description length) */
  compaction?: ToolCompactionConfig;

  /** Async webhook binding configuration */
  async_webhook_binding?: AsyncWebhookBindingIR;

  /** Variable namespace IDs this tool is linked to (for env var scoping at runtime) */
  variable_namespace_ids?: string[];

  /** Auth profile reference for JIT / preflight auth */
  auth_profile_ref?: string;

  /** Connection mode — per_user requires user-scoped credentials, shared uses tenant-level */
  connection_mode?: 'per_user' | 'shared';

  /** Consent mode: preflight prompts all auth upfront, inline prompts on first use */
  consent_mode?: 'preflight' | 'inline';

  /** Minimum identity verification tier required to execute this tool (0=anonymous, 1=basic, 2=verified) */
  identity_tier_required?: 0 | 1 | 2;

  /** Whether this tool requires JIT (just-in-time) authentication */
  jit_auth?: boolean;

  /** Derived JSON Schema for parameters (e.g., from workflow inputVariables) */
  derivedParameterSchema?: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** Declarative context access — session vars auto-injected/written for HTTP tools */
export interface ToolContextAccess {
  /** Session var names to auto-inject into tool params before execution */
  read: string[];
  /** Session var names the tool can update via context_updates in its response */
  write: string[];
}

export interface ConnectorBindingIR {
  connector: string;
  action: string;
}

/** Auth requirement collected from tools — used for preflight/JIT auth flows */
export interface AuthRequirementIR {
  /** Connector name (derived from connector_binding or auth_profile_ref) */
  connector: string;
  /** Auth profile reference to resolve credentials */
  auth_profile_ref: string;
  /** Variable namespace IDs for scoping templated auth profile refs */
  variable_namespace_ids?: string[];
  /** OAuth scopes required */
  scopes?: string[];
  /** Connection mode */
  connection_mode: 'per_user' | 'shared';
  /** Consent mode */
  consent_mode: 'inline' | 'preflight';
}

export interface WorkflowBindingIR {
  workflowId: string;
  workflowVersionId?: string;
  /** Semver pin for the workflow version (e.g. 'v0.2.0' or 'draft'). When absent, auto-resolve picks the latest active version. */
  workflowVersion?: string;
  /**
   * Trigger endpoint ID for the workflow.
   * Optional at the type level but enforced as non-empty by the tool-schema-validator
   * when tool_type is 'workflow' (see D-3 in workflow-as-tool spec).
   */
  triggerId?: string;
  mode: 'sync' | 'async';
  paramMapping: Record<string, string>;
  timeoutMs?: RuntimeNumericValue;
}

export interface SearchAIBindingIR {
  /** Tenant ID for isolation */
  tenantId: string;
  /** Search index ID (knowledgeBaseId) */
  indexId: string;
  /** Display name for the KB (used in tool description) */
  kbName?: string;
  /** Optional user-defined instructions injected into the classify prompt to guide filter/query behavior */
  searchInstructions?: string;
}

export interface AsyncWebhookBindingIR {
  endpoint: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  /** Where in the body to inject the callback URL (dot path). Defaults to "callbackUrl". */
  callbackUrlField: string;
  /** Timeout in seconds for the async callback. Defaults to 3600 (1 hour). */
  timeoutSeconds: number;
}

export interface ToolParameter {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  default?: unknown;
  validation?: string;
  /** Enum values for constrained params (e.g. ['economy', 'business', 'first']) */
  enum?: unknown[];
  /** Nested object fields (recursive ToolParameter[]) */
  properties?: ToolParameter[];
  /** Array item schema (supports nested properties for object[] types) */
  items?: { type: string; enum?: unknown[]; properties?: ToolParameter[] };
}

export interface ToolReturnType {
  type: string;
  fields?: Record<string, ToolReturnType>;
  items?: ToolReturnType;
  optional?: boolean;
}

export interface ToolHints {
  /** Can be cached */
  cacheable: boolean;

  /** Typical latency category */
  latency: 'fast' | 'medium' | 'slow';

  /** Can run in parallel with other tools */
  parallelizable: boolean;

  /** Has side effects */
  side_effects: boolean;

  /** Requires authentication context */
  requires_auth: boolean;

  /** Custom timeout in ms */
  timeout?: RuntimeNumericValue;
}

// =============================================================================
// TOOL BINDINGS (IR)
// =============================================================================

export type ConfigRuntimeNumericTemplate = `{{config.${string}}}`;
export type RuntimeNumericValue = number | ConfigRuntimeNumericTemplate;

/** Authentication type for tool bindings */
export type ToolAuthTypeIR =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_client'
  | 'oauth2_user'
  | 'custom'
  | 'searchai';

/** HTTP tool binding in IR */
export interface HttpBindingIR {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: {
    type: ToolAuthTypeIR;
    config?: {
      headerName?: string;
      headerPrefix?: string;
      queryParam?: string;
      /** Inline bearer token value (may contain {{secrets.X}} templates) */
      token?: string;
      /** Inline API key value (may contain {{secrets.X}} templates) */
      apiKey?: string;
      /** OAuth2 client secret (may contain {{secrets.X}} templates) */
      clientSecret?: string;
      oauth?: { tokenUrl: string; clientId: string; scopes: string[] };
      /** OAuth2 user provider name (e.g. 'google', 'slack', 'microsoft') for oauth2_user auth type */
      provider?: string;
      customHeaders?: Record<string, string>;
      /** SearchAI auth config — token URL, client ID, client secret, bot ID for JWT lifecycle */
      searchai?: {
        tokenUrl: string;
        clientId: string;
        clientSecret?: string;
        botId?: string;
        /** Header name for the token (defaults to 'Auth' for SearchAI compat) */
        headerName?: string;
      };
    };
  };
  timeout_ms?: RuntimeNumericValue;
  retry?: { count: RuntimeNumericValue; delay_ms: RuntimeNumericValue };
  rate_limit_per_minute?: RuntimeNumericValue;
  circuit_breaker?: { threshold: RuntimeNumericValue; reset_ms: RuntimeNumericValue };
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_type?: 'json' | 'form' | 'xml' | 'text';
  body_template?: string;

  /** TLS/mTLS options for mutual TLS connections */
  tls_options?: {
    /** CA certificate (PEM) */
    ca?: string;
    /** Client certificate (PEM) */
    cert?: string;
    /** Client private key (PEM) */
    key?: string;
    /** Whether to reject unauthorized certificates (default: true) */
    rejectUnauthorized?: boolean;
  };

  /** Protocol discriminator — undefined or 'rest' is byte-identical to prior REST behavior */
  protocol?: 'rest' | 'soap';
  /** SOAP version — required when protocol === 'soap'; defaults to '1.1' */
  soap_version?: '1.1' | '1.2';
  /** SOAPAction header value (1.1) or media-type action parameter (1.2) */
  soap_action?: string;
  /** How <soap:Fault> responses are handled — 'error' throws, 'data' passes through */
  on_soap_fault?: 'error' | 'data';

  /**
   * How non-2xx HTTP responses are handled.
   * 'data' (default): returns { statusCode, body, is_error: true } so the agent
   *         can inspect structured error payloads (e.g. 404 with { "error": { ... } }).
   * 'error': throws TOOL_HTTP_ERROR — opt-in legacy behaviour for tools that
   *         require error propagation.
   */
  on_http_error?: 'error' | 'data';

  /**
   * Runtime-only AWS SigV4 signing context injected by auth-profile middleware.
   * This field is never authored in DSL and is not persisted; the HTTP executor
   * consumes it after the final request shape is resolved.
   */
  sigv4_auth?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
    service: string;
  };
}

/** MCP tool binding in IR */
export interface McpBindingIR {
  server: string;
  tool: string; // Resolved tool name (defaults to definition name)
  /** Per-call headers (may contain {{secrets.X}}, {{env.X}} templates) */
  headers?: Record<string, string>;

  /** Full server config baked at compile time (zero DB lookups at runtime) */
  server_config?: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    /** Stays encrypted — decrypted at execution time (CPU only, AES-256-GCM) */
    encrypted_env?: string;
    connection_timeout_ms?: number;
    request_timeout_ms?: number;
    allowed_commands?: string[];
    /** Encrypted auth config — decrypted at execution time */
    encrypted_auth_config?: string;
    auth_type?: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials';
    /** Auth profile reference for MCP header resolution at runtime */
    auth_profile_id?: string;
    /** Auth profile reference for MCP env-var resolution at runtime */
    env_profile_id?: string;
  };
}

/** Sandbox tool binding in IR */
export interface SandboxBindingIR {
  runtime: 'javascript' | 'python';
  /** Full code content — baked at compile time (zero DB lookups at runtime) */
  code_content: string;
  timeout_ms?: RuntimeNumericValue;
  memory_mb?: RuntimeNumericValue;
}

// =============================================================================
// GATHER (Information Collection)
// =============================================================================

/** Extraction strategy for gather fields */
export type ExtractionStrategy = 'auto' | 'ml' | 'llm' | 'hybrid' | 'pattern';

/** NLU provider tier — 'standard' uses JS + LLM only; 'advanced' adds ML sidecar (enterprise) */
export type NluProvider = 'standard' | 'advanced';

/** Strategy for correction detection tiers */
export type CorrectionDetectionStrategy = 'auto' | 'ml' | 'llm' | 'regex' | 'sidecar' | 'disabled';

export interface GatherConfig {
  /** Fields to collect */
  fields: GatherField[];

  /** Extraction strategy */
  strategy: 'llm' | 'pattern' | 'hybrid';

  /** Custom correction patterns (regex strings) */
  correction_patterns?: string[];
}

/** Supplemental metadata describing what a gather field value represents */
export interface GatherFieldSemantics {
  /** High-level format hint: 'address', 'airport_code', 'currency', 'temperature', etc. */
  format?: string;
  /** Structured sub-parts to extract (e.g. ['street','city','state','zip','country']) */
  components?: string[];
  /** Unit of measurement: 'USD', 'kg', 'miles', 'celsius' */
  unit?: string;
  /** Reference table name for lookup-based validation */
  lookup?: string;
  /** Auto-conversion target unit */
  convert_to?: string;
  /** Formatting locale */
  locale?: string;
  /** Maps to Kore platform entity type (e.g. 'LOC_AIRPORT') for migration */
  kore_entity_type?: string;
  /**
   * Allowed enumeration values for the field. Alternative DSL location to
   * top-level `options`; the compiler mirrors this into the parent field's
   * `enum_values` so runtime consumers read one canonical source. Parsed
   * from DSL key `enum_set:` inside the `SEMANTICS:` sub-block.
   */
  enum_set?: string[];
}

/** Lookup table definition for reference-based field validation */
export interface LookupTableIR {
  name: string;
  source: 'inline' | 'collection' | 'api';
  values?: string[];
  /** Pre-lowercased values for O(1) Set lookup (computed at compile time when case_sensitive=false) */
  normalized_values?: string[];
  /** Logical table name for collection source (platform resolves to tenant-scoped storage) */
  table_name?: string;
  /** HTTP endpoint URL (for source='api') */
  endpoint?: string;
  field?: string;
  /** Timeout in ms for api source (default: 5000) */
  timeout_ms?: number;
  /** Custom HTTP headers for API source (e.g. Authorization, API keys) */
  headers?: Record<string, string>;
  /** Case-sensitive matching (default: false) */
  case_sensitive: boolean;
  /** Enable fuzzy matching (default: false) */
  fuzzy_match: boolean;
  /** Fuzzy match similarity threshold 0-1 (default: 0.85) */
  fuzzy_threshold: number;
}

/** Value shape when range=true on a gather field */
export interface RangeValue<T = unknown> {
  low?: T;
  high?: T;
}

/** Value shape when preferences=true on a gather field */
export interface PreferenceValue<T = unknown> {
  /** Explicitly acceptable */
  accept: T[];
  /** Preferred/wanted */
  desire: T[];
  /** Would rather not */
  avoid: T[];
  /** Hard no (allergies, dealbreakers) */
  refuse: T[];
}

/** Activation mode for progressive/dynamic gather fields */
export type GatherActivation =
  | 'required' // Always required (default)
  | 'optional' // Collected if mentioned, never prompted
  | 'progressive' // Becomes required when depends_on fields are collected
  | { when: string }; // Data-driven: activate when condition is true

export interface GatherField {
  name: string;
  /** Reference to a named entity in ir.entities — inherits type, values, synonyms, intrinsic validation */
  entity_ref?: string;
  prompt: string;
  /** Locale catalog key for prompt */
  message_key?: string;
  type: string;
  required: boolean;
  default?: unknown;
  validation?: ValidationRule;
  extraction_hints?: string[];
  infer?: boolean;
  /** Minimum confidence for LLM inference acceptance (default: 0.8) */
  infer_confidence?: number;
  /** Whether to confirm inferred values with user (default: true) */
  infer_confirm?: boolean;
  /** Supplemental metadata describing what the value represents */
  semantics?: GatherFieldSemantics;
  /** Collect as range {low, high} instead of scalar */
  range?: boolean;
  /** Collect as array instead of scalar */
  list?: boolean;
  /** Categorize into accept/desire/avoid/refuse preference sets */
  preferences?: boolean;
  /** Activation mode: required (default), optional, progressive, or data-driven */
  activation?: GatherActivation;
  /** Field names that must be collected before this field activates (for progressive/data-driven) */
  depends_on?: string[];
  /** Whether prompt is for user-facing ask or LLM extraction only */
  prompt_mode?: 'ask' | 'extract_only';
  /** Whether this field carries PII and should be treated as sensitive */
  sensitive?: boolean;
  /** Display mode for sensitive field values in non-gathering contexts */
  sensitive_display?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitive_display: 'mask') */
  mask_config?: { show_first: number; show_last: number; char: string };
  /**
   * Explicit PII type hint. Used when the field name is non-canonical
   * (contact_info, customer_number, dob) so the redactor can produce
   * a shape-preserving mask (e.g. email @domain preservation).
   * Parsed from DSL key `PII_TYPE:` on the gather field.
   */
  pii_type?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
  /** Whether PII auto-cleans after gather completes (for CVV, OTP — XO migration) */
  transient?: boolean;
  /** Custom regex pattern for value extraction (XO migration) */
  extraction_pattern?: string;
  /** Capture group index for extraction_pattern (default: 0 = full match) */
  extraction_group?: number;
  /** Allowed values for enum type fields (used by Studio test context and LLM extraction) */
  enum_values?: string[];
  /** Synonym map from NLU entity definitions (canonical value → synonym list) */
  synonyms?: Record<string, string[]>;
  /** Voice-specific overrides for the gather prompt (populated from TEMPLATE format variants) */
  voice_config?: VoiceConfigIR;
  /** Rich content format variants (populated when prompt uses TEMPLATE with formats) */
  rich_content?: RichContentIR;
}

export interface ValidationRule {
  /** Validation type */
  type: 'pattern' | 'range' | 'enum' | 'custom' | 'llm' | 'intrinsic';
  /** Validation rule (regex, expression, enum list, or LLM instruction) */
  rule: string;
  /** Error message shown when validation fails */
  error_message: string;
  /** Custom prompt for re-collection when validation fails */
  retry_prompt?: string;
  /** Max validation retry attempts before escalation */
  max_retries?: number;
  /** Validation process type */
  validation_process?: 'REGEX' | 'CODE' | 'LLM';
}

// =============================================================================
// ATTACHMENTS (File/Media Collection)
// =============================================================================

/** Category of attachment content (IR) */
export type AttachmentCategoryIR = 'image' | 'document' | 'audio' | 'video';

/** Processing options for attachment fields (IR) */
export interface AttachmentProcessing {
  ocr_enabled?: boolean;
  transcription_enabled?: boolean;
  key_frame_extraction?: boolean;
}

/** Attachment field definition (IR) */
export interface AttachmentFieldIR {
  name: string;
  prompt: string;
  category: AttachmentCategoryIR;
  required: boolean;
  allowed_mime_types: string[];
  max_file_size_bytes: number;
  processing: AttachmentProcessing;
}

// =============================================================================
// MEMORY
// =============================================================================

export interface MemoryConfig {
  /** Session-scoped variables */
  session: SessionMemory[];

  /** Persistent user/system memory */
  persistent: PersistentMemory[];

  /** Automatic memory triggers */
  remember: RememberTrigger[];

  /** Memory recall instructions */
  recall: RecallInstruction[];
}

export interface SessionMemory {
  name: string;
  /** Value type declared via TYPE: in the ABL MEMORY section */
  type?: string;
  description?: string;
  initial_value?: unknown;
  /** When to reset this variable: per_session (default), per_step, or never */
  reset?: 'per_session' | 'per_step' | 'never';
}

export interface PersistentMemory {
  path: string;
  description?: string;
  /** Ownership scope: user (default), project (shared across all users), or execution_tree */
  scope: 'user' | 'project' | 'execution_tree';
  access: 'read' | 'write' | 'readwrite';
  /** Value type for runtime validation */
  type?: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  /** Unit of the stored value (e.g. 'USD', 'km') */
  unit?: string;
  /** Default value when no fact exists */
  default_value?: unknown;
  /** Whether this persistent path carries sensitive data */
  sensitive?: boolean;
  /** Display mode for sensitive values outside gather context */
  sensitive_display?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitive_display: 'mask') */
  mask_config?: { show_first: number; show_last: number; char: string };
}

export interface RememberTrigger {
  when: string;
  store: {
    value: string;
    target: string;
  };
  ttl?: string;
}

/** Concrete action for RECALL instructions */
export type RecallAction =
  | { type: 'inject_context'; paths: string[] }
  | { type: 'load_memory'; domain?: string }
  | { type: 'prompt_llm'; instruction: string };

export interface RecallInstruction {
  event: string;
  instruction: string;
  /** Concrete action to execute (defaults to prompt_llm with instruction) */
  action?: RecallAction;
}

// =============================================================================
// CONSTRAINTS
// =============================================================================

export interface ConstraintConfig {
  /** All constraints — checked every turn */
  constraints: Constraint[];

  /** Global guardrails (checked every turn, before constraints) */
  guardrails: Guardrail[];
}

export interface Constraint {
  condition: string;
  on_fail: ConstraintAction;
  /** 'error' (default, REQUIRE) blocks execution; 'warning' (WARN) emits a warning but continues */
  severity?: 'error' | 'warning';
  /** Constraint kind: require (default), limit, or restrict */
  kind?: 'require' | 'limit' | 'restrict';
  /** Original WHEN clause — condition under which the constraint applies (metadata only) */
  applies_when?: string;
  /** Structural checkpoint — specifies when the constraint is evaluated (BEFORE tool_call / response) */
  checkpoint?: ConstraintCheckpoint;
}

/** Structural checkpoint for BEFORE clauses */
export interface ConstraintCheckpoint {
  kind: 'tool_call' | 'response';
  target?: string;
}

export interface ConstraintAction {
  type:
    | 'respond'
    | 'escalate'
    | 'handoff'
    | 'block'
    | 'redact'
    | 'retry_step'
    | 'goto_step'
    | 'collect_field';
  message?: string;
  target?: string;
  reason?: string;
  /** Fields to collect (for collect_field action) */
  collect_fields?: string[];
  /** What to do after collection: continue forward or retry current step */
  then_action?: 'continue' | 'retry';
  /** Target step name (for goto_step action) */
  then_step?: string;
}

/** Rich ON_FAIL block for structured control flow in constraints and step CHECK */
export interface ConstraintOnFailBlock {
  respond?: string;
  /** Mini-gather: fields to collect before proceeding */
  collect?: string[];
  /** Step name to jump to (backtrack) */
  goto?: string;
  /** Retry current step */
  retry?: boolean;
  /** After collect: proceed forward or retry current step */
  then?: 'continue' | 'retry';
}

export type GuardrailKind = 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
export type GuardrailTier = 'local' | 'model' | 'llm';

export interface Guardrail {
  /** Unique guardrail identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** When this guardrail fires — 'both' expanded at compile time */
  kind: GuardrailKind;
  /** Execution priority (lower = first) */
  priority: number;
  /** Inferred execution tier */
  tier: GuardrailTier;
  // ── Tier 1: Local CEL ──
  /** CEL expression to evaluate */
  check?: string;
  // ── Tier 2: Model-based ──
  /** Provider name from registry */
  provider?: string;
  /** Safety taxonomy category */
  category?: string;
  /** Score threshold (0.0-1.0) */
  threshold?: number;
  // ── Tier 3: LLM-based ──
  /** Natural language check prompt */
  llmCheck?: string;
  // ── Action ──
  /** Default action on violation */
  action: GuardrailAction;
  /** Per-severity action overrides (excludes 'safe') */
  severityActions?: Partial<Record<Exclude<SeverityLevel, 'safe'>, GuardrailAction>>;
  // ── Streaming ──
  /** Enable mid-stream evaluation */
  streaming?: boolean;
  /** Streaming evaluation interval */
  streamingInterval?: 'token' | 'sentence' | 'chunk_size';
  // ── Sensitive Data Block Preset ──
  /** Recognizer-set restriction for builtin-pii. Sensitive Data Block preset. */
  entities?: string[];
  /** Preset identifier propagated into trace events. */
  presetKey?: string;
}

// =============================================================================
// COORDINATION (Multi-Agent)
// =============================================================================

export interface CoordinationConfig {
  /** Delegate configurations */
  delegates: DelegateConfig[];

  /** Handoff configurations */
  handoffs: HandoffConfig[];

  /** Named post-return handlers for RETURN:true handoffs */
  return_handlers?: Record<string, HandoffReturnHandler>;

  /** Escalation configuration */
  escalation?: EscalationConfig;
}

export type CustomerExperienceMode =
  | 'shared_voice_handoff'
  | 'visible_handoff'
  | 'silent_delegate'
  | 'human_escalation';

export interface DelegateConfig {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  use_result: string;
  timeout?: string;
  on_failure: 'continue' | 'escalate' | 'respond';
  failure_message?: string;
  remote?: RemoteAgentLocation;
  experienceMode?: CustomerExperienceMode;
}

/** Strategy for passing conversation history during handoff */
export type HistoryStrategy =
  | 'auto' // Default: prefer summary_only when safe, otherwise fall back to bounded raw history
  | 'none' // Fresh child context with no summary or raw history
  | 'summary_only' // Only SUMMARY, no messages
  | 'full' // Full parent conversation history
  | { last_n: number }; // Last N messages from parent

/** Concrete runtime history behavior after `auto` resolution */
export type ResolvedHistoryStrategy = Exclude<HistoryStrategy, 'auto'>;

/** Structured return mapping for handoff ON_RETURN */
export interface HandoffReturnMapping {
  action?: string; // on_return action (currently wired: continue, resume_intent)
  handler?: string; // canonical named return handler reference
  map?: Record<string, string>; // structured result mapping (child key → parent key)
}

/** Named return handler executed on the parent after a child handoff returns */
export interface HandoffReturnHandler {
  respond?: string;
  clear?: string[];
  continue?: boolean;
  resume_intent?: boolean;
}

/** Resolved PASS field with type and optional description */
export interface ResolvedPassField {
  name: string;
  type: string; // resolved: inline → session memory → 'string'
  description?: string; // resolved: inline → session memory → undefined
}

export interface HandoffMemoryGrant {
  path: string;
  access: 'read' | 'readwrite';
}

export interface HandoffConfig {
  to: string;
  when: string;
  context: {
    pass: ResolvedPassField[];
    summary: string;
    memory_grants?: HandoffMemoryGrant[];
    history?: HistoryStrategy;
  };
  return: boolean;
  on_failure?: 'continue' | 'escalate' | 'respond';
  failure_message?: string;
  on_return?: string | HandoffReturnMapping;
  remote?: RemoteAgentLocation;
  timeout?: string;
  on_timeout?: string;
  /** Whether to use async dispatch with push notifications for remote agents */
  async?: boolean;
  /** Timeout for async handoff in seconds (defaults to remote timeout) */
  asyncTimeout?: number;
  experienceMode?: CustomerExperienceMode;
}

/** Project-level defaults for coordination (handoff/delegate) behavior */
export interface ProjectCoordinationDefaults {
  defaultHistoryStrategy?: HistoryStrategy;
  autoHistoryFallbackLastN?: number;
  defaultContextValidation?: boolean;
}

export interface EscalationConfig {
  triggers: EscalationTrigger[];
  context_for_human: string[];
  on_human_complete: OnHumanComplete[];
  routing?: EscalationRouting;
  /** Optional connector action name for ITSM integration (e.g., 'servicenow_create_incident') */
  connector_action?: string;
}

export interface EscalationTrigger {
  when: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical' | number;
  tags?: string[];
}

export interface OnHumanComplete {
  condition: string;
  action: string;
}

export interface EscalationRouting {
  connection: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  post_agent?: 'return' | 'end';
  voice?: {
    transfer_method?: 'invite' | 'refer' | 'bye';
    sip_headers?: Record<string, string>;
  };
  provider_config?: Record<string, unknown>;
}

// =============================================================================
// COMPLETION
// =============================================================================

export interface CompletionConfig {
  conditions: CompletionCondition[];
}

export interface CompletionCondition {
  when: string;
  respond?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  store?: string;
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

export interface ErrorHandlingConfig {
  handlers: ErrorHandler[];
  default_handler: ErrorHandler;
}

export interface ErrorHandler {
  type: string;
  /** Error subtypes for fine-grained matching (e.g. 'credit_card_declined', 'room_unavailable') */
  subtypes?: string[];
  respond?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  retry?: number;
  retry_delay_ms?: number;
  /** Backoff strategy for retries */
  retry_backoff?: 'fixed' | 'exponential' | 'linear';
  /** Maximum delay between retries (caps exponential/linear growth) */
  retry_max_delay_ms?: number;
  then: 'continue' | 'escalate' | 'handoff' | 'complete' | 'backtrack' | 'retry_step';
  handoff_target?: string;
  /** Target step name for backtrack action */
  backtrack_to?: string;
}

// =============================================================================
// MESSAGES
// =============================================================================

/**
 * Configurable agent messages for i18n and customization
 */
export interface AgentMessages {
  error_default: string;
  constraint_blocked: string;
  gather_prompt: string;
  escalation_format: string;
  conversation_complete: string;
  invalid_handoff: string;
  self_handoff: string;
  tool_fallback_desc: string;
  [key: string]: string;
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Hook action definition
 */
export interface HookAction {
  call?: string;
  call_spec?: ToolInvocationIR;
  set?: Record<string, string>;
  respond?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  /** If true, hook failure aborts the turn. Default false — log warning and continue. */
  critical?: boolean;
}

/**
 * Lifecycle hooks configuration
 */
export interface HooksConfig {
  before_agent?: HookAction;
  after_agent?: HookAction;
  before_turn?: HookAction;
  after_turn?: HookAction;
}

// =============================================================================
// LIFECYCLE
// =============================================================================

/**
 * ON_START configuration - executed when session initializes
 */
export interface StartConfig {
  /** Welcome/greeting message to send */
  respond?: string;
  /** Voice-specific overrides for respond */
  voice_config?: VoiceConfigIR;
  /** Rich content format variants for respond */
  rich_content?: RichContentIR;
  /** Interactive actions for respond */
  actions?: ActionSetIR;
  /** Tool to call during startup (e.g., check_returning_user) */
  call?: string;
  /** Canonical tool invocation for lifecycle startup */
  call_spec?: ToolInvocationIR;
  /** Variables to set during startup */
  set?: Record<string, unknown>;
  /** Agent to delegate to for welcome flow */
  delegate?: string;
}

// =============================================================================
// NLU CONFIGURATION
// =============================================================================

/**
 * NLU model config in IR
 */
export interface NLUModelConfig {
  fast?: string;
  balanced?: string;
}

/**
 * NLU intent definition in IR
 */
export interface NLUIntentDefinition {
  name: string;
  patterns: string[];
  examples?: string[];
  examplesFile?: string;
  entities?: string[];
}

/**
 * NLU category definition in IR
 */
export interface NLUCategoryDefinition {
  name: string;
  patterns: string[];
}

/**
 * NLU entity definition in IR
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
 * NLU evaluation configuration in IR
 */
export interface NLUEvalConfig {
  logPredictions?: boolean;
  abTest?: boolean;
  confidenceThreshold?: number;
}

/**
 * NLU embeddings configuration in IR
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
 * Complete NLU IR configuration — compiled from ABL NLU: section
 */
export interface NLUIRConfig {
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
}

// =============================================================================
// CANONICAL ENTITY REGISTRY
// =============================================================================

/**
 * Unified entity type system — merges GATHER field types and NLU entity types.
 *
 * System types (email, phone, date, etc.) have built-in intrinsic validation.
 * Custom types (enum, pattern) are user-defined.
 */
export type EntityType =
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

/**
 * Canonical entity definition in the IR entity registry.
 *
 * Every entity in the system (from ENTITIES, NLU.entities, or inline GATHER TYPE)
 * is lowered into this format. The `source` field tracks provenance.
 */
export interface EntityDefinitionIR {
  /** Entity name — unique within the agent */
  name: string;
  /** Unified entity type */
  type: EntityType;
  /** Allowed values for enum entities */
  values?: string[];
  /** Synonym map — canonical value → alternative forms */
  synonyms?: Record<string, string[]>;
  /** Regex pattern for pattern-type entities */
  pattern?: string;
  /** Intrinsic validation expression (entity-level, not business-level) */
  intrinsic_validation?: string;
  /** Whether this entity carries PII */
  sensitive?: boolean;
  /** Where this entity was defined — for debugging and migration tooling */
  source: 'explicit' | 'nlu_lowered' | 'gather_inline' | 'system';
}

// =============================================================================
// MULTI-INTENT HANDLING
// =============================================================================

/** Multi-intent handling strategy */
export type MultiIntentStrategy =
  | 'sequential' // Execute intents in order, pass context forward
  | 'parallel' // Fan-out to sub-agents (supervisor only)
  | 'primary_queue' // Handle primary, queue rest, surface after completion
  | 'disambiguate' // Ask user to choose
  | 'auto'; // LLM decides based on intent relationships

/** Intent relationship type (assessed by LLM during detection) */
export type IntentRelationshipType = 'independent' | 'dependent' | 'ambiguous';

/** Multi-intent configuration on AgentIR */
export interface IntentHandlingConfig {
  multi_intent?: {
    enabled: boolean;
    strategy: MultiIntentStrategy;
    max_intents: number;
    confidence_threshold: number;
    queue_max_age_ms: number;
  };
}

// =============================================================================
// STATIC GRAPH (State Machine Visualization)
// =============================================================================

/**
 * Static graph node types for state machine visualization
 */
export type StaticNodeType =
  | 'entry' // Flow entry point
  | 'step' // Regular flow step
  | 'decision' // ON_INPUT branch point (deterministic)
  | 'llm_decision' // Intent classification (non-deterministic)
  | 'exit'; // Completion/terminal

/**
 * Static graph edge types
 */
export type StaticEdgeType =
  | 'sequential' // Simple THEN
  | 'conditional' // ON_INPUT branch with condition
  | 'success' // ON_SUCCESS path
  | 'failure' // ON_FAILURE path
  | 'error' // ON_FAIL path
  | 'digression'; // Intent-based jump

/**
 * Node in the static execution graph
 */
export interface StaticGraphNode {
  id: string;
  type: StaticNodeType;
  label: string;
  deterministic: boolean;
  step?: {
    call?: string;
    respond?: string;
    check?: string; // Reference to constraint phase
  };
  conditions?: string[]; // For decision nodes
}

/**
 * Edge in the static execution graph
 */
export interface StaticGraphEdge {
  id: string;
  from: string;
  to: string;
  type: StaticEdgeType;
  label?: string; // Condition text
  isDefault?: boolean; // ELSE branch
}

/**
 * Complete static graph for state machine visualization
 */
export interface StaticGraph {
  nodes: StaticGraphNode[];
  edges: StaticGraphEdge[];
  entryPoint: string;
}

// =============================================================================
// FLOW (Scripted Mode)
// =============================================================================

export interface FlowConfig {
  /** Step execution order */
  steps: string[];

  /** Step definitions */
  definitions: Record<string, FlowStep>;

  /** Entry point (default: first step) */
  entry_point?: string;

  /** Global digressions available in all steps */
  global_digressions?: Digression[];

  /** Static graph for state machine visualization */
  staticGraph?: StaticGraph;
}

/** SET assignment — variable = expression, resolved at execution time */
export interface SetAssignmentIR {
  variable: string;
  expression: string;
}

/** TRANSFORM pipeline configuration */
export interface TransformConfigIR {
  source: string;
  item_var: string;
  target: string;
  filter?: string;
  map?: Record<string, string>;
  sort_by?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}

/** Canonical tool invocation shape shared across execution surfaces. */
export interface ToolInvocationIR {
  tool: string;
  with?: Record<string, unknown>;
  as?: string;
}

/** Reasoning zone configuration for a flow step (compiled from REASONING: true) */
export interface ReasoningZoneIR {
  /** Goal for the reasoning zone (from step GOAL or agent GOAL) */
  goal: string;
  /** Tool names available in this reasoning zone (subset of agent tools) */
  available_tools?: string[];
  /** Condition to exit the reasoning loop (evaluated after each turn) */
  exit_when?: string;
  /** Max reasoning turns before forcing exit (default: 10) */
  max_turns: number;
  /** Step-level constraints */
  constraints?: string[];
}

export interface FlowStep {
  name: string;

  // --- Reasoning zone (present when step has REASONING: true) ---
  /** Reasoning zone configuration (present = this step uses LLM reasoning) */
  reasoning_zone?: ReasoningZoneIR;

  // --- Enhanced multi-field collection (GATHER within FLOW) ---
  /** GATHER-style flexible collection within this step */
  gather?: FlowGatherConfig;

  /** Presentation template shown before collection (with data from previous steps) */
  present?: string;

  /** Allow natural corrections like "actually 4 guests not 3" */
  corrections?: boolean;

  /** Condition for when this step is complete (default: all required gather fields) */
  complete_when?: string;

  // --- Computed assignments ---
  /** SET variable = expression (resolved at execution time) */
  set?: SetAssignmentIR[];

  /** CLEAR variable paths to delete from session */
  clear?: string[];

  // --- Data transformation ---
  /** TRANSFORM array pipeline (filter/map/sort/limit) */
  transform?: TransformConfigIR;

  // --- Actions ---
  call?: string;
  /** Canonical tool invocation for this step */
  call_spec?: ToolInvocationIR;
  /** Explicit key-value parameters for CALL (from WITH: block) */
  call_with?: Record<string, string>;
  /** Variable name for CALL result binding (from AS:) */
  call_as?: string;
  /** Condition expression to determine call success (evaluated against session + _result) */
  success_when?: string;
  check?: string;
  respond?: string; // Response shown after call/action (with results)
  message_key?: string; // Locale catalog key for respond
  voice_config?: VoiceConfigIR; // Voice-specific overrides for respond
  rich_content?: RichContentIR; // Rich content format variants for respond
  actions?: ActionSetIR; // Interactive actions for respond
  on_action?: ActionHandlerIR[]; // Handlers for interactive responses
  on_fail?: string; // Simple on-fail step reference (legacy)
  then?: string;

  // --- Call result branches (for CALL steps with ON_SUCCESS/ON_FAIL blocks) ---
  /** Branch for successful call result */
  on_success?: CallResultBlock;
  /** Branch for failed call result */
  on_failure?: CallResultBlock;

  // --- Multi-way branching on tool results or deterministic flow context ---
  /** ON_RESULT: multi-way branching after CALL, or no-CALL deterministic gates using session vars/input */
  on_result?: InputBranch[];

  // --- Branching ---
  /** Conditional branches based on user input (ON_INPUT) - legacy rigid branching */
  on_input?: InputBranch[];

  // --- Intent handling ---
  /** Digressions: intent-based escapes from this step */
  digressions?: Digression[];

  /** Sub-intents: scoped intents valid only within this step */
  sub_intents?: SubIntent[];

  // --- Step-level error handling ---
  /** Step-level error handlers (override agent-level handlers for this step) */
  on_error?: ErrorHandler[];

  // --- Human-in-the-loop ---
  /** Human approval gate — suspends execution until a human approves/rejects */
  human_approval?: HumanApprovalIR;

  // --- Attachment collection ---
  /** AWAIT_ATTACHMENT: pause execution until the user provides a file attachment */
  await_attachment?: AwaitAttachmentIR;
}

/**
 * AwaitAttachmentIR — configuration for an attachment collection gate within a flow step.
 * Execution pauses until the user provides a file attachment or timeout is reached.
 */
export interface AwaitAttachmentIR {
  /** Variable name to store the attachment ID in session */
  variable: string;
  /** User-facing prompt text requesting the attachment */
  prompt: string;
  /** Attachment category filter: image, document, audio, video */
  category?: 'image' | 'document' | 'audio' | 'video';
  /** Whether the attachment is required (default: true) */
  required: boolean;
  /** Timeout in seconds before transitioning to on_timeout step */
  timeout_seconds?: number;
  /** Step name to transition to on timeout */
  on_timeout?: string;
}

/**
 * HumanApprovalIR — configuration for a human approval gate within a flow step.
 * Execution suspends and resumes when the human provides their decision.
 */
export interface HumanApprovalIR {
  /** Prompt template shown to the human approver */
  prompt: string;
  /** Who should approve (expression resolving to user/role/routing key) */
  assignee?: string;
  /** Timeout in seconds before auto-action (default: 86400 = 24 hours) */
  timeoutSeconds: number;
  /** Step to transition to on approval */
  onApprove: string;
  /** Step to transition to on rejection */
  onReject: string;
  /** Step to transition to on timeout */
  onTimeout: string;
}

/** GATHER configuration within a FLOW step */
export interface FlowGatherConfig {
  /** Fields to collect in this step */
  fields: FlowGatherField[];

  /** Extraction strategy (default: hybrid) */
  strategy?: 'llm' | 'pattern' | 'hybrid';

  /** Prompt template for collecting (supports {{field}} placeholders for missing fields) */
  prompt?: string;
  /** Locale catalog key for the whole gather prompt */
  message_key?: string;
}

/** Field definition for GATHER within FLOW */
export interface FlowGatherField {
  name: string;
  /** Reference to a named entity in ir.entities */
  entity_ref?: string;
  type?: string; // string, number, date, email, phone, etc.
  required?: boolean; // default: true
  default?: unknown;
  prompt?: string; // Individual prompt for this field
  /** Locale catalog key for prompt */
  message_key?: string;
  validation?: ValidationRule;
  extraction_hints?: string[]; // Hints for LLM extraction
  infer?: boolean; // Allow LLM to infer (true) or require grounding (false)
  /** Minimum confidence for LLM inference acceptance (default: 0.8) */
  infer_confidence?: number;
  /** Whether to confirm inferred values with user (default: true) */
  infer_confirm?: boolean;
  /** Supplemental metadata describing what the value represents */
  semantics?: GatherFieldSemantics;
  /** Collect as range {low, high} instead of scalar */
  range?: boolean;
  /** Collect as array instead of scalar */
  list?: boolean;
  /** Categorize into accept/desire/avoid/refuse preference sets */
  preferences?: boolean;
  /** Activation mode: required (default), optional, progressive, or data-driven */
  activation?: GatherActivation;
  /** Field names that must be collected before this field activates */
  depends_on?: string[];
  /** Whether prompt is for user-facing ask or LLM extraction only */
  prompt_mode?: 'ask' | 'extract_only';
  /** Whether this field carries PII and should be treated as sensitive */
  sensitive?: boolean;
  /** Display mode for sensitive field values in non-gathering contexts */
  sensitive_display?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitive_display: 'mask') */
  mask_config?: { show_first: number; show_last: number; char: string };
  /**
   * Explicit PII type hint. Used when the field name is non-canonical
   * so the redactor can produce a shape-preserving mask.
   * Parsed from DSL key `PII_TYPE:` on the gather field.
   */
  pii_type?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
  /** Whether PII auto-cleans after gather completes (for CVV, OTP — XO migration) */
  transient?: boolean;
  /** Custom regex pattern for value extraction (XO migration) */
  extraction_pattern?: string;
  /** Capture group index for extraction_pattern (default: 0 = full match) */
  extraction_group?: number;
  /** Allowed values for enum type fields */
  enum_values?: string[];
  /** Synonym map from NLU entity definitions (canonical value → synonym list) */
  synonyms?: Record<string, string[]>;
  /** Voice-specific overrides (populated when prompt uses TEMPLATE with voice config) */
  voice_config?: VoiceConfigIR;
  /** Rich content format variants (populated when prompt uses TEMPLATE with formats) */
  rich_content?: RichContentIR;
}

/** Digression: intent-based escape from current step */
export interface DigressionOnReturn {
  /** Structured result mapping (child key -> parent key) */
  map?: Record<string, string>;
}

/** Ordered digression action within a canonical DO block */
export interface DigressionAction {
  /** Response emitted at this action */
  respond?: string;
  /** Locale catalog key for respond */
  message_key?: string;

  /** Voice-specific overrides for respond */
  voice_config?: VoiceConfigIR;

  /** Rich content format variants for respond */
  rich_content?: RichContentIR;

  /** Interactive actions for respond */
  actions?: ActionSetIR;

  /** Variables to set sequentially */
  set?: Record<string, string>;

  /** Variables to clear sequentially */
  clear?: string[];

  /** Tool to call sequentially */
  call?: string;
  call_spec?: ToolInvocationIR;

  /** Agent to delegate to sequentially */
  delegate?: string;

  /** Whether the delegate must return before execution continues */
  return?: boolean;

  /** Explicit return mapping contract for delegate results */
  on_return?: DigressionOnReturn;

  /** Resume current step (terminal) */
  resume?: boolean;

  /** Transition to another step (terminal) */
  goto?: string;
}

export interface Digression {
  /** Intent pattern to match (e.g., "cancel", "help", "weather_query") */
  intent: string;

  /** Explicit keywords for matching (overrides splitting intent string) */
  keywords?: string[];

  /** Optional condition for when this digression applies */
  condition?: string;

  /** Canonical ordered actions */
  do?: DigressionAction[];

  /** Response message before handling */
  respond?: string;
  /** Locale catalog key for respond */
  message_key?: string;

  /** Voice-specific overrides for respond */
  voice_config?: VoiceConfigIR;

  /** Rich content format variants for respond */
  rich_content?: RichContentIR;

  /** Interactive actions for respond */
  actions?: ActionSetIR;

  /** Target step to go to */
  goto?: string;

  /** Agent to delegate to */
  delegate?: string;

  /** Tool to call */
  call?: string;
  call_spec?: ToolInvocationIR;

  /** Whether to resume current step after handling (default: false) */
  resume?: boolean;

  /** Variables to clear before resuming */
  clear?: string[];
}

/** Sub-intent: scoped intent valid only within a step */
export interface SubIntent {
  /** Intent pattern (e.g., "change destination", "more options") */
  intent: string;

  /** Response message */
  respond?: string;
  /** Locale catalog key for respond */
  message_key?: string;

  /** Voice-specific overrides for respond */
  voice_config?: VoiceConfigIR;

  /** Rich content format variants for respond */
  rich_content?: RichContentIR;

  /** Interactive actions for respond */
  actions?: ActionSetIR;

  /** Variables to clear (triggers re-collection) */
  clear?: string[];

  /** Variables to set */
  set?: Record<string, string>;

  /** Tool to call */
  call?: string;
  call_spec?: ToolInvocationIR;

  /** Stay in current step (default: true for sub-intents) */
  resume?: boolean;
}

/** Branch for ON_INPUT conditional handling (legacy) */
export interface InputBranch {
  condition?: string; // IF condition (undefined = ELSE/default branch)
  respond?: string; // Optional response message
  message_key?: string; // Locale catalog key for respond
  voice_config?: VoiceConfigIR; // Voice-specific overrides for respond
  rich_content?: RichContentIR; // Rich content format variants for respond
  actions?: ActionSetIR; // Interactive actions for respond
  set?: Record<string, string>; // Variable assignments
  call?: string; // Optional tool call
  call_spec?: ToolInvocationIR; // Canonical tool invocation
  then: string; // Next step to transition to
}

/** Branch within ON_SUCCESS / ON_FAILURE for conditional handling of tool results */
export interface CallResultBranch {
  condition?: string; // IF condition (undefined = ELSE/default branch)
  respond?: string; // Response message
  message_key?: string; // Locale catalog key for respond
  voice_config?: VoiceConfigIR; // Voice-specific overrides for respond
  rich_content?: RichContentIR; // Rich content format variants for respond
  actions?: ActionSetIR; // Interactive actions for respond
  set?: Record<string, string>; // Variable assignments
  call?: string; // Optional nested tool call
  call_spec?: ToolInvocationIR; // Canonical tool invocation
  then: string; // Next step
}

/** ON_SUCCESS / ON_FAILURE block — simple (respond+then) or conditional (branches) */
export interface CallResultBlock {
  respond?: string; // Simple: single response
  message_key?: string; // Locale catalog key for respond
  voice_config?: VoiceConfigIR; // Voice-specific overrides for respond
  rich_content?: RichContentIR; // Rich content format variants for respond
  actions?: ActionSetIR; // Interactive actions for respond
  set?: Record<string, string>; // Variable assignments for simple blocks
  then?: string; // Simple: single next step
  branches?: CallResultBranch[]; // Conditional: evaluated in order (first match wins)
}

/**
 * SupervisorIR — backward-compatible alias.
 * Supervisor fields (routing, available_agents) are now optional on AgentIR.
 * Use this type when you know an AgentIR has routing configured.
 */
export type SupervisorIR = AgentIR & {
  routing: RoutingConfig;
  available_agents: string[];
};

// =============================================================================
// ROUTING CONFIG (used by agents with supervisor role)
// =============================================================================

export interface RoutingConfig {
  /** Routing rules in priority order */
  rules: RoutingRule[];

  /** Default agent for unmatched intents */
  default_agent: string;

  /** Intent classification config */
  intent_classification: IntentConfig;

  /** Allow supervisor to respond directly for simple queries (softer routing) */
  direct_response_allowed?: boolean;
}

export interface RoutingRule {
  to: string;
  when: string;
  description: string;
  priority: number;
  /** Whether control should return to supervisor after this handoff */
  return?: boolean;
}

/** A single intent category, optionally with a description from the INTENTS: block */
export interface IntentCategory {
  /** Category name (e.g., "billing", "setup", "escalation") */
  name: string;
  /** Human-readable description from INTENTS: block. Undefined for inferred categories. */
  description?: string;
}

export type IntentClassificationLexicalFallback = 'never' | 'when_unavailable' | 'always';

export interface IntentConfig {
  /** Intent categories — flat vocabulary for classification */
  categories: IntentCategory[];
  /** Confidence threshold */
  min_confidence: number;
  /** Whether categories came from explicit INTENTS: block or WHEN extraction */
  source: 'explicit' | 'inferred';
  /** Optional supervisor lexical rescue policy for gather interrupts. */
  lexical_fallback?: IntentClassificationLexicalFallback;
}

// =============================================================================
// IR COMPILATION OUTPUT
// =============================================================================

/**
 * Complete compilation output including all agents
 */
export interface CompilationOutput {
  /** IR version */
  version: '1.0';

  /** Compilation timestamp */
  compiled_at: string;

  /** All agent IRs (including supervisors) */
  agents: Record<string, AgentIR>;

  /** Entry agent name (supervisor / entry point) */
  entry_agent?: string;

  /** Deployment hints */
  deployment: DeploymentHints;

  /** Registry of remote agents referenced in handoffs/delegates */
  remote_agents?: Record<string, RemoteAgentLocation>;

  /** Project-level coordination defaults */
  coordination_defaults?: ProjectCoordinationDefaults;

  /** Per-agent compilation errors (agents that failed are omitted from `agents`) */
  compilation_errors?: CompilationError[];

  /** Per-agent validation warnings (non-blocking) */
  compilation_warnings?: CompilationError[];

  /** Additive alias for SDK callers that only inspect `errors`. */
  errors?: CompilationError[];

  /** Additive alias for SDK callers that only inspect `warnings`. */
  warnings?: CompilationError[];

  /** Config variable resolution metadata (present when config_variables were provided) */
  resolved_config_variables?: ConfigVariableResolution;

  /** Tool snapshot captured at compile time (audit trail for which project tools were resolved) */
  tool_snapshot?: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    toolType: 'http' | 'sandbox' | 'mcp';
    description: string | null;
    dslContent: string;
  }>;
}

/** Metadata about config variable resolution during compilation */
export interface ConfigVariableResolution {
  /** Config variables that were provided and used */
  resolved: Record<string, string>;
  /** Config variable keys referenced in ABL but not provided */
  unresolved: string[];
  /** Config variable keys provided but not referenced */
  unused: string[];
}

export interface CompilationError {
  /** Agent name or document name that failed */
  agent: string;
  /** Error message */
  message: string;
  /** Machine-readable validation code when available */
  code?: string;
  /** Path within the IR for validation diagnostics */
  path?: string;
  /** Referenced agent target for cross-agent validation diagnostics */
  referenced_agent?: string;
  /** Error type */
  type: 'parse' | 'compilation' | 'validation';
  /** Severity for validation diagnostics. Errors should block deployment; warnings are informational. */
  severity?: 'error' | 'warning';
}

export interface DeploymentHints {
  /** Recommended runtime for each agent */
  runtime_recommendations: Record<string, 'voice' | 'digital' | 'workflow'>;

  /** Agents that can run in parallel */
  parallel_safe: string[];

  /** Agents requiring persistent state */
  stateful: string[];

  /** Agents with HITL requirements */
  hitl_capable: string[];
}

// =============================================================================
// APP-LEVEL CONFIGURATION (Multi-Agent Visualization)
// =============================================================================

/**
 * App configuration for multi-agent visualization
 * Represents a collection of related agents that work together
 */
export interface AppConfig {
  /** App name (e.g., "traveldesk", "saludsa") */
  name: string;

  /** Entry agent - the starting point (typically supervisor) */
  entryAgent: string;

  /** All agents in this app */
  agents: string[];

  /** Inter-agent connections derived from handoffs/delegates */
  connections: AgentConnection[];
}

/**
 * Connection between agents (handoff or delegate)
 */
export interface AgentConnection {
  /** Source agent name */
  from: string;

  /** Target agent name */
  to: string;

  /** Connection type */
  type: 'handoff' | 'delegate';

  /** Condition that triggers this connection */
  when?: string;

  /** Whether control returns to source after target completes */
  returns: boolean;

  /** Label for the connection */
  label?: string;

  /** Customer experience/topology mode for this edge */
  experienceMode?: CustomerExperienceMode;
}

/**
 * Combined static graph for app-level visualization
 * Shows all agents and their internal flows in one diagram
 */
export interface AppStaticGraph {
  /** App configuration */
  app: AppConfig;

  /** Individual agent static graphs */
  agentGraphs: Record<string, StaticGraph>;

  /** Inter-agent edges (handoffs/delegates between agents) */
  interAgentEdges: InterAgentEdge[];

  /** Layout hints for positioning agents */
  layout: AppLayoutHints;
}

/**
 * Edge connecting two agents
 */
export interface InterAgentEdge {
  id: string;
  fromAgent: string;
  fromNode?: string; // Optional: specific node within agent
  toAgent: string;
  toNode?: string; // Optional: specific entry point in target
  type: 'handoff' | 'delegate';
  label?: string;
  returns: boolean;
}

/**
 * Layout hints for app visualization
 */
export interface AppLayoutHints {
  /** Suggested positions for agents (relative) */
  agentPositions: Record<string, { row: number; col: number }>;

  /** Entry agent should be at the top/left */
  entryPosition: 'top' | 'left';

  /** Suggested flow direction */
  direction: 'horizontal' | 'vertical';
}
