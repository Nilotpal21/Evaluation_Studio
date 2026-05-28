/**
 * Extract Signature from DSL
 *
 * Strips implementation properties from a full tool DSL string, returning
 * only the signature portion suitable for embedding in agent DSL TOOLS sections.
 *
 * Implementation properties (endpoint, method, auth, auth_config, headers,
 * timeout, retry, retry_delay, rate_limit, circuit_breaker, code, runtime,
 * memory_mb, server, server_tool) are removed. The signature line, description,
 * and type declaration are preserved.
 *
 * Example:
 *   Input:
 *     charge_card(amount: number) -> {txnId: string}
 *       description: "Charge a card"
 *       type: http
 *       endpoint: "https://..."
 *       method: POST
 *
 *   Output:
 *     charge_card(amount: number) -> {txnId: string}
 *       description: "Charge a card"
 *       type: http
 */

/** Implementation-only properties that must be stripped from agent DSL context */
const IMPLEMENTATION_PROPERTIES = new Set([
  'endpoint',
  'method',
  'auth',
  'auth_config',
  'headers',
  'timeout',
  'retry',
  'retry_delay',
  'rate_limit',
  'circuit_breaker',
  'code',
  'runtime',
  'memory_mb',
  'server',
  'server_tool',
]);

/**
 * Extract the signature-only portion from a full tool DSL string.
 *
 * Preserves: signature line, `description`, `type`.
 * Removes: all implementation properties and their nested content.
 *
 * @param dslContent - Full tool DSL (signature + implementation)
 * @returns Signature-only DSL suitable for agent TOOLS section
 */
export function extractSignatureFromDsl(dslContent: string): string {
  const lines = dslContent.split('\n');
  const result: string[] = [];
  let skipBlock = false;
  let skipIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Always include the signature line (first non-empty, non-indented line)
    if (result.length === 0 && trimmed.length > 0 && !line.startsWith(' ')) {
      result.push(line);
      continue;
    }

    // Skip empty lines at the start
    if (result.length === 0 && trimmed.length === 0) continue;

    // Determine the property name from "  property_name:" or "  property_name: value"
    const propMatch = trimmed.match(/^([a-z_]+)\s*:/);
    const propName = propMatch?.[1];

    // If we're currently skipping a nested block, check indentation
    if (skipBlock) {
      const currentIndent = line.length - line.trimStart().length;
      if (currentIndent > skipIndent || trimmed.length === 0) {
        continue; // Still inside the nested block
      }
      skipBlock = false;
    }

    if (propName && IMPLEMENTATION_PROPERTIES.has(propName)) {
      // Check if this property starts a nested block (line ends with ":" or has pipe "|")
      if (trimmed.endsWith(':') || trimmed.endsWith('|')) {
        skipBlock = true;
        skipIndent = line.length - line.trimStart().length;
      }
      continue; // Skip this implementation property
    }

    result.push(line);
  }

  // Remove trailing empty lines
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }

  return result.join('\n');
}
