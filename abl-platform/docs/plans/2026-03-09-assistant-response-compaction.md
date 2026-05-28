# Prior-Turn Assistant Response Compaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compact prior-turn assistant responses that follow tool results, so the LLM re-invokes tools on refinement queries instead of answering from stale cached text.

**Architecture:** Extend `truncatePriorTurnToolResults` with a second pass that finds assistant messages following truncated tool_result blocks and replaces their content with a compact summary (first 200 chars + generic suffix). No new files — just ~15 lines added to the existing function + updated tests.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Update `truncatePriorTurnToolResults` to compact assistant responses

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:167-208`

**Step 1: Write the failing test**

Add to `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`:

```typescript
it('compacts assistant responses that follow truncated tool results', () => {
  const longResponse =
    'Here are the top sneakers I found for you: ' +
    '1. Nike Air Max 90 - AED 500, available in red and black. ' +
    '2. Adidas Ultraboost - AED 650, available in white. ' +
    '3. Puma RS-X - AED 400, available in blue and grey. ' +
    'All of these are currently in stock at your nearest store. ' +
    'Would you like me to check sizes for any of these?';

  const messages: Array<{ role: string; content: unknown }> = [
    // Turn 1
    { role: 'user', content: 'Show me red sneakers' },
    assistantToolCallMsg(),
    toolResultMsg('{"products": [{"title": "Sneaker 1", "price": "500"}]}'),
    { role: 'assistant', content: longResponse },
    // Turn 2 (current)
    { role: 'user', content: 'What about Nike ones?' },
  ];

  truncatePriorTurnToolResults(messages);

  // Tool result truncated
  expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
  // Assistant response compacted
  const compacted = messages[3].content as string;
  expect(compacted).toContain(longResponse.slice(0, 200));
  expect(compacted).toContain('re-invoke tools if the user changes or refines their request');
  expect(compacted.length).toBeLessThan(longResponse.length);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`
Expected: FAIL — assistant response is not compacted yet

**Step 3: Implement the compaction logic**

Add after the existing tool_result truncation loop (after line 207, before the closing `}`), in `truncatePriorTurnToolResults`:

```typescript
// Second pass: compact assistant messages that follow truncated tool_result blocks
const COMPACT_PREFIX_CHARS = 200;
for (let i = 0; i < lastPlainUserIdx; i++) {
  const msg = messages[i];
  if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;

  // Check if the previous message was a truncated tool_result
  if (i === 0) continue;
  const prev = messages[i - 1];
  if (prev.role !== 'user' || !Array.isArray(prev.content)) continue;
  const prevBlocks = prev.content as Array<{ type: string; content?: string }>;
  const wasTruncated = prevBlocks.some(
    (b) => b.type === 'tool_result' && b.content === '[Prior turn result — summarized]',
  );
  if (!wasTruncated) continue;

  const text = msg.content;
  if (text.length > COMPACT_PREFIX_CHARS) {
    msg.content = `[Prior response: "${text.slice(0, COMPACT_PREFIX_CHARS)}..." — full details omitted, re-invoke tools if the user changes or refines their request]`;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`
Expected: PASS — all 5 tests pass (4 existing + 1 new)

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
git commit -m "[ABLP-2] feat(runtime): compact prior-turn assistant responses to force fresh tool calls"
```

---

### Task 2: Add edge case tests

**Files:**

- Modify: `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`

**Step 1: Add test for short assistant responses (should NOT be compacted)**

```typescript
it('leaves short assistant responses unchanged even in prior turns', () => {
  const shortResponse = 'Here are some sneakers.';

  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'Show me sneakers' },
    assistantToolCallMsg(),
    toolResultMsg('{"products": []}'),
    { role: 'assistant', content: shortResponse },
    { role: 'user', content: 'Show me Nike ones' },
  ];

  truncatePriorTurnToolResults(messages);

  // Short response stays unchanged (under 200 chars)
  expect(messages[3].content).toBe(shortResponse);
});
```

**Step 2: Add test for assistant ContentBlock[] responses (tool_use, not plain text)**

```typescript
it('does not compact assistant messages with ContentBlock arrays (tool_use)', () => {
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'Show me sneakers' },
    assistantToolCallMsg(),
    toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
    // Assistant responds with another tool call (ContentBlock[]), not plain text
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_2', name: 'offer_search', input: {} }],
    },
    toolResultMsg('{"offers": []}', 'call_2'),
    { role: 'assistant', content: 'Here are offers and sneakers.' },
    { role: 'user', content: 'Tell me more' },
  ];

  truncatePriorTurnToolResults(messages);

  // The tool_use assistant message should be untouched (it's an array, not string)
  expect(Array.isArray(messages[3].content)).toBe(true);
});
```

**Step 3: Add test for multiple prior turns with compaction**

```typescript
it('compacts assistant responses across multiple prior turns', () => {
  const longResponse1 = 'A '.repeat(200);
  const longResponse2 = 'B '.repeat(200);

  const messages: Array<{ role: string; content: unknown }> = [
    // Turn 1
    { role: 'user', content: 'Show me sneakers' },
    assistantToolCallMsg(),
    toolResultMsg('{"products": [...]}', 'call_t1'),
    { role: 'assistant', content: longResponse1 },
    // Turn 2
    { role: 'user', content: 'Now show me offers' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_t2', name: 'offer_search', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_t2', content: '{"offers": [...]}' }],
    },
    { role: 'assistant', content: longResponse2 },
    // Turn 3 (current)
    { role: 'user', content: 'Tell me more about offer 1' },
  ];

  truncatePriorTurnToolResults(messages);

  // Both assistant responses compacted
  expect(messages[3].content as string).toContain('Prior response:');
  expect(messages[7].content as string).toContain('Prior response:');
  // Current turn user message untouched
  expect(messages[8].content).toBe('Tell me more about offer 1');
});
```

**Step 4: Run all tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`
Expected: PASS — all 8 tests pass

**Step 5: Commit**

```bash
git add apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
git commit -m "[ABLP-2] test(runtime): add edge case tests for assistant response compaction"
```

---

### Task 3: Run E2E to verify Multi-turn Turn 3 improvement

**Files:**

- Read: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/`

**Step 1: Run the AFG E2E test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`

**Step 2: Check Multi-turn Turn 3 results**

Verify that Turn 3 ("Do you have any in blue?") now triggers a fresh `product_search` tool call instead of answering from cached text.

**Step 3: Commit any test adjustments if needed**

Only if E2E assertions need updating to reflect the improved behavior.
