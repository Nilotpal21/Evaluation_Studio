# Singleton Tool Executors + Execution Pipeline Cleanup

**Date**: 2026-02-23
**Status**: Draft
**Scope**: `packages/compiler/src/platform/constructs/executors/`, `apps/runtime/src/services/execution/`

## Problem

### 1. Per-Session Executor Waste

Tool executors are created per-session. Each session allocates its own executor tree with its own circuit breakers, rate limiters, OAuth token cache, and tool registry — even when sessions target the same tools.

- Circuit breaker in session A doesn't protect session B from the same broken endpoint
- Each session's OAuth token cache starts cold — redundant token fetches
- Rate limiters per-session — tenant rate budget not enforced across sessions
- Redundant memory: N copies of the same Maps, resilience state, middleware chains

### 2. Redundancies in the Execution Pipeline

Traced the full lifecycle for HTTP, MCP, and Sandbox tool types. Found:

| Redundancy                                                                                                                                          | Location                                                            | Impact                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Dual tracing** — inline trace in ToolBindingExecutor + middleware logging. Inline path unreachable when middleware present (always in production) | `tool-binding-executor.ts:252-275`                                  | Dead code path                                                                                         |
| **Double header sanitization** — CRLF stripped on individual headers during resolution, then ALL headers re-sanitized before fetch                  | `http-tool-executor.ts:195` + `~227-231`                            | Wasted CPU per call                                                                                    |
| **Double MCP result parsing** — EphemeralMcpClient extracts text + JSON.parses, then normalizeMcpResult processes same content blocks               | `inline-mcp-provider.ts:~232-251` vs `mcp-tool-executor.ts:283-333` | **Bug**: early JSON.parse destroys content array, normalizeMcpResult never sees original MCP structure |
| **Duplicate audit logging** — ToolBindingExecutor mandatory `log.info('tool.execution')` AND middleware `createAuditMiddleware` both always run     | `tool-binding-executor.ts:279-291` + audit middleware               | Duplicate audit entries                                                                                |
| **Per-session ResilienceFactory** — `createToolResilienceFactory(tenantId)` called per session, but it's stateless                                  | `llm-wiring.ts:~326`                                                | Unnecessary allocation                                                                                 |

### 3. Gaps in the Execution Pipeline

| Gap                                                                                                                               | Location                                                 | Severity |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------- |
| **Hardcoded 30s timeout** — callers hardcode 30000 instead of reading `tool.hints.timeout` or `agentIR.execution.tool_timeout_ms` | `reasoning-executor.ts:574`, `flow-step-executor.ts:113` | Medium   |
| **No response size limit on MCP** — HTTP has 10MB, Sandbox has 5MB, MCP has none                                                  | `mcp-tool-executor.ts`                                   | Medium   |
| **Circuit breaker state never TTLs** — breakers persist indefinitely, only evicted by FIFO at 2000 entries                        | All executors                                            | Low      |
| **No MCP connection pooling** — EphemeralMcpClient connect→call→disconnect per invocation, spawns new process for stdio           | `inline-mcp-provider.ts:~196-261`                        | High     |
| **Resilience not traced** — breaker trips, rate limiter waits, retries only at debug level                                        | All executors                                            | Medium   |
| **Caller context not in tool trace** — `tool_call` trace event missing `callerContext`                                            | `reasoning-executor.ts:638-655`                          | Low      |
| **Proxy routing not audited**                                                                                                     | HTTP executor + MCP provider                             | Low      |

### 4. Dead Code

| Item                                                                      | Location                           |
| ------------------------------------------------------------------------- | ---------------------------------- |
| `createToolBindingExecutor()` factory — unused                            | `tool-binding-executor.ts:462-479` |
| `LambdaToolExecutor` stub — deprecated, throws                            | `lambda-tool-executor.ts` + test   |
| Inline trace logging in ToolBindingExecutor — unreachable with middleware | `tool-binding-executor.ts:252-275` |
| `MCPClient.subscribeResource()` / `unsubscribeResource()` — never called  | `client.ts:432-444`                |

### 5. Inconsistencies Across Tool Types

| Concern              | HTTP               | MCP                    | Sandbox            |
| -------------------- | ------------------ | ---------------------- | ------------------ |
| Response size limit  | 10MB               | **None**               | 5MB                |
| Circuit breaker      | Yes                | Yes                    | **No**             |
| Rate limiter         | Yes (from IR)      | **No**                 | **No**             |
| Retry                | Yes (configurable) | Fixed 1 retry          | **No**             |
| Result normalization | None               | `normalizeMcpResult()` | JSON.parse attempt |
| Connection pooling   | N/A (stateless)    | **No** (ephemeral)     | N/A                |

---

## Design

### Core Principle

Executors become **stateless method dispatchers with shared caches**. Everything session-specific is passed per-call. All redundant code paths are eliminated.

```
execute(tool, params, context) → result
```

### New Interface

```typescript
export interface ToolExecutionContext {
  tenantId: string;
  sessionContext: ToolSessionContext;
  secrets: SecretsProvider;
  trace?: TraceContextManager;
  proxyResolver?: ProxyResolver;
  projectId?: string;
}

export interface ToolExecutionRequest {
  tool: ToolDefinition;
  params: Record<string, unknown>;
  timeoutMs: number;
  context: ToolExecutionContext;
}

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<unknown>;
  executeParallel(
    requests: ToolExecutionRequest[],
  ): Promise<Array<{ name: string; result?: unknown; error?: string }>>;
}
```

### Singleton Topology

```
LLMWiringService (singleton on RuntimeExecutor)
  ├── httpExecutor: HttpToolExecutor        — singleton
  ├── mcpExecutor: McpToolExecutor          — singleton
  ├── sandboxExecutor: SandboxToolExecutor  — singleton
  ├── resilienceFactory: ResilienceFactory  — singleton
  ├── tokenCache: TokenCache               — singleton (shared OAuth)
  └── mcpClientProvider: McpClientProvider  — singleton (connection pool)
```

### Cleanup Decisions

**Remove inline tracing from ToolBindingExecutor** — middleware always handles it in production. The inline path (lines 252-275) is dead code. Single tracing path via middleware only.

**Remove duplicate audit log** — ToolBindingExecutor's `log.info('tool.execution')` (lines 279-291) removed. Audit middleware is the single source of audit logging.

**Fix MCP double-parsing** — Remove text extraction from `EphemeralMcpClient.callTool()`. Return raw MCP `ToolCallResult` to McpToolExecutor. Let `normalizeMcpResult()` be the single normalization point.

**Single header sanitization pass** — Sanitize once when headers are built, not again before fetch.

**Read timeout from IR** — ToolBindingExecutor facade reads `tool.hints.timeout` or defaults to caller's timeout. Callers no longer need to hardcode 30000.

**Add response size limit to MCP** — Bounded response reading (10MB, same as HTTP) inside McpToolExecutor.

**Delete dead code**:

- `createToolBindingExecutor()` factory
- `LambdaToolExecutor` stub + test
- Unreachable inline trace block in ToolBindingExecutor

**Add callerContext to tool trace** — reasoning-executor includes `callerContext` in `tool_call` trace event.

### ToolBindingExecutor — Lightweight Per-Session Facade

Still created per-session, but allocation is trivial — stores references, not owned objects:

```typescript
class ToolBindingExecutor implements ToolExecutor {
  // Singleton references (not owned)
  private httpExecutor: HttpToolExecutor;
  private mcpExecutor: McpToolExecutor;
  private sandboxExecutor: SandboxToolExecutor;

  // Per-session context (closed over for caller convenience)
  private executionContext: ToolExecutionContext;
  private tools: Map<string, ToolDefinition>;
  private middleware: ToolMiddleware[];
  private composedMiddlewareFn?: ToolMiddlewareNext;
  private maxConcurrency: number;
}
```

The `execute(name, params, timeout)` method:

1. Looks up tool by name from its local `tools` map
2. Resolves effective timeout: `min(timeout, tool.hints.timeout)` — IR config respected
3. Builds `ToolExecutionRequest` from tool + params + effective timeout + closed-over context
4. Runs through middleware chain (single path — no inline tracing fallback)
5. Routes to the appropriate singleton executor based on `tool.tool_type`

**Callers see no change** — `session.toolExecutor.execute(name, params, timeout)` still works.

### What Improves

| Aspect            | Before                                   | After                                      |
| ----------------- | ---------------------------------------- | ------------------------------------------ |
| Circuit breakers  | Per-session (trip protects 1 session)    | Shared (trip protects all sessions on pod) |
| Rate limiters     | Per-session (not enforced globally)      | Shared (enforced across sessions)          |
| OAuth tokens      | Cold cache per session                   | Warm shared cache                          |
| Memory            | N executor trees × M tools               | 3 singletons + N lightweight facades       |
| Session creation  | Heavy (3 sub-executors, filter, compose) | Lightweight (store refs + context)         |
| Tracing           | Dual paths (inline + middleware)         | Single path (middleware only)              |
| Audit             | Duplicate (inline log + middleware)      | Single source (middleware only)            |
| MCP results       | Double-parsed (data loss)                | Single normalization (preserves structure) |
| Timeouts          | Hardcoded 30s                            | IR-configurable per tool                   |
| MCP response size | Unbounded                                | 10MB limit (matches HTTP)                  |

---

## Implementation Plan

_Merged from `2026-02-23-singleton-tool-executors-plan.md`._

## Task 1: Define `ToolExecutionContext` and `ToolExecutionRequest` types

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`
- Modify: `packages/compiler/src/platform/constructs/types.ts`
- Modify: `packages/compiler/src/platform/constructs/index.ts`

**Step 1: Move `ToolSessionContext` to tool-middleware.ts and add `ToolExecutionContext`**

> **[GAP FIX S8]**: `ToolSessionContext` must live in `tool-middleware.ts` (not `tool-binding-executor.ts`) to avoid a circular type import. Move the interface here and re-export from `tool-binding-executor.ts` for backward compatibility.

Add after the existing `ToolCallResult` interface (line 25). This is the per-call context that singleton executors receive:

```typescript
import type { SecretsProvider } from './secrets-provider.js';
import type { ProxyResolver } from './proxy-resolver.js';
import type { McpClientProvider } from './mcp-tool-executor.js';

/**
 * Caller identity context propagated from the edge layer.
 * Structural mirror of `CallerContext` from `@agent-platform/shared/types` —
 * kept standalone to avoid adding a shared dependency to the compiler package.
 * Source: tool-binding-executor.ts:40-49
 */
export interface ToolCallerContext {
  channel?: string;
  channelId?: string;
  identityTier?: number;
  verificationMethod?: string;
  contactId?: string;
  customerId?: string;
  sourceIp?: string;
  userAgent?: string;
}

/** Session context for tool execution (moved here from tool-binding-executor.ts to avoid circular imports) */
export interface ToolSessionContext {
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  callerContext?: ToolCallerContext;
  /** Execution source tag for audit — 'test' (Studio), 'production', 'staging' */
  source?: 'test' | 'production' | 'staging';
}

/**
 * Per-call execution context passed to singleton executors.
 * Contains everything session/tenant-specific needed to dispatch a tool call.
 * Executors MUST NOT store this — it changes per call.
 */
export interface ToolExecutionContext {
  tenantId: string;
  sessionContext: ToolSessionContext;
  secrets: SecretsProvider;
  proxyResolver?: ProxyResolver;
  projectId?: string;
  /** Per-session MCP client provider — needed because MCP clients require tenant-scoped decryption */
  mcpClients?: McpClientProvider;
}
```

Then in `tool-binding-executor.ts`, replace the local `ToolCallerContext` and `ToolSessionContext` definitions with re-exports:

```typescript
export type { ToolCallerContext, ToolSessionContext } from './tool-middleware.js';
```

> **NOTE**: Both `ToolCallerContext` and `ToolSessionContext` are currently exported from `index.ts` via `tool-binding-executor.js` (lines 134-135). The re-export preserves backward compatibility.

**Step 2: Add `executionContext` field to `ToolCallContext`**

Extend `ToolCallContext` (line 14-20) so middleware can read session/tenant info:

```typescript
export interface ToolCallContext {
  toolName: string;
  params: Record<string, unknown>;
  timeoutMs: number;
  tool?: ToolDefinition;
  metadata?: Record<string, unknown>;
  /** Per-call execution context for singleton executors */
  executionContext?: ToolExecutionContext;
}
```

**Step 3: Add `ToolExecutionRequest` to types.ts**

Add after the `ToolExecutor` interface (line 544):

```typescript
/**
 * Per-call request for singleton tool executors.
 * Tool definition + params + timeout + session context — everything needed for one dispatch.
 */
export interface ToolExecutionRequest {
  tool: import('../ir/schema.js').ToolDefinition;
  params: Record<string, unknown>;
  timeoutMs: number;
  context: import('./executors/tool-middleware.js').ToolExecutionContext;
}
```

**Step 4: Export from constructs index**

Add to `packages/compiler/src/platform/constructs/index.ts`:

```typescript
export type { ToolExecutionContext } from './executors/tool-middleware.js';
export type { ToolExecutionRequest } from './types.js';
```

**Step 5: Build**

Run: `pnpm --filter @abl/compiler build`
Expected: SUCCESS — types only, no runtime changes yet.

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/tool-middleware.ts \
       packages/compiler/src/platform/constructs/types.ts \
       packages/compiler/src/platform/constructs/index.ts
git commit -m "feat(compiler): add ToolExecutionRequest and ToolExecutionContext types"
```

---

## Task 2: Refactor HttpToolExecutor to singleton

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Modify: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

**What changes:** HttpToolExecutor drops `httpTools` map, `secrets`, and `tenantId` from instance state. These are passed per-call via `ToolExecutionRequest`. Shared state stays on `this`: `rateLimiters`, `circuitBreakers`, `tokenCache`, `resilienceFactory`.

**What stays the same:** The old `execute(toolName, params, timeoutMs)` method remains for backward compatibility but is marked `@deprecated`. Existing tests continue to pass.

**Step 1: Write failing tests for `executeRequest`**

Add new test block in `http-tool-executor.test.ts`:

```typescript
describe('HttpToolExecutor singleton (executeRequest)', () => {
  it('should execute with per-call tool definition and context', async () => {
    const executor = new HttpToolExecutor({
      tools: [], // No tools baked in — singleton mode
      secrets: mockSecrets,
      resilienceFactory: mockResilienceFactory,
    });

    const result = await executor.executeRequest({
      tool: httpTool, // Tool passed per-call
      params: { city: 'NYC' },
      timeoutMs: 5000,
      context: {
        tenantId: 'tenant-1',
        secrets: mockSecrets,
        sessionContext: { sessionId: 'sess-1', tenantId: 'tenant-1' },
      },
    });

    expect(result).toBeDefined();
  });

  it('should share circuit breakers across calls with same tenantId:toolName', async () => {
    const executor = new HttpToolExecutor({
      tools: [],
      secrets: mockSecrets,
      resilienceFactory: mockResilienceFactory,
    });

    // First call fails → records failure on breaker
    // Second call with same tenantId+tool → sees the failure count
    // Verify breaker key is `tenant-1:weather_api`
  });

  it('should isolate breakers across tenants', async () => {
    // tenant-A breaker trip should NOT affect tenant-B
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @abl/compiler test -- --run -t "singleton"`
Expected: FAIL with `executeRequest is not a function`

**Step 3: Implement `executeRequest` method**

In `http-tool-executor.ts`:

1. Add new method that accepts `ToolExecutionRequest`:

```typescript
import type { ToolExecutionRequest } from '../types.js';

/**
 * Singleton entry point — tool definition and context passed per-call.
 * Shared state (breakers, limiters, tokenCache) stays on `this`.
 */
async executeRequest(request: ToolExecutionRequest): Promise<unknown> {
  const { tool, params, timeoutMs, context } = request;
  if (!tool.http_binding) {
    throw new ToolExecutionError({
      code: 'TOOL_NOT_FOUND',
      message: `HTTP tool has no http_binding: ${tool.name}`,
      toolName: tool.name,
      toolType: 'http',
    });
  }
  // Delegate to core logic with per-call secrets, tenantId, proxyResolver
  return this._executeHttp(tool, tool.http_binding, params, timeoutMs, context.secrets, context.tenantId, context.proxyResolver);
}
```

2. Extract core logic from `execute()` into `_executeHttp(tool, binding, params, timeoutMs, secrets, tenantId, proxyResolver)`. Both `execute()` and `executeRequest()` delegate to it.

3. All `this.secrets` references in `_executeHttp` become `secrets` parameter. All `this.tenantId` references become `tenantId` parameter. `this.proxyResolver` becomes `proxyResolver` parameter with fallback to `this.proxyResolver`.

4. **Fix double header sanitization**: Remove the second pass at lines 227-231:

```typescript
// REMOVE THIS — headers are already sanitized in resolvePlaceholders() and applyAuth()
// for (const [key, value] of Object.entries(headers)) {
//   headers[key] = sanitizeHeaderValue(value);
// }
```

The per-header sanitization at line 195 (`sanitizeHeaderValue`) and in `applyAuth` is sufficient.

5. Mark old `execute()` with `@deprecated`:

```typescript
/**
 * @deprecated Use `executeRequest()` for singleton mode.
 * Retained for backward compatibility with direct construction.
 */
async execute(toolName: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
```

**Step 4: Run tests — expect PASS**

Run: `pnpm --filter @abl/compiler test -- --run`
Expected: ALL PASS (old tests + new singleton tests)

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/http-tool-executor.ts \
       packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts
git commit -m "feat(compiler): singleton HttpToolExecutor with executeRequest + single-pass header sanitization"
```

---

## Task 3: Fix MCP double-parsing bug + refactor McpToolExecutor to singleton

**Files:**

- Modify: `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`
- Modify: `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`

**The bug:** `EphemeralMcpClient.callTool()` (inline-mcp-provider.ts:241-248) extracts the first text block, JSON.parses it, and returns that single value. Multi-content MCP results (text + image + resource) lose all non-first content blocks. Then `normalizeMcpResult()` in McpToolExecutor never sees the original content array structure.

**Step 1: Write failing test for multi-content MCP result**

In `mcp-tool-executor.test.ts`, add:

```typescript
describe('MCP double-parsing fix', () => {
  it('should preserve multi-content MCP results through normalization', async () => {
    // Mock MCP client that returns raw content array (image + text)
    const mockClient = {
      callTool: vi.fn().mockResolvedValue([
        { type: 'text', text: 'Weather report' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ]),
    };
    const mockProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [mcpTool],
      mcpClients: mockProvider,
    });

    const result = await executor.execute('weather_mcp', {}, 5000);
    // Should return structured result with text AND non-text content noted
    expect(result).toEqual({
      text: 'Weather report',
      nonTextContent: ['image(image/png)'],
    });
  });

  it('should reject MCP responses exceeding 10MB', async () => {
    const hugeResult = [{ type: 'text', text: 'x'.repeat(11 * 1024 * 1024) }];
    const mockClient = { callTool: vi.fn().mockResolvedValue(hugeResult) };
    const mockProvider = { getClient: vi.fn().mockResolvedValue(mockClient) };

    const executor = new McpToolExecutor({ tools: [mcpTool], mcpClients: mockProvider });
    await expect(executor.execute('weather_mcp', {}, 5000)).rejects.toThrow(
      'TOOL_RESPONSE_TOO_LARGE',
    );
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @abl/compiler test -- --run -t "double-parsing"`
Expected: FAIL

**Step 3: Fix EphemeralMcpClient (BUG FIX)**

In `inline-mcp-provider.ts`, replace lines 232-251 of `EphemeralMcpClient.callTool()`:

**Before** (buggy — destroys multi-content):

```typescript
if (result.isError) {
  const errorText = result.content
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { type: string; text?: string }) => c.text)
    .join('\n');
  throw new Error(errorText || 'MCP tool execution failed');
}

// Extract text content from MCP result
const textContent = result.content.find((c: { type: string }) => c.type === 'text');
if (textContent && 'text' in textContent) {
  try {
    return JSON.parse(textContent.text as string);
  } catch {
    return textContent.text;
  }
}
return result;
```

**After** (fixed — return raw content for normalizeMcpResult):

```typescript
if (result.isError) {
  const errorText = result.content
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { type: string; text?: string }) => c.text)
    .join('\n');
  throw new Error(errorText || 'MCP tool execution failed');
}

// Return raw content blocks — normalizeMcpResult() handles all normalization
return result.content;
```

**Step 4: Add response size limit to McpToolExecutor**

In `mcp-tool-executor.ts`, add constant and check after `client.callTool()`:

```typescript
/** Maximum MCP response size (10MB, matching HTTP executor) */
const MAX_MCP_RESPONSE_BYTES = 10 * 1024 * 1024;
```

After `const rawResult = await Promise.race([...])` and before `normalizeMcpResult`:

```typescript
// Bound response size (MCP has no Content-Length, so check serialized size)
const serialized = JSON.stringify(rawResult);
if (serialized.length > MAX_MCP_RESPONSE_BYTES) {
  throw new ToolExecutionError({
    code: 'TOOL_RESPONSE_TOO_LARGE',
    message: `MCP tool ${toolName} response exceeds ${MAX_MCP_RESPONSE_BYTES} byte limit`,
    toolName,
    toolType: 'mcp',
  });
}
```

**Step 5: Add `executeRequest` to McpToolExecutor (singleton pattern)**

Same approach as Task 2:

- Add `executeRequest(request: ToolExecutionRequest)` that passes `tenantId`, `projectId` per-call
- Extract core logic to `_executeMcp(tool, params, timeoutMs, mcpClients, tenantId, projectId)`
- `breakers` map stays on `this` (shared)
- `mcpClients` can be passed per-call OR set at construction
- Mark old `execute()` as `@deprecated`

> **[GAP FIX C5]**: MCP singleton uses a placeholder `mcpClients` — real per-session provider must come via `context.mcpClients`. Without this, ALL MCP tool calls fail silently.

```typescript
async executeRequest(request: ToolExecutionRequest): Promise<unknown> {
  const { tool, params, timeoutMs, context } = request;
  if (!tool.mcp_binding) {
    throw new ToolExecutionError({ code: 'TOOL_NOT_FOUND', message: `MCP tool has no mcp_binding: ${tool.name}`, toolName: tool.name, toolType: 'mcp' });
  }
  // Use per-session mcpClients from context (NOT the singleton's placeholder)
  const mcpClients = context.mcpClients ?? this.mcpClients;
  return this._executeMcp(tool, params, timeoutMs, mcpClients, context.tenantId, context.projectId);
}
```

**Step 6: Run tests — expect PASS**

Run: `pnpm --filter @abl/compiler test -- --run`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add apps/runtime/src/services/mcp/inline-mcp-provider.ts \
       packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts \
       packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts
git commit -m "fix(compiler): fix MCP double-parsing bug, add 10MB response limit, singleton McpToolExecutor"
```

---

## Task 4: Refactor SandboxToolExecutor to singleton

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts`
- Modify: `packages/compiler/src/__tests__/constructs/sandbox-tool-executor.test.ts`

**What changes:** SandboxToolExecutor drops `sandboxTools` map and `sessionContext` from instance state. Tool definition passed per-call. Session context for audit logging comes from `request.context.sessionContext`. `runner` stays on `this` (one per pod).

**Step 1: Write failing test for `executeRequest`**

```typescript
describe('SandboxToolExecutor singleton (executeRequest)', () => {
  it('should execute with per-call tool and session context', async () => {
    const executor = new SandboxToolExecutor({
      tools: [], // Empty — singleton mode
      runner: mockRunner,
    });

    const result = await executor.executeRequest({
      tool: sandboxTool,
      params: { input: 'test' },
      timeoutMs: 5000,
      context: {
        tenantId: 'tenant-1',
        secrets: mockSecrets,
        sessionContext: { sessionId: 'sess-1', tenantId: 'tenant-1', userId: 'user-1' },
      },
    });

    expect(result).toBeDefined();
    // Verify audit log includes session context from request
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @abl/compiler test -- --run -t "singleton"`

**Step 3: Implement**

1. Add `executeRequest(request: ToolExecutionRequest)` method
2. Extract core logic to `_executeSandbox(tool, params, timeoutMs, sessionContext)`
3. Audit logging uses `sessionContext` from the request, not from `this`
4. Mark old `execute()` as `@deprecated`

**Step 4: Run tests — expect PASS**

Run: `pnpm --filter @abl/compiler test -- --run`

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts \
       packages/compiler/src/__tests__/constructs/sandbox-tool-executor.test.ts
git commit -m "feat(compiler): singleton SandboxToolExecutor with executeRequest"
```

---

## Task 5: Clean up ToolBindingExecutor — singleton injection, remove dead code

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
- Modify: `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts`

**This is the core "clean session" task.** ToolBindingExecutor becomes a thin facade:

- Accepts pre-built singleton executor references (no more `new HttpToolExecutor(...)`)
- Stores tools map + closed-over session context
- Pre-composes middleware chain once
- Routes via `executeRequest()` on singletons
- All dead code removed

**Step 1: Write failing tests for singleton injection mode**

```typescript
describe('ToolBindingExecutor singleton injection', () => {
  it('should route HTTP tools to injected singleton executor', async () => {
    const httpExecutor = { executeRequest: vi.fn().mockResolvedValue({ data: 'ok' }) };
    const executor = new ToolBindingExecutor({
      tools: [httpTool],
      secrets: mockSecrets,
      sessionContext: { sessionId: 'sess-1', tenantId: 'tenant-1' },
      // NEW: inject singleton refs
      httpExecutor: httpExecutor as any,
    });
    await executor.execute('weather_api', { city: 'NYC' }, 5000);
    expect(httpExecutor.executeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: httpTool,
        params: { city: 'NYC' },
        context: expect.objectContaining({ tenantId: 'tenant-1' }),
      }),
    );
  });

  it('should resolve effective timeout from tool.hints.timeout', async () => {
    const httpExecutor = { executeRequest: vi.fn().mockResolvedValue('ok') };
    const toolWith5sTimeout = { ...httpTool, hints: { timeout: 5000 } };
    const executor = new ToolBindingExecutor({
      tools: [toolWith5sTimeout],
      secrets: mockSecrets,
      httpExecutor: httpExecutor as any,
    });
    await executor.execute(toolWith5sTimeout.name, {}, 30000);
    expect(httpExecutor.executeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }), // min(30000, 5000)
    );
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

1. **Extend `ToolBindingExecutorConfig`** with optional singleton refs:

```typescript
export interface ToolBindingExecutorConfig {
  // ... existing fields ...
  /** Pre-built singleton HTTP executor (skips per-session allocation) */
  httpExecutor?: HttpToolExecutor;
  /** Pre-built singleton MCP executor (skips per-session allocation) */
  mcpExecutor?: McpToolExecutor;
  /** Pre-built singleton Sandbox executor (skips per-session allocation) */
  sandboxExecutor?: SandboxToolExecutor;
}
```

2. **Constructor prefers injected singletons**:

```typescript
constructor(config: ToolBindingExecutorConfig) {
  // ... existing tools map + middleware setup ...

  // Singleton mode: use injected executors (no allocation)
  if (config.httpExecutor) {
    this.httpExecutor = config.httpExecutor;
  } else {
    // Legacy mode: create per-session (backward compat)
    const httpTools = config.tools.filter(t => t.tool_type === 'http');
    if (httpTools.length > 0) {
      this.httpExecutor = new HttpToolExecutor({ tools: httpTools, secrets: config.secrets, ... });
    }
  }
  // Same for mcpExecutor, sandboxExecutor
}
```

3. **Add `buildExecutionContext()` helper** that creates `ToolExecutionContext` from closed-over session state:

```typescript
private buildExecutionContext(): ToolExecutionContext {
  return {
    tenantId: this.sessionContext?.tenantId ?? '',
    sessionContext: this.sessionContext ?? {},
    secrets: this.secrets,
    proxyResolver: this.proxyResolver,
    projectId: this.projectId,
    mcpClients: this.mcpClientProvider,  // GAP FIX C5: per-session MCP clients for singleton executor
  };
}
```

4. **Dispatch uses `executeRequest`** when singleton executors are injected:

```typescript
private async dispatch(toolName, tool, params, timeoutMs) {
  const effectiveTimeout = Math.min(timeoutMs, tool.hints?.timeout ?? timeoutMs);

  switch (tool.tool_type) {
    case 'http':
      if (!this.httpExecutor) throw new Error(`No HTTP executor for: ${toolName}`);
      // Singleton mode: use executeRequest with per-call context
      if ('executeRequest' in this.httpExecutor) {
        return this.httpExecutor.executeRequest({
          tool, params, timeoutMs: effectiveTimeout,
          context: this.buildExecutionContext(),
        });
      }
      // Legacy fallback
      return this.httpExecutor.execute(toolName, params, effectiveTimeout);
    // ... same for mcp, sandbox ...
  }
}
```

5. **Remove inline tracing dead path** (lines 252-275):
   Delete the entire `if (!hasMiddleware && this.trace)` block in the success path. Middleware always handles tracing.

6. **Guard audit `log.info('tool.execution')` behind `!hasMiddleware`** (lines 279-291 success, lines 317-328 failure):

   > **[GAP FIX S7]**: Do NOT delete these blocks entirely — they are the only audit trail when no AuditStore is configured (compliance requirement). Change to `if (!this.composedMiddlewareFn)` guard:

   ```typescript
   if (!this.composedMiddlewareFn) {
     log.info('tool.execution', { event: 'tool_call', ... });
   }
   ```

7. **Remove inline tracing dead path in error handler** (lines 331-351):
   Delete the `if (!hasMiddleware && this.trace)` block in the catch path.

8. **Remove duplicate error sanitization** (lines 296-313):
   The error message stripping logic (removing stack traces, file paths, HTTP status codes) duplicates `trace-scrubber.ts:36-93`. Extract to a shared `sanitizeToolError()` utility in `scrub-patterns.ts` and import from both locations. See Task 9 for the consolidation.

9. **Pass `executionContext` in `ToolCallContext`** so middleware can access it:

```typescript
const ctx: ToolCallContext = {
  toolName, params, timeoutMs: effectiveTimeout,
  tool,
  metadata: { ... },
  executionContext: this.buildExecutionContext(),
};
```

10. **Store `secrets`, `projectId`, and `proxyResolver`** as instance fields (needed for `buildExecutionContext()`):

```typescript
private secrets: SecretsProvider;
private projectId?: string;
private proxyResolver?: ProxyResolver;
```

11. **Fix `setProxyResolver()` for singleton mode**: The current implementation (lines 104-112) patches `this.httpExecutor.proxyResolver` directly — this is UNSAFE in singleton mode because it mutates the shared singleton. In singleton mode, `setProxyResolver` must store the resolver on the facade (`this.proxyResolver`) and let `buildExecutionContext()` pass it per-call. The httpExecutor singleton's own `proxyResolver` field must NOT be mutated:

```typescript
setProxyResolver(resolver: import('./proxy-resolver.js').ProxyResolver): void {
  // Store per-session — passed per-call via buildExecutionContext()
  this.proxyResolver = resolver;
  // Legacy mode: patch per-session executor directly
  if (this.httpExecutor && !this._singletonMode) {
    this.httpExecutor.proxyResolver = resolver;
  }
  // Also patch MCP client provider if it supports proxy (per-session, safe)
  if (this.mcpClientProvider && 'proxyResolver' in this.mcpClientProvider) {
    (this.mcpClientProvider as { proxyResolver: unknown }).proxyResolver = resolver;
  }
}
```

> **IMPORTANT**: The existing `setProxyResolver` also patches `mcpClientProvider.proxyResolver` (line 109-111). This is per-session safe because `mcpClientProvider` is already per-session (`InlineMcpClientProvider`). Preserve this behavior.

**Step 4: Run tests — expect PASS**

Run: `pnpm --filter @abl/compiler test -- --run`

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts \
       packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts
git commit -m "feat(compiler): singleton injection in ToolBindingExecutor, remove dead tracing/audit code"
```

---

## Task 6: Delete dead code — compiler package

**Files:**

- Delete: `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts`
- Delete: `packages/compiler/src/__tests__/constructs/lambda-tool-executor.test.ts`
- Delete: `packages/compiler/src/platform/constructs/executors/result-validation-middleware.ts`
- Delete: `packages/compiler/src/__tests__/constructs/result-validation.test.ts` **(GAP FIX C1: test file imports deleted middleware)**
- Modify: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` (remove `createToolBindingExecutor`)
- Modify: `packages/compiler/src/platform/constructs/executors/secrets-provider.ts` (remove `getSamlAssertion`)
- Modify: `packages/compiler/src/platform/constructs/index.ts` (remove lambda + factory + result-validation exports)
- Modify: `packages/compiler/src/index.ts` (remove lambda + factory exports if present)
- Modify: `packages/compiler/src/platform/mcp/client.ts` (remove dead methods)

**Step 1: Delete LambdaToolExecutor stub + test**

It's a deprecated stub that throws `NOT_IMPLEMENTED`. No callers.

**Step 2: Delete `createToolBindingExecutor()` factory function**

At `tool-binding-executor.ts:462-479`. Unused — callers construct directly. Remove it entirely.

**Step 3: Delete `resultValidationMiddleware` + its test**

File: `packages/compiler/src/platform/constructs/executors/result-validation-middleware.ts` (lines 28-55). Exported but never instantiated anywhere in the codebase. ~100 lines dead code.

> **[GAP FIX C1]**: Also delete `packages/compiler/src/__tests__/constructs/result-validation.test.ts` — this test file imports the deleted middleware and will cause `pnpm test` to fail with an unresolvable import.

**Step 4: Remove `getSamlAssertion()` from `SecretsProvider` interface**

In `secrets-provider.ts` line 23. SAML auth is rejected at compile time (`convert-db-tool-to-ir.ts` skips SAML tools). No implementation exists. Remove from the interface.

**Step 5: Remove dead MCPClient methods**

In `packages/compiler/src/platform/mcp/client.ts`, delete these methods never called during tool execution:

- `subscribeResource()` (lines 432-439) — never called
- `unsubscribeResource()` (lines 441-444) — never called
- `listPrompts()` (lines 462-464) — never called
- `fetchPrompt()` (lines 466-493) — never called
- `createSamplingMessage()` (lines 511-515) — never called

**Step 6: Remove exports from index files**

Remove from `packages/compiler/src/platform/constructs/index.ts`:

- `createToolBindingExecutor` (line 130 — exported alongside `ToolBindingExecutor`)
- `resultValidationMiddleware` AND `validateResult` (lines 204-207 — both exported from `result-validation-middleware.js`)
- `ValidationMode` and `ValidationError` type exports (line 208)

> **NOTE**: `LambdaToolExecutor` is NOT exported from `index.ts` — no action needed for it there. Only the file itself and its test file need deletion.

Check `packages/compiler/src/index.ts` for any of these exports and remove if present.

**Step 7: Build and test**

Run: `pnpm --filter @abl/compiler build && pnpm --filter @abl/compiler test -- --run`
Expected: SUCCESS — nothing depends on these.

**Step 8: Commit**

```bash
git add -A packages/compiler/
git commit -m "refactor(compiler): delete LambdaToolExecutor, resultValidationMiddleware, getSamlAssertion, unused MCPClient methods, createToolBindingExecutor factory"
```

---

## Task 7: Delete dead code — runtime package + clean unused IR schema fields

**Files:**

- Modify: `apps/runtime/src/services/adapters/tool-executor-adapter.ts` (delete MockToolExecutor)
- Modify: `packages/compiler/src/platform/ir/schema.ts` (clean unused fields)
- Modify: `apps/runtime/src/services/execution/llm-wiring.ts` (clean unused imports)

**Step 1: Delete MockToolExecutor (domain-mock class)**

> **[GAP FIX C2]**: There are TWO classes named `MockToolExecutor`. Only delete the one in `tool-executor-adapter.ts` (domain-specific mock with hardcoded hotel/weather responses). Do **NOT** touch `apps/runtime/src/services/execution/mock-tool-executor.ts` — that's a decorator used for testing.

In `tool-executor-adapter.ts` lines 984-1070: The domain-mock `MockToolExecutor` contains 1000+ lines of hardcoded mock domain responses. Dead code in production — violates domain agnosticism rules.

Delete the class AND update all call sites:

- `apps/runtime/src/services/adapters/tool-executor-adapter.ts` — delete `MockToolExecutor` class + `getDefaultMockResponses` function
- `apps/runtime/src/services/adapters/index.ts` (line 24) — remove `MockToolExecutor` and `getDefaultMockResponses` re-exports
- `apps/runtime/src/services/runtime-executor.ts` (line 46) — remove import, replace usage with `undefined`
- `apps/runtime/src/__tests__/airlines-search-e2e.test.ts` (line 38) — remove import, update test to not use domain mocks
- `apps/runtime/src/__tests__/agent-search-e2e.test.ts` (line 36) — remove import, update test to not use domain mocks
- `apps/runtime/src/__tests__/tool-executor-adapter.test.ts` — delete entire test file (tests the deleted class)

The `fallbackExecutor` field in `_wireExecutor` uses this only in dev mode — remove the fallback entirely (Task 11 does not include it).

**Step 2: Clean unused IR schema fields**

In `packages/compiler/src/platform/ir/schema.ts`:

- **Line 309**: Remove `system?: boolean` from `ToolDefinition`. No code reads this field; tools are identified by `tool_type`, not a boolean flag.
- **Lines 341-343**: Remove `fields?: Record<string, ToolReturnType>`, `items?: ToolReturnType`, `optional?: boolean` from `ToolReturnType`. These are never populated by the compiler or read by the runtime. `ToolReturnType` is only used for `type` and `description`.

**Step 3: Clean unused imports in llm-wiring.ts**

In `llm-wiring.ts`:

- **Line 38**: `MockToolExecutor` import — remove (after Step 1 deletes the class)
- **Line 41**: `MultimodalServiceClient` import — remove (unused, no attachment integration wired yet)

> **[GAP FIX M11]**: Keep `SearchAIAwareToolExecutor`, `isSearchAITool`, `isAttachmentTool`, and `AttachmentToolExecutor` imports — `SearchAIAwareToolExecutor` and `isSearchAITool` are actively used in `_wireExecutor`; `isAttachmentTool` and `AttachmentToolExecutor` are placeholders for pending attachment tool integration. Remove only `MultimodalServiceClient` (unused standalone import, not part of the attachment executor pattern).

**Step 4: Build and test**

Run: `pnpm build --filter='!@agent-platform/observatory-cli' && pnpm test --filter='!@agent-platform/observatory-cli'`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/adapters/tool-executor-adapter.ts \
       apps/runtime/src/services/adapters/index.ts \
       apps/runtime/src/services/runtime-executor.ts \
       apps/runtime/src/__tests__/airlines-search-e2e.test.ts \
       apps/runtime/src/__tests__/agent-search-e2e.test.ts \
       apps/runtime/src/__tests__/tool-executor-adapter.test.ts \
       packages/compiler/src/platform/ir/schema.ts \
       apps/runtime/src/services/execution/llm-wiring.ts
git commit -m "refactor: delete MockToolExecutor, clean unused IR schema fields, remove dead imports"
```

---

## Task 8: Fix buildAuthConfig customHeaders leak + skip MCP ephemeral discovery

**Files:**

- Modify: `packages/shared/src/tools/convert-db-tool-to-ir.ts`
- Modify: `packages/compiler/src/platform/mcp/client.ts`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts`

**Step 1: Fix buildAuthConfig() customHeaders leak**

In `convert-db-tool-to-ir.ts` lines 265-297, `buildAuthConfig()` passes the entire `cfg` (auth config dict) as `customHeaders` for `api_key` and `bearer` auth types (lines 284, 290, 295). This leaks all auth config fields (client secrets, token URLs, etc.) into HTTP request headers — header pollution and potential credential exposure.

**Fix**: Only extract legitimate header fields:

```typescript
// Before (buggy — leaks entire auth config as headers):
case 'api_key':
  return { type: 'api_key', apiKey: cfg.api_key || cfg.apiKey || '', headerName: cfg.header_name || 'X-API-Key', customHeaders: cfg };

// After (fixed — no custom headers for api_key, only what's needed):
case 'api_key':
  return { type: 'api_key', apiKey: cfg.api_key || cfg.apiKey || '', headerName: cfg.header_name || 'X-API-Key' };

// Same for bearer:
case 'bearer':
  return { type: 'bearer', token: cfg.token || cfg.access_token || '' };

// GAP FIX M12: default case also leaks entire cfg as customHeaders
default:
  return {};  // Was: Object.keys(cfg).length > 0 ? { customHeaders: cfg } : {}
```

Add a test to verify no leakage:

```typescript
it('should not leak auth config into customHeaders', () => {
  const cfg = {
    type: 'api_key',
    api_key: 'secret',
    header_name: 'X-Key',
    client_secret: 'very-secret',
  };
  const result = buildAuthConfig(cfg);
  expect(result.customHeaders).toBeUndefined();
  // Or if customHeaders exists, it should NOT contain client_secret
});
```

**Step 2: Skip MCPClient discovery on ephemeral connect**

In `packages/compiler/src/platform/mcp/client.ts` lines 236-238, `connect()` calls `refreshTools()`, `refreshResources()`, `refreshPrompts()` — three RPC round-trips that are immediately discarded in ephemeral mode (connect → callTool → disconnect).

Add a `skipDiscovery` option to `connect()`:

```typescript
async connect(options?: { skipDiscovery?: boolean }): Promise<void> {
  // ... existing transport setup ...

  if (!options?.skipDiscovery) {
    await this.refreshTools();
    await this.refreshResources();
    await this.refreshPrompts();
  }
}
```

Update `EphemeralMcpClient.callTool()` in `inline-mcp-provider.ts` to use it:

```typescript
await client.connect({ skipDiscovery: true });
```

**Step 3: Remove unbounded `last_*_result` session state**

> **[GAP FIX S10]**: Before removing, search for downstream readers:
>
> ```bash
> grep -r 'last_.*_result\|last_\$' packages/ apps/ --include='*.ts' -l
> ```
>
> Also check `evaluateRememberAfterStateChange` and `executeRecallAfterToolCall` (lines 629-630 in reasoning-executor.ts) — they run immediately after the assignment and may read these values.
> If readers exist, either wire the data through a different mechanism or keep the assignment with a TTL/max-size guard. Only remove if truly unused.

In `reasoning-executor.ts` line 626:

```typescript
session.data.values[`last_${toolCall.name}_result`] = toolResult;
```

This writes every tool result into session state with no TTL, no size limit. Verify no downstream code reads `last_*_result` (grep first). If confirmed unused, remove the line.

**Step 4: Build and test**

Run: `pnpm build --filter='!@agent-platform/observatory-cli' && pnpm test --filter='!@agent-platform/observatory-cli'`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add packages/shared/src/tools/convert-db-tool-to-ir.ts \
       packages/compiler/src/platform/mcp/client.ts \
       apps/runtime/src/services/mcp/inline-mcp-provider.ts \
       apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "fix: buildAuthConfig customHeaders leak, skip MCP ephemeral discovery, remove unbounded last_result"
```

---

## Task 9: Consolidate duplicate utilities

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
- Create: `packages/compiler/src/platform/constructs/executors/proxy-dispatcher-factory.ts` (shared utility)
- Modify: `apps/runtime/src/services/mcp/inline-mcp-provider.ts`
- Modify: `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
- Modify: `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`

### 9a: Consolidate secret patterns

**Problem:** `trace-scrubber.ts` (lines 11-14) defines its own `SECRET_PATTERNS` regex list. `scrub-patterns.ts` (lines 22-33) defines `DEFAULT_SECRET_PATTERNS`. They overlap but aren't identical.

> **[GAP FIX S9]**: The trace-scrubber patterns are **narrow anchored patterns** (match `^Bearer ...` and `^{{secrets.xxx}}$`). `DEFAULT_SECRET_PATTERNS` are **broad unanchored patterns** (match substrings like `api_key` anywhere). Replacing anchored with unanchored would over-redact legitimate data in tool results. Do NOT simply import `DEFAULT_SECRET_PATTERNS`.

**Fix:** Export the trace-scrubber's narrow patterns as `TRACE_SECRET_PATTERNS` from `scrub-patterns.ts` alongside the existing `DEFAULT_SECRET_PATTERNS`. `trace-scrubber.ts` imports `TRACE_SECRET_PATTERNS`:

```typescript
// scrub-patterns.ts — ADD:
/** Anchored patterns for trace output scrubbing (narrow — won't over-redact tool results) */
export const TRACE_SECRET_PATTERNS = [/^Bearer\s+.+$/i, /^\{\{secrets\.\w+\}\}$/];

// trace-scrubber.ts — CHANGE:
import { TRACE_SECRET_PATTERNS } from './scrub-patterns.js';
// Use TRACE_SECRET_PATTERNS instead of local SECRET_PATTERNS
```

### 9b: Consolidate error sanitization

**Problem:** `tool-binding-executor.ts` (lines 296-313) strips stack traces and file paths from error messages. `trace-scrubber.ts` (lines 36-93) has `sanitizeForTrace()` that does the same thing.

**Fix:** Extract a shared `sanitizeToolError(message: string): string` function into `scrub-patterns.ts`:

```typescript
// scrub-patterns.ts
export function sanitizeToolError(message: string): string {
  let sanitized = message;
  // Strip file paths
  sanitized = sanitized.replace(/\b(?:\/[\w.-]+)+\b/g, '[path]');
  // Strip stack traces
  sanitized = sanitized.replace(/\s+at\s+.+$/gm, '');
  // Strip HTTP status code details
  sanitized = sanitized.replace(/\b\d{3}\s+[\w\s]+\b/g, '[status]');
  return sanitized.trim();
}
```

Both `tool-binding-executor.ts` and `trace-scrubber.ts` import and use this.

### 9c: Extract shared proxy dispatcher creation

**Problem:** `inline-mcp-provider.ts` (lines 157-189) and `runtime-mcp-provider.ts` (lines 101, 254) both create undici `ProxyAgent` dispatchers with identical logic (dynamic import, TLS config, error handling).

**Fix:** Create `packages/compiler/src/platform/constructs/executors/proxy-dispatcher-factory.ts`:

```typescript
export async function createProxyDispatcher(proxyConfig: {
  proxyUrl: string;
  caCertificate?: string;
  clientCert?: string;
  clientKey?: string;
}): Promise<unknown> {
  try {
    const mod = 'undici';
    const undici = await import(/* @vite-ignore */ mod);
    const ProxyAgentCtor = (undici as Record<string, unknown>).ProxyAgent as
      | (new (opts: Record<string, unknown>) => unknown)
      | undefined;
    if (!ProxyAgentCtor) return undefined;

    const proxyOpts: Record<string, unknown> = { uri: proxyConfig.proxyUrl };
    if (proxyConfig.caCertificate || proxyConfig.clientCert) {
      const requestTls: Record<string, unknown> = {};
      if (proxyConfig.caCertificate) requestTls.ca = proxyConfig.caCertificate;
      if (proxyConfig.clientCert) requestTls.cert = proxyConfig.clientCert;
      if (proxyConfig.clientKey) requestTls.key = proxyConfig.clientKey;
      proxyOpts.requestTls = requestTls;
    }

    return new ProxyAgentCtor(proxyOpts);
  } catch {
    return undefined;
  }
}
```

Both `inline-mcp-provider.ts` and `runtime-mcp-provider.ts` import and delegate to this. Delete their inline implementations.

> **[GAP FIX S6]**: Add export to `packages/compiler/src/platform/constructs/index.ts`:
>
> ```typescript
> export { createProxyDispatcher } from './executors/proxy-dispatcher-factory.js';
> ```
>
> Also add a `log` parameter or use `createLogger('proxy-dispatcher')` inside the catch block to preserve observability (current code logs warnings on proxy dispatcher failure).

### 9d: Extract shared resilience cache key utility

**Problem:** `http-tool-executor.ts` (line 856) has `cacheKey()` that builds `{tenantId}:{toolName}` keys for circuit breakers/rate limiters. `mcp-tool-executor.ts` (line 252) has `breakerKey()` doing the same thing.

**Fix:** Add to a shared location (e.g., `scrub-patterns.ts` or a new `resilience-utils.ts`):

```typescript
/** Build a tenant+tool scoped cache key for resilience state */
export function resilienceCacheKey(tenantId: string | undefined, toolName: string): string {
  return tenantId ? `${tenantId}:${toolName}` : toolName;
}
```

Both executors import and use this instead of their local implementations.

**Step 5: Build and test**

Run: `pnpm build --filter='!@agent-platform/observatory-cli' && pnpm test --filter='!@agent-platform/observatory-cli'`
Expected: SUCCESS

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/constructs/executors/scrub-patterns.ts \
       packages/compiler/src/platform/constructs/executors/trace-scrubber.ts \
       packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts \
       packages/compiler/src/platform/constructs/executors/proxy-dispatcher-factory.ts \
       packages/compiler/src/platform/constructs/executors/http-tool-executor.ts \
       packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts \
       apps/runtime/src/services/mcp/inline-mcp-provider.ts \
       apps/runtime/src/services/mcp/runtime-mcp-provider.ts
git commit -m "refactor: consolidate duplicate secret patterns, error sanitization, proxy dispatchers, resilience keys"
```

---

## Task 10: E2E tests for singleton pipeline

**Files:**

- Modify: `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`

**Step 1: Add e2e tests with singleton executors**

New describe block that validates the full singleton pipeline:

```typescript
describe('Singleton tool executor pipeline (e2e)', () => {
  it('HTTP singleton → middleware → trace → result', async () => {
    // Create singleton HttpToolExecutor (empty tools)
    // Create ToolBindingExecutor with injected singleton
    // Execute → verify middleware chain runs → verify result
  });

  it('MCP singleton → normalizeMcpResult preserves multi-content', async () => {
    // Mock MCP client returns [text, image] content blocks
    // Verify normalizeMcpResult sees full array (not pre-parsed)
  });

  it('Sandbox singleton → per-call session context in audit', async () => {
    // Create singleton SandboxToolExecutor
    // Execute with session context in request
    // Verify audit log shows correct session context
  });

  it('cross-session circuit breaker sharing', async () => {
    // Create one HttpToolExecutor singleton
    // Create two ToolBindingExecutor facades (different sessions)
    // Trip breaker via session A → verify session B sees open breaker
  });

  it('IR timeout override: tool.hints.timeout takes precedence', async () => {
    // Tool with hints.timeout = 5000
    // Caller passes 30000
    // Verify executor receives min(30000, 5000) = 5000
  });
});
```

**Step 2: Run all compiler tests**

Run: `pnpm --filter @abl/compiler build && pnpm --filter @abl/compiler test -- --run`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts
git commit -m "test(compiler): e2e tests for singleton tool executor pipeline"
```

---

## Task 11: Wire singletons in LLMWiringService (clean session)

**Files:**

- Modify: `apps/runtime/src/services/execution/llm-wiring.ts`

This is the main "clean session" task at the runtime level. All executors and runners are initialized once; `_wireExecutor` becomes trivial.

**Step 1: Add singleton fields to LLMWiringService**

```typescript
export class LLMWiringService {
  // === Existing singletons (keep as-is) ===
  private _modelResolution: ModelResolutionService | null = null;
  private _proxyConfigService: ProxyConfigService | null = null;
  private _toolSecretStore?: ToolSecretStore | null;
  private _secretDecryptor?: SecretDecryptor | null;
  private _oauthTokenResolver?: OAuthTokenResolver | null;
  private _envVarStore?: EnvVarStore | null;

  // === NEW: Tool executor singletons (init once at first use) ===
  private _httpExecutor: HttpToolExecutor | null = null;
  private _mcpExecutor: McpToolExecutor | null = null;
  private _sandboxExecutor: SandboxToolExecutor | null = null;
  private _sandboxRunner: GvisorSandboxRunner | null = null;
  private _resilienceFactory: ResilienceFactory | null = null;
```

**Step 2: Add lazy-init getters**

```typescript
/**
 * Singleton HttpToolExecutor — shared across all sessions on this pod.
 * Circuit breakers, rate limiters, OAuth token cache are shared.
 */
private getHttpExecutor(): HttpToolExecutor {
  if (!this._httpExecutor) {
    this._httpExecutor = new HttpToolExecutor({
      tools: [],  // No tools baked in — passed per-call
      secrets: { getSecret: async () => undefined, getEnvVar: async () => undefined } as any,
      // ^ Placeholder — real secrets come per-call via ToolExecutionRequest
      resilienceFactory: this.getResilienceFactory(),
      allowLocalhost: !!getDevSSRFOptions().allowLocalhost,
    });
  }
  return this._httpExecutor;
}

/**
 * Singleton McpToolExecutor — shared across all sessions.
 */
private getMcpExecutor(): McpToolExecutor {
  if (!this._mcpExecutor) {
    this._mcpExecutor = new McpToolExecutor({
      tools: [],
      mcpClients: { getClient: async () => undefined } as any,
      // ^ Placeholder — real mcpClients come per session via ToolBindingExecutor
      resilienceFactory: this.getResilienceFactory(),
    });
  }
  return this._mcpExecutor;
}

/**
 * Singleton SandboxToolExecutor — one runner per pod.
 * Returns undefined when no sandbox runner is available (no pod URLs configured).
 */
private getSandboxExecutor(): SandboxToolExecutor | undefined {
  if (this._sandboxExecutor) return this._sandboxExecutor;
  const runner = this.getSandboxRunner();
  if (!runner) return undefined;  // GAP FIX C4: don't crash without sandbox pods
  this._sandboxExecutor = new SandboxToolExecutor({
    tools: [],
    runner,
  });
  return this._sandboxExecutor;
}

/**
 * Singleton GvisorSandboxRunner — NAT-only, no JWT auth needed.
 * Created once from env vars. No session context.
 * Returns undefined when sandbox pod URLs are not configured.
 */
private getSandboxRunner(): SandboxRunner | undefined {
  // GAP FIX C4: return undefined (not null!) when no pod URLs configured
  if (this._sandboxRunner !== undefined) return this._sandboxRunner ?? undefined;
  const pythonPodUrl = process.env.SANDBOX_PYTHON_POD_URL || '';
  const javascriptPodUrl = process.env.SANDBOX_JAVASCRIPT_POD_URL || '';
  if (pythonPodUrl || javascriptPodUrl) {
    this._sandboxRunner = new GvisorSandboxRunner({
      pythonPodUrl,
      javascriptPodUrl,
      podPath: process.env.SANDBOX_POD_PATH || '/execute-script',
      codeBasePath: process.env.SANDBOX_CODE_BASE_PATH || './sandbox-tools',
    });
    return this._sandboxRunner;
  }
  return undefined;  // No sandbox runner available — don't crash
}

/**
 * Singleton ResilienceFactory — no per-session allocation.
 * The factory is stateless; breakers and limiters it creates use the
 * global HybridCircuitBreakerRegistry.
 */
private getResilienceFactory(): ResilienceFactory {
  if (!this._resilienceFactory) {
    this._resilienceFactory = createToolResilienceFactory();
    // Note: no tenantId — tenant scoping happens in the breaker/limiter keys
  }
  return this._resilienceFactory;
}
```

**Step 3: Simplify `_wireExecutor` — clean session wiring**

Replace the current `_wireExecutor` (lines 302-489) with a clean version:

```typescript
private _wireExecutor(
  session: RuntimeSession,
  allTools: ToolDefinition[],
  authToken?: string,
  tenantId?: string,
  trace?: TraceContextManager,
  projectId?: string,
): void {
  const resolvedEnvironment =
    session.versionInfo?.environment ?? (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');

  // Per-session secrets provider (tenant + auth scoped)
  const secrets = new RuntimeSecretsProvider({
    tenantId,
    authToken,
    userId: session.userId,
    agentIR: session.agentIR,
    projectId: projectId || session.projectId,
    environment: resolvedEnvironment,
    secretStore: this.getOrCreateToolSecretStore(),
    decryptor: this.getOrCreateSecretDecryptor(),
    oauthResolver: this.getOrCreateOAuthTokenResolver(),
    envVarStore: this.getOrCreateEnvVarStore(),
  });

  // Per-session middleware chain (trace is session-scoped)
  const middleware: ToolMiddleware[] = [];
  middleware.push(loggingMiddleware(trace));

  try {
    const auditStore = getAuditStore();
    if (auditStore) {
      middleware.push(createAuditMiddleware(new ToolAuditLoggerImpl(auditStore)));
    } else if (isDatabaseAvailable()) {
      middleware.push(createAuditMiddleware(new MongoToolAuditLogger()));
    }
  } catch (err) {
    log.warn('Audit logger init failed', { error: err instanceof Error ? err.message : String(err) });
  }

  middleware.push(createSecretScrubberMiddleware());
  middleware.push(createSecretValidationMiddleware());

  // MCP client provider — per-session (tenantId for decryption)
  let mcpClients: McpClientProvider | undefined;
  const mcpTools = allTools.filter(t => t.tool_type === 'mcp' && t.mcp_binding?.server_config);
  if (mcpTools.length > 0 && tenantId) {
    mcpClients = new InlineMcpClientProvider(mcpTools, this.getOrCreateSecretDecryptor(), tenantId);
  }
  if (!mcpClients) {
    const runtimeMcp = getRuntimeMcpProvider();
    if (runtimeMcp.hasRegistry()) mcpClients = runtimeMcp;
  }

  // === CLEAN SESSION: just pass singleton refs + context ===
  const resolvedProjectId = projectId || session.projectId;

  session.toolExecutor = new ToolBindingExecutor({
    tools: allTools,
    secrets,
    mcpClients,
    projectId: resolvedProjectId,
    sessionContext: {
      sessionId: session.id,
      tenantId: tenantId || session.tenantId,
      userId: session.userId,
      source: (session.versionInfo?.environment || 'production') as 'test' | 'production' | 'staging',
      ...(session.callerContext && { callerContext: session.callerContext }),
    },
    defaultTimeoutMs: 30000,
    allowLocalhost: !!getDevSSRFOptions().allowLocalhost,
    middleware,
    resilienceFactory: this.getResilienceFactory(),
    // === SINGLETON INJECTION — no per-session executor allocation ===
    httpExecutor: this.getHttpExecutor(),
    mcpExecutor: this.getMcpExecutor(),
    sandboxExecutor: allTools.some(t => t.tool_type === 'sandbox') ? this.getSandboxExecutor() : undefined,
  });

  // Proxy config resolution (async patch — same pattern as before)
  const proxyConfigService = this.getProxyConfigService();
  if (proxyConfigService && tenantId && session.toolExecutor instanceof ToolBindingExecutor) {
    const executor = session.toolExecutor;
    const proxyPromise = proxyConfigService
      .getResolver(tenantId, resolvedEnvironment)
      .then(resolver => {
        if (resolver) {
          executor.setProxyResolver(resolver);
          if (mcpClients instanceof InlineMcpClientProvider) {
            mcpClients.proxyResolver = resolver;
          }
        }
      })
      .catch(err => {
        log.error('Failed to load proxy config', { error: err instanceof Error ? err.message : String(err) });
      });
    executor.setProxyReadyPromise(proxyPromise);
  }

  // GAP FIX C3: SearchAIAwareToolExecutor wrapping.
  // NOTE: As of current codebase, `SearchAIAwareToolExecutor` and `isSearchAITool` are imported
  // at llm-wiring.ts:39 but NOT currently wired in `_wireExecutor`. This wrapping block is
  // INTENTIONALLY ADDED by this refactor to activate the import. If SearchAI integration is
  // not yet ready, keep this commented out and add a TODO. Verify with `grep -rn 'isSearchAITool'`
  // whether any test expects this wrapping before uncommenting.
  //
  // if (allTools.some(isSearchAITool)) {
  //   session.toolExecutor = new SearchAIAwareToolExecutor(session.toolExecutor, {
  //     authToken,
  //     tenantId,
  //     projectId: resolvedProjectId,
  //   });
  // }

  log.info('ToolBindingExecutor wired for session', {
    sessionId: session.id,
    totalTools: allTools.length,
    httpTools: allTools.filter(t => t.tool_type === 'http').length,
    mcpTools: mcpTools.length,
    sandboxTools: allTools.filter(t => t.tool_type === 'sandbox').length,
    middlewareCount: middleware.length,
    singletonMode: true,
  });
}
```

**What's removed from per-session wiring:**

- `new HttpToolExecutor(...)` — gone, use `this.getHttpExecutor()`
- `new McpToolExecutor(...)` — gone, use `this.getMcpExecutor()`
- `new SandboxToolExecutor(...)` — gone, use `this.getSandboxExecutor()`
- `new GvisorSandboxRunner(...)` — gone, use `this.getSandboxRunner()`
- `createToolResilienceFactory(tenantId)` — gone, use `this.getResilienceFactory()`
- Sandbox JWT signer creation — gone (NAT-only, no auth)
- Sandbox code map building — gone (code_content in tool definition, passed per-call)
- Per-session sandbox runner URL validation — gone (done once at startup)
- `MockToolExecutor` fallback — gone (deleted in Task 7)
- `fallbackExecutor: new MockToolExecutor()` — gone. The `fallbackExecutor` field remains in `ToolBindingExecutorConfig` (line 66) for backward compatibility but is no longer passed from `_wireExecutor`. It was only ever set to `MockToolExecutor` which is deleted in Task 7. If contract-only tools (no binding) need a fallback executor in the future, callers can still pass one.

**What remains per-session (correctly so):**

- `RuntimeSecretsProvider` — tenant + auth scoped
- Middleware chain — trace is per-session
- `InlineMcpClientProvider` — needs per-session decryptor + tenantId
- `ToolBindingExecutor` — lightweight facade with refs + context

**Step 4: Build and run runtime tests**

Run: `pnpm build --filter='!@agent-platform/observatory-cli' && pnpm --filter @agent-platform/runtime test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/llm-wiring.ts
git commit -m "feat(runtime): wire singleton tool executors in LLMWiringService — clean session wiring"
```

---

## Task 12: Remove hardcoded 30s timeouts from callers

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: Replace hardcoded 30000 with IR-configurable timeout**

In `reasoning-executor.ts` line 575 and 589:

```typescript
// Before:
toolResult = await session.toolExecutor.execute(toolCall.name, toolCall.input, 30000);
// After:
const toolTimeoutMs = session.agentIR?.execution?.timeouts?.tool_timeout_ms ?? 30_000;
toolResult = await session.toolExecutor.execute(toolCall.name, toolCall.input, toolTimeoutMs);
```

And in the retry path (line 589):

```typescript
() => session.toolExecutor!.execute(toolCall.name, toolCall.input, toolTimeoutMs),
```

In `flow-step-executor.ts` line 113:

```typescript
// Before:
const executeFn = () => session.toolExecutor!.execute(toolName, params, 30000);
// After:
const toolTimeoutMs = session.agentIR?.execution?.timeouts?.tool_timeout_ms ?? 30_000;
const executeFn = () => session.toolExecutor!.execute(toolName, params, toolTimeoutMs);
```

Note: `ToolBindingExecutor.dispatch()` already does `Math.min(timeoutMs, tool.hints?.timeout ?? timeoutMs)` (line 417), so the per-tool IR timeout is respected even if the caller passes a generous default.

**Step 2: Add callerContext to tool_call trace event**

In `reasoning-executor.ts` lines 639-655, add `callerContext`:

```typescript
onTraceEvent({
  type: 'tool_call',
  data: {
    toolName: toolCall.name,
    input: toolCall.input,
    output: toolResult,
    success: !(typeof toolResult === 'object' && toolResult !== null && 'error' in toolResult),
    latencyMs,
    isActionTool: toolCall.name.startsWith('__'),
    agent: session.agentName,
    callerContext: session.callerContext, // NEW — audit trail compliance
  },
});
```

**Step 3: Commit**

```bash
git add apps/runtime/src/services/execution/reasoning-executor.ts \
       apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "fix(runtime): IR-configurable tool timeout, add callerContext to tool trace events"
```

---

## Task 13: Full integration verification

**Step 1: Build everything**

Run: `pnpm build --filter='!@agent-platform/observatory-cli'`
Expected: SUCCESS

**Step 2: Run all tests**

Run: `pnpm test --filter='!@agent-platform/observatory-cli'`
Expected: ALL PASS

**Step 3: Verify no regressions**

Check:

- All existing `http-tool-executor.test.ts` tests pass (backward compat)
- All existing `mcp-tool-executor.test.ts` tests pass
- All existing `sandbox-tool-executor.test.ts` tests pass
- All existing `tool-binding-executor.test.ts` tests pass
- All existing `tool-lifecycle-e2e.test.ts` tests pass
- All runtime tests pass (`llm-wiring.test.ts`, etc.)
- `llm-wiring.test.ts` SearchAIAwareToolExecutor wrapping test passes (GAP FIX C3)

**Step 4: Verify no dangling references to deleted code**

```bash
grep -r 'resultValidationMiddleware\|LambdaToolExecutor\|createToolBindingExecutor\|validateResult' packages/ apps/ --include='*.ts' -l
grep -r 'MockToolExecutor.*tool-executor-adapter' apps/ --include='*.ts' -l
grep -r 'getSamlAssertion' packages/ apps/ --include='*.ts' -l
```

All should return empty.

**Step 5: Final commit if adjustments needed**

```bash
git commit -m "test: final adjustments for singleton tool executor refactor"
```

---

## Summary of Changes

### Principle: Clean Session Wiring

| Component             | Before (per-session)                                        | After (singleton)                                 |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `HttpToolExecutor`    | `new` per session                                           | Init once at startup, `executeRequest()` per call |
| `McpToolExecutor`     | `new` per session                                           | Init once at startup, `executeRequest()` per call |
| `SandboxToolExecutor` | `new` per session                                           | Init once at startup, `executeRequest()` per call |
| `GvisorSandboxRunner` | `new` per session + JWT signer                              | Init once at startup, no JWT (NAT-only)           |
| `ResilienceFactory`   | `createToolResilienceFactory(tenantId)` per session         | One factory, shared across all sessions           |
| Circuit breakers      | Per-session maps                                            | Shared maps on singleton (tenant-keyed)           |
| Rate limiters         | Per-session maps                                            | Shared maps on singleton (tenant-keyed)           |
| OAuth token cache     | Cold per session                                            | Warm shared cache on singleton                    |
| `ToolBindingExecutor` | Heavy (creates 3 sub-executors, filters tools, builds maps) | Lightweight facade (store refs + context)         |

### Bug Fixes

- **MCP double-parsing**: EphemeralMcpClient returns raw `result.content` — `normalizeMcpResult()` sees full structure
- **Hardcoded 30s timeout**: Callers read `agentIR.execution.timeouts.tool_timeout_ms`; dispatch reads `tool.hints.timeout`
- **Missing callerContext in traces**: Added to `tool_call` trace event
- **buildAuthConfig customHeaders leak**: Entire auth config dict was leaking into HTTP headers for api_key/bearer types — only specific fields now exposed
- **MCP ephemeral discovery waste**: 3 wasted RPCs on connect() for tools/resources/prompts that are immediately discarded — `skipDiscovery` option added
- **Unbounded `last_*_result` session state**: Tool results written to `session.data.values` with no TTL, never read by LLM — removed

### Removed (Dead Code / Redundancies)

- Inline tracing dead path in ToolBindingExecutor (lines 252-275, 331-351)
- Duplicate audit `log.info('tool.execution')` in ToolBindingExecutor (lines 279-291, 317-328)
- Second header sanitization pass in HttpToolExecutor (lines 227-231)
- `LambdaToolExecutor` stub + test file
- `createToolBindingExecutor()` unused factory function
- `resultValidationMiddleware` — exported but never instantiated (~100 lines)
- `getSamlAssertion()` from `SecretsProvider` interface — SAML rejected at compile time
- Dead MCPClient methods: `subscribeResource`, `unsubscribeResource`, `listPrompts`, `fetchPrompt`, `createSamplingMessage`
- `MockToolExecutor` with 1000+ lines of hardcoded mock domain responses
- Unused IR schema fields: `ToolDefinition.system`, `ToolReturnType.fields/.items/.optional`
- Unused imports in `llm-wiring.ts` (MockToolExecutor, MultimodalServiceClient)
- Per-session `GvisorSandboxRunner` + JWT signer creation
- Per-session sandbox code map building
- Per-session `createToolResilienceFactory(tenantId)` allocation
- Unbounded `session.data.values[last_*_result]` writes

### Consolidated (Duplicate Logic)

- Secret patterns: `trace-scrubber.ts` now imports from `scrub-patterns.ts` instead of maintaining local copy
- Error sanitization: Shared `sanitizeToolError()` utility in `scrub-patterns.ts` used by both `tool-binding-executor.ts` and `trace-scrubber.ts`
- Proxy dispatcher creation: Shared `createProxyDispatcher()` in `proxy-dispatcher-factory.ts` used by both `inline-mcp-provider.ts` and `runtime-mcp-provider.ts`
- Resilience cache keys: Shared `resilienceCacheKey()` utility used by both `http-tool-executor.ts` and `mcp-tool-executor.ts`

### Added

- `ToolExecutionRequest` and `ToolExecutionContext` types
- `executeRequest()` on all 3 type-specific executors
- Singleton lazy-init getters on `LLMWiringService`
- MCP response size limit (10MB)
- MCPClient `skipDiscovery` connect option
- Shared utility functions: `sanitizeToolError()`, `createProxyDispatcher()`, `resilienceCacheKey()`
- E2E tests for singleton pipeline
