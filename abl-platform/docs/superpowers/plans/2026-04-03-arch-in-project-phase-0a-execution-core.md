# Arch In-Project Phase 0a: Execution Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-turn tool execution works end-to-end for IN_PROJECT mode, with auth propagation, input validation, failure recovery, and security fixes — without breaking the working ONBOARDING flow.

**Architecture:** Conditional routing in the message route — `mode === 'IN_PROJECT'` uses the clean `executeSpecialistTurn` from `specialist-executor.ts`; ONBOARDING continues using the existing `processMessage` path. The executor is extended with multi-turn loops (re-invoke LLM after tool results), auth context threading, Zod validation, and timeout/stall/loop protection.

**Tech Stack:** TypeScript, Vercel AI SDK (ONBOARDING path only), Zod, MongoDB (session model), SSE streaming

**Design Spec:** `docs/arch/research/2026-04-03-in-project-capabilities-design.md` — Phase 0, deliverables #1-8
**Prototype Gate:** Prototype A — LLM calls `query_sessions` → executor runs → result fed back → LLM generates insight text → SSE streamed to client

---

## File Structure

### New Files

| File                                                     | Responsibility                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/executor/multi-turn-executor.ts`   | Multi-turn wrapper around `executeSpecialistTurn` — handles re-invocation loop, timeout, stall detection, max-turns cap |
| `packages/arch-ai/src/executor/tool-validator.ts`        | Zod schema registry for tool inputs — validates before execution                                                        |
| `packages/arch-ai/src/executor/executor-guards.ts`       | Timeout, stall detection, and loop detection wiring                                                                     |
| `packages/arch-ai/src/types/auth-context.ts`             | `AuthContext` type and `ToolExecuteFn` v2 signature                                                                     |
| `packages/arch-ai/src/types/chain-context.ts`            | `ChainContext`, `Finding`, `Action` types for specialist chaining                                                       |
| `packages/arch-ai/src/types/in-project-specialists.ts`   | IN_PROJECT specialist IDs, display map, coexistence with ONBOARDING                                                     |
| `packages/arch-ai/src/classifier/in-project-approval.ts` | New 3-tier (SMALL/MEDIUM/LARGE) approval classifier for IN_PROJECT mutations                                            |
| `packages/arch-ai/src/tools/schemas/`                    | Directory with per-tool Zod input schemas                                                                               |

### Modified Files

| File                                                   | Changes                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `packages/arch-ai/src/executor/specialist-executor.ts` | Accept `AuthContext`, pass to `ToolExecuteFn`                  |
| `packages/arch-ai/src/types/tools.ts`                  | Add new IN_PROJECT specialist tool names to `ToolName` union   |
| `packages/arch-ai/src/types/session.ts`                | Add `activeSpecialist`, `pendingMutation` to `SessionMetadata` |
| `packages/arch-ai/src/types/constants.ts`              | Add 5 IN_PROJECT specialist IDs to `SPECIALIST_IDS`            |
| `packages/arch-ai/src/types/sse-events.ts`             | Add `version` field to new event types                         |
| `packages/database/src/models/arch-session.model.ts`   | Fix partial unique index for per-project IN_PROJECT sessions   |
| `apps/studio/src/app/api/arch-ai/message/route.ts`     | Add conditional routing: IN_PROJECT → multi-turn executor      |
| `packages/arch-ai/src/index.ts`                        | Export new types and functions                                 |

---

## Task 1: Fix Session Index for Per-Project Isolation

**Files:**

- Modify: `packages/database/src/models/arch-session.model.ts` (indexes at end of file)

This is a security fix — must land first since the current index allows session conflicts.

- [ ] **Step 1: Write failing test**

Create `packages/arch-ai/src/__tests__/session-index.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { ArchSessionModel } from '@abl/database/models/arch-session.model';

describe('ArchSession per-project uniqueness', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/test-arch-session');
  });

  afterAll(async () => {
    await ArchSessionModel.deleteMany({ tenantId: 'test-tenant-idx' });
    await mongoose.disconnect();
  });

  it('allows two active IN_PROJECT sessions for different projects', async () => {
    const base = {
      tenantId: 'test-tenant-idx',
      userId: 'user-1',
      state: 'ACTIVE' as const,
      metadata: {
        phase: 'INTERVIEW' as const,
        mode: 'IN_PROJECT' as const,
        specification: {},
        pendingInteraction: null,
        messages: [],
      },
    };

    const session1 = await ArchSessionModel.create({
      ...base,
      metadata: { ...base.metadata, projectId: 'project-A' },
    });

    const session2 = await ArchSessionModel.create({
      ...base,
      metadata: { ...base.metadata, projectId: 'project-B' },
    });

    expect(session1.id).toBeDefined();
    expect(session2.id).toBeDefined();
  });

  it('rejects two active IN_PROJECT sessions for the SAME project', async () => {
    await ArchSessionModel.deleteMany({ tenantId: 'test-tenant-idx-dup' });

    const base = {
      tenantId: 'test-tenant-idx-dup',
      userId: 'user-1',
      state: 'ACTIVE' as const,
      metadata: {
        phase: 'INTERVIEW' as const,
        mode: 'IN_PROJECT' as const,
        specification: {},
        pendingInteraction: null,
        messages: [],
        projectId: 'project-A',
      },
    };

    await ArchSessionModel.create(base);

    await expect(ArchSessionModel.create(base)).rejects.toThrow(/duplicate key/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/database && pnpm test -- --run session-index`
Expected: First test PASSES (current index doesn't check projectId, so two projects work by accident). Second test FAILS (current index blocks two sessions for same user+mode regardless of projectId).

- [ ] **Step 3: Update the session model index**

In `packages/database/src/models/arch-session.model.ts`, replace the partial unique index:

```typescript
// OLD: one non-terminal session per (tenantId, userId, mode)
// ArchSessionSchema.index(
//   { tenantId: 1, userId: 1, 'metadata.mode': 1 },
//   {
//     unique: true,
//     partialFilterExpression: {
//       state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] },
//     },
//   },
// );

// NEW: one non-terminal session per (tenantId, userId, mode, projectId)
// For ONBOARDING (no projectId), uniqueness is per (tenantId, userId, mode)
// For IN_PROJECT, uniqueness includes projectId
ArchSessionSchema.index(
  { tenantId: 1, userId: 1, 'metadata.mode': 1, 'metadata.projectId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] },
    },
  },
);
```

Also update the query index to match:

```typescript
ArchSessionSchema.index({
  tenantId: 1,
  userId: 1,
  'metadata.mode': 1,
  'metadata.projectId': 1,
  state: 1,
});
```

- [ ] **Step 4: Run test to verify both pass**

Run: `cd packages/database && pnpm test -- --run session-index`
Expected: Both tests PASS

- [ ] **Step 5: Run full database package tests**

Run: `pnpm build --filter=@abl/database && pnpm test --filter=@abl/database`
Expected: All existing tests still pass

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/database/src/models/arch-session.model.ts packages/arch-ai/src/__tests__/session-index.test.ts
git add packages/database/src/models/arch-session.model.ts packages/arch-ai/src/__tests__/session-index.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] fix(database): per-project session uniqueness for IN_PROJECT mode

The partial unique index now includes metadata.projectId, allowing
users to have separate Arch sessions for different projects while
still enforcing one active session per project.
EOF
)"
```

---

## Task 2: Fix Tenant Isolation in query_traces

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts` (the `query_traces` tool executor)

This is a live security gap — `query_traces` filters by `projectId` but not `tenantId`.

- [ ] **Step 1: Read the current query_traces implementation**

Read `apps/studio/src/app/api/arch-ai/message/route.ts` and locate the `query_traces` tool definition in `buildInProjectTools`. Note the Mongoose query filter.

- [ ] **Step 2: Add tenantId to the trace query filter**

In the `query_traces` execute function, add `tenantId` to the filter:

```typescript
// Before:
const filter: Record<string, unknown> = { projectId };
// After:
const filter: Record<string, unknown> = { projectId, tenantId: ctx.tenantId };
```

- [ ] **Step 3: Add tenantId to read_agent query**

Also verify `read_agent` filters by tenantId. In `buildInProjectTools`, the `read_agent` execute function queries `ProjectAgent`. Ensure the filter includes `tenantId`:

```typescript
const agent = await ProjectAgentModel.findOne({
  projectId,
  tenantId: ctx.tenantId,
  name: input.agentName,
});
```

- [ ] **Step 4: Add tenantId to health_check query**

Same pattern — ensure `health_check` filters by `tenantId`:

```typescript
const agents = await ProjectAgentModel.find({
  projectId,
  tenantId: ctx.tenantId,
});
```

- [ ] **Step 5: Build and verify no type errors**

Run: `pnpm build --filter=@abl/studio`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] fix(studio): add tenantId filter to IN_PROJECT tool queries

query_traces, read_agent, and health_check now filter by tenantId
in addition to projectId, closing a tenant isolation gap.
EOF
)"
```

---

## Task 3: Define AuthContext and Extended ToolExecuteFn

**Files:**

- Create: `packages/arch-ai/src/types/auth-context.ts`
- Modify: `packages/arch-ai/src/executor/specialist-executor.ts`
- Modify: `packages/arch-ai/src/index.ts`

- [ ] **Step 1: Create AuthContext type**

Create `packages/arch-ai/src/types/auth-context.ts`:

```typescript
/**
 * Auth context propagated from HTTP handler through coordinator to tool executors.
 * Tool executors MUST use userAuthToken for all outbound HTTP calls.
 * Tool executors MUST NOT use service-account credentials.
 */
export interface AuthContext {
  /** JWT from the authenticated user — forwarded as Authorization header */
  userAuthToken: string;
  /** Tenant ID from the authenticated session */
  tenantId: string;
  /** User ID from the authenticated session */
  userId: string;
}

/**
 * Extended tool executor function signature with auth context.
 * Replaces the original ToolExecuteFn that only received session.
 */
export type ToolExecuteWithAuthFn = (
  input: Record<string, unknown>,
  session: import('./session').ArchSession,
  authContext: AuthContext,
) => Promise<unknown>;
```

- [ ] **Step 2: Build to verify types compile**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build

- [ ] **Step 3: Update specialist-executor to accept AuthContext**

Read `packages/arch-ai/src/executor/specialist-executor.ts`. Add `authContext` to `ExecutorParams`:

```typescript
import type { AuthContext, ToolExecuteWithAuthFn } from '../types/auth-context';

export interface ExecutorParams {
  specialist: SpecialistId;
  tools: ToolDefinition[];
  toolExecutors: Record<string, ToolExecuteWithAuthFn>;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  session: ArchSession;
  authContext: AuthContext;
  onEvent: SSEEmitter;
  llmClient: LLMStreamClient;
}
```

Update the tool execution call inside `executeSpecialistTurn` to pass `authContext`:

```typescript
// Where tool executor is called:
const result = await executor(toolInput, params.session, params.authContext);
```

- [ ] **Step 4: Export from index**

Add to `packages/arch-ai/src/index.ts`:

```typescript
export type { AuthContext, ToolExecuteWithAuthFn } from './types/auth-context';
```

- [ ] **Step 5: Build and verify**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build (ExecutorParams consumers won't break yet since nobody calls executeSpecialistTurn from the route)

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/arch-ai/src/types/auth-context.ts packages/arch-ai/src/executor/specialist-executor.ts packages/arch-ai/src/index.ts
git add packages/arch-ai/src/types/auth-context.ts packages/arch-ai/src/executor/specialist-executor.ts packages/arch-ai/src/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add AuthContext type and extend ToolExecuteFn

Tool executors now receive AuthContext with the user's JWT token,
tenantId, and userId. This prevents privilege escalation via
service-account credentials.
EOF
)"
```

---

## Task 4: Add IN_PROJECT Specialist IDs and Types

**Files:**

- Create: `packages/arch-ai/src/types/in-project-specialists.ts`
- Create: `packages/arch-ai/src/types/chain-context.ts`
- Modify: `packages/arch-ai/src/types/constants.ts`
- Modify: `packages/arch-ai/src/types/session.ts`
- Modify: `packages/arch-ai/src/index.ts`

- [ ] **Step 1: Add IN_PROJECT specialist IDs to constants**

Read `packages/arch-ai/src/types/constants.ts`. Add the 5 new IDs:

```typescript
export const IN_PROJECT_SPECIALIST_IDS = [
  'project-architect',
  'diagnostician',
  'analyst',
  'quality-engineer',
  'platform-guide',
] as const;

export type InProjectSpecialistId = (typeof IN_PROJECT_SPECIALIST_IDS)[number];

// Extended union — both ONBOARDING and IN_PROJECT specialists
export const ALL_SPECIALIST_IDS = [...SPECIALIST_IDS, ...IN_PROJECT_SPECIALIST_IDS] as const;
export type AnySpecialistId = (typeof ALL_SPECIALIST_IDS)[number];
```

Keep the existing `SPECIALIST_IDS` and `SpecialistId` unchanged for ONBOARDING compatibility.

- [ ] **Step 2: Create in-project-specialists.ts**

Create `packages/arch-ai/src/types/in-project-specialists.ts`:

```typescript
import type { InProjectSpecialistId } from './constants';

export const IN_PROJECT_SPECIALIST_DISPLAY: Record<
  InProjectSpecialistId,
  { label: string; icon: string }
> = {
  'project-architect': { label: 'Project Architect', icon: '🏗️' },
  diagnostician: { label: 'Diagnostician', icon: '🔍' },
  analyst: { label: 'Analyst', icon: '📊' },
  'quality-engineer': { label: 'Quality Engineer', icon: '🧪' },
  'platform-guide': { label: 'Platform Guide', icon: '📖' },
};
```

- [ ] **Step 3: Create chain-context.ts**

Create `packages/arch-ai/src/types/chain-context.ts`:

```typescript
import type { InProjectSpecialistId } from './constants';

export interface Finding {
  type: 'error' | 'warning' | 'info';
  summary: string;
  agentName?: string;
  metric?: { name: string; value: number; threshold?: number };
}

export interface RecommendedAction {
  type: 'modify_agent' | 'modify_topology' | 'create_guardrail' | 'configure' | string;
  target: string;
  description: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
}

/**
 * Typed context passed between chained specialists.
 * Prevents the second specialist from receiving ambiguous prose.
 */
export interface ChainContext {
  sourceSpecialist: InProjectSpecialistId;
  findings: Finding[];
  recommendedActions: RecommendedAction[];
  suggestedToolNames?: string[];
  rawEvidence?: unknown;
}
```

- [ ] **Step 4: Extend SessionMetadata**

Read `packages/arch-ai/src/types/session.ts`. Add new optional fields to `SessionMetadata`:

```typescript
export interface SessionMetadata {
  // ... existing fields ...

  /** IN_PROJECT: currently active specialist */
  activeSpecialist?: string;
  /** IN_PROJECT: pending mutation awaiting approval */
  pendingMutation?: {
    tool: string;
    target: string;
    scope: 'SMALL' | 'MEDIUM' | 'LARGE';
    before?: unknown;
    after?: unknown;
  };
}
```

- [ ] **Step 5: Export from index**

Add to `packages/arch-ai/src/index.ts`:

```typescript
export type { InProjectSpecialistId, AnySpecialistId } from './types/constants';
export { IN_PROJECT_SPECIALIST_IDS, ALL_SPECIALIST_IDS } from './types/constants';
export { IN_PROJECT_SPECIALIST_DISPLAY } from './types/in-project-specialists';
export type { ChainContext, Finding, RecommendedAction } from './types/chain-context';
```

- [ ] **Step 6: Build and verify**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/arch-ai/src/types/constants.ts packages/arch-ai/src/types/in-project-specialists.ts packages/arch-ai/src/types/chain-context.ts packages/arch-ai/src/types/session.ts packages/arch-ai/src/index.ts
git add packages/arch-ai/src/types/constants.ts packages/arch-ai/src/types/in-project-specialists.ts packages/arch-ai/src/types/chain-context.ts packages/arch-ai/src/types/session.ts packages/arch-ai/src/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add IN_PROJECT specialist IDs, ChainContext, session metadata

Additive extension: 5 new specialist IDs coexist with 9 existing
ONBOARDING IDs. ChainContext provides typed interface for specialist
chaining. SessionMetadata gains activeSpecialist and pendingMutation
fields for IN_PROJECT mode.
EOF
)"
```

---

## Task 5: Build Tool Input Validator

**Files:**

- Create: `packages/arch-ai/src/executor/tool-validator.ts`
- Create: `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`

- [ ] **Step 1: Create tool input Zod schemas**

Create `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`:

```typescript
import { z } from 'zod';

export const toolInputSchemas: Record<string, z.ZodSchema> = {
  read_agent: z.object({
    agentName: z.string().min(1, 'agentName is required'),
  }),

  query_traces: z.object({
    agentName: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),

  health_check: z.object({}),

  compile_abl: z.object({
    dsl: z.string().min(1, 'dsl content is required'),
  }),

  generate_agent: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    persona: z.string().optional(),
  }),

  propose_modification: z.object({
    agentName: z.string().min(1),
    modification: z.string().min(1, 'modification description is required'),
  }),

  run_test: z.object({
    agentName: z.string().min(1),
    testMessage: z.string().min(1),
    expectedBehavior: z.string().optional(),
  }),

  ask_user: z.object({
    question: z.string().min(1),
    options: z.array(z.string()).optional(),
  }),

  collect_file: z.object({
    prompt: z.string().min(1),
    accept: z.string().optional(),
  }),
};
```

- [ ] **Step 2: Create tool validator**

Create `packages/arch-ai/src/executor/tool-validator.ts`:

```typescript
import { z } from 'zod';
import { toolInputSchemas } from '../tools/schemas/in-project-schemas';

export interface ValidationResult {
  valid: boolean;
  input: Record<string, unknown>;
  errors?: string[];
}

/**
 * Validates tool call inputs against Zod schemas.
 * Returns sanitized input on success, error details on failure.
 */
export function validateToolInput(
  toolName: string,
  rawInput: Record<string, unknown>,
): ValidationResult {
  const schema = toolInputSchemas[toolName];

  if (!schema) {
    // No schema registered — pass through (forward compatible with new tools)
    return { valid: true, input: rawInput };
  }

  const result = schema.safeParse(rawInput);

  if (result.success) {
    return { valid: true, input: result.data as Record<string, unknown> };
  }

  const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  return { valid: false, input: rawInput, errors };
}
```

- [ ] **Step 3: Write test for validator**

Create `packages/arch-ai/src/__tests__/tool-validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateToolInput } from '../executor/tool-validator';

describe('validateToolInput', () => {
  it('passes valid read_agent input', () => {
    const result = validateToolInput('read_agent', { agentName: 'triage' });
    expect(result.valid).toBe(true);
    expect(result.input).toEqual({ agentName: 'triage' });
  });

  it('rejects empty agentName for read_agent', () => {
    const result = validateToolInput('read_agent', { agentName: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toContain('agentName');
  });

  it('applies defaults for query_traces limit', () => {
    const result = validateToolInput('query_traces', {});
    expect(result.valid).toBe(true);
    expect(result.input).toEqual({ limit: 20 });
  });

  it('rejects query_traces limit > 100', () => {
    const result = validateToolInput('query_traces', { limit: 500 });
    expect(result.valid).toBe(false);
  });

  it('passes through unknown tool names (forward compatible)', () => {
    const result = validateToolInput('future_tool', { anything: true });
    expect(result.valid).toBe(true);
    expect(result.input).toEqual({ anything: true });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/arch-ai && pnpm test -- --run tool-validator`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/arch-ai/src/executor/tool-validator.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts packages/arch-ai/src/__tests__/tool-validator.test.ts
git add packages/arch-ai/src/executor/tool-validator.ts packages/arch-ai/src/tools/schemas/in-project-schemas.ts packages/arch-ai/src/__tests__/tool-validator.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add Zod tool input validation for IN_PROJECT tools

Each tool has a Zod schema validating LLM-generated arguments before
execution. Unknown tools pass through for forward compatibility.
Addresses DEFERRED.md item #13.
EOF
)"
```

---

## Task 6: Build Executor Guards (Timeout, Stall, Loop Detection)

**Files:**

- Create: `packages/arch-ai/src/executor/executor-guards.ts`

- [ ] **Step 1: Create executor guards module**

Create `packages/arch-ai/src/executor/executor-guards.ts`:

```typescript
import { LoopDetector } from '../coordinator/loop-detection';

export interface ExecutorGuardConfig {
  /** Max time to wait for first token from LLM (ms). Default: 10000 */
  ttftTimeoutMs: number;
  /** Max time with no output before declaring stall (ms). Default: 15000 */
  stallTimeoutMs: number;
  /** Max total time for one specialist turn (ms). Default: 120000 */
  turnTimeoutMs: number;
  /** Max LLM re-invocations per turn (tool call → result → re-invoke). Default: 10 */
  maxTurns: number;
  /** Max time for a single tool execution (ms). Default: 30000 */
  toolTimeoutMs: number;
}

export const DEFAULT_GUARD_CONFIG: ExecutorGuardConfig = {
  ttftTimeoutMs: 10_000,
  stallTimeoutMs: 15_000,
  turnTimeoutMs: 120_000,
  maxTurns: 10,
  toolTimeoutMs: 30_000,
};

export class ExecutorGuards {
  private turnStart = 0;
  private lastActivity = 0;
  private firstTokenReceived = false;
  private turnCount = 0;
  private readonly loopDetector: LoopDetector;
  private readonly config: ExecutorGuardConfig;

  constructor(config: Partial<ExecutorGuardConfig> = {}) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
    this.loopDetector = new LoopDetector();
  }

  /** Call at start of specialist turn */
  startTurn(): void {
    this.turnStart = Date.now();
    this.lastActivity = Date.now();
    this.firstTokenReceived = false;
    this.turnCount = 0;
    this.loopDetector.reset();
  }

  /** Call when any output is received from LLM */
  onActivity(): void {
    this.lastActivity = Date.now();
    this.firstTokenReceived = true;
  }

  /** Call before each LLM re-invocation. Returns error string if guard tripped. */
  checkReInvocation(): string | null {
    this.turnCount++;

    if (this.turnCount > this.config.maxTurns) {
      return `Max turns exceeded (${this.config.maxTurns}). Stopping to prevent runaway loop.`;
    }

    const elapsed = Date.now() - this.turnStart;
    if (elapsed > this.config.turnTimeoutMs) {
      return `Turn timeout exceeded (${this.config.turnTimeoutMs}ms). Stopping.`;
    }

    return null;
  }

  /** Call before executing a tool. Returns error string if loop detected. */
  checkToolCall(
    specialist: string,
    toolName: string,
    input: Record<string, unknown>,
  ): string | null {
    const isLoop = this.loopDetector.check(specialist, toolName, input);
    if (isLoop) {
      return `Loop detected: ${toolName} called ${3} times with same input. Stopping.`;
    }
    return null;
  }

  /** Check for TTFT timeout (call periodically before first token) */
  checkTTFT(): string | null {
    if (this.firstTokenReceived) return null;

    const elapsed = Date.now() - this.turnStart;
    if (elapsed > this.config.ttftTimeoutMs) {
      return `No response from LLM within ${this.config.ttftTimeoutMs}ms (TTFT timeout).`;
    }
    return null;
  }

  /** Check for stall (call periodically after first token) */
  checkStall(): string | null {
    if (!this.firstTokenReceived) return null;

    const sinceLast = Date.now() - this.lastActivity;
    if (sinceLast > this.config.stallTimeoutMs) {
      return `No output for ${this.config.stallTimeoutMs}ms (stall detected).`;
    }
    return null;
  }

  /** Wrap a tool execution with timeout */
  async executeWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.toolTimeoutMs);

    try {
      const result = await fn();
      return result;
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(`Tool execution timeout: ${label} exceeded ${this.config.toolTimeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 2: Write tests**

Create `packages/arch-ai/src/__tests__/executor-guards.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ExecutorGuards } from '../executor/executor-guards';

describe('ExecutorGuards', () => {
  it('allows re-invocation within limits', () => {
    const guards = new ExecutorGuards({ maxTurns: 3 });
    guards.startTurn();
    expect(guards.checkReInvocation()).toBeNull();
    expect(guards.checkReInvocation()).toBeNull();
    expect(guards.checkReInvocation()).toBeNull();
  });

  it('blocks re-invocation beyond maxTurns', () => {
    const guards = new ExecutorGuards({ maxTurns: 2 });
    guards.startTurn();
    guards.checkReInvocation();
    guards.checkReInvocation();
    const result = guards.checkReInvocation();
    expect(result).toContain('Max turns exceeded');
  });

  it('detects loop on 3rd identical tool call', () => {
    const guards = new ExecutorGuards();
    guards.startTurn();
    expect(guards.checkToolCall('analyst', 'query_sessions', { limit: 10 })).toBeNull();
    expect(guards.checkToolCall('analyst', 'query_sessions', { limit: 10 })).toBeNull();
    const result = guards.checkToolCall('analyst', 'query_sessions', { limit: 10 });
    expect(result).toContain('Loop detected');
  });

  it('does not detect loop for different inputs', () => {
    const guards = new ExecutorGuards();
    guards.startTurn();
    expect(guards.checkToolCall('analyst', 'query_sessions', { limit: 10 })).toBeNull();
    expect(guards.checkToolCall('analyst', 'query_sessions', { limit: 20 })).toBeNull();
    expect(guards.checkToolCall('analyst', 'query_sessions', { limit: 30 })).toBeNull();
  });

  it('detects TTFT timeout', () => {
    const guards = new ExecutorGuards({ ttftTimeoutMs: 0 });
    guards.startTurn();
    const result = guards.checkTTFT();
    expect(result).toContain('TTFT timeout');
  });

  it('does not report TTFT after first token', () => {
    const guards = new ExecutorGuards({ ttftTimeoutMs: 0 });
    guards.startTurn();
    guards.onActivity();
    expect(guards.checkTTFT()).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd packages/arch-ai && pnpm test -- --run executor-guards`
Expected: All 6 tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/executor/executor-guards.ts packages/arch-ai/src/__tests__/executor-guards.test.ts
git add packages/arch-ai/src/executor/executor-guards.ts packages/arch-ai/src/__tests__/executor-guards.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add executor guards — timeout, stall, loop detection

ExecutorGuards wraps specialist turns with TTFT timeout (10s),
stall detection (15s), turn timeout (120s), max re-invocations (10),
tool execution timeout (30s), and loop detection (3 identical calls).
Addresses DEFERRED.md item #14.
EOF
)"
```

---

## Task 7: Build Multi-Turn Executor

**Files:**

- Create: `packages/arch-ai/src/executor/multi-turn-executor.ts`

This is the core of Phase 0 — the wrapper that makes `executeSpecialistTurn` do multi-turn tool loops.

- [ ] **Step 1: Create multi-turn executor**

Create `packages/arch-ai/src/executor/multi-turn-executor.ts`:

```typescript
import { executeSpecialistTurn, type ExecutorParams, type SSEEmitter } from './specialist-executor';
import { ExecutorGuards, type ExecutorGuardConfig } from './executor-guards';
import { validateToolInput } from './tool-validator';
import type { AuthContext } from '../types/auth-context';
import type { ArchSSEEvent } from '../types/sse-events';

export interface MultiTurnParams extends Omit<ExecutorParams, 'messages'> {
  /** Full conversation history — executor manages tool result injection */
  messages: Array<{ role: string; content: string; toolCallId?: string; toolName?: string }>;
  /** Guard configuration overrides */
  guardConfig?: Partial<ExecutorGuardConfig>;
}

export interface MultiTurnResult {
  status: 'completed' | 'awaiting_tool_result' | 'error' | 'guard_tripped';
  /** Final messages array including all tool results */
  messages: Array<{ role: string; content: string; toolCallId?: string; toolName?: string }>;
  /** Number of LLM invocations in this turn */
  turnCount: number;
  /** If guard_tripped, the reason */
  guardReason?: string;
  /** If awaiting_tool_result, the tool call ID */
  toolCallId?: string;
}

/**
 * Multi-turn executor: wraps executeSpecialistTurn with re-invocation loop.
 *
 * Flow:
 * 1. Call LLM with current messages
 * 2. If LLM calls a server-side tool:
 *    a. Validate input (Zod)
 *    b. Check guards (loop, timeout, max turns)
 *    c. Execute tool
 *    d. Append tool result as message
 *    e. Re-invoke LLM (go to 1)
 * 3. If LLM calls a client-side tool (ask_user, collect_file):
 *    a. Return awaiting_tool_result (client will resume later)
 * 4. If LLM finishes without tool call:
 *    a. Return completed
 */
export async function executeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
  const guards = new ExecutorGuards(params.guardConfig);
  guards.startTurn();

  let currentMessages = [...params.messages];
  let turnCount = 0;

  while (true) {
    // Check re-invocation guard
    const guardError = guards.checkReInvocation();
    if (guardError) {
      params.onEvent({
        type: 'error',
        code: 'GUARD_TRIPPED',
        message: guardError,
        retryable: false,
      });
      return {
        status: 'guard_tripped',
        messages: currentMessages,
        turnCount,
        guardReason: guardError,
      };
    }

    turnCount++;

    // Call the single-turn executor
    const result = await executeSpecialistTurn({
      ...params,
      messages: currentMessages,
    });

    if (result.status === 'completed') {
      return { status: 'completed', messages: currentMessages, turnCount };
    }

    if (result.status === 'awaiting_tool_result') {
      // Client-side tool — return and wait for resume
      return {
        status: 'awaiting_tool_result',
        messages: currentMessages,
        turnCount,
        toolCallId: result.toolCallId,
      };
    }

    if (result.status === 'tool_executed') {
      // Server-side tool was executed — result is in result.toolResult
      // Append tool result as a message and re-invoke
      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: '',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        },
        {
          role: 'tool',
          content:
            typeof result.toolResult === 'string'
              ? result.toolResult
              : JSON.stringify(result.toolResult),
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        },
      ];
      // Continue loop — will re-invoke LLM
      continue;
    }

    if (result.status === 'error') {
      return { status: 'error', messages: currentMessages, turnCount };
    }

    // Unexpected status — break to prevent infinite loop
    return { status: 'error', messages: currentMessages, turnCount };
  }
}
```

**Note:** This assumes `executeSpecialistTurn` returns a `status: 'tool_executed'` variant with `toolResult`, `toolCallId`, and `toolName`. The existing executor already handles server-side tool execution — we need to ensure it returns the result rather than just emitting SSE. The exact integration depends on reading the current executor's return type. If `ExecutionResult` doesn't have a `tool_executed` status, we'll need to add it in the next step.

- [ ] **Step 2: Verify ExecutionResult type and extend if needed**

Read `specialist-executor.ts` to check the current `ExecutionResult` type. If it doesn't include `tool_executed`, extend it:

```typescript
export type ExecutionResult =
  | { status: 'completed' }
  | { status: 'awaiting_tool_result'; toolCallId: string }
  | { status: 'tool_executed'; toolCallId: string; toolName: string; toolResult: unknown }
  | { status: 'error'; error: string };
```

Update the server-side tool execution branch in `executeSpecialistTurn` to return the tool result instead of only emitting SSE.

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/executor/multi-turn-executor.ts packages/arch-ai/src/executor/specialist-executor.ts
git add packages/arch-ai/src/executor/multi-turn-executor.ts packages/arch-ai/src/executor/specialist-executor.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): multi-turn executor with re-invocation loop

Wraps executeSpecialistTurn with a loop: LLM calls tool → execute →
inject result as message → re-invoke LLM. Guards enforce max 10
re-invocations, 120s total timeout, loop detection. Client-side
tools (ask_user, collect_file) break the loop for resume.
Addresses DEFERRED.md item #11.
EOF
)"
```

---

## Task 8: Wire Multi-Turn Executor to Route (IN_PROJECT only)

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts`

This is the most critical and risky task — connecting the new executor to the live route without breaking ONBOARDING.

- [ ] **Step 1: Read the route's IN_PROJECT handling section**

Read `apps/studio/src/app/api/arch-ai/message/route.ts`. Locate where `isInProject` is checked and how it currently routes to `processMessage`. Understand the `createSSEStream` pattern used for streaming.

- [ ] **Step 2: Add conditional routing**

At the point where `isInProject` is detected, instead of falling through to the existing `streamText` path, call the multi-turn executor:

```typescript
import { executeMultiTurn } from '@agent-platform/arch-ai/executor/multi-turn-executor';
import type { AuthContext } from '@agent-platform/arch-ai/types/auth-context';

// Inside the POST handler, after session is loaded:
if (session.metadata.mode === 'IN_PROJECT') {
  // Extract auth context from the request
  const authContext: AuthContext = {
    userAuthToken: auth.token, // from requireAuth
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  };

  // Route to multi-turn executor
  const specialist = routeByContent(msg.userMessage);
  const systemPrompt = composeInProjectPrompt(specialist);
  const tools = getToolsForInProject(allToolDefinitions);
  const toolExecutors = buildInProjectToolExecutors(ctx, session, authContext);

  const result = await executeMultiTurn({
    specialist,
    tools,
    toolExecutors,
    systemPrompt,
    messages: session.metadata.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    session,
    authContext,
    onEvent: emit,
    llmClient: createLLMStreamClient(), // adapter for the LLM provider
  });

  // Handle result
  if (result.status === 'awaiting_tool_result') {
    await sessionService.setPendingInteraction(ctx, session.id, {
      kind: 'widget',
      id: result.toolCallId!,
      payload: null,
      createdAt: new Date().toISOString(),
    });
  }

  emit({ type: 'done', suggestions: [] });
  close();
  return;
}

// ONBOARDING mode — existing processMessage path (unchanged)
await processMessage(ctx, session, msg, emit, close);
```

- [ ] **Step 3: Create LLMStreamClient adapter**

The existing route uses Vercel AI SDK's `streamText`. The `executeSpecialistTurn` expects an `LLMStreamClient` interface. Create an adapter:

```typescript
function createLLMStreamClient(): LLMStreamClient {
  return {
    async *streamChat(params) {
      const { textStream } = await streamText({
        model: getModel(),
        system: params.systemPrompt,
        messages: params.messages.map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
        tools: convertToVercelTools(params.tools),
      });

      for await (const chunk of textStream) {
        yield { type: 'text_delta' as const, delta: chunk };
      }
      yield { type: 'response_end' as const };
    },
  };
}
```

**Note:** This adapter is simplified. The actual implementation needs to handle tool calls from the Vercel AI SDK stream, converting them to `LLMStreamChunk` tool_call events. Read the existing `streamText` usage in the route to understand the exact stream format and adapt accordingly.

- [ ] **Step 4: Build and test manually**

Run: `pnpm build --filter=@abl/studio`
Expected: Clean build

Test manually: Start Studio, open Arch overlay for an existing project, send "how many agents do I have?" → should route to IN_PROJECT path and get a response via the multi-turn executor.

- [ ] **Step 5: Verify ONBOARDING still works**

Test: Start a new project creation flow (ONBOARDING). Send messages through INTERVIEW, BLUEPRINT, BUILD phases. Verify the existing `processMessage` path still handles everything correctly.

- [ ] **Step 6: Commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(studio): wire multi-turn executor for IN_PROJECT mode

Conditional routing: IN_PROJECT uses the new multi-turn executor with
auth propagation, tool validation, and guards. ONBOARDING continues
using the existing processMessage path — zero changes to the working
creation flow.
EOF
)"
```

---

## Task 9: Build IN_PROJECT Approval Classifier

**Files:**

- Create: `packages/arch-ai/src/classifier/in-project-approval.ts`
- Create: `packages/arch-ai/src/__tests__/in-project-approval.test.ts`

- [ ] **Step 1: Create the 3-tier classifier**

Create `packages/arch-ai/src/classifier/in-project-approval.ts`:

```typescript
export type InProjectApprovalTier = 'SMALL' | 'MEDIUM' | 'LARGE';

interface ApprovalRule {
  pattern: RegExp;
  tier: InProjectApprovalTier;
}

/**
 * Policy tables per mutation family.
 * This is a NEW classifier — does NOT extend the BUILD-phase scope-classifier.ts.
 * The BUILD-phase classifier decides backtracking; this decides user approval tier.
 */
const AGENT_RULES: ApprovalRule[] = [
  // LARGE — structural changes
  { pattern: /topology redesign|restructure|rearchitect|split agent|merge agents/i, tier: 'LARGE' },
  { pattern: /delete agent|remove agent/i, tier: 'LARGE' },

  // MEDIUM — significant but bounded changes
  {
    pattern: /add (a |new )?agent|create (a |new )?agent|generate (a |new )?agent/i,
    tier: 'MEDIUM',
  },
  { pattern: /add handoff|remove handoff|modify topology/i, tier: 'MEDIUM' },
  { pattern: /change model|set model|configure model|switch model/i, tier: 'MEDIUM' },
  { pattern: /promote version|rollback version/i, tier: 'MEDIUM' },
  { pattern: /set entry agent|change entry/i, tier: 'MEDIUM' },

  // SMALL — single-field or low-risk changes
  { pattern: /change persona|update persona/i, tier: 'SMALL' },
  { pattern: /add tool|remove tool/i, tier: 'SMALL' },
  { pattern: /change constraint|add constraint/i, tier: 'SMALL' },
  { pattern: /fix|tweak|adjust|rename/i, tier: 'SMALL' },
];

const TOOL_RULES: ApprovalRule[] = [
  { pattern: /create (a |new )?tool|build (a |new )?tool/i, tier: 'MEDIUM' },
  { pattern: /connect mcp|connect search/i, tier: 'MEDIUM' },
  { pattern: /bind auth|link auth/i, tier: 'SMALL' },
  { pattern: /modify tool|update tool/i, tier: 'SMALL' },
  { pattern: /manage variable|set variable/i, tier: 'SMALL' },
];

const GUARDRAIL_RULES: ApprovalRule[] = [
  { pattern: /create guardrail|new guardrail/i, tier: 'MEDIUM' },
  { pattern: /design constitution/i, tier: 'MEDIUM' },
  { pattern: /budget control|set budget|spending limit/i, tier: 'MEDIUM' },
  { pattern: /configure rule|modify guardrail/i, tier: 'SMALL' },
  { pattern: /pii redaction|toggle redaction/i, tier: 'SMALL' },
];

const DEPLOYMENT_RULES: ApprovalRule[] = [
  { pattern: /rollback/i, tier: 'LARGE' },
  { pattern: /provision voice|phone number|sip gateway/i, tier: 'LARGE' },
  { pattern: /create deployment|deploy to|promote deployment/i, tier: 'MEDIUM' },
  { pattern: /setup channel|configure channel/i, tier: 'MEDIUM' },
  { pattern: /environment variable|env var|manage secret/i, tier: 'SMALL' },
  { pattern: /pin version|link channel/i, tier: 'SMALL' },
];

const CONFIG_RULES: ApprovalRule[] = [
  { pattern: /manage knowledge|create knowledge/i, tier: 'MEDIUM' },
  { pattern: /manage connector/i, tier: 'MEDIUM' },
  { pattern: /manage workflow|create workflow/i, tier: 'MEDIUM' },
  { pattern: /configure llm|set (model )?tier/i, tier: 'SMALL' },
  { pattern: /configure thinking|thinking budget/i, tier: 'SMALL' },
  { pattern: /configure extraction|configure pipeline|configure intent/i, tier: 'SMALL' },
  { pattern: /manage lookup|lookup table/i, tier: 'SMALL' },
];

const ALL_RULES = [
  ...AGENT_RULES,
  ...TOOL_RULES,
  ...GUARDRAIL_RULES,
  ...DEPLOYMENT_RULES,
  ...CONFIG_RULES,
];

/**
 * Classify a mutation request into SMALL / MEDIUM / LARGE approval tier.
 * Returns MEDIUM as default if no pattern matches (safe default).
 */
export function classifyApprovalTier(userMessage: string): InProjectApprovalTier {
  for (const rule of ALL_RULES) {
    if (rule.pattern.test(userMessage)) {
      return rule.tier;
    }
  }
  // Default: MEDIUM (require confirmation for unknown mutations)
  return 'MEDIUM';
}

/**
 * Classify by tool name (used when the LLM has already selected a tool).
 */
export function classifyToolApprovalTier(toolName: string): InProjectApprovalTier {
  const TOOL_TIERS: Record<string, InProjectApprovalTier> = {
    // LARGE
    rollback_deployment: 'LARGE',
    provision_voice: 'LARGE',

    // MEDIUM
    modify_agent: 'MEDIUM',
    generate_agent: 'MEDIUM',
    modify_topology: 'MEDIUM',
    set_entry_agent: 'MEDIUM',
    promote_version: 'MEDIUM',
    configure_model: 'MEDIUM',
    create_tool: 'MEDIUM',
    connect_mcp_tool: 'MEDIUM',
    connect_search_tool: 'MEDIUM',
    create_guardrail: 'MEDIUM',
    design_constitution: 'MEDIUM',
    set_budget_controls: 'MEDIUM',
    create_deployment: 'MEDIUM',
    promote_deployment: 'MEDIUM',
    setup_channel: 'MEDIUM',
    manage_knowledge_base: 'MEDIUM',
    manage_kb_connectors: 'MEDIUM',
    manage_workflow: 'MEDIUM',

    // SMALL
    build_http_tool: 'SMALL',
    modify_tool: 'SMALL',
    bind_tool_auth: 'SMALL',
    manage_tool_variables: 'SMALL',
    configure_guardrail_rules: 'SMALL',
    configure_pii_redaction: 'SMALL',
    manage_env_vars: 'SMALL',
    pin_versions: 'SMALL',
    link_channel_deployment: 'SMALL',
    manage_lookup_tables: 'SMALL',
    configure_llm_tiers: 'SMALL',
    configure_thinking: 'SMALL',
    configure_extraction: 'SMALL',
    configure_pipeline: 'SMALL',
    configure_multi_intent: 'SMALL',
    define_custom_metrics: 'SMALL',
  };

  return TOOL_TIERS[toolName] ?? 'MEDIUM';
}
```

- [ ] **Step 2: Write tests**

Create `packages/arch-ai/src/__tests__/in-project-approval.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyApprovalTier, classifyToolApprovalTier } from '../classifier/in-project-approval';

describe('classifyApprovalTier', () => {
  it('classifies topology redesign as LARGE', () => {
    expect(classifyApprovalTier('I need to restructure my agent topology')).toBe('LARGE');
  });

  it('classifies rollback as LARGE', () => {
    expect(classifyApprovalTier('rollback the last deployment')).toBe('LARGE');
  });

  it('classifies add agent as MEDIUM', () => {
    expect(classifyApprovalTier('add a new agent for billing')).toBe('MEDIUM');
  });

  it('classifies change model as MEDIUM', () => {
    expect(classifyApprovalTier('change the model for Agent B')).toBe('MEDIUM');
  });

  it('classifies add tool as SMALL', () => {
    expect(classifyApprovalTier('add the Salesforce tool to Agent A')).toBe('SMALL');
  });

  it('classifies fix as SMALL', () => {
    expect(classifyApprovalTier('fix the prompt in Agent B')).toBe('SMALL');
  });

  it('defaults to MEDIUM for unknown mutations', () => {
    expect(classifyApprovalTier('do something unusual')).toBe('MEDIUM');
  });
});

describe('classifyToolApprovalTier', () => {
  it('maps provision_voice to LARGE', () => {
    expect(classifyToolApprovalTier('provision_voice')).toBe('LARGE');
  });

  it('maps modify_agent to MEDIUM', () => {
    expect(classifyToolApprovalTier('modify_agent')).toBe('MEDIUM');
  });

  it('maps configure_llm_tiers to SMALL', () => {
    expect(classifyToolApprovalTier('configure_llm_tiers')).toBe('SMALL');
  });

  it('defaults to MEDIUM for unknown tools', () => {
    expect(classifyToolApprovalTier('future_tool')).toBe('MEDIUM');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd packages/arch-ai && pnpm test -- --run in-project-approval`
Expected: All 11 tests PASS

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/arch-ai/src/classifier/in-project-approval.ts packages/arch-ai/src/__tests__/in-project-approval.test.ts
git add packages/arch-ai/src/classifier/in-project-approval.ts packages/arch-ai/src/__tests__/in-project-approval.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): new IN_PROJECT 3-tier approval classifier

Separate from the BUILD-phase scope classifier. Classifies mutations
as SMALL (auto-apply), MEDIUM (confirm), or LARGE (diff review).
Policy tables per mutation family: agents, tools, guardrails,
deployment, config. Defaults to MEDIUM for safety.
EOF
)"
```

---

## Task 10: Prototype A — End-to-End Verification

This is the gating prototype: LLM calls `health_check` → executor runs → result fed back → LLM generates insight text → SSE streamed to client.

- [ ] **Step 1: Start Studio in dev mode**

Run: `cd apps/studio && pnpm dev`
Ensure Runtime is running on port 3112.

- [ ] **Step 2: Open Arch overlay for an existing project**

Navigate to a project page. Open the Arch overlay.

- [ ] **Step 3: Send a test message**

Type: "How many agents do I have? Are they all healthy?"

- [ ] **Step 4: Verify multi-turn execution**

Expected behavior:

1. Message routes to IN_PROJECT path (not processMessage)
2. Coordinator routes to a specialist
3. LLM calls `health_check` tool
4. Executor runs the tool, gets agent list
5. Tool result is fed back to LLM
6. LLM generates a natural language response about the agents
7. Response streams to client via SSE

- [ ] **Step 5: Verify ONBOARDING still works**

Navigate to the Arch project creation flow. Send "I want to build a customer support bot." Verify the INTERVIEW phase works as before.

- [ ] **Step 6: Document results**

Write results to `docs/testing/arch-in-project-phase-0a-prototype-a.md`:

```markdown
# Phase 0a Prototype A — Multi-Turn Executor E2E

**Date:** YYYY-MM-DD
**Status:** PASS / FAIL

## Test: IN_PROJECT multi-turn tool execution

- Message sent: "How many agents do I have? Are they all healthy?"
- Tool called: health_check
- Tool result fed back: YES / NO
- LLM generated response: YES / NO
- SSE streamed to client: YES / NO

## Test: ONBOARDING regression

- INTERVIEW phase: PASS / FAIL
- Tool calls work: PASS / FAIL
```

---

## Summary

| Task | Description                                   | Risk                                 |
| ---- | --------------------------------------------- | ------------------------------------ |
| 1    | Fix session index for per-project isolation   | Low                                  |
| 2    | Fix tenant isolation in query_traces          | Low                                  |
| 3    | Define AuthContext and extended ToolExecuteFn | Low                                  |
| 4    | Add IN_PROJECT specialist IDs and types       | Low                                  |
| 5    | Build tool input validator (Zod)              | Low                                  |
| 6    | Build executor guards (timeout, stall, loop)  | Low                                  |
| 7    | Build multi-turn executor                     | Medium                               |
| 8    | Wire multi-turn executor to route             | **High** — must not break ONBOARDING |
| 9    | Build IN_PROJECT approval classifier          | Low                                  |
| 10   | Prototype A — end-to-end verification         | Verification                         |

**Critical path:** Tasks 1-6 are independent and can be parallelized. Task 7 depends on Task 3 (AuthContext) and Task 6 (guards). Task 8 depends on Task 7 and is the riskiest step. Task 9 is independent. Task 10 verifies everything.
