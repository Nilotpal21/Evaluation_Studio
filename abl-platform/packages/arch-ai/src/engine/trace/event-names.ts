/**
 * Span-event name constants for arch-ai trace records.
 *
 * Inlined from arch-observability-contracts. Mid-span annotations emitted
 * via span_event records.
 */

export const EVENT_RETRY = 'retry' as const;
export const EVENT_WARNING = 'warning' as const;
export const EVENT_PAUSE = 'pause' as const;
export const EVENT_RESUME = 'resume' as const;
export const EVENT_CANCEL_REQUESTED = 'cancel_requested' as const;
export const EVENT_TIMEOUT = 'timeout' as const;
export const EVENT_BUDGET_EXHAUSTED = 'budget_exhausted' as const;
export const EVENT_SELF_CORRECTION = 'self_correction' as const;
export const EVENT_ROUTING_DECISION = 'routing_decision' as const;
