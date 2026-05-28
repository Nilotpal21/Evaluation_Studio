/**
 * Generate Test Input from DSL
 *
 * Given a tool DSL content string, produces a dummy input object
 * suitable for test invocations. Uses heuristics on parameter names
 * and types to generate realistic sample values.
 */

import { parseSignatureLine, parseDslParamMetadata } from './dsl-property-parser.js';

// ─── Name-Based Heuristics ──────────────────────────────────────────────────

const STRING_HEURISTICS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /email/i, value: 'test@example.com' },
  { pattern: /phone/i, value: '+1-555-000-1234' },
  { pattern: /date/i, value: '2026-01-15' },
  { pattern: /url/i, value: 'https://example.com' },
  { pattern: /name/i, value: 'Test User' },
  { pattern: /address/i, value: '123 Main St' },
  { pattern: /city/i, value: 'San Francisco' },
  { pattern: /country/i, value: 'US' },
  { pattern: /zip|postal/i, value: '94105' },
  { pattern: /id/i, value: 'test-id-001' },
  { pattern: /token/i, value: 'tok_test_abc123' },
  { pattern: /key/i, value: 'key_test_abc123' },
  { pattern: /query|search/i, value: 'test query' },
  { pattern: /message|text|body|content/i, value: 'Hello, this is a test message.' },
  { pattern: /description/i, value: 'Test description' },
  { pattern: /title/i, value: 'Test Title' },
  { pattern: /currency/i, value: 'USD' },
  { pattern: /language|lang/i, value: 'en' },
  { pattern: /status/i, value: 'active' },
];

/**
 * Generate a dummy string value based on parameter name heuristics.
 */
function generateStringValue(paramName: string): string {
  for (const { pattern, value } of STRING_HEURISTICS) {
    if (pattern.test(paramName)) {
      return value;
    }
  }
  return 'test-value';
}

/**
 * Generate a dummy value for a given parameter type and name.
 */
function generateValueForType(
  paramName: string,
  paramType: string,
  metadata?: { enum?: string[]; default?: string },
): unknown {
  // If a default value is provided, use it
  if (metadata?.default !== undefined && metadata.default !== '') {
    return coerceDefault(metadata.default, paramType);
  }

  // If enum values are provided, pick the first one
  if (metadata?.enum && metadata.enum.length > 0) {
    return metadata.enum[0];
  }

  const normalizedType = paramType.toLowerCase().trim();

  switch (normalizedType) {
    case 'string':
    case 'email':
      return generateStringValue(paramName);
    case 'number':
    case 'integer':
    case 'int':
    case 'float':
      return 0;
    case 'boolean':
    case 'bool':
      return true;
    case 'object':
      return {};
    case 'array':
      return [];
    default:
      // Array types like "string[]"
      if (normalizedType.endsWith('[]')) {
        return [];
      }
      // Object types like "{name: string, email: string}"
      if (normalizedType.startsWith('{') && normalizedType.endsWith('}')) {
        return {};
      }
      return 'test-value';
  }
}

/**
 * Coerce a default value string to the appropriate JS type.
 */
function coerceDefault(defaultStr: string, paramType: string): unknown {
  const normalizedType = paramType.toLowerCase().trim();
  if (normalizedType === 'number' || normalizedType === 'integer' || normalizedType === 'float') {
    const num = Number(defaultStr);
    return Number.isNaN(num) ? 0 : num;
  }
  if (normalizedType === 'boolean' || normalizedType === 'bool') {
    return defaultStr.toLowerCase() === 'true';
  }
  return defaultStr;
}

/**
 * Generate a test input object from a tool DSL content string.
 *
 * @param dslContent - The raw DSL string defining the tool
 * @returns An object mapping parameter names to dummy test values
 */
export function generateTestInputFromDsl(dslContent: string): Record<string, unknown> {
  if (!dslContent?.trim()) return {};

  const { parameters } = parseSignatureLine(dslContent);
  const paramMetadata = parseDslParamMetadata(dslContent);
  const result: Record<string, unknown> = {};

  for (const param of parameters) {
    const meta = paramMetadata.get(param.name);
    result[param.name] = generateValueForType(param.name, param.type, meta);
  }

  return result;
}
