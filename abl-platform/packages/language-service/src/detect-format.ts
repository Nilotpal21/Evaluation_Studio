/**
 * Detect whether ABL source is YAML or legacy format.
 *
 * YAML format uses lowercase keys: `agent:`, `mode:`, `tools:`
 * Legacy format uses uppercase section headers: `AGENT:`, `MODE:`, `TOOLS:`
 *
 * Heuristic: check if the first non-empty, non-comment line starts with
 * a lowercase key followed by a colon (YAML) or an uppercase key (legacy).
 */
export function detectFormat(source: string): 'yaml' | 'legacy' {
  if (typeof source !== 'string') return 'legacy';
  const lines = source.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // YAML format: lowercase key followed by colon
    if (/^[a-z][a-z_]*\s*:/.test(trimmed)) {
      return 'yaml';
    }

    // Legacy format: uppercase key followed by colon or space
    if (/^[A-Z][A-Z_]*[\s:]/.test(trimmed)) {
      return 'legacy';
    }

    // First meaningful line doesn't match either pattern, default to legacy
    return 'legacy';
  }

  return 'legacy';
}
