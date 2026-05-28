# Knowledge Auto-Generation + L3 RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-written knowledge cards with auto-generated cards from docs-internal MDX, and add a BM25 L3 RAG fallback layer that fills remaining token budget with relevant doc chunks.

**Architecture:** Build-time pipeline in `tools/abl-docs/` reads MDX files from `apps/docs-internal/content/`, generates compressed L2 card `.ts` files and a BM25 index JSON. At runtime, `card-router.ts` loads L2 cards by regex match (unchanged), then fills remaining budget with L3 BM25-ranked chunks. L0 (platform-limits.ts) stays hand-curated.

**Tech Stack:** TypeScript, Node.js, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-24-knowledge-auto-gen-l3-rag-design.md`

---

## File Structure

```
NEW FILES:
  tools/abl-docs/card-mapping.ts          — MDX→card mapping config (shared by generator + router)
  tools/abl-docs/card-generator.ts        — MDX → compressed .ts card files
  tools/abl-docs/l3-index-builder.ts      — MDX → BM25 index JSON
  packages/arch-ai/src/knowledge/cards/_mapping.ts        — re-exports mapping for runtime dedup
  packages/arch-ai/src/knowledge/cards/generated/*.ts     — 30 auto-generated card files
  packages/arch-ai/src/knowledge/l3-search.ts             — BM25 scorer (~80 lines)
  packages/arch-ai/src/knowledge/l3-index.json            — pre-built BM25 index (~1 MB)
  packages/arch-ai/src/__tests__/l3-search.test.ts        — L3 search tests
  packages/arch-ai/src/__tests__/card-generator.test.ts   — card generation tests

MODIFIED FILES:
  tools/abl-docs/generate.ts              — call card + index generators
  tools/abl-docs/shared.ts                — export card + index artifact functions
  packages/arch-ai/src/knowledge/card-router.ts   — L3 fallthrough after L2
  packages/arch-ai/src/knowledge/index.ts          — export L3 types + generated cards
  packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts — update imports
  packages/arch-ai/src/__tests__/build-prompt-contract.test.ts         — update imports

DELETED FILES:
  packages/arch-ai/src/knowledge/cards/abl-anatomy.ts
  packages/arch-ai/src/knowledge/cards/attachments-kb.ts
  packages/arch-ai/src/knowledge/cards/behavior-profiles.ts
  packages/arch-ai/src/knowledge/cards/cel-functions.ts
  packages/arch-ai/src/knowledge/cards/cel-pitfalls.ts
  packages/arch-ai/src/knowledge/cards/cross-agent-contracts.ts
  packages/arch-ai/src/knowledge/cards/diagnostics-workflow.ts
  packages/arch-ai/src/knowledge/cards/error-handling.ts
  packages/arch-ai/src/knowledge/cards/escalate-a2a.ts
  packages/arch-ai/src/knowledge/cards/execution-config.ts
  packages/arch-ai/src/knowledge/cards/flow-digressions.ts
  packages/arch-ai/src/knowledge/cards/flow-patterns.ts
  packages/arch-ai/src/knowledge/cards/flow-reasoning-zones.ts
  packages/arch-ai/src/knowledge/cards/flow-transform.ts
  packages/arch-ai/src/knowledge/cards/gather-fields.ts
  packages/arch-ai/src/knowledge/cards/gather-validation-pii.ts
  packages/arch-ai/src/knowledge/cards/guardrails-tiers.ts
  packages/arch-ai/src/knowledge/cards/handoff-delegate.ts
  packages/arch-ai/src/knowledge/cards/hooks-lifecycle.ts
  packages/arch-ai/src/knowledge/cards/limitations-vs-constraints.ts
  packages/arch-ai/src/knowledge/cards/memory-full.ts
  packages/arch-ai/src/knowledge/cards/nlu-entities.ts
  packages/arch-ai/src/knowledge/cards/observer-analytics.ts
  packages/arch-ai/src/knowledge/cards/project-config.ts
  packages/arch-ai/src/knowledge/cards/rich-content.ts
  packages/arch-ai/src/knowledge/cards/routing-intents.ts
  packages/arch-ai/src/knowledge/cards/testing-workflow.ts
  packages/arch-ai/src/knowledge/cards/tool-binding-auth.ts
  packages/arch-ai/src/knowledge/cards/tool-resolution.ts
  packages/arch-ai/src/knowledge/cards/tool-templates.ts
```

---

## Phase 1: Scaffold (no behavior change)

### Task 1: Create the card mapping config

**Files:**

- Create: `tools/abl-docs/card-mapping.ts`
- Create: `packages/arch-ai/src/knowledge/cards/_mapping.ts`

This is the shared source of truth declaring which MDX files feed which card, the regex patterns for each card, and any content that must be forcibly preserved.

- [ ] **Step 1: Create `tools/abl-docs/card-mapping.ts`**

````typescript
// tools/abl-docs/card-mapping.ts
// Shared MDX → card mapping config. Used by:
//   - card-generator.ts (build time: MDX → .ts card files)
//   - _mapping.ts re-export (runtime: L3 deduplication)

export interface CardMappingEntry {
  /** Card ID — must match the existing CARD_REGISTRY id in card-router.ts */
  id: string;
  /** Export constant name — e.g. 'FLOW_PATTERNS_CARD' */
  exportName: string;
  /** Card title used as the H2 heading in the generated card */
  title: string;
  /** Primary MDX sources: relative paths from apps/docs-internal/content/ */
  sources: Array<{
    file: string;
    sections?: string[];
  }>;
  /** Content blocks to forcibly include even if MDX doesn't contain them */
  preserveContent?: string[];
  /** Per-card token cap (chars / 4). Default 800 */
  maxTokens?: number;
}

export const CARD_MAPPINGS: CardMappingEntry[] = [
  // ═══════════════════════════════════════════════════════════════
  // ABL Structure & Identity
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'abl-anatomy',
    exportName: 'ABL_ANATOMY_CARD',
    title: 'ABL Anatomy — All Sections at a Glance',
    sources: [
      { file: 'abl-reference/language-overview.mdx' },
      {
        file: 'abl-reference/agent-declaration.mdx',
        sections: ['Agent declaration', 'File structure'],
      },
    ],
  },
  {
    id: 'execution-config',
    exportName: 'EXECUTION_CONFIG_CARD',
    title: 'EXECUTION — Model, Reasoning, Timeouts, Compaction',
    sources: [{ file: 'abl-reference/agent-declaration.mdx', sections: ['Execution'] }],
  },
  {
    id: 'limitations-vs-constraints',
    exportName: 'LIMITATIONS_VS_CONSTRAINTS_CARD',
    title: 'LIMITATIONS vs CONSTRAINTS vs GUARDRAILS',
    sources: [
      { file: 'abl-reference/memory-and-constraints.mdx', sections: ['Constraints'] },
      { file: 'abl-reference/guardrails.mdx', sections: ['Overview', 'Three-tier'] },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // FLOW Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'flow-patterns',
    exportName: 'FLOW_PATTERNS_CARD',
    title: 'FLOW — Step Shapes, Branching, Transitions',
    sources: [{ file: 'abl-reference/flow.mdx' }],
  },
  {
    id: 'flow-reasoning-zones',
    exportName: 'FLOW_REASONING_ZONES_CARD',
    title: 'REASONING Zones — LLM-Driven Steps Inside Scripted FLOW',
    sources: [{ file: 'abl-reference/flow.mdx', sections: ['Reasoning'] }],
  },
  {
    id: 'flow-transform',
    exportName: 'FLOW_TRANSFORM_CARD',
    title: "TRANSFORM — ABL's Array Pipeline",
    sources: [
      { file: 'abl-reference/flow.mdx', sections: ['TRANSFORM'] },
      { file: 'guides/memory-and-state.mdx', sections: ['TRANSFORM'] },
    ],
  },
  {
    id: 'flow-digressions',
    exportName: 'FLOW_DIGRESSIONS_CARD',
    title: 'Digressions & Sub-Intents — Handling Off-Script User Input',
    sources: [{ file: 'abl-reference/flow.mdx', sections: ['Digression'] }],
  },

  // ═══════════════════════════════════════════════════════════════
  // GATHER Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'gather-fields',
    exportName: 'GATHER_FIELDS_CARD',
    title: 'GATHER — Field Declaration & Extraction Pipeline',
    sources: [
      { file: 'abl-reference/gather.mdx' },
      { file: 'guides/data-collection-with-gather.mdx' },
    ],
    preserveContent: [
      '### 4-Tier Extraction Pipeline\nWhen a user message arrives during GATHER:\n1. **Trivial-input skip** — "hi", "ok", single-char messages are short-circuited (saves ~1500 tokens).\n2. **JS libs** — chrono-node, libphonenumber-js for dates, phones, currency.\n3. **NLU sidecar** — embeddings-based entity resolver (enterprise only).\n4. **LLM tool-call** — `_extract_entities` function call (~$0.003/turn).\n5. **Regex fallback** — fields with `PATTERN:` declaration.',
    ],
  },
  {
    id: 'gather-validation-pii',
    exportName: 'GATHER_VALIDATION_PII_CARD',
    title: 'GATHER — Validation Modes & PII Handling',
    sources: [{ file: 'abl-reference/gather.mdx', sections: ['Validation', 'Sensitive'] }],
  },

  // ═══════════════════════════════════════════════════════════════
  // Tools Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'tool-binding-auth',
    exportName: 'TOOL_BINDING_AUTH_CARD',
    title: 'Tool Binding & Auth — Types, Declaration, Authentication',
    sources: [{ file: 'abl-reference/tools.mdx' }, { file: 'guides/tools-and-integrations.mdx' }],
    preserveContent: [
      "### 7 Auth Error Codes\n| Code | When |\n|---|---|\n| AUTH_PROFILE_NOT_FOUND | Profile lookup miss |\n| AUTH_PROFILE_TOKEN_REQUIRED | OAuth grant missing — user hasn't connected |\n| AUTH_PROFILE_CONFIG_VAR_NOT_FOUND | Template config var unresolvable |\n| AUTH_PROFILE_USER_CONTEXT_REQUIRED | User-scoped OAuth but no userId on session |\n| AUTH_PROFILE_TOKEN_URL_MISSING | Client credentials without tokenUrl |\n| AUTH_PROFILE_TOKEN_URL_BLOCKED | Token URL fails SSRF validator |\n| AUTH_PROFILE_CLIENT_CREDENTIALS_INVALID | Missing clientId/clientSecret |",
    ],
  },
  {
    id: 'tool-resolution',
    exportName: 'TOOL_RESOLUTION_CARD',
    title: 'Tool Resolution — How Names Become Implementations',
    sources: [{ file: 'abl-reference/tools.mdx', sections: ['Resolution', 'MCP'] }],
  },
  {
    id: 'tool-templates',
    exportName: 'TOOL_TEMPLATES_CARD',
    title: 'Tool Templates — Placeholder Namespaces & Secrets Resolution',
    sources: [{ file: 'abl-reference/rich-content-and-expressions.mdx', sections: ['Template'] }],
  },

  // ═══════════════════════════════════════════════════════════════
  // Multi-Agent Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'handoff-delegate',
    exportName: 'HANDOFF_DELEGATE_CARD',
    title: 'HANDOFF vs DELEGATE — Agent-to-Agent Control Transfer',
    sources: [
      { file: 'abl-reference/multi-agent-and-supervisor.mdx', sections: ['HANDOFF', 'DELEGATE'] },
      { file: 'guides/agent-collaboration-and-handoff.mdx' },
    ],
  },
  {
    id: 'routing-intents',
    exportName: 'ROUTING_INTENTS_CARD',
    title: 'Routing & Intent Classification — Supervisor Patterns',
    sources: [
      { file: 'abl-reference/multi-agent-and-supervisor.mdx', sections: ['Routing', 'SUPERVISOR'] },
      { file: 'guides/multi-agent-orchestration.mdx' },
    ],
  },
  {
    id: 'cross-agent-contracts',
    exportName: 'CROSS_AGENT_CONTRACTS_CARD',
    title: 'Cross-Agent Contracts — Type Safety Across Agent Boundaries',
    sources: [
      {
        file: 'abl-reference/multi-agent-and-supervisor.mdx',
        sections: ['Contract', 'Validation'],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Safety & Quality
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'guardrails-tiers',
    exportName: 'GUARDRAILS_TIERS_CARD',
    title: 'GUARDRAILS — Three-Tier Safety System',
    sources: [
      { file: 'abl-reference/guardrails.mdx' },
      { file: 'guides/safety-and-guardrails.mdx' },
    ],
  },
  {
    id: 'error-handling',
    exportName: 'ERROR_HANDLING_CARD',
    title: 'Error Handling — Resolution Chain & Recovery',
    sources: [{ file: 'abl-reference/lifecycle-and-hooks.mdx', sections: ['ON_ERROR'] }],
  },
  {
    id: 'escalate-a2a',
    exportName: 'ESCALATE_A2A_CARD',
    title: 'ESCALATE & A2A — Human Handoff & Cross-Service Communication',
    sources: [{ file: 'abl-reference/multi-agent-and-supervisor.mdx', sections: ['ESCALATE'] }],
  },

  // ═══════════════════════════════════════════════════════════════
  // CEL & Expressions
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'cel-functions',
    exportName: 'CEL_FUNCTIONS_CARD',
    title: 'CEL Functions — Built-In Reference',
    sources: [
      {
        file: 'abl-reference/rich-content-and-expressions.mdx',
        sections: ['Expression', 'Function'],
      },
      { file: 'abl-reference/data-types-and-utilities.mdx' },
    ],
    preserveContent: [
      '### Usage in Different Constructs\n\n```yaml\n# In CONSTRAINTS:\nREQUIRE: "kyc_status == \'verified\'"\n\n# In GATHER VALIDATION:\nVALIDATION: "size(account_number) >= 8 && size(account_number) <= 12"\n\n# In FLOW ON_INPUT:\nIF: "input contains \'yes\' || input contains \'confirm\'"\n\n# In COMPLETE:\nCOMPLETE:\n  - WHEN: "has(order_id) && payment_status == \'confirmed\'"\n    RESPOND: ""\n\n# In TRANSFORM MAP:\ndisplay_amount: FORMAT_CURRENCY(ABS(txn.amount), "USD")\n```',
    ],
  },
  {
    id: 'cel-pitfalls',
    exportName: 'CEL_PITFALLS_CARD',
    title: 'CEL Pitfalls — What Silently Bites',
    sources: [{ file: 'abl-reference/data-types-and-utilities.mdx', sections: ['Pitfall'] }],
  },

  // ═══════════════════════════════════════════════════════════════
  // Memory & State
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'memory-full',
    exportName: 'MEMORY_FULL_CARD',
    title: 'MEMORY — Four Sub-Blocks for Agent State',
    sources: [
      { file: 'abl-reference/memory-and-constraints.mdx', sections: ['Memory'] },
      { file: 'guides/memory-and-state.mdx' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Supporting Constructs
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'nlu-entities',
    exportName: 'NLU_ENTITIES_CARD',
    title: 'NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES',
    sources: [{ file: 'abl-reference/nlu.mdx' }],
  },
  {
    id: 'behavior-profiles',
    exportName: 'BEHAVIOR_PROFILES_CARD',
    title: 'BEHAVIOR_PROFILE — Deployment-Time Overrides',
    sources: [{ file: 'abl-reference/agent-declaration.mdx', sections: ['BEHAVIOR_PROFILE'] }],
  },
  {
    id: 'hooks-lifecycle',
    exportName: 'HOOKS_LIFECYCLE_CARD',
    title: 'HOOKS, ACTION_HANDLERS, RETURN_HANDLERS, MESSAGES, COMPLETE',
    sources: [{ file: 'abl-reference/lifecycle-and-hooks.mdx' }],
  },
  {
    id: 'rich-content',
    exportName: 'RICH_CONTENT_CARD',
    title: 'Rich Content — Widgets, Charts, Quick Replies',
    sources: [
      { file: 'abl-reference/rich-content-and-expressions.mdx', sections: ['Rich Content'] },
    ],
  },
  {
    id: 'attachments-kb',
    exportName: 'ATTACHMENTS_KB_CARD',
    title: 'Attachments & Knowledge Bases',
    sources: [
      { file: 'abl-reference/agent-declaration.mdx', sections: ['Attachment'] },
      { file: 'guides/knowledge-bases.mdx' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Project-Level
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'project-config',
    exportName: 'PROJECT_CONFIG_CARD',
    title: 'Project Configuration — Platform-Level Settings',
    sources: [
      { file: 'guides/publishing-and-operations.mdx' },
      { file: 'admin/workspace-configuration.mdx' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Workflow Cards
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'diagnostics-workflow',
    exportName: 'DIAGNOSTICS_WORKFLOW_CARD',
    title: 'Diagnostics — Validation, Debugging, Health Checks',
    sources: [{ file: 'guides/testing-and-evaluation.mdx', sections: ['Diagnostic'] }],
  },
  {
    id: 'observer-analytics',
    exportName: 'OBSERVER_ANALYTICS_CARD',
    title: 'Observer & Analytics — Briefings, Metrics, Improvement',
    sources: [{ file: 'guides/testing-and-evaluation.mdx', sections: ['Analytic', 'Metric'] }],
  },
  {
    id: 'testing-workflow',
    exportName: 'TESTING_WORKFLOW_CARD',
    title: 'Testing & Evaluation — Strategy, Scenarios, Coverage',
    sources: [{ file: 'guides/testing-and-evaluation.mdx' }],
  },
];

/** Build a Set of MDX files covered by a set of card IDs (for L3 deduplication) */
export function getCoveredFiles(matchedCardIds: string[]): Set<string> {
  const covered = new Set<string>();
  const matchedSet = new Set(matchedCardIds);
  for (const card of CARD_MAPPINGS) {
    if (matchedSet.has(card.id)) {
      for (const source of card.sources) {
        covered.add(source.file);
      }
    }
  }
  return covered;
}
````

- [ ] **Step 2: Create the runtime re-export `_mapping.ts`**

```typescript
// packages/arch-ai/src/knowledge/cards/_mapping.ts
// Re-exports the mapping for runtime L3 deduplication.
// The full mapping config lives in tools/abl-docs/card-mapping.ts
// and is consumed at build time. This file exports only the
// getCoveredFiles function needed at runtime.

export { getCoveredFiles } from '../../../../tools/abl-docs/card-mapping.js';
```

- [ ] **Step 3: Verify build**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS (new files are not consumed yet)

- [ ] **Step 4: Commit**

```bash
git add tools/abl-docs/card-mapping.ts packages/arch-ai/src/knowledge/cards/_mapping.ts
git commit -m "[ABLP-162] feat(compiler): add MDX-to-card mapping config for knowledge auto-generation"
```

---

### Task 2: Create the L3 BM25 search module

**Files:**

- Create: `packages/arch-ai/src/knowledge/l3-search.ts`
- Create: `packages/arch-ai/src/__tests__/l3-search.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/arch-ai/src/__tests__/l3-search.test.ts
import { describe, expect, it } from 'vitest';
import { buildBm25Index, searchBm25, type L3Index, type L3Chunk } from '../knowledge/l3-search.js';

const SAMPLE_CHUNKS: L3Chunk[] = [
  {
    file: 'abl-reference/gather.mdx',
    heading: 'GATHER (information collection)',
    text: 'The GATHER section defines structured information that the agent needs to collect from the user during a conversation. Each field specifies a data type, prompt, validation rules, and collection behavior.',
    words: 30,
  },
  {
    file: 'abl-reference/flow.mdx',
    heading: 'FLOW (structured execution steps)',
    text: 'The FLOW section adds structured execution steps to any agent. It defines a step-by-step execution graph where each step declares actions and transitions to other steps.',
    words: 28,
  },
  {
    file: 'guides/memory-and-state.mdx',
    heading: 'Memory & State',
    text: 'ABL agents use two kinds of memory to track information during and across conversations. Session variables hold data within a single conversation. Persistent memory stores facts that survive across sessions.',
    words: 32,
  },
  {
    file: 'abl-reference/tools.mdx',
    heading: 'MCP tools',
    text: 'MCP Model Context Protocol tools connect to external MCP servers that provide tool definitions dynamically. The agent discovers available tools at session start from the MCP server.',
    words: 28,
  },
];

describe('L3 BM25 Search', () => {
  const index = buildBm25Index(SAMPLE_CHUNKS);

  it('builds index with correct metadata', () => {
    expect(index.N).toBe(4);
    expect(index.avgdl).toBeGreaterThan(0);
    expect(Object.keys(index.df).length).toBeGreaterThan(0);
    expect(index.chunks).toHaveLength(4);
  });

  it('returns ranked results for a query', () => {
    const results = searchBm25(index, 'gather collect user information fields', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toBe('abl-reference/gather.mdx');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns flow results for flow query', () => {
    const results = searchBm25(index, 'FLOW step execution graph transitions', 3);
    expect(results[0].file).toBe('abl-reference/flow.mdx');
  });

  it('returns memory results for memory query', () => {
    const results = searchBm25(index, 'persistent memory session variables', 3);
    expect(results[0].file).toBe('guides/memory-and-state.mdx');
  });

  it('returns MCP results for MCP query', () => {
    const results = searchBm25(index, 'MCP server tool connect', 3);
    expect(results[0].file).toBe('abl-reference/tools.mdx');
  });

  it('returns empty for completely unrelated query', () => {
    const results = searchBm25(index, 'xyzzy frobnicator', 3);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('respects topK limit', () => {
    const results = searchBm25(index, 'agent execution steps memory tools', 2);
    expect(results).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/Sri.Harsha/abl-platform && pnpm vitest run packages/arch-ai/src/__tests__/l3-search.test.ts`
Expected: FAIL — module `../knowledge/l3-search.js` not found

- [ ] **Step 3: Implement `l3-search.ts`**

````typescript
// packages/arch-ai/src/knowledge/l3-search.ts

const CHARS_PER_TOKEN = 4;

export interface L3Chunk {
  file: string;
  heading: string;
  text: string;
  words: number;
}

export interface L3Index {
  version: number;
  generatedAt: string;
  chunks: L3Chunk[];
  df: Record<string, number>;
  avgdl: number;
  N: number;
  tfPerChunk: Array<{ tf: Record<string, number>; length: number }>;
}

export interface L3SearchResult {
  file: string;
  heading: string;
  text: string;
  score: number;
}

function tokenize(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[|#*_\->[\](){}]/g, ' ')
    .toLowerCase();
  return cleaned.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

export function buildBm25Index(chunks: L3Chunk[]): L3Index {
  const N = chunks.length;
  const df: Record<string, number> = {};
  const tfPerChunk: Array<{ tf: Record<string, number>; length: number }> = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] ?? 0) + 1;
    }
    tfPerChunk.push({ tf, length: tokens.length });
    for (const t of Object.keys(tf)) {
      df[t] = (df[t] ?? 0) + 1;
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    chunks,
    df,
    avgdl: N > 0 ? totalLength / N : 0,
    N,
    tfPerChunk,
  };
}

export function searchBm25(index: L3Index, query: string, topK: number): L3SearchResult[] {
  const k1 = 1.5;
  const b = 0.75;
  const queryTokens = tokenize(query);
  const { N, df, tfPerChunk, avgdl, chunks } = index;
  const scores = new Float64Array(N);

  for (const qt of queryTokens) {
    const docFreq = df[qt] ?? 0;
    if (docFreq === 0) continue;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    for (let i = 0; i < N; i++) {
      const tf = tfPerChunk[i].tf[qt] ?? 0;
      if (tf === 0) continue;
      const dl = tfPerChunk[i].length;
      scores[i] += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
    }
  }

  const indices = Array.from({ length: N }, (_, i) => i);
  indices.sort((a, b2) => scores[b2] - scores[a]);

  return indices.slice(0, topK).map((i) => ({
    file: chunks[i].file,
    heading: chunks[i].heading,
    text: chunks[i].text,
    score: scores[i],
  }));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

let _cachedIndex: L3Index | null = null;

export function loadL3Index(): L3Index {
  if (_cachedIndex) return _cachedIndex;
  // Dynamic import of the pre-built JSON index
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const raw = require('./l3-index.json') as L3Index;
  // Rebuild tfPerChunk from chunks (not stored in JSON to save space)
  if (!raw.tfPerChunk) {
    const tfPerChunk: Array<{ tf: Record<string, number>; length: number }> = [];
    for (const chunk of raw.chunks) {
      const tokens = tokenize(chunk.text);
      const tf: Record<string, number> = {};
      for (const t of tokens) {
        tf[t] = (tf[t] ?? 0) + 1;
      }
      tfPerChunk.push({ tf, length: tokens.length });
    }
    raw.tfPerChunk = tfPerChunk;
  }
  _cachedIndex = raw;
  return _cachedIndex;
}

export function resetL3Cache(): void {
  _cachedIndex = null;
}
````

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/Sri.Harsha/abl-platform && pnpm vitest run packages/arch-ai/src/__tests__/l3-search.test.ts`
Expected: PASS — all 7 tests green

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/__tests__/l3-search.test.ts
git add packages/arch-ai/src/knowledge/l3-search.ts packages/arch-ai/src/__tests__/l3-search.test.ts
git commit -m "[ABLP-162] feat(compiler): add BM25 search module for L3 knowledge retrieval"
```

---

### Task 3: Create the L3 index builder

**Files:**

- Create: `tools/abl-docs/l3-index-builder.ts`

- [ ] **Step 1: Create `l3-index-builder.ts`**

````typescript
// tools/abl-docs/l3-index-builder.ts
import { promises as fs } from 'fs';
import path from 'path';

export interface L3BuilderChunk {
  file: string;
  heading: string;
  text: string;
  words: number;
}

export interface L3BuilderIndex {
  version: number;
  generatedAt: string;
  chunks: L3BuilderChunk[];
  df: Record<string, number>;
  avgdl: number;
  N: number;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

function tokenize(text: string): string[] {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/[|#*_\->[\](){}]/g, ' ')
    .toLowerCase();
  return cleaned.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

function extractHeading(section: string): string {
  const match = section.match(/^#{2,3}\s+(.+)/m);
  return match ? match[1].trim() : 'untitled';
}

export function chunkMdxFile(filePath: string, content: string): L3BuilderChunk[] {
  const body = stripFrontmatter(content);
  const h2Sections = body.split(/(?=^## )/m);
  const chunks: L3BuilderChunk[] = [];

  for (const section of h2Sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).length;
    if (words < 10) continue;

    if (words <= 600) {
      chunks.push({
        file: filePath,
        heading: extractHeading(trimmed),
        text: trimmed,
        words,
      });
    } else {
      const h3Sections = trimmed.split(/(?=^### )/m);
      for (const sub of h3Sections) {
        const subTrimmed = sub.trim();
        const subWords = subTrimmed.split(/\s+/).length;
        if (subWords >= 10) {
          chunks.push({
            file: filePath,
            heading: extractHeading(subTrimmed),
            text: subTrimmed,
            words: subWords,
          });
        }
      }
    }
  }

  return chunks;
}

export function buildL3Index(chunks: L3BuilderChunk[]): L3BuilderIndex {
  const N = chunks.length;
  const df: Record<string, number> = {};
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    totalLength += tokens.length;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        df[t] = (df[t] ?? 0) + 1;
        seen.add(t);
      }
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    chunks,
    df,
    avgdl: N > 0 ? totalLength / N : 0,
    N,
  };
}

async function collectMdxFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMdxFiles(full)));
    } else if (entry.name.endsWith('.mdx')) {
      results.push(full);
    }
  }
  return results;
}

export async function generateL3Index(contentDir: string): Promise<L3BuilderIndex> {
  const files = await collectMdxFiles(contentDir);
  const allChunks: L3BuilderChunk[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf8');
    const relativePath = path.relative(contentDir, filePath);
    const chunks = chunkMdxFile(relativePath, content);
    allChunks.push(...chunks);
  }

  return buildL3Index(allChunks);
}
````

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit tools/abl-docs/l3-index-builder.ts` (or rely on build)
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write tools/abl-docs/l3-index-builder.ts
git add tools/abl-docs/l3-index-builder.ts
git commit -m "[ABLP-162] feat(compiler): add L3 BM25 index builder for docs-internal MDX"
```

---

### Task 4: Create the L2 card generator

**Files:**

- Create: `tools/abl-docs/card-generator.ts`

- [ ] **Step 1: Create `card-generator.ts`**

````typescript
// tools/abl-docs/card-generator.ts
import { promises as fs } from 'fs';
import path from 'path';
import type { CardMappingEntry } from './card-mapping.js';
import { CARD_MAPPINGS } from './card-mapping.js';

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 800;

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

function extractSections(body: string, sectionFilters?: string[]): string {
  if (!sectionFilters || sectionFilters.length === 0) return body;

  const h2Sections = body.split(/(?=^## )/m);
  const matched: string[] = [];

  for (const section of h2Sections) {
    const heading = section.match(/^#{2,3}\s+(.+)/m)?.[1]?.trim() ?? '';
    const matchesFilter = sectionFilters.some((f) =>
      heading.toLowerCase().includes(f.toLowerCase()),
    );
    if (matchesFilter) {
      matched.push(section.trim());
    }
  }

  return matched.length > 0 ? matched.join('\n\n') : body;
}

function compressToCardFormat(rawContent: string, maxChars: number): string {
  let content = rawContent;

  // Keep markdown tables and code blocks intact — they're the most valuable for LLM
  // Compress prose paragraphs to bullet points
  const lines = content.split('\n');
  const compressed: string[] = [];
  let inCodeBlock = false;
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      compressed.push(line);
      continue;
    }
    if (inCodeBlock) {
      compressed.push(line);
      continue;
    }
    if (line.startsWith('|')) {
      inTable = true;
      compressed.push(line);
      continue;
    }
    if (inTable && !line.startsWith('|')) {
      inTable = false;
    }
    // Keep headings
    if (line.startsWith('#')) {
      compressed.push(line);
      continue;
    }
    // Keep bullet points
    if (line.match(/^\s*[-*]\s/)) {
      compressed.push(line);
      continue;
    }
    // Compress long prose lines to a bullet
    const trimmed = line.trim();
    if (trimmed.length > 100) {
      // Take first sentence
      const firstSentence = trimmed.match(/^[^.!?]+[.!?]/)?.[0] ?? trimmed.slice(0, 100);
      compressed.push(`- ${firstSentence}`);
    } else if (trimmed.length > 0) {
      compressed.push(line);
    }
  }

  content = compressed.join('\n');

  // Hard truncate if still over budget
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    // Clean up: don't cut mid-line
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline > maxChars * 0.8) {
      content = content.slice(0, lastNewline);
    }
  }

  return content;
}

export interface GeneratedCard {
  id: string;
  exportName: string;
  fileName: string;
  content: string;
  tsSource: string;
}

export async function generateCard(
  entry: CardMappingEntry,
  contentDir: string,
): Promise<GeneratedCard> {
  const maxTokens = entry.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const parts: string[] = [];

  for (const source of entry.sources) {
    const filePath = path.join(contentDir, source.file);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      console.warn(`Warning: MDX source not found: ${source.file} (card: ${entry.id})`);
      continue;
    }
    const body = stripFrontmatter(content);
    const extracted = extractSections(body, source.sections);
    parts.push(extracted);
  }

  let combined = parts.join('\n\n');

  // Inject preserved content blocks
  if (entry.preserveContent && entry.preserveContent.length > 0) {
    combined += '\n\n' + entry.preserveContent.join('\n\n');
  }

  // Compress to fit token budget (reserve space for title heading)
  const titleLine = `## ${entry.title}`;
  const budgetForBody = maxChars - titleLine.length - 10;
  const compressed = compressToCardFormat(combined, budgetForBody);

  const cardContent = `${titleLine}\n\n${compressed}`;

  // Generate TypeScript source
  const escapedContent = cardContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const tsSource = `// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: ${entry.sources.map((s) => s.file).join(', ')}
// Regenerate: pnpm abl:docs:generate

export const ${entry.exportName} = \`${escapedContent}\`;
`;

  return {
    id: entry.id,
    exportName: entry.exportName,
    fileName: `${entry.id}.ts`,
    content: cardContent,
    tsSource,
  };
}

export async function generateAllCards(contentDir: string): Promise<GeneratedCard[]> {
  const cards: GeneratedCard[] = [];
  for (const entry of CARD_MAPPINGS) {
    cards.push(await generateCard(entry, contentDir));
  }
  return cards;
}
````

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit tools/abl-docs/card-generator.ts`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
npx prettier --write tools/abl-docs/card-generator.ts
git add tools/abl-docs/card-generator.ts
git commit -m "[ABLP-162] feat(compiler): add L2 card generator from docs-internal MDX"
```

---

### Task 5: Wire generators into the existing pipeline

**Files:**

- Modify: `tools/abl-docs/shared.ts`

Note: `generate.ts` needs no changes — it already calls `writeGeneratedArtifacts()` which we're extending in `shared.ts`.

- [ ] **Step 1: Extend `shared.ts` to include card + index artifacts**

Add these imports and artifact entries to `getGeneratedArtifacts()` in `tools/abl-docs/shared.ts`:

At the top, add imports:

```typescript
import { generateAllCards } from './card-generator.js';
import { generateL3Index } from './l3-index-builder.js';
```

Inside `getGeneratedArtifacts()`, after the existing `rawArtifacts` array, add the card and index artifacts:

```typescript
// Generate L2 knowledge cards from docs-internal MDX
const docsContentDir = path.join(REPO_ROOT, 'apps/docs-internal/content');
const generatedCards = await generateAllCards(docsContentDir);
for (const card of generatedCards) {
  rawArtifacts.push({
    relativePath: `packages/arch-ai/src/knowledge/cards/generated/${card.fileName}`,
    content: card.tsSource,
  });
}

// Generate L3 BM25 index from docs-internal MDX
const l3Index = await generateL3Index(docsContentDir);
rawArtifacts.push({
  relativePath: 'packages/arch-ai/src/knowledge/l3-index.json',
  content: JSON.stringify(l3Index, null, 2) + '\n',
});
```

- [ ] **Step 2: Run the generator to produce artifacts**

Run: `cd /Users/Sri.Harsha/abl-platform && pnpm abl:docs:generate`
Expected: Output includes the 30 generated card files + l3-index.json

- [ ] **Step 3: Verify generated files exist**

Run: `ls packages/arch-ai/src/knowledge/cards/generated/ | wc -l`
Expected: 30

Run: `ls -la packages/arch-ai/src/knowledge/l3-index.json`
Expected: File exists, ~1 MB

- [ ] **Step 4: Commit**

```bash
npx prettier --write tools/abl-docs/shared.ts
git add tools/abl-docs/shared.ts
git add packages/arch-ai/src/knowledge/cards/generated/
git add packages/arch-ai/src/knowledge/l3-index.json
git commit -m "[ABLP-162] feat(compiler): wire card generator and L3 index builder into abl:docs:generate"
```

---

## Phase 2: L2 Card Swap (content change, same API)

### Task 6: Switch card-router imports to generated cards

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts`
- Modify: `packages/arch-ai/src/knowledge/index.ts`

- [ ] **Step 1: Update all imports in `card-router.ts`**

Replace every import line from `'./cards/X.js'` to `'./cards/generated/X.js'`. The import names stay identical:

```typescript
// In card-router.ts, replace:
import { ABL_ANATOMY_CARD } from './cards/abl-anatomy.js';
// with:
import { ABL_ANATOMY_CARD } from './cards/generated/abl-anatomy.js';
```

Apply this pattern to ALL 30 card imports. The `PLATFORM_LIMITS_CARD` import from `'./platform-limits.js'` stays UNCHANGED (L0 is hand-curated).

The two cards that import from `contract-facts.ts` (`handoff-delegate` and `cross-agent-contracts` and `memory-full`) — the generated versions won't have that import since their content comes from MDX. The contract facts content must be present in the MDX or in `preserveContent`. Verify by checking: `grep "handoff.context.history" packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts`. If missing, add to `preserveContent` in the mapping and regenerate.

- [ ] **Step 2: Update `index.ts` barrel exports**

Replace all re-exports from `'./cards/X.js'` to `'./cards/generated/X.js'`.

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS

- [ ] **Step 4: Run existing tests**

Run: `pnpm vitest run packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`

If tests fail because contract facts (e.g., `handoff.context.history` syntax) are missing from generated cards, add the required content to `preserveContent` in the mapping config for those cards and regenerate.

- [ ] **Step 5: Commit import changes**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/knowledge/index.ts
git add packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/knowledge/index.ts
git commit -m "[ABLP-162] refactor(compiler): switch card-router imports to auto-generated cards"
```

---

### Task 7: Delete old hand-written card files

**Files:**

- Delete: all 30 `.ts` files in `packages/arch-ai/src/knowledge/cards/` (not `generated/`, not `_mapping.ts`)

- [ ] **Step 1: Delete old card files**

```bash
# Delete all hand-written card files (NOT generated/ or _mapping.ts)
rm packages/arch-ai/src/knowledge/cards/abl-anatomy.ts
rm packages/arch-ai/src/knowledge/cards/attachments-kb.ts
rm packages/arch-ai/src/knowledge/cards/behavior-profiles.ts
rm packages/arch-ai/src/knowledge/cards/cel-functions.ts
rm packages/arch-ai/src/knowledge/cards/cel-pitfalls.ts
rm packages/arch-ai/src/knowledge/cards/cross-agent-contracts.ts
rm packages/arch-ai/src/knowledge/cards/diagnostics-workflow.ts
rm packages/arch-ai/src/knowledge/cards/error-handling.ts
rm packages/arch-ai/src/knowledge/cards/escalate-a2a.ts
rm packages/arch-ai/src/knowledge/cards/execution-config.ts
rm packages/arch-ai/src/knowledge/cards/flow-digressions.ts
rm packages/arch-ai/src/knowledge/cards/flow-patterns.ts
rm packages/arch-ai/src/knowledge/cards/flow-reasoning-zones.ts
rm packages/arch-ai/src/knowledge/cards/flow-transform.ts
rm packages/arch-ai/src/knowledge/cards/gather-fields.ts
rm packages/arch-ai/src/knowledge/cards/gather-validation-pii.ts
rm packages/arch-ai/src/knowledge/cards/guardrails-tiers.ts
rm packages/arch-ai/src/knowledge/cards/handoff-delegate.ts
rm packages/arch-ai/src/knowledge/cards/hooks-lifecycle.ts
rm packages/arch-ai/src/knowledge/cards/limitations-vs-constraints.ts
rm packages/arch-ai/src/knowledge/cards/memory-full.ts
rm packages/arch-ai/src/knowledge/cards/nlu-entities.ts
rm packages/arch-ai/src/knowledge/cards/observer-analytics.ts
rm packages/arch-ai/src/knowledge/cards/project-config.ts
rm packages/arch-ai/src/knowledge/cards/rich-content.ts
rm packages/arch-ai/src/knowledge/cards/routing-intents.ts
rm packages/arch-ai/src/knowledge/cards/testing-workflow.ts
rm packages/arch-ai/src/knowledge/cards/tool-binding-auth.ts
rm packages/arch-ai/src/knowledge/cards/tool-resolution.ts
rm packages/arch-ai/src/knowledge/cards/tool-templates.ts
```

- [ ] **Step 2: Build to confirm no broken imports**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS

- [ ] **Step 3: Run all arch-ai tests**

Run: `pnpm vitest run --project arch-ai` (or `pnpm vitest run packages/arch-ai/src/__tests__/`)
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -u packages/arch-ai/src/knowledge/cards/
git commit -m "[ABLP-162] refactor(compiler): remove hand-written knowledge cards replaced by auto-generated"
```

---

## Phase 3: L3 Activation (new behavior)

### Task 8: Add L3 fallthrough to card-router

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts`

- [ ] **Step 1: Add L3 imports and types**

At the top of `card-router.ts`, add:

```typescript
import { loadL3Index, searchBm25, estimateTokens, type L3SearchResult } from './l3-search.js';
import { getCoveredFiles } from './cards/_mapping.js';
```

Update the `CardSelection` interface:

```typescript
export interface CardSelection {
  selectedIds: string[];
  skippedIds: string[];
  l3Chunks: L3SearchResult[];
  content: string;
  estimatedTokens: number;
}
```

- [ ] **Step 2: Add L3 retrieval logic at the end of `selectKnowledgeCards()`**

After the existing L2 matching loop (around line 820), before the return statement, add:

```typescript
// L3: BM25 fallthrough — fill remaining budget with relevant doc chunks
const l3Chunks: L3SearchResult[] = [];
if (userMessage && userMessage.trim().length > 0 && totalChars < maxChars) {
  const l3Index = loadL3Index();
  const coveredFiles = getCoveredFiles(selectedIds);
  const candidates = searchBm25(l3Index, userMessage, 10);

  for (const candidate of candidates) {
    if (candidate.score === 0) break;
    if (coveredFiles.has(candidate.file)) continue;
    const chunkChars = candidate.text.length;
    if (totalChars + chunkChars > maxChars) continue;
    parts.push(candidate.text);
    l3Chunks.push(candidate);
    totalChars += chunkChars;
  }
}
```

Update the return to include `l3Chunks`:

```typescript
return {
  selectedIds,
  skippedIds,
  l3Chunks,
  content: parts.join('\n\n'),
  estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
};
```

- [ ] **Step 3: Build and test**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS

Run: `pnpm vitest run packages/arch-ai/src/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts
git add packages/arch-ai/src/knowledge/card-router.ts
git commit -m "[ABLP-162] feat(compiler): add L3 BM25 fallthrough to knowledge card router"
```

---

### Task 9: Add L3 integration tests

**Files:**

- Create: `packages/arch-ai/src/__tests__/card-generator.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// packages/arch-ai/src/__tests__/card-generator.test.ts
import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';

describe('Knowledge card selection with L3', () => {
  it('returns L0 content when no user message', () => {
    const result = selectKnowledgeCards();
    expect(result.selectedIds).toContain('platform-limits');
    expect(result.l3Chunks).toHaveLength(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('matches L2 cards by regex and fills L3 from remaining budget', () => {
    const result = selectKnowledgeCards('how do I use GATHER to collect user information');
    expect(result.selectedIds).toContain('gather-fields');
    expect(result.estimatedTokens).toBeLessThanOrEqual(6000);
    // L3 should have filled some additional chunks
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('deduplicates L3 chunks against L2 card sources', () => {
    const result = selectKnowledgeCards('GATHER field validation and collection');
    expect(result.selectedIds).toContain('gather-fields');
    // L3 should NOT include chunks from abl-reference/gather.mdx (covered by L2)
    for (const chunk of result.l3Chunks) {
      expect(chunk.file).not.toBe('abl-reference/gather.mdx');
    }
  });

  it('retrieves L3 chunks for long-tail queries with no L2 match', () => {
    const result = selectKnowledgeCards('how do I configure workspace SSO authentication');
    // This query may not match any L2 card regex
    // But L3 should retrieve relevant chunks from admin docs
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it('respects total token budget across L0 + L2 + L3', () => {
    const result = selectKnowledgeCards('FLOW step branching ON_INPUT tools GATHER memory');
    expect(result.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it('returns l3Chunks metadata for debugging', () => {
    const result = selectKnowledgeCards('supervisor routing multi-agent orchestration');
    if (result.l3Chunks.length > 0) {
      const chunk = result.l3Chunks[0];
      expect(chunk.file).toBeTruthy();
      expect(chunk.heading).toBeTruthy();
      expect(chunk.score).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/arch-ai/src/__tests__/card-generator.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/arch-ai/src/__tests__/card-generator.test.ts
git add packages/arch-ai/src/__tests__/card-generator.test.ts
git commit -m "[ABLP-162] test(compiler): add L3 BM25 integration tests for knowledge selection"
```

---

### Task 10: Update existing tests for new import paths

**Files:**

- Modify: `packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts`
- Modify: `packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`

- [ ] **Step 1: Update imports in `abl-contract-backed-knowledge.test.ts`**

```typescript
// Replace:
import { HANDOFF_DELEGATE_CARD } from '../knowledge/cards/handoff-delegate.js';
import { CROSS_AGENT_CONTRACTS_CARD } from '../knowledge/cards/cross-agent-contracts.js';
import { MEMORY_FULL_CARD } from '../knowledge/cards/memory-full.js';

// With:
import { HANDOFF_DELEGATE_CARD } from '../knowledge/cards/generated/handoff-delegate.js';
import { CROSS_AGENT_CONTRACTS_CARD } from '../knowledge/cards/generated/cross-agent-contracts.js';
import { MEMORY_FULL_CARD } from '../knowledge/cards/generated/memory-full.js';
```

- [ ] **Step 2: Update imports in `build-prompt-contract.test.ts`**

```typescript
// Replace:
import { CEL_FUNCTIONS_CARD } from '../knowledge/cards/cel-functions.js';

// With:
import { CEL_FUNCTIONS_CARD } from '../knowledge/cards/generated/cel-functions.js';
```

- [ ] **Step 3: Run both tests**

Run: `pnpm vitest run packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts packages/arch-ai/src/__tests__/build-prompt-contract.test.ts`
Expected: PASS

If contract assertions fail (e.g., `HANDOFF_DELEGATE_CARD` doesn't contain `handoff.context.history` syntax), it means the generated card is missing contract facts. Fix by adding the required content to `preserveContent` in `tools/abl-docs/card-mapping.ts` for the affected card, regenerate with `pnpm abl:docs:generate`, and re-run tests.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts packages/arch-ai/src/__tests__/build-prompt-contract.test.ts
git add packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts packages/arch-ai/src/__tests__/build-prompt-contract.test.ts
git commit -m "[ABLP-162] test(compiler): update knowledge card test imports to generated paths"
```

---

## Phase 4: Cleanup

### Task 11: Add CI freshness check for generated artifacts

**Files:**

- No new files — `tools/abl-docs/check.ts` already calls `getOutdatedArtifacts()` from `shared.ts`, which now includes the generated cards and L3 index. The freshness check is automatic.

- [ ] **Step 1: Verify the check works**

Run: `pnpm abl:docs:check`
Expected: "ABL docs artifacts are up to date."

- [ ] **Step 2: Test staleness detection**

Manually edit one MDX file (add a comment), then run:

Run: `pnpm abl:docs:check`
Expected: "ABL docs artifacts are stale. Run `pnpm abl:docs:generate` to refresh:" with the affected generated card listed.

Revert the test edit after verification.

- [ ] **Step 3: Run full build to confirm CI integration**

Run: `pnpm build --filter=@agent-platform/docs-internal`
Expected: PASS (this runs `abl:docs:check` before `next build`)

---

### Task 12: Update barrel exports and JSDoc references

**Files:**

- Modify: `packages/arch-ai/src/knowledge/index.ts`

- [ ] **Step 1: Update `index.ts` to export L3 types**

Add these exports:

```typescript
export { searchBm25, loadL3Index, estimateTokens, resetL3Cache } from './l3-search.js';
export type { L3Index, L3Chunk, L3SearchResult } from './l3-search.js';
export { getCoveredFiles } from './cards/_mapping.js';
```

- [ ] **Step 2: Update JSDoc in `card-router.ts` header**

Replace the old header comment referencing HTML files:

```typescript
/**
 * Card Router — selects knowledge cards based on user-intent cues in the ask.
 *
 * Part of the 4-layer knowledge architecture:
 *   L0: Platform foundation (always loaded, hand-curated)
 *   L1: Specialist baselines (loaded via specialist prompts — not managed here)
 *   L2: Construct cards (intent-triggered, auto-generated from docs-internal MDX)
 *   L3: Docs RAG fallback (BM25 keyword search over docs-internal chunks)
 *
 * Selection logic:
 *   1. Always include L0 (platform foundation)
 *   2. Match user message keywords against L2 card trigger patterns
 *   3. Fill remaining token budget with L3 BM25-ranked doc chunks
 *   4. Deduplicate L3 against MDX files already covered by matched L2 cards
 */
```

- [ ] **Step 3: Build and test**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS

Run: `pnpm vitest run packages/arch-ai/src/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/index.ts packages/arch-ai/src/knowledge/card-router.ts
git add packages/arch-ai/src/knowledge/index.ts packages/arch-ai/src/knowledge/card-router.ts
git commit -m "[ABLP-162] docs(compiler): update knowledge barrel exports and JSDoc for L3 architecture"
```

---

### Task 13: Final verification

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `pnpm vitest run packages/arch-ai/src/__tests__/`
Expected: PASS

- [ ] **Step 3: Freshness check**

Run: `pnpm abl:docs:check`
Expected: "ABL docs artifacts are up to date."

- [ ] **Step 4: Spot-check generated card quality**

Read 3 generated cards and compare against the MDX source:

- `packages/arch-ai/src/knowledge/cards/generated/flow-patterns.ts` vs `apps/docs-internal/content/abl-reference/flow.mdx`
- `packages/arch-ai/src/knowledge/cards/generated/gather-fields.ts` vs `apps/docs-internal/content/abl-reference/gather.mdx`
- `packages/arch-ai/src/knowledge/cards/generated/tool-binding-auth.ts` vs `apps/docs-internal/content/abl-reference/tools.mdx`

Verify: generated card contains key syntax tables, code examples, and anti-patterns from the MDX.

- [ ] **Step 5: Verify L3 retrieval for long-tail query**

Run a quick node script:

```bash
node -e "
  const { selectKnowledgeCards } = require('./packages/arch-ai/dist/knowledge/card-router.js');
  const r = selectKnowledgeCards('how do I configure workspace SSO');
  console.log('L2 cards:', r.selectedIds);
  console.log('L3 chunks:', r.l3Chunks.length, r.l3Chunks.map(c => c.file));
  console.log('Total tokens:', r.estimatedTokens);
"
```

Expected: L3 chunks include content from `admin/security-and-authentication.mdx` or similar.
