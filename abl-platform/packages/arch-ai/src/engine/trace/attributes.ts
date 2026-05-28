/**
 * Attribute key constants for arch-ai trace records.
 *
 * Inlined from arch-observability-contracts. Two namespaces:
 * 1. OTel GenAI semantic conventions (gen_ai.*) — for interoperability.
 * 2. arch.* namespace — Arch-specific attributes.
 */

// ─── OTel GenAI Semantic Convention Keys ──────────────────────────────

export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name' as const;
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name' as const;
export const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id' as const;
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model' as const;
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model' as const;
export const GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature' as const;
export const GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens' as const;
export const GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p' as const;
export const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons' as const;
export const GEN_AI_RESPONSE_ID = 'gen_ai.response.id' as const;
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens' as const;
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens' as const;
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens' as const;
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  'gen_ai.usage.cache_creation.input_tokens' as const;
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name' as const;
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id' as const;
export const GEN_AI_TOOL_TYPE = 'gen_ai.tool.type' as const;
export const GEN_AI_TOOL_CALL_ARGUMENTS = 'gen_ai.tool.call.arguments' as const;
export const GEN_AI_TOOL_CALL_RESULT = 'gen_ai.tool.call.result' as const;
export const ERROR_TYPE = 'error.type' as const;

// ─── Arch-Specific Attribute Keys (arch.* namespace) ─────────────────

export const ARCH_SESSION_MODE = 'arch.session.mode' as const;
export const ARCH_PHASE = 'arch.phase' as const;
export const ARCH_PHASE_FROM = 'arch.phase.from' as const;
export const ARCH_PHASE_TO = 'arch.phase.to' as const;
export const ARCH_PHASE_REASON = 'arch.phase.reason' as const;
export const ARCH_SPECIALIST = 'arch.specialist' as const;
export const ARCH_AGENT_FROM = 'arch.agent.from' as const;
export const ARCH_AGENT_TO = 'arch.agent.to' as const;
export const ARCH_AGENT_REASON = 'arch.agent.reason' as const;
export const ARCH_TOOL_INTERACTIVE = 'arch.tool.interactive' as const;
export const ARCH_TOOL_ARGUMENTS = 'arch.tool.arguments' as const;
export const ARCH_TOOL_RESULT = 'arch.tool.result' as const;
export const ARCH_GATE_NAME = 'arch.gate.name' as const;
export const ARCH_GATE_OUTCOME = 'arch.gate.outcome' as const;
export const ARCH_GATE_SCORE = 'arch.gate.score' as const;
export const ARCH_TURN_END_REASON = 'arch.turn.end_reason' as const;
export const COST_USD = 'cost.usd' as const;
export const ARCH_SPECIALIST_CHAIN = 'arch.specialist_chain' as const;
