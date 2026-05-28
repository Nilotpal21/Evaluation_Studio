/**
 * Agent Editor Types
 *
 * All section IDs, menu group definitions, and the section data map
 * for the unified agent editor. Reuses existing types from
 * agent-detail-store.ts where possible.
 */

import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Reuse existing types from the agent detail store
// ---------------------------------------------------------------------------

import type {
  IdentitySectionData,
  ToolSectionData,
  GatherFieldData,
  FlowSectionData,
  ToolInvocationData,
  BehaviorSectionData,
  ConstraintData,
  GuardrailData,
  HandoffData,
  DelegateData,
  ErrorHandlerData,
  CompletionConditionData,
  EscalationRouting,
} from '../../store/agent-detail-store';

export type {
  IdentitySectionData,
  ToolSectionData,
  GatherFieldData,
  FlowSectionData,
  ToolInvocationData,
  BehaviorSectionData,
  ConstraintData,
  GuardrailData,
  HandoffData,
  DelegateData,
  ErrorHandlerData,
  CompletionConditionData,
  EscalationRouting,
};

// =============================================================================
// SECTION IDS
// =============================================================================

/** All navigable sections in the unified agent editor */
export type EditorSection =
  | 'identity'
  | 'execution'
  | 'tools'
  | 'gather'
  | 'memory'
  | 'flow'
  | 'constraints'
  | 'guardrails'
  | 'behavior'
  | 'handoffs'
  | 'delegates'
  | 'escalation'
  | 'onStart'
  | 'errorHandling'
  | 'completion'
  | 'templates'
  | 'definition';

// =============================================================================
// NEW SECTION DATA MODELS
// =============================================================================

/** Execution / LLM configuration for the agent */
export interface ExecutionSectionData {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  enableThinking?: boolean | null;
  thinkingBudget?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  toolTimeout?: number;
  llmTimeout?: number;
  sessionIdleTimeout?: number;
  maxReasoningIterations?: number;
  maxFlowIterations?: number;
  voiceLatencyTarget?: number;
  fallbackModel?: string;
  concurrency?: 'serial' | 'preemptive' | 'parallel';
  operationModels?: Record<string, string>;
}

/** Memory configuration — session vars, persistence, remember/recall */
export interface MemorySectionData {
  sessionVars: Array<{
    name: string;
    type?: string;
    description?: string;
    initialValue?: unknown;
  }>;
  persistentPaths: string[];
  reads?: string[];
  writes?: string[];
  rememberTriggers: Array<{
    when: string;
    store: { value: string; target: string };
    ttl?: string;
  }>;
  recallInstructions: Array<{ event: string; instruction: string }>;
}

/** Escalation configuration — when and how to escalate to a human */
export interface EscalationSectionData {
  triggers: Array<{
    when: string;
    reason: string;
    priority: string;
    tags?: string[];
  }>;
  contextForHuman: string[];
  onHumanComplete: Array<{ condition: string; action: string }>;
  routing?: EscalationRouting;
}

/** on_start lifecycle hook — what happens when the agent starts */
export interface OnStartSectionData {
  respond?: string;
  calls: Array<{ tool: string; args?: string }>;
  sets: Array<{ variable: string; value: string }>;
  /** Configured hooks (e.g., on_handoff, on_complete). Read-only display. */
  hooks: string[];
  /** Whether ON_START is enabled */
  hasOnStart: boolean;
  /** Tool call on start */
  onStartCall?: string;
  /** Canonical tool invocation preserved for DSL round-trip support */
  onStartCallSpec?: ToolInvocationData;
}

/** Template definition with multiple output formats */
export interface TemplateSectionData {
  name: string;
  formats: {
    default?: string;
    markdown?: string;
    html?: string;
    voiceInstructions?: string;
  };
}

// =============================================================================
// SECTION DATA MAP
// =============================================================================

/** Maps each EditorSection to its typed data */
export interface SectionDataMap {
  identity: IdentitySectionData;
  execution: ExecutionSectionData;
  tools: ToolSectionData[];
  gather: GatherFieldData[];
  memory: MemorySectionData;
  flow: FlowSectionData | null;
  constraints: ConstraintData[];
  guardrails: GuardrailData[];
  behavior: BehaviorSectionData;
  handoffs: HandoffData[];
  delegates: DelegateData[];
  escalation: EscalationSectionData;
  onStart: OnStartSectionData;
  errorHandling: ErrorHandlerData[];
  completion: CompletionConditionData[];
  templates: TemplateSectionData[];
  definition: string;
}

// =============================================================================
// MENU TYPES
// =============================================================================

/** A group of menu items in the editor sidebar */
export interface MenuGroup {
  id: string;
  label: string;
  items: MenuItemDef[];
}

/** Definition of a single menu item in the editor sidebar */
export interface MenuItemDef {
  section: EditorSection;
  label: string;
  Icon: LucideIcon;
  /** Returns a count badge value (e.g. number of tools) */
  countFn?: (data: SectionDataMap) => number;
  /** Whether this section should be visible for the current agent */
  visibilityFn?: (data: SectionDataMap) => boolean;
}

// =============================================================================
// EDITOR PROPS
// =============================================================================

/** Generic props passed to each section editor component */
export interface SectionEditorProps<S extends EditorSection> {
  data: SectionDataMap[S];
  onChange: (data: SectionDataMap[S]) => void;
  readOnly?: boolean;
  onArchClick?: () => void;
}
