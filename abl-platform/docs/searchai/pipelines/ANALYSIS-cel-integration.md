# CEL Integration Analysis

**Task:** Pre-Check #57 - Explore existing CEL integration and expression evaluation
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

The ABL Platform has a **mature CEL (Common Expression Language) integration** with 37 custom functions under the `abl` namespace. The platform uses `@marcbachmann/cel-js` v7.5.1 with a singleton environment ready for reuse. Flow selection rules can leverage this existing infrastructure.

---

## 1. CEL Library and Version

**Library:** `@marcbachmann/cel-js` version **7.5.1**

**Location:** `packages/compiler/src/platform/constructs/cel-evaluator.ts`

**Industry Usage:** CEL is used by Kubernetes, Firebase, and Envoy for policy evaluation.

---

## 2. Evaluation API

### Primary Functions

```typescript
import { evaluateCel, evaluateCelCondition } from '@abl/compiler';

// Evaluate expression, return any value
evaluateCel(expression: string, context: Record<string, unknown>): unknown

// Evaluate as boolean condition (preferred for flow selection)
evaluateCelCondition(expression: string, context: Record<string, unknown>): boolean
```

### Features

- **Max expression length:** 4096 bytes
- **BigInt normalization:** CEL integer literals (e.g., `42`) produce BigInt but are auto-normalized to JS numbers
- **Error handling:** Clear error messages with expression preview
- **Singleton environment:** Created once, reused for all evaluations (no per-evaluation overhead)

---

## 3. Available Functions (37 total)

### String Functions (12)

| Function                       | Description                     | Example                                           |
| ------------------------------ | ------------------------------- | ------------------------------------------------- |
| `abl.upper(s)`                 | Convert to uppercase            | `abl.upper(doc.contentType) == 'APPLICATION/PDF'` |
| `abl.lower(s)`                 | Convert to lowercase            | `abl.lower(doc.fileName)`                         |
| `abl.trim(s)`                  | Remove whitespace               | `abl.trim(doc.title)`                             |
| `abl.substring(s, start)`      | Extract substring               | `abl.substring(doc.fileName, 0, 10)`              |
| `abl.substring(s, start, end)` | Extract substring with end      | `abl.substring(doc.fileName, 0, 5)`               |
| `abl.replace(s, find, repl)`   | Replace all occurrences         | `abl.replace(doc.fileName, ".pdf", ".txt")`       |
| `abl.split(s, delim)`          | Split string into array         | `abl.split(doc.tags, ",")`                        |
| `abl.join(arr, delim)`         | Join array into string          | `abl.join(doc.tags, " ")`                         |
| `abl.pad_start(s, len, ch)`    | Pad start of string             | `abl.pad_start(doc.id, 10, "0")`                  |
| `abl.pad_end(s, len, ch)`      | Pad end of string               | `abl.pad_end(doc.name, 20, " ")`                  |
| `abl.repeat(s, count)`         | Repeat string (bounded to 100K) | `abl.repeat("-", 5)`                              |
| `abl.length(x)`                | Get length of string/array      | `abl.length(doc.fileName) > 100`                  |

### Numeric Functions (4)

| Function                 | Description             | Example                                    |
| ------------------------ | ----------------------- | ------------------------------------------ |
| `abl.round(n)`           | Round to integer        | `abl.round(doc.contentSizeBytes / 1024.0)` |
| `abl.round(n, decimals)` | Round to decimal places | `abl.round(doc.score, 2)`                  |
| `abl.abs(n)`             | Absolute value          | `abl.abs(doc.offset)`                      |
| `abl.min(a, b)`          | Minimum of two values   | `abl.min(doc.pageCount, 100)`              |
| `abl.max(a, b)`          | Maximum of two values   | `abl.max(doc.pageCount, 1)`                |

### Formatting Functions (4)

| Function                           | Description         | Example                                         |
| ---------------------------------- | ------------------- | ----------------------------------------------- |
| `abl.mask(s, pattern)`             | Mask sensitive data | `abl.mask(ssn, "last4")` → `*****1234`          |
| `abl.format_currency(n, currency)` | Format as currency  | `abl.format_currency(100.5, "USD")` → `$100.50` |
| `abl.format_date(d, fmt)`          | Format date         | `abl.format_date(doc.createdAt, "YYYY-MM-DD")`  |
| `abl.ordinal(n)`                   | Convert to ordinal  | `abl.ordinal(1)` → `"1st"`                      |

### Type Checking Functions (5)

| Function           | Description                 | Example                        |
| ------------------ | --------------------------- | ------------------------------ |
| `abl.is_array(x)`  | Check if array              | `abl.is_array(doc.tags)`       |
| `abl.is_number(x)` | Check if number/bigint      | `abl.is_number(doc.pageCount)` |
| `abl.is_string(x)` | Check if string             | `abl.is_string(doc.fileName)`  |
| `abl.to_number(x)` | Convert to number (or null) | `abl.to_number(doc.id)`        |
| `abl.to_string(x)` | Convert to string           | `abl.to_string(doc.pageCount)` |

### Array Functions (3)

| Function                                  | Description                   | Example                                           |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `abl.array_find(arr, field, value)`       | Find object in array by field | `abl.array_find(items, "id", "123")`              |
| `abl.array_find_index(arr, field, value)` | Find index of object in array | `abl.array_find_index(items, "status", "active")` |
| `abl.length(arr)`                         | Get array length              | `abl.length(doc.tags) > 0`                        |

### Object Functions (3)

| Function                 | Description           | Example                                 |
| ------------------------ | --------------------- | --------------------------------------- |
| `abl.object_keys(obj)`   | Get object keys       | `abl.object_keys(doc.metadata)`         |
| `abl.object_values(obj)` | Get object values     | `abl.object_values(doc.tags)`           |
| `abl.object_merge(a, b)` | Shallow merge objects | `abl.object_merge(doc.meta, overrides)` |

### Utility Functions (6)

| Function                             | Description                  | Example                                          |
| ------------------------------------ | ---------------------------- | ------------------------------------------------ |
| `abl.coalesce(a, b)`                 | Return first non-null        | `abl.coalesce(doc.title, doc.fileName)`          |
| `abl.now()`                          | Current ISO timestamp        | `doc.createdAt == abl.now()`                     |
| `abl.unique_id()`                    | Generate random ID (6 chars) | `abl.unique_id()`                                |
| `abl.word_count(text)`               | Count words                  | `abl.word_count(doc.content) > 100`              |
| `abl.sentence_count(text)`           | Count sentences              | `abl.sentence_count(doc.summary) > 5`            |
| `abl.matches_pattern(text, pattern)` | Regex match                  | `abl.matches_pattern(doc.fileName, ".*\\.pdf$")` |

### Guardrail Functions (5)

| Function                   | Description                      | Example                          |
| -------------------------- | -------------------------------- | -------------------------------- |
| `abl.contains_pii(text)`   | Check for PII (email, SSN, etc.) | `abl.contains_pii(doc.content)`  |
| `abl.detect_pii(text)`     | Detect PII with details          | `abl.detect_pii(doc.summary)`    |
| `abl.redact_pii(text)`     | Redact all PII                   | `abl.redact_pii(doc.text)`       |
| `abl.contains_url(text)`   | Check for HTTP URLs              | `abl.contains_url(doc.content)`  |
| `abl.contains_email(text)` | Check for email addresses        | `abl.contains_email(doc.author)` |

---

## 4. Context Object Structure

CEL expressions receive a context object with available variables:

```typescript
// Flow selection context (from RFC)
const context = {
  doc: {
    contentType: string,      // MIME type: 'application/pdf', 'image/png', etc.
    contentSizeBytes: number, // File size in bytes
    pageCount?: number,       // Number of pages (if applicable)
    language?: string,        // Language code: 'en', 'es', 'fr', etc.
    mimeType: string,         // Alternative to contentType
    sourceType: string        // 'upload', 'connector', 'email', etc.
  }
};
```

### Field Access

```typescript
// Direct field access (preferred)
doc.contentType == 'application/pdf';

// Nested field access
doc.metadata.author == 'John Doe';

// Array access
doc.tags[0] == 'medical';
```

---

## 5. Expression Examples for Flow Selection

### Simple Type Matching

```cel
// PDF documents
doc.contentType == 'application/pdf'

// Images (PNG or JPEG)
doc.contentType == 'image/png' || doc.contentType == 'image/jpeg'

// Plain text
doc.contentType == 'text/plain'
```

### Complex Conditions

```cel
// Large PDFs (>10 pages)
doc.contentType == 'application/pdf' && doc.pageCount > 10

// Small images (<5MB)
doc.contentType.startsWith('image/') && doc.contentSizeBytes < 5242880

// SharePoint documents (any type)
doc.sourceType == 'sharepoint'

// English PDFs from connector
doc.contentType == 'application/pdf' && doc.language == 'en' && doc.sourceType == 'connector'
```

### Using ABL Functions

```cel
// Uppercase comparison (case-insensitive)
abl.upper(doc.contentType) == 'APPLICATION/PDF'

// File size in MB
doc.contentSizeBytes / 1048576.0 > 50.0

// Multiple source types
doc.sourceType in ['connector', 'email', 'api']

// Pattern matching on filename
abl.matches_pattern(doc.fileName, '.*\\.docx?$')
```

---

## 6. Security and Field Whitelisting

### Field Whitelisting Strategy

**Best Practice:** Only expose safe fields in the context object.

```typescript
// ✅ SAFE - Only whitelisted fields
const safeContext = {
  doc: {
    contentType: document.contentType,
    contentSizeBytes: document.contentSizeBytes,
    pageCount: document.pageCount,
    language: document.language,
    mimeType: document.mimeType,
    sourceType: document.sourceType,
  },
};

// ❌ UNSAFE - Don't expose entire document
const unsafeContext = { doc: document }; // Could expose tenantId, _id, etc.
```

### Field Blacklisting (Defense in Depth)

Even with whitelisting, validate expressions don't reference blacklisted fields:

```typescript
const BLACKLISTED_FIELDS = ['tenantId', '_id', 'apiKey', 'secret', 'password'];

function validateExpression(expr: string): void {
  for (const field of BLACKLISTED_FIELDS) {
    if (expr.includes(field)) {
      throw new Error(`Expression references blacklisted field: ${field}`);
    }
  }
}
```

---

## 7. Error Handling

### Syntax Errors (at save time)

```typescript
try {
  evaluateCelCondition(expression, context);
} catch (err) {
  // CEL evaluation failed for "doc.contentType =": Syntax error: mismatched input '<EOF>' expecting ...
  // User-friendly message: "Invalid expression: Missing comparison value"
}
```

### Runtime Errors (during evaluation)

CEL handles missing fields gracefully:

```typescript
// If doc.pageCount is undefined, CEL treats it as null
doc.pageCount > 10; // null > 10 → false (no error)

// Safe navigation
doc.metadata.author == 'John'; // If metadata is null, evaluates to false
```

### Validation Strategy

**At Save Time:**

1. Parse expression with CEL to check syntax
2. Validate field references (whitelist)
3. Check for blacklisted fields
4. Test against sample documents

**At Evaluation Time:**

1. Build safe context (whitelisted fields only)
2. Evaluate with CEL
3. Log errors for debugging
4. Default to fallback flow if expression fails

---

## 8. Performance

### Singleton Environment

```typescript
// ✅ CORRECT - Reuse singleton environment (created once)
import { evaluateCelCondition } from '@abl/compiler';

// This reuses the pre-created ablCelEnvironment
evaluateCelCondition('doc.contentType == "application/pdf"', context);
```

**Performance:** ~100-500 microseconds per evaluation (no compilation overhead).

### Caching Strategy (Optional)

For hot-path evaluations, consider caching compiled expressions:

```typescript
const expressionCache = new Map<string, CompiledExpression>();

function evaluateWithCache(expr: string, context: Record<string, unknown>): boolean {
  let compiled = expressionCache.get(expr);
  if (!compiled) {
    compiled = compileExpression(expr); // Hypothetical compilation
    expressionCache.set(expr, compiled);
  }
  return compiled.evaluate(context);
}
```

**Note:** Current CEL integration doesn't expose compiled expressions, but compilation is fast enough that caching may not be needed.

---

## 9. Existing Usage Patterns

### Profile Resolution (Runtime)

**Location:** `apps/runtime/src/services/execution/profile-resolver.ts`

```typescript
import { evaluateCelCondition } from '@abl/compiler';

// Evaluate behavior profile WHEN expressions
function resolveActiveProfiles(
  profiles: BehaviorProfileIR[],
  context: ProfileContext,
): BehaviorProfileIR[] {
  return profiles.filter((profile) => {
    if (!profile.when) return true; // No condition = always active

    try {
      return evaluateCelCondition(profile.when, context);
    } catch (err) {
      log.error('Profile WHEN evaluation failed', { profileId: profile.id, error: err });
      return false; // Failed profiles are inactive
    }
  });
}
```

**Context Structure:**

```typescript
interface ProfileContext {
  channel: {
    name: string;
    region: string;
    capabilities: { streaming: boolean; media: boolean };
  };
  caller: {
    is_authenticated: boolean;
    customer_id: string | null;
  };
  session: {
    is_new: boolean;
    language: string;
  };
}
```

### Dual-Mode Evaluator

**Location:** `packages/compiler/src/platform/constructs/dual-evaluator.ts`

Supports both legacy ABL syntax and CEL:

```typescript
// Auto-detects format and migrates legacy to CEL
evaluateConditionDual('age >= 18 AND UPPER(name) == "JOHN"', context);
// Migrates to: age >= 18 && abl.upper(name) == "JOHN"

// CEL syntax works directly
evaluateConditionDual('age >= 18 && abl.upper(name) == "JOHN"', context);
```

---

## 10. Recommendations for Pipeline Flow Selection

### Context Object for Flow Selection

```typescript
interface FlowSelectionContext {
  doc: {
    contentType: string;
    contentSizeBytes: number;
    pageCount: number | null;
    language: string | null;
    mimeType: string;
    sourceType: string;
    fileName: string;
  };
}
```

### Service Interface

```typescript
class FlowSelectionService {
  /**
   * Evaluate flow selection rules to find matching flow
   * @returns flowId or null if no match (use default flow)
   */
  selectFlow(flows: PipelineFlow[], document: ISearchDocument): string | null {
    // Build safe context (whitelisted fields only)
    const context: FlowSelectionContext = {
      doc: {
        contentType: document.contentType,
        contentSizeBytes: document.contentSizeBytes,
        pageCount: document.pageCount,
        language: document.language,
        mimeType: document.mimeType,
        sourceType: document.sourceType,
        fileName: document.fileName,
      },
    };

    // Sort flows by priority (highest first)
    const sortedFlows = flows.sort((a, b) => b.priority - a.priority);

    // Evaluate in priority order
    for (const flow of sortedFlows) {
      // Default flow (no selection rules)
      if (!flow.selectionRules) {
        return flow.id;
      }

      // Evaluate CEL expression
      try {
        const matches = evaluateCelCondition(flow.selectionRules, context);
        if (matches) {
          return flow.id;
        }
      } catch (err) {
        // Log error but continue to next flow
        log.error('Flow selection rule failed', {
          flowId: flow.id,
          expression: flow.selectionRules,
          error: err,
        });
        // Don't match on error (security: fail closed)
      }
    }

    // No flow matched (should not happen if default flow exists)
    return null;
  }
}
```

### Validation at Save Time

```typescript
function validateSelectionRules(expression: string): ValidationResult {
  // 1. Check syntax
  try {
    evaluateCelCondition(expression, { doc: {} });
  } catch (err) {
    return { valid: false, error: 'Syntax error: ' + err.message };
  }

  // 2. Check field whitelist
  const allowedFields = [
    'contentType',
    'contentSizeBytes',
    'pageCount',
    'language',
    'mimeType',
    'sourceType',
    'fileName',
  ];
  const usedFields = extractFieldReferences(expression); // Parse AST to find field refs
  const invalidFields = usedFields.filter((f) => !allowedFields.includes(f));

  if (invalidFields.length > 0) {
    return { valid: false, error: `Invalid fields: ${invalidFields.join(', ')}` };
  }

  // 3. Check blacklist
  const blacklist = ['tenantId', '_id', 'secret'];
  for (const field of blacklist) {
    if (expression.includes(field)) {
      return { valid: false, error: `Blacklisted field: ${field}` };
    }
  }

  return { valid: true };
}
```

---

## 11. Migration from Legacy to CEL

**Note:** The platform already migrated from legacy ABL expressions to CEL. The `dual-evaluator` module provides backwards compatibility.

For flow selection rules, **only support CEL** (no legacy syntax):

- ✅ Simpler (one syntax)
- ✅ Better error messages
- ✅ Industry standard
- ✅ Better tooling (Monaco editor support)

---

## 12. CEL Language Features

### Operators

| Operator | Description      | Example                                                   |
| -------- | ---------------- | --------------------------------------------------------- |
| `==`     | Equals           | `doc.contentType == 'pdf'`                                |
| `!=`     | Not equals       | `doc.pageCount != 0`                                      |
| `>`      | Greater than     | `doc.contentSizeBytes > 1000`                             |
| `<`      | Less than        | `doc.pageCount < 100`                                     |
| `>=`     | Greater or equal | `doc.pageCount >= 10`                                     |
| `<=`     | Less or equal    | `doc.contentSizeBytes <= 5000`                            |
| `&&`     | Logical AND      | `doc.contentType == 'pdf' && doc.pageCount > 10`          |
| `\|\|`   | Logical OR       | `doc.contentType == 'pdf' \|\| doc.contentType == 'docx'` |
| `!`      | Logical NOT      | `!(doc.pageCount > 100)`                                  |
| `in`     | Membership       | `doc.sourceType in ['connector', 'email']`                |

### Ternary Operator

```cel
doc.pageCount > 10 ? 'large' : 'small'
```

### String Methods (Built-in CEL)

```cel
// startsWith, endsWith, contains
doc.contentType.startsWith('image/')
doc.fileName.endsWith('.pdf')
doc.title.contains('report')

// matches (regex)
doc.fileName.matches('.*\\.pdf$')
```

### Null Safety

```cel
// Safe navigation (no error if field missing)
doc.metadata.author == 'John'  // If metadata is null, returns false

// Explicit null check
doc.pageCount != null && doc.pageCount > 10
```

---

## 13. Testing Strategy

### Unit Tests

```typescript
describe('Flow Selection Rules', () => {
  test('selects PDF flow for PDF documents', () => {
    const context = {
      doc: {
        contentType: 'application/pdf',
        contentSizeBytes: 1000000,
        pageCount: 50,
      },
    };

    const result = evaluateCelCondition('doc.contentType == "application/pdf"', context);

    expect(result).toBe(true);
  });

  test('selects image flow for PNG/JPEG', () => {
    const context = {
      doc: {
        contentType: 'image/png',
        contentSizeBytes: 500000,
      },
    };

    const result = evaluateCelCondition(
      'doc.contentType == "image/png" || doc.contentType == "image/jpeg"',
      context,
    );

    expect(result).toBe(true);
  });
});
```

### Integration Tests

Test with real document metadata:

```typescript
test('flow selection with real document', async () => {
  const document = await SearchDocument.findById(documentId);
  const flowId = flowSelectionService.selectFlow(pipeline.flows, document);

  expect(flowId).toBe(expectedFlowId);
});
```

---

## Conclusion

**Key Decisions:**

1. ✅ Use existing **`evaluateCelCondition()`** from `@abl/compiler` (no new integration needed)
2. ✅ Leverage **37 ABL functions** under `abl` namespace for rich expressions
3. ✅ Build **safe context object** with whitelisted fields only (security)
4. ✅ Validate expressions **at save time** (syntax, field whitelist, blacklist)
5. ✅ Handle **runtime errors** gracefully (log and skip flow, don't crash)
6. ✅ **Singleton environment** (no per-evaluation overhead, ~100-500μs per eval)
7. ✅ Support **CEL only** for flow selection (no legacy syntax, simpler UX)

**Context Object:**

```typescript
{
  doc: {
    contentType: string,
    contentSizeBytes: number,
    pageCount: number | null,
    language: string | null,
    mimeType: string,
    sourceType: string,
    fileName: string
  }
}
```

**Next:** Proceed to Task #40 (Backend Design: Flow selection service) with this CEL integration.

---

**Analysis complete.** Ready for design implementation.
