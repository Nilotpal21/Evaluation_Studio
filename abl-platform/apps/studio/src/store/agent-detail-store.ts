/**
 * Agent Detail Store
 *
 * Manages the agent detail page state: which sections are expanded,
 * parsed IR section data for each accordion, save status tracking,
 * and visible section computation.
 *
 * This store is NOT persisted — it is ephemeral and reloaded each time
 * an agent is opened. Follows the same pattern as lifecycle-store.ts
 * and spec-generation-store.ts.
 */

import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import { create } from 'zustand';

// =============================================================================
// TYPES
// =============================================================================

/** Section identifiers for the accordion layout */
export type SectionId =
  | 'IDENTITY'
  | 'TOOLS'
  | 'GATHER'
  | 'FLOW'
  | 'RULES'
  | 'COORDINATION'
  | 'BEHAVIOR'
  | 'LIFECYCLE';

/** Save indicator states */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// ---------------------------------------------------------------------------
// Section data models (camelCase for React consumption)
// ---------------------------------------------------------------------------

export interface IdentitySectionData {
  /** @deprecated MODE removed in unified agent type. Derive from flow presence. */
  mode?: string;
  goal: string;
  persona: string;
  limitations: string[];
  /** Read-only summary only. Editing lives in the dedicated model configuration card. */
  model?: string;
  /** @deprecated Use agent model config hyperParameters instead. */
  temperature?: number;
  /** @deprecated Use agent model config hyperParameters instead. */
  maxTokens?: number;
  /** @deprecated Use agent model config hyperParameters instead. */
  enableThinking?: boolean | null;
}

export interface ToolSectionData {
  name: string;
  description: string;
  parameters: ToolParameterData[];
  returns: { type: string };
  toolType?: 'http' | 'mcp' | 'lambda' | 'sandbox' | 'searchai' | 'workflow';
  httpBinding?: {
    endpoint: string;
    method: string;
  };
  mcpBinding?: {
    server: string;
    tool: string;
  };
  sandboxBinding?: {
    runtime: string;
    codePreview: string;
    timeoutMs?: number;
    memoryMb?: number;
  };
  searchaiBinding?: {
    indexId: string;
    tenantId: string;
    kbName?: string;
  };
  workflowBinding?: {
    workflowId: string;
    triggerId: string;
    mode: string;
    timeoutMs?: number;
  };
  hints: Record<string, unknown>;
  // Confirmation config
  confirmation?: {
    require: 'always' | 'never' | 'when_side_effects';
    immutableParams?: string[];
  };
  // PII access level
  piiAccess?: 'original' | 'tools' | 'user' | 'logs' | 'llm';
}

export interface ToolParameterData {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  defaultValue?: unknown;
}

export interface GatherFieldSemanticsData {
  format?: string;
  components?: string[];
  unit?: string;
  lookup?: string;
  convert_to?: string;
  locale?: string;
  kore_entity_type?: string;
  enum_set?: string[];
}

export interface GatherFieldData {
  name: string;
  prompt: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  validation?: {
    type: string;
    rule: string;
    errorMessage: string;
  };
  extractionHints?: string[];
  infer?: boolean;
  piiType?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
  semantics?: GatherFieldSemanticsData;
  /** Allowed values for enum type fields */
  options?: string[];
  /** Reference to a project-level lookup table name (semantics.lookup in DSL) */
  lookupTable?: string;
  // --- NEW: PII sensitive fields ---
  sensitive?: boolean;
  sensitiveDisplay?: 'redact' | 'mask' | 'replace';
  maskConfig?: { showFirst: number; showLast: number; char: string };
  transient?: boolean;
  // --- NEW: Custom extraction pattern ---
  extractionPattern?: string;
  extractionGroup?: number;
}

export interface ToolInvocationData {
  tool: string;
  with?: Record<string, unknown>;
  as?: string;
}

export interface FlowStepData {
  name: string;
  respond?: string;
  call?: string;
  callSpec?: ToolInvocationData;
  then?: string;
  hasGather: boolean;
  hasBranching: boolean;

  // --- Per-step reasoning (unified agent type) ---
  /** Whether this step uses LLM reasoning (maps to REASONING: true/false in DSL) */
  reasoning: boolean;
  /** Step-level goal (overrides agent GOAL for reasoning steps) */
  goal?: string;
  /** Condition to exit the reasoning loop */
  exitWhen?: string;
  /** Max reasoning turns before forcing exit (default: 10) */
  maxTurns?: number;
  /** Tool subset available in this reasoning step (names from agent TOOLS) */
  availableTools?: string[];

  // --- Additional fields preserved from IR for lossless round-trip ---
  when?: string;
  maxAttempts?: number;
  onExhausted?: string;
  set?: Array<{ variable: string; expression: string }>;
  clear?: string[];
  onFail?: string;
  /** Raw IR step data for fields the visual editor cannot yet render */
  _rawExtras?: Record<string, unknown>;
}

export interface FlowSectionData {
  steps: FlowStepData[];
  entryPoint: string;
}

export interface RulesSectionData {
  constraints: ConstraintData[];
  guardrails: GuardrailData[];
}

export interface ConstraintData {
  condition: string;
  onFail: {
    type: string;
    message?: string;
    target?: string;
    reason?: string;
  };
}

export interface GuardrailData {
  name: string;
  description: string;
  check: string;
  action: {
    type: string;
    message?: string;
  };
  provider?: string;
  category?: string;
  threshold?: number;
  severityActions?: Record<string, string>;
  llmCheck?: string;
  kind?: string;
  priority?: number;
  streaming?: boolean;
}

export interface EscalationRouting {
  connectionId: string;
  queue?: string;
  skills?: string[];
  priority?: number;
  postAgentAction: 'return' | 'end';
  voice?: {
    transferMethod?: 'invite' | 'refer' | 'bye';
    sipHeaders?: Record<string, string>;
  };
  providerConfig?: Record<string, unknown>;
}

export interface EscalationSectionData {
  triggers: Array<{ when: string; reason: string; priority: string; tags?: string[] }>;
  contextForHuman: string[];
  onHumanComplete: Array<{ condition: string; action: string }>;
  routing?: EscalationRouting;
}

export interface CoordinationSectionData {
  delegates: DelegateData[];
  handoffs: HandoffData[];
  escalation: EscalationSectionData;
}

export interface DelegateData {
  agent: string;
  when: string;
  purpose: string;
  input?: Record<string, string>;
  returns?: Record<string, string>;
  useResult?: string;
  timeout?: string;
  onFailure?: string;
}

export interface HandoffData {
  to: string;
  when: string;
  summary: string;
  returnable: boolean;
  priority?: number;
  pass?: string[];
  history?: string | { mode: string; count?: number };
  onFailure?: string;
  onReturn?: string | { action?: string; handler?: string; map?: Record<string, string> };
}

export interface BehaviorProfileRef {
  name: string;
  priority: number;
  whenSummary: string;
  overrideCategories: string[];
}

export interface ConversationBehaviorSpeakingData {
  style?: string;
  tone?: string;
  emotion?: string;
  pace?: string;
  language_policy?: 'interaction_context' | 'agent_default' | 'fixed';
  fixed_language?: string;
  max_sentences?: number;
  one_thing_at_a_time?: boolean;
  tool_lead_in?: string;
  tool_results?: {
    style?: string;
    max_points?: number;
  };
  handoffs?: {
    internal?: string;
    human?: string;
  };
}

export interface ConversationBehaviorListeningData {
  barge_in?: string;
  on_pause?: string;
  on_overlap?: string;
  on_unclear_audio?: string;
  on_self_correction?: string;
}

export interface ConversationBehaviorInteractionData {
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

export interface ConversationBehaviorData {
  speaking?: ConversationBehaviorSpeakingData;
  listening?: ConversationBehaviorListeningData;
  interaction?: ConversationBehaviorInteractionData;
}

export interface BehaviorSectionData {
  conversationBehavior?: ConversationBehaviorData;
  profiles: BehaviorProfileRef[];
}

export interface LifecycleSectionData {
  hasOnStart: boolean;
  onStartRespond?: string;
  onStartCall?: string;
  onStartCallSpec?: ToolInvocationData;
  onStartSets?: Array<{ variable: string; value: string }>;
  hasHooks: boolean;
  hooks: string[];
  hookConfigs?: Partial<Record<LifecycleHookName, LifecycleHookData>>;
  errorHandlers: ErrorHandlerData[];
  completionConditions: CompletionConditionData[];
  memoryConfig: MemoryConfigData;
}

export type LifecycleHookName = 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn';

export interface LifecycleHookData {
  call?: string;
  callSpec?: ToolInvocationData;
  set?: Record<string, string>;
  respond?: string;
  voiceConfig?: VoiceConfigIR;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  critical?: boolean;
}

export interface ErrorHandlerData {
  type: string;
  subtypes?: string[];
  respond?: string;
  then: string;
  handoffTarget?: string;
  retry?: number;
  retryDelayMs?: number;
  retryBackoff?: 'fixed' | 'exponential' | 'linear';
  retryMaxDelayMs?: number;
  backtrackTo?: string;
  voiceConfig?: VoiceConfigIR;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
}

export interface CompletionConditionData {
  when: string;
  respond?: string;
  voiceConfig?: VoiceConfigIR;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  store?: string;
}

export interface MemoryConfigData {
  sessionVars: string[];
  persistentPaths: string[];
  rememberTriggers: number;
  recallInstructions: number;
}

/** Combined section models — all parsed section data */
export interface SectionModels {
  identity: IdentitySectionData;
  tools: ToolSectionData[];
  gather: GatherFieldData[];
  flow: FlowSectionData | null;
  rules: RulesSectionData;
  coordination: CoordinationSectionData;
  behavior: BehaviorSectionData;
  lifecycle: LifecycleSectionData;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const EMPTY_IDENTITY: IdentitySectionData = {
  mode: 'reasoning',
  goal: '',
  persona: '',
  limitations: [],
};

const EMPTY_RULES: RulesSectionData = {
  constraints: [],
  guardrails: [],
};

const EMPTY_COORDINATION: CoordinationSectionData = {
  delegates: [],
  handoffs: [],
  escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
};

const EMPTY_LIFECYCLE: LifecycleSectionData = {
  hasOnStart: false,
  hasHooks: false,
  hooks: [],
  errorHandlers: [],
  completionConditions: [],
  memoryConfig: {
    sessionVars: [],
    persistentPaths: [],
    rememberTriggers: 0,
    recallInstructions: 0,
  },
};

const EMPTY_BEHAVIOR: BehaviorSectionData = {
  conversationBehavior: undefined,
  profiles: [],
};

const EMPTY_SECTIONS: SectionModels = {
  identity: EMPTY_IDENTITY,
  tools: [],
  gather: [],
  flow: null,
  rules: EMPTY_RULES,
  coordination: EMPTY_COORDINATION,
  behavior: EMPTY_BEHAVIOR,
  lifecycle: EMPTY_LIFECYCLE,
};

const INITIAL_STATE = {
  agentId: null as string | null,
  agentName: '',
  agentDescription: '',
  rawIR: null as Record<string, unknown> | null,
  sections: EMPTY_SECTIONS,
  visibleSections: [] as SectionId[],
  expandedSection: null as SectionId | null,
  saveStatus: 'idle' as SaveStatus,
  saveError: null as string | null,
};

// =============================================================================
// PURE HELPERS
// =============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Parse an AgentIR object into UI-friendly section models.
 * Filters out system tools and converts snake_case to camelCase.
 */
export function parseIRToSections(ir: any): SectionModels {
  const identity = parseIdentity(ir);
  const tools = parseTools(ir);
  const gather = parseGather(ir);
  const flow = parseFlow(ir);
  const rules = parseRules(ir);
  const coordination = parseCoordination(ir);
  const behavior = parseBehavior(ir);
  const lifecycle = parseLifecycle(ir);

  return { identity, tools, gather, flow, rules, coordination, behavior, lifecycle };
}

function parseIdentity(ir: any): IdentitySectionData {
  return {
    mode: undefined, // MODE removed — derive from flow presence
    goal: ir.identity?.goal ?? '',
    persona: ir.identity?.persona ?? '',
    limitations: ir.identity?.limitations ?? [],
    model: ir.execution?.model,
    temperature: ir.execution?.temperature,
    maxTokens: ir.execution?.max_tokens,
    enableThinking: null, // Default: inherit from project (loaded separately from agent model config)
  };
}

function parseTools(ir: any): ToolSectionData[] {
  const rawTools = ir.tools ?? [];
  return rawTools
    .filter((t: any) => !t.system)
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: (t.parameters ?? []).map((p: any) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: p.required ?? false,
        defaultValue: p.default,
      })),
      returns: { type: t.returns?.type ?? 'unknown' },
      toolType: t.tool_type,
      httpBinding: t.http_binding
        ? { endpoint: t.http_binding.endpoint, method: t.http_binding.method }
        : undefined,
      mcpBinding: t.mcp_binding
        ? { server: t.mcp_binding.server, tool: t.mcp_binding.tool }
        : undefined,
      sandboxBinding: t.sandbox_binding
        ? {
            runtime: t.sandbox_binding.runtime,
            codePreview: (t.sandbox_binding.code_content || '').slice(0, 200),
            timeoutMs: t.sandbox_binding.timeout_ms,
            memoryMb: t.sandbox_binding.memory_mb,
          }
        : undefined,
      searchaiBinding: t.searchai_binding
        ? {
            indexId: t.searchai_binding.indexId,
            tenantId: t.searchai_binding.tenantId,
            kbName: t.searchai_binding.kbName,
          }
        : undefined,
      workflowBinding: t.workflow_binding
        ? {
            workflowId: t.workflow_binding.workflow_id,
            triggerId: t.workflow_binding.trigger_id,
            mode: t.workflow_binding.mode,
            timeoutMs: t.workflow_binding.timeout_ms,
          }
        : undefined,
      hints: t.hints ?? {},
      confirmation: t.confirmation
        ? {
            require: t.confirmation.require,
            immutableParams: t.confirmation.immutable_params,
          }
        : undefined,
      piiAccess: t.pii_access,
    }));
}

function parseGather(ir: any): GatherFieldData[] {
  const fields = ir.gather?.fields ?? [];

  return fields.map((f: any) => {
    const semantics: GatherFieldSemanticsData | undefined = f.semantics
      ? {
          format: f.semantics.format,
          components: Array.isArray(f.semantics.components)
            ? [...f.semantics.components]
            : undefined,
          unit: f.semantics.unit,
          lookup: f.semantics.lookup,
          convert_to: f.semantics.convert_to,
          locale: f.semantics.locale,
          kore_entity_type: f.semantics.kore_entity_type,
          enum_set: Array.isArray(f.semantics.enum_set) ? [...f.semantics.enum_set] : undefined,
        }
      : undefined;
    const base: GatherFieldData = {
      name: f.name,
      prompt: f.prompt ?? '',
      type: f.type ?? 'string',
      required: f.required ?? false,
      defaultValue: f.default,
      validation: f.validation
        ? {
            type: f.validation.type,
            rule: f.validation.rule,
            errorMessage: f.validation.error_message,
          }
        : undefined,
      extractionHints: f.extraction_hints,
      infer: f.infer,
      piiType: f.pii_type,
      semantics,
      options: f.enum_values,
      sensitive: f.sensitive,
      sensitiveDisplay: f.sensitive_display,
      maskConfig: f.mask_config
        ? {
            showFirst: f.mask_config.show_first,
            showLast: f.mask_config.show_last,
            char: f.mask_config.char,
          }
        : undefined,
      transient: f.transient,
      extractionPattern: f.extraction_pattern,
      extractionGroup: f.extraction_group,
    };

    // Reference to project-level lookup table
    if (semantics?.lookup) {
      base.lookupTable = semantics.lookup;
    }

    return base;
  });
}

function parseFlow(ir: any): FlowSectionData | null {
  if (!ir.flow) return null;

  const stepNames: string[] = ir.flow.steps ?? [];
  const definitions: Record<string, any> = ir.flow.definitions ?? {};

  const KNOWN_KEYS = new Set([
    'name',
    'respond',
    'call',
    'call_spec',
    'then',
    'gather',
    'on_input',
    'on_result',
    'reasoning_zone',
    'when',
    'max_attempts',
    'on_exhausted',
    'set',
    'clear',
    'on_fail',
  ]);

  const steps: FlowStepData[] = stepNames.map((name: string) => {
    const def = definitions[name] ?? {};
    const rz = def.reasoning_zone;
    const callSpec = def.call_spec
      ? {
          tool: def.call_spec.tool,
          with: def.call_spec.with,
          as: def.call_spec.as,
        }
      : undefined;

    // Collect fields the visual editor cannot render into _rawExtras
    const rawExtras: Record<string, unknown> = {};
    for (const key of Object.keys(def)) {
      if (!KNOWN_KEYS.has(key)) {
        rawExtras[key] = def[key];
      }
    }
    if (def.gather) rawExtras.gather = def.gather;
    if (def.on_input?.length) rawExtras.on_input = def.on_input;
    if (def.on_result?.length) rawExtras.on_result = def.on_result;

    return {
      name: def.name ?? name,
      respond: def.respond,
      call: callSpec?.tool ?? def.call,
      callSpec,
      then: def.then,
      hasGather: Boolean(def.gather),
      hasBranching: Boolean(def.on_input?.length || def.on_result?.length),
      reasoning: Boolean(rz),
      goal: rz?.goal,
      exitWhen: rz?.exit_when,
      maxTurns: rz?.max_turns,
      availableTools: rz?.available_tools,
      when: def.when || undefined,
      maxAttempts: def.max_attempts,
      onExhausted: def.on_exhausted || undefined,
      set: Array.isArray(def.set) ? def.set : undefined,
      clear: Array.isArray(def.clear) ? def.clear : undefined,
      onFail: def.on_fail || undefined,
      _rawExtras: Object.keys(rawExtras).length > 0 ? rawExtras : undefined,
    };
  });

  return {
    steps,
    entryPoint: ir.flow.entry_point ?? stepNames[0] ?? '',
  };
}

function parseRules(ir: any): RulesSectionData {
  const constraints = (ir.constraints?.constraints ?? []).map((c: any) => ({
    condition: c.condition,
    onFail: {
      type: c.on_fail?.type ?? 'respond',
      message: c.on_fail?.message,
      target: c.on_fail?.target,
      reason: c.on_fail?.reason,
    },
  }));

  const guardrails = (ir.constraints?.guardrails ?? []).map((g: any) => ({
    name: g.name,
    description: g.description ?? '',
    check: g.check ?? '',
    action: {
      type: g.action?.type ?? 'block',
      message: g.action?.message,
    },
    provider: g.provider,
    category: g.category,
    threshold: g.threshold,
    severityActions: g.severity_actions,
    llmCheck: g.llm_check,
    kind: g.kind,
    priority: g.priority,
    streaming: g.streaming,
  }));

  return { constraints, guardrails };
}

function parseEscalation(ir: any): EscalationSectionData {
  const esc = ir.coordination?.escalation;
  const defaultPriority = 'medium';
  if (!esc) return { triggers: [], contextForHuman: [], onHumanComplete: [] };
  return {
    triggers: (esc.triggers ?? []).map((t: any) => ({
      when: t.when ?? '',
      reason: t.reason ?? '',
      priority: t.priority ?? defaultPriority,
      tags: t.tags,
    })),
    contextForHuman: esc.context_for_human ?? [],
    onHumanComplete: (esc.on_human_complete ?? []).map((h: any) => ({
      condition: h.condition ?? '',
      action: h.action ?? '',
    })),
    routing: esc.routing
      ? {
          connectionId: esc.routing.connection ?? '',
          queue: esc.routing.queue,
          skills: esc.routing.skills,
          priority: esc.routing.priority,
          postAgentAction: (esc.routing.post_agent as 'return' | 'end') ?? 'return',
          voice: esc.routing.voice
            ? {
                transferMethod: esc.routing.voice.transfer_method,
                sipHeaders: esc.routing.voice.sip_headers,
              }
            : undefined,
          providerConfig: esc.routing.provider_config,
        }
      : undefined,
  };
}

function parseCoordination(ir: any): CoordinationSectionData {
  const delegates = (ir.coordination?.delegates ?? []).map((d: any) => ({
    agent: d.agent,
    when: d.when ?? '',
    purpose: d.purpose ?? '',
    input: d.input && Object.keys(d.input).length > 0 ? d.input : undefined,
    returns: d.returns && Object.keys(d.returns).length > 0 ? d.returns : undefined,
    useResult: d.use_result || undefined,
    timeout: d.timeout || undefined,
    onFailure: d.on_failure || undefined,
  }));

  const handoffs = (ir.coordination?.handoffs ?? []).map((h: any) => ({
    to: h.to,
    when: h.when ?? '',
    summary: h.context?.summary ?? '',
    returnable: h.return ?? false,
    priority: h.priority,
    pass: h.context?.pass?.length ? h.context.pass : undefined,
    history: h.context?.history || undefined,
    onFailure: h.on_failure || undefined,
    onReturn: h.on_return || undefined,
  }));

  const escalation = parseEscalation(ir);

  return { delegates, handoffs, escalation };
}

export function parseBehavior(ir: any): BehaviorSectionData {
  const conversationBehavior = ir.conversation_behavior
    ? {
        speaking: ir.conversation_behavior.speaking
          ? {
              style: ir.conversation_behavior.speaking.style,
              tone: ir.conversation_behavior.speaking.tone,
              emotion: ir.conversation_behavior.speaking.emotion,
              pace: ir.conversation_behavior.speaking.pace,
              language_policy: ir.conversation_behavior.speaking.language_policy,
              fixed_language: ir.conversation_behavior.speaking.fixed_language,
              max_sentences: ir.conversation_behavior.speaking.max_sentences,
              one_thing_at_a_time: ir.conversation_behavior.speaking.one_thing_at_a_time,
              tool_lead_in: ir.conversation_behavior.speaking.tool_lead_in,
              tool_results: ir.conversation_behavior.speaking.tool_results
                ? {
                    style: ir.conversation_behavior.speaking.tool_results.style,
                    max_points: ir.conversation_behavior.speaking.tool_results.max_points,
                  }
                : undefined,
              handoffs: ir.conversation_behavior.speaking.handoffs
                ? {
                    internal: ir.conversation_behavior.speaking.handoffs.internal,
                    human: ir.conversation_behavior.speaking.handoffs.human,
                  }
                : undefined,
            }
          : undefined,
        listening: ir.conversation_behavior.listening
          ? {
              barge_in: ir.conversation_behavior.listening.barge_in,
              on_pause: ir.conversation_behavior.listening.on_pause,
              on_overlap: ir.conversation_behavior.listening.on_overlap,
              on_unclear_audio: ir.conversation_behavior.listening.on_unclear_audio,
              on_self_correction: ir.conversation_behavior.listening.on_self_correction,
            }
          : undefined,
        interaction: ir.conversation_behavior.interaction
          ? {
              answer_shape: ir.conversation_behavior.interaction.answer_shape,
              detail: ir.conversation_behavior.interaction.detail,
              initiative: ir.conversation_behavior.interaction.initiative,
              grounding: ir.conversation_behavior.interaction.grounding
                ? {
                    mode: ir.conversation_behavior.interaction.grounding.mode,
                  }
                : undefined,
              clarification: ir.conversation_behavior.interaction.clarification
                ? {
                    mode: ir.conversation_behavior.interaction.clarification.mode,
                    max_questions: ir.conversation_behavior.interaction.clarification.max_questions,
                    assume_when_low_risk:
                      ir.conversation_behavior.interaction.clarification.assume_when_low_risk,
                  }
                : undefined,
              confirmation: ir.conversation_behavior.interaction.confirmation
                ? {
                    parameters: ir.conversation_behavior.interaction.confirmation.parameters,
                    actions: ir.conversation_behavior.interaction.confirmation.actions,
                  }
                : undefined,
              uncertainty: ir.conversation_behavior.interaction.uncertainty
                ? {
                    mode: ir.conversation_behavior.interaction.uncertainty.mode,
                    offer_next_step:
                      ir.conversation_behavior.interaction.uncertainty.offer_next_step,
                  }
                : undefined,
              empathy: ir.conversation_behavior.interaction.empathy,
              repair: ir.conversation_behavior.interaction.repair
                ? {
                    on_correction: ir.conversation_behavior.interaction.repair.on_correction,
                    on_confusion: ir.conversation_behavior.interaction.repair.on_confusion,
                    on_misheard: ir.conversation_behavior.interaction.repair.on_misheard,
                    max_attempts: ir.conversation_behavior.interaction.repair.max_attempts,
                  }
                : undefined,
              context: ir.conversation_behavior.interaction.context
                ? {
                    avoid_reasking: ir.conversation_behavior.interaction.context.avoid_reasking,
                    remember_recent_constraints:
                      ir.conversation_behavior.interaction.context.remember_recent_constraints,
                  }
                : undefined,
              closure: ir.conversation_behavior.interaction.closure,
            }
          : undefined,
      }
    : undefined;

  const profiles = (ir.behavior_profiles ?? []).map((p: any) => {
    const overrideCategories: string[] = [];
    if (p.instructions) overrideCategories.push('instructions');
    if (p.constraints && p.constraints.length > 0) overrideCategories.push('constraints');
    if (p.tools_hide?.length > 0 || p.tools_add?.length > 0) overrideCategories.push('tools');
    if (p.voice) overrideCategories.push('voice');
    if (p.response_rules) overrideCategories.push('response_rules');
    if (p.gather_overrides) overrideCategories.push('gather');
    if (p.flow_modifications || p.flow_replace) overrideCategories.push('flow');
    if (p.conversation_behavior) overrideCategories.push('conversation');

    return {
      name: p.name,
      priority: p.priority ?? 0,
      whenSummary: p.when ?? '',
      overrideCategories,
    };
  });

  return { conversationBehavior, profiles };
}

function parseLifecycle(ir: any): LifecycleSectionData {
  const onStart = ir.on_start;
  const hooks = ir.hooks;
  const errorHandling = ir.error_handling;
  const completion = ir.completion;
  const memory = ir.memory;

  const hookNames: string[] = [];
  if (hooks?.before_agent) hookNames.push('before_agent');
  if (hooks?.after_agent) hookNames.push('after_agent');
  if (hooks?.before_turn) hookNames.push('before_turn');
  if (hooks?.after_turn) hookNames.push('after_turn');

  const hookConfigs = (
    ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as LifecycleHookName[]
  ).reduce<Partial<Record<LifecycleHookName, LifecycleHookData>>>((acc, hookName) => {
    const hook = hooks?.[hookName];
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
      return acc;
    }

    acc[hookName] = {
      call: hook.call,
      callSpec: hook.call_spec
        ? {
            tool: hook.call_spec.tool,
            with: hook.call_spec.with,
            as: hook.call_spec.as,
          }
        : undefined,
      set: hook.set,
      respond: hook.respond,
      voiceConfig: hook.voice_config,
      richContent: hook.rich_content,
      actions: hook.actions,
      critical: hook.critical,
    };

    return acc;
  }, {});

  const mapErrorHandler = (handler: any): ErrorHandlerData => ({
    type: handler.type,
    subtypes: handler.subtypes,
    respond: handler.respond,
    then: handler.then ?? 'continue',
    handoffTarget: handler.handoff_target,
    retry: handler.retry,
    retryDelayMs: handler.retry_delay_ms,
    retryBackoff: handler.retry_backoff,
    retryMaxDelayMs: handler.retry_max_delay_ms,
    backtrackTo: handler.backtrack_to,
    voiceConfig: handler.voice_config,
    richContent: handler.rich_content,
    actions: handler.actions,
  });

  const errorHandlers: ErrorHandlerData[] = [
    ...(errorHandling?.handlers ?? []).map(mapErrorHandler),
    ...(errorHandling?.default_handler ? [mapErrorHandler(errorHandling.default_handler)] : []),
  ];

  const completionConditions: CompletionConditionData[] = (completion?.conditions ?? []).map(
    (c: any) => ({
      when: c.when,
      respond: c.respond,
      voiceConfig: c.voice_config,
      richContent: c.rich_content,
      actions: c.actions,
      store: c.store,
    }),
  );

  const memoryConfig: MemoryConfigData = {
    sessionVars: (memory?.session ?? []).map((s: any) => s.name),
    persistentPaths: (memory?.persistent ?? []).map((p: any) => p.path),
    rememberTriggers: (memory?.remember ?? []).length,
    recallInstructions: (memory?.recall ?? []).length,
  };

  return {
    hasOnStart: Boolean(onStart),
    onStartRespond: onStart?.respond,
    onStartCall: onStart?.call_spec?.tool ?? onStart?.call,
    onStartCallSpec: onStart?.call_spec
      ? {
          tool: onStart.call_spec.tool,
          with: onStart.call_spec.with,
          as: onStart.call_spec.as,
        }
      : undefined,
    onStartSets: onStart?.set
      ? Object.entries(onStart.set).map(([variable, value]) => ({
          variable,
          value: String(value),
        }))
      : undefined,
    hasHooks: hookNames.length > 0,
    hooks: hookNames,
    hookConfigs: Object.keys(hookConfigs).length > 0 ? hookConfigs : undefined,
    errorHandlers,
    completionConditions,
    memoryConfig,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Determine which sections should be visible based on parsed data.
 * All sections are always visible so users can add content to empty ones.
 * FLOW is shown when the agent has flow definitions.
 */
export function computeVisibleSections(sections: SectionModels): SectionId[] {
  const visible: SectionId[] = [
    'IDENTITY',
    'TOOLS',
    'GATHER',
    'RULES',
    'COORDINATION',
    'BEHAVIOR',
    'LIFECYCLE',
  ];

  // FLOW is shown when the agent has flow definitions
  if (sections.flow) {
    visible.splice(3, 0, 'FLOW');
  }

  return visible;
}

// =============================================================================
// STORE
// =============================================================================

interface AgentDetailState {
  // Agent metadata
  agentId: string | null;
  agentName: string;
  agentDescription: string;

  // Raw IR for reference
  rawIR: Record<string, unknown> | null;

  // Parsed section data
  sections: SectionModels;

  // Which sections are visible (non-empty or always-visible)
  visibleSections: SectionId[];

  // Which section is currently expanded (accordion)
  expandedSection: SectionId | null;

  // Save state
  saveStatus: SaveStatus;
  saveError: string | null;

  // Actions
  loadFromIR: (ir: any, agentId: string) => void;
  updateSection: <K extends keyof SectionModels>(key: K, data: SectionModels[K]) => void;
  expandSection: (section: SectionId) => void;
  collapseSection: () => void;
  setSaveStatus: (status: SaveStatus, error?: string) => void;
  reset: () => void;
}

export const useAgentDetailStore = create<AgentDetailState>((set) => ({
  ...INITIAL_STATE,

  loadFromIR: (ir, agentId) => {
    const sections = parseIRToSections(ir);
    const visibleSections = computeVisibleSections(sections);

    set((state) => ({
      agentId,
      agentName: ir.metadata?.name ?? '',
      agentDescription: ir.identity?.goal ?? '',
      rawIR: ir,
      sections,
      visibleSections,
      // Preserve expanded section when reloading the same agent (auto-save reload),
      // reset only when switching to a different agent
      expandedSection: state.agentId === agentId ? state.expandedSection : null,
      saveStatus: 'idle',
      saveError: null,
    }));
  },

  updateSection: (key, data) =>
    set((state) => {
      const sections = { ...state.sections, [key]: data };
      return { sections, visibleSections: computeVisibleSections(sections) };
    }),

  expandSection: (section) => set({ expandedSection: section }),

  collapseSection: () => set({ expandedSection: null }),

  setSaveStatus: (status, error) =>
    set({
      saveStatus: status,
      saveError: error ?? null,
    }),

  reset: () => set({ ...INITIAL_STATE, sections: { ...EMPTY_SECTIONS } }),
}));

// =============================================================================
// SELECTORS
// =============================================================================

export const selectIsExpanded = (sectionId: SectionId) => (state: AgentDetailState) =>
  state.expandedSection === sectionId;

export const selectSectionData =
  <K extends keyof SectionModels>(key: K) =>
  (state: AgentDetailState): SectionModels[K] =>
    state.sections[key];
