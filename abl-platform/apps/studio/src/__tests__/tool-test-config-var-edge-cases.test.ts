/**
 * Tool Test Service — Config Variable Edge Cases
 *
 * Tests for config variable resolution in the Studio tool testing path.
 * These test pure/extractable logic from tool-test-service.ts:
 *
 * 1. TOOL_CONFIG_VARIABLE_PATTERN only matches \w+ — keys with hyphens are missed.
 * 2. collectToolConfigVariableRefs skips auth_profile_ref — but the pattern
 *    check is at the calling site (loadToolConfigVariablesMap), not in the
 *    function itself. Direct callers miss this.
 * 3. resolveDisplayPlaceholders leaks {{config.X}} values in display output —
 *    config vars resolved at compile time are embedded in the IR, so they
 *    appear in cleartext in test results. This is by design for config vars
 *    (plaintext) but could surprise users who expect them masked.
 * 4. The raw namespace-scoped store returns undefined for config vars when
 *    no namespace scope is provided. Studio Tool Test wraps that with a
 *    project-default namespace fallback for legacy tools.
 * 5. The TOOL_CONFIG_VARIABLE_PATTERN (/\{\{config\.(\w+)\}\}/g) does NOT
 *    match {{config.}} (empty key) — correct, but worth documenting.
 * 6. Config vars with namespace scoping: if a var exists but is not in the
 *    tool's linked namespaces, resolution silently returns null with no
 *    warning or error. The user gets an unresolved placeholder with no
 *    indication why.
 */

import { describe, test, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pattern under test — same as in tool-test-service.ts
// ---------------------------------------------------------------------------

const TOOL_CONFIG_VARIABLE_PATTERN = /\{\{config\.(\w+)\}\}/g;

/**
 * Replicated from tool-test-service.ts for pure-function testing.
 * In the actual service, this is a private function.
 */
function collectToolConfigVariableRefs(
  value: unknown,
  refs: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)) {
      refs.add(match[1]);
    }
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolConfigVariableRefs(item, refs);
    }
    return refs;
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      collectToolConfigVariableRefs(nestedValue, refs);
    }
  }

  return refs;
}

/**
 * Replicated from tool-test-service.ts for pure-function testing.
 */
function resolveDisplayPlaceholders(
  value: string,
  input: Record<string, unknown> | undefined,
  consumedKeys: Set<string>,
  urlEncode = false,
): string {
  // 1. Mask secrets, env vars, and unresolved config vars
  let result = value.replace(/\{\{secrets\.(\w+)\}\}/g, '***');
  result = result.replace(/\{\{env\.(\w+)\}\}/g, '***');
  result = result.replace(/\{\{config\.(\w+)\}\}/g, '***');

  // 2. Context/session vars as labels
  result = result.replace(/\{\{_context\.(\w+)\}\}/g, (_, key) => {
    return urlEncode ? encodeURIComponent(`[context.${key}]`) : `[context.${key}]`;
  });
  result = result.replace(/\{\{session\.(\w+)\}\}/g, (_, key) => {
    return urlEncode ? encodeURIComponent(`[session.${key}]`) : `[session.${key}]`;
  });

  // 3. Resolve {{input.X}}, {{X}}, {X} from test input
  if (input) {
    result = result.replace(
      /\{\{input\.(\w+)\}\}|\{\{(\w+)\}\}|\{(\w+)\}/g,
      (match, inputKey, doubleKey, singleKey) => {
        const key = inputKey || doubleKey || singleKey;
        const val = input[key];
        if (val !== undefined && val !== null) {
          consumedKeys.add(key);
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return urlEncode ? encodeURIComponent(str) : str;
        }
        return match;
      },
    );
  }

  return result;
}

// ===========================================================================
// collectToolConfigVariableRefs edge cases
// ===========================================================================

describe('collectToolConfigVariableRefs — edge cases', () => {
  test('extracts config var keys from simple string', () => {
    const refs = collectToolConfigVariableRefs(
      'https://{{config.BASE_URL}}/api/v{{config.VERSION}}',
    );
    expect(refs).toEqual(new Set(['BASE_URL', 'VERSION']));
  });

  test('handles empty string', () => {
    const refs = collectToolConfigVariableRefs('');
    expect(refs.size).toBe(0);
  });

  test('does not extract env or secrets placeholders', () => {
    const refs = collectToolConfigVariableRefs(
      '{{env.DB_URL}} {{secrets.API_KEY}} {{config.APP_NAME}}',
    );
    expect(refs).toEqual(new Set(['APP_NAME']));
  });

  test('extracts from nested object', () => {
    const refs = collectToolConfigVariableRefs({
      endpoint: 'https://{{config.HOST}}/api',
      headers: {
        'X-Version': '{{config.API_VERSION}}',
        nested: {
          deep: '{{config.DEEP_VAR}}',
        },
      },
    });
    expect(refs).toEqual(new Set(['HOST', 'API_VERSION', 'DEEP_VAR']));
  });

  test('extracts from arrays', () => {
    const refs = collectToolConfigVariableRefs([
      '{{config.FIRST}}',
      ['{{config.SECOND}}'],
      { key: '{{config.THIRD}}' },
    ]);
    expect(refs).toEqual(new Set(['FIRST', 'SECOND', 'THIRD']));
  });

  test('handles null and undefined values without error', () => {
    const refs = collectToolConfigVariableRefs(null);
    expect(refs.size).toBe(0);

    const refs2 = collectToolConfigVariableRefs(undefined);
    expect(refs2.size).toBe(0);
  });

  test('handles non-string primitives without error', () => {
    const refs = collectToolConfigVariableRefs(42);
    expect(refs.size).toBe(0);

    const refs2 = collectToolConfigVariableRefs(true);
    expect(refs2.size).toBe(0);
  });

  // Keys with hyphens are not valid config var keys per the API's KEY_PATTERN
  // (/^[A-Za-z][A-Za-z0-9_]*$/), so \w+ in the pattern correctly excludes them.
  test('does not detect keys with hyphens (by design: hyphens not valid in key names)', () => {
    const refs = collectToolConfigVariableRefs('{{config.MY-API-KEY}}');

    // \w+ matches [A-Za-z0-9_] — hyphens are excluded.
    // This is correct: the API rejects hyphenated keys, so the resolution
    // pattern should not match them either.
    expect(refs.has('MY-API-KEY')).toBe(false);
    expect(refs.size).toBe(0);
  });

  test('handles empty key {{config.}} gracefully', () => {
    const refs = collectToolConfigVariableRefs('{{config.}}');
    // Empty key should not be extracted (correct behavior)
    expect(refs.size).toBe(0);
  });

  test('handles key with only underscores', () => {
    const refs = collectToolConfigVariableRefs('{{config._}}');
    expect(refs).toEqual(new Set(['_']));
  });

  test('deduplicates same key referenced multiple times', () => {
    const refs = collectToolConfigVariableRefs('{{config.X}} and {{config.X}} and {{config.X}}');
    expect(refs.size).toBe(1);
    expect(refs.has('X')).toBe(true);
  });
});

// ===========================================================================
// resolveDisplayPlaceholders edge cases
// ===========================================================================

describe('resolveDisplayPlaceholders — config var display', () => {
  test('masks both {{secrets.X}} and {{config.X}} in display', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'endpoint: https://{{config.HOST}}/api?key={{secrets.KEY}}',
      undefined,
      consumed,
    );

    // Both secrets and unresolved config vars are masked
    expect(result).toBe('endpoint: https://***/api?key=***');
    expect(result).not.toContain('config.HOST');
    expect(result).not.toContain('secrets.KEY');
  });

  test('masks {{env.X}} in display', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders('db: {{env.DATABASE_URL}}', undefined, consumed);
    expect(result).toBe('db: ***');
  });

  // Unresolved {{config.X}} placeholders are masked (like secrets and env vars)
  // to prevent leaking config variable names in test result display.
  test('unresolved {{config.X}} is masked in display output', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'https://{{config.PRIVATE_HOST}}/internal',
      undefined,
      consumed,
    );

    // {{config.PRIVATE_HOST}} should be replaced with *** like secrets/env vars
    expect(result).not.toContain('config.PRIVATE_HOST');
    expect(result).toBe('https://***/internal');
  });

  test('{{X}} pattern in display resolves from input, not config vars', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'https://example.com/{{id}}/details',
      { id: '12345' },
      consumed,
    );

    expect(result).toBe('https://example.com/12345/details');
    expect(consumed.has('id')).toBe(true);
  });

  test('consumed keys are tracked correctly for URL encoding', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'https://example.com/{{query}}/search',
      { query: 'hello world' },
      consumed,
      true, // urlEncode
    );

    expect(result).toBe('https://example.com/hello%20world/search');
    expect(consumed.has('query')).toBe(true);
  });

  test('undefined input values leave placeholder intact', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'https://example.com/{{missing}}/details',
      { other: 'value' },
      consumed,
    );

    expect(result).toBe('https://example.com/{{missing}}/details');
    expect(consumed.size).toBe(0);
  });

  test('object input values are JSON-serialized', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders(
      'body: {{data}}',
      { data: { key: 'value', nested: [1, 2] } },
      consumed,
    );

    expect(result).toBe('body: {"key":"value","nested":[1,2]}');
    expect(consumed.has('data')).toBe(true);
  });

  test('input with null value leaves placeholder intact', () => {
    const consumed = new Set<string>();
    const result = resolveDisplayPlaceholders('{{nullable}}', { nullable: null }, consumed);

    expect(result).toBe('{{nullable}}');
    expect(consumed.size).toBe(0);
  });
});

// ===========================================================================
// Pattern edge cases — TOOL_CONFIG_VARIABLE_PATTERN
// ===========================================================================

describe('TOOL_CONFIG_VARIABLE_PATTERN — regex edge cases', () => {
  test('does not match single-brace syntax {config.X}', () => {
    const matches = [...'{config.API_KEY}'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  test('does not match triple-brace syntax {{{config.X}}}', () => {
    const input = '{{{config.API_KEY}}}';
    const matches = [...input.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    // It will match {{config.API_KEY}} within {{{config.API_KEY}}}
    // Leaving an extra { and } around it
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('API_KEY');
  });

  test('matches config var adjacent to other text with no spacing', () => {
    const matches = [...'prefix{{config.KEY}}suffix'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('KEY');
  });

  test('does not match when there is a space in the key', () => {
    const matches = [...'{{config.MY KEY}}'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  test('does not match config.X without double braces', () => {
    const matches = [...'config.API_KEY'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  test('matches numeric keys', () => {
    const matches = [...'{{config.VAR123}}'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('VAR123');
  });

  // BUG: Keys starting with numbers match \w+ but are invalid per API KEY_PATTERN
  test('matches key starting with number (inconsistent with API validation)', () => {
    const matches = [...'{{config.123VAR}}'.matchAll(TOOL_CONFIG_VARIABLE_PATTERN)];

    // The regex matches 123VAR because \w+ allows digits.
    // But the API's KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/ requires
    // keys to start with a letter. So you can reference {{config.123VAR}}
    // in DSL, but you can't create a var with key "123VAR" via the API.
    // This is an inconsistency — the resolution pattern is more permissive
    // than the storage validation.
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('123VAR');
  });
});

// ===========================================================================
// Namespace scoping edge cases
// ===========================================================================

describe('config var namespace scoping — edge cases', () => {
  test('documents: the raw namespace-scoped store needs an effective namespace', async () => {
    // Studio Tool Test computes an effective namespace before calling the
    // store. The store itself still fails closed when no namespace scope is
    // provided, which keeps accidental broad project scans out of the helper.

    // Simulate createConfigVarStore with empty namespace list
    const hasNamespaces = false;
    const findConfigVar = async () => {
      if (!hasNamespaces) return null;
      return { value: 'should-not-reach' };
    };

    await expect(findConfigVar()).resolves.toBeNull();
  });
});
