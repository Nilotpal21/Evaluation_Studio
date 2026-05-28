# AFG Latency Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 7 latency improvements for the ABL runtime, reducing perceived TTFB from 3-11s to 1-2s and total latency by 20-40% across all AFG scenarios.

**Architecture:** Three tiers of changes: (1) Enable the existing pipeline classifier with the self-hosted Qwen model to bypass supervisor LLM calls, (2) Stream tokens through the reasoning executor and parallelize tool execution, (3) Add embedding caching and parallel fan-out for delegation. Each improvement is independent and can be tested in isolation via the existing AFG E2E test suite.

**Tech Stack:** TypeScript, Vitest, Vercel AI SDK (`streamText`), Redis (embedding cache), self-hosted Qwen3 30B via vLLM (`http://54.163.62.233:8000/v1/chat/completions`)

**Qwen Model:** `qwen3-a3b-30b-instruct` at `QWEN_URL=http://54.163.62.233:8000/v1/chat/completions`, auth via `QWEN_API_KEY` env var. Default pipeline model ID in config: `qwen3-30b`.

---

## Task Overview

| Task | Improvement                         | Tier   | Est. Savings          |
| ---- | ----------------------------------- | ------ | --------------------- |
| 1    | Enable pipeline classifier for AFG  | Tier 1 | ~1-2s/turn            |
| 2    | Stream tokens through executor      | Tier 1 | 2-5s perceived TTFB   |
| 3    | Parallelize multi-tool execution    | Tier 1 | 2-4s (multiple tools) |
| 4    | Cheaper model for supervisor        | Tier 2 | ~0.5-1s/turn          |
| 5    | Embedding cache (Redis)             | Tier 2 | ~500-1500ms on hit    |
| 6    | Parallel fan-out for delegation     | Tier 3 | 3-5s on delegation    |
| 7    | E2E validation & updated comparison | —      | Validation            |

---

### Task 1: Enable Pipeline Classifier for AFG Supervisor

The pipeline classifier system is fully built (`apps/runtime/src/services/pipeline/`) but disabled by default (`DEFAULT_PIPELINE_CONFIG.enabled = false`). It uses a cheap/fast LLM (Qwen 30B) to classify user intent and route directly to the target agent, bypassing the expensive GPT-4.1 supervisor reasoning call (~1-2s savings per turn).

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`
- Modify: `apps/runtime/src/services/pipeline/types.ts:34-50` (reference only — verify defaults)
- Test: `apps/runtime/src/__tests__/pipeline-classifier.test.ts` (existing — verify still passes)

**Context:** The AFG E2E test builds `AgentIR` objects inline for `GuardRail_Supervisor`, `Advisor_Agent`, and `Store_Policy_Agent`. The supervisor IR has an `execution` block. We need to add `pipeline: { enabled: true }` to it. The pipeline resolves its model via `session.llmClient.resolveLanguageModel('tool_selection')` which uses the 5-level model resolution chain — the default model `qwen3-30b` is already configured in `DEFAULT_PIPELINE_CONFIG`.

**Step 1: Read the AFG E2E test to find the supervisor IR definition**

Run: Read `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts` and search for the `GuardRail_Supervisor` agent IR construction — specifically the `execution` property. Note the line number.

**Step 2: Add pipeline config to the supervisor's execution block**

In the `GuardRail_Supervisor` agent IR within the E2E test, add the pipeline configuration to the `execution` object:

```typescript
execution: {
  // ... existing fields (mode, maxIterations, etc.) ...
  pipeline: {
    enabled: true,
    mode: 'parallel',
    model: 'qwen3-30b',
    shortCircuit: {
      enabled: true,
      confidenceThreshold: 0.85,
    },
    toolFilter: {
      enabled: true,
      maxTools: 6,
    },
    keywordVeto: {
      enabled: true,
      keywords: [],
    },
  },
},
```

**Step 3: Verify the IR schema supports pipeline in ExecutionConfig**

Read `packages/compiler/src/platform/ir/schema.ts` and confirm `ExecutionConfig` has a `pipeline` field. The `resolvePipelineConfig()` in `apps/runtime/src/services/pipeline/config.ts:16-58` reads from `agentExecution?.pipeline`.

**Step 4: Run existing pipeline tests to verify nothing is broken**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/pipeline-classifier.test.ts apps/runtime/src/__tests__/pipeline-tool-filter.test.ts apps/runtime/src/__tests__/pipeline-config.test.ts apps/runtime/src/__tests__/pipeline-circuit-breaker.test.ts`
Expected: All PASS

**Step 5: Run the AFG E2E test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`
Expected: All scenarios pass. Check trace output for `pipeline_classify` and `pipeline_short_circuit` events — these confirm the pipeline is active.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git commit -m "[ABLP-2] feat(runtime): enable pipeline classifier for AFG supervisor with Qwen model"
```

---

### Task 2: Stream Tokens Through Executor (Final-Response Streaming)

Currently, the reasoning executor buffers ALL LLM tokens via an `iterBuffer` wrapper (line 733-738 of `reasoning-executor.ts`) and flushes as a single chunk only after the full response completes. This means TTFB == Total for every scenario (users see "dead air" for 3-11s).

**The fix:** On iterations where the LLM produces NO tool calls (the final response), pass `onChunk` directly to `chatWithToolUseStreamable()` instead of `bufferChunk`. On tool-calling iterations, keep the existing buffering behavior (needed for system-tool text suppression).

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:729-760, 1132-1139`
- Test: `apps/runtime/src/__tests__/reasoning-executor-streaming.test.ts` (new)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/reasoning-executor-streaming.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

/**
 * Test that the reasoning executor streams tokens for final responses
 * instead of buffering them into a single chunk.
 *
 * We test the streaming behavior by mocking the LLM client to return
 * a text-only response (no tool calls) and verifying onChunk is called
 * with individual chunks, not one big blob.
 */
describe('reasoning executor streaming', () => {
  it('streams tokens directly for final responses (no tool calls)', async () => {
    // This test validates the core behavior change:
    // When the LLM returns a text-only response (no tool_use blocks),
    // tokens should be streamed through onChunk as they arrive,
    // NOT buffered in iterBuffer and flushed once.
    //
    // We verify this by checking that onChunk is called multiple times
    // (once per chunk from the LLM stream) rather than once with the
    // full concatenated response.

    const chunks: string[] = [];
    const onChunk = vi.fn((chunk: string) => chunks.push(chunk));

    // The actual integration test happens in the E2E suite.
    // This unit test verifies the streaming callback contract:
    // - Multiple calls to onChunk (not one big call)
    // - Each call contains a partial token, not the full response

    // Simulate what the executor should do on a no-tool-call iteration:
    // Pass onChunk directly to LLM, which calls it per-token.
    const simulatedTokens = ['Hello', '! ', 'How ', 'can ', 'I ', 'help?'];
    for (const token of simulatedTokens) {
      onChunk(token);
    }

    expect(onChunk).toHaveBeenCalledTimes(6);
    expect(chunks.join('')).toBe('Hello! How can I help?');
    // Key assertion: no single call contains the full response
    expect(chunks.some((c) => c === 'Hello! How can I help?')).toBe(false);
  });

  it('buffers tokens for tool-calling iterations (preserves existing behavior)', () => {
    // When the LLM returns tool_use blocks, tokens MUST be buffered
    // because we need to check if all tools are system tools
    // (handoff/delegate) to decide whether to suppress the text.

    let iterBuffer = '';
    const bufferChunk = (chunk: string) => {
      iterBuffer += chunk;
    };

    const tokens = ['I will ', 'search ', 'for that.'];
    for (const t of tokens) {
      bufferChunk(t);
    }

    expect(iterBuffer).toBe('I will search for that.');
  });
});
```

**Step 2: Run test to verify it passes (this is a contract test)**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/reasoning-executor-streaming.test.ts`
Expected: PASS — the contract test validates the expected behavior pattern.

**Step 3: Implement two-phase streaming in the reasoning executor**

The key insight: We can't know ahead of time whether an LLM call will produce tool calls or a final text response. The Vercel AI SDK's `streamText()` streams text tokens through `textStream` iterator and only reveals `toolCalls` after the full stream completes.

**Approach:** Use a "speculative streaming" pattern:

1. Always pass `onChunk` directly to `chatWithToolUseStreamable()` (stream tokens as they arrive)
2. After the LLM response completes, check if tool calls were returned
3. If tool calls exist AND all are system tools → the text was already streamed but should have been suppressed. Send a `__clear_stream__` signal via onChunk so the WebSocket layer can discard it. (Or: accept the cosmetic leak — supervisor text is typically short and benign.)
4. If tool calls exist but NOT all system tools → text was correctly streamed (non-system-tool rounds already flush)
5. If no tool calls → this was the final response, tokens already streamed perfectly

**However**, a simpler approach that requires no WebSocket changes:

**Conservative approach (recommended):** Track whether this is the first iteration AND the previous iteration had tool calls. If so, use `bufferChunk`. Otherwise, on the Nth iteration, if we're in the reasoning loop and the LLM is likely producing a final response (i.e., the last iteration had no system tools remaining), stream directly.

**Simplest correct approach:** Keep `bufferChunk` for ALL iterations. But after `chatWithToolUseStreamable` returns with no tool calls (final response at line 1132), instead of flushing the buffer in one chunk, split `iterBuffer` into smaller chunks and flush them rapidly with small delays to simulate streaming. This is "synthetic streaming" — not real per-token, but breaks the single-chunk wall.

**Actually simplest approach that works today:** Modify `chatWithToolUseStreamable` to accept a `streamDirectly` boolean. When true, it calls `onChunk` per-token (existing behavior at line 374-379 of `session-llm-client.ts`). When false, it accumulates internally. The executor passes `streamDirectly: true` on the LAST iteration (detected by: no tool calls in result).

**Problem:** We don't know it's the last iteration until AFTER the LLM call returns.

**Final approach (simplest, correct):** Always stream via `onChunk` directly. After the call, if tool calls are present AND `allSystemTools` is true, send a special chunk `\x00CLEAR\x00` that the WebSocket handler interprets as "discard everything streamed this iteration". This is a one-line WebSocket change.

**Actually, let's go with the cleanest approach:**

In `reasoning-executor.ts`, modify the while loop to:

1. On iteration 1+, if previous iteration produced system-tool-only calls, use `bufferChunk` (supervisor text suppression needed)
2. Otherwise, pass `onChunk` directly (speculative streaming)
3. After result returns: if tool calls exist AND allSystemTools → text was speculatively streamed but shouldn't have been. This is acceptable — supervisor text like "Let me transfer you" is helpful UX, not harmful. We just don't add `\n\n` suffix.

Modify `apps/runtime/src/services/execution/reasoning-executor.ts`:

Replace lines 729-758 (the iterBuffer + bufferChunk + LLM call block):

```typescript
// Determine streaming strategy for this iteration:
// - If we know this agent is a supervisor with ONLY system tools
//   (handoff/delegate), buffer text so we can suppress it.
// - Otherwise, stream directly to the client for low TTFB.
const isSupervisor = session.agentIR?.metadata?.type === 'supervisor';
const hasOnlySystemTools =
  isSupervisor &&
  tools.every(
    (t) =>
      t.name.startsWith('__') ||
      t.name.startsWith('handoff_to_') ||
      t.name.startsWith('delegate_to_'),
  );

let iterBuffer = '';
const bufferChunk = onChunk
  ? (chunk: string) => {
      iterBuffer += chunk;
    }
  : undefined;

// Stream directly when the agent has regular tools (specialist agents).
// Buffer when the agent only has system tools (supervisor routing).
const streamCallback = hasOnlySystemTools ? bufferChunk : onChunk;

// Truncate old tool results to save tokens on later iterations
const compactionPolicy = resolveCompactionPolicy(session);
truncateOldToolResults(messages, iterations, compactionPolicy.tool_results.keep_recent);

const allowParallel = isConfigLoaded() ? getConfig().features.allowParallelToolCalls : false;
const disableParallelToolUse = false;
const llmStart = Date.now();
const result = await session.llmClient!.chatWithToolUseStreamable(
  systemPrompt,
  messages,
  tools,
  'response_gen',
  streamCallback,
  disableParallelToolUse ? { disableParallelToolUse: true } : undefined,
);
const llmDurationMs = Date.now() - llmStart;
```

Then update the text flushing logic at lines 1008-1017:

```typescript
// Flush buffered text for non-system-tool rounds. System-tool rounds
// (handoff, delegate, etc.) have their text suppressed — the thought
// card provides the reasoning context instead.
const allSystemTools = effectiveToolCalls.every(
  (tc) =>
    tc.name.startsWith('__') ||
    tc.name.startsWith('handoff_to_') ||
    tc.name.startsWith('delegate_to_'),
);
if (!allSystemTools && iterBuffer && onChunk) {
  // Only flush buffer if we were buffering (supervisor agents).
  // Specialist agents already streamed directly via onChunk.
  onChunk(this.filterChunkPII(session, iterBuffer) + '\n\n');
  streamedText = true;
} else if (!allSystemTools && !hasOnlySystemTools && onChunk) {
  // Text was already streamed directly — just mark as streamed
  // and send the separator.
  onChunk('\n\n');
  streamedText = true;
}
```

And update the final response at lines 1132-1139:

```typescript
      } else {
        // No tool calls — this is the final response.
        if (hasOnlySystemTools && iterBuffer && onChunk) {
          // Supervisor agent that unexpectedly produced a direct response
          // (e.g., guard rail rejection). Flush the buffer.
          onChunk(this.filterChunkPII(session, iterBuffer));
          streamedText = true;
        } else if (!hasOnlySystemTools && onChunk) {
          // Specialist agent — text was already streamed directly.
          streamedText = true;
        }
        finalResponse = result.text;
        break;
      }
```

**Step 4: Run existing reasoning executor tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/reasoning-executor`
Expected: All PASS. The behavior should be identical for non-streaming tests (onChunk=undefined → streamCallback=undefined).

**Step 5: Run AFG E2E to verify streaming improvement**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`
Expected: All PASS. For specialist agents (Advisor, Store_Policy), the onChunk callback should now be called multiple times per scenario instead of once.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/reasoning-executor-streaming.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/reasoning-executor-streaming.test.ts
git commit -m "[ABLP-2] feat(runtime): stream tokens directly for specialist agents to reduce perceived TTFB"
```

---

### Task 3: Parallelize Multi-Tool Execution

When the LLM returns multiple tool_use blocks (e.g., `product_search` + `offer_search`), they execute serially via a `for...await` loop. Two 3s tool calls take 6s instead of 3s. System tools (handoff/delegate) must remain serial because they have side effects and `breakLoop` semantics.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1019-1118`
- Test: `apps/runtime/src/__tests__/parallel-tool-execution.test.ts` (new)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/parallel-tool-execution.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('parallel tool execution', () => {
  it('executes non-system tools concurrently', async () => {
    const executionOrder: string[] = [];
    const startTime = Date.now();

    // Simulate two tool calls that each take 100ms
    const tool1 = async () => {
      executionOrder.push('tool1-start');
      await new Promise((r) => setTimeout(r, 100));
      executionOrder.push('tool1-end');
      return { toolResult: { data: 'result1' }, action: undefined, breakLoop: false };
    };

    const tool2 = async () => {
      executionOrder.push('tool2-start');
      await new Promise((r) => setTimeout(r, 100));
      executionOrder.push('tool2-end');
      return { toolResult: { data: 'result2' }, action: undefined, breakLoop: false };
    };

    // Execute in parallel
    const results = await Promise.all([tool1(), tool2()]);
    const elapsed = Date.now() - startTime;

    // Both started before either finished (parallel execution)
    expect(executionOrder[0]).toBe('tool1-start');
    expect(executionOrder[1]).toBe('tool2-start');
    // Total time should be ~100ms, not ~200ms
    expect(elapsed).toBeLessThan(180);
    expect(results).toHaveLength(2);
  });

  it('keeps system tools serial (breakLoop semantics)', async () => {
    const executionOrder: string[] = [];

    const systemTool = async () => {
      executionOrder.push('system-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('system-end');
      return { toolResult: { response: 'done' }, action: { type: 'handoff' }, breakLoop: true };
    };

    const regularTool = async () => {
      executionOrder.push('regular-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('regular-end');
      return { toolResult: { data: 'result' }, action: undefined, breakLoop: false };
    };

    // System tool should break before regular tool runs
    const results = [];
    for (const fn of [systemTool, regularTool]) {
      const result = await fn();
      results.push(result);
      if (result.breakLoop) break;
    }

    expect(executionOrder).toEqual(['system-start', 'system-end']);
    expect(results).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it passes (contract test)**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/parallel-tool-execution.test.ts`
Expected: PASS

**Step 3: Implement parallel tool execution**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, replace the serial tool loop (lines 1019-1118) with:

```typescript
// Execute tools: parallel for regular tools, serial for system tools.
// System tools (handoff, delegate, fan_out, etc.) have side effects
// and breakLoop semantics that require serial execution.
const toolResults: Array<ToolResultContent> = [];
let shouldBreak = false;

// Partition into regular and system tool calls
const regularToolCalls = effectiveToolCalls.filter(
  (tc) =>
    !tc.name.startsWith('__') &&
    !tc.name.startsWith('handoff_to_') &&
    !tc.name.startsWith('delegate_to_'),
);
const systemToolCalls = effectiveToolCalls.filter(
  (tc) =>
    tc.name.startsWith('__') ||
    tc.name.startsWith('handoff_to_') ||
    tc.name.startsWith('delegate_to_'),
);

// Execute regular tools in parallel
if (regularToolCalls.length > 0) {
  const parallelResults = await Promise.all(
    regularToolCalls.map(async (toolCall) => {
      const { toolResult, action, breakLoop } = await this.executeToolCall(
        session,
        toolCall,
        onChunk,
        onTraceEvent,
      );
      return { toolCall, toolResult, action, breakLoop };
    }),
  );

  for (const { toolCall, toolResult, action, breakLoop } of parallelResults) {
    const serialized = JSON.stringify(toolResult);
    const compactionPolicy = resolveCompactionPolicy(session);
    const compressed = compressToolResult(serialized, toolCall.name, compactionPolicy);
    const maxChars = compactionPolicy.tool_results.max_chars;
    const truncated =
      compressed.length > maxChars
        ? compressed.slice(0, maxChars) +
          `\n...[truncated: ${compressed.length} chars, showing first ${maxChars}]`
        : compressed;

    if (compressed.length > maxChars) {
      log.warn('Tool result truncated after compression — exceeds size limit', {
        toolName: toolCall.name,
        originalSize: serialized.length,
        compressedSize: compressed.length,
        truncatedSize: maxChars,
        agent: session.agentName,
      });
      if (onTraceEvent) {
        onTraceEvent({
          type: 'tool_result_truncated',
          data: {
            toolName: toolCall.name,
            originalSize: serialized.length,
            compressedSize: compressed.length,
            truncatedSize: maxChars,
            agent: session.agentName,
          },
        });
      }
    } else if (compressed.length < serialized.length) {
      log.info('Tool result compressed', {
        toolName: toolCall.name,
        originalSize: serialized.length,
        compressedSize: compressed.length,
        agent: session.agentName,
      });
    }

    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: truncated,
    });

    if (action) {
      finalAction = action;
    }
  }
}

// Execute system tools serially (breakLoop semantics)
if (!shouldBreak) {
  for (const toolCall of systemToolCalls) {
    const { toolResult, action, breakLoop } = await this.executeToolCall(
      session,
      toolCall,
      onChunk,
      onTraceEvent,
    );

    const serialized = JSON.stringify(toolResult);
    const compactionPolicy = resolveCompactionPolicy(session);
    const compressed = compressToolResult(serialized, toolCall.name, compactionPolicy);
    const maxChars = compactionPolicy.tool_results.max_chars;
    const truncated =
      compressed.length > maxChars
        ? compressed.slice(0, maxChars) +
          `\n...[truncated: ${compressed.length} chars, showing first ${maxChars}]`
        : compressed;

    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: truncated,
    });

    if (action) {
      finalAction = action;
    }

    // Silent handoff handling
    if (!breakLoop && action?.type === 'handoff') {
      finalAction = { type: 'continue' };
    }

    if (breakLoop) {
      shouldBreak = true;
      if (
        action?.type === 'handoff' &&
        typeof toolResult === 'object' &&
        toolResult !== null &&
        'response' in toolResult
      ) {
        finalResponse = (toolResult as { response: string }).response;
      }
      if (action?.type === 'escalate') {
        finalResponse = `\u{1F514} **Escalated to Human Agent**\nReason: ${sanitizeForDisplay(action.reason || 'User request')}\nPriority: ${sanitizeForDisplay(action.priority || 'medium', 20)}\n\n[A human agent will respond to your next message]`;
      }
      if (
        action?.type === 'complete' &&
        typeof toolResult === 'object' &&
        toolResult !== null &&
        'message' in toolResult
      ) {
        finalResponse = (toolResult as { message: string }).message;
      }
      if (action?.type === 'constraint_violation' && action.message) {
        finalResponse = action.message as string;
        if (onChunk) onChunk(this.filterChunkPII(session, finalResponse));
      }
      break;
    }
  }
}
```

**Important:** The tool result compression block is duplicated for regular and system tools. Extract a helper to keep it DRY:

```typescript
private compressAndTruncateToolResult(
  session: RuntimeSession,
  toolCall: ToolCall,
  toolResult: unknown,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): string {
  const serialized = JSON.stringify(toolResult);
  const compactionPolicy = resolveCompactionPolicy(session);
  const compressed = compressToolResult(serialized, toolCall.name, compactionPolicy);
  const maxChars = compactionPolicy.tool_results.max_chars;
  const truncated =
    compressed.length > maxChars
      ? compressed.slice(0, maxChars) +
        `\n...[truncated: ${compressed.length} chars, showing first ${maxChars}]`
      : compressed;

  if (compressed.length > maxChars) {
    log.warn('Tool result truncated after compression — exceeds size limit', {
      toolName: toolCall.name,
      originalSize: serialized.length,
      compressedSize: compressed.length,
      truncatedSize: maxChars,
      agent: session.agentName,
    });
    onTraceEvent?.({
      type: 'tool_result_truncated',
      data: {
        toolName: toolCall.name,
        originalSize: serialized.length,
        compressedSize: compressed.length,
        truncatedSize: maxChars,
        agent: session.agentName,
      },
    });
  } else if (compressed.length < serialized.length) {
    log.info('Tool result compressed', {
      toolName: toolCall.name,
      originalSize: serialized.length,
      compressedSize: compressed.length,
      agent: session.agentName,
    });
  }

  return truncated;
}
```

**Step 4: Run all reasoning executor tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/reasoning-executor apps/runtime/src/__tests__/parallel-tool-execution.test.ts`
Expected: All PASS

**Step 5: Run AFG E2E**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`
Expected: All PASS. Product search scenarios should be faster when multiple tools are called.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/parallel-tool-execution.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/parallel-tool-execution.test.ts
git commit -m "[ABLP-2] feat(runtime): parallelize non-system tool execution with Promise.all"
```

---

### Task 4: Cheaper Model for Supervisor

The `GuardRail_Supervisor` uses the same GPT-4.1 model as specialist agents, but only needs to route — its text output is always suppressed. Use Qwen 30B (or GPT-4.1-mini if available) for the supervisor's reasoning calls, saving ~0.5-1s per turn.

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

**Step 1: Add model override to the supervisor's agent IR**

In the `GuardRail_Supervisor` IR in the E2E test, add model configuration to use the Qwen model for reasoning. The model resolution chain uses `agentIR.execution.model` or the IR-level model override.

Find the supervisor IR `execution` block and add:

```typescript
execution: {
  // ... existing fields ...
  model: 'qwen3-30b', // Cheap model for routing-only supervisor
  // ... pipeline config from Task 1 ...
},
```

**Note:** Check how the model is resolved. If `execution.model` isn't the right field, check `agentIR.model` or the `models` map in the IR. The `session-llm-client.ts` resolves via `resolveConfig(operationType)` → `resolveLanguageModel(operationType)` → the 5-level chain. The agent IR level is Level 1.

**Step 2: Run AFG E2E**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`
Expected: All PASS. Supervisor latency should be lower in trace events. Guard rail scenario should be noticeably faster since it only uses the supervisor (no specialist).

**Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git commit -m "[ABLP-2] perf(runtime): use Qwen 30B for supervisor routing to reduce LLM latency"
```

---

### Task 5: Embedding Cache (Redis)

The AFG product/automobile search tools call Azure OpenAI to generate embeddings (~500-1500ms per call). Repeated or similar queries regenerate embeddings from scratch. Add a Redis cache for `(query → embedding vector)` with a 1-hour TTL.

**Files:**

- Modify: The sandbox tool code that calls Azure OpenAI embeddings. This is in the Lambda/sandbox tool definition, likely in the AFG project's tool configuration or a shared embedding utility.
- Test: `apps/runtime/src/__tests__/embedding-cache.test.ts` (new)

**Step 1: Find the embedding call site**

Search for embedding-related code in the runtime and tools:

```bash
grep -r "embedding" apps/runtime/src/services/ --include="*.ts" -l
grep -r "azure.*openai.*embed" apps/runtime/ --include="*.ts" -l
grep -r "text-embedding" apps/runtime/ --include="*.ts" -l
```

The embedding call is likely inside the sandbox tool's Lambda function or an HTTP tool definition. Identify the exact file and function.

**Step 2: Design the cache layer**

Create `apps/runtime/src/services/cache/embedding-cache.ts`:

```typescript
import { createLogger } from '@abl/compiler/platform';
import { getRedisClient } from '../../infrastructure/redis.js';

const log = createLogger('embedding-cache');

const EMBEDDING_CACHE_PREFIX = 'emb:';
const EMBEDDING_CACHE_TTL_S = 3600; // 1 hour

/**
 * Get a cached embedding vector for a query string.
 * Returns null on cache miss or Redis unavailability.
 */
export async function getCachedEmbedding(query: string, model: string): Promise<number[] | null> {
  try {
    const redis = getRedisClient();
    if (!redis) return null;

    const key = `${EMBEDDING_CACHE_PREFIX}${model}:${hashQuery(query)}`;
    const cached = await redis.get(key);
    if (!cached) return null;

    log.debug('Embedding cache hit', { model, queryLength: query.length });
    return JSON.parse(cached);
  } catch (err) {
    log.warn('Embedding cache read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store an embedding vector in the cache.
 */
export async function setCachedEmbedding(
  query: string,
  model: string,
  embedding: number[],
): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis) return;

    const key = `${EMBEDDING_CACHE_PREFIX}${model}:${hashQuery(query)}`;
    await redis.set(key, JSON.stringify(embedding), 'EX', EMBEDDING_CACHE_TTL_S);
    log.debug('Embedding cached', {
      model,
      queryLength: query.length,
      dimensions: embedding.length,
    });
  } catch (err) {
    log.warn('Embedding cache write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function hashQuery(query: string): string {
  // Simple hash for cache key — crypto.createHash is fast for short strings
  const { createHash } = require('crypto');
  return createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
}
```

**Step 3: Wire the cache into the embedding call site**

Wrap the existing embedding API call with cache check:

```typescript
import { getCachedEmbedding, setCachedEmbedding } from '../cache/embedding-cache.js';

async function getEmbedding(query: string, model: string): Promise<number[]> {
  // Check cache first
  const cached = await getCachedEmbedding(query, model);
  if (cached) return cached;

  // Cache miss — call Azure OpenAI
  const embedding = await callAzureOpenAIEmbedding(query, model);

  // Cache async (don't await — fire and forget)
  setCachedEmbedding(query, model, embedding).catch(() => {});

  return embedding;
}
```

**Step 4: Write unit test**

Create `apps/runtime/src/__tests__/embedding-cache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock('../../infrastructure/redis.js', () => ({
  getRedisClient: () => mockRedis,
}));

import { getCachedEmbedding, setCachedEmbedding } from '../services/cache/embedding-cache.js';

describe('embedding cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null on cache miss', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
    expect(result).toBeNull();
  });

  it('returns cached embedding on hit', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockRedis.get.mockResolvedValue(JSON.stringify(embedding));
    const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
    expect(result).toEqual(embedding);
  });

  it('stores embedding with TTL', async () => {
    const embedding = [0.1, 0.2, 0.3];
    await setCachedEmbedding('test query', 'text-embedding-3-large', embedding);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('emb:text-embedding-3-large:'),
      JSON.stringify(embedding),
      'EX',
      3600,
    );
  });

  it('returns null on Redis error (graceful degradation)', async () => {
    mockRedis.get.mockRejectedValue(new Error('connection refused'));
    const result = await getCachedEmbedding('test query', 'text-embedding-3-large');
    expect(result).toBeNull();
  });
});
```

**Step 5: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/embedding-cache.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/cache/embedding-cache.ts apps/runtime/src/__tests__/embedding-cache.test.ts
git add apps/runtime/src/services/cache/embedding-cache.ts apps/runtime/src/__tests__/embedding-cache.test.ts
git commit -m "[ABLP-2] feat(runtime): add Redis embedding cache with 1hr TTL for tool search latency"
```

**Note:** The actual wiring into the AFG sandbox tools depends on whether the embedding call is inside a Lambda function (external) or an HTTP tool handler (in-process). If it's a Lambda, the cache would need to be in the Lambda code or the embedding call would need to be extracted to a shared service. Investigate the tool execution path during implementation.

---

### Task 6: Parallel Fan-Out for Delegation

The delegation scenario ("buy sneakers AND what's the return policy?") currently routes to AdvisorAgent and StorePolicyAgent serially. The `__fan_out__` system tool already supports parallel agent execution. The issue is that the supervisor LLM emits sequential `handoff_to_Advisor_Agent` + `delegate_to_Store_Policy_Agent` calls instead of a single `__fan_out__` call.

The reasoning executor already has a guard (around line 895-965) that converts parallel handoff calls into `__fan_out__`. However, the supervisor may be configured with `disableParallelToolUse: true`, forcing serial tool calls. We need to verify this and ensure the fan-out conversion works.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` (verify parallel→fan_out guard)
- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts` (test delegation timing)

**Step 1: Read the parallel→fan_out conversion guard**

Read `apps/runtime/src/services/execution/reasoning-executor.ts` around lines 860-970 to understand the guard that converts `[handoff_to_A, handoff_to_B]` → `__fan_out__({tasks: [A, B]})`. Identify under what conditions it activates and whether `disableParallelToolUse` prevents it.

**Step 2: Verify supervisor tool use configuration**

Check if the `GuardRail_Supervisor` IR has `disableParallelToolUse` set. In the E2E test, look at the supervisor's execution config. Also check `reasoning-executor.ts:749-751`:

```typescript
const isSupervisor = session.agentIR?.metadata?.type === 'supervisor';
const allowParallel = isConfigLoaded() ? getConfig().features.allowParallelToolCalls : false;
const disableParallelToolUse = false; // Per-agent tools — LLM decides parallelism
```

If `disableParallelToolUse` is `false`, the LLM CAN emit parallel tool calls. But the supervisor prompt may instruct the LLM to use `__fan_out__` explicitly for multi-intent scenarios. Verify the supervisor's system prompt instructions.

**Step 3: Test the delegation scenario with timing**

In the AFG E2E test, add timing assertions to the delegation scenario:

```typescript
it('delegation: routes product + policy queries in parallel via fan-out', async () => {
  const start = Date.now();
  const result = await sendMessage(
    session,
    'I want to buy red sneakers and what is the return policy for clothing?',
  );
  const elapsed = Date.now() - start;

  // Verify both topics are addressed
  expect(result.response).toMatch(/sneaker|product|retail/i);
  expect(result.response).toMatch(/policy|return|routing/i);

  // With parallel fan-out, should be faster than serial (2x agent chain)
  // Serial: ~10-12s (supervisor + advisor chain + policy chain)
  // Parallel: ~6-8s (supervisor + max(advisor, policy))
  // Log timing for comparison
  console.log(`Delegation elapsed: ${elapsed}ms`);
});
```

**Step 4: If fan-out is not activating, enable it**

If the supervisor emits sequential tool calls (not parallel), we have two options:

a) **Prompt engineering:** Add explicit instruction to the supervisor system prompt to use `__fan_out__` for multi-intent messages.

b) **Post-hoc conversion:** The parallel→fan_out guard already exists. Ensure it's not disabled by the `disableParallelToolUse` flag. If the LLM emits parallel handoff calls, the guard converts them.

c) **Pipeline-level:** With the pipeline classifier from Task 1 enabled, multi-intent messages are detected by the classifier's `intentCount > 1` path. Check if `pipeline/index.ts` has multi-intent fan-out support.

**Step 5: Run AFG E2E and verify delegation timing**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose`
Expected: Delegation scenario passes and timing is improved.

**Step 6: Commit**

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git commit -m "[ABLP-2] perf(runtime): ensure delegation uses parallel fan-out for multi-intent routing"
```

---

### Task 7: E2E Validation & Updated Comparison Doc

Run the full AFG E2E suite with all improvements enabled and update the comparison document with new metrics.

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/ABL_VS_BASELINE_COMPARISON.md`

**Step 1: Run full AFG E2E with verbose timing**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/e2e/afg-blue-advisory/ --reporter=verbose 2>&1 | tee /tmp/afg-latency-results.txt`

**Step 2: Collect metrics from the run**

Extract timing data from the test output and trace events. For each scenario, record:

- TTFB (time to first chunk)
- Total time
- Number of chunks (should be >1 for specialist agents now)
- Pipeline events (if short-circuit activated)

**Step 3: Update the comparison doc**

Add a new section to `ABL_VS_BASELINE_COMPARISON.md`:

```markdown
## Post-Optimization Results (2026-03-09)

### Changes Applied

1. Pipeline classifier enabled (Qwen 30B, short-circuit routing)
2. Direct streaming for specialist agents (TTFB != Total)
3. Parallel tool execution (Promise.all for non-system tools)
4. Qwen 30B for supervisor reasoning
5. Parallel fan-out for delegation

### Updated Performance Comparison

| Scenario | Before TTFB | Before Total | After TTFB | After Total | Improvement |
| ... | ... | ... | ... | ... | ... |
```

Include updated transcripts for each scenario showing the new response text and timing.

**Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/e2e/afg-blue-advisory/ABL_VS_BASELINE_COMPARISON.md
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/ABL_VS_BASELINE_COMPARISON.md
git commit -m "[ABLP-2] docs(runtime): update AFG comparison doc with post-optimization metrics and transcripts"
```

---

## Dependency Graph

```
Task 1 (Pipeline Classifier) ─────────────────┐
Task 4 (Cheaper Supervisor Model) ─────────────┤
                                                ├──→ Task 7 (E2E Validation)
Task 2 (Streaming) ────────────────────────────┤
Task 3 (Parallel Tools) ──────────────────────┤
Task 5 (Embedding Cache) ─────────────────────┤
Task 6 (Fan-Out Delegation) ───────────────────┘
```

Tasks 1-6 are independent and can be executed in any order. Task 7 must run last.

## Projected Impact

| Scenario       | Current | Projected TTFB | Projected Total |
| -------------- | ------- | -------------- | --------------- |
| Greeting       | 3.0s    | ~0.8-1.2s      | ~1.5-2.0s       |
| Product Search | 9.1s    | ~1.5-2.0s      | ~5-6s           |
| Guard Rail     | 1.6s    | ~0.5-0.8s      | ~0.8-1.0s       |
| Delegation     | 5.6s    | ~1.0-1.5s      | ~3-4s           |
| Automobile     | 11.0s   | ~1.5-2.0s      | ~6-7s           |
