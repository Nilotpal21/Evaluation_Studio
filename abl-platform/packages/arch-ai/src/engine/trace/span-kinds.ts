/**
 * Span kind string constants for arch-ai trace records.
 *
 * Inlined from arch-observability-contracts. spanKind is an open taxonomy;
 * these constants define the arch-ai-emitted set.
 */

export const SPAN_KIND_TURN = 'turn' as const;
export const SPAN_KIND_LLM_CALL = 'llm_call' as const;
export const SPAN_KIND_TOOL_CALL = 'tool_call' as const;
export const SPAN_KIND_PHASE_TRANSITION = 'phase_transition' as const;
export const SPAN_KIND_AGENT_HANDOFF = 'agent_handoff' as const;
export const SPAN_KIND_GATE_CHECK = 'gate_check' as const;
