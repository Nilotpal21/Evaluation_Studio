/**
 * Action precedence map — higher number = higher precedence.
 *
 * Terminal actions (escalate > block > reask) take priority over
 * non-terminal content modifications (redact > fix > filter > warn).
 *
 * When multiple terminal violations exist, the one with the highest
 * precedence becomes the primaryViolation that determines the
 * pipeline's response behaviour.
 *
 * Extracted to a shared constants file to avoid circular imports
 * between types.ts and result-aggregator.ts.
 */
export const ACTION_PRECEDENCE: Record<string, number> = {
  warn: 0,
  filter: 1,
  fix: 2,
  redact: 3,
  reask: 4,
  block: 5,
  escalate: 6,
};
