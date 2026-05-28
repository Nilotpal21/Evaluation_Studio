/**
 * Produce a representative sample value for a JSON Schema fragment.
 *
 * Used to pre-populate curl `-d` payloads and the Fire Now modal from a
 * workflow's `inputSchema`, so author-declared contracts flow into every
 * invocation surface (curl examples, Fire Now editor, docs).
 *
 * Resolution order per node (highest-priority first):
 *   1. `example` — author-provided example (preferred signal)
 *   2. `examples[0]` — OpenAPI-style examples array
 *   3. `default` — JSON Schema default value
 *   4. `enum[0]` — first of a closed value list
 *   5. `const` — fixed value
 *   6. Derived from `type` (object/array/string/number/boolean/null)
 *
 * Unknown or malformed schemas resolve to `null`. An empty schema `{}` with
 * no `type` or `properties` also resolves to `null` — callers should treat
 * `null` as "no sample available" and fall back to their own default.
 */
export function jsonSchemaToSample(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;

  if ('example' in s) return s.example;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if ('default' in s) return s.default;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  if ('const' in s) return s.const;

  const type = s.type;

  if (type === 'object' || (type === undefined && s.properties)) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      out[key] = jsonSchemaToSample(value);
    }
    return out;
  }

  if (type === 'array') {
    const items = s.items;
    if (!items) return [];
    // Single representative element — callers can duplicate if they need more.
    return [jsonSchemaToSample(items)];
  }

  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;

  return null;
}

/**
 * Convenience: derive a sample object from a workflow-level inputSchema.
 * Returns `null` when the schema is missing, empty, or produces a null sample
 * (so the caller can skip rendering or fall back cleanly).
 */
export function workflowInputSample(
  inputSchema: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!inputSchema || Object.keys(inputSchema).length === 0) return null;
  const sample = jsonSchemaToSample(inputSchema);
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    return sample as Record<string, unknown>;
  }
  return null;
}
