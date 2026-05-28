/**
 * Auto-generated CEL Functions documentation.
 * DO NOT EDIT — regenerate with: npx tsx scripts/generate-cel-docs.ts
 */
export const CEL_FUNCTIONS_DOCS = `# CEL Functions Reference

ABL provides built-in CEL (Common Expression Language) functions for use in
conditions, transitions, and computed fields.

Total: 30 functions across 7 categories.

## String Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.upper\` | \`abl.upper(s: string): string\` | Convert string to uppercase |
| \`abl.lower\` | \`abl.lower(s: string): string\` | Convert string to lowercase |
| \`abl.trim\` | \`abl.trim(s: string): string\` | Trim leading and trailing whitespace |
| \`abl.substring\` | \`abl.substring(s: string, start: int, end?: int): string\` | Extract substring from start to optional end index |
| \`abl.replace\` | \`abl.replace(s: string, find: string, replacement: string): string\` | Replace all occurrences of find with replacement |
| \`abl.split\` | \`abl.split(s: string, delimiter: string): list\` | Split string into array by delimiter |
| \`abl.join\` | \`abl.join(arr: list, delimiter?: string): string\` | Join array elements with delimiter (default: ",") |
| \`abl.pad_start\` | \`abl.pad_start(s: string, length: int, char?: string): string\` | Pad string from the left to target length |
| \`abl.pad_end\` | \`abl.pad_end(s: string, length: int, char?: string): string\` | Pad string from the right to target length |
| \`abl.repeat\` | \`abl.repeat(s: string, count: int): string\` | Repeat string count times (max 100,000 chars) |

## Numeric Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.round\` | \`abl.round(n: double, decimals?: int): double\` | Round number to integer or N decimal places |
| \`abl.abs\` | \`abl.abs(n: double): double\` | Absolute value |
| \`abl.min\` | \`abl.min(a: double, b: double): double\` | Return the smaller of two numbers |
| \`abl.max\` | \`abl.max(a: double, b: double): double\` | Return the larger of two numbers |

## Formatting Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.mask\` | \`abl.mask(s: string, pattern: string, char?: string): string\` | Mask sensitive data (patterns: "last4", "first4", "n*m") |
| \`abl.format_currency\` | \`abl.format_currency(n: double, currency: string, locale?: string): string\` | Format number as currency using Intl.NumberFormat |
| \`abl.format_date\` | \`abl.format_date(d: string, fmt: string, tz?: string): string\` | Format date string (YYYY, MM, DD, HH, mm, ss placeholders) |
| \`abl.ordinal\` | \`abl.ordinal(n: int): string\` | Convert number to ordinal string (1st, 2nd, 3rd, ...) |

## Type Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.is_array\` | \`abl.is_array(x: any): bool\` | Check if value is an array |
| \`abl.is_number\` | \`abl.is_number(x: any): bool\` | Check if value is a number |
| \`abl.is_string\` | \`abl.is_string(x: any): bool\` | Check if value is a string |
| \`abl.to_number\` | \`abl.to_number(x: any): double | null\` | Convert value to number (null if NaN) |
| \`abl.to_string\` | \`abl.to_string(x: any): string\` | Convert value to string representation |

## Array Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.length\` | \`abl.length(x: list | string): int\` | Get length of array or string |
| \`abl.array_find\` | \`abl.array_find(arr: list, field: string, value: any): map | null\` | Find first object in array where field equals value |
| \`abl.array_find_index\` | \`abl.array_find_index(arr: list, field: string, value: any): int\` | Find index of first object where field equals value (-1 if not found) |

## Object Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.object_keys\` | \`abl.object_keys(obj: map): list\` | Get array of object keys |
| \`abl.object_values\` | \`abl.object_values(obj: map): list\` | Get array of object values |
| \`abl.object_merge\` | \`abl.object_merge(a: map, b: map, c?: map): map\` | Shallow merge two or three objects |

## Utility Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| \`abl.coalesce\` | \`abl.coalesce(a: any, b: any, c?: any, d?: any): any\` | Return first non-null value |
| \`abl.now\` | \`abl.now(): string\` | Current timestamp as ISO 8601 string |
| \`abl.unique_id\` | \`abl.unique_id(length?: int): string\` | Generate pseudorandom alphanumeric ID (default length: 6) |

## Usage Examples

\`\`\`yaml
# In a transition condition:
transitions:
  - target: next_step
    condition: abl.length(context.items) > 0

# In a computed field:
fields:
  formatted_name:
    type: string
    compute: abl.upper(abl.trim(context.name))

# In a constraint:
constraints:
  - description: Only process valid amounts
    condition: abl.is_number(context.amount) && abl.round(context.amount, 2) > 0
\`\`\``;
