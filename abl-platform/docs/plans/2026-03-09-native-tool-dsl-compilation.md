# Native Tool DSL Compilation for E2E Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate ~200 lines of custom tool execution code in AFG E2E tests by making the platform natively compile `.tool.abl` files and execute sandbox code without MongoDB.

**Architecture:** Add a Format A → Format B adapter in `packages/shared`, fix `MockSandboxRunner` to support async code with globals (`params`, `env`, `memory`, `fetch`), fix `SandboxToolExecutor` to use a `Proxy` for `env`, and rewire the E2E test to use native tool execution.

**Tech Stack:** TypeScript, Vitest, existing `dsl-property-parser.ts` pipeline

**Security note:** `MockSandboxRunner` already uses `new Function()` for code execution (line 48). This plan extends it to `AsyncFunction` for `await` support. The `validateCodeContent` check in `SandboxToolExecutor` runs before the runner, blocking path traversal / null bytes. This is a dev/test-only code path (activated via `SANDBOX_BACKEND=mock`).

---

## Task 1: Standalone Tool DSL Adapter

Converts Format A (standalone `TOOL:` header files) to Format B (signature-first `dslContent`), then pipes through existing parsing infra.

**Files:**

- Create: `packages/shared/src/tools/standalone-tool-adapter.ts`
- Modify: `packages/shared/src/tools/index.ts`
- Test: `packages/shared/src/__tests__/tools/standalone-tool-adapter.test.ts`

### Step 1: Write the failing test

```typescript
import { describe, it, expect } from 'vitest';
import {
  convertStandaloneToolDSL,
  loadToolDSLsAsResolved,
} from '../../tools/standalone-tool-adapter.js';

describe('convertStandaloneToolDSL', () => {
  const sampleDSL = `TOOL: product_search
VERSION: "1.0"
DESCRIPTION: "Search for products"
TYPE: sandbox
RUNTIME: javascript
TIMEOUT: 15000
MEMORY_MB: 128

PARAMETERS:
  queries:
    type: object[]
    description: "Array of search queries"
    required: true

CODE: |
  const url = env.SEARCH_URL || "https://example.com";
  return { success: true };
`;

  it('converts TOOL header to signature-first format', () => {
    const result = convertStandaloneToolDSL(sampleDSL);
    // First line must be signature-first format
    expect(result).toMatch(/^product_search\(queries: object\[\]\) -> object$/m);
    expect(result).toContain('type: sandbox');
    expect(result).toContain('runtime: javascript');
    expect(result).toContain('timeout: 15000');
    expect(result).toContain('memory_mb: 128');
    expect(result).toContain('description: "Search for products"');
    expect(result).toContain('code: |');
    expect(result).toContain('const url = env.SEARCH_URL');
  });

  it('handles multiple parameters', () => {
    const dsl = `TOOL: multi_param
DESCRIPTION: "Multi param tool"
TYPE: sandbox
RUNTIME: javascript

PARAMETERS:
  query:
    type: string
    required: true
  limit:
    type: number
    required: false

CODE: |
  return { ok: true };
`;
    const result = convertStandaloneToolDSL(dsl);
    expect(result).toMatch(/^multi_param\(query: string, limit\?: number\) -> object$/m);
  });

  it('throws on missing TOOL header', () => {
    expect(() => convertStandaloneToolDSL('AGENT: foo\nGOAL: bar')).toThrow('Missing TOOL: header');
  });
});

describe('loadToolDSLsAsResolved', () => {
  const sandboxToolDSL = `TOOL: product_search
DESCRIPTION: "Search products"
TYPE: sandbox
RUNTIME: javascript
TIMEOUT: 15000

PARAMETERS:
  queries:
    type: object[]
    required: true

CODE: |
  return { success: true };
`;

  it('returns a map with ToolDefinitionLocal entries', () => {
    const result = loadToolDSLsAsResolved([sandboxToolDSL]);
    expect(result.has('product_search')).toBe(true);
    const tools = result.get('product_search')!;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('product_search');
    expect(tools[0].tool_type).toBe('sandbox');
    expect(tools[0].sandbox_binding).toBeDefined();
    expect(tools[0].sandbox_binding!.code_content).toContain('return { success: true }');
    expect(tools[0].sandbox_binding!.runtime).toBe('javascript');
  });

  it('handles multiple tool DSLs', () => {
    const tool2 = `TOOL: policy_search
DESCRIPTION: "Search policies"
TYPE: sandbox
RUNTIME: javascript

PARAMETERS:
  query:
    type: string
    required: true

CODE: |
  return { answer: "ok" };
`;
    const result = loadToolDSLsAsResolved([sandboxToolDSL, tool2]);
    expect(result.has('product_search')).toBe(true);
    expect(result.has('policy_search')).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd packages/shared && npx vitest run src/__tests__/tools/standalone-tool-adapter.test.ts`
Expected: FAIL — module not found

### Step 3: Write the implementation

Create `packages/shared/src/tools/standalone-tool-adapter.ts`:

```typescript
/**
 * Standalone Tool DSL Adapter
 *
 * Converts standalone .tool.abl files (Format A: TOOL header) into
 * signature-first dslContent (Format B) for the existing parsing pipeline.
 *
 * Format A (standalone):
 *   TOOL: product_search
 *   DESCRIPTION: "..."
 *   TYPE: sandbox
 *   ...
 *   PARAMETERS:
 *     queries:
 *       type: object[]
 *       required: true
 *   CODE: |
 *     ...
 *
 * Format B (dslContent):
 *   product_search(queries: object[]) -> object
 *     type: sandbox
 *     description: "..."
 *     code: |
 *       ...
 */

import {
  parseDslProperties,
  buildSandboxBindingFromProps,
  buildHttpBindingFromProps,
  parseSignatureLine,
  parseDslParamMetadata,
  parseReturnTypeString,
} from './dsl-property-parser.js';
import type { ToolDefinitionLocal, ToolParameterLocal } from './resolve-tool-implementations.js';

// ─── Types ────────────────────────────────────────────────────────────────

interface ParsedStandaloneParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

// ─── Format A Parser ──────────────────────────────────────────────────────

/**
 * Parse the PARAMETERS: block from a standalone .tool.abl file.
 */
function parseStandaloneParameters(content: string): ParsedStandaloneParam[] {
  const lines = content.split('\n');
  const params: ParsedStandaloneParam[] = [];
  let inParams = false;
  let paramsIndent = -1;
  let currentParam: ParsedStandaloneParam | null = null;
  let paramIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (inParams) {
      if (trimmed && indent <= paramsIndent) break;
      if (!trimmed) continue;

      if (currentParam && indent > paramIndent) {
        const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
        if (match) {
          const [, key, rawValue] = match;
          const value = rawValue.replace(/^["']|["']$/g, '').trim();
          if (key === 'type') currentParam.type = value;
          else if (key === 'required') currentParam.required = value === 'true';
          else if (key === 'description') currentParam.description = value;
        }
      } else {
        const nameMatch = trimmed.match(/^(\w+)\s*:\s*$/);
        if (nameMatch) {
          currentParam = { name: nameMatch[1], type: 'string', required: false };
          paramIndent = indent;
          params.push(currentParam);
        }
      }
    } else if (trimmed === 'PARAMETERS:') {
      inParams = true;
      paramsIndent = indent;
    }
  }

  return params;
}

/**
 * Parse top-level key: value headers from a standalone .tool.abl file.
 * Only reads uppercase keys (TOOL, TYPE, RUNTIME, etc.) and DESCRIPTION.
 */
function parseStandaloneHeaders(content: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Stop at PARAMETERS: or CODE: blocks
    if (trimmed === 'PARAMETERS:' || trimmed.startsWith('CODE:')) break;

    const match = trimmed.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (match) {
      headers[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return headers;
}

/**
 * Extract the CODE: | block from a standalone .tool.abl file.
 */
function extractStandaloneCodeBlock(content: string): string | null {
  const lines = content.split('\n');
  let capturing = false;
  let baseIndent = -1;
  const codeLines: string[] = [];

  for (const line of lines) {
    if (capturing) {
      if (baseIndent === -1 && line.trim()) {
        baseIndent = line.length - line.trimStart().length;
      }
      if (line.trim() === '' || line.length - line.trimStart().length >= baseIndent) {
        codeLines.push(baseIndent > 0 ? line.slice(baseIndent) : line);
      } else if (line.trim()) {
        break;
      } else {
        codeLines.push('');
      }
    } else if (line.trimStart().startsWith('CODE:') && line.trimStart().endsWith('|')) {
      capturing = true;
    }
  }

  return codeLines.length > 0 ? codeLines.join('\n').trimEnd() : null;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Convert a standalone .tool.abl file (Format A) to signature-first dslContent (Format B).
 *
 * Throws if the content does not contain a TOOL: header line.
 */
export function convertStandaloneToolDSL(content: string): string {
  const headers = parseStandaloneHeaders(content);
  const toolName = headers.TOOL;
  if (!toolName) {
    throw new Error('Missing TOOL: header in standalone tool DSL');
  }

  const params = parseStandaloneParameters(content);
  const codeBlock = extractStandaloneCodeBlock(content);

  // Build signature line: name(param1: type1, param2?: type2) -> object
  const paramParts = params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`);
  const signatureLine = `${toolName}(${paramParts.join(', ')}) -> object`;

  // Build property lines
  const propLines: string[] = [];
  if (headers.TYPE) propLines.push(`  type: ${headers.TYPE.toLowerCase()}`);
  if (headers.RUNTIME) propLines.push(`  runtime: ${headers.RUNTIME.toLowerCase()}`);
  if (headers.TIMEOUT) propLines.push(`  timeout: ${headers.TIMEOUT}`);
  if (headers.MEMORY_MB) propLines.push(`  memory_mb: ${headers.MEMORY_MB}`);
  if (headers.DESCRIPTION) propLines.push(`  description: "${headers.DESCRIPTION}"`);

  // Build params metadata block
  const paramMetaLines: string[] = [];
  const hasParamMeta = params.some((p) => p.description);
  if (hasParamMeta) {
    paramMetaLines.push('  params:');
    for (const p of params) {
      if (p.description) {
        paramMetaLines.push(`    ${p.name}:`);
        paramMetaLines.push(`      description: "${p.description}"`);
      }
    }
  }

  // Build code block
  const codeLines: string[] = [];
  if (codeBlock) {
    codeLines.push('  code: |');
    for (const line of codeBlock.split('\n')) {
      codeLines.push(line ? `    ${line}` : '');
    }
  }

  return [signatureLine, ...propLines, ...paramMetaLines, ...codeLines].join('\n');
}

/**
 * Load standalone .tool.abl DSL strings and resolve them into ToolDefinitionLocal entries.
 *
 * Returns a map of tool name -> [ToolDefinitionLocal] (single-element array per tool).
 * This map is compatible with compileToResolvedAgent's resolvedToolImplementations parameter.
 */
export function loadToolDSLsAsResolved(toolDSLs: string[]): Map<string, ToolDefinitionLocal[]> {
  const result = new Map<string, ToolDefinitionLocal[]>();

  for (const rawDSL of toolDSLs) {
    const dslContent = convertStandaloneToolDSL(rawDSL);
    const sig = parseSignatureLine(dslContent);
    const props = parseDslProperties(dslContent);
    const paramMeta = parseDslParamMetadata(dslContent);
    const toolType = (props.type || 'sandbox') as 'http' | 'sandbox' | 'mcp' | 'searchai';

    // Build binding based on type
    let sandbox_binding: ToolDefinitionLocal['sandbox_binding'];
    let http_binding: ToolDefinitionLocal['http_binding'];
    if (toolType === 'sandbox') {
      sandbox_binding = buildSandboxBindingFromProps(props, dslContent);
    } else if (toolType === 'http') {
      http_binding = buildHttpBindingFromProps(props, dslContent);
    }

    const toolDef: ToolDefinitionLocal = {
      name: dslContent.split('(')[0].trim(),
      description: props.description || '',
      parameters: sig.parameters.map((p) => {
        const meta = paramMeta.get(p.name);
        const param: ToolParameterLocal = {
          name: p.name,
          type: p.type,
          required: p.required,
          ...(meta?.description && { description: meta.description }),
        };
        return param;
      }),
      returns: parseReturnTypeString(sig.returnType),
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: true,
        side_effects: true,
        requires_auth: false,
        timeout: props.timeout ? Number(props.timeout) : undefined,
      },
      tool_type: toolType,
      sandbox_binding,
      http_binding,
    };

    result.set(toolDef.name, [toolDef]);
  }

  return result;
}
```

### Step 4: Run test to verify it passes

Run: `cd packages/shared && npx vitest run src/__tests__/tools/standalone-tool-adapter.test.ts`
Expected: PASS

### Step 5: Export from index

Add to `packages/shared/src/tools/index.ts`:

```typescript
// ─── Standalone Tool DSL Adapter ──────────────────────────────────────
export { convertStandaloneToolDSL, loadToolDSLsAsResolved } from './standalone-tool-adapter.js';
```

### Step 6: Commit

```bash
git add packages/shared/src/tools/standalone-tool-adapter.ts packages/shared/src/__tests__/tools/standalone-tool-adapter.test.ts packages/shared/src/tools/index.ts
git commit -m "feat(shared): add standalone .tool.abl adapter for Format A to Format B conversion"
```

---

## Task 2: Fix MockSandboxRunner to Support Async Code + Globals

The tool DSL code uses `await fetch()`, `params.queries`, `env.KEY`, and `memory.get_content()`. The current `MockSandboxRunner` uses synchronous `new Function()` with `$`-prefixed args — none of these work.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/mock-sandbox-runner.ts`
- Modify: `packages/compiler/src/__tests__/constructs/mock-sandbox-runner.test.ts`

### Step 1: Write the failing tests

Add these tests to `packages/compiler/src/__tests__/constructs/mock-sandbox-runner.test.ts`:

```typescript
// ─── Globals Injection ────────────────────────────────────────────────

describe('globals injection', () => {
  it('injects params as a global object', async () => {
    const runner = new MockSandboxRunner();
    const result = await runner.run({
      functionName: 'use_params',
      runtime: 'javascript',
      codeContent: 'return { q: params.query };',
      params: { query: 'test' },
      ...defaults,
      globals: {},
    });
    expect(result).toEqual({ q: 'test' });
  });

  it('injects env global from globals', async () => {
    const runner = new MockSandboxRunner();
    const mockEnv = {
      get: (key: string) => (key === 'MY_URL' ? 'https://example.com' : undefined),
    };
    const result = await runner.run({
      functionName: 'use_env',
      runtime: 'javascript',
      codeContent: 'return { url: env.get("MY_URL") };',
      params: {},
      ...defaults,
      globals: { env: mockEnv },
    });
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('injects memory global from globals', async () => {
    const runner = new MockSandboxRunner();
    const mockMemory = {
      get_content: async () => ({ data: { content: { foo: 'bar' } } }),
      set_content: async () => {},
    };
    const result = await runner.run({
      functionName: 'use_memory',
      runtime: 'javascript',
      codeContent: 'const m = await memory.get_content("key"); return { val: m.data.content.foo };',
      params: {},
      ...defaults,
      globals: { memory: mockMemory },
    });
    expect(result).toEqual({ val: 'bar' });
  });

  it('supports async code with await', async () => {
    const runner = new MockSandboxRunner();
    const result = await runner.run({
      functionName: 'async_tool',
      runtime: 'javascript',
      codeContent: 'const val = await Promise.resolve(42); return { answer: val };',
      params: {},
      ...defaults,
      globals: {},
    });
    expect(result).toEqual({ answer: 42 });
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/mock-sandbox-runner.test.ts`
Expected: FAIL — globals not accepted, async not supported

### Step 3: Implement the fix

In `packages/compiler/src/platform/constructs/executors/mock-sandbox-runner.ts`:

**Replace** the `executeJsMockCode` function (lines 31-61) with:

```typescript
/**
 * Execute JavaScript code_content from seeded mock tools.
 *
 * Uses AsyncFunction to support `await` in tool code.
 * Injects globals (params, env, memory, secrets, fetch) as named function args
 * alongside $-prefixed param args (for backward compatibility with Gvisor convention).
 *
 * SECURITY: Uses AsyncFunction (derived from Function) — same scope isolation as
 * the existing new Function() approach. The validateCodeContent check in
 * SandboxToolExecutor runs before the runner, blocking path traversal / null bytes.
 * This code path is only active via SANDBOX_BACKEND=mock (dev/test).
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as typeof Function;

async function executeJsMockCode(
  codeContent: string,
  params: unknown,
  timeoutMs: number,
  globals?: Record<string, unknown>,
): Promise<unknown> {
  const code = codeContent.trim();
  if (!code) {
    return { success: true, message: 'mock executed (empty code)' };
  }

  // Build $-prefixed arg names from params (backward compat with Gvisor convention)
  const paramObj = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const argNames = Object.keys(paramObj).map((k) => `$${k}`);
  const argValues = Object.values(paramObj);

  // Inject globals: params (whole object), fetch, plus any from globals map
  const globalNames = ['params', 'fetch'];
  const globalValues: unknown[] = [paramObj, globalThis.fetch];
  if (globals) {
    for (const [key, value] of Object.entries(globals)) {
      if (!globalNames.includes(key)) {
        globalNames.push(key);
        globalValues.push(value);
      }
    }
  }

  const allArgNames = [...globalNames, ...argNames];
  const allArgValues = [...globalValues, ...argValues];

  // Use AsyncFunction to support `await` in tool code
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new AsyncFunction(...allArgNames, code);
    const result = await fn(...allArgValues);
    return result;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Mock sandbox timed out after ${timeoutMs}ms`);
    }
    throw new Error(
      `Mock JS execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
```

**Update** `MockSandboxRunner.run()` — add `globals` to the signature and forward it:

Change the `run` method signature (line 98-104) to:

```typescript
  async run(config: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
    globals?: Record<string, unknown>;
  }): Promise<unknown> {
    const { functionName, runtime, codeContent, params, limits, globals } = config;
```

Change the JS execution call (line 140) from:

```typescript
const result = executeJsMockCode(codeContent, params, limits.timeoutMs);
```

to:

```typescript
const result = await executeJsMockCode(codeContent, params, limits.timeoutMs, globals);
```

### Step 4: Run test to verify it passes

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/mock-sandbox-runner.test.ts`
Expected: ALL PASS (both old and new tests)

### Step 5: Commit

```bash
git add packages/compiler/src/platform/constructs/executors/mock-sandbox-runner.ts packages/compiler/src/__tests__/constructs/mock-sandbox-runner.test.ts
git commit -m "feat(compiler): support async code and globals injection in MockSandboxRunner"
```

---

## Task 3: Fix SandboxToolExecutor `env` Proxy

Replace `globals.env = { get: ... }` with a `Proxy` that supports both property access (`env.MY_KEY`) and method call (`env.get('MY_KEY')`).

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` (lines 144-148)

### Step 1: Write the change

In `sandbox-tool-executor.ts`, replace lines 144-148:

Old:

```typescript
if (this.secrets.getEnvVar) {
  globals.env = {
    get: (key: string) => this.secrets!.getEnvVar!(key),
  };
}
```

New:

```typescript
if (this.secrets.getEnvVar) {
  const getEnvVar = this.secrets.getEnvVar.bind(this.secrets);
  globals.env = new Proxy(
    { get: (key: string) => getEnvVar(key) },
    {
      get(target, prop) {
        if (prop === 'get') return target.get;
        if (typeof prop === 'string') return getEnvVar(prop);
        return undefined;
      },
    },
  );
}
```

### Step 2: Run existing tests to verify no regression

Run: `cd packages/compiler && npx vitest run src/__tests__/constructs/`
Expected: ALL PASS

### Step 3: Commit

```bash
git add packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts
git commit -m "feat(compiler): use Proxy for env global to support property access in sandbox tools"
```

---

## Task 4: Rewire AFG E2E Test

Remove custom tool executors and use native sandbox execution via the adapter + MockSandboxRunner.

**Files:**

- Modify: `apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`

### Step 1: Build packages

Run: `pnpm build --filter @agent-platform/shared --filter @abl/compiler`
Expected: Build succeeds

### Step 2: Rewrite the test

**Remove** (lines 113-212): The entire `EXTERNAL API TOOL EXECUTORS` section — `executeProductSearch()`, `executePolicySearch()`, `AFG_PRODUCT_SEARCH_URL` constant.

**Add** after the `loadDSL` function (around line 112):

```typescript
// =============================================================================
// LOAD TOOL DSL FILES
// =============================================================================

import { loadToolDSLsAsResolved } from '@agent-platform/shared/tools/standalone-tool-adapter';
import type { ToolDefinition } from '@abl/compiler';

// Load tool DSL files and resolve into IR with sandbox bindings
const productSearchToolDSL = loadDSL('tools/product_search.tool.abl');
const policySearchToolDSL = loadDSL('tools/policy_search.tool.abl');

function resolveToolDSLs(): Map<string, ToolDefinition[]> {
  const resolved = loadToolDSLsAsResolved([productSearchToolDSL, policySearchToolDSL]);
  // Convert to Map<agentName, ToolDefinition[]> for compileToResolvedAgent
  // Tools are keyed by tool name — we need to map them to the agents that declare them
  const byAgent = new Map<string, ToolDefinition[]>();
  const advisorTools: ToolDefinition[] = [];
  const policyTools: ToolDefinition[] = [];

  const productSearch = resolved.get('product_search');
  if (productSearch) advisorTools.push(...(productSearch as unknown as ToolDefinition[]));

  const policySearch = resolved.get('policy_search');
  if (policySearch) policyTools.push(...(policySearch as unknown as ToolDefinition[]));

  if (advisorTools.length) byAgent.set('Advisor_Agent', advisorTools);
  if (policyTools.length) byAgent.set('Store_Policy_Agent', policyTools);

  return byAgent;
}
```

**Add** `SANDBOX_BACKEND=mock` in `beforeAll`:

```typescript
beforeAll(async () => {
  if (SKIP_REASON) return;

  // Use mock sandbox runner for E2E tests (executes JS inline via AsyncFunction)
  process.env.SANDBOX_BACKEND = 'mock';

  // ... rest of beforeAll unchanged
});
```

**Rewrite `createAfgSession`** — remove the monkey-patch block (lines 449-472):

```typescript
function createAfgSession(): RuntimeSession {
  const resolvedTools = resolveToolDSLs();
  const resolved = compileToResolvedAgent(
    [supervisorDSL, advisorDSL, policyDSL],
    'GuardRail_Supervisor',
    undefined,
    resolvedTools,
  );

  // Enable inline gather on Advisor_Agent
  const advisorIR = resolved.agents['Advisor_Agent'];
  if (advisorIR) {
    advisorIR.execution.inline_gather = true;
  }

  // Enable pipeline classifier on supervisor for fast Qwen-based routing
  const supervisorIR = resolved.agents['GuardRail_Supervisor'];
  if (supervisorIR) {
    supervisorIR.execution.pipeline = {
      enabled: true,
      mode: 'sequential',
      model: 'qwen3-30b',
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.85,
      },
      toolFilter: {
        enabled: false,
      },
      keywordVeto: {
        enabled: true,
        keywords: [],
      },
    };
  }

  const session = executor.createSessionFromResolved(resolved, {
    tenantId: 'afg-test',
    projectId: 'afg-blue-advisory',
    userId: 'e2e_test_user',
  });

  // No monkey-patching needed — platform sandbox executes tool CODE blocks natively

  return session;
}
```

**Rewrite `createAfgSessionNoPipeline`** — same pattern, remove monkey-patch:

```typescript
function createAfgSessionNoPipeline(): RuntimeSession {
  const resolvedTools = resolveToolDSLs();
  const resolved = compileToResolvedAgent(
    [supervisorDSL, advisorDSL, policyDSL],
    'GuardRail_Supervisor',
    undefined,
    resolvedTools,
  );

  const advisorIR = resolved.agents['Advisor_Agent'];
  if (advisorIR) {
    advisorIR.execution.inline_gather = true;
  }

  // No pipeline — supervisor uses full GPT-4.1

  const session = executor.createSessionFromResolved(resolved, {
    tenantId: 'afg-test',
    projectId: 'afg-blue-advisory',
    userId: 'e2e_test_user',
  });

  return session;
}
```

### Step 3: Run the test

Run: `cd apps/runtime && npx vitest run src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`
Expected: Tests skip if OPENAI_API_KEY not set, or pass if set.

### Step 4: Commit

```bash
git add apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts
git commit -m "refactor(runtime): replace custom tool executors with native sandbox execution in AFG E2E test"
```

---

## Task 5: Final Verification

### Step 1: Run full compiler test suite

Run: `cd packages/compiler && pnpm test`
Expected: ALL PASS

### Step 2: Run full shared test suite

Run: `cd packages/shared && pnpm test`
Expected: ALL PASS

### Step 3: Run runtime tests (excluding known pre-existing failures)

Run: `cd apps/runtime && pnpm test -- --reporter=verbose 2>&1 | tail -30`
Expected: No new failures introduced

### Step 4: Prettier

Run: `npx prettier --write packages/shared/src/tools/standalone-tool-adapter.ts packages/shared/src/__tests__/tools/standalone-tool-adapter.test.ts packages/shared/src/tools/index.ts packages/compiler/src/platform/constructs/executors/mock-sandbox-runner.ts packages/compiler/src/__tests__/constructs/mock-sandbox-runner.test.ts packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts apps/runtime/src/__tests__/e2e/afg-blue-advisory/afg-abl-runtime.e2e.test.ts`
