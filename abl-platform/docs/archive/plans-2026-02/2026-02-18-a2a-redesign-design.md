# A2A Redesign: Clean Architecture with Official SDK

**Date:** 2026-02-18
**Status:** Approved

## Summary

Restructure A2A (Agent-to-Agent) protocol support as a standalone monorepo package (`packages/a2a/`) using hexagonal architecture. Adopt the official `@a2a-js/sdk` for protocol mechanics and wrap it with platform-specific adapters for tenant isolation, tracing, and SSRF validation.

## Context

### What exists

- **`A2AClient`** class in `apps/runtime/src/services/a2a/a2a-client.ts` — hand-rolled outbound client with JSON-RPC, auth header building, and utility helpers
- **`routes/a2a.ts`** — inbound JSON-RPC endpoint + `/.well-known/agent.json` discovery, with custom request handling
- **`routing-executor.ts`** — remote handoff logic that instantiates `A2AClient` directly
- **`RemoteAgentLocation`** in compiler IR schema — DSL support for `LOCATION: remote`, `ENDPOINT`, `PROTOCOL: a2a`
- **3 test suites** covering client, routes, and compilation

### Problems

1. **Monolithic client** — `A2AClient` mixes protocol (JSON-RPC), transport (HTTP fetch), auth, and message mapping in one class
2. **No domain layer** — protocol types, use cases, and infrastructure are intermingled in 2 files
3. **Routes orchestrate directly** — `handleTaskSend` does param parsing, executor calls, and response formatting inline
4. **Custom protocol code** — we maintain ~300 lines of JSON-RPC, type definitions, and serialization that the official SDK handles
5. **No bounded context** — A2A code lives mixed within runtime services and routes

### Official SDK availability

The official `@a2a-js/sdk` (A2A Protocol Specification v0.3.0) provides:

- All protocol types (`Task`, `Message`, `Part`, `AgentCard`, etc.)
- JSON-RPC, REST, and gRPC transports
- SSE streaming support
- Auth handling (`AuthenticationHandler`, `CallInterceptor`)
- Server request handling (`DefaultRequestHandler`, `JsonRpcTransportHandler`)
- Task store interface (`TaskStore`, `InMemoryTaskStore`)
- Push notification support
- Express integration via `@a2a-js/sdk/server/express`

Per the library-first principle, we adopt the SDK for protocol mechanics and wrap it with platform concerns.

## Architecture

### Hexagonal (Ports & Adapters)

```
                    ┌─────────────────────────────────────────┐
                    │           packages/a2a/                  │
                    │                                         │
                    │  ┌─────────────────────────────────┐    │
                    │  │  domain/                         │    │
                    │  │    ports.ts (interfaces)          │    │
                    │  └────────────┬──────────────────────┘    │
                    │               │                          │
                    │  ┌────────────▼──────────────────────┐    │
                    │  │  application/                      │    │
                    │  │    send-task.ts                    │    │
                    │  │    discover-agent.ts               │    │
                    │  │    receive-task.ts                 │    │
                    │  └────────────┬──────────────────────┘    │
                    │               │                          │
                    │  ┌────────────▼──────────────────────┐    │
                    │  │  infrastructure/                   │    │
                    │  │    traced-client.ts                │    │
                    │  │    agent-executor-adapter.ts       │    │
                    │  │    task-store-adapter.ts           │    │
                    │  │    ssrf-interceptor.ts             │    │
                    │  │    express-handlers.ts             │    │
                    │  └──────────────────────────────────┘    │
                    └─────────────────────────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │          @a2a-js/sdk                     │
                    │  (protocol types, transports, handlers)  │
                    └─────────────────────────────────────────┘
```

### Responsibility split

| Concern                       | Owner                                   |
| ----------------------------- | --------------------------------------- |
| A2A protocol types            | `@a2a-js/sdk`                           |
| JSON-RPC serialization        | `@a2a-js/sdk`                           |
| Transport (HTTP, gRPC, SSE)   | `@a2a-js/sdk`                           |
| Auth header building          | `@a2a-js/sdk` (`CallInterceptor`)       |
| Server request handling       | `@a2a-js/sdk` (`DefaultRequestHandler`) |
| Task lifecycle management     | `@a2a-js/sdk` (`TaskStore`)             |
| Push notifications            | `@a2a-js/sdk`                           |
| Tenant isolation              | `@agent-platform/a2a`                   |
| Tracing (TraceEvent emission) | `@agent-platform/a2a`                   |
| SSRF endpoint validation      | `@agent-platform/a2a`                   |
| RuntimeExecutor bridging      | `@agent-platform/a2a`                   |
| Session persistence bridging  | `@agent-platform/a2a`                   |

### Dependency graph

```
@a2a-js/sdk (protocol mechanics)
     ↑
@agent-platform/a2a (platform adapters)
     ↑
apps/runtime (wiring + mounting)
```

## Domain Layer

### Ports (`src/domain/ports.ts`)

Platform port interfaces — what the A2A module needs from the host runtime:

```ts
interface A2ATracingPort {
  traceOutbound(params: {
    targetEndpoint: string;
    taskId: string;
    tenantId: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;
  traceInbound(params: {
    sourceIp: string;
    taskId: string;
    tenantId: string;
    agentName: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;
}

interface EndpointValidator {
  validate(url: string, allowPrivate?: boolean): void;
}

interface AgentExecutionPort {
  executeMessage(sessionId: string, message: string): Promise<ExecutionResult>;
  getSessionDetail(sessionId: string): SessionDetail | null;
}
```

No domain entities or value objects — the SDK owns all protocol types. Our domain layer defines only the ports that bridge platform concerns.

### Message extraction helpers

`extractResponseFromArtifacts` and `extractPromptFromTask` are deleted. The SDK's structured `Task` type and `Message` parts handle this natively.

## Application Layer

### `SendTaskUseCase` (`src/application/send-task.ts`)

Outbound task dispatch. Used by `routing-executor.ts` for remote handoffs.

1. Validate endpoint via `EndpointValidator` port
2. Create SDK `A2AClient` with tracing `CallInterceptor`
3. Build SDK `Message` from params (text, context, history)
4. Call `client.sendMessage(params)`
5. Emit trace event via `A2ATracingPort`
6. Return SDK `Task`

Constructor injection of ports:

```ts
class SendTaskUseCase {
  constructor(
    private endpointValidator: EndpointValidator,
    private tracing: A2ATracingPort,
  ) {}

  async execute(params: SendTaskParams): Promise<Task> { ... }
}
```

### `DiscoverAgentUseCase` (`src/application/discover-agent.ts`)

Fetch remote agent capability card.

1. Validate endpoint via `EndpointValidator`
2. Use SDK `DefaultAgentCardResolver` with tracing interceptor
3. Emit trace event
4. Return SDK `AgentCard`

### `ReceiveTaskUseCase` (`src/application/receive-task.ts`)

Adapter between SDK's `AgentExecutor` interface and our `RuntimeExecutor`. The SDK server handler invokes this when an inbound `tasks/send` arrives.

1. SDK handler parses JSON-RPC, calls our `AgentExecutorAdapter`
2. Adapter extracts text from SDK `Message` parts
3. Calls `AgentExecutionPort.executeMessage(contextId, text)`
4. Maps runtime result → SDK response (status state, message parts, artifacts)
5. Emits inbound trace event

## Infrastructure Layer

### `traced-client.ts`

Wraps SDK's `CallInterceptor` to add:

- SSRF validation before every outbound HTTP call
- Timer start/stop around the actual SDK call
- Trace event emission with duration, status, error

### `agent-executor-adapter.ts`

Implements SDK's `AgentExecutor` interface. Bridges inbound A2A requests to our `RuntimeExecutor`:

- Extract text from SDK `Message.parts`
- Call `AgentExecutionPort.executeMessage()`
- Map `ExecutionResult` → SDK task response (status, parts, artifacts)
- Map rich content: markdown → data part, adaptive cards → data part, actions → data part

### `task-store-adapter.ts`

Implements SDK's `TaskStore` interface. Initially wraps SDK's `InMemoryTaskStore`. Can be swapped to a Redis-backed implementation later for distributed deployments.

### `ssrf-interceptor.ts`

Implements `EndpointValidator` port. Thin wrapper around existing `validateUrlForSSRF` from `@abl/compiler`.

### `express-handlers.ts`

Factory function that wires SDK Express handlers with our adapters:

```ts
function createA2AExpressHandlers(config: {
  executor: AgentExecutionPort;
  tracing: A2ATracingPort;
  endpointValidator: EndpointValidator;
  agentCardProvider: () => AgentCard;
}): Router;
```

Returns an Express Router ready to mount. Internally creates SDK `DefaultRequestHandler` with our `AgentExecutorAdapter` and `TaskStoreAdapter`.

## Runtime Changes

### `server.ts` — mount SDK handlers

```ts
// Before:
import a2aRouter from './routes/a2a.js';
app.use('/a2a', a2aRouter);
app.use(a2aRouter);

// After:
import { createA2AExpressHandlers } from '@agent-platform/a2a';
const a2aHandlers = createA2AExpressHandlers({
  executor: runtimeExecutor,
  tracing: traceStore,
  endpointValidator: ssrfValidator,
  agentCardProvider: () => buildAgentCard(runtimeExecutor),
});
app.use('/a2a', a2aHandlers);
```

### `routing-executor.ts` — use `SendTaskUseCase`

```ts
// Before:
const { A2AClient, extractResponseFromArtifacts } = await import('../a2a/a2a-client.js');
const client = new A2AClient(endpoint, { auth, timeoutMs });
const task = await client.sendTask({ contextId, message, context, historyMessages });
const response = extractResponseFromArtifacts(task.artifacts);

// After:
import { SendTaskUseCase } from '@agent-platform/a2a';
const sendTask = new SendTaskUseCase(endpointValidator, tracing);
const task = await sendTask.execute({ endpoint, auth, contextId, message, context, history });
```

### Files deleted from runtime

- `apps/runtime/src/services/a2a/a2a-client.ts`
- `apps/runtime/src/routes/a2a.ts`
- `apps/runtime/src/__tests__/a2a-client.test.ts`
- `apps/runtime/src/__tests__/a2a-routes.test.ts`

### Files modified in runtime

- `apps/runtime/src/server.ts` — new A2A handler mounting
- `apps/runtime/src/services/execution/routing-executor.ts` — use `SendTaskUseCase`

### Files unchanged

- `packages/compiler/src/platform/ir/schema.ts` — `RemoteAgentLocation` type stays
- `packages/compiler/src/__tests__/remote-agent-coordination.test.ts` — DSL compilation tests unchanged

## Package Public API

```ts
// Use cases
export { SendTaskUseCase } from './application/send-task.js';
export { DiscoverAgentUseCase } from './application/discover-agent.js';

// Express server factory
export { createA2AExpressHandlers } from './infrastructure/express-handlers.js';

// Ports (for runtime to implement/inject)
export type { A2ATracingPort, EndpointValidator, AgentExecutionPort } from './domain/ports.js';

// Re-export SDK types consumers need
export type { Task, AgentCard, Message, Part } from '@a2a-js/sdk';
```

## Dependencies

- `@a2a-js/sdk` — official A2A protocol SDK
- `@agent-platform/shared` — `AppError`, `ErrorCodes`
- `express` (peer dependency) — for Express handler factory
- No other new dependencies

## Testing

Tests are written from scratch (not migrated from old tests).

- `send-task.test.ts` — mock `EndpointValidator` + `A2ATracingPort`, verify SDK client called correctly
- `discover-agent.test.ts` — mock ports, verify agent card resolution
- `receive-task.test.ts` — mock `AgentExecutionPort`, verify SDK message → runtime call → SDK response mapping
- `traced-client.test.ts` — verify SSRF check happens before fetch, trace emitted with duration
- `agent-executor-adapter.test.ts` — verify SDK `AgentExecutor` interface fulfilled, rich content mapping

## Error Handling

- SSRF validation failure → `AppError` with `ErrorCodes.VALIDATION_ERROR`, traced
- Remote agent unreachable → SDK transport error, caught by use case, traced with status `error`
- RuntimeExecutor failure → caught by `AgentExecutorAdapter`, mapped to SDK `failed` task state
- Invalid JSON-RPC → SDK `DefaultRequestHandler` returns standard JSON-RPC error codes

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure A2A support as a standalone `packages/a2a/` package using hexagonal architecture, adopting the official `@a2a-js/sdk` for protocol mechanics and wrapping it with platform adapters.

**Architecture:** Hexagonal (ports & adapters). The official SDK owns protocol types, transports, and serialization. Our package defines platform ports (tracing, SSRF, execution) and provides infrastructure adapters that bridge the SDK to our runtime. The runtime becomes thin wiring that imports use cases and mounts SDK Express handlers.

**Tech Stack:** `@a2a-js/sdk` (A2A protocol), TypeScript, Express, Vitest

**Design doc:** `docs/plans/2026-02-18-a2a-redesign-design.md`

---

### Task 1: Create the `packages/a2a/` package scaffold

**Files:**

- Create: `packages/a2a/package.json`
- Create: `packages/a2a/tsconfig.json`
- Create: `packages/a2a/vitest.config.ts`
- Create: `packages/a2a/src/index.ts`

**Step 1: Create `package.json`**

```json
{
  "name": "@agent-platform/a2a",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@a2a-js/sdk": "^0.2.5",
    "@agent-platform/shared": "workspace:*"
  },
  "peerDependencies": {
    "express": "^4.18.0 || ^5.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0",
    "express": "^4.21.0",
    "@types/express": "^5.0.0"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```

**Step 4: Create placeholder `src/index.ts`**

```ts
// @agent-platform/a2a — Platform A2A adapter
// Wraps @a2a-js/sdk with platform concerns (tracing, tenant isolation, SSRF)
export {};
```

**Step 5: Install dependencies**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install`
Expected: Resolves workspace dependencies, creates `node_modules` links

**Step 6: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a build`
Expected: Compiles successfully, creates `dist/index.js`

**Step 7: Commit**

```bash
git add packages/a2a/
git commit -m "feat(a2a): scaffold packages/a2a with SDK dependency"
```

---

### Task 2: Domain ports

**Files:**

- Create: `packages/a2a/src/domain/ports.ts`
- Test: `packages/a2a/src/__tests__/ports.test.ts`

**Step 1: Write the test**

This tests that port interfaces are importable and that a mock implementation satisfies the contract.

```ts
// packages/a2a/src/__tests__/ports.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { A2ATracingPort, EndpointValidator, AgentExecutionPort } from '../domain/ports.js';

describe('A2A domain ports', () => {
  it('A2ATracingPort mock satisfies interface', () => {
    const tracing: A2ATracingPort = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    tracing.traceOutbound({
      targetEndpoint: 'https://remote.example.com',
      taskId: 'task-1',
      tenantId: 'tenant-1',
      durationMs: 150,
      status: 'success',
    });
    expect(tracing.traceOutbound).toHaveBeenCalledOnce();
  });

  it('EndpointValidator mock satisfies interface', () => {
    const validator: EndpointValidator = {
      validate: vi.fn(),
    };
    validator.validate('https://remote.example.com');
    expect(validator.validate).toHaveBeenCalledWith('https://remote.example.com');
  });

  it('AgentExecutionPort mock satisfies interface', async () => {
    const executor: AgentExecutionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello',
        action: { type: 'complete' },
      }),
      getSessionDetail: vi.fn().mockReturnValue(null),
    };
    const result = await executor.executeMessage('session-1', 'Hi');
    expect(result.response).toBe('Hello');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../domain/ports.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/domain/ports.ts

/**
 * Tracing port — emit structured events for every A2A interaction.
 * Runtime provides an implementation backed by its TraceStore.
 */
export interface A2ATracingPort {
  traceOutbound(params: {
    targetEndpoint: string;
    taskId: string;
    tenantId: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;

  traceInbound(params: {
    sourceIp: string;
    taskId: string;
    tenantId: string;
    agentName: string;
    durationMs: number;
    status: 'success' | 'error';
    error?: string;
  }): void;
}

/**
 * Endpoint validation port — SSRF protection before outbound calls.
 * Throws on invalid/private URLs.
 */
export interface EndpointValidator {
  validate(url: string, allowPrivate?: boolean): void;
}

/**
 * Execution result from the runtime agent executor.
 */
export interface ExecutionResult {
  response: string;
  action?: { type: string; [key: string]: unknown };
  richContent?: {
    markdown?: string;
    adaptive_card?: string;
  };
  actions?: unknown;
}

/**
 * Session detail for task status queries.
 */
export interface SessionDetail {
  messages: Array<{ role: string; content: string }>;
}

/**
 * Agent execution port — bridge to the runtime's executor.
 * Runtime provides an implementation backed by RuntimeExecutor.
 */
export interface AgentExecutionPort {
  executeMessage(sessionId: string, message: string): Promise<ExecutionResult>;
  getSessionDetail(sessionId: string): SessionDetail | null;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add packages/a2a/src/domain/ports.ts packages/a2a/src/__tests__/ports.test.ts
git commit -m "feat(a2a): add domain port interfaces"
```

---

### Task 3: SSRF interceptor adapter

**Files:**

- Create: `packages/a2a/src/infrastructure/ssrf-interceptor.ts`
- Test: `packages/a2a/src/__tests__/ssrf-interceptor.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/ssrf-interceptor.test.ts
import { describe, it, expect } from 'vitest';
import { SsrfEndpointValidator } from '../infrastructure/ssrf-interceptor.js';

describe('SsrfEndpointValidator', () => {
  const validator = new SsrfEndpointValidator();

  it('accepts valid public HTTPS URL', () => {
    expect(() => validator.validate('https://remote-agent.example.com/a2a')).not.toThrow();
  });

  it('accepts valid public HTTP URL', () => {
    expect(() => validator.validate('http://remote-agent.example.com/a2a')).not.toThrow();
  });

  it('rejects private IP (127.0.0.1)', () => {
    expect(() => validator.validate('http://127.0.0.1/a2a')).toThrow();
  });

  it('rejects private IP (10.x)', () => {
    expect(() => validator.validate('http://10.0.0.1/a2a')).toThrow();
  });

  it('rejects metadata endpoint (169.254.169.254)', () => {
    expect(() => validator.validate('http://169.254.169.254/latest/meta-data')).toThrow();
  });

  it('allows private IP when allowPrivate is true', () => {
    expect(() => validator.validate('http://127.0.0.1/a2a', true)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../infrastructure/ssrf-interceptor.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/infrastructure/ssrf-interceptor.ts
import type { EndpointValidator } from '../domain/ports.js';

/** Private/reserved IP ranges that must be blocked for SSRF protection. */
const BLOCKED_PATTERNS = [
  /^127\./, // Loopback
  /^10\./, // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
  /^192\.168\./, // Class C private
  /^169\.254\./, // Link-local / metadata
  /^0\./, // Current network
  /^fc00:/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
  /^::1$/, // IPv6 loopback
];

/**
 * Validates URLs against SSRF attacks by blocking private/reserved IP ranges.
 * Implements the EndpointValidator port.
 */
export class SsrfEndpointValidator implements EndpointValidator {
  validate(url: string, allowPrivate = false): void {
    if (allowPrivate) return;

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error(`SSRF blocked: ${hostname} is a private/reserved address`);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS (all SSRF tests + previous port tests)

**Step 5: Commit**

```bash
git add packages/a2a/src/infrastructure/ssrf-interceptor.ts packages/a2a/src/__tests__/ssrf-interceptor.test.ts
git commit -m "feat(a2a): add SSRF endpoint validator adapter"
```

---

### Task 4: Traced client (SDK CallInterceptor wrapper)

**Files:**

- Create: `packages/a2a/src/infrastructure/traced-client.ts`
- Test: `packages/a2a/src/__tests__/traced-client.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/traced-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

describe('TracedCallInterceptor', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;

  beforeEach(() => {
    tracing = {
      traceOutbound: vi.fn(),
      traceInbound: vi.fn(),
    };
    validator = {
      validate: vi.fn(),
    };
  });

  it('validates endpoint on creation', () => {
    new TracedCallInterceptor({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      tracing,
      validator,
    });
    expect(validator.validate).toHaveBeenCalledWith('https://remote.example.com', undefined);
  });

  it('throws if SSRF validation fails', () => {
    (validator.validate as any).mockImplementation(() => {
      throw new Error('SSRF blocked');
    });
    expect(
      () =>
        new TracedCallInterceptor({
          endpoint: 'http://127.0.0.1',
          tenantId: 'tenant-1',
          tracing,
          validator,
        }),
    ).toThrow('SSRF blocked');
  });

  it('exposes endpoint and tenantId', () => {
    const interceptor = new TracedCallInterceptor({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      tracing,
      validator,
    });
    expect(interceptor.endpoint).toBe('https://remote.example.com');
    expect(interceptor.tenantId).toBe('tenant-1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../infrastructure/traced-client.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/infrastructure/traced-client.ts
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

interface TracedCallInterceptorConfig {
  endpoint: string;
  tenantId: string;
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  allowPrivate?: boolean;
}

/**
 * Wraps outbound A2A calls with SSRF validation and tracing.
 *
 * Validates the endpoint at construction time (fail-fast) and
 * provides a trace method for use cases to call after SDK operations.
 */
export class TracedCallInterceptor {
  readonly endpoint: string;
  readonly tenantId: string;
  private tracing: A2ATracingPort;

  constructor(config: TracedCallInterceptorConfig) {
    config.validator.validate(config.endpoint, config.allowPrivate);
    this.endpoint = config.endpoint;
    this.tenantId = config.tenantId;
    this.tracing = config.tracing;
  }

  /**
   * Record an outbound A2A call trace event.
   * Call this after the SDK operation completes (success or error).
   */
  traceCall(taskId: string, durationMs: number, status: 'success' | 'error', error?: string): void {
    this.tracing.traceOutbound({
      targetEndpoint: this.endpoint,
      taskId,
      tenantId: this.tenantId,
      durationMs,
      status,
      error,
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/a2a/src/infrastructure/traced-client.ts packages/a2a/src/__tests__/traced-client.test.ts
git commit -m "feat(a2a): add traced call interceptor with SSRF validation"
```

---

### Task 5: SendTaskUseCase

**Files:**

- Create: `packages/a2a/src/application/send-task.ts`
- Test: `packages/a2a/src/__tests__/send-task.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/send-task.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendTaskUseCase } from '../application/send-task.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

// Mock the SDK client
vi.mock('@a2a-js/sdk/client', () => ({
  A2AClient: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      id: 'task-123',
      contextId: 'ctx-1',
      status: {
        state: 'completed',
        message: { role: 'agent', parts: [{ type: 'text', text: 'Done' }] },
      },
      artifacts: [{ parts: [{ type: 'text', text: 'Result text' }] }],
    }),
  })),
}));

describe('SendTaskUseCase', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;
  let useCase: SendTaskUseCase;

  beforeEach(() => {
    tracing = { traceOutbound: vi.fn(), traceInbound: vi.fn() };
    validator = { validate: vi.fn() };
    useCase = new SendTaskUseCase(validator, tracing);
  });

  it('validates endpoint before sending', async () => {
    await useCase.execute({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      contextId: 'ctx-1',
      message: 'Hello',
    });
    expect(validator.validate).toHaveBeenCalledWith('https://remote.example.com', undefined);
  });

  it('traces a successful outbound call', async () => {
    await useCase.execute({
      endpoint: 'https://remote.example.com',
      tenantId: 'tenant-1',
      contextId: 'ctx-1',
      message: 'Hello',
    });
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEndpoint: 'https://remote.example.com',
        tenantId: 'tenant-1',
        status: 'success',
      }),
    );
  });

  it('traces an error when SDK call fails', async () => {
    const { A2AClient } = await import('@a2a-js/sdk/client');
    (A2AClient as any).mockImplementation(() => ({
      sendMessage: vi.fn().mockRejectedValue(new Error('Connection refused')),
    }));

    await expect(
      useCase.execute({
        endpoint: 'https://remote.example.com',
        tenantId: 'tenant-1',
        contextId: 'ctx-1',
        message: 'Hello',
      }),
    ).rejects.toThrow('Connection refused');

    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'Connection refused',
      }),
    );
  });

  it('throws if SSRF validation fails', async () => {
    (validator.validate as any).mockImplementation(() => {
      throw new Error('SSRF blocked');
    });

    await expect(
      useCase.execute({
        endpoint: 'http://127.0.0.1',
        tenantId: 'tenant-1',
        contextId: 'ctx-1',
        message: 'Hello',
      }),
    ).rejects.toThrow('SSRF blocked');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../application/send-task.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/application/send-task.ts
import type { Task, Message, Part } from '@a2a-js/sdk';
import { A2AClient } from '@a2a-js/sdk/client';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import { TracedCallInterceptor } from '../infrastructure/traced-client.js';

export interface SendTaskParams {
  endpoint: string;
  tenantId: string;
  contextId: string;
  message: string;
  context?: Record<string, unknown>;
  history?: Array<{ role: string; content: string }>;
  auth?: {
    type: 'api_key' | 'bearer' | 'oauth';
    header?: string;
    value?: string;
  };
  timeoutMs?: number;
  allowPrivate?: boolean;
}

/**
 * Sends a task to a remote A2A agent.
 *
 * Validates the endpoint (SSRF), creates an SDK client, sends the message,
 * and traces the call. All protocol mechanics delegated to @a2a-js/sdk.
 */
export class SendTaskUseCase {
  constructor(
    private validator: EndpointValidator,
    private tracing: A2ATracingPort,
  ) {}

  async execute(params: SendTaskParams): Promise<Task> {
    const interceptor = new TracedCallInterceptor({
      endpoint: params.endpoint,
      tenantId: params.tenantId,
      tracing: this.tracing,
      validator: this.validator,
      allowPrivate: params.allowPrivate,
    });

    const client = new A2AClient({ url: params.endpoint });

    // Build SDK message
    const parts: Part[] = [{ type: 'text', text: params.message }];
    if (params.context) {
      parts.push({ type: 'data', data: params.context });
    }
    const message: Message = { role: 'user', parts };

    const start = Date.now();
    try {
      const task = await client.sendMessage({
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        message,
        configuration: {
          acceptedOutputModes: ['text'],
        },
      });

      interceptor.traceCall(task.id ?? 'unknown', Date.now() - start, 'success');

      return task;
    } catch (error) {
      interceptor.traceCall(
        'unknown',
        Date.now() - start,
        'error',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
```

> **Note:** The exact SDK client API (`A2AClient` constructor, `sendMessage` params) may need adjustment based on the installed SDK version. The test mocks the SDK so the use case logic is verified regardless. Adjust imports and constructor after `pnpm install` confirms the SDK's actual API.

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/a2a/src/application/send-task.ts packages/a2a/src/__tests__/send-task.test.ts
git commit -m "feat(a2a): add SendTaskUseCase with tracing and SSRF"
```

---

### Task 6: DiscoverAgentUseCase

**Files:**

- Create: `packages/a2a/src/application/discover-agent.ts`
- Test: `packages/a2a/src/__tests__/discover-agent.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/discover-agent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscoverAgentUseCase } from '../application/discover-agent.js';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

const MOCK_CARD = {
  name: 'Remote Agent',
  description: 'A remote A2A agent',
  url: 'https://remote.example.com/a2a',
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [{ id: 'skill-1', name: 'Booking', description: 'Books things' }],
};

vi.mock('@a2a-js/sdk/client', () => ({
  DefaultAgentCardResolver: vi.fn().mockImplementation(() => ({
    getAgentCard: vi.fn().mockResolvedValue(MOCK_CARD),
  })),
}));

describe('DiscoverAgentUseCase', () => {
  let tracing: A2ATracingPort;
  let validator: EndpointValidator;
  let useCase: DiscoverAgentUseCase;

  beforeEach(() => {
    tracing = { traceOutbound: vi.fn(), traceInbound: vi.fn() };
    validator = { validate: vi.fn() };
    useCase = new DiscoverAgentUseCase(validator, tracing);
  });

  it('validates endpoint before discovery', async () => {
    await useCase.execute({ endpoint: 'https://remote.example.com', tenantId: 't-1' });
    expect(validator.validate).toHaveBeenCalledWith('https://remote.example.com', undefined);
  });

  it('returns the agent card', async () => {
    const card = await useCase.execute({ endpoint: 'https://remote.example.com', tenantId: 't-1' });
    expect(card.name).toBe('Remote Agent');
    expect(card.skills).toHaveLength(1);
  });

  it('traces the discovery call', async () => {
    await useCase.execute({ endpoint: 'https://remote.example.com', tenantId: 't-1' });
    expect(tracing.traceOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', tenantId: 't-1' }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../application/discover-agent.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/application/discover-agent.ts
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import type { A2ATracingPort, EndpointValidator } from '../domain/ports.js';

export interface DiscoverAgentParams {
  endpoint: string;
  tenantId: string;
  allowPrivate?: boolean;
}

/**
 * Fetches a remote agent's Agent Card for capability discovery.
 *
 * Validates the endpoint (SSRF), uses the SDK's card resolver,
 * and traces the call.
 */
export class DiscoverAgentUseCase {
  constructor(
    private validator: EndpointValidator,
    private tracing: A2ATracingPort,
  ) {}

  async execute(params: DiscoverAgentParams): Promise<AgentCard> {
    this.validator.validate(params.endpoint, params.allowPrivate);

    const resolver = new DefaultAgentCardResolver();
    const start = Date.now();

    try {
      const card = await resolver.getAgentCard(params.endpoint);

      this.tracing.traceOutbound({
        targetEndpoint: params.endpoint,
        taskId: 'discovery',
        tenantId: params.tenantId,
        durationMs: Date.now() - start,
        status: 'success',
      });

      return card;
    } catch (error) {
      this.tracing.traceOutbound({
        targetEndpoint: params.endpoint,
        taskId: 'discovery',
        tenantId: params.tenantId,
        durationMs: Date.now() - start,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/a2a/src/application/discover-agent.ts packages/a2a/src/__tests__/discover-agent.test.ts
git commit -m "feat(a2a): add DiscoverAgentUseCase"
```

---

### Task 7: AgentExecutorAdapter (inbound bridge)

**Files:**

- Create: `packages/a2a/src/infrastructure/agent-executor-adapter.ts`
- Test: `packages/a2a/src/__tests__/agent-executor-adapter.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/agent-executor-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentExecutorAdapter } from '../infrastructure/agent-executor-adapter.js';
import type { AgentExecutionPort, A2ATracingPort } from '../domain/ports.js';

describe('AgentExecutorAdapter', () => {
  let executionPort: AgentExecutionPort;
  let tracing: A2ATracingPort;
  let adapter: AgentExecutorAdapter;

  beforeEach(() => {
    executionPort = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Booking confirmed',
        action: { type: 'complete' },
        richContent: { markdown: '**Confirmed**' },
      }),
      getSessionDetail: vi.fn().mockReturnValue({
        messages: [
          { role: 'user', content: 'Book a room' },
          { role: 'assistant', content: 'Booking confirmed' },
        ],
      }),
    };
    tracing = { traceOutbound: vi.fn(), traceInbound: vi.fn() };
    adapter = new AgentExecutorAdapter(executionPort, tracing);
  });

  it('extracts text from message parts and calls execution port', async () => {
    const mockEventBus = { publish: vi.fn() };
    const mockRequestContext = {
      userMessage: { role: 'user', parts: [{ type: 'text', text: 'Book a room' }] },
      taskId: 'task-1',
      contextId: 'ctx-1',
    };

    await adapter.execute(mockRequestContext as any, mockEventBus as any);

    expect(executionPort.executeMessage).toHaveBeenCalledWith('ctx-1', 'Book a room');
  });

  it('publishes status completed for complete action', async () => {
    const published: any[] = [];
    const mockEventBus = { publish: vi.fn((event: any) => published.push(event)) };
    const mockRequestContext = {
      userMessage: { role: 'user', parts: [{ type: 'text', text: 'Book a room' }] },
      taskId: 'task-1',
      contextId: 'ctx-1',
    };

    await adapter.execute(mockRequestContext as any, mockEventBus as any);

    expect(mockEventBus.publish).toHaveBeenCalled();
  });

  it('traces inbound execution', async () => {
    const mockEventBus = { publish: vi.fn() };
    const mockRequestContext = {
      userMessage: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      taskId: 'task-1',
      contextId: 'ctx-1',
      context: { remoteAddress: '1.2.3.4' },
    };

    await adapter.execute(mockRequestContext as any, mockEventBus as any);

    expect(tracing.traceInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        status: 'success',
      }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../infrastructure/agent-executor-adapter.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/infrastructure/agent-executor-adapter.ts
import type { AgentExecutor, RequestContext } from '@a2a-js/sdk/server';
import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import type { AgentExecutionPort, A2ATracingPort } from '../domain/ports.js';

/**
 * Bridges the SDK's AgentExecutor interface to our RuntimeExecutor.
 *
 * When an inbound tasks/send arrives, the SDK parses the JSON-RPC request
 * and calls this adapter. We extract the text, delegate to our executor,
 * map the result back to SDK events, and trace the call.
 */
export class AgentExecutorAdapter implements AgentExecutor {
  constructor(
    private executionPort: AgentExecutionPort,
    private tracing: A2ATracingPort,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const start = Date.now();
    const { userMessage, taskId, contextId } = requestContext;

    // Extract text from SDK message parts
    const textParts = userMessage.parts
      .filter((p: any) => p.type === 'text' && p.text)
      .map((p: any) => p.text);
    const text = textParts.join('\n');

    const sourceIp = (requestContext as any).context?.remoteAddress ?? 'unknown';

    try {
      const result = await this.executionPort.executeMessage(contextId, text);

      // Map our result → SDK status state
      const state =
        result.action?.type === 'complete'
          ? 'completed'
          : result.action?.type === 'escalate'
            ? 'input-required'
            : 'completed';

      // Build response message parts
      const parts: any[] = [{ type: 'text', text: result.response }];
      if (result.richContent?.markdown) {
        parts.push({
          type: 'data',
          data: { format: 'markdown', content: result.richContent.markdown },
        });
      }

      // Publish status update through SDK event bus
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state, message: { role: 'agent', parts } },
        final: true,
      });

      // Publish artifact if there's a response
      if (result.response) {
        eventBus.publish({
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: { parts: [{ type: 'text', text: result.response }] },
        });
      }

      this.tracing.traceInbound({
        sourceIp,
        taskId,
        tenantId: 'unknown', // TODO: extract from request auth context
        agentName: 'runtime',
        durationMs: Date.now() - start,
        status: 'success',
      });
    } catch (error) {
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            role: 'agent',
            parts: [
              { type: 'text', text: error instanceof Error ? error.message : 'Execution failed' },
            ],
          },
        },
        final: true,
      });

      this.tracing.traceInbound({
        sourceIp,
        taskId,
        tenantId: 'unknown',
        agentName: 'runtime',
        durationMs: Date.now() - start,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    // No-op — cancellation not yet supported by our runtime
  }
}
```

> **Note:** The exact SDK event bus `publish` payload shape (`kind`, fields) may differ from what's shown. The test mocks the event bus so the adapter logic is verified. Adjust event payloads after inspecting the installed SDK's `ExecutionEventBus` type.

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/a2a/src/infrastructure/agent-executor-adapter.ts packages/a2a/src/__tests__/agent-executor-adapter.test.ts
git commit -m "feat(a2a): add AgentExecutorAdapter bridging SDK to RuntimeExecutor"
```

---

### Task 8: Express handler factory

**Files:**

- Create: `packages/a2a/src/infrastructure/express-handlers.ts`
- Test: `packages/a2a/src/__tests__/express-handlers.test.ts`

**Step 1: Write the test**

```ts
// packages/a2a/src/__tests__/express-handlers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createA2AExpressHandlers } from '../infrastructure/express-handlers.js';
import type { AgentExecutionPort, A2ATracingPort, EndpointValidator } from '../domain/ports.js';

describe('createA2AExpressHandlers', () => {
  it('returns an Express Router', () => {
    const executor: AgentExecutionPort = {
      executeMessage: vi.fn().mockResolvedValue({ response: 'ok', action: { type: 'complete' } }),
      getSessionDetail: vi.fn().mockReturnValue(null),
    };
    const tracing: A2ATracingPort = { traceOutbound: vi.fn(), traceInbound: vi.fn() };
    const validator: EndpointValidator = { validate: vi.fn() };

    const router = createA2AExpressHandlers({
      executor,
      tracing,
      validator,
      agentCard: {
        name: 'Test Runtime',
        description: 'Test',
        url: 'http://localhost:3000/a2a',
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: [],
      },
    });

    // Express Router is a function
    expect(typeof router).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: FAIL — cannot resolve `../infrastructure/express-handlers.js`

**Step 3: Write the implementation**

```ts
// packages/a2a/src/infrastructure/express-handlers.ts
import { Router } from 'express';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { jsonRpcHandler, agentCardHandler } from '@a2a-js/sdk/server/express';
import type { AgentExecutionPort, A2ATracingPort, EndpointValidator } from '../domain/ports.js';
import { AgentExecutorAdapter } from './agent-executor-adapter.js';

export interface A2AExpressHandlerConfig {
  executor: AgentExecutionPort;
  tracing: A2ATracingPort;
  validator: EndpointValidator;
  agentCard: AgentCard;
}

/**
 * Creates an Express Router with SDK-backed A2A endpoints.
 *
 * Mounts:
 * - POST / — JSON-RPC endpoint (tasks/send, tasks/get, tasks/cancel)
 * - GET /.well-known/agent.json — Agent Card discovery
 *
 * All protocol mechanics handled by the SDK. Our adapter bridges
 * execution to the platform's RuntimeExecutor.
 */
export function createA2AExpressHandlers(config: A2AExpressHandlerConfig): Router {
  const router = Router();

  const agentExecutorAdapter = new AgentExecutorAdapter(config.executor, config.tracing);

  const taskStore = new InMemoryTaskStore();

  const requestHandler = new DefaultRequestHandler(
    config.agentCard,
    taskStore,
    agentExecutorAdapter,
  );

  // Mount JSON-RPC handler at root of this router
  router.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: { build: () => ({ id: 'anonymous' }) },
    }),
  );

  // Mount agent card at well-known path
  router.use(
    agentCardHandler({
      agentCardProvider: async () => config.agentCard,
    }),
  );

  return router;
}
```

> **Note:** The SDK's `userBuilder` and `agentCardHandler` interface may need adjustment based on installed SDK version. The `UserBuilder.noAuthentication` shorthand may be available. Adjust after install.

**Step 4: Run test to verify it passes**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/a2a/src/infrastructure/express-handlers.ts packages/a2a/src/__tests__/express-handlers.test.ts
git commit -m "feat(a2a): add Express handler factory with SDK integration"
```

---

### Task 9: Package public API exports

**Files:**

- Modify: `packages/a2a/src/index.ts`

**Step 1: Update index.ts with all public exports**

```ts
// packages/a2a/src/index.ts

// --- Use cases ---
export { SendTaskUseCase } from './application/send-task.js';
export type { SendTaskParams } from './application/send-task.js';
export { DiscoverAgentUseCase } from './application/discover-agent.js';
export type { DiscoverAgentParams } from './application/discover-agent.js';

// --- Express server factory ---
export { createA2AExpressHandlers } from './infrastructure/express-handlers.js';
export type { A2AExpressHandlerConfig } from './infrastructure/express-handlers.js';

// --- Infrastructure adapters (for advanced wiring) ---
export { AgentExecutorAdapter } from './infrastructure/agent-executor-adapter.js';
export { SsrfEndpointValidator } from './infrastructure/ssrf-interceptor.js';
export { TracedCallInterceptor } from './infrastructure/traced-client.js';

// --- Domain ports (for runtime to implement/inject) ---
export type {
  A2ATracingPort,
  EndpointValidator,
  AgentExecutionPort,
  ExecutionResult,
  SessionDetail,
} from './domain/ports.js';

// --- Re-export SDK types consumers need ---
export type { Task, AgentCard, Message, Part } from '@a2a-js/sdk';
```

**Step 2: Verify build succeeds**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a build`
Expected: Compiles successfully

**Step 3: Verify all tests still pass**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add packages/a2a/src/index.ts
git commit -m "feat(a2a): finalize package public API exports"
```

---

### Task 10: Wire runtime routing-executor to use SendTaskUseCase

**Files:**

- Modify: `apps/runtime/src/services/execution/routing-executor.ts:366-482`
- Modify: `apps/runtime/package.json` (add `@agent-platform/a2a` dependency)

**Step 1: Add dependency**

Add to `apps/runtime/package.json` dependencies:

```json
"@agent-platform/a2a": "workspace:*"
```

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm install`

**Step 2: Refactor `handleRemoteHandoff`**

Replace the dynamic import of `A2AClient` and manual client construction with `SendTaskUseCase`.

In `apps/runtime/src/services/execution/routing-executor.ts`, replace lines 378-383:

```ts
// BEFORE:
const { A2AClient, extractResponseFromArtifacts, extractPromptFromTask } =
  await import('../a2a/a2a-client.js');
const client = new A2AClient(agentInfo.remote!.endpoint, {
  auth: agentInfo.remote!.auth as any,
  timeoutMs: agentInfo.remote!.timeout,
});
```

With:

```ts
// AFTER:
import { SendTaskUseCase, SsrfEndpointValidator } from '@agent-platform/a2a';
import type { A2ATracingPort } from '@agent-platform/a2a';

// ... at top of file, add the import above

// ... in handleRemoteHandoff method body:
const validator = new SsrfEndpointValidator();
const tracing: A2ATracingPort = {
  traceOutbound: (params) => {
    if (onTraceEvent) {
      onTraceEvent({ type: 'a2a_call', data: params as Record<string, unknown> });
    }
  },
  traceInbound: () => {},
};
const sendTask = new SendTaskUseCase(validator, tracing);
```

Replace the `client.sendTask()` call (lines 422-428):

```ts
// BEFORE:
const result = await client.sendTask({
  contextId: session.id,
  message: lastUserMessage,
  context,
  historyMessages,
});

// AFTER:
const result = await sendTask.execute({
  endpoint: agentInfo.remote!.endpoint,
  tenantId: session.tenantId ?? 'unknown',
  contextId: session.id,
  message: lastUserMessage,
  context,
  history: historyMessages,
  auth: agentInfo.remote!.auth as any,
  timeoutMs: agentInfo.remote!.timeout,
});
```

Replace the response extraction (lines 442-443):

```ts
// BEFORE:
const response = extractResponseFromArtifacts(result.artifacts) || extractPromptFromTask(result);

// AFTER:
// Extract text from SDK Task artifacts and status message
const artifactText = (result.artifacts ?? [])
  .flatMap((a: any) => a.parts?.filter((p: any) => p.type === 'text' && p.text) ?? [])
  .map((p: any) => p.text)
  .join('\n');
const statusText =
  result.status?.message?.parts
    ?.filter((p: any) => p.type === 'text' && p.text)
    .map((p: any) => p.text)
    .join('\n') ?? '';
const response = statusText || artifactText || '';
```

Remove the old trace event emission (lines 430-440) — tracing is now handled inside `SendTaskUseCase`.

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: Full monorepo build succeeds

**Step 4: Commit**

```bash
git add apps/runtime/package.json apps/runtime/src/services/execution/routing-executor.ts
git commit -m "refactor(runtime): use SendTaskUseCase from @agent-platform/a2a"
```

---

### Task 11: Wire runtime server.ts to use SDK Express handlers

**Files:**

- Modify: `apps/runtime/src/server.ts:167-168`

**Step 1: Replace custom A2A route mounting**

In `apps/runtime/src/server.ts`, replace lines 167-168:

```ts
// BEFORE:
app.use('/a2a', a2aRouter);
app.use(a2aRouter); // Mount at root for /.well-known/agent.json

// AFTER:
import { createA2AExpressHandlers, SsrfEndpointValidator } from '@agent-platform/a2a';
import type { A2ATracingPort, AgentExecutionPort } from '@agent-platform/a2a';

// ... build the handler config:
const a2aExecutor: AgentExecutionPort = {
  executeMessage: (sessionId, message) => getRuntimeExecutor().executeMessage(sessionId, message),
  getSessionDetail: (sessionId) => getRuntimeExecutor().getSessionDetail(sessionId),
};

const a2aTracing: A2ATracingPort = {
  traceOutbound: (params) => log.info('a2a:outbound', params),
  traceInbound: (params) => log.info('a2a:inbound', params),
};

const a2aHandlers = createA2AExpressHandlers({
  executor: a2aExecutor,
  tracing: a2aTracing,
  validator: new SsrfEndpointValidator(),
  agentCard: {
    name: 'Agent Runtime',
    description: 'ABL Agent Runtime - A2A compatible',
    url: `${process.env.BASE_URL ?? 'http://localhost:3112'}/a2a`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  },
});

app.use('/a2a', a2aHandlers);
```

Also remove the old import at the top of the file:

```ts
// REMOVE:
import a2aRouter from './routes/a2a.js';
```

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: Full monorepo build succeeds

**Step 3: Commit**

```bash
git add apps/runtime/src/server.ts
git commit -m "refactor(runtime): mount SDK-backed A2A Express handlers"
```

---

### Task 12: Delete old A2A files from runtime

**Files:**

- Delete: `apps/runtime/src/services/a2a/a2a-client.ts`
- Delete: `apps/runtime/src/routes/a2a.ts`
- Delete: `apps/runtime/src/__tests__/a2a-client.test.ts`
- Delete: `apps/runtime/src/__tests__/a2a-routes.test.ts`

**Step 1: Verify no other imports reference the old files**

Run: `grep -r "a2a-client" apps/runtime/src/ --include="*.ts" -l`
Run: `grep -r "routes/a2a" apps/runtime/src/ --include="*.ts" -l`

Expected: No results (all references should have been replaced in Tasks 10-11). If any remain, update those imports first.

**Step 2: Delete old files**

```bash
rm apps/runtime/src/services/a2a/a2a-client.ts
rm apps/runtime/src/routes/a2a.ts
rm apps/runtime/src/__tests__/a2a-client.test.ts
rm apps/runtime/src/__tests__/a2a-routes.test.ts
```

**Step 3: Verify build still succeeds**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: Full monorepo build succeeds. No dangling imports.

**Step 4: Verify all tests pass**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test`
Expected: All packages pass (the old tests are deleted, new tests in `packages/a2a` pass)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(runtime): delete old A2A client, routes, and tests"
```

---

### Task 13: End-to-end build and verification

**Files:** None (verification only)

**Step 1: Full monorepo build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build`
Expected: All packages build successfully including `@agent-platform/a2a`

**Step 2: Run all tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test`
Expected: All tests pass

**Step 3: Verify the new package tests specifically**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/a2a test`
Expected: All 6 test suites pass:

- `ports.test.ts`
- `ssrf-interceptor.test.ts`
- `traced-client.test.ts`
- `send-task.test.ts`
- `discover-agent.test.ts`
- `agent-executor-adapter.test.ts`
- `express-handlers.test.ts`

**Step 4: Verify no dangling references to old A2A files**

Run: `grep -r "a2a-client" apps/runtime/src/ --include="*.ts"`
Run: `grep -r "from.*routes/a2a" apps/runtime/src/ --include="*.ts"`
Expected: No results

**Step 5: Final commit if any cleanup needed**

If any fixes were required, commit them:

```bash
git add -A
git commit -m "chore(a2a): final cleanup and verification"
```
