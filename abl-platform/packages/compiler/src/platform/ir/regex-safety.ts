/**
 * Regex Safety Validation
 *
 * Detects common ReDoS (Regular Expression Denial of Service) patterns
 * at compile time. User-defined regex patterns in ENTITIES and NLU.entities
 * are validated before they reach the runtime to prevent catastrophic
 * backtracking attacks.
 *
 * Detected patterns:
 * - Nested quantifiers: (a+)+, (a*)*,  (a+)*, etc.
 * - Overlapping alternations with quantifiers: (a|a)+
 * - Repeated groups with quantifiers: (.+.+)+
 *
 * This is a heuristic check, not a formal proof. It catches the most
 * common ReDoS patterns without requiring external dependencies.
 */

/**
 * Maximum input length allowed for runtime pattern matching.
 * Limits the blast radius even if a pattern slips through compile-time checks.
 */
export const MAX_PATTERN_INPUT_LENGTH = 1000;

/**
 * Maximum length for user-authored regex patterns accepted in runtime-facing
 * extraction paths.
 */
export const MAX_USER_REGEX_PATTERN_LENGTH = 500;

/**
 * Heuristic patterns that indicate potential catastrophic backtracking.
 *
 * These detect nested quantifiers — the primary cause of ReDoS:
 *   (a+)+    → quantified group containing a quantifier
 *   (a*)*    → same with star
 *   (.+.+)+  → group with multiple quantified terms
 */
const NESTED_QUANTIFIER_PATTERNS = [
  // Group with internal quantifier, followed by external quantifier: (x+)+ (x*)* (x+)* (x*)+
  /\([^)]*[+*]\)[+*{]/,
  // Group with internal quantifier followed by ? (possessive-like but still dangerous)
  /\([^)]*[+*]\)\?/,
  // Alternation where branches overlap, inside a quantified group: (a|a)+ (\w|\d)+
  /\(([^|)]+)\|(\1)\)[+*]/,
];

export interface RegexSafetyResult {
  safe: boolean;
  error?: string;
}

/**
 * Validate a regex pattern string for safety at compile time.
 *
 * Checks:
 * 1. The pattern is valid RegExp syntax
 * 2. The pattern does not contain known ReDoS-vulnerable constructs
 *
 * @param pattern - The regex pattern string from ENTITIES or NLU.entities
 * @param entityName - The entity name (for error messages)
 * @returns Safety check result
 */
export function validateRegexSafety(pattern: string, entityName: string): RegexSafetyResult {
  // 1. Validate syntax
  try {
    new RegExp(pattern);
  } catch (err) {
    return {
      safe: false,
      error: `Entity "${entityName}" has invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Check for nested quantifiers (primary ReDoS vector)
  for (const dangerousPattern of NESTED_QUANTIFIER_PATTERNS) {
    if (dangerousPattern.test(pattern)) {
      return {
        safe: false,
        error:
          `Entity "${entityName}" has a potentially unsafe regex pattern "${pattern}". ` +
          `Nested quantifiers (e.g., (a+)+) can cause catastrophic backtracking. ` +
          `Simplify the pattern to avoid nested repetition.`,
      };
    }
  }

  return { safe: true };
}
