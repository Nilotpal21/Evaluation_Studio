/**
 * Static registry of ABL CEL function metadata for completions and hover docs.
 *
 * This is a mirror of the functions registered in
 * packages/compiler/src/platform/constructs/cel-functions.ts
 * kept as static data to avoid importing the CEL runtime.
 */

export interface CelFunctionMeta {
  name: string;
  signature: string;
  description: string;
  category: 'string' | 'numeric' | 'formatting' | 'type' | 'array' | 'object' | 'utility';
}

export const CEL_FUNCTIONS: ReadonlyArray<CelFunctionMeta> = [
  // --- String ---
  {
    name: 'abl.upper',
    signature: 'abl.upper(s: string): string',
    description: 'Convert string to uppercase',
    category: 'string',
  },
  {
    name: 'abl.lower',
    signature: 'abl.lower(s: string): string',
    description: 'Convert string to lowercase',
    category: 'string',
  },
  {
    name: 'abl.trim',
    signature: 'abl.trim(s: string): string',
    description: 'Trim leading and trailing whitespace',
    category: 'string',
  },
  {
    name: 'abl.substring',
    signature: 'abl.substring(s: string, start: int, end?: int): string',
    description: 'Extract substring from start to optional end index',
    category: 'string',
  },
  {
    name: 'abl.replace',
    signature: 'abl.replace(s: string, find: string, replacement: string): string',
    description: 'Replace all occurrences of find with replacement',
    category: 'string',
  },
  {
    name: 'abl.split',
    signature: 'abl.split(s: string, delimiter: string): list',
    description: 'Split string into array by delimiter',
    category: 'string',
  },
  {
    name: 'abl.join',
    signature: 'abl.join(arr: list, delimiter?: string): string',
    description: 'Join array elements with delimiter (default: ",")',
    category: 'string',
  },
  {
    name: 'abl.pad_start',
    signature: 'abl.pad_start(s: string, length: int, char?: string): string',
    description: 'Pad string from the left to target length',
    category: 'string',
  },
  {
    name: 'abl.pad_end',
    signature: 'abl.pad_end(s: string, length: int, char?: string): string',
    description: 'Pad string from the right to target length',
    category: 'string',
  },
  {
    name: 'abl.repeat',
    signature: 'abl.repeat(s: string, count: int): string',
    description: 'Repeat string count times (max 100,000 chars)',
    category: 'string',
  },

  // --- Numeric ---
  {
    name: 'abl.round',
    signature: 'abl.round(n: double, decimals?: int): double',
    description: 'Round number to integer or N decimal places',
    category: 'numeric',
  },
  {
    name: 'abl.abs',
    signature: 'abl.abs(n: double): double',
    description: 'Absolute value',
    category: 'numeric',
  },
  {
    name: 'abl.min',
    signature: 'abl.min(a: double, b: double): double',
    description: 'Return the smaller of two numbers',
    category: 'numeric',
  },
  {
    name: 'abl.max',
    signature: 'abl.max(a: double, b: double): double',
    description: 'Return the larger of two numbers',
    category: 'numeric',
  },

  // --- Formatting ---
  {
    name: 'abl.mask',
    signature: 'abl.mask(s: string, pattern: string, char?: string): string',
    description: 'Mask sensitive data (patterns: "last4", "first4", "n*m")',
    category: 'formatting',
  },
  {
    name: 'abl.format_currency',
    signature: 'abl.format_currency(n: double, currency: string, locale?: string): string',
    description: 'Format number as currency using Intl.NumberFormat',
    category: 'formatting',
  },
  {
    name: 'abl.format_date',
    signature: 'abl.format_date(d: string, fmt: string, tz?: string): string',
    description: 'Format date string (YYYY, MM, DD, HH, mm, ss placeholders)',
    category: 'formatting',
  },
  {
    name: 'abl.ordinal',
    signature: 'abl.ordinal(n: int): string',
    description: 'Convert number to ordinal string (1st, 2nd, 3rd, ...)',
    category: 'formatting',
  },

  // --- Type checking ---
  {
    name: 'abl.is_array',
    signature: 'abl.is_array(x: any): bool',
    description: 'Check if value is an array',
    category: 'type',
  },
  {
    name: 'abl.is_number',
    signature: 'abl.is_number(x: any): bool',
    description: 'Check if value is a number',
    category: 'type',
  },
  {
    name: 'abl.is_string',
    signature: 'abl.is_string(x: any): bool',
    description: 'Check if value is a string',
    category: 'type',
  },
  {
    name: 'abl.to_number',
    signature: 'abl.to_number(x: any): double | null',
    description: 'Convert value to number (null if NaN)',
    category: 'type',
  },
  {
    name: 'abl.to_string',
    signature: 'abl.to_string(x: any): string',
    description: 'Convert value to string representation',
    category: 'type',
  },

  // --- Array ---
  {
    name: 'abl.length',
    signature: 'abl.length(x: list | string): int',
    description: 'Get length of array or string',
    category: 'array',
  },
  {
    name: 'abl.array_find',
    signature: 'abl.array_find(arr: list, field: string, value: any): map | null',
    description: 'Find first object in array where field equals value',
    category: 'array',
  },
  {
    name: 'abl.array_find_index',
    signature: 'abl.array_find_index(arr: list, field: string, value: any): int',
    description: 'Find index of first object where field equals value (-1 if not found)',
    category: 'array',
  },

  // --- Object ---
  {
    name: 'abl.object_keys',
    signature: 'abl.object_keys(obj: map): list',
    description: 'Get array of object keys',
    category: 'object',
  },
  {
    name: 'abl.object_values',
    signature: 'abl.object_values(obj: map): list',
    description: 'Get array of object values',
    category: 'object',
  },
  {
    name: 'abl.object_merge',
    signature: 'abl.object_merge(a: map, b: map, c?: map): map',
    description: 'Shallow merge two or three objects',
    category: 'object',
  },

  // --- Utility ---
  {
    name: 'abl.coalesce',
    signature: 'abl.coalesce(a: any, b: any, c?: any, d?: any): any',
    description: 'Return first non-null value',
    category: 'utility',
  },
  {
    name: 'abl.now',
    signature: 'abl.now(): string',
    description: 'Current timestamp as ISO 8601 string',
    category: 'utility',
  },
  {
    name: 'abl.unique_id',
    signature: 'abl.unique_id(length?: int): string',
    description: 'Generate pseudorandom alphanumeric ID (default length: 6)',
    category: 'utility',
  },
];
