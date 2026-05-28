# Search Citations — Tool Loop Fix — Low-Level Design

## Problem

Citation support only works on the **KB fast path** (KB-only agents). When an agent has mixed tools (KB + non-KB), the **tool loop path** is used instead, and:

1. The LLM receives **no instruction** to cite sources with `[1]`, `[2]` markers
2. `buildCitationMap()` is **never called** — `finalCitations` stays `undefined`
3. Users get zero citations in responses from mixed-tool agents

This is likely the most common production config (agents with both KB and action tools).

## Approach

Three changes, all in the runtime package:

1. **Add citation instruction to the prompt catalog** — a Handlebars conditional block
2. **Pass `citations_enabled` flag into template context** — from discovery manifest
3. **Collect search tool results in tool loop and build citation map** — before returning

## Files to Modify

| File                                                        | Change                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/shared/src/prompts/prompt-catalog.ts`             | Add `{{#if citations_enabled}}` block to `specialist` and `standalone` templates               |
| `apps/runtime/src/services/execution/prompt-builder.ts`     | Add `citations_enabled` to `buildTemplateContext()` by checking discovery manifest             |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Collect searchai tool results in tool loop, call `buildCitationMap()`, assign `finalCitations` |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Refactor KB fast path to use same catalog prompt constant instead of inline string             |

## Task T-1: Add Citation Instruction to Prompt Catalog

### File: `packages/shared/src/prompts/prompt-catalog.ts`

Add after the `{{#if has_tools}}` block in the `specialist` template (after line 214) and the `standalone` template (after line 322):

```handlebars
{{#if citations_enabled}}
  IMPORTANT: When using information from search results, cite the source by including the result
  number in square brackets, like [1], [2], etc. Always cite your sources.
{{/if}}
```

**Placement**: Inside the `{{#if has_tools}}` block, after the "IMPORTANT: When the user asks about multiple aspects" paragraph. This ensures citation instructions only appear when the agent has tools AND citations are enabled.

**Why inside `has_tools`**: Citation instructions are meaningless without search tools. Placing them here avoids polluting prompts for non-search agents.

**Note**: The 5 templates are: `supervisor`, `supervisor_direct`, `specialist`, `standalone`, `fallback`. Only `specialist` and `standalone` need the block — supervisors don't directly answer search queries, and `fallback` is a minimal error template.

### Subtasks

1. ST-1.1: Add `{{#if citations_enabled}}` block to `specialist` template (after line 214)
2. ST-1.2: Add same block to `standalone` template (after line 322)

### Acceptance Criteria

- AC-1.1: Template renders citation instruction when `citations_enabled: true` and `has_tools: true`
- AC-1.2: Template does NOT render citation instruction when `citations_enabled: false`
- AC-1.3: Template does NOT render citation instruction when `has_tools: false`

---

## Task T-2: Pass `citations_enabled` into Template Context

### File: `apps/runtime/src/services/execution/prompt-builder.ts`

In `buildTemplateContext()`, add a `citations_enabled` field. The value is derived from the session's SearchAI tool executor discovery manifest:

```typescript
// In buildTemplateContext():
// Uses CONSERVATIVE logic (matches KB fast path): if ANY tool has enabled===false, disable all.
citations_enabled: (() => {
  if (!session._searchaiToolExecutor) return false;
  const toolNames = Array.from(session._searchaiToolExecutor.getToolBindings().keys());
  if (toolNames.length === 0) return false;
  for (const toolName of toolNames) {
    const manifest = session._searchaiToolExecutor.getDiscoveryManifestForTool(toolName);
    if (manifest?.citationConfig?.enabled === false) return false;
  }
  return true;
})(),
```

**Key detail**: `getDiscoveryManifestForTool` and `getToolBindings()` are both public on `SearchAIKBToolExecutor` (lines 662 and 696). The session carries `_searchaiToolExecutor`. We use `getToolBindings().keys()` to get tool names — there is no `_searchaiToolNames` property on session.

### Subtasks

1. ST-2.1: Find `buildTemplateContext()` in prompt-builder.ts
2. ST-2.2: Add `citations_enabled` field with discovery manifest check
3. ST-2.3: Verify the Handlebars context type includes the new field

### Acceptance Criteria

- AC-2.1: `citations_enabled` is `true` when session has searchai tools with `citationConfig.enabled !== false`
- AC-2.2: `citations_enabled` is `false` when session has no searchai tools
- AC-2.3: `citations_enabled` is `false` when `citationConfig.enabled === false`

---

## Task T-3: Build Citation Map in Tool Loop Path

### File: `apps/runtime/src/services/execution/reasoning-executor.ts`

Two changes in the tool loop:

#### Change 1: Collect search results before truncation (around line 2793)

After `executeToolCall` returns `toolResult` but BEFORE `compressAndTruncateToolResult`, check if this was a searchai tool call. If so, stash the raw result for citation mapping:

```typescript
// OUTSIDE the while loop (before line 2374), declare accumulator:
const searchToolResults: Array<{
  toolName: string;
  formattedResult: { results?: Array<any> };
}> = [];

// Inside the parallelResults loop, before compressAndTruncateToolResult:
if (
  session._searchaiToolExecutor &&
  toolCall.name &&
  session._searchaiToolExecutor.getDiscoveryManifestForTool(toolCall.name)
) {
  // toolResult has the formatResult() shape — stash before truncation strips metadata
  searchToolResults.push({
    toolName: toolCall.name,
    formattedResult: toolResult as { results?: Array<any> },
  });
}
```

**Critical**: This must happen BEFORE `compressAndTruncateToolResult` because truncation strips `_sourceUrl`, `_documentId`, `_sourceType`, `_sourceKey` fields.

#### Change 2: Build citation map after tool loop exits (around line 2870, after the while loop)

**Key design decision**: Use only the LAST search call's results, not accumulated across iterations. Reason: the LLM only sees the most recent search results in its context window when generating citations. If search was called in iteration 1 (5 results) and again in iteration 3 (3 results), the LLM will produce `[1]`-`[3]` markers for the latest results. Accumulating would cause index mismatch.

```typescript
// After the tool loop while-block, before building ExecutionResult:
if (searchToolResults.length > 0) {
  // Use the LAST search call — the LLM generates citations based on what it last saw
  const lastSearch = searchToolResults[searchToolResults.length - 1];
  const results = lastSearch.formattedResult?.results;

  if (Array.isArray(results) && results.length > 0) {
    const m = session._searchaiToolExecutor?.getDiscoveryManifestForTool(lastSearch.toolName);
    const citationCfg = m?.citationConfig ?? null;

    const toolLoopCitations = session._searchaiToolExecutor?.buildCitationMap(
      { results },
      citationCfg,
      {
        tenantId: session.tenantId ?? '',
        indexId: session._searchaiToolExecutor?.getIndexIdForTool(lastSearch.toolName),
      },
    );

    // Merge: KB fast path citations take precedence if already set (shouldn't happen
    // since KB fast path and tool loop are mutually exclusive, but defensive)
    if (toolLoopCitations) {
      finalCitations = finalCitations
        ? [...finalCitations, ...toolLoopCitations]
        : toolLoopCitations;
    }
  }
}
```

**Note on mutual exclusivity**: KB fast path and tool loop are mutually exclusive paths — KB fast path only triggers for `isKBOnly` agents (line 1900), while the tool loop handles all other agents. The merge logic above is defensive; in practice only one path sets `finalCitations`.

#### Change 3: Refactor KB fast path inline prompt

Replace the inline citation string at lines 2192-2194 with a reference to a shared constant:

```typescript
// Extract to a constant at module level:
const CITATION_INSTRUCTION =
  ' IMPORTANT: When using information from search results, cite the source by including ' +
  'the result number in square brackets, like [1], [2], etc. Always cite your sources.';
```

**Note**: The leading `" IMPORTANT:"` prefix is preserved from the original inline string to maintain prompt strength. The prompt catalog template also uses this same text (with "IMPORTANT:") for consistency.

This constant is used by the KB fast path lean prompt. The tool loop path gets the same text from the prompt catalog template. Single source of truth.

### Subtasks

1. ST-3.1: Extract `CITATION_INSTRUCTION` constant at module level
2. ST-3.2: Replace inline string in KB fast path with the constant
3. ST-3.3: Declare `searchToolResults` accumulator before tool loop
4. ST-3.4: Stash raw searchai tool results before truncation
5. ST-3.5: Build citation map after tool loop exits
6. ST-3.6: Verify `finalCitations` is already threaded to `ExecutionResult` (it is — line 3537)

### Acceptance Criteria

- AC-3.1: Mixed-tool agent gets citation instruction in system prompt
- AC-3.2: Mixed-tool agent gets `Citation[]` in `response_end` after search tool returns results
- AC-3.3: When search is called multiple times across loop iterations, citation map uses the LAST call's results (matching what the LLM sees)
- AC-3.4: KB fast path still works identically (uses same constant)
- AC-3.5: `searchToolResults` only accumulates for searchai tools, not other tools
- AC-3.6: Raw results are captured BEFORE truncation — citation metadata preserved

---

## Risk Assessment

| Risk                                                    | Mitigation                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `toolResult` shape differs from `formatResult()` output | `SearchAIKBToolExecutor.execute()` returns `formatResult()` output — verified in code |
| Multiple search tools produce overlapping indices       | `buildCitationMap` uses array position — continuous by construction when merged       |
| `compressAndTruncateToolResult` strips citation fields  | We capture results BEFORE truncation                                                  |
| KB fast path regression                                 | Same constant, same logic — just extracted                                            |
| `searchToolResults` grows unbounded                     | Bounded by number of tool calls per turn (typically 1-3)                              |

## Dependency Graph

```
T-1 (catalog) ──┐
                 ├──► T-3 depends on both
T-2 (context)  ──┘
```

T-1 and T-2 are independent. T-3 depends on T-1 (catalog prompt) and T-2 (context flag) for the tool loop system prompt to render correctly.
