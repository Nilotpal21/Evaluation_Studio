# Compaction Strategies Design

## Problem

The ABL runtime has 5 compaction behaviors hardcoded across 2 files with magic numbers and domain-specific knowledge baked into engine code:

| Hardcoded Value                                       | File                      | Problem                                  |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------- |
| `MAX_TOOL_RESULT_CHARS = 102_400`                     | reasoning-executor.ts     | Magic number, not configurable           |
| `KEEP_RECENT_TOOL_RESULTS = 2`                        | reasoning-executor.ts     | Magic number, not configurable           |
| `COMPACT_PREFIX_CHARS = 200`                          | reasoning-executor.ts     | Magic number, not configurable           |
| `MAX_COMPRESSED_TOOL_RESULT_CHARS = 10_000`           | tool-result-compressor.ts | Magic number, not configurable           |
| `ESSENTIAL_PRODUCT_FIELDS` / `ESSENTIAL_OFFER_FIELDS` | tool-result-compressor.ts | Domain-specific knowledge in engine code |

This makes the compaction behavior opaque, non-configurable, and couples the engine to specific tool schemas.

## Design

### CompactionPolicy Type

A unified configuration type that governs all compaction behavior:

```typescript
export interface CompactionPolicy {
  /** LLM model for 'summarize' strategies. Resolved via chain:
   *  agent.execution.compaction.model → project.compaction.model → platform default */
  model?: string;

  /** Tool result compaction configuration */
  tool_results: {
    /** Strategy for compacting tool results:
     *  - 'none': pass through raw results unchanged
     *  - 'truncate': character-cap only (no structural understanding)
     *  - 'structured': strip non-essential fields, truncate descriptions, then char-cap
     *  - 'summarize': LLM-powered summary (async, falls back to 'structured' on failure) */
    strategy: 'none' | 'truncate' | 'structured' | 'summarize';

    /** Maximum characters per tool result before truncation */
    max_chars: number;

    /** Threshold above which structured compression is attempted (before char-cap fallback) */
    structured_threshold: number;

    /** Number of most-recent tool iterations to keep intact (older ones get placeholders) */
    keep_recent: number;

    /** Per-tool-name field allowlists for structured compression.
     *  Keys are tool names, values are arrays of field names to preserve.
     *  If a tool has no entry, all fields are kept (only char-cap applies). */
    essential_fields?: Record<string, string[]>;

    /** Per-tool maximum description/text field length for structured compression */
    max_description_length?: number;
  };

  /** Prior-turn compaction configuration */
  prior_turns: {
    /** Strategy for handling prior turn content:
     *  - 'none': keep full history across turns
     *  - 'placeholder': replace prior tool results with placeholder text only
     *  - 'compact': placeholder + compact assistant responses to preview + suffix
     *  - 'summarize': LLM-powered summary of prior turns (async, falls back to 'compact') */
    strategy: 'none' | 'placeholder' | 'compact' | 'summarize';

    /** Number of characters to keep from assistant response as preview (used by 'compact') */
    assistant_preview_chars: number;
  };
}
```

### Platform Defaults

```typescript
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  tool_results: {
    strategy: 'structured',
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
```

### Configuration Layering

Three levels, each overrides the previous:

```
Platform defaults → Project config (DB) → Agent IR (compile-time)
```

**Project level** — `ProjectRuntimeConfig` MongoDB model:

```typescript
// Added to IProjectRuntimeConfig
compaction?: {
  model?: string;
  tool_results?: Partial<CompactionPolicy['tool_results']>;
  prior_turns?: Partial<CompactionPolicy['prior_turns']>;
};
```

**Agent level** — `AgentIR.execution`:

```typescript
// Added to ExecutionConfig
compaction?: Partial<CompactionPolicy>;
```

**Tool level** — `ToolDefinition` (all tool types including MCP, HTTP, connector, searchai, etc.):

```typescript
// Added to ToolDefinition
compaction?: {
  /** Fields to preserve during structured compression */
  essential_fields?: string[];
  /** Max length for description/text fields */
  max_description_length?: number;
};
```

Tool-level annotations apply to ALL tool types (HTTP, MCP, sandbox, lambda, connector, workflow, searchai, async_webhook). The compiler collects tool-level `compaction.essential_fields` into the policy's `tool_results.essential_fields` map keyed by tool name.

**Resolution** — lazy, cached on session:

```typescript
function resolveCompactionPolicy(session: RuntimeSession): CompactionPolicy {
  if (session._compactionPolicy) return session._compactionPolicy;

  const defaults = DEFAULT_COMPACTION_POLICY;
  const project = session._projectRuntimeConfig?.compaction ?? {};
  const agent = session.agentIR?.execution?.compaction ?? {};

  // Deep merge: defaults ← project ← agent (agent wins)
  const resolved = deepMergeCompaction(defaults, project, agent);

  // Collect tool-level essential_fields into the policy
  const tools = session.agentIR?.tools ?? [];
  for (const tool of tools) {
    if (tool.compaction?.essential_fields) {
      resolved.tool_results.essential_fields ??= {};
      resolved.tool_results.essential_fields[tool.name] = tool.compaction.essential_fields;
    }
  }

  session._compactionPolicy = resolved;
  return resolved;
}
```

### LLM-Powered Compaction

The `summarize` strategy uses an LLM to produce intelligent summaries.

**Model resolution chain:**

```
agent.execution.compaction.model → project.compaction.model → platform default ("gpt-4o-mini")
```

**Async execution:** When a turn completes and the response is being streamed to the user, the compaction engine summarizes the just-completed turn's content in parallel. By the next user message, compacted versions are in history. No latency added.

```
User sends Turn 2 → LLM generates response → stream response to user
                                              ↘ async: compact Turn 1 (LLM summary)
User sends Turn 3 → history already has compacted Turn 1
```

**Graceful degradation:**

| LLM available?        | tool_results            | prior_turns            |
| --------------------- | ----------------------- | ---------------------- |
| Yes + `summarize`     | LLM summary (async)     | LLM summary (async)    |
| No LLM / `structured` | Strip fields + char-cap | First N chars + suffix |
| No LLM / `truncate`   | Char-cap only           | Placeholder only       |
| `none`                | Pass through raw        | Keep full history      |

If async LLM call fails (timeout, error), silently falls back to `structured`/`compact`. No user-visible impact.

### ABL DSL Surface

Agent-level compaction in DSL:

```yaml
AGENT ProductAdvisor:
  EXECUTION:
    compaction:
      model: 'gpt-4o-mini'
      tool_results:
        strategy: 'structured'
        max_chars: 50000
        structured_threshold: 8000
      prior_turns:
        strategy: 'compact'
        assistant_preview_chars: 300

  TOOLS:
    product_search:
      compaction:
        essential_fields:
          [id, title, brand, price, salePrice, color, size, description, product_image]
        max_description_length: 200

    offer_search:
      compaction:
        essential_fields: [id, title, brand, description, discount, validUntil, category]

    # MCP tools get the same annotation surface
    crm_lookup:
      tool_type: mcp
      mcp_binding:
        server: crm-server
        tool: lookup_customer
      compaction:
        essential_fields: [customerId, name, tier, lastPurchase]
```

### What Moves Out of Engine Code

| Before (hardcoded)                                              | After (configurable)                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ESSENTIAL_PRODUCT_FIELDS` array in `tool-result-compressor.ts` | `tool.compaction.essential_fields` on `product_search` tool definition |
| `ESSENTIAL_OFFER_FIELDS` array in `tool-result-compressor.ts`   | `tool.compaction.essential_fields` on `offer_search` tool definition   |
| `MAX_TOOL_RESULT_CHARS = 102_400`                               | `policy.tool_results.max_chars`                                        |
| `MAX_COMPRESSED_TOOL_RESULT_CHARS = 10_000`                     | `policy.tool_results.structured_threshold`                             |
| `KEEP_RECENT_TOOL_RESULTS = 2`                                  | `policy.tool_results.keep_recent`                                      |
| `COMPACT_PREFIX_CHARS = 200`                                    | `policy.prior_turns.assistant_preview_chars`                           |
| `MAX_DESCRIPTION_LENGTH = 200`                                  | `policy.tool_results.max_description_length`                           |

The hardcoded constants remain as `DEFAULT_COMPACTION_POLICY` values — they're the platform fallback, not the source of truth.

## Files Changed

### Priority 1: Type Definitions & Policy Resolution

| File                                                            | Change                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                   | Add `CompactionPolicy` type, `compaction?` to `ExecutionConfig`, `compaction?` to `ToolDefinition`    |
| `packages/database/src/models/project-runtime-config.model.ts`  | Add `compaction` field to schema                                                                      |
| NEW: `apps/runtime/src/services/execution/compaction-policy.ts` | `CompactionPolicy`, `DEFAULT_COMPACTION_POLICY`, `resolveCompactionPolicy()`, `deepMergeCompaction()` |
| `apps/runtime/src/services/execution/types.ts`                  | Add `_compactionPolicy?: CompactionPolicy` cache field to `RuntimeSession`                            |

### Priority 2: Engine Integration

| File                                                            | Change                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/tool-result-compressor.ts` | Accept `CompactionPolicy` param, read `essential_fields` from policy, remove hardcoded field lists |
| `apps/runtime/src/services/execution/reasoning-executor.ts`     | Resolve policy via `resolveCompactionPolicy()`, pass to compressor and truncation functions        |

### Priority 3: Async LLM Compaction

| File                                                     | Change                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/runtime/src/services/session/compaction-engine.ts` | Extend with policy-driven summarization for tool results and prior turns |
| `apps/runtime/src/services/runtime-executor.ts`          | Wire async compaction after turn completion                              |

### Priority 4: Documentation Updates

| File                                                  | Change                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `docs/DESIGN_IMPLEMENTATION_ABL_ENGINE.md`            | Update Section 3.4 with CompactionPolicy architecture   |
| `docs/RUNTIME_ARCHITECTURE.md`                        | Add compaction strategies section                       |
| `docs/memory-and-session-store.md`                    | Add compaction policy reference                         |
| `docs/plans/3.4-durable-session-persistence.md`       | Update with policy-driven compaction                    |
| `.claude/skills/abl-architect.md`                     | Add compaction strategy guidance for agent design       |
| `.claude/skills/platform-toolkit.md`                  | Reference compaction policy as available infrastructure |
| `packages/compiler/src/platform/README.md`            | Update IR schema documentation                          |
| `docs/specs/rfcs/RFC-005-agent-tools-platform.md`     | Add tool-level compaction annotation to tool spec       |
| `docs/specs/rfcs/RFC-003-threaded-sessions-memory.md` | Update with compaction policy feature                   |

### Priority 5: Tests

| File                                                            | Change                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| NEW: `apps/runtime/src/__tests__/compaction-policy.test.ts`     | Policy resolution, merge semantics, tool-level collection |
| `apps/runtime/src/__tests__/tool-result-compressor.test.ts`     | Update to pass policy, test per-tool field lists          |
| `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts` | Update to use policy-driven settings                      |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`          | Add policy-driven summarization tests                     |
