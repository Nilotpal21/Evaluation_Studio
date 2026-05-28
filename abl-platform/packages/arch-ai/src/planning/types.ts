/**
 * Agent Architecture Plan — pre-computed structural specification for a single agent.
 *
 * Computed deterministically from topology (agents + edges + entryPoint).
 * Consumed by the prompt builder to tell the LLM exactly what structures
 * to produce — replacing prose rules that the LLM may or may not follow.
 */

/**
 * Topology input for the planner — matches the historical TopologyOutput
 * shape used by the legacy blueprint flow.
 */
export interface PlannerTopologyInput {
  agents: ReadonlyArray<{
    name: string;
    role: string;
    executionMode: 'reasoning' | 'scripted' | 'hybrid';
    description?: string;
    tools?: string[];
    gatherFields?: string[];
  }>;
  edges: ReadonlyArray<{
    from: string;
    to: string;
    type: 'delegate' | 'escalate' | 'transfer';
    experienceMode?:
      | 'shared_voice_handoff'
      | 'visible_handoff'
      | 'silent_delegate'
      | 'human_escalation';
    condition?: string;
    expectReturn?: boolean;
    allowCycle?: boolean;
  }>;
  entryPoint: string;
}

/** Archetype — inferred from topology position and edge patterns */
export type AgentArchetype = 'supervisor' | 'specialist' | 'pipeline_stage' | 'worker';

/** Runtime-aligned history hint for a single handoff target. */
export interface HandoffHistoryHint {
  /**
   * Prefer the runtime default so the executor can choose summary_only vs
   * bounded raw history based on target capabilities.
   */
  suggestedHistory: 'auto';
  /** Whether runtime auto can resolve to summary_only for this target. */
  autoSummaryEligible: boolean;
  /** Whether the planner recommends authoring CONTEXT.summary for this target. */
  summaryRecommended: boolean;
  /** Source-side fields worth mentioning in the handoff summary when known. */
  summaryFocusFields: string[];
  /** Concrete summary-writing seed grounded in topology context. */
  summaryTemplateSeed: string;
  /** Human-readable explanation derived from the target execution mode. */
  reason: string;
}

/** Runtime-aligned return-contract hint for a single handoff target. */
export interface HandoffReturnContractHint {
  /**
   * Child gathered fields that RETURN: true already merges back to the parent
   * by same name when no ON_RETURN.map is configured.
   */
  defaultMergedFields: string[];
  /**
   * Guidance for when ON_RETURN.map is still needed despite the default merge.
   */
  reason: string;
}

/** A single handoff target with its structural contract */
export interface HandoffTargetPlan {
  to: string;
  edgeType: 'delegate' | 'escalate' | 'transfer';
  experienceMode?:
    | 'shared_voice_handoff'
    | 'visible_handoff'
    | 'silent_delegate'
    | 'human_escalation';
  returnExpected: boolean;
  condition: string | undefined;
  /** Topology-derived child field seeds that are safe ON_RETURN.map candidates. */
  returnFieldSeeds?: string[];
  /** Runtime-aligned history hint for authored CONTEXT.summary / history blocks. */
  historyHint?: HandoffHistoryHint;
  /** Runtime-aligned return contract hint for default merge vs ON_RETURN.map. */
  returnContractHint?: HandoffReturnContractHint;
}

/** Structural requirement with a reason explaining WHY it's required */
export interface StructuralRequirement {
  required: boolean;
  reason: string;
}

/** GATHER plan — whether the agent needs GATHER and suggested field seeds */
export interface GatherPlan extends StructuralRequirement {
  suggestedFields: string[];
}

/** FLOW plan — whether FLOW is recommended for this agent's execution mode */
export interface FlowPlan {
  recommended: boolean;
  reason: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
}

/** Complexity decision — deterministic recommendation before generation. */
export interface AgentComplexityPlan {
  selectedExecutionMode: 'reasoning' | 'scripted' | 'hybrid';
  level: 'simple' | 'structured' | 'complex';
  reason: string;
  signals: string[];
}

/** HANDOFF routing plan — pre-computed from topology edges */
export interface HandoffPlan {
  targets: HandoffTargetPlan[];
  needsCatchAll: boolean;
  catchAllTarget: string | undefined;
}

/** A blocked pattern detected in topology analysis */
export interface BlockedPattern {
  pattern: 'self_handoff' | 'circular_handoff' | 'orphan_agent' | 'missing_return_path';
  agentName: string;
  detail: string;
}

/** The full architecture plan for one agent */
export interface AgentArchitecturePlan {
  agentName: string;
  archetype: AgentArchetype;
  /** DSL keyword: SUPERVISOR or AGENT */
  keyword: 'SUPERVISOR' | 'AGENT';
  isEntry: boolean;

  gather: GatherPlan;
  complete: StructuralRequirement;
  complexity: AgentComplexityPlan;
  flow: FlowPlan;
  handoffs: HandoffPlan;

  /** Fields this agent is allowed to pass via CONTEXT.pass (from its own declared sources) */
  allowedPassFields: string[];

  /** Blocked patterns detected for this agent */
  blocked: BlockedPattern[];

  /** Compact topology view: only this agent's direct neighbors */
  localTopology: {
    agents: Array<{ name: string; role: string; executionMode: string }>;
    edges: Array<{
      from: string;
      to: string;
      type: string;
      experienceMode?:
        | 'shared_voice_handoff'
        | 'visible_handoff'
        | 'silent_delegate'
        | 'human_escalation';
      returnExpected: boolean;
    }>;
  };
}

/** Output of the planner — one plan per topology agent + global diagnostics */
export interface ArchitecturePlanResult {
  plans: Map<string, AgentArchitecturePlan>;
  /** Topology-level blocked patterns (cycles, orphans) */
  globalBlocked: BlockedPattern[];
}
