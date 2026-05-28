# CEL Migration Guide

## Overview

ABL is adopting [CEL (Common Expression Language)](https://github.com/google/cel-spec) as its standard expression language. CEL is an industry standard used in Kubernetes, Firebase Security Rules, and Envoy proxy.

## What Changed

The ABL expression engine now supports two syntaxes:

- **Legacy ABL**: `age >= 18 AND UPPER(name) == "JOHN"`
- **CEL**: `age >= 18 && abl.upper(name) == "JOHN"`

Both syntaxes are fully supported during the transition period. Legacy expressions are automatically detected and migrated to CEL at evaluation time.

## Expression Syntax Comparison

| ABL Custom              | CEL Equivalent              | Notes             |
| ----------------------- | --------------------------- | ----------------- |
| `AND`                   | `&&`                        | Logical AND       |
| `OR`                    | `\|\|`                      | Logical OR        |
| `NOT x`                 | `!x`                        | Logical NOT       |
| `x CONTAINS "y"`        | `x.contains("y")`           | String membership |
| `x MATCHES "pattern"`   | `x.matches("pattern")`      | Regex match       |
| `x IS SET`              | `has(x)`                    | Field existence   |
| `x IS NOT SET`          | `!has(x)`                   | Field absence     |
| `x IN [a, b]`           | `x in [a, b]`               | List membership   |
| `ADD(a, b)`             | `a + b`                     | Addition          |
| `SUB(a, b)`             | `a - b`                     | Subtraction       |
| `MUL(a, b)`             | `a * b`                     | Multiplication    |
| `DIV(a, b)`             | `a / b`                     | Division          |
| `LENGTH(x)`             | `size(x)`                   | Length/size       |
| `UPPER(x)`              | `abl.upper(x)`              | Uppercase         |
| `LOWER(x)`              | `abl.lower(x)`              | Lowercase         |
| `TRIM(x)`               | `abl.trim(x)`               | Trim whitespace   |
| `MASK(s, p)`            | `abl.mask(s, p)`            | Mask string       |
| `FORMAT_CURRENCY(n, c)` | `abl.format_currency(n, c)` | Format currency   |
| `COALESCE(a, b)`        | `abl.coalesce(a, b)`        | First non-null    |
| `ROUND(n, d)`           | `abl.round(n, d)`           | Round number      |

## ABL Custom Function Reference (abl.\* Namespace)

### String Functions

- `abl.upper(s)` -- Convert to uppercase
- `abl.lower(s)` -- Convert to lowercase
- `abl.trim(s)` -- Remove leading/trailing whitespace
- `abl.substring(s, start)` / `abl.substring(s, start, end)` -- Extract substring
- `abl.replace(s, find, replacement)` -- Replace all occurrences
- `abl.split(s, delimiter)` -- Split into array
- `abl.join(arr, delimiter)` -- Join array into string
- `abl.pad_start(s, len, char)` -- Pad start
- `abl.pad_end(s, len, char)` -- Pad end
- `abl.repeat(s, count)` -- Repeat string

### Numeric Functions

- `abl.round(n, decimals)` -- Round to N decimals
- `abl.abs(n)` -- Absolute value
- `abl.min(a, b)` -- Minimum
- `abl.max(a, b)` -- Maximum

### Formatting Functions

- `abl.mask(s, pattern)` -- Mask string (patterns: "last4", "first4", "N\*N")
- `abl.format_currency(n, currency)` -- Format as currency
- `abl.format_date(d, format)` -- Format date (YYYY, MM, DD, HH, mm, ss)
- `abl.ordinal(n)` -- Ordinal suffix (1st, 2nd, 3rd, etc.)

### Type Functions

- `abl.is_array(x)` -- Check if array
- `abl.is_number(x)` -- Check if number
- `abl.is_string(x)` -- Check if string
- `abl.to_number(s)` -- Parse string to number
- `abl.to_string(x)` -- Convert to string

### Array Functions

- `abl.length(x)` -- Length of array or string
- `abl.array_find(arr, field, value)` -- Find object in array by field value
- `abl.array_find_index(arr, field, value)` -- Find index in array

### Object Functions

- `abl.object_keys(obj)` -- Get keys
- `abl.object_values(obj)` -- Get values

### Utility Functions

- `abl.coalesce(a, b, ...)` -- First non-null value (2-4 args)
- `abl.now()` -- Current ISO timestamp
- `abl.unique_id(length?)` -- Generate random ID

## CEL Built-in Features

CEL also provides built-in features beyond what ABL custom syntax offered:

- **Ternary**: `condition ? trueValue : falseValue`
- **String methods**: `.contains()`, `.startsWith()`, `.endsWith()`, `.matches()`
- **Size**: `size(list)`, `size(string)`, `size(map)`
- **Type checking**: `type(x)`, `int(x)`, `double(x)`, `string(x)`
- **Macros**: `has()`, `all()`, `exists()`, `filter()`, `map()`

## Backward Compatibility

- **Legacy expressions continue to work.** The dual evaluator auto-detects legacy syntax and migrates it to CEL at evaluation time.
- **No breaking changes.** Existing ABL files with legacy expressions will continue to compile and run.
- **Gradual migration.** Teams can migrate expressions at their own pace using the migration tool.

## Migration Tool

Use `migrateAgentExpressions(dslContent)` to migrate all expressions in an ABL file:

```typescript
import { migrateAgentExpressions } from '@abl/compiler/tools/migrate-expressions';

const result = migrateAgentExpressions(myDslContent);
console.log(result.migratedContent); // Migrated DSL
console.log(result.changes); // List of changes made
```

## Timeline

- **Phase 1 (Current)**: Dual-mode support -- both syntaxes work, CEL evaluator available
- **Phase 2**: YAML format with CEL as the primary expression language
- **Phase 3**: Legacy ABL syntax deprecated (with migration tooling)
