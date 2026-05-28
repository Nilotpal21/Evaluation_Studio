/**
 * normalizeChannels() — Normalizes channel values malformed by LLM re-encoding.
 *
 * The INTERVIEW LLM sometimes re-encodes JSON arrays, producing nested strings
 * like `["[\"Web Chat\"]"]` instead of `["Web Chat"]`. This function unwraps
 * all layers of encoding and returns a clean deduplicated string[].
 */

// Residual JSON characters to strip from split fragments
const JSON_CHARS_RE = /^[\s["]+|[\s"\]]+$/g;

/**
 * Attempt JSON.parse, return undefined on failure.
 */
function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Recursively flatten a parsed value into string elements.
 * Strings that are themselves JSON-encoded are unwrapped recursively.
 */
function flattenParsed(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    // If the string looks like it could be further JSON-encoded, try to unwrap
    if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
      const inner = tryParse(trimmed);
      if (inner !== undefined) {
        flattenParsed(inner, out);
        return;
      }
    }

    out.push(trimmed);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      flattenParsed(item, out);
    }
  }
}

/**
 * Process a single element from the raw array: unwrap JSON encoding layers,
 * strip residual chars, and push clean strings into the output array.
 */
function processElement(element: unknown, out: string[]): void {
  if (typeof element !== 'string') return;

  const trimmed = element.trim();
  if (trimmed.length === 0) return;

  // If it looks like JSON (starts with [ or "), try to parse and flatten
  if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
    const parsed = tryParse(trimmed);
    if (parsed !== undefined) {
      flattenParsed(parsed, out);
      return;
    }

    // Parse failed — likely a split fragment like `["Web Chat"` or `"Email"]`
    // Strip residual JSON characters and split by comma
    const stripped = trimmed.replace(JSON_CHARS_RE, '');
    if (stripped.length > 0) {
      for (const part of stripped.split(',')) {
        const clean = part.replace(JSON_CHARS_RE, '').trim();
        if (clean.length > 0) {
          out.push(clean);
        }
      }
    }
    return;
  }

  // Plain string — use as-is
  out.push(trimmed);
}

/**
 * Normalize channel values that may have been malformed by LLM re-encoding.
 *
 * Handles:
 * - null/undefined → []
 * - JSON string → parsed and recursed
 * - Nested encoding like `['["Web Chat"]']` → `['Web Chat']`
 * - Split fragments like `['["Web Chat"', '"Email"]']` → `['Web Chat', 'Email']`
 * - Deduplication, trimming, empty filtering
 */
export function normalizeChannels(raw: unknown): string[] {
  // null/undefined → empty
  if (raw == null) return [];

  // String input — try to parse as JSON
  if (typeof raw === 'string') {
    const parsed = tryParse(raw);
    if (Array.isArray(parsed)) {
      return normalizeChannels(parsed);
    }
    // Not a JSON array — treat as plain text
    const trimmed = raw.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  // Non-array → empty
  if (!Array.isArray(raw)) return [];

  // Process each element
  const results: string[] = [];
  for (const element of raw) {
    processElement(element, results);
  }

  // Deduplicate preserving order, trim, filter empties
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of results) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      deduped.push(trimmed);
    }
  }

  return deduped;
}
