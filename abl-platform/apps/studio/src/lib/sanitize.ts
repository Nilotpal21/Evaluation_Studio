/**
 * Generic Document Sanitizer for API Responses
 *
 * Reusable core that handles common sanitization operations:
 * - _id → id promotion and _id deletion
 * - Internal field stripping
 * - JSON string field parsing (array or nullable variants)
 *
 * Entity-specific sanitizers (sanitizeTool, sanitizeMcpServer, etc.)
 * compose on top of this for custom logic like secret redaction.
 */

export interface SanitizeOptions {
  /** Fields to delete from the output */
  stripFields: string[];
  /** JSON string fields → parsed arrays (null/undefined/malformed → []) */
  jsonArrayFields?: string[];
  /** JSON string fields → parsed value (null stays null, malformed → null) */
  jsonNullableFields?: string[];
}

/**
 * Sanitize a document for API response.
 *
 * - Always deletes `_id` (promotes to `id` if `id` is missing)
 * - Strips listed internal fields
 * - Parses JSON string fields to arrays or nullable values
 */
export function sanitizeDocument<T>(doc: Record<string, unknown>, opts: SanitizeOptions): T {
  const out: Record<string, unknown> = { ...doc };

  // _id → id promotion (always delete _id regardless)
  if (out._id !== undefined) {
    if (!out.id) out.id = String(out._id);
    delete out._id;
  }

  // Strip internal fields
  for (const k of opts.stripFields) delete out[k];

  // Parse JSON array fields (string → T[], null/undefined → [], malformed → [])
  for (const k of opts.jsonArrayFields ?? []) {
    if (typeof out[k] === 'string') {
      try {
        out[k] = JSON.parse(out[k] as string);
      } catch {
        out[k] = [];
      }
    }
    if (out[k] === null || out[k] === undefined) out[k] = [];
  }

  // Parse JSON nullable fields (string → T, null stays null, malformed → null)
  for (const k of opts.jsonNullableFields ?? []) {
    if (typeof out[k] === 'string') {
      try {
        out[k] = JSON.parse(out[k] as string);
      } catch {
        out[k] = null;
      }
    }
  }

  return out as T;
}
