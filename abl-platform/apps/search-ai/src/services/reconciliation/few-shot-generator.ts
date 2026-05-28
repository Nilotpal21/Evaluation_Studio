/**
 * Few-Shot Generator
 *
 * Generates extraction patterns and aliases for a promoted attribute.
 * Uses cluster member names as aliases and creates regex patterns
 * from snake_case, space-separated, kebab-case, and concatenated variants.
 */

/**
 * Deduplicate an array of strings preserving order.
 */
function deduplicate(arr: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const result: string[] = [];
  for (const item of arr) {
    if (!seen[item]) {
      seen[item] = true;
      result.push(item);
    }
  }
  return result;
}

/**
 * Generate extraction patterns and aliases for a promoted attribute.
 */
export function generateFewShotExamples(
  canonicalName: string,
  clusterMembers: Array<{ name: string; definition: string }>,
): { aliases: string[]; extractionPatterns: string[] } {
  // Aliases = all cluster member names except the canonical
  const aliases = clusterMembers.map((m) => m.name).filter((name) => name !== canonicalName);

  // Generate regex patterns from canonical + aliases
  // Convert snake_case to human-readable variants
  // Cap at 20 names to prevent unbounded regex alternation (200+ alternations degrade perf)
  const MAX_PATTERN_MEMBERS = 20;
  const allNames = [canonicalName, ...aliases].slice(0, MAX_PATTERN_MEMBERS);
  const humanReadable = allNames.flatMap((name) => {
    const words = name.split('_');
    return [
      name, // snake_case: contactless_payment
      words.join(' '), // spaces: contactless payment
      words.join('-'), // kebab: contactless-payment
      words.join(''), // concatenated: contactlesspayment
    ];
  });

  // Deduplicate and escape for regex
  const unique = deduplicate(humanReadable);
  const escaped = unique.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // Create a single pattern matching any variant (case-insensitive)
  const pattern = `\\b(${escaped.join('|')})\\b`;
  const extractionPatterns = [pattern];

  return { aliases, extractionPatterns };
}
