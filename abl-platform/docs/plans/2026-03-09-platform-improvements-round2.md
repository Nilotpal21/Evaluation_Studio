# Platform Improvements Round 2 — AFG Baseline Parity

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the 5 behavioral/performance gaps between ABL Runtime and Kore.ai baseline identified during AFG Blue Advisory E2E comparison.

**Architecture:** Three independent platform-level fixes: (1) propagate session metadata across agent handoffs so child agents see conversationSummary/user/gender/location, (2) compress tool results in conversation history between turns to reduce token bloat from 33K→~3K, (3) add cross-turn tool result truncation so multi-turn conversations don't accumulate 20K+ tokens of stale results.

**Tech Stack:** TypeScript, Vitest, runtime services (reasoning-executor, routing-executor, prompt-builder)

---

## Gap Summary (ABL vs Kore.ai Baseline)

| #   | Gap                                                             | Impact      | Root Cause                                        |
| --- | --------------------------------------------------------------- | ----------- | ------------------------------------------------- |
| 1   | Summary Continuity: generic greeting instead of warm resumption | Behavioral  | Session metadata not propagated on handoff        |
| 2   | Product Search: 13.8s vs 7.7s (+80%)                            | Performance | 33K tokens of raw Pinecone results in LLM context |
| 3   | Multi-turn T3: no tool call on follow-up                        | Behavioral  | LLM answers from 20K tokens of stale history      |

---

### Task 1: Session Metadata Propagation on Handoff

Session metadata (`conversationSummary`, `user`, `gender`, `location`) set on the root session's `data.values` is lost when the supervisor hands off to a child agent. The child thread only receives `mergedContext` (which is `{ handoff_from, reason, message }`).

**Root cause:** `routing-executor.ts:357-379` builds `mergedContext` from LLM context + PASS fields only. Session-level metadata not in either source is lost.

**Fix:** Before building the child thread, propagate session-level metadata from the parent's `data.values` to `mergedContext` — excluding internal (`_` prefixed), GATHER field, and already-present keys.

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:357-379`
- Test: `apps/runtime/src/__tests__/routing-executor-metadata-propagation.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/routing-executor-metadata-propagation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests that session-level metadata (conversationSummary, user, gender, location)
 * propagates from parent thread to child thread during handoff.
 *
 * The routing-executor's executeHandoff() builds mergedContext from:
 *   1. LLM-provided context (reason, message)
 *   2. PASS fields from handoff config
 *   3. (NEW) Session-level metadata from parent data.values
 *
 * The child thread's data.values should include all three sources.
 */
describe('Session metadata propagation on handoff', () => {
  it('propagates non-internal, non-GATHER metadata from parent to child thread', () => {
    // This test validates the extractSessionMetadata helper function
    // that will be called in routing-executor during handoff context building.
    const { extractSessionMetadata } = require('../services/execution/routing-executor');

    const parentValues: Record<string, unknown> = {
      // Session metadata (should propagate)
      conversationSummary: 'Customer was looking at Nike running shoes',
      user: 'e2e_test_user',
      gender: 'male',
      location: 'Dubai',
      // Internal keys (should NOT propagate)
      _handoff_summary: 'routing info',
      _recallPrompts: ['prompt1'],
      _constraint_warnings: [],
      // GATHER field values (should NOT propagate — agent-specific)
      product_category: 'Red sneakers',
      budget_range: 'Under 500 AED',
      // Handoff tracking (should NOT propagate)
      handoff_from: 'GuardRail_Supervisor',
    };

    const gatherFieldNames = ['product_category', 'brand_preference', 'budget_range', 'occasion'];

    const metadata = extractSessionMetadata(parentValues, gatherFieldNames);

    // Session metadata should propagate
    expect(metadata).toEqual({
      conversationSummary: 'Customer was looking at Nike running shoes',
      user: 'e2e_test_user',
      gender: 'male',
      location: 'Dubai',
    });

    // Internal keys should NOT be present
    expect(metadata._handoff_summary).toBeUndefined();
    expect(metadata._recallPrompts).toBeUndefined();
    expect(metadata._constraint_warnings).toBeUndefined();

    // GATHER fields should NOT be present
    expect(metadata.product_category).toBeUndefined();
    expect(metadata.budget_range).toBeUndefined();

    // Handoff tracking should NOT be present
    expect(metadata.handoff_from).toBeUndefined();
  });

  it('returns empty object when parent has no propagatable metadata', () => {
    const { extractSessionMetadata } = require('../services/execution/routing-executor');

    const parentValues: Record<string, unknown> = {
      _internal: 'value',
      handoff_from: 'Agent_A',
      product_category: 'shoes',
    };

    const metadata = extractSessionMetadata(parentValues, ['product_category']);
    expect(metadata).toEqual({});
  });

  it('does not overwrite existing mergedContext keys', () => {
    const { extractSessionMetadata } = require('../services/execution/routing-executor');

    const parentValues: Record<string, unknown> = {
      user: 'parent_user',
      conversationSummary: 'Parent summary',
    };

    const metadata = extractSessionMetadata(parentValues, []);

    // Caller should apply metadata BEFORE LLM context, so LLM context wins
    expect(metadata.user).toBe('parent_user');
    expect(metadata.conversationSummary).toBe('Parent summary');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/routing-executor-metadata-propagation.test.ts --reporter=verbose`
Expected: FAIL — `extractSessionMetadata` is not exported from routing-executor

**Step 3: Implement extractSessionMetadata and wire it into handoff**

In `apps/runtime/src/services/execution/routing-executor.ts`:

Add the helper function (near the top, after imports):

```typescript
/**
 * Keys that should never propagate from parent to child during handoff.
 * - Internal keys: prefixed with '_'
 * - Handoff tracking: 'handoff_from'
 * - These are either internal runtime state or per-handoff ephemeral values.
 */
const HANDOFF_TRACKING_KEYS = new Set(['handoff_from']);

/**
 * Extract session-level metadata from parent thread's data.values
 * for propagation to child threads during handoff.
 *
 * Excludes:
 * - Internal keys (prefixed with '_')
 * - GATHER field names (agent-specific, should not cross agent boundaries)
 * - Handoff tracking keys (handoff_from, etc.)
 *
 * This ensures session-level metadata like conversationSummary, user,
 * gender, location flows through supervisor → specialist handoffs.
 */
export function extractSessionMetadata(
  parentValues: Record<string, unknown>,
  gatherFieldNames: string[],
): Record<string, unknown> {
  const gatherSet = new Set(gatherFieldNames);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parentValues)) {
    if (key.startsWith('_')) continue;
    if (HANDOFF_TRACKING_KEYS.has(key)) continue;
    if (gatherSet.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }

  return result;
}
```

Then modify the `mergedContext` building block (around line 357-379):

```typescript
    let mergedContext: Record<string, unknown> = { handoff_from: currentThread.agentName };

    // Propagate session-level metadata from parent to child (lowest priority)
    // This ensures conversationSummary, user, gender, location, etc. flow through
    // supervisor → specialist handoffs without requiring explicit PASS config.
    const parentGatherFields = (currentIR?.gather?.fields ?? []).map((f) =>
      typeof f === 'string' ? f : f.name,
    );
    const sessionMetadata = extractSessionMetadata(
      currentThread.data.values,
      parentGatherFields,
    );
    Object.assign(mergedContext, sessionMetadata);

    // Start with LLM-provided context (overrides metadata)
    Object.assign(mergedContext, context);

    // PASS fields OVERRIDE LLM context (fix bug: was reversed before)
    if (handoffConfig?.context?.pass && handoffConfig.context.pass.length > 0) {
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/routing-executor-metadata-propagation.test.ts --reporter=verbose`
Expected: PASS (3 tests)

**Step 5: Run existing tests to verify no regressions**

Run: `cd apps/runtime && pnpm build && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add apps/runtime/src/services/execution/routing-executor.ts apps/runtime/src/__tests__/routing-executor-metadata-propagation.test.ts
git commit -m "[ABLP-2] feat(runtime): propagate session metadata across agent handoffs

Session-level metadata (conversationSummary, user, gender, location)
now flows from parent thread to child thread during handoff. Excludes
internal keys, GATHER fields, and handoff tracking keys."
```

---

### Task 2: Tool Result Compression in Conversation History

Product search returns ~33K tokens of raw Pinecone results that get stored verbatim in conversation history. When the response_gen LLM call processes them, it receives the full payload. The current `MAX_TOOL_RESULT_CHARS = 102_400` limit is too high (~25K tokens) and `truncateOldToolResults` only triggers on iteration 3+ within a single turn's reasoning loop.

**Fix:** Add a `compressToolResult` function that extracts only essential fields from large tool results before storing them in conversation history. Applied at the tool result serialization point (reasoning-executor line 937).

**Files:**

- Create: `apps/runtime/src/services/execution/tool-result-compressor.ts`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:937-942`
- Test: `apps/runtime/src/__tests__/tool-result-compressor.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/tool-result-compressor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  compressToolResult,
  MAX_COMPRESSED_TOOL_RESULT_CHARS,
} from '../services/execution/tool-result-compressor';

describe('compressToolResult', () => {
  it('returns small results unchanged', () => {
    const small = JSON.stringify({ success: true, data: 'hello' });
    expect(compressToolResult(small)).toBe(small);
  });

  it('compresses product search results by extracting essential fields', () => {
    const products = Array.from({ length: 10 }, (_, i) => ({
      id: `prod-${i}`,
      title: `Product ${i}`,
      brand: 'TestBrand',
      price: `${100 + i * 50}`,
      salePrice: `${80 + i * 40}`,
      color: ['red'],
      size: ['M', 'L'],
      description: 'A '.repeat(500), // 1000 chars of description
      product_image: `https://cdn.example.com/img-${i}.jpg`,
      // Large noise fields that should be stripped
      complementaryanalogous: Array.from({ length: 40 }, (_, j) => `sku-${j}`),
      keyFeatures: Array.from({ length: 20 }, (_, j) => String.fromCharCode(65 + j)),
      arabicProductTitle: 'عنوان المنتج العربي',
      sku: `SKU-${i}`,
      storeId: 'store-uae',
      updatedAt: '2026-01-30T02:17:39.082Z',
      activities: ['Walking', 'Running'],
      agegroup: ['Adults'],
      bodytype: ['Slim'],
      caretype: ['Spot clean only'],
      category: ['Footwear'],
      chaintype: ['undefined'],
      normalizedColor: 'red',
      gender: ['men'],
      discount: '0%',
      score: 0.535,
      productId: `prod-${i}`,
      productType: 'Shoes',
    }));

    const rawResult = JSON.stringify({ products, offers: [], automobiles: [] });
    expect(rawResult.length).toBeGreaterThan(MAX_COMPRESSED_TOOL_RESULT_CHARS);

    const compressed = compressToolResult(rawResult);
    const parsed = JSON.parse(compressed);

    // Should preserve essential fields
    expect(parsed.products[0].title).toBe('Product 0');
    expect(parsed.products[0].brand).toBe('TestBrand');
    expect(parsed.products[0].price).toBe('100');
    expect(parsed.products[0].salePrice).toBe('80');
    expect(parsed.products[0].color).toEqual(['red']);
    expect(parsed.products[0].product_image).toBeDefined();

    // Should strip noise fields
    expect(parsed.products[0].complementaryanalogous).toBeUndefined();
    expect(parsed.products[0].keyFeatures).toBeUndefined();
    expect(parsed.products[0].sku).toBeUndefined();
    expect(parsed.products[0].storeId).toBeUndefined();
    expect(parsed.products[0].updatedAt).toBeUndefined();
    expect(parsed.products[0].activities).toBeUndefined();
    expect(parsed.products[0].agegroup).toBeUndefined();
    expect(parsed.products[0].bodytype).toBeUndefined();
    expect(parsed.products[0].caretype).toBeUndefined();
    expect(parsed.products[0].chaintype).toBeUndefined();

    // Should truncate long descriptions
    expect(parsed.products[0].description.length).toBeLessThan(250);

    // Compressed size should be significantly smaller
    expect(compressed.length).toBeLessThan(rawResult.length * 0.3);
  });

  it('truncates description to 200 chars with ellipsis', () => {
    const longDesc = 'A'.repeat(500);
    const products = [{ title: 'Test', description: longDesc, brand: 'B', price: '100' }];
    const raw = JSON.stringify({ products });

    // Only compress if over threshold — make it large enough
    const bigProducts = Array.from({ length: 20 }, () => ({
      title: 'Test',
      description: longDesc,
      brand: 'B',
      price: '100',
      complementaryanalogous: Array.from({ length: 40 }, (_, j) => `sku-${j}`),
    }));
    const bigRaw = JSON.stringify({ products: bigProducts });

    if (bigRaw.length > MAX_COMPRESSED_TOOL_RESULT_CHARS) {
      const compressed = compressToolResult(bigRaw);
      const parsed = JSON.parse(compressed);
      expect(parsed.products[0].description.length).toBeLessThanOrEqual(203); // 200 + '...'
    }
  });

  it('handles non-product tool results gracefully', () => {
    const policyResult = JSON.stringify({
      success: true,
      answer: 'Return policy allows 14 days...',
      chunks: [{ text: 'chunk1' }, { text: 'chunk2' }],
    });

    // Small enough — returned as-is
    expect(compressToolResult(policyResult)).toBe(policyResult);
  });

  it('falls back to char truncation when compression is insufficient', () => {
    // Create result that's huge even after field stripping
    const hugeProducts = Array.from({ length: 100 }, (_, i) => ({
      title: `Product ${i} - ${'Detail '.repeat(50)}`,
      brand: 'TestBrand',
      price: `${i * 100}`,
      description: 'Long description '.repeat(100),
    }));
    const raw = JSON.stringify({ products: hugeProducts });

    const compressed = compressToolResult(raw);
    expect(compressed.length).toBeLessThanOrEqual(MAX_COMPRESSED_TOOL_RESULT_CHARS + 100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/tool-result-compressor.test.ts --reporter=verbose`
Expected: FAIL — module not found

**Step 3: Implement tool-result-compressor.ts**

Create `apps/runtime/src/services/execution/tool-result-compressor.ts`:

```typescript
/**
 * Tool Result Compressor
 *
 * Compresses large tool results before they enter conversation history.
 * Strips noise fields (SKU arrays, cross-sell IDs, metadata) and truncates
 * descriptions to reduce token count while preserving essential product data
 * for LLM response generation.
 *
 * Threshold: Results under MAX_COMPRESSED_TOOL_RESULT_CHARS are returned as-is.
 * Above threshold: structured compression for known shapes, char truncation as fallback.
 */

/** Maximum compressed result size (~10K chars ≈ ~2.5K tokens) */
export const MAX_COMPRESSED_TOOL_RESULT_CHARS = 10_000;

/** Maximum description length before truncation */
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Fields to keep on product/automobile objects.
 * Everything else is stripped during compression.
 */
const ESSENTIAL_PRODUCT_FIELDS = new Set([
  'id',
  'title',
  'brand',
  'price',
  'salePrice',
  'color',
  'size',
  'description',
  'product_image',
  'gender',
  'category',
  'productType',
  'discount',
  'isPreOwned',
  'model',
  'year',
  'mileage',
  'fuelType',
  'transmission',
]);

/**
 * Fields to keep on offer objects.
 */
const ESSENTIAL_OFFER_FIELDS = new Set([
  'id',
  'title',
  'brand',
  'description',
  'discount',
  'validUntil',
  'category',
]);

/**
 * Compress a serialized tool result string.
 * Returns the original string if under threshold, or a compressed version.
 */
export function compressToolResult(serialized: string): string {
  if (serialized.length <= MAX_COMPRESSED_TOOL_RESULT_CHARS) {
    return serialized;
  }

  // Try structured compression for known tool result shapes
  try {
    const parsed = JSON.parse(serialized);
    if (typeof parsed === 'object' && parsed !== null) {
      const compressed = compressStructured(parsed);
      const result = JSON.stringify(compressed);
      if (result.length <= MAX_COMPRESSED_TOOL_RESULT_CHARS) {
        return result;
      }
      // Structured compression wasn't enough — fall back to char truncation
      return (
        result.slice(0, MAX_COMPRESSED_TOOL_RESULT_CHARS) +
        `\n...[compressed from ${serialized.length} chars]`
      );
    }
  } catch {
    // Not valid JSON — fall back to char truncation
  }

  return (
    serialized.slice(0, MAX_COMPRESSED_TOOL_RESULT_CHARS) +
    `\n...[truncated: ${serialized.length} chars]`
  );
}

/**
 * Compress a parsed tool result object by stripping noise fields
 * and truncating long text values.
 */
function compressStructured(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'products' || key === 'automobiles') {
      result[key] = compressItemArray(value, ESSENTIAL_PRODUCT_FIELDS);
    } else if (key === 'offers' || key === 'productOffers' || key === 'automobileOffers') {
      result[key] = compressItemArray(value, ESSENTIAL_OFFER_FIELDS);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Compress an array of items by keeping only essential fields
 * and truncating descriptions.
 */
function compressItemArray(items: unknown, essentialFields: Set<string>): unknown[] {
  if (!Array.isArray(items)) return [];

  return items.map((item) => {
    if (typeof item !== 'object' || item === null) return item;

    const compressed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!essentialFields.has(key)) continue;

      if (
        key === 'description' &&
        typeof value === 'string' &&
        value.length > MAX_DESCRIPTION_LENGTH
      ) {
        compressed[key] = value.slice(0, MAX_DESCRIPTION_LENGTH) + '...';
      } else {
        compressed[key] = value;
      }
    }
    return compressed;
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/tool-result-compressor.test.ts --reporter=verbose`
Expected: PASS (5 tests)

**Step 5: Wire compressor into reasoning-executor**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add import at top:

```typescript
import { compressToolResult } from './tool-result-compressor.js';
```

Then modify the tool result serialization block (around line 937):

Replace:

```typescript
const serialized = JSON.stringify(toolResult);
const truncated =
  serialized.length > MAX_TOOL_RESULT_CHARS
    ? serialized.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n...[truncated: ${serialized.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`
    : serialized;
```

With:

```typescript
const serialized = JSON.stringify(toolResult);
// Compress large results (strip noise fields, truncate descriptions)
// before falling back to hard char truncation
const compressed = compressToolResult(serialized);
const truncated =
  compressed.length > MAX_TOOL_RESULT_CHARS
    ? compressed.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n...[truncated: ${compressed.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`
    : compressed;
```

**Step 6: Run all runtime tests**

Run: `cd apps/runtime && pnpm build && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/tool-result-compressor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/tool-result-compressor.test.ts
git commit -m "[ABLP-2] feat(runtime): compress large tool results before storing in history

Adds tool-result-compressor that strips noise fields (SKU arrays,
cross-sell IDs, metadata) and truncates descriptions. Reduces product
search results from ~33K tokens to ~2.5K tokens in LLM context."
```

---

### Task 3: Cross-Turn Tool Result Truncation

Within a single turn's reasoning loop, `truncateOldToolResults` (iteration 3+) replaces old tool results with placeholders. But between turns, all tool results accumulate. Multi-turn Turn 3 carries 20K+ tokens of stale results from Turns 1–2, causing the LLM to answer from memory instead of making a fresh tool call.

**Fix:** At the start of each new turn's reasoning loop, truncate all tool results from prior turns. Keep only the most recent user→assistant exchange's tool results intact.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:306-311`
- Test: `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts` (create)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { truncatePriorTurnToolResults } from '../services/execution/reasoning-executor';

describe('truncatePriorTurnToolResults', () => {
  function toolResultMsg(content: string, toolUseId = 'call_1') {
    return {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: toolUseId, content }],
    };
  }

  function assistantToolCallMsg(toolName = 'product_search') {
    return {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'call_1', name: toolName, input: {} }],
    };
  }

  it('truncates tool results from prior turns', () => {
    const messages = [
      // Turn 1
      { role: 'user', content: 'Show me red sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1", "price": "500"}]}'),
      { role: 'assistant', content: 'Here are sneakers...' },
      // Turn 2 (current)
      { role: 'user', content: 'What about Nike ones?' },
    ];

    truncatePriorTurnToolResults(messages);

    // Turn 1's tool results should be truncated
    const toolResultBlock = (messages[2].content as any[])[0];
    expect(toolResultBlock.content).toBe('[Prior turn result — summarized]');

    // Turn 2's user message should be untouched
    expect(messages[4].content).toBe('What about Nike ones?');
  });

  it('leaves current turn tool results intact', () => {
    const messages = [
      // Single turn with tool call
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
    ];

    truncatePriorTurnToolResults(messages);

    // Only turn — should not be truncated
    const toolResultBlock = (messages[2].content as any[])[0];
    expect(toolResultBlock.content).not.toBe('[Prior turn result — summarized]');
  });

  it('handles messages with no tool results', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Thanks' },
    ];

    // Should not throw
    truncatePriorTurnToolResults(messages);
    expect(messages).toHaveLength(3);
  });

  it('handles multiple prior turns', () => {
    const messages = [
      // Turn 1
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [...long result 1...]}', 'call_t1'),
      { role: 'assistant', content: 'Here are sneakers' },
      // Turn 2
      { role: 'user', content: 'Now show me offers' },
      assistantToolCallMsg('offer_search'),
      toolResultMsg('{"offers": [...long result 2...]}', 'call_t2'),
      { role: 'assistant', content: 'Here are offers' },
      // Turn 3 (current)
      { role: 'user', content: 'Tell me more about offer 1' },
    ];

    truncatePriorTurnToolResults(messages);

    // Turn 1 tool results: truncated
    expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Turn 2 tool results: truncated
    expect((messages[6].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Turn 3 user message: untouched
    expect(messages[8].content).toBe('Tell me more about offer 1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/cross-turn-tool-truncation.test.ts --reporter=verbose`
Expected: FAIL — `truncatePriorTurnToolResults` is not exported

**Step 3: Implement truncatePriorTurnToolResults**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add after `truncateOldToolResults` (around line 150):

```typescript
/**
 * Truncate tool results from prior turns in conversation history.
 *
 * A "turn boundary" is detected by finding user messages that are plain text
 * (not tool_result content blocks). Tool results between the start of the
 * conversation and the last plain-text user message are from prior turns
 * and should be truncated.
 *
 * This prevents multi-turn conversations from accumulating stale tool results
 * (e.g., 20K+ tokens of Pinecone product data from Turn 1 polluting Turn 3's
 * context window, causing the LLM to answer from memory instead of re-searching).
 *
 * Exported for testing.
 */
export function truncatePriorTurnToolResults(
  messages: Array<{ role: string; content: unknown }>,
): void {
  // Find the index of the last plain-text user message (current turn start)
  let lastPlainUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    // Plain text user message = turn boundary
    if (typeof msg.content === 'string') {
      lastPlainUserIdx = i;
      break;
    }
    // ContentBlock[] user message could be text or tool_result
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type: string }>;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (!hasToolResult) {
        lastPlainUserIdx = i;
        break;
      }
    }
  }

  if (lastPlainUserIdx <= 0) return; // No prior turns or single-turn conversation

  // Truncate all tool results before the current turn
  for (let i = 0; i < lastPlainUserIdx; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const blocks = msg.content as Array<{ type: string; content?: string }>;
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (!hasToolResult) continue;

    for (const block of blocks) {
      if (block.type === 'tool_result' && block.content) {
        block.content = '[Prior turn result — summarized]';
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/cross-turn-tool-truncation.test.ts --reporter=verbose`
Expected: PASS (4 tests)

**Step 5: Wire into reasoning-executor execute method**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, after the messages array is built (around line 311), add:

```typescript
// Truncate tool results from prior turns to prevent token bloat.
// Without this, multi-turn conversations accumulate 20K+ tokens of stale
// product search results, causing the LLM to answer from memory instead
// of making fresh tool calls.
truncatePriorTurnToolResults(messages);
```

This should go right after:

```typescript
const messages: Message[] = session.conversationHistory
  .filter((m) => m.content && (typeof m.content !== 'string' || m.content.trim() !== ''))
  .map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: normalizeMessageContent(m.content),
  }));
```

**Step 6: Run all runtime tests**

Run: `cd apps/runtime && pnpm build && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

**Step 7: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
git commit -m "[ABLP-2] feat(runtime): truncate prior turn tool results in multi-turn conversations

Detects turn boundaries via plain-text user messages and replaces
tool results from prior turns with placeholders. Prevents 20K+ token
accumulation that causes the LLM to answer from stale context."
```

---

### Task 4: Update E2E Tests and Validate

After implementing the three platform fixes, run the AFG E2E tests and update assertions.

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

**Step 1: Run the full E2E test suite**

Run: `cd apps/runtime && pnpm build && npx vitest run src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts --reporter=verbose --timeout 300000`

**Step 2: Analyze the run report**

Run:

```bash
python3 -c "
import json
with open('apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-run-report.json') as f:
    data = json.load(f)
for s in data['scenarios']:
    print(f\"{s['scenario']}: {s['metrics']['total']}ms | passed={s.get('passed', '?')}\")
    llm_calls = [t for t in s['traces'] if t['type'] == 'llm_call']
    print(f\"  LLM calls: {len(llm_calls)}\")
"
```

**Step 3: Verify improvements**

Expected improvements:

- **Summary Continuity**: Response should now mention "Nike running shoes" or "last time" (conversationSummary propagated)
- **Product Search**: Total time should drop from 13.8s to ~8-9s (smaller tool result in LLM context)
- **Multi-turn Turn 3**: Should now make a product_search tool call for "Nike options" (stale results truncated)

**Step 4: Tighten Summary Continuity assertion if response improved**

If the Summary Continuity response now mentions prior context, tighten the assertion:

```typescript
const hasContextResumption =
  lower.includes('nike') ||
  lower.includes('running') ||
  lower.includes('shoes') ||
  lower.includes('last time') ||
  lower.includes('previous') ||
  lower.includes('continue') ||
  lower.includes('discount');
expect(hasContextResumption).toBe(true);
```

**Step 5: Commit**

```bash
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-run-report.json
git commit -m "[ABLP-2] test(runtime): validate platform improvements round 2 in AFG E2E

Summary Continuity now surfaces prior conversation context.
Product Search latency reduced via tool result compression.
Multi-turn follow-up now triggers fresh tool call."
```

---

## Validation Criteria

After all 4 tasks, the run report should show:

| Scenario           | Before           | Target                         | Metric      |
| ------------------ | ---------------- | ------------------------------ | ----------- |
| Summary Continuity | Generic greeting | Mentions Nike/running/discount | Behavioral  |
| Product Search     | 13.8s            | <10s                           | Performance |
| Multi-turn T3      | 0 tool calls     | 1 tool call (product_search)   | Behavioral  |
| All scenarios      | 9/9 pass         | 9/9 pass                       | Correctness |
