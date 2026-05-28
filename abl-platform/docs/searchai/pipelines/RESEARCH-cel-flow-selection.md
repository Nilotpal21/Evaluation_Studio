# Research: CEL Expression Evaluation for Flow Selection Rules

**Task:** Research #34 - CEL expression evaluation for flow selection rules
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

Flow selection rules use **CEL (Common Expression Language)** to dynamically route documents to different pipeline flows based on document properties. The platform's existing CEL infrastructure (`@marcbachmann/cel-js` with 37 custom functions) can be reused with a **document context object** containing metadata, content type, file size, and source properties. Evaluation is **fail-safe** (invalid expressions or errors default to no match) with **priority-based ordering** to handle multiple matching flows.

---

## 1. Flow Selection Strategy

### Overview

```
Document Ingestion → Load Pipeline Definition → Evaluate Flow Selection Rules (Priority Order) → Execute Matched Flow
```

### Selection Algorithm

```typescript
function selectFlow(document: ISearchDocument, flows: PipelineFlow[]): PipelineFlow {
  // Sort flows by priority (ascending: 1 = highest priority)
  const sortedFlows = flows.sort((a, b) => a.priority - b.priority);

  for (const flow of sortedFlows) {
    // If no selection rules, flow matches all documents
    if (!flow.selectionRules) {
      return flow;
    }

    // Evaluate CEL expression
    try {
      const context = buildDocumentContext(document);
      const matches = evaluateCelCondition(flow.selectionRules, context);
      if (matches) {
        return flow;
      }
    } catch (error) {
      // Invalid expression or evaluation error → skip flow
      log.warn('Flow selection rule evaluation failed', {
        flowId: flow.id,
        error: error.message,
      });
      continue;
    }
  }

  // No flow matched → throw error (pipeline requires at least one matching flow)
  throw new Error(
    'No flow matched document. All flows have selection rules that evaluated to false.',
  );
}
```

**Key Decisions:**

- **Priority-based**: Lower number = higher priority (1, 2, 3, ...)
- **First match wins**: Stop evaluation after first matching flow
- **Fail-safe**: Invalid expressions skip the flow (don't block pipeline)
- **Default flow**: Flow with no `selectionRules` matches all documents (use as catch-all)
- **Error handling**: If no flow matches, throw error (don't silently skip document)

---

## 2. Document Context Object

### Context Structure

```typescript
interface DocumentContext {
  // Core properties
  contentType: string | null; // e.g., 'application/pdf', 'text/html'
  contentSizeBytes: number; // Original file size
  originalReference: string | null; // Filename or URL
  sourceType: string; // Source type (e.g., 'sharepoint', 's3', 'web')
  language: string | null; // Detected language code (e.g., 'en', 'es')

  // Extracted content indicators
  hasExtractedText: boolean; // Whether text extraction succeeded
  pageCount: number | null; // Number of pages (for Docling-extracted documents)

  // Metadata (from source connector)
  metadata: {
    // Source-specific fields (e.g., SharePoint column values, S3 tags)
    [key: string]: string | number | boolean | null;
  };

  // Classification (if available)
  classification: {
    department: string | null;
    category: string | null;
    primaryProduct: string | null;
  } | null;
}
```

### Context Builder

```typescript
function buildDocumentContext(document: ISearchDocument): DocumentContext {
  return {
    contentType: document.contentType,
    contentSizeBytes: document.contentSizeBytes,
    originalReference: document.originalReference,
    sourceType: 'unknown', // Resolved from source lookup
    language: document.language,
    hasExtractedText: document.extractedText !== null && document.extractedText.length > 0,
    pageCount: document.pageCount ?? null,
    metadata: document.sourceMetadata ?? {},
    classification: document.classification
      ? {
          department: document.classification.department,
          category: document.classification.category,
          primaryProduct: document.classification.productScope.primaryProduct,
        }
      : null,
  };
}
```

---

## 3. Example Selection Rules

### By Content Type (MIME Type)

```cel
# PDF documents
contentType == 'application/pdf'

# Office documents (Word, Excel, PowerPoint)
contentType.startsWith('application/vnd.openxmlformats') || contentType.startsWith('application/vnd.ms')

# HTML/Web content
contentType == 'text/html' || contentType == 'application/xhtml+xml'

# Markdown
contentType == 'text/markdown'

# Images
contentType.startsWith('image/')

# Any non-PDF document
contentType != null && contentType != 'application/pdf'
```

### By File Size

```cel
# Small documents (<1MB)
contentSizeBytes < 1048576

# Large documents (>10MB)
contentSizeBytes > 10485760

# Medium-sized documents (1-10MB)
contentSizeBytes >= 1048576 && contentSizeBytes <= 10485760
```

### By File Name/Extension

```cel
# PDF files by extension
originalReference != null && originalReference.endsWith('.pdf')

# Office documents by extension
originalReference != null && (
  originalReference.endsWith('.docx') ||
  originalReference.endsWith('.xlsx') ||
  originalReference.endsWith('.pptx')
)

# Files in specific directory
originalReference != null && originalReference.contains('/legal/')

# Temporary or draft files
originalReference != null && (
  originalReference.contains('_draft') ||
  originalReference.contains('_temp')
)
```

### By Source Type

```cel
# SharePoint documents
sourceType == 'sharepoint'

# S3 documents
sourceType == 's3'

# Web-crawled documents
sourceType == 'web'

# Direct uploads
sourceType == 'upload'
```

### By Language

```cel
# English documents only
language == 'en'

# Spanish or Portuguese documents
language == 'es' || language == 'pt'

# Non-English documents
language != null && language != 'en'
```

### By Classification (if available)

```cel
# Legal department documents
classification != null && classification.department == 'legal'

# Product manuals
classification != null && classification.category == 'product_manual'

# Credit card products
classification != null && classification.primaryProduct == 'credit_card'
```

### By Metadata (source-specific)

```cel
# SharePoint: Confidentiality level
metadata.Confidentiality == 'Internal' || metadata.Confidentiality == 'Public'

# SharePoint: Document status
metadata.Status == 'Published'

# S3: Object tags
metadata.Environment == 'production'

# S3: Object class
metadata.StorageClass == 'STANDARD'
```

### Complex Conditions

```cel
# Large PDFs in legal department
contentType == 'application/pdf' &&
contentSizeBytes > 5242880 &&
classification != null &&
classification.department == 'legal'

# Published English documents from SharePoint
sourceType == 'sharepoint' &&
language == 'en' &&
metadata.Status == 'Published'

# Non-text documents (images, videos) under 50MB
(contentType.startsWith('image/') || contentType.startsWith('video/')) &&
contentSizeBytes < 52428800

# Documents needing vision processing (images in PDF or image files)
(contentType == 'application/pdf' && pageCount > 10) ||
contentType.startsWith('image/')

# High-priority documents for expensive processing
contentSizeBytes < 10485760 &&
(metadata.Priority == 'High' || classification.department == 'executive')
```

---

## 4. Using `abl` Namespace Functions

### String Manipulation

```cel
# Case-insensitive MIME type check
abl.lower(contentType) == 'application/pdf'

# Extract file extension
abl.substring(originalReference, abl.length(originalReference) - 4) == '.pdf'

# Replace file extension in filename check
abl.replace(originalReference, '.docx', '.pdf').endsWith('.pdf')

# Check if filename contains any of multiple terms
abl.lower(originalReference).contains('invoice') ||
abl.lower(originalReference).contains('receipt') ||
abl.lower(originalReference).contains('bill')
```

### Numeric Operations

```cel
# File size in MB (rounded)
abl.round(contentSizeBytes / 1048576.0, 2) < 10.0

# File size in KB
abl.round(contentSizeBytes / 1024.0) > 500

# Page count range
pageCount != null && abl.min(pageCount, 100) >= 10
```

### Type Checking

```cel
# Check if metadata field exists and is a number
abl.is_number(metadata.PageCount) && abl.to_number(metadata.PageCount) > 10

# Check if metadata field is a string
abl.is_string(metadata.DocumentType)

# Safe conversion to number with fallback
abl.to_number(metadata.Priority) >= 5
```

---

## 5. Validation Strategy

### Pre-Save Validation

When a pipeline definition is saved, validate all flow selection rules:

```typescript
async function validateFlowSelectionRules(flows: PipelineFlow[]): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    if (!flow.selectionRules) continue;

    // 1. Check expression length
    if (flow.selectionRules.length > 4096) {
      errors.push({
        code: 'SELECTION_RULES_TOO_LONG',
        message: `Selection rules exceed 4096 characters (${flow.selectionRules.length} chars)`,
        path: `flows[${i}].selectionRules`,
        severity: 'error',
      });
      continue;
    }

    // 2. Syntax validation (parse expression)
    try {
      const env = getCelEnvironment();
      const ast = env.parse(flow.selectionRules);
    } catch (error) {
      errors.push({
        code: 'INVALID_SELECTION_RULES_SYNTAX',
        message: `Invalid CEL syntax: ${error.message}`,
        path: `flows[${i}].selectionRules`,
        severity: 'error',
      });
      continue;
    }

    // 3. Test evaluation with sample context
    try {
      const sampleContext = {
        contentType: 'application/pdf',
        contentSizeBytes: 1048576,
        originalReference: 'document.pdf',
        sourceType: 'upload',
        language: 'en',
        hasExtractedText: true,
        pageCount: 10,
        metadata: {},
        classification: null,
      };
      evaluateCelCondition(flow.selectionRules, sampleContext);
    } catch (error) {
      errors.push({
        code: 'SELECTION_RULES_EVALUATION_ERROR',
        message: `Expression evaluation failed on sample context: ${error.message}`,
        path: `flows[${i}].selectionRules`,
        severity: 'warning', // Warning, not error (might work with real document)
      });
    }

    // 4. Check for undefined variables
    const undefinedVars = extractUndefinedVariables(flow.selectionRules);
    if (undefinedVars.length > 0) {
      errors.push({
        code: 'UNDEFINED_SELECTION_RULES_VARIABLES',
        message: `Expression references undefined variables: ${undefinedVars.join(', ')}. Available: contentType, contentSizeBytes, originalReference, sourceType, language, hasExtractedText, pageCount, metadata, classification`,
        path: `flows[${i}].selectionRules`,
        severity: 'error',
      });
    }
  }

  return errors;
}

/**
 * Extract variable references from a CEL expression.
 * Returns variables not in the allowed context.
 */
function extractUndefinedVariables(expression: string): string[] {
  const allowedVars = new Set([
    'contentType',
    'contentSizeBytes',
    'originalReference',
    'sourceType',
    'language',
    'hasExtractedText',
    'pageCount',
    'metadata',
    'classification',
  ]);

  const env = getCelEnvironment();
  const ast = env.parse(expression);

  // Walk AST to find identifiers
  const vars = new Set<string>();
  function walk(node: any) {
    if (node.type === 'IDENT') {
      vars.add(node.value);
    }
    if (node.args) {
      for (const arg of node.args) {
        walk(arg);
      }
    }
    if (node.operand) walk(node.operand);
    if (node.left) walk(node.left);
    if (node.right) walk(node.right);
  }
  walk(ast.expr);

  const undefined: string[] = [];
  for (const v of vars) {
    if (!allowedVars.has(v)) {
      undefined.push(v);
    }
  }

  return undefined;
}
```

### Runtime Validation

During flow selection:

```typescript
function selectFlowSafe(document: ISearchDocument, flows: PipelineFlow[]): PipelineFlow {
  const sortedFlows = flows.sort((a, b) => a.priority - b.priority);

  for (const flow of sortedFlows) {
    if (!flow.selectionRules) {
      return flow;
    }

    try {
      const context = buildDocumentContext(document);

      // Timeout protection (max 100ms per expression)
      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Evaluation timeout')), 100),
      );

      const evalPromise = Promise.resolve(evaluateCelCondition(flow.selectionRules, context));

      const matches = await Promise.race([evalPromise, timeoutPromise]);

      if (matches) {
        return flow;
      }
    } catch (error) {
      log.warn('Flow selection rule evaluation failed', {
        flowId: flow.id,
        documentId: document._id,
        error: error.message,
      });
      continue; // Skip this flow, try next
    }
  }

  throw new Error(`No flow matched document ${document._id}. Check pipeline flow selection rules.`);
}
```

---

## 6. Priority Handling

### Priority Rules

- **Priority is an integer** (1, 2, 3, ..., 100)
- **Lower number = higher priority** (1 = highest, 100 = lowest)
- **Flows are evaluated in priority order** (ascending)
- **First match wins** (stop evaluation after first matching flow)
- **Duplicate priorities allowed** (but should be avoided for clarity)

### Example Priority Ordering

```typescript
const flows = [
  {
    id: 'f1',
    name: 'Large PDFs',
    priority: 1,
    selectionRules: "contentType == 'application/pdf' && contentSizeBytes > 10485760",
  },
  {
    id: 'f2',
    name: 'Small PDFs',
    priority: 2,
    selectionRules: "contentType == 'application/pdf' && contentSizeBytes <= 10485760",
  },
  {
    id: 'f3',
    name: 'Office Docs',
    priority: 3,
    selectionRules: "contentType.startsWith('application/vnd.openxmlformats')",
  },
  { id: 'f4', name: 'All Others', priority: 99, selectionRules: null }, // Default catch-all
];

// Document: large PDF → matches f1 (priority 1) → stop
// Document: small PDF → skips f1, matches f2 (priority 2) → stop
// Document: Word doc → skips f1, f2, matches f3 (priority 3) → stop
// Document: image → skips f1, f2, f3, matches f4 (priority 99) → stop
```

### Best Practices

1. **Use priority 1-10 for common cases** (PDFs, Office docs, HTML)
2. **Use priority 11-50 for specific cases** (large files, legal docs, specific sources)
3. **Use priority 99 for default catch-all** (no selection rules)
4. **Avoid gaps in priority sequence** (1, 2, 3, not 1, 10, 20) for maintainability
5. **Document priority rationale** in flow name or description

---

## 7. Performance Considerations

### Evaluation Cost

- **CEL evaluation is fast** (~1-10ms per expression)
- **Priority ordering minimizes evaluations** (stop at first match)
- **No external API calls** (all context is in-memory)
- **BigInt normalization overhead is negligible** (<1ms)

### Optimization Strategies

1. **Order flows by match frequency** (most common → priority 1)
   - If 80% of documents are PDFs, put PDF flow first
2. **Use simple expressions for high-priority flows** (single condition, not complex AND/OR chains)
3. **Avoid expensive operations in selection rules**:
   - ❌ `abl.repeat(originalReference, 1000)` (unbounded string repeat)
   - ❌ Complex regex (CEL doesn't support regex, but avoid simulated patterns)
   - ✅ `contentType == 'application/pdf'` (simple equality)
   - ✅ `contentSizeBytes > 1048576` (simple comparison)
4. **Cache document context** (build once, reuse for all flow evaluations)
5. **Limit expression length** (max 4096 bytes enforced)

### Scalability

- **10,000 documents/day** with 5 flows: ~50ms total selection time (negligible)
- **100,000 documents/day** with 10 flows: ~500ms total selection time (0.005ms per doc)
- **1,000,000 documents/day** with 20 flows: ~5s total selection time (0.000005ms per doc)

**Conclusion:** Flow selection is **not a bottleneck** even at high scale.

---

## 8. Error Handling

### Error Types

| Error Type             | Cause                                 | Handling                                                 |
| ---------------------- | ------------------------------------- | -------------------------------------------------------- |
| **Syntax Error**       | Invalid CEL expression                | Return validation error on save, block pipeline creation |
| **Undefined Variable** | Expression references unknown field   | Return validation error on save, block pipeline creation |
| **Type Error**         | Expression expects string, got number | Log warning, skip flow (fail-safe)                       |
| **Evaluation Timeout** | Expression takes >100ms to evaluate   | Log warning, skip flow (fail-safe)                       |
| **No Match**           | No flow matched document              | Throw error, fail document ingestion                     |

### Fail-Safe Behavior

```typescript
// If a flow's selection rule fails to evaluate, skip that flow (don't fail the entire pipeline)
try {
  const matches = evaluateCelCondition(flow.selectionRules, context);
  if (matches) return flow;
} catch (error) {
  log.warn('Flow selection rule evaluation failed', { flowId: flow.id, error: error.message });
  continue; // Try next flow
}
```

**Rationale:** A single malformed expression shouldn't block document ingestion. Evaluation errors are logged for debugging, but the pipeline continues with other flows.

---

## 9. Testing Strategy

### Unit Tests

Test each validation and evaluation function:

```typescript
describe('Flow Selection Rules', () => {
  it('should match PDF documents', () => {
    const context = { contentType: 'application/pdf', ... };
    const matches = evaluateCelCondition("contentType == 'application/pdf'", context);
    expect(matches).toBe(true);
  });

  it('should match large files', () => {
    const context = { contentSizeBytes: 20 * 1024 * 1024, ... };
    const matches = evaluateCelCondition('contentSizeBytes > 10485760', context);
    expect(matches).toBe(true);
  });

  it('should handle undefined variables gracefully', () => {
    const context = { contentType: 'application/pdf', ... };
    expect(() => {
      evaluateCelCondition('unknownField == "value"', context);
    }).toThrow();
  });

  it('should validate expression syntax', async () => {
    const errors = await validateFlowSelectionRules([
      { id: 'f1', name: 'Test', priority: 1, selectionRules: 'contentType ==' }, // Invalid syntax
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_SELECTION_RULES_SYNTAX');
  });

  it('should detect undefined variables', async () => {
    const errors = await validateFlowSelectionRules([
      { id: 'f1', name: 'Test', priority: 1, selectionRules: 'unknownField == "value"' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('UNDEFINED_SELECTION_RULES_VARIABLES');
  });
});
```

### Integration Tests

Test flow selection with real document context:

```typescript
describe('Flow Selection Integration', () => {
  it('should select flow by priority order', () => {
    const flows = [
      { id: 'f1', priority: 2, selectionRules: "contentType == 'application/pdf'" },
      { id: 'f2', priority: 1, selectionRules: 'contentSizeBytes > 1048576' },
    ];
    const document = { contentType: 'application/pdf', contentSizeBytes: 2 * 1024 * 1024, ... };

    const selected = selectFlow(document, flows);
    expect(selected.id).toBe('f2'); // Priority 1 wins
  });

  it('should fall back to default flow', () => {
    const flows = [
      { id: 'f1', priority: 1, selectionRules: "contentType == 'text/html'" },
      { id: 'f2', priority: 99, selectionRules: null }, // Default
    ];
    const document = { contentType: 'application/pdf', ... };

    const selected = selectFlow(document, flows);
    expect(selected.id).toBe('f2'); // Default flow
  });

  it('should throw if no flow matches', () => {
    const flows = [
      { id: 'f1', priority: 1, selectionRules: "contentType == 'text/html'" },
    ];
    const document = { contentType: 'application/pdf', ... };

    expect(() => selectFlow(document, flows)).toThrow('No flow matched document');
  });
});
```

---

## 10. Recommendations

### For Pipeline Authors

1. **Always include a default flow** (priority 99, no selection rules) as a catch-all
2. **Test expressions with sample data** before saving pipeline
3. **Use simple expressions** for high-priority flows (performance)
4. **Document priority rationale** (why is this flow priority 1 vs 5?)
5. **Avoid overlapping conditions** (if two flows match, only first executes)

### For Platform Developers

1. **Reuse existing CEL infrastructure** (`evaluateCelCondition` from `@abl/compiler`)
2. **Validate expressions pre-save** (syntax + undefined variables)
3. **Use fail-safe evaluation** (skip flow on error, log warning)
4. **Implement timeout protection** (max 100ms per expression)
5. **Cache document context** (build once, reuse for all flows)
6. **Expose `abl` namespace functions** in UI documentation (users need to know what's available)

---

## 11. UI Considerations

### Expression Builder (No-Code)

Provide a visual builder for common patterns:

```
[Field: contentType] [Operator: equals] [Value: application/pdf]

  AND/OR

[Field: contentSizeBytes] [Operator: greater than] [Value: 10485760]
```

**Generated CEL:**

```cel
contentType == 'application/pdf' && contentSizeBytes > 10485760
```

### Expression Editor (Code)

Provide a code editor with:

- **Syntax highlighting** (CEL)
- **Autocomplete** (context fields, `abl` functions)
- **Real-time validation** (syntax check as user types)
- **Sample test** (evaluate expression against sample document)

### Validation Feedback

Show validation errors inline:

```
❌ Invalid syntax: "contentType ==" (expected value after ==)
❌ Undefined variable: "unknownField" (available: contentType, contentSizeBytes, ...)
⚠️ Expression evaluation failed on sample context (might work with real documents)
✅ Valid expression
```

---

## Conclusion

**Key Decisions:**

1. ✅ Use **CEL (Common Expression Language)** for flow selection rules
2. ✅ **Reuse existing CEL infrastructure** (`@abl/compiler` with 37 custom functions)
3. ✅ **Document context**: contentType, contentSizeBytes, originalReference, sourceType, language, hasExtractedText, pageCount, metadata, classification
4. ✅ **Priority-based evaluation**: Lower number = higher priority, first match wins
5. ✅ **Fail-safe behavior**: Invalid expressions skip flow, log warning (don't block pipeline)
6. ✅ **Pre-save validation**: Syntax, undefined variables, sample evaluation
7. ✅ **Runtime validation**: Timeout protection (max 100ms per expression)
8. ✅ **Default flow**: Always include catch-all flow with no selection rules (priority 99)

**Next:** Proceed to design implementation with this CEL evaluation strategy.

---

**Research complete.** Ready for design phase.
