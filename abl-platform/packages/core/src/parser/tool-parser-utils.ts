/**
 * Tool Parser Utilities
 *
 * Shared parsing functions for tool signatures, parameters, and return types.
 * Used by both agent-based-parser and tool-file-parser.
 */

import type { ToolParam, ToolReturn } from '../types/agent-based.js';

const NUMERIC_DEFAULT_VALUE_PATTERN = /^-?\d+(?:\.\d+)?$/;

export function parseToolParams(paramsStr: string): ToolParam[] {
  if (!paramsStr.trim()) return [];

  const params: ToolParam[] = [];
  const parts = splitParams(paramsStr);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Parse: name: type [= default]
    // Type can be: string, number, object[], {field: type}, etc.
    const match = trimmed.match(/^(\w+):\s*([\w[\]{}:,\s]+?)(?:\s*=\s*(.+))?$/);
    if (match) {
      const [, name, type, defaultVal] = match;
      params.push({
        name,
        type: type.trim(),
        required: defaultVal === undefined,
        default: defaultVal ? parseDefaultValue(defaultVal) : undefined,
      });
    }
  }

  return params;
}

export function splitParams(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of str) {
    if (char === '{' || char === '[' || char === '(') depth++;
    if (char === '}' || char === ']' || char === ')') depth--;

    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) parts.push(current);
  return parts;
}

export function parseToolReturn(returnStr: string): ToolReturn {
  const trimmed = returnStr.trim();

  // Simple type
  if (/^\w+$/.test(trimmed)) {
    return { type: trimmed };
  }

  // Array type: Type[]
  if (trimmed.endsWith('[]')) {
    return {
      type: 'array',
      items: { type: trimmed.slice(0, -2) },
    };
  }

  // Object type: {field: type, ...}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const fields: Record<string, ToolReturn> = {};
    const inner = trimmed.slice(1, -1);
    const parts = splitParams(inner);

    for (const part of parts) {
      const match = part.trim().match(/^(\w+)\??:\s*(.+)$/);
      if (match) {
        const [, name, typeStr] = match;
        const optional = part.includes('?:');
        fields[name] = { ...parseToolReturn(typeStr), optional };
      }
    }

    return { type: 'object', fields };
  }

  return { type: trimmed };
}

export function parseDefaultValue(val: string): unknown {
  const trimmed = val.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (NUMERIC_DEFAULT_VALUE_PATTERN.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed.replace(/^"|"$/g, '');
}
