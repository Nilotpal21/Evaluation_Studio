/**
 * Scope Classifier — keyword/pattern analysis for BUILD phase mutations.
 * Contract: S1-F01 req 14
 *
 * Runs as a coordinator function (not a tool call). Determines whether
 * a user request is a SMALL mutation (stays in BUILD) or LARGE mutation
 * (backtracks to BLUEPRINT).
 *
 * Contract-specified examples (S1-F01 req 14):
 *   LARGE: 'add agent', 'new agent', 'topology change'
 *   SMALL: 'change persona', 'add tool', 'modify gather'
 *
 * Additional patterns below (marked [extrapolated]) are reasonable
 * extensions of the contract examples. They follow the same principle:
 * topology-altering changes are LARGE, single-agent-internal changes are SMALL.
 */

export type MutationScope = 'SMALL' | 'LARGE';

const LARGE_MUTATION_PATTERNS = [
  // Contract-specified:
  /\badd\s+(a\s+)?(new\s+)?agent\b/i,
  /\bnew\s+agent\b/i,
  /\btopology\s+change\b/i,
  /\bchange\s+(the\s+)?topology\b/i,
  // Extrapolated (topology-altering):
  /\bremove\s+agent\b/i,
  /\bdelete\s+agent\b/i,
  /\bredesign\b/i,
  /\brearchitect\b/i,
  /\bsplit\s+(the\s+)?agent\b/i,
  /\bmerge\s+(the\s+)?agents?\b/i,
  /\bnew\s+handoff\b/i,
  /\badd\s+handoff\b/i,
  /\bremove\s+handoff\b/i,
];

const SMALL_MUTATION_PATTERNS = [
  // Contract-specified:
  /\bchange\s+(the\s+)?persona\b/i,
  /\badd\s+(a\s+)?tool\b/i,
  /\bmodify\s+(the\s+)?gather\b/i,
  // Extrapolated (single-agent-internal):
  /\bremove\s+(a\s+)?tool\b/i,
  /\badd\s+(a\s+)?gather\b/i,
  /\bchange\s+(the\s+)?constraint\b/i,
  /\badd\s+(a\s+)?constraint\b/i,
  /\bupdate\s+(the\s+)?guardrail\b/i,
  /\badd\s+(a\s+)?guardrail\b/i,
  /\bchange\s+(the\s+)?model\b/i,
  /\brename\b/i,
  /\bfix\b/i,
  /\btweak\b/i,
];

/**
 * Classify a user message as SMALL or LARGE mutation.
 * LARGE mutations trigger BUILD->BLUEPRINT backtracking.
 * SMALL mutations stay in BUILD phase.
 *
 * When neither pattern matches, defaults to SMALL (conservative —
 * stays in current phase rather than forcing a backtrack).
 */
export function classifyMutationScope(userMessage: string): MutationScope {
  for (const pattern of LARGE_MUTATION_PATTERNS) {
    if (pattern.test(userMessage)) {
      return 'LARGE';
    }
  }

  for (const pattern of SMALL_MUTATION_PATTERNS) {
    if (pattern.test(userMessage)) {
      return 'SMALL';
    }
  }

  // Additional LARGE patterns — topology-altering intent phrased differently
  const additionalLargePatterns = [
    /\bcombine\b.*\bagents?\b/i,
    /\bbreak\b.*\binto\b/i,
    /\brethink\b/i,
    /\brestructur/i,
    /\brefactor\b.*\btopology\b/i,
    /\bnew\s+agent/i,
    /\bremove\s+agent/i,
    /\bdelete\s+agent/i,
  ];
  if (additionalLargePatterns.some((p) => p.test(userMessage))) {
    return 'LARGE';
  }

  return 'SMALL';
}
