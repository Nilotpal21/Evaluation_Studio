# ABL Extensions Gap Closure — Design

**Date**: 2026-03-02
**Scope**: Gaps 1-4 from the ABL Extensions Roadmap gap analysis
**Out of scope**: Phase 6 SDK Generation, LLM-enhanced analysis (Phase B)

---

## Context

A gap analysis of the 7-phase ABL Extensions Roadmap identified 5 gaps. This design covers gaps 1-4 (Phase 6 SDK Generation is deferred as a separate design cycle).

| #   | Gap                                                                                         | Phase | Effort               |
| --- | ------------------------------------------------------------------------------------------- | ----- | -------------------- |
| 1   | MCP model tools not registered in server.ts                                                 | P3    | None (already wired) |
| 2   | MCP authoring/testing tools not registered in server.ts                                     | P4    | Small                |
| 3   | 3 missing analysis tools: test_agent, explain_dsl, suggest_improvements                     | P4    | Medium               |
| 4   | 5 missing doc topics: yaml-format, cel-functions, extensions, tool-patterns, best-practices | P5    | Medium               |

Gap 1 was confirmed as already resolved — model tools are imported and spread into the tools array in server.ts.

---

## Gap 2: MCP Authoring/Testing Tool Registration

### Problem

`packages/kore-platform-cli/src/mcp/authoring/index.ts` exports 10 authoring tools and `mcp/testing/index.ts` exports 3 testing tools. Both have complete implementations with handler functions. Neither is registered in `server.ts`.

### Design

Follow the exact pattern used by model tools (already integrated):

1. **Import** both tool arrays and handlers in `server.ts`
2. **Spread** into the `tools[]` array
3. **Update `LOCAL_TOOLS`** set to include `kore_validate_agent` (uses language service locally)
4. **Add switch cases** in `handleRemoteToolCall` for 12 remote tools (9 authoring + 3 testing)
5. **Add switch case** in `handleLocalToolCall` for `kore_validate_agent`

### Files

- Modified: `packages/kore-platform-cli/src/mcp/server.ts`

---

## Gap 3: Analysis Tools (explain_dsl, suggest_improvements, test_agent)

### Problem

The design specifies 3 Arch co-pilot tools that aren't implemented. These should be available both in Studio's Arch chat and as MCP tools for external AI agents (Claude Code, Codex, Cursor).

### Architecture

```
External AI agents (Claude Code, Codex, Cursor)
    ↓ MCP protocol
packages/kore-platform-cli/src/mcp/analysis/    ← core logic
    ↑ API route call
apps/studio/src/app/api/abl/analysis/route.ts   ← Studio proxy
    ↑ executeArchTool()
apps/studio/src/lib/arch-tools.ts                ← Arch chat
```

### Two-Phase Approach

**Phase A (this plan — stub)**: Tools return structured data from static analysis. No LLM calls.

**Phase B (follow-up)**: Add optional LLM calls for richer natural language explanations, improvement prioritization, and test scenario generation. Uses tenant LLM credentials when available, degrades gracefully without.

### Tool Definitions

#### `explain_dsl` / `kore_explain_dsl`

- **Input**: `{ dsl: string }` (raw DSL content)
- **Output**: Structured parse result
  ```typescript
  {
    agentType: 'scripted' | 'reasoning' | 'supervisor';
    executionMode: string;
    flowSteps: Array<{ name: string; type: string; transitions?: string[] }>;
    tools: Array<{ name: string; type: string }>;
    constraints: Array<{ description: string }>;
    handoffs: Array<{ target: string; condition?: string }>;
    gatherFields: Array<{ name: string; type: string }>;
    summary: string; // human-readable one-liner
  }
  ```
- **Arch stages**: `build`, `test`, `evolve`
- **MCP type**: LOCAL (no auth needed, operates on provided content)

#### `suggest_improvements` / `kore_suggest_improvements`

- **Input**: `{ dsl: string }` (raw DSL content)
- **Output**: Diagnostics + rule-based improvement checklist
  ```typescript
  {
    diagnostics: Diagnostic[];
    suggestions: Array<{
      category: 'safety' | 'completeness' | 'performance' | 'maintainability';
      severity: 'high' | 'medium' | 'low';
      message: string;
      location?: string; // section/step name
    }>;
  }
  ```
- **Rules**: Missing constraints on reasoning agents, unused declared tools, gather fields without validation, flow steps without error transitions, missing escalation paths, overly broad tool permissions.
- **Arch stages**: `build`, `evolve`
- **MCP type**: LOCAL

#### `test_agent` / `kore_test_agent`

- **Input**: `{ dsl: string }` (raw DSL content)
- **Output**: Compilation result + diagnostic summary
  ```typescript
  {
    compiles: boolean;
    diagnosticCount: { error: number; warning: number; info: number };
    diagnostics: Diagnostic[];
    agentType: string;
    toolCount: number;
    flowStepCount: number;
  }
  ```
- **Arch stages**: `test`, `evolve`
- **MCP type**: LOCAL

### Files

- New: `packages/kore-platform-cli/src/mcp/analysis/index.ts` (core logic + tool definitions + handler)
- New: `apps/studio/src/app/api/abl/analysis/route.ts` (Studio proxy)
- Modified: `packages/kore-platform-cli/src/mcp/server.ts` (register 3 MCP tools)
- Modified: `apps/studio/src/lib/arch-tools.ts` (register 3 Arch tools + stage mapping)

---

## Gap 4: Missing Documentation Topics

### Problem

Studio's `/docs/abl` page advertises 13 topics in its `TOPIC_INDEX`, but only 8 have content in the CLI docs package. 5 topics return 404.

### Content Strategy

| Topic            | Category        | Source                                       | Size |
| ---------------- | --------------- | -------------------------------------------- | ---- |
| `yaml-format`    | Getting Started | Static markdown                              | ~3KB |
| `cel-functions`  | Concepts        | Auto-generated from `CEL_FUNCTIONS` registry | ~4KB |
| `extensions`     | Concepts        | Static markdown                              | ~3KB |
| `tool-patterns`  | Patterns        | Static markdown                              | ~3KB |
| `best-practices` | Patterns        | Static markdown                              | ~4KB |

### CEL Functions Auto-Generation

A build-time script reads `CEL_FUNCTIONS` from `@abl/language-service` (37 functions with name, signature, description, category), groups by category, and outputs a markdown string with tables. The output is embedded in `docs/index.ts` as a constant.

```
packages/language-service/src/cel-functions.ts  (source of truth)
    ↓ build script
packages/kore-platform-cli/scripts/generate-cel-docs.ts
    ↓ generates
packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts  (constant)
    ↓ imported by
packages/kore-platform-cli/src/mcp/docs/index.ts  (added to ABL_DOCS)
```

### Static Topic Content Sources

- **yaml-format**: Derived from the YAML parser implementation and existing ABL YAML examples in the codebase
- **extensions**: Derived from the Extension Points section of the ABL Extensions Roadmap design doc
- **tool-patterns**: Derived from existing tool binding patterns in the compiler and runtime
- **best-practices**: Derived from CLAUDE.md coding standards adapted for ABL authoring

### Files

- New: `packages/kore-platform-cli/scripts/generate-cel-docs.ts`
- New: `packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts`
- Modified: `packages/kore-platform-cli/src/mcp/docs/index.ts` (add 5 topics to `ABL_DOCS`)

---

## Execution Order

1. **Gap 2**: Wire authoring/testing tools in server.ts (quick win, unblocks MCP usage)
2. **Gap 3**: Analysis tools — MCP module first, then Arch integration
3. **Gap 4**: Documentation topics (independent, can parallelize with late Gap 3 tasks)

## File Impact Summary

| File                                                                 | Action   | Gap  |
| -------------------------------------------------------------------- | -------- | ---- |
| `packages/kore-platform-cli/src/mcp/server.ts`                       | Modified | 2, 3 |
| `packages/kore-platform-cli/src/mcp/analysis/index.ts`               | New      | 3    |
| `packages/kore-platform-cli/scripts/generate-cel-docs.ts`            | New      | 4    |
| `packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts` | New      | 4    |
| `packages/kore-platform-cli/src/mcp/docs/index.ts`                   | Modified | 4    |
| `apps/studio/src/app/api/abl/analysis/route.ts`                      | New      | 3    |
| `apps/studio/src/lib/arch-tools.ts`                                  | Modified | 3    |

**Total**: 4 new files, 3 modified files

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close 3 implementation gaps (authoring/testing MCP wiring, analysis tools, doc topics) identified in the ABL Extensions Roadmap gap analysis.

**Architecture:** Gap 2 wires existing authoring/testing tool modules into the MCP server. Gap 3 creates a new `mcp/analysis/` module with 3 tools exposed both as MCP tools and Arch chat tools via a Studio proxy API route. Gap 4 adds 5 doc topic constants to the docs module (1 auto-generated from CEL registry, 4 static).

**Tech Stack:** TypeScript, MCP protocol, `@abl/language-service` (getDiagnostics, getDocumentSymbols, detectFormat, CEL_FUNCTIONS), Studio Next.js API routes.

**Design doc:** `docs/plans/2026-03-02-abl-extensions-gap-closure-design.md`

---

## Task 1: Wire authoring/testing tools into MCP server

**Files:**

- Modify: `packages/kore-platform-cli/src/mcp/server.ts`

**Step 1: Add imports for authoring and testing modules**

At line 25 of `server.ts`, after the existing `modelTools` import, add:

```typescript
import { authoringTools, handleAuthoringTool, LOCAL_AUTHORING_TOOLS } from './authoring/index.js';
import { testingTools, handleTestingTool } from './testing/index.js';
```

**Step 2: Add `kore_validate_agent` to `LOCAL_TOOLS` set**

In the `LOCAL_TOOLS` set (lines 71-81), add `'kore_validate_agent'` as a new entry:

```typescript
const LOCAL_TOOLS = new Set([
  'kore_get_docs',
  'kore_search_docs',
  'kore_architect_analyze',
  'kore_architect_generate',
  'kore_architect_generate_agent',
  'kore_architect_generate_docs',
  'kore_import_analyze',
  'kore_import_convert',
  'kore_architect_validate',
  'kore_validate_agent',
]);
```

**Step 3: Spread authoring and testing tools into the tools array**

After `...modelTools,` (line 308), add:

```typescript
  ...modelTools,

  // Authoring Tools
  ...authoringTools,

  // Testing Tools
  ...testingTools,
```

**Step 4: Add remote handler cases for authoring + testing tools**

In `handleRemoteToolCall` switch statement, before the default case (around line 678), add:

```typescript
    // Authoring Tools (remote)
    case 'kore_create_agent':
    case 'kore_list_agents':
    case 'kore_get_agent_dsl':
    case 'kore_update_agent_dsl':
    case 'kore_add_tool':
    case 'kore_add_flow_step':
    case 'kore_add_constraint':
    case 'kore_add_handoff':
    case 'kore_compile_agent': {
      return handleAuthoringTool(name, args, apiUrl, headers);
    }

    // Testing Tools
    case 'kore_test_conversation':
    case 'kore_test_scenario':
    case 'kore_get_test_results': {
      return handleTestingTool(name, args, apiUrl, headers);
    }
```

**Step 5: Add local handler case for kore_validate_agent**

In `handleLocalToolCall` switch statement, before the default case (around line 790), add:

```typescript
    case 'kore_validate_agent': {
      return handleAuthoringTool(name, args, '', {});
    }
```

Note: `kore_validate_agent` in the authoring handler uses the language service locally — `apiUrl` and `headers` are unused.

**Step 6: Build and verify**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Clean build, no type errors.

**Step 7: Commit**

```bash
git add packages/kore-platform-cli/src/mcp/server.ts
git commit -m "feat(cli): wire authoring and testing MCP tools into server"
```

---

## Task 2: Create analysis module with core logic

**Files:**

- Create: `packages/kore-platform-cli/src/mcp/analysis/index.ts`

**Step 1: Create the analysis module directory**

```bash
mkdir -p packages/kore-platform-cli/src/mcp/analysis
```

**Step 2: Write the analysis tool definitions and handlers**

Create `packages/kore-platform-cli/src/mcp/analysis/index.ts`:

```typescript
/**
 * MCP Analysis Tools
 *
 * DSL analysis, improvement suggestions, and compilation testing.
 * All tools are LOCAL (operate on provided DSL content, no auth needed).
 *
 * Phase A: Structured data from static analysis (no LLM).
 * Phase B (follow-up): Optional LLM-enhanced explanations.
 */

import { getDiagnostics, getDocumentSymbols, detectFormat } from '@abl/language-service';
import type { Diagnostic, DocumentSymbol } from '@abl/language-service';

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export interface AnalysisTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const analysisTools: AnalysisTool[] = [
  {
    name: 'kore_explain_dsl',
    description:
      'Analyze ABL DSL source code and return a structured explanation of its ' +
      'components: agent type, execution mode, flow steps, tools, constraints, ' +
      'handoffs, and gather fields. Use this to understand what an agent does.',
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'The ABL DSL source code to explain',
        },
      },
      required: ['dsl'],
    },
  },
  {
    name: 'kore_suggest_improvements',
    description:
      'Analyze ABL DSL source code and return diagnostics plus rule-based ' +
      'improvement suggestions. Checks for missing constraints, unused tools, ' +
      'gather fields without validation, missing error transitions, and other ' +
      'common issues.',
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'The ABL DSL source code to analyze for improvements',
        },
      },
      required: ['dsl'],
    },
  },
  {
    name: 'kore_test_agent',
    description:
      'Compile ABL DSL source code and return a diagnostic summary. Reports ' +
      'whether the agent compiles successfully, error/warning counts, agent type, ' +
      'and structural statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'The ABL DSL source code to test',
        },
      },
      required: ['dsl'],
    },
  },
];

// =============================================================================
// TYPES
// =============================================================================

interface ExplainResult {
  agentType: string;
  executionMode: string;
  format: 'yaml' | 'legacy';
  flowSteps: Array<{ name: string; kind: string }>;
  tools: Array<{ name: string }>;
  constraints: Array<{ name: string }>;
  handoffs: Array<{ target: string }>;
  gatherFields: Array<{ name: string; kind: string }>;
  summary: string;
}

interface Suggestion {
  category: 'safety' | 'completeness' | 'performance' | 'maintainability';
  severity: 'high' | 'medium' | 'low';
  message: string;
  location?: string;
}

interface SuggestResult {
  diagnostics: Diagnostic[];
  suggestions: Suggestion[];
}

interface TestResult {
  compiles: boolean;
  diagnosticCount: { error: number; warning: number; info: number };
  diagnostics: Diagnostic[];
  agentType: string;
  toolCount: number;
  flowStepCount: number;
}

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Explain DSL structure by parsing document symbols and diagnostics.
 */
function explainDsl(dsl: string): ExplainResult {
  const format = detectFormat(dsl);
  const symbols = getDocumentSymbols(dsl);

  // Extract agent type from symbols
  const agentSymbol = symbols.find((s) => s.kind === 'agent' || s.kind === 'supervisor');
  const agentType = agentSymbol?.kind === 'supervisor' ? 'supervisor' : extractAgentType(dsl);

  // Extract execution mode
  const executionMode = extractField(dsl, 'MODE') || 'reasoning';

  // Categorize symbols
  const flowSteps: ExplainResult['flowSteps'] = [];
  const tools: ExplainResult['tools'] = [];
  const constraints: ExplainResult['constraints'] = [];
  const handoffs: ExplainResult['handoffs'] = [];
  const gatherFields: ExplainResult['gatherFields'] = [];

  for (const sym of symbols) {
    switch (sym.kind) {
      case 'step':
        flowSteps.push({ name: sym.name, kind: sym.detail || 'step' });
        break;
      case 'tool':
        tools.push({ name: sym.name });
        break;
      case 'constraint':
        constraints.push({ name: sym.name });
        break;
      case 'handoff':
        handoffs.push({ target: sym.name });
        break;
      case 'field':
        gatherFields.push({ name: sym.name, kind: sym.detail || 'string' });
        break;
    }
  }

  const summary =
    `${agentType} agent (${executionMode} mode) with ` +
    `${flowSteps.length} flow steps, ${tools.length} tools, ` +
    `${constraints.length} constraints, ${handoffs.length} handoffs`;

  return {
    agentType,
    executionMode,
    format,
    flowSteps,
    tools,
    constraints,
    handoffs,
    gatherFields,
    summary,
  };
}

/**
 * Suggest improvements based on diagnostics and static rules.
 */
function suggestImprovements(dsl: string): SuggestResult {
  const diagnostics = getDiagnostics(dsl);
  const symbols = getDocumentSymbols(dsl);
  const suggestions: Suggestion[] = [];

  const agentType = extractAgentType(dsl);
  const hasConstraints = symbols.some((s) => s.kind === 'constraint');
  const hasTools = symbols.some((s) => s.kind === 'tool');
  const hasHandoffs = symbols.some((s) => s.kind === 'handoff');
  const flowSteps = symbols.filter((s) => s.kind === 'step');
  const gatherFields = symbols.filter((s) => s.kind === 'field');

  // Rule: Reasoning agents should have constraints
  if (agentType === 'reasoning' && !hasConstraints) {
    suggestions.push({
      category: 'safety',
      severity: 'high',
      message:
        'Reasoning agent has no constraints. Add CONSTRAINTS section to ' +
        'define behavioral boundaries.',
    });
  }

  // Rule: Agents with tools should have at least one constraint
  if (hasTools && !hasConstraints) {
    suggestions.push({
      category: 'safety',
      severity: 'medium',
      message:
        'Agent has tools but no constraints. Consider adding constraints ' +
        'to limit tool usage scope.',
    });
  }

  // Rule: Multi-agent setup should have escalation
  if (hasHandoffs && !dsl.includes('ESCALAT')) {
    suggestions.push({
      category: 'completeness',
      severity: 'medium',
      message:
        'Agent has handoffs but no escalation path. Consider adding an ' +
        'ESCALATION section for unhandled cases.',
    });
  }

  // Rule: Gather fields should have validation
  for (const field of gatherFields) {
    const fieldSection = extractFieldSection(dsl, field.name);
    if (fieldSection && !fieldSection.includes('validat')) {
      suggestions.push({
        category: 'completeness',
        severity: 'low',
        message: `Gather field "${field.name}" has no validation rules.`,
        location: field.name,
      });
    }
  }

  // Rule: Flow steps without error transitions
  if (flowSteps.length > 1) {
    const hasErrorTransition = dsl.includes('on_error') || dsl.includes('ON_ERROR');
    if (!hasErrorTransition) {
      suggestions.push({
        category: 'completeness',
        severity: 'medium',
        message:
          'Flow has multiple steps but no error transitions. ' +
          'Consider adding on_error transitions for graceful failure handling.',
      });
    }
  }

  // Rule: No GOAL defined
  if (!dsl.includes('GOAL:') && !dsl.includes('goal:')) {
    suggestions.push({
      category: 'completeness',
      severity: 'high',
      message: 'Agent has no GOAL defined. Add a GOAL to guide LLM behavior.',
    });
  }

  return { diagnostics, suggestions };
}

/**
 * Test agent by running diagnostics and reporting compilation status.
 */
function testAgent(dsl: string): TestResult {
  const diagnostics = getDiagnostics(dsl);
  const symbols = getDocumentSymbols(dsl);

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
  const infoCount = diagnostics.filter(
    (d) => d.severity === 'info' || d.severity === 'hint',
  ).length;

  const agentType = extractAgentType(dsl);
  const toolCount = symbols.filter((s) => s.kind === 'tool').length;
  const flowStepCount = symbols.filter((s) => s.kind === 'step').length;

  return {
    compiles: errorCount === 0,
    diagnosticCount: { error: errorCount, warning: warningCount, info: infoCount },
    diagnostics,
    agentType,
    toolCount,
    flowStepCount,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/** Extract agent type from DSL content */
function extractAgentType(dsl: string): string {
  if (/\bSUPERVISOR\b/i.test(dsl)) return 'supervisor';
  const modeMatch = dsl.match(/MODE:\s*(\w+)/i);
  if (modeMatch) {
    const mode = modeMatch[1].toLowerCase();
    if (mode === 'scripted') return 'scripted';
  }
  return 'reasoning';
}

/** Extract a top-level field value from DSL */
function extractField(dsl: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = dsl.match(regex);
  return match?.[1]?.trim();
}

/** Extract the content block around a gather field name */
function extractFieldSection(dsl: string, fieldName: string): string | undefined {
  const idx = dsl.indexOf(fieldName);
  if (idx === -1) return undefined;
  // Grab ~200 chars around the field name for context
  return dsl.slice(idx, Math.min(idx + 200, dsl.length));
}

// =============================================================================
// DISPATCH
// =============================================================================

export async function handleAnalysisTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dsl = args.dsl as string;
  if (!dsl || typeof dsl !== 'string') {
    return { error: 'Missing required parameter: dsl' };
  }

  switch (name) {
    case 'kore_explain_dsl':
      return explainDsl(dsl);
    case 'kore_suggest_improvements':
      return suggestImprovements(dsl);
    case 'kore_test_agent':
      return testAgent(dsl);
    default:
      return { error: `Unknown analysis tool: ${name}` };
  }
}
```

**Step 3: Build and verify**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Clean build. The analysis module imports `@abl/language-service` which is a declared dependency.

**Step 4: Commit**

```bash
git add packages/kore-platform-cli/src/mcp/analysis/index.ts
git commit -m "feat(cli): add analysis MCP tools module (explain, suggest, test)"
```

---

## Task 3: Register analysis tools in MCP server

**Files:**

- Modify: `packages/kore-platform-cli/src/mcp/server.ts`

**Step 1: Add import for analysis module**

After the testing tools import added in Task 1, add:

```typescript
import { analysisTools, handleAnalysisTool } from './analysis/index.js';
```

**Step 2: Add analysis tool names to LOCAL_TOOLS set**

All 3 analysis tools are local (operate on provided DSL content):

```typescript
  'kore_validate_agent',
  'kore_explain_dsl',
  'kore_suggest_improvements',
  'kore_test_agent',
]);
```

**Step 3: Spread analysis tools into the tools array**

After the testing tools spread (added in Task 1):

```typescript
  // Analysis Tools
  ...analysisTools,
```

**Step 4: Add local handler cases for analysis tools**

In `handleLocalToolCall` switch, before the default case, add:

```typescript
    // Analysis Tools
    case 'kore_explain_dsl':
    case 'kore_suggest_improvements':
    case 'kore_test_agent': {
      return handleAnalysisTool(name, args);
    }
```

**Step 5: Build and verify**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Clean build.

**Step 6: Commit**

```bash
git add packages/kore-platform-cli/src/mcp/server.ts
git commit -m "feat(cli): register analysis tools in MCP server"
```

---

## Task 4: Create Studio analysis API route

**Files:**

- Create: `apps/studio/src/app/api/abl/analysis/route.ts`

**Step 1: Create the API route directory**

```bash
mkdir -p apps/studio/src/app/api/abl/analysis
```

**Step 2: Write the analysis proxy route**

Create `apps/studio/src/app/api/abl/analysis/route.ts`:

```typescript
/**
 * POST /api/abl/analysis
 *
 * Proxy for analysis tools (explain_dsl, suggest_improvements, test_agent).
 * Loads the analysis handler from the compiled CLI package and dispatches.
 */
import { NextRequest, NextResponse } from 'next/server';

interface AnalysisRequest {
  tool: string;
  dsl: string;
}

// Lazy-load the analysis handler from the compiled CLI package
let handlerCache: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getHandler() {
  if (handlerCache) return handlerCache;
  try {
    const mod = await import(
      /* webpackIgnore: true */
      '@agent-platform/kore-platform-cli/mcp/analysis/index.js'
    );
    handlerCache = mod.handleAnalysisTool;
    return handlerCache;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnalysisRequest;

    if (!body.tool || !body.dsl) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: tool, dsl' },
        { status: 400 },
      );
    }

    const validTools = ['kore_explain_dsl', 'kore_suggest_improvements', 'kore_test_agent'];
    if (!validTools.includes(body.tool)) {
      return NextResponse.json(
        { success: false, error: `Unknown tool: ${body.tool}` },
        { status: 400 },
      );
    }

    const handler = await getHandler();
    if (!handler) {
      return NextResponse.json(
        { success: false, error: 'Analysis module not available' },
        { status: 503 },
      );
    }

    const result = await handler(body.tool, { dsl: body.dsl });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
```

**Step 3: Build and verify**

Run: `pnpm --filter @agent-platform/studio build`
Expected: Clean build (or at least the API route compiles without type errors).

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/abl/analysis/route.ts
git commit -m "feat(studio): add analysis API proxy route"
```

---

## Task 5: Add analysis tools to arch-tools.ts

**Files:**

- Modify: `apps/studio/src/lib/arch-tools.ts`

**Step 1: Define 3 new tool definitions**

After the existing `modifyAgentAbl` definition (around line 168), add:

```typescript
// =============================================================================
// ANALYSIS TOOLS (Phase A — stub, returns structured data)
// =============================================================================

const explainDsl: ToolDefinition = {
  name: 'explain_dsl',
  description:
    'Analyze ABL DSL source code and return a structured explanation of its ' +
    'components: agent type, execution mode, flow steps, tools, constraints, ' +
    'handoffs, and gather fields. Use this to understand what an agent does.',
  input_schema: {
    type: 'object',
    properties: {
      dslContent: {
        type: 'string',
        description: 'The ABL DSL source code to explain',
      },
    },
    required: ['dslContent'],
  },
};

const suggestImprovements: ToolDefinition = {
  name: 'suggest_improvements',
  description:
    'Analyze ABL DSL source code and return diagnostics plus improvement ' +
    'suggestions. Checks for missing constraints, unused tools, gather fields ' +
    'without validation, missing error transitions, and other common issues.',
  input_schema: {
    type: 'object',
    properties: {
      dslContent: {
        type: 'string',
        description: 'The ABL DSL source code to analyze for improvements',
      },
    },
    required: ['dslContent'],
  },
};

const testAgent: ToolDefinition = {
  name: 'test_agent',
  description:
    'Compile ABL DSL source code and return a diagnostic summary. Reports ' +
    'whether the agent compiles successfully, error/warning counts, agent type, ' +
    'and structural statistics.',
  input_schema: {
    type: 'object',
    properties: {
      dslContent: {
        type: 'string',
        description: 'The ABL DSL source code to test',
      },
    },
    required: ['dslContent'],
  },
};
```

**Step 2: Add to ALL_TOOLS record**

Update the `ALL_TOOLS` record to include the new tools:

```typescript
const ALL_TOOLS: Record<string, ToolDefinition> = {
  read_agent_dsl: readAgentDsl,
  list_project_agents: listProjectAgents,
  compile_abl: compileAbl,
  query_session_traces: querySessionTraces,
  propose_modification: proposeModification,
  modify_agent_abl: modifyAgentAbl,
  explain_dsl: explainDsl,
  suggest_improvements: suggestImprovements,
  test_agent: testAgent,
};
```

**Step 3: Update TOOLS_BY_STAGE mapping**

```typescript
const TOOLS_BY_STAGE: Record<LifecycleStage, string[]> = {
  ideate: [],
  design: ['list_project_agents'],
  build: [
    'read_agent_dsl',
    'list_project_agents',
    'compile_abl',
    'query_session_traces',
    'explain_dsl',
    'suggest_improvements',
  ],
  test: [
    'read_agent_dsl',
    'list_project_agents',
    'query_session_traces',
    'compile_abl',
    'explain_dsl',
    'test_agent',
  ],
  deploy: ['compile_abl', 'list_project_agents', 'read_agent_dsl'],
  evolve: [
    'read_agent_dsl',
    'list_project_agents',
    'compile_abl',
    'query_session_traces',
    'explain_dsl',
    'suggest_improvements',
    'test_agent',
  ],
  edit: [],
};
```

**Step 4: Add executor implementations in executeArchTool**

In the `executeArchTool` switch statement, before the default case, add:

```typescript
    case 'explain_dsl':
      return executeAnalysisTool('kore_explain_dsl', input);
    case 'suggest_improvements':
      return executeAnalysisTool('kore_suggest_improvements', input);
    case 'test_agent':
      return executeAnalysisTool('kore_test_agent', input);
```

**Step 5: Add the executeAnalysisTool helper function**

After the existing executor functions (around line 613), add:

```typescript
/**
 * Execute an analysis tool by calling the Studio analysis API proxy.
 */
async function executeAnalysisTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const dsl = input.dslContent as string;
  if (!dsl) {
    return {
      success: false,
      error: { code: 'MISSING_INPUT', message: 'dslContent is required' },
    };
  }

  try {
    const response = await fetch('/api/abl/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, dsl }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: { code: 'ANALYSIS_ERROR', message: text },
      };
    }

    const result = await response.json();
    return { success: true, data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { code: 'ANALYSIS_FETCH_ERROR', message },
    };
  }
}
```

**Step 6: Build and verify**

Run: `pnpm --filter @agent-platform/studio build`
Expected: Clean build.

**Step 7: Commit**

```bash
git add apps/studio/src/lib/arch-tools.ts
git commit -m "feat(studio): add explain_dsl, suggest_improvements, test_agent Arch tools"
```

---

## Task 6: Create CEL docs generator script

**Files:**

- Create: `packages/kore-platform-cli/scripts/generate-cel-docs.ts`

**Step 1: Create the scripts directory if needed**

```bash
mkdir -p packages/kore-platform-cli/scripts
```

**Step 2: Write the CEL docs generator**

Create `packages/kore-platform-cli/scripts/generate-cel-docs.ts`:

````typescript
/**
 * Generate CEL Functions documentation from the language-service registry.
 *
 * Reads CEL_FUNCTIONS from @abl/language-service and outputs a TypeScript
 * constant with markdown content grouped by category.
 *
 * Usage: npx tsx packages/kore-platform-cli/scripts/generate-cel-docs.ts
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import from the language-service source directly (build-time script)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CEL_FUNCTIONS } = await import('@abl/language-service');

const CATEGORY_TITLES: Record<string, string> = {
  string: 'String Functions',
  numeric: 'Numeric Functions',
  formatting: 'Formatting Functions',
  type: 'Type Functions',
  array: 'Array Functions',
  object: 'Object Functions',
  utility: 'Utility Functions',
};

// Group functions by category
const grouped = new Map<string, typeof CEL_FUNCTIONS>();
for (const fn of CEL_FUNCTIONS) {
  const list = grouped.get(fn.category) || [];
  list.push(fn);
  grouped.set(fn.category, list);
}

// Generate markdown
const lines: string[] = [
  '# CEL Functions Reference',
  '',
  'ABL provides built-in CEL (Common Expression Language) functions for use in',
  'conditions, transitions, and computed fields.',
  '',
  `Total: ${CEL_FUNCTIONS.length} functions across ${grouped.size} categories.`,
  '',
];

const categoryOrder = ['string', 'numeric', 'formatting', 'type', 'array', 'object', 'utility'];

for (const cat of categoryOrder) {
  const fns = grouped.get(cat);
  if (!fns) continue;

  lines.push(`## ${CATEGORY_TITLES[cat] || cat}`);
  lines.push('');
  lines.push('| Function | Signature | Description |');
  lines.push('|----------|-----------|-------------|');

  for (const fn of fns) {
    lines.push(`| \`${fn.name}\` | \`${fn.signature}\` | ${fn.description} |`);
  }
  lines.push('');
}

lines.push('## Usage Examples');
lines.push('');
lines.push('```yaml');
lines.push('# In a transition condition:');
lines.push('transitions:');
lines.push('  - target: next_step');
lines.push('    condition: abl.length(context.items) > 0');
lines.push('');
lines.push('# In a computed field:');
lines.push('fields:');
lines.push('  formatted_name:');
lines.push('    type: string');
lines.push('    compute: abl.upper(abl.trim(context.name))');
lines.push('');
lines.push('# In a constraint:');
lines.push('constraints:');
lines.push('  - description: Only process valid amounts');
lines.push('    condition: abl.is_number(context.amount) && abl.round(context.amount, 2) > 0');
lines.push('```');

const markdown = lines.join('\n');

// Write as a TypeScript constant
const output = `/**
 * Auto-generated CEL Functions documentation.
 * DO NOT EDIT — regenerate with: npx tsx scripts/generate-cel-docs.ts
 */
export const CEL_FUNCTIONS_DOCS = \`${markdown.replace(/`/g, '\\`')}\`;
`;

const outPath = join(__dirname, '..', 'src', 'mcp', 'docs', 'cel-functions-generated.ts');
writeFileSync(outPath, output, 'utf-8');

console.log(`Generated CEL docs: ${outPath} (${markdown.length} chars)`);
````

**Step 3: Run the generator**

```bash
npx tsx packages/kore-platform-cli/scripts/generate-cel-docs.ts
```

Expected: Creates `packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts` with the generated constant.

**Step 4: Verify the generated file**

Read the output file and confirm it contains all 30 CEL functions grouped by category with the markdown table format.

**Step 5: Commit**

```bash
git add packages/kore-platform-cli/scripts/generate-cel-docs.ts
git add packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts
git commit -m "feat(cli): add CEL docs auto-generator and generated output"
```

---

## Task 7: Write 4 static doc topics

**Files:**

- Modify: `packages/kore-platform-cli/src/mcp/docs/index.ts`

**Step 1: Add YAML Format topic**

Before the `ABL_DOCS` export (around line 799), add:

```typescript
const YAML_FORMAT = `# YAML Format Reference

ABL supports two source formats: legacy (custom DSL syntax) and YAML.

## File Extensions

- \`.agent.yaml\` — YAML format (recommended)
- \`.agent.abl\` — Legacy format (still supported)

## Structure

A YAML agent file has these top-level keys:

\`\`\`yaml
AGENT: agent_name
DESCRIPTION: What this agent does
GOAL: The agent's primary objective
MODE: reasoning | scripted

TOOLS:
  - name: tool_name
    type: http | lambda | sandbox | mcp
    description: What this tool does
    endpoint: https://api.example.com/action
    method: POST
    parameters:
      param1:
        type: string
        description: Parameter description
        required: true

CONSTRAINTS:
  - Never share sensitive information
  - Always confirm before making changes

FLOW:
  greeting:
    prompt: Welcome the user
    transitions:
      - target: gather_info
        condition: "true"

  gather_info:
    collect:
      - name: user_name
        type: string
        prompt: What is your name?
    transitions:
      - target: process
        condition: context.user_name != ""
\`\`\`

## YAML vs Legacy Syntax

| Feature | YAML | Legacy |
|---------|------|--------|
| Indentation | 2-space YAML standard | Custom section markers |
| Multi-line strings | YAML block scalars (\`|\`, \`>\`) | Backtick blocks |
| Comments | \`#\` prefix | \`//\` prefix |
| Lists | YAML sequences (\`-\`) | Comma-separated or newline |
| Nesting | YAML maps | Indented blocks |

## Auto-Detection

The language service auto-detects format based on content:
- Files starting with \`AGENT:\` followed by YAML structure → YAML
- Files with custom section markers (\`TOOLS:\`, \`FLOW:\` without YAML indentation) → Legacy

Both formats compile to the same intermediate representation (IR).
`;
```

**Step 2: Add Extensions topic**

```typescript
const EXTENSIONS = `# Extensions

ABL agents can be extended through several mechanisms.

## Tool Binding Types

Tools connect agents to external capabilities:

| Type | Description | Use Case |
|------|-------------|----------|
| \`http\` | REST API call | External services, databases |
| \`lambda\` | Serverless function | Custom compute, transformations |
| \`sandbox\` | Isolated code execution | User-provided scripts, code eval |
| \`mcp\` | Model Context Protocol | AI tool ecosystems, IDE integration |

### HTTP Tool Example

\`\`\`yaml
TOOLS:
  - name: get_weather
    type: http
    endpoint: https://api.weather.com/v1/current
    method: GET
    parameters:
      city:
        type: string
        required: true
    headers:
      Authorization: "Bearer \${env.WEATHER_API_KEY}"
\`\`\`

### MCP Tool Example

\`\`\`yaml
TOOLS:
  - name: search_docs
    type: mcp
    server: documentation-server
    description: Search internal documentation
\`\`\`

## Custom CEL Functions

ABL includes built-in CEL functions (see cel-functions topic). Custom functions
can be registered at the platform level for domain-specific operations.

## Middleware Hooks

The runtime supports middleware hooks at these points:
- **Pre-tool**: Before tool execution (validation, logging)
- **Post-tool**: After tool execution (result transformation)
- **Pre-LLM**: Before LLM calls (prompt augmentation)
- **Post-LLM**: After LLM responses (filtering, compliance)

## Guardrails

Input and output guardrails can be configured per agent:
- **Input guardrails**: Validate user messages before processing
- **Output guardrails**: Filter agent responses before delivery
- **Tool guardrails**: Validate tool inputs/outputs
`;
```

**Step 3: Add Tool Patterns topic**

```typescript
const TOOL_PATTERNS = `# Tool Patterns

Common patterns for defining and using tools in ABL agents.

## REST API Tool

The most common pattern — call an external HTTP API:

\`\`\`yaml
TOOLS:
  - name: create_ticket
    type: http
    description: Create a support ticket
    endpoint: https://api.ticketing.com/tickets
    method: POST
    parameters:
      title:
        type: string
        required: true
      description:
        type: string
        required: true
      priority:
        type: string
        enum: [low, medium, high]
        default: medium
\`\`\`

## Tool with Result Validation

Use \`success_when\` to define what constitutes a successful tool call:

\`\`\`yaml
TOOLS:
  - name: lookup_order
    type: http
    endpoint: https://api.orders.com/v1/orders/\${orderId}
    method: GET
    success_when: result.status != "not_found"
    parameters:
      orderId:
        type: string
        required: true
\`\`\`

## Tool Error Handling

Define fallback behavior when tools fail:

\`\`\`yaml
FLOW:
  process_payment:
    action: charge_card
    on_error:
      - target: retry_payment
        condition: error.retryable == true
      - target: escalate_to_human
        condition: error.retryable == false
\`\`\`

## Chained Tool Calls

Use flow steps to chain tool calls sequentially:

\`\`\`yaml
FLOW:
  lookup:
    action: find_customer
    transitions:
      - target: enrich
        condition: result.found == true

  enrich:
    action: get_customer_history
    transitions:
      - target: respond
\`\`\`

## Tool Parameter Types

| Type | JSON Schema | ABL Usage |
|------|-------------|-----------|
| \`string\` | \`type: string\` | Text input |
| \`number\` | \`type: number\` | Numeric input |
| \`boolean\` | \`type: boolean\` | True/false flags |
| \`array\` | \`type: array\` | Lists of items |
| \`object\` | \`type: object\` | Nested structures |
| \`enum\` | \`enum: [...]\` | Fixed set of values |

## Security Considerations

- Never embed API keys in DSL — use \`\${env.KEY_NAME}\` references
- Tool endpoints are validated against SSRF blocklists (private IPs blocked)
- Tool execution runs in an isolated context from the engine
- All tool calls are traced with caller identity for audit
`;
```

**Step 4: Add Best Practices topic**

```typescript
const BEST_PRACTICES = `# Best Practices

Guidelines for authoring effective ABL agents.

## Agent Design

**Define a clear GOAL.** The GOAL drives LLM behavior. Be specific:
- Bad: \`Help users\`
- Good: \`Help users troubleshoot network connectivity issues by diagnosing symptoms and suggesting solutions\`

**Choose the right MODE.**
- \`reasoning\`: Agent decides what to do via LLM (most flexible)
- \`scripted\`: Agent follows a predefined flow (most predictable)
- Use \`scripted\` when the conversation has a known structure (forms, wizards, intake flows)
- Use \`reasoning\` when the agent needs to adapt dynamically

## Constraints

**Always add constraints to reasoning agents.** Constraints define boundaries:

\`\`\`yaml
CONSTRAINTS:
  - Only discuss topics related to the agent's domain
  - Never share customer data with unauthorized parties
  - Always confirm destructive actions before executing
  - Limit tool calls to 3 per turn to prevent runaway loops
\`\`\`

## Flow Design

**Keep flows shallow.** Deep nesting makes agents hard to debug:
- Aim for 3-7 flow steps
- Use handoffs to other agents instead of adding more steps

**Always define error transitions:**

\`\`\`yaml
transitions:
  - target: success_step
    condition: result.success == true
  - target: error_step
    condition: result.success == false
\`\`\`

## Gather Fields

**Add validation to every gather field:**

\`\`\`yaml
collect:
  - name: email
    type: string
    prompt: What is your email address?
    validation:
      pattern: "^[^@]+@[^@]+\\\\.[^@]+$"
      message: Please enter a valid email address
\`\`\`

**Use extraction hints for better parsing:**

\`\`\`yaml
collect:
  - name: date
    type: string
    prompt: When would you like to schedule?
    extraction_hints:
      - Accept formats like "tomorrow", "next Monday", "March 15"
      - Convert to ISO 8601 format
\`\`\`

## Handoffs

**Define clear handoff conditions:**

\`\`\`yaml
HANDOFFS:
  - target: billing_agent
    condition: context.topic == "billing"
    description: Transfer to billing specialist

  - target: escalation_agent
    condition: context.sentiment == "frustrated"
    description: Escalate to human support
\`\`\`

## Testing

**Test each flow path.** For scripted agents, verify:
1. Happy path completes successfully
2. Error transitions fire correctly
3. Gather field validation rejects bad input
4. Handoffs route to the correct agent

**Use the test_agent tool** to verify compilation before deployment.

## Performance

- Keep conversation history bounded (configure \`max_messages\`)
- Use specific tool descriptions (helps LLM choose the right tool faster)
- Minimize gather fields per step (1-3 fields, not 10)
- Use \`success_when\` on tools to avoid re-calling failed tools
`;
```

**Step 5: Commit static topics**

```bash
git add packages/kore-platform-cli/src/mcp/docs/index.ts
git commit -m "feat(cli): add yaml-format, extensions, tool-patterns, best-practices doc topics"
```

---

## Task 8: Wire all 5 doc topics into ABL_DOCS

**Files:**

- Modify: `packages/kore-platform-cli/src/mcp/docs/index.ts`

**Step 1: Import the generated CEL docs**

At the top of `index.ts`, add:

```typescript
import { CEL_FUNCTIONS_DOCS } from './cel-functions-generated.js';
```

**Step 2: Update ABL_DOCS to include all 5 new topics**

Replace the `ABL_DOCS` export:

```typescript
export const ABL_DOCS: Record<string, string> = {
  overview: ABL_OVERVIEW,
  'yaml-format': YAML_FORMAT,
  scripted: ABL_SCRIPTED,
  reasoning: ABL_REASONING,
  supervisor: ABL_SUPERVISOR,
  context: CONTEXT_REFERENCE,
  'cel-functions': CEL_FUNCTIONS_DOCS,
  extensions: EXTENSIONS,
  'tool-patterns': TOOL_PATTERNS,
  'best-practices': BEST_PRACTICES,
  'trace-events': TRACE_EVENTS,
  debugging: DEBUGGING_GUIDE,
  architect: ARCHITECT_DOCS,
};
```

The order now matches the Studio `TOPIC_INDEX` categories: Getting Started → Agent Types → Concepts → Patterns → Debugging → Tools.

**Step 3: Build and verify**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Clean build. `DOC_TOPICS` (derived from `Object.keys(ABL_DOCS)`) now returns all 13 topics.

**Step 4: Verify topic count**

After build, the `DOC_TOPICS` export should contain exactly 13 entries matching the Studio `TOPIC_INDEX`.

**Step 5: Commit**

```bash
git add packages/kore-platform-cli/src/mcp/docs/index.ts
git add packages/kore-platform-cli/src/mcp/docs/cel-functions-generated.ts
git commit -m "feat(cli): wire all 13 doc topics into ABL_DOCS (closes doc gap)"
```

---

## Task 9: Full verification

**Step 1: Build all affected packages**

```bash
pnpm build
```

Expected: Clean build across all packages.

**Step 2: Run existing tests**

```bash
pnpm --filter @agent-platform/kore-platform-cli test
pnpm --filter @abl/language-service test
```

Expected: All existing tests pass.

**Step 3: Verify MCP tool count**

After build, the MCP server should register:

- 5 existing remote tools (project management)
- 4 model tools
- 9 authoring tools (remote)
- 1 authoring tool (local: kore_validate_agent)
- 3 testing tools
- 3 analysis tools (local)
- 9 existing local tools (docs, architect, import, validate)
  = **34 total tools**

**Step 4: Verify doc topic count**

The `DOC_TOPICS` export should have exactly 13 entries:
`overview`, `yaml-format`, `scripted`, `reasoning`, `supervisor`, `context`, `cel-functions`, `extensions`, `tool-patterns`, `best-practices`, `trace-events`, `debugging`, `architect`

**Step 5: Verify Arch tool count**

`ALL_TOOLS` in `arch-tools.ts` should have 9 entries (6 existing + 3 new analysis tools).

**Step 6: Final commit (if any adjustments needed)**

```bash
git add -A
git commit -m "chore: verification fixes for extension gap closure"
```
