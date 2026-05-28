/**
 * arch-ai trace port — types and constants for engine-internal trace emission.
 *
 * Inlined from arch-observability-contracts to keep arch-ai self-contained.
 * External observability providers consume these via TraceEmitter and
 * TraceLogRecord, and may re-export the constant set for UI conventions.
 */

export type { SpanStatus, TraceStatus, SpanError } from './errors.js';

export type {
  TraceLogEnvelope,
  TraceLogRecord,
  TraceLogRecordKind,
  TraceStartedRecord,
  SpanStartedRecord,
  SpanEventRecord,
  SpanEndedRecord,
  TraceEndedRecord,
} from './trace-log-record.js';

export type { TraceEmitter } from './trace-emitter.js';

export {
  DEFAULT_MAX_ATTRIBUTE_BYTES,
  truncateAttributes,
  type TruncationOptions,
} from './truncation.js';

export {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_TYPE,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  ERROR_TYPE,
  ARCH_SESSION_MODE,
  ARCH_PHASE,
  ARCH_PHASE_FROM,
  ARCH_PHASE_TO,
  ARCH_PHASE_REASON,
  ARCH_SPECIALIST,
  ARCH_AGENT_FROM,
  ARCH_AGENT_TO,
  ARCH_AGENT_REASON,
  ARCH_TOOL_INTERACTIVE,
  ARCH_TOOL_ARGUMENTS,
  ARCH_TOOL_RESULT,
  ARCH_GATE_NAME,
  ARCH_GATE_OUTCOME,
  ARCH_GATE_SCORE,
  ARCH_TURN_END_REASON,
  COST_USD,
  ARCH_SPECIALIST_CHAIN,
} from './attributes.js';

export {
  SPAN_KIND_TURN,
  SPAN_KIND_LLM_CALL,
  SPAN_KIND_TOOL_CALL,
  SPAN_KIND_PHASE_TRANSITION,
  SPAN_KIND_AGENT_HANDOFF,
  SPAN_KIND_GATE_CHECK,
} from './span-kinds.js';

export {
  EVENT_RETRY,
  EVENT_WARNING,
  EVENT_PAUSE,
  EVENT_RESUME,
  EVENT_CANCEL_REQUESTED,
  EVENT_TIMEOUT,
  EVENT_BUDGET_EXHAUSTED,
  EVENT_SELF_CORRECTION,
  EVENT_ROUTING_DECISION,
} from './event-names.js';
