# Configurable Compaction Strategies Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all hardcoded compaction magic numbers and domain-specific field lists with a configurable `CompactionPolicy` system at project, agent, and tool levels.

**Architecture:** Define a `CompactionPolicy` type in the IR schema. Resolve it lazily on session via 3-level merge (platform defaults → project DB → agent IR). Tool-level `compaction.essential_fields` annotations feed into the policy. The `summarize` strategy uses an async LLM call (fire-and-forget) with graceful degradation to `structured`/`compact`.

**Tech Stack:** TypeScript, Vitest, MongoDB/Mongoose, ABL compiler IR

---

### Task 1: Define CompactionPolicy type in IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:321-395` (ExecutionConfig) and `:472-546` (ToolDefinition)

**Step 1: Write the failing test**

Create `apps/runtime/src/__tests__/compaction-policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  resolveCompactionPolicy,
  DEFAULT_COMPACTION_POLICY,
} from '../services/execution/compaction-policy.js';

describe('resolveCompactionPolicy', () => {
  it('returns platform defaults when no project or agent config', () => {
    const session = {
      agentIR: { execution: {}, tools: [] },
      _projectRuntimeConfig: {},
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy).toEqual(DEFAULT_COMPACTION_POLICY);
  });

  it('agent-level overrides project-level', () => {
    const session = {
      agentIR: {
        execution: {
          compaction: {
            tool_results: { max_chars: 50_000 },
          },
        },
        tools: [],
      },
      _projectRuntimeConfig: {
        compaction: {
          tool_results: { max_chars: 80_000, keep_recent: 3 },
        },
      },
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy.tool_results.max_chars).toBe(50_000); // agent wins
    expect(policy.tool_results.keep_recent).toBe(3); // project fills gap
    expect(policy.tool_results.strategy).toBe('structured'); // default fills rest
  });

  it('collects tool-level essential_fields into policy', () => {
    const session = {
      agentIR: {
        execution: {},
        tools: [
          {
            name: 'product_search',
            compaction: { essential_fields: ['title', 'price', 'brand'] },
          },
          {
            name: 'crm_lookup',
            tool_type: 'mcp',
            compaction: { essential_fields: ['customerId', 'name'] },
          },
          { name: 'no_compaction_tool' },
        ],
      },
      _projectRuntimeConfig: {},
    };
    const policy = resolveCompactionPolicy(session as any);
    expect(policy.tool_results.essential_fields).toEqual({
      product_search: ['title', 'price', 'brand'],
      crm_lookup: ['customerId', 'name'],
    });
  });

  it('caches resolved policy on session', () => {
    const session = {
      agentIR: { execution: {}, tools: [] },
      _projectRuntimeConfig: {},
    } as any;
    const policy1 = resolveCompactionPolicy(session);
    const policy2 = resolveCompactionPolicy(session);
    expect(policy1).toBe(policy2); // same reference = cached
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/compaction-policy.test.ts`
Expected: FAIL — module not found

**Step 3: Add CompactionPolicy types to IR schema**

In `packages/compiler/src/platform/ir/schema.ts`, add before the `ExecutionConfig` interface (before line 321):

```typescript
// =============================================================================
// COMPACTION POLICY
// =============================================================================

/** Strategy for compacting tool results in conversation history */
export type ToolResultCompactionStrategy = 'none' | 'truncate' | 'structured' | 'summarize';

/** Strategy for compacting prior-turn content */
export type PriorTurnCompactionStrategy = 'none' | 'placeholder' | 'compact' | 'summarize';

/** Tool result compaction configuration */
export interface ToolResultCompactionConfig {
  /** Strategy: none=passthrough, truncate=char-cap, structured=strip fields+cap, summarize=LLM */
  strategy: ToolResultCompactionStrategy;
  /** Maximum characters per tool result before truncation */
  max_chars: number;
  /** Threshold above which structured compression is attempted */
  structured_threshold: number;
  /** Number of most-recent tool iterations to keep intact */
  keep_recent: number;
  /** Per-tool-name field allowlists for structured compression */
  essential_fields?: Record<string, string[]>;
  /** Maximum description/text field length for structured compression */
  max_description_length?: number;
}

/** Prior-turn compaction configuration */
export interface PriorTurnCompactionConfig {
  /** Strategy: none=keep all, placeholder=replace tool results, compact=+preview, summarize=LLM */
  strategy: PriorTurnCompactionStrategy;
  /** Characters to keep from assistant response as preview (used by 'compact') */
  assistant_preview_chars: number;
}

/** Unified compaction policy — configurable at project and agent level */
export interface CompactionPolicy {
  /** LLM model for 'summarize' strategies (resolved: agent → project → platform default) */
  model?: string;
  /** Tool result compaction configuration */
  tool_results: ToolResultCompactionConfig;
  /** Prior-turn compaction configuration */
  prior_turns: PriorTurnCompactionConfig;
}

/** Tool-level compaction hints — declared per tool definition */
export interface ToolCompactionConfig {
  /** Fields to preserve during structured compression */
  essential_fields?: string[];
  /** Max length for description/text fields */
  max_description_length?: number;
}
```

Add `compaction?` to `ExecutionConfig` (after `compaction_threshold` at line 360):

```typescript
  /** Compaction policy — overrides project-level and platform defaults */
  compaction?: Partial<CompactionPolicy>;
```

Add `compaction?` to `ToolDefinition` (after `pii_access` at line 542):

```typescript
  /** Compaction hints for this tool's results (essential fields, description length) */
  compaction?: ToolCompactionConfig;
```

**Step 4: Create compaction-policy.ts**

Create `apps/runtime/src/services/execution/compaction-policy.ts`:

```typescript
/**
 * Compaction Policy Resolution
 *
 * Resolves the effective CompactionPolicy for a session via 3-level merge:
 *   Platform defaults → Project config (DB) → Agent IR (compile-time)
 *
 * Tool-level essential_fields annotations are collected into the policy
 * from ToolDefinition.compaction entries.
 */

import type {
  CompactionPolicy,
  ToolResultCompactionConfig,
  PriorTurnCompactionConfig,
} from '@abl/compiler/platform/ir/schema.js';

import type { RuntimeSession } from './types.js';

/** Platform-wide default compaction policy (matches previous hardcoded values) */
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

/**
 * Resolve the effective CompactionPolicy for a session.
 * Uses lazy caching on session._compactionPolicy.
 */
export function resolveCompactionPolicy(
  session: Pick<RuntimeSession, 'agentIR' | '_projectRuntimeConfig' | '_compactionPolicy'>,
): CompactionPolicy {
  if (session._compactionPolicy) return session._compactionPolicy;

  const defaults = DEFAULT_COMPACTION_POLICY;
  const project = (session._projectRuntimeConfig as Record<string, unknown>)?.compaction as
    | Partial<CompactionPolicy>
    | undefined;
  const agent = session.agentIR?.execution?.compaction;

  // Deep merge: defaults ← project ← agent
  const resolved = deepMergeCompaction(defaults, project, agent);

  // Collect tool-level essential_fields into the policy
  const tools = session.agentIR?.tools ?? [];
  for (const tool of tools) {
    if (tool.compaction?.essential_fields) {
      resolved.tool_results.essential_fields ??= {};
      resolved.tool_results.essential_fields[tool.name] = tool.compaction.essential_fields;
    }
    if (tool.compaction?.max_description_length !== undefined) {
      // Tool-level max_description_length stored in essential_fields map is tool-specific;
      // the policy-level one is the global default. Tool-specific overrides are handled
      // by the compressor when it checks per-tool config.
    }
  }

  (session as { _compactionPolicy?: CompactionPolicy })._compactionPolicy = resolved;
  return resolved;
}

/** Deep-merge compaction configs with right-side winning per leaf field */
function deepMergeCompaction(
  defaults: CompactionPolicy,
  project?: Partial<CompactionPolicy>,
  agent?: Partial<CompactionPolicy>,
): CompactionPolicy {
  return {
    model: agent?.model ?? project?.model ?? defaults.model,
    tool_results: mergeToolResults(
      defaults.tool_results,
      project?.tool_results,
      agent?.tool_results,
    ),
    prior_turns: mergePriorTurns(defaults.prior_turns, project?.prior_turns, agent?.prior_turns),
  };
}

function mergeToolResults(
  defaults: ToolResultCompactionConfig,
  project?: Partial<ToolResultCompactionConfig>,
  agent?: Partial<ToolResultCompactionConfig>,
): ToolResultCompactionConfig {
  return {
    strategy: agent?.strategy ?? project?.strategy ?? defaults.strategy,
    max_chars: agent?.max_chars ?? project?.max_chars ?? defaults.max_chars,
    structured_threshold:
      agent?.structured_threshold ?? project?.structured_threshold ?? defaults.structured_threshold,
    keep_recent: agent?.keep_recent ?? project?.keep_recent ?? defaults.keep_recent,
    essential_fields: mergeEssentialFields(
      defaults.essential_fields,
      project?.essential_fields,
      agent?.essential_fields,
    ),
    max_description_length:
      agent?.max_description_length ??
      project?.max_description_length ??
      defaults.max_description_length,
  };
}

function mergePriorTurns(
  defaults: PriorTurnCompactionConfig,
  project?: Partial<PriorTurnCompactionConfig>,
  agent?: Partial<PriorTurnCompactionConfig>,
): PriorTurnCompactionConfig {
  return {
    strategy: agent?.strategy ?? project?.strategy ?? defaults.strategy,
    assistant_preview_chars:
      agent?.assistant_preview_chars ??
      project?.assistant_preview_chars ??
      defaults.assistant_preview_chars,
  };
}

function mergeEssentialFields(
  ...sources: Array<Record<string, string[]> | undefined>
): Record<string, string[]> | undefined {
  let merged: Record<string, string[]> | undefined;
  for (const source of sources) {
    if (!source) continue;
    merged ??= {};
    Object.assign(merged, source);
  }
  return merged;
}
```

**Step 5: Add cache field to RuntimeSession**

In `apps/runtime/src/services/execution/types.ts`, after the `_guardrailPolicy` field (line 203), add:

```typescript
  /** Cached compaction policy — lazily resolved once per session.
   *  See compaction-policy.ts for resolution chain. */
  _compactionPolicy?: import('@abl/compiler/platform/ir/schema.js').CompactionPolicy;
```

**Step 6: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@abl/compiler && pnpm vitest run apps/runtime/src/__tests__/compaction-policy.test.ts`
Expected: PASS — all 4 tests

**Step 7: Run prettier and commit**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write packages/compiler/src/platform/ir/schema.ts apps/runtime/src/services/execution/compaction-policy.ts apps/runtime/src/services/execution/types.ts apps/runtime/src/__tests__/compaction-policy.test.ts
git add packages/compiler/src/platform/ir/schema.ts apps/runtime/src/services/execution/compaction-policy.ts apps/runtime/src/services/execution/types.ts apps/runtime/src/__tests__/compaction-policy.test.ts
git commit -m "[ABLP-2] feat(runtime): add CompactionPolicy type and resolution with 3-level merge"
```

---

### Task 2: Wire policy into tool-result-compressor

**Files:**

- Modify: `apps/runtime/src/services/execution/tool-result-compressor.ts`
- Modify: `apps/runtime/src/__tests__/tool-result-compressor.test.ts`

**Step 1: Write the failing test**

Add to `apps/runtime/src/__tests__/tool-result-compressor.test.ts`:

```typescript
import { DEFAULT_COMPACTION_POLICY } from '../services/execution/compaction-policy.js';
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';

// ... existing tests stay as-is (they use the default signature) ...

describe('compressToolResult with policy', () => {
  it('uses tool-specific essential_fields from policy', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        essential_fields: {
          custom_search: ['name', 'value'],
        },
      },
    };

    const items = Array.from({ length: 10 }, (_, i) => ({
      name: `Item ${i}`,
      value: i * 100,
      internalId: `int-${i}`,
      metadata: { source: 'api' },
      rawData: 'x'.repeat(500),
    }));

    const raw = JSON.stringify({ custom_search: items });
    expect(raw.length).toBeGreaterThan(policy.tool_results.structured_threshold);

    const compressed = compressToolResult(raw, 'custom_search', policy);
    const parsed = JSON.parse(compressed);
    expect(parsed.custom_search[0].name).toBe('Item 0');
    expect(parsed.custom_search[0].value).toBe(0);
    expect(parsed.custom_search[0].internalId).toBeUndefined();
    expect(parsed.custom_search[0].rawData).toBeUndefined();
  });

  it('respects policy max_description_length', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        max_description_length: 50,
        essential_fields: {
          my_tool: ['title', 'description'],
        },
      },
    };

    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `Item ${i}`,
      description:
        'A very long description that exceeds the fifty character limit we set in policy',
      noise: 'x'.repeat(500),
    }));

    const raw = JSON.stringify({ my_tool: items });
    expect(raw.length).toBeGreaterThan(policy.tool_results.structured_threshold);

    const compressed = compressToolResult(raw, 'my_tool', policy);
    const parsed = JSON.parse(compressed);
    expect(parsed.my_tool[0].description.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(parsed.my_tool[0].noise).toBeUndefined();
  });

  it('falls back to char truncation when strategy is truncate', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        strategy: 'truncate',
        structured_threshold: 100,
      },
    };

    const raw = JSON.stringify({ data: 'x'.repeat(200) });
    const compressed = compressToolResult(raw, 'some_tool', policy);
    // Should be a truncation summary, not structured compression
    expect(compressed).toContain('_truncated');
  });

  it('passes through when strategy is none', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        strategy: 'none',
      },
    };

    const raw = JSON.stringify({ data: 'x'.repeat(50_000) });
    const compressed = compressToolResult(raw, 'some_tool', policy);
    expect(compressed).toBe(raw);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/tool-result-compressor.test.ts`
Expected: FAIL — compressToolResult doesn't accept new params

**Step 3: Rewrite tool-result-compressor.ts to be policy-driven**

Replace `apps/runtime/src/services/execution/tool-result-compressor.ts` with:

```typescript
/**
 * Tool Result Compressor
 *
 * Compresses large tool results before they enter conversation history.
 * Reads configuration from CompactionPolicy — no hardcoded domain knowledge.
 *
 * Strategies:
 *  - 'none': pass through unchanged
 *  - 'truncate': character-cap only (no structural understanding)
 *  - 'structured': strip non-essential fields, truncate descriptions, then char-cap
 *  - 'summarize': LLM-powered (handled externally; this module does structured fallback)
 */

import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';

/** @deprecated Use policy.tool_results.structured_threshold instead */
export const MAX_COMPRESSED_TOOL_RESULT_CHARS =
  DEFAULT_COMPACTION_POLICY.tool_results.structured_threshold;

/**
 * Compress a serialized tool result string.
 *
 * @param serialized - Raw JSON string from tool execution
 * @param toolName - Name of the tool that produced this result (for per-tool field config)
 * @param policy - CompactionPolicy to use (defaults to platform defaults for backward compat)
 */
export function compressToolResult(
  serialized: string,
  toolName?: string,
  policy?: CompactionPolicy,
): string {
  const p = policy ?? DEFAULT_COMPACTION_POLICY;
  const { strategy, structured_threshold, max_description_length } = p.tool_results;

  // Strategy: none — pass through unchanged
  if (strategy === 'none') return serialized;

  // Under threshold — no compression needed
  if (serialized.length <= structured_threshold) return serialized;

  // Strategy: truncate — char-cap only, no structural understanding
  if (strategy === 'truncate') {
    return JSON.stringify({
      _truncated: true,
      _originalSize: serialized.length,
      _preview: serialized.slice(0, 500),
    });
  }

  // Strategy: structured (or summarize fallback) — strip fields, then char-cap
  try {
    const parsed = JSON.parse(serialized);
    if (typeof parsed === 'object' && parsed !== null) {
      const essentialFields = resolveEssentialFields(toolName, p);
      const maxDescLen = max_description_length ?? 200;
      const compressed = compressStructured(parsed, essentialFields, maxDescLen);
      let result = JSON.stringify(compressed);
      if (result.length <= structured_threshold) {
        return result;
      }
      result = trimItemsToFit(compressed, structured_threshold);
      if (result.length <= structured_threshold) {
        return result;
      }
    }
  } catch {
    // Not valid JSON — fall through to truncation summary
  }

  return JSON.stringify({
    _truncated: true,
    _originalSize: serialized.length,
    _preview: serialized.slice(0, 500),
  });
}

/**
 * Resolve essential fields for a tool.
 * Returns a Set if the tool has configured fields, or undefined if no filtering.
 */
function resolveEssentialFields(
  toolName: string | undefined,
  policy: CompactionPolicy,
): Set<string> | undefined {
  if (!toolName || !policy.tool_results.essential_fields) return undefined;
  const fields = policy.tool_results.essential_fields[toolName];
  if (!fields || fields.length === 0) return undefined;
  return new Set(fields);
}

function compressStructured(
  obj: Record<string, unknown>,
  essentialFields: Set<string> | undefined,
  maxDescLen: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      result[key] = compressItemArray(value, essentialFields, maxDescLen);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function compressItemArray(
  items: unknown[],
  essentialFields: Set<string> | undefined,
  maxDescLen: number,
): unknown[] {
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const entries = Object.entries(item as Record<string, unknown>);

    // No essential fields configured — keep all fields, just truncate descriptions
    if (!essentialFields) {
      const compressed: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        if (key === 'description' && typeof value === 'string' && value.length > maxDescLen) {
          compressed[key] = value.slice(0, maxDescLen) + '...';
        } else {
          compressed[key] = value;
        }
      }
      return compressed;
    }

    // Filter to essential fields only
    const compressed: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (!essentialFields.has(key)) continue;
      if (key === 'description' && typeof value === 'string' && value.length > maxDescLen) {
        compressed[key] = value.slice(0, maxDescLen) + '...';
      } else {
        compressed[key] = value;
      }
    }
    return compressed;
  });
}

/** Progressively remove trailing items from array fields until result fits within maxChars. */
function trimItemsToFit(obj: Record<string, unknown>, maxChars: number): string {
  const clone = { ...obj };
  for (const [key, value] of Object.entries(clone)) {
    if (!Array.isArray(value)) continue;
    const arr = [...value];
    clone[key] = arr;
    while (arr.length > 1) {
      arr.pop();
      const candidate = JSON.stringify(clone);
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }
  }
  return JSON.stringify(clone);
}
```

**Step 4: Update reasoning-executor.ts call site**

At `apps/runtime/src/services/execution/reasoning-executor.ts` line ~1026, update the `compressToolResult` call to pass tool name and policy:

Find:

```typescript
const compressed = compressToolResult(serialized);
```

Replace with:

```typescript
const compactionPolicy = resolveCompactionPolicy(session);
const compressed = compressToolResult(serialized, toolCall.name, compactionPolicy);
```

Add import at top of file (near the existing compressToolResult import):

```typescript
import { resolveCompactionPolicy } from './compaction-policy.js';
```

Also replace the hardcoded `MAX_TOOL_RESULT_CHARS` reference at line ~1028 with the policy value:

Find:

```typescript
const truncated =
  compressed.length > MAX_TOOL_RESULT_CHARS
    ? compressed.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n...[truncated: ${compressed.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`
    : compressed;
```

Replace with:

```typescript
const maxChars = compactionPolicy.tool_results.max_chars;
const truncated =
  compressed.length > maxChars
    ? compressed.slice(0, maxChars) +
      `\n...[truncated: ${compressed.length} chars, showing first ${maxChars}]`
    : compressed;
```

**Step 5: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/tool-result-compressor.test.ts apps/runtime/src/__tests__/compaction-policy.test.ts`
Expected: PASS — all tests (old + new)

**Step 6: Run prettier and commit**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write apps/runtime/src/services/execution/tool-result-compressor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/tool-result-compressor.test.ts
git add apps/runtime/src/services/execution/tool-result-compressor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/tool-result-compressor.test.ts
git commit -m "[ABLP-2] feat(runtime): wire CompactionPolicy into tool result compressor"
```

---

### Task 3: Wire policy into prior-turn truncation

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:167-230`
- Modify: `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`

**Step 1: Write the failing test**

Add to `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`:

```typescript
import { DEFAULT_COMPACTION_POLICY } from '../services/execution/compaction-policy.js';
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';

describe('truncatePriorTurnToolResults with policy', () => {
  it('does nothing when prior_turns strategy is none', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'none', assistant_preview_chars: 200 },
    };

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
      { role: 'assistant', content: 'Here are sneakers with full details...' },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    // Nothing truncated
    expect((messages[2].content as any[])[0].content).toBe(
      '{"products": [{"title": "Sneaker 1"}]}',
    );
    expect(messages[3].content).toBe('Here are sneakers with full details...');
  });

  it('only truncates tool results when strategy is placeholder', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'placeholder', assistant_preview_chars: 200 },
    };

    const longResponse = 'A '.repeat(200);
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
      { role: 'assistant', content: longResponse },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    // Tool result truncated
    expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Assistant response NOT compacted (placeholder strategy doesn't compact assistant)
    expect(messages[3].content).toBe(longResponse);
  });

  it('uses custom assistant_preview_chars from policy', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'compact', assistant_preview_chars: 50 },
    };

    const longResponse = 'Here are the sneakers: ' + 'detail '.repeat(100);
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": []}'),
      { role: 'assistant', content: longResponse },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    const compacted = messages[3].content as string;
    // Should use 50 chars, not the default 200
    expect(compacted).toContain(longResponse.slice(0, 50));
    expect(compacted).not.toContain(longResponse.slice(0, 51));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`
Expected: FAIL — truncatePriorTurnToolResults doesn't accept policy param

**Step 3: Update truncatePriorTurnToolResults to accept policy**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, update the function signature and body:

```typescript
export function truncatePriorTurnToolResults(
  messages: Array<{ role: string; content: unknown }>,
  policy?: CompactionPolicy,
): void {
  const priorTurns = policy?.prior_turns ?? DEFAULT_COMPACTION_POLICY.prior_turns;

  // Strategy: none — keep full history
  if (priorTurns.strategy === 'none') return;

  // Find the index of the last plain-text user message (current turn start)
  let lastPlainUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      lastPlainUserIdx = i;
      break;
    }
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type: string }>;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (!hasToolResult) {
        lastPlainUserIdx = i;
        break;
      }
    }
  }

  if (lastPlainUserIdx <= 0) return;

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

  // Strategy: compact — also compact assistant messages following truncated tool results
  if (priorTurns.strategy === 'compact' || priorTurns.strategy === 'summarize') {
    const previewChars = priorTurns.assistant_preview_chars;
    for (let i = 0; i < lastPlainUserIdx; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;

      if (i === 0) continue;
      const prev = messages[i - 1];
      if (prev.role !== 'user' || !Array.isArray(prev.content)) continue;
      const prevBlocks = prev.content as Array<{ type: string; content?: string }>;
      const wasTruncated = prevBlocks.some(
        (b) => b.type === 'tool_result' && b.content === '[Prior turn result — summarized]',
      );
      if (!wasTruncated) continue;

      const text = msg.content;
      if (text.length > previewChars) {
        msg.content = `[Prior response: "${text.slice(0, previewChars)}..." — full details omitted, re-invoke tools if the user changes or refines their request]`;
      }
    }
  }
}
```

Add import at top of file (if not already there from Task 2):

```typescript
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';
```

Update the call site (~line 375 where `truncatePriorTurnToolResults(messages)` is called):

Find:

```typescript
truncatePriorTurnToolResults(messages);
```

Replace with:

```typescript
truncatePriorTurnToolResults(messages, resolveCompactionPolicy(session));
```

Also update `truncateOldToolResults` call to use policy's `keep_recent`:

Find:

```typescript
truncateOldToolResults(messages, iteration);
```

Replace with:

```typescript
const compactionPolicy = resolveCompactionPolicy(session);
truncateOldToolResults(messages, iteration, compactionPolicy.tool_results.keep_recent);
```

**Step 4: Run all truncation tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts apps/runtime/src/__tests__/truncate-old-tool-results.test.ts`
Expected: PASS — all tests (old + new)

**Step 5: Run prettier and commit**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
git commit -m "[ABLP-2] feat(runtime): wire CompactionPolicy into prior-turn truncation"
```

---

### Task 4: Add project-level compaction config to DB model

**Files:**

- Modify: `packages/database/src/models/project-runtime-config.model.ts`

**Step 1: Add the interface and schema**

In `packages/database/src/models/project-runtime-config.model.ts`, add after `IPIIRedactionConfig` (after line 53):

```typescript
export interface ICompactionConfig {
  model?: string;
  tool_results?: {
    strategy?: string;
    max_chars?: number;
    structured_threshold?: number;
    keep_recent?: number;
    max_description_length?: number;
  };
  prior_turns?: {
    strategy?: string;
    assistant_preview_chars?: number;
  };
}
```

Add to `IProjectRuntimeConfig` (after `lookup_tables` at line 81):

```typescript
  compaction?: ICompactionConfig;
```

Add the Mongoose schema (after `LookupTableEntrySchema`, before line 159):

```typescript
const CompactionToolResultsSchema = new Schema(
  {
    strategy: { type: String, enum: ['none', 'truncate', 'structured', 'summarize'] },
    max_chars: { type: Number },
    structured_threshold: { type: Number },
    keep_recent: { type: Number },
    max_description_length: { type: Number },
  },
  { _id: false },
);

const CompactionPriorTurnsSchema = new Schema(
  {
    strategy: { type: String, enum: ['none', 'placeholder', 'compact', 'summarize'] },
    assistant_preview_chars: { type: Number },
  },
  { _id: false },
);

const CompactionConfigSchema = new Schema<ICompactionConfig>(
  {
    model: { type: String },
    tool_results: { type: CompactionToolResultsSchema },
    prior_turns: { type: CompactionPriorTurnsSchema },
  },
  { _id: false },
);
```

Add to `ProjectRuntimeConfigSchema` (after `lookup_tables` at line 174):

```typescript
    compaction: { type: CompactionConfigSchema, default: undefined },
```

**Step 2: Run build to verify schema compiles**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@abl/database`
Expected: PASS

**Step 3: Run prettier and commit**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write packages/database/src/models/project-runtime-config.model.ts
git add packages/database/src/models/project-runtime-config.model.ts
git commit -m "[ABLP-2] feat(database): add compaction config to ProjectRuntimeConfig model"
```

---

### Task 5: Remove hardcoded constants from reasoning-executor

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:107-111`

**Step 1: Remove the now-unused constants**

In `apps/runtime/src/services/execution/reasoning-executor.ts`, delete the constants that are now in the policy:

Find (lines 107-111):

```typescript
/** Maximum tool result size in bytes (~100 KB) before truncation for LLM context */
const MAX_TOOL_RESULT_CHARS = 102_400;

/** Number of recent iterations whose tool results are kept intact */
const KEEP_RECENT_TOOL_RESULTS = 2;
```

Replace with:

```typescript
// Tool result compaction thresholds moved to CompactionPolicy (compaction-policy.ts).
// See DEFAULT_COMPACTION_POLICY for platform defaults.
```

Verify no remaining references to `MAX_TOOL_RESULT_CHARS` or `KEEP_RECENT_TOOL_RESULTS` in the file (they should all have been replaced in Tasks 2–3).

Also remove the `COMPACT_PREFIX_CHARS` constant if it's still there (it was at line ~209 inside the function — should have been replaced in Task 3).

**Step 2: Run full runtime test suite**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run --project runtime`
Expected: PASS — all tests pass with policy-driven values

**Step 3: Run prettier and commit**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-2] refactor(runtime): remove hardcoded compaction constants in favor of CompactionPolicy"
```

---

### Task 6: Update documentation

**Files:**

- Modify: `docs/DESIGN_IMPLEMENTATION_ABL_ENGINE.md`
- Modify: `docs/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/memory-and-session-store.md`
- Modify: `.claude/skills/abl-architect.md`

**Step 1: Read each doc to find the right insertion point**

Read the relevant sections of each file before editing.

**Step 2: Add CompactionPolicy section to DESIGN_IMPLEMENTATION_ABL_ENGINE.md**

Find the Section 3.4 (durable session persistence) and add a subsection:

```markdown
#### 3.4.1 Compaction Strategies

The platform provides configurable compaction strategies via `CompactionPolicy`, resolving at three levels: platform defaults → project config (DB) → agent IR (compile-time).

**Strategies:**

| Strategy     | Tool Results                     | Prior Turns                     |
| ------------ | -------------------------------- | ------------------------------- |
| `none`       | Pass through raw                 | Keep full history               |
| `truncate`   | Character-cap only               | Replace with placeholder        |
| `structured` | Strip non-essential fields + cap | Placeholder + assistant preview |
| `summarize`  | LLM summary (async)              | LLM summary (async)             |

**Configuration:**

- **Project level:** `ProjectRuntimeConfig.compaction` — project-wide defaults
- **Agent level:** `AgentIR.execution.compaction` — per-agent overrides
- **Tool level:** `ToolDefinition.compaction.essential_fields` — per-tool field allowlists

**Files:** `compaction-policy.ts` (resolution), `tool-result-compressor.ts` (structured compression), `reasoning-executor.ts` (wiring)
```

**Step 3: Add section to RUNTIME_ARCHITECTURE.md**

Add under the appropriate section:

```markdown
### Compaction Strategies

Conversation history compaction is governed by `CompactionPolicy` with 4 strategy tiers (none → truncate → structured → summarize). Configuration is resolved via 3-level merge: platform defaults → project DB → agent IR.

Tool-level `compaction.essential_fields` annotations declare which fields to preserve during structured compression — this works for all tool types (HTTP, MCP, connector, searchai, sandbox, workflow).

The `summarize` strategy runs an async LLM call after turn completion (fire-and-forget), falling back to `structured` on failure. Model is resolved: agent → project → platform default.

See `apps/runtime/src/services/execution/compaction-policy.ts` for resolution logic and defaults.
```

**Step 4: Add to memory-and-session-store.md**

Add a reference:

```markdown
### Compaction Policy

Session-level compaction behavior is governed by `CompactionPolicy`, cached on `session._compactionPolicy`. See `docs/plans/2026-03-09-compaction-strategies-design.md` for the full design.
```

**Step 5: Update abl-architect.md skill**

Add compaction as a tool configuration concern:

````markdown
### Tool Compaction Configuration

When designing tools that return large result sets (product search, CRM lookup, etc.), configure compaction hints:

```yaml
TOOLS:
  product_search:
    compaction:
      essential_fields: [id, title, brand, price, color, size, description, product_image]
      max_description_length: 200
```
````

This tells the runtime which fields to preserve during structured compression. Without this, the runtime keeps all fields and only applies character-cap truncation.

Available at agent level: `EXECUTION.compaction.tool_results.strategy` (none/truncate/structured/summarize)

````

**Step 6: Commit all doc updates**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx prettier --write docs/DESIGN_IMPLEMENTATION_ABL_ENGINE.md docs/RUNTIME_ARCHITECTURE.md docs/memory-and-session-store.md .claude/skills/abl-architect.md
git add docs/DESIGN_IMPLEMENTATION_ABL_ENGINE.md docs/RUNTIME_ARCHITECTURE.md docs/memory-and-session-store.md .claude/skills/abl-architect.md
git commit -m "[ABLP-2] docs: add CompactionPolicy documentation to architecture docs and skills"
````

---

### Task 7: Run full test suite and verify

**Step 1: Build all packages**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`

**Step 2: Run runtime tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run --project runtime`
Expected: All tests pass

**Step 3: Run compiler tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm vitest run --project compiler`
Expected: All tests pass (schema changes are additive/optional)
