# Session Compaction — Low-Level Design

## Implementation Structure

### Core Files

| File                                                            | Purpose                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/session/compaction-engine.ts`        | CompactionEngine class: autoCompact trigger, compactThread, LLM summary, extractive fallback     |
| `apps/runtime/src/services/execution/compaction-policy.ts`      | resolveCompactionPolicy: 3-level merge (platform, project, agent IR), tool essential_fields      |
| `apps/runtime/src/services/execution/tool-result-compressor.ts` | compressToolResult: per-result compression using essential_fields, truncation, LLM summarization |
| `apps/runtime/src/services/execution/reasoning-executor.ts`     | truncatePriorTurnToolResults: cross-turn tool result truncation before LLM calls                 |
| `apps/runtime/src/services/session/types.ts`                    | SessionConfig interface with compactionEnabled, autoCompactThreshold, compactionModel            |

### Type Definitions

| File                                          | Purpose                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts` | CompactionPolicy, ToolResultCompactionConfig, PriorTurnCompactionConfig types |

### Test Files

| File                                                            | Type | Focus                                                                                |
| --------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`          | unit | 8 tests: trigger logic, threshold, model registry, trace events, extractive fallback |
| `apps/runtime/src/__tests__/compaction-policy.test.ts`          | unit | 4 tests: defaults, 3-level merge, essential_fields, caching                          |
| `apps/runtime/src/__tests__/tool-result-compressor.test.ts`     | unit | ~6 tests: essential_fields extraction, truncation, summarization                     |
| `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts` | unit | ~4 tests: prior-turn truncation, current-turn preservation                           |

## Task T-1: CompactionEngine

### Key Functions

```typescript
// Constructor accepts optional SessionConfig override
class CompactionEngine {
  constructor(config?: Partial<SessionConfig>);

  // Check if auto-compaction should trigger for active thread
  // Called before each LLM call in reasoning loop
  async autoCompact(
    session: RuntimeSession,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<CompactionResult | null>;

  // Compact a specific thread's conversation history
  async compactThread(
    session: RuntimeSession,
    threadIndex: number,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<CompactionResult>;
}

// Token estimation: 4 chars per token + 10 chars role overhead per message
function estimateTokens(messages: Array<{ role: string; content: unknown }>): number;

// Model context window resolution chain:
// session.resolvedModelId -> thread.agentIR.execution.model -> session.agentIR.execution.model -> 128K
function getContextWindowSize(session: RuntimeSession): number;
```

### Compaction Algorithm

1. Check `compactionEnabled` config flag
2. Get active thread from `session.threads[session.activeThreadIndex]`
3. Resolve context window via model registry (`getModelRegistryEntry`)
4. Estimate current tokens via character heuristic
5. Compare against `contextWindow * effectiveThreshold` (session override or global)
6. If under threshold, return null (no compaction needed)
7. Split history: keep `max(MIN_ACTIVE_WINDOW=10, floor(length/2))` recent messages
8. Generate summary of older messages (LLM or extractive fallback)
9. Rebuild history: `[summarySystemMessage, ...activeWindow]`
10. Emit `auto_compact` trace event

### Extractive Fallback

When LLM is unavailable or fails, builds summary from:

- Agent name
- First user message content (truncated to 200 chars)
- Last user message content (truncated to 200 chars)
- Gathered data from `thread.data.values` (first 10 entries)
- Message count

## Task T-2: CompactionPolicy Resolution

### Key Functions

```typescript
// Platform defaults
const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  tool_results: {
    strategy: 'summarize',
    max_chars: 102_400,
    structured_threshold: 10_000,
    keep_recent: 2,
    max_description_length: 200,
  },
  prior_turns: {
    strategy: 'compact',
    assistant_preview_chars: 200,
  },
};

// 3-level merge with lazy caching on session._compactionPolicy
function resolveCompactionPolicy(
  session: Pick<RuntimeSession, 'agentIR' | '_projectRuntimeConfig' | '_compactionPolicy'>,
): CompactionPolicy;
```

### Merge Strategy

Right-side-wins per leaf field:

1. Start with `DEFAULT_COMPACTION_POLICY`
2. Apply `session._projectRuntimeConfig.compaction` (project-level overrides)
3. Apply `session.agentIR.execution.compaction` (agent IR overrides)
4. Collect `tool.compaction.essential_fields` from all tools in agent IR

### Constants

| Constant                    | Value                      | Location             |
| --------------------------- | -------------------------- | -------------------- |
| `DEFAULT_CONTEXT_WINDOW`    | 128,000                    | compaction-engine.ts |
| `CHARS_PER_TOKEN`           | 4                          | compaction-engine.ts |
| `MIN_ACTIVE_WINDOW`         | 10                         | compaction-engine.ts |
| `COMPACTION_SUMMARY_PREFIX` | `[Conversation Summary]\n` | compaction-engine.ts |

## Task T-3: Tool-Result Compressor (Complementary)

Works alongside the compaction engine to compress individual tool results within messages:

- **essential_fields extraction**: For structured JSON tool results, extract only the fields listed in the policy's essential_fields for that tool
- **Truncation**: When result exceeds max_chars, truncate with a note
- **LLM summarization**: For large structured results exceeding structured_threshold, use LLM to summarize

## Task T-4: Cross-Turn Truncation (Complementary)

`truncatePriorTurnToolResults` in the reasoning executor:

- Tool results from prior turns are truncated to `assistant_preview_chars` (default 200)
- Current-turn tool results are preserved in full
- Reduces context before the main compaction engine threshold check

## Known Gaps

| ID      | Description                                                                                              | Severity        |
| ------- | -------------------------------------------------------------------------------------------------------- | --------------- |
| GAP-001 | `compactionModel` field in SessionConfig exists but is not wired — summarization always uses session LLM | Medium          |
| GAP-002 | Token estimation heuristic (4 chars/token) may under-estimate for CJK languages                          | Low             |
| GAP-003 | No integration test exercises compaction within the reasoning loop                                       | High            |
| GAP-004 | No E2E test for transparent long-conversation auto-compaction                                            | High            |
| GAP-005 | Tests only use string content, not ContentBlock[] array content                                          | Medium          |
| GAP-006 | Compaction disabled by default — requires explicit opt-in                                                | Low (by design) |

## Dependencies

- `@abl/compiler/platform/llm/model-capabilities.js` — model registry for context window lookup
- `@abl/compiler/platform/ir/schema.js` — CompactionPolicy, ToolResultCompactionConfig types
- Session LLM client (`thread.llmClient || session.llmClient`) — for abstractive summarization
- Session store — compacted history persisted when session is saved

## Exit Criteria

- All 4 unit test files pass: `pnpm test --filter=runtime -- compaction`
- Extractive fallback produces useful summary without LLM
- Compaction never drops below MIN_ACTIVE_WINDOW (10) messages
- Trace events include all required fields (threadIndex, agentName, tokensBefore, tokensAfter)
- Policy caching prevents recomputation per LLM call
