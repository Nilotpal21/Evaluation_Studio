/**
 * Shared constants for the ABL compiler and runtime.
 * Replaces magic strings with named constants for maintainability.
 */

import type { IntentCategory } from './ir/schema.js';

// =============================================================================
// FLOW & STEPS
// =============================================================================

/** Terminal step name that signals flow completion */
export const TERMINAL_STEP = 'COMPLETE';

// =============================================================================
// SUPERVISOR & ROUTING
// =============================================================================

/** Default fallback agent for unmatched intents in supervisor routing */
export const DEFAULT_FALLBACK_AGENT = 'Fallback_Handler';

/** Default intent categories always included in supervisor classification (inferred mode) */
export const DEFAULT_INTENT_CATEGORIES: IntentCategory[] = [
  { name: 'greeting' },
  { name: 'farewell' },
  { name: 'escalation' },
];

/** Default minimum confidence threshold for intent classification */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** Default escalation target for constraint handoffs */
export const DEFAULT_ESCALATION_TARGET = 'supervisor';

// =============================================================================
// CONTEXT KEYS
// =============================================================================

/** Context key for conversation summary during handoffs */
export const CONTEXT_SUMMARY_KEY = '_summary';

/** Prefix for stored context values */
export const CONTEXT_STORED_PREFIX = '_stored_';

/** Context key for error information */
export const CONTEXT_ERROR_KEY = '_error';

/** Context key for correction information */
export const CONTEXT_CORRECTION_KEY = '_correction';

/** Context key for the active structural constraint checkpoint kind. */
export const CONSTRAINT_CHECKPOINT_KIND_KEY = '_abl_constraint_checkpoint_kind';

/** Context key for the active structural constraint checkpoint target. */
export const CONSTRAINT_CHECKPOINT_TARGET_KEY = '_abl_constraint_checkpoint_target';

// =============================================================================
// SYSTEM TOOL NAMES
// =============================================================================

/** System tool for agent handoff */
export const SYSTEM_TOOL_HANDOFF = '__handoff__';

/** System tool for delegation */
export const SYSTEM_TOOL_DELEGATE = '__delegate__';

/** System tool for conversation completion */
export const SYSTEM_TOOL_COMPLETE = '__complete__';

/** System tool for escalation */
export const SYSTEM_TOOL_ESCALATE = '__escalate__';

/** System tool for multi-intent fan-out */
export const SYSTEM_TOOL_FAN_OUT = '__fan_out__';

/** System tool for setting session context variables */
export const SYSTEM_TOOL_SET_CONTEXT = '__set_context__';

/** System tool for returning control to parent supervisor */
export const SYSTEM_TOOL_RETURN_TO_PARENT = '__return_to_parent__';

// =============================================================================
// DEFAULT MESSAGES (English)
// =============================================================================

/** Default agent messages for English locale */
export const DEFAULT_MESSAGES: Record<string, string> = {
  // Core messages
  error_default: 'An error occurred. Please try again.',
  constraint_blocked: 'I cannot proceed with that request.',
  gather_prompt: 'Please provide: {{fields}}',
  escalation_format: 'Escalating to human agent. Reason: {{reason}}',
  conversation_complete: 'This conversation has been completed.',
  invalid_handoff: 'Unable to transfer to the requested agent.',
  self_handoff: 'Cannot hand off to self.',
  tool_fallback_desc: 'Execute the requested operation.',
  empty_input: 'Please provide a message.',
  max_iterations: 'I was unable to complete the response. Please try again.',

  // Constraint action fallback messages
  constraint_respond: 'Request cannot be processed.',
  constraint_collect: 'Additional information needed.',
  constraint_backtrack: 'Let me take a step back.',
  constraint_redact: 'That information has been redacted.',

  // Multi-intent disambiguation
  multi_intent_disambiguate_header:
    'I noticed your message may contain multiple requests. Could you clarify which you would like me to help with first?',
  multi_intent_disambiguate_option: '{{index}}. {{intent}} (confidence: {{confidence}})',
  multi_intent_queued_notice:
    'I will address your other requests after completing the current one.',
  multi_intent_queued_follow_up: 'Next: {{next_intent}}. Would you like me to help with that?',

  // Handoff messages (digital and voice)
  handoff_message: '\n\n\ud83d\udce4 **Transferring to {{target}}...**\n\n',
  handoff_message_voice: 'Transferring you to {{target}}. One moment please.',
  remote_handoff_message: '\n\n\ud83d\udce4 **Connecting to remote agent {{target}}...**\n\n',
  remote_handoff_message_voice: 'Connecting you to {{target}}. Please hold.',
  routing_message: 'Routing to {{target}} for assistance.',

  // Error executor messages
  error_tool_timeout:
    "I'm having trouble reaching some of our systems right now. Let me try a different approach.",
  error_tool_error: 'I encountered an issue while processing your request. Let me try again.',
  error_llm_timeout: 'I apologize for the delay. Could you please repeat your request?',
  error_llm_error: "I'm having some technical difficulties. Please try again in a moment.",
  error_validation:
    "The information provided doesn't seem to be in the expected format. Could you please verify and try again?",
  error_constraint: "I'm unable to proceed with that request due to policy restrictions.",
  error_delegation:
    "I wasn't able to connect with the appropriate service. Let me try to help you directly.",
  error_handoff: "I'm having trouble transferring your request. Please hold while I resolve this.",
  error_memory:
    "I'm having trouble accessing some information. This shouldn't affect our conversation.",
  error_unknown: 'I encountered an unexpected issue. Let me try to help you another way.',

  // LLM error subtype messages (used by reasoning-executor when an LLM error
  // has a subtype but no agent-level handler matched). Defaults match
  // `error_default` so existing non-customized agents see ZERO behavior change.
  // Authors override these in the agent DSL's MESSAGES section to provide
  // subtype-specific UX.
  // NOTE: error_llm_timeout and error_llm_error already exist above (executor-
  // level messages). The subtype key for MODEL_TIMEOUT maps to error_llm_timeout,
  // reusing the existing message. The five new keys below are additive.
  error_llm_content_filter: 'An error occurred. Please try again.',
  error_llm_rate_limited: 'An error occurred. Please try again.',
  error_llm_context_exceeded: 'An error occurred. Please try again.',
  error_llm_api_error: 'An error occurred. Please try again.',
  error_llm_credential_not_found: 'An error occurred. Please try again.',

  // Voice-specific messages
  voice_repeat: 'Could you please repeat that?',
  voice_nomatch: "I didn't understand. Please try again.",
  voice_noinput: "I didn't hear anything. Please try again.",
  voice_system_busy: 'The system is busy. Please try again later.',
  voice_error: 'An error occurred. Please try again later.',
  voice_session_not_found: 'Session not found.',
  greeting: 'How can I help you?',

  // Pipeline intent bridge
  out_of_scope:
    "I'm sorry, but that request is outside what I can help with. Let me know if there's something else I can assist you with.",
};

// =============================================================================
// CONFIDENCE THRESHOLDS (NLU)
// =============================================================================

/** Confidence for exact example match in fallback layer */
export const CONFIDENCE_EXACT_MATCH = 0.9;

/** Confidence for quoted-phrase match in fallback layer */
export const CONFIDENCE_PHRASE_MATCH = 0.8;

/** Confidence for keyword/pattern match in fallback layer */
export const CONFIDENCE_KEYWORD_MATCH = 0.7;

/** Confidence for weak/partial match */
export const CONFIDENCE_WEAK_MATCH = 0.6;

/** Confidence for very weak fallback match */
export const CONFIDENCE_FALLBACK = 0.5;

// =============================================================================
// DEFAULT TIMEOUTS (ms)
// =============================================================================

/** Default timeout for tool execution */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default timeout for LLM calls */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/** Default session idle timeout (30 minutes) */
export const DEFAULT_SESSION_TIMEOUT_MS = 1_800_000;

/** Default number of prior conversation turns included in extraction LLM calls. */
export const DEFAULT_CONVERSATION_HISTORY_WINDOW = 2;

/**
 * Hard cap on the conversation history window regardless of agent configuration.
 * Prevents accidental token bloat on agents with large conversation histories.
 */
export const MAX_CONVERSATION_HISTORY_WINDOW = 10;

/** Voice latency target for scripted mode */
export const VOICE_LATENCY_SCRIPTED_MS = 500;

/** Voice latency target for interactive mode */
export const VOICE_LATENCY_INTERACTIVE_MS = 1_000;

// =============================================================================
// CONFIG VARIABLE RESOLUTION
// =============================================================================

/** Pattern for {{config.KEY}} placeholders */
export const CONFIG_VAR_PATTERN = /\{\{config\.(\w+)\}\}/g;

/** Pattern for {{env.KEY}} placeholders — resolved at compile/deploy time */
export const ENV_VAR_PATTERN = /\{\{env\.(\w+)\}\}/g;

/** Maximum number of config variables per project */
export const MAX_CONFIG_VARIABLES_PER_PROJECT = 200;

/** Maximum length of a config variable value */
export const MAX_CONFIG_VAR_VALUE_LENGTH = 4096;

/** Maximum length of a config variable key */
export const MAX_CONFIG_VAR_KEY_LENGTH = 100;

// =============================================================================
// VARIABLE NAMESPACES
// =============================================================================

/** Maximum number of variable namespaces per project */
export const MAX_VARIABLE_NAMESPACES_PER_PROJECT = 25;

/** Maximum number of variable namespaces a single variable can belong to */
export const MAX_VARIABLE_NAMESPACES_PER_VARIABLE = 10;

/** Maximum number of environment variables per project */
export const MAX_ENV_VARS_PER_PROJECT = 500;

/** Maximum length of a variable namespace slug name */
export const MAX_VARIABLE_NAMESPACE_NAME_LENGTH = 50;

/** Maximum length of a variable namespace display name */
export const MAX_VARIABLE_NAMESPACE_DISPLAY_NAME_LENGTH = 100;

/** Pattern for valid variable namespace slug names (lowercase, alphanumeric, hyphens) */
export const VARIABLE_NAMESPACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Reserved name for the auto-created default variable namespace */
export const DEFAULT_VARIABLE_NAMESPACE_NAME = 'default';

/** Display name for the default variable namespace */
export const DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME = 'Default';

// =============================================================================
// DEFAULT CORRECTION PATTERNS
// =============================================================================

/** Default correction detection regex patterns */
export const DEFAULT_CORRECTION_PATTERNS = [
  '^actually[,]?\\s+(.+)$',
  "^no[,]?\\s+(?:it'?s?|make it|change (?:it )?to)?\\s*(.+)$",
  '^(?:i meant|change (?:it )?to|make it)\\s+(.+)$',
  '^not\\s+\\w+[,]?\\s+(.+)$',
  '^(\\d+)\\s+(?:guests?|people|rooms?|nights?)\\s+(?:instead|not\\s+\\d+)$',
];

// =============================================================================
// ESCALATION FORMAT TEMPLATES
// =============================================================================

/** Escalation message templates by channel type */
export const ESCALATION_FORMAT = {
  digital:
    '\ud83d\udd14 **Escalated to Human Agent**\nReason: {{reason}}\nPriority: {{priority}}\n\n[A human agent will respond to your next message]',
  voice: 'Escalated to human agent. Reason: {{reason}}. Priority: {{priority}}.',
  plain: 'Escalated to human agent. Reason: {{reason}}. Priority: {{priority}}',
} as const;

// =============================================================================
// NAMED LIMIT CONSTANTS
// =============================================================================

/** Minimum number of tasks for fan-out dispatch */
export const FAN_OUT_MIN_TASKS = 2;

/** Maximum number of tasks for fan-out dispatch */
export const FAN_OUT_MAX_TASKS = 5;

/** Maximum retry count allowed by error handler to prevent infinite loops */
export const ERROR_HANDLER_MAX_RETRIES = 10;

/** Maximum backoff delay in milliseconds for error handler retries */
export const ERROR_HANDLER_MAX_BACKOFF_MS = 60_000;

/** Maximum number of times a constraint can backtrack to the same step before escalating */
export const DEFAULT_MAX_BACKTRACKS_PER_STEP = 3;

/** Minimum length for escalation reason text */
export const ESCALATION_REASON_MIN_LENGTH = 5;

/** Maximum length for escalation reason text */
export const ESCALATION_REASON_MAX_LENGTH = 500;

// =============================================================================
// SYSTEM PROMPT TEMPLATES
// =============================================================================

/**
 * Named prompt template fragments for buildSystemPrompt().
 * Each key is a logical section of the system prompt.
 * Templates use {{variable}} interpolation.
 */
export const SYSTEM_PROMPT_TEMPLATES = {
  // Identity
  identity: 'You are {{name}}, an AI assistant.',
  goal: '\nYour goal: {{goal}}',
  persona: '\nPersona: {{persona}}',
  limitations_header: '\nLimitations:',
  tools_available: '\nYou have access to tools. Use them when needed to help the user.',

  // Gather
  gather_header: '\nYou need to gather the following information from the user:',
  gather_continuation:
    '\nContinue asking for any missing required fields. The system will automatically detect when all information has been gathered.',

  // Supervisor / routing
  supervisor_header: '\n## CRITICAL: You are a ROUTING-ONLY supervisor',
  supervisor_mandate:
    'You MUST use the {{handoff_tool}} tool to route EVERY user request to the appropriate specialist.',
  supervisor_no_direct:
    'DO NOT respond to users directly with information or help - your ONLY job is to route them.',
  supervisor_no_clarify:
    'DO NOT ask users clarifying questions - pick the best matching agent and hand off immediately.',
  supervisor_routing_header:
    '\n## Routing Rules (use {{handoff_tool}} tool with target parameter):',
  supervisor_mandatory_header: '\n## MANDATORY: Always use {{handoff_tool}} tool',
  supervisor_mandatory_body:
    'For EVERY user message, you MUST call the {{handoff_tool}} tool with the appropriate target.',
  supervisor_never_respond:
    '\nNEVER respond without using {{handoff_tool}}. You are a router, not a conversationalist.',
  supervisor_multi_intent_header: '\n## Multi-Intent Messages',
  supervisor_multi_intent_body:
    "If the user's message contains MULTIPLE distinct requests for different specialists, use {{fan_out_tool}} to dispatch all at once.",
  supervisor_multi_intent_synthesize:
    'You will receive all results and must synthesize one unified response.',
  supervisor_multi_intent_single: 'Use {{handoff_tool}} for single-intent messages only.',

  // Supervisor direct response (when direct_response_allowed is true)
  supervisor_direct_response_header: '\n## Routing Guidance',
  supervisor_direct_response_mandate:
    'You SHOULD use the {{handoff_tool}} tool to route user requests to the appropriate specialist.',
  supervisor_direct_response_simple:
    'For simple greetings, farewells, or trivial queries you may respond directly. For substantive requests, always route to a specialist.',

  // Specialist agents with handoff
  specialist_header: '\n## Your Role',
  specialist_body: 'You are a specialist agent. Help the user directly with your expertise.',
  specialist_no_immediate: 'Do NOT immediately hand off - try to assist the user first.',
  specialist_handoff_header: '\n## Handoff (use only when necessary)',
  specialist_handoff_body:
    "If the user's request matches one of the specific conditions below, you can transfer to another specialist:",
  specialist_handoff_warning:
    '\nIMPORTANT: Only use {{handoff_tool}} when the specific handoff conditions above are met. Do NOT hand off to yourself.',

  // Escalation
  escalation_header: '\n## Escalation',
  escalation_intro: 'Use the {{escalate_tool}} tool ONLY if:',
  escalation_human_request: '- The user explicitly and repeatedly asks for a human agent',
  escalation_attempt_first:
    '\nIMPORTANT: Always attempt to help the user at least once before escalating.',
  escalation_not_routing: '\nDo NOT escalate for normal routing - use {{handoff_tool}} instead.',

  // Voice format
  voice_format_header: '\n## Response Format (Voice Channel)',
  voice_format_intro:
    'This conversation is over a voice channel. Responses are read aloud by text-to-speech.',
  voice_format_rules:
    'Rules: Use plain conversational text only. No markdown (bold, italic, headers, links). No emoji. No numbered lists or bullet points \u2014 use natural flowing sentences. Keep responses concise.',

  // Fallback
  fallback_identity: 'You are {{name}}, an AI assistant.',
  fallback_instruction: '\nHelp the user with their request in a friendly and helpful manner.',

  // Context
  context_header: '\n## Current Context',

  // Memory
  memory_header: '\n## Recalled Memory Instructions',
} as const;

// =============================================================================
// SYSTEM TOOL DESCRIPTIONS
// =============================================================================

/**
 * Descriptions for system tools, keyed by tool name and context.
 * Supervisor and agent contexts may use different description wording.
 */
export const SYSTEM_TOOL_DESCRIPTIONS = {
  handoff: {
    supervisor:
      'MANDATORY: Use this tool to route the user to the appropriate specialist. Available targets: {{targets}}. You MUST call this for every user message.',
    supervisor_target: 'The name of the agent to hand off to. REQUIRED for every user message.',
    agent:
      'Transfer the conversation to another specialist ONLY when one of the specific handoff conditions described in your instructions is met. Do NOT use for requests you can handle yourself. Available targets: {{targets}}.',
    agent_target:
      'The name of the specialist to transfer to. Only use if you cannot help directly.',
    context: 'JSON context to pass to the target agent (optional)',
  },
  delegate: {
    runtime:
      'Call a sub-agent and use their result. The sub-agent runs to completion and returns a result that you can use. Available targets: {{targets}}',
    target: 'The name of the sub-agent to delegate to',
    input:
      'Input data to pass to the sub-agent (will be mapped using delegate config if not provided)',
  },
  escalate: {
    runtime:
      'Transfer the conversation to a human agent. Use when the user explicitly requests human help or when you cannot assist them.',
    reason: 'Reason for escalation',
    priority: 'Priority level',
  },
  fan_out: {
    runtime:
      'Handle a message with MULTIPLE distinct requests needing different specialists. ' +
      'Use ONLY when the user asks 2+ unrelated things in one message. ' +
      'Results are returned for you to synthesize into one unified response. ' +
      'Available targets: {{targets}}.',
    tasks: 'List of sub-tasks to dispatch to specialist agents',
    target: 'The specialist agent to handle this sub-task',
    intent: "What this agent should handle (the user's sub-request)",
    context: 'Optional context to pass to the agent',
  },
  set_context: {
    runtime:
      'Store information learned during conversation (names, preferences, choices) into session memory. ' +
      'Use this when the user shares personal details or preferences you should remember, or when you must update writable execution_tree/granted memory surfaced by the runtime.',
    updates:
      'Key-value pairs to store. Keys should match the session memory variables, writable execution_tree paths, or writable granted_memory paths surfaced by this agent.',
  },
  reason: 'Brief reason for this action (used for tracing and debugging)',
  thought: 'Your detailed reasoning about why this is the right action',
} as const;

// =============================================================================
// ENTITY EXTRACTION PROMPT
// =============================================================================

/**
 * System prompt template for LLM-based entity extraction.
 * Used by flow-step-executor.ts extractEntitiesWithLLM().
 * Interpolated with: contextSection, today, fieldDescriptions.
 */
// =============================================================================
// LIFECYCLE EVENT PATTERNS (RECALL validation)
// =============================================================================

/**
 * Valid lifecycle event patterns for RECALL instructions.
 * Used by compiler validation to check event names.
 *
 * Event taxonomy:
 *   session:start, session:end
 *   agent:<name>:before, agent:<name>:after  (+ agent:*:before, agent:*:after)
 *   tool:<name>:after  (+ tool:*:after)
 *   entity:<field>:extracted, step:(enter|exit):<name>
 */
export const LIFECYCLE_PATTERNS: RegExp[] = [
  /^session:(start|end)$/,
  /^agent:[^:]+:(before|after)$/,
  /^agent:\*:(before|after)$/,
  /^tool:[^:]+:after$/,
  /^tool:\*:after$/,
  /^entity:[^:]+:extracted$/,
  /^step:(enter|exit):[^:]+$/,
];

/** Legacy event names that normalize to new lifecycle format */
export const LEGACY_EVENT_ALIASES: Record<string, string> = {
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};

// =============================================================================
// ENTITY EXTRACTION PROMPT
// =============================================================================

export const ENTITY_EXTRACTION_PROMPT = `You are an entity extraction assistant. Extract information from the user's message.

Return ONLY a valid JSON object with the extracted values.
{{contextSection}}
RULES:
1. If user says "same", "already given", "use previous", or similar - return the value from ALREADY COLLECTED
2. For dates: Convert to YYYY-MM-DD format. Today is {{today}}
3. Only extract values the user explicitly stated. Do not infer values.
4. If a REQUIRED field cannot be determined, omit it
5. For text fields: Capitalize proper nouns appropriately

Fields to extract:
{{fieldDescriptions}}

Example 1 - Extract values from message:
User: "John Smith, email john@example.com"
Output: {"name": "John Smith", "email": "john@example.com"}

Example 2 - Reference to previous value:
Already collected: name: "John"
User: "same"
Output: {"name": "John"}

IMPORTANT: Return ONLY the JSON object, no explanations or markdown.`;
