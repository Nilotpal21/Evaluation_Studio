# Bruce Wilcox P0/P1 Feedback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 4 security and migration-critical fixes from Bruce Wilcox's review: post-guardrail re-validation, tool confirmation immutability, PII guard field-type awareness, and custom regex extractors for GATHER.

**Architecture:** Each item is independent with no cross-dependencies. All changes touch the compiler IR schema (`packages/compiler`) and/or the runtime executor (`apps/runtime`). TDD approach with vitest. XO migration compatibility is a design constraint for PII and GATHER items.

**Tech Stack:** TypeScript, Vitest, `packages/compiler` (IR schema, PII detector, NLU, gather executor), `apps/runtime` (reasoning executor)

**Design Doc:** `docs/plans/2026-03-08-bruce-feedback-p0-p1-design.md`

---

## Task 1: Post-Guardrail Parameter Re-validation (P1)

The smallest fix. When guardrails modify tool call parameters (redact/fix actions), the modified params skip `validateToolInputs()`. This means a guardrail could redact a required field to `[REDACTED]` and the tool would execute with broken input.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:560` — export `validateToolInputs`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:1388-1401` — add re-validation after guardrail modification
- Test: `apps/runtime/src/__tests__/post-guardrail-revalidation.test.ts`

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/post-guardrail-revalidation.test.ts`:

```typescript
/**
 * Post-Guardrail Parameter Re-validation Tests
 *
 * Verifies that tool parameters are re-validated after guardrail modification,
 * catching cases where guardrail redaction breaks required fields or type constraints.
 */
import { describe, test, expect } from 'vitest';
import { validateToolInputs } from '@abl/compiler/platform/constructs/executors/tool-binding-executor.js';
import type { ToolParameter } from '@abl/compiler';

describe('Post-Guardrail Re-validation', () => {
  const schema: ToolParameter[] = [
    { name: 'order_id', type: 'string', required: true },
    { name: 'email', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true },
    {
      name: 'status',
      type: 'string',
      required: false,
      enum: ['pending', 'confirmed', 'cancelled'],
    },
  ];

  test('passes when guardrail leaves valid params unchanged', () => {
    const params = { order_id: 'ORD-123', email: 'user@test.com', amount: 49.99 };
    expect(() => validateToolInputs('process_order', params, schema)).not.toThrow();
  });

  test('throws when guardrail redacts a required string field', () => {
    const params = { order_id: 'ORD-123', email: null, amount: 49.99 };
    expect(() => validateToolInputs('process_order', params, schema)).toThrow(
      /missing required parameter 'email'/,
    );
  });

  test('throws when guardrail removes a required field entirely', () => {
    const params = { order_id: 'ORD-123', amount: 49.99 };
    expect(() => validateToolInputs('process_order', params, schema)).toThrow(
      /missing required parameter 'email'/,
    );
  });

  test('throws when guardrail modifies enum to invalid value', () => {
    const params = {
      order_id: 'ORD-123',
      email: 'user@test.com',
      amount: 49.99,
      status: '[REDACTED]',
    };
    expect(() => validateToolInputs('process_order', params, schema)).toThrow(
      /not in allowed values/,
    );
  });

  test('throws when guardrail changes number to string', () => {
    const params = { order_id: 'ORD-123', email: 'user@test.com', amount: '[REDACTED]' };
    expect(() => validateToolInputs('process_order', params, schema)).toThrow(
      /expected type 'number'/,
    );
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/post-guardrail-revalidation.test.ts
```

Expected: FAIL — `validateToolInputs` is not exported from `@abl/compiler`.

### Step 3: Export validateToolInputs from tool-binding-executor

In `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`, change line 560 from:

```typescript
function validateToolInputs(
```

to:

```typescript
export function validateToolInputs(
```

Then add the export to the compiler's barrel exports. Check `packages/compiler/src/platform/index.ts` or the main `index.ts` for the existing export pattern and add `validateToolInputs` alongside other executor exports.

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/post-guardrail-revalidation.test.ts
```

Expected: PASS — all 5 tests green.

### Step 5: Wire re-validation into reasoning-executor

In `apps/runtime/src/services/execution/reasoning-executor.ts`, find the guardrail modification block (search for `guardrailResult.modifiedContent`). After the `toolCall = { ...toolCall, input: JSON.parse(guardrailResult.modifiedContent) }` block, add re-validation:

```typescript
// If guardrail redacted/modified the content, use modified parameters
if (guardrailResult.modifiedContent) {
  try {
    toolCall = {
      ...toolCall,
      input: JSON.parse(guardrailResult.modifiedContent),
    };

    // Re-validate modified params — guardrail redaction can break type/required constraints
    const toolDef = session.agentIR?.tools?.find((t) => t.name === toolCall.name);
    if (toolDef?.parameters?.length) {
      const { validateToolInputs } =
        await import('@abl/compiler/platform/constructs/executors/tool-binding-executor.js');
      try {
        validateToolInputs(
          toolCall.name,
          toolCall.input as Record<string, unknown>,
          toolDef.parameters,
        );
      } catch (validationErr) {
        log.warn('Post-guardrail re-validation failed', {
          toolName: toolCall.name,
          error: validationErr instanceof Error ? validationErr.message : String(validationErr),
        });
        toolResult = {
          error: `Tool input invalid after guardrail modification: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
          guardrail: 'post_modification_revalidation',
        };
        return { toolResult };
      }
    }
  } catch {
    // If modified content isn't valid JSON, use original parameters
    log.warn('Guardrail modified content is not valid JSON, using original parameters', {
      toolName: toolCall.name,
    });
  }
}
```

### Step 6: Run full test suite to verify no regressions

```bash
pnpm build && pnpm test -- --run
```

Expected: All existing tests pass. The new re-validation is fail-open for guardrail pipeline errors (existing behavior) but fail-closed for validation errors (new behavior).

### Step 7: Commit

```bash
npx prettier --write packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/post-guardrail-revalidation.test.ts
git add packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/post-guardrail-revalidation.test.ts
git commit -m "[ABLP-2] fix(runtime): re-validate tool params after guardrail modification

Guardrail redact/fix actions can modify tool call parameters in ways
that break required fields, type constraints, or enum restrictions.
Add validateToolInputs() call after guardrail modification to catch
these cases before tool execution."
```

---

## Task 2: Tool Confirmation Immutability — IR Schema (P0, part 1/3)

Add the `confirmation` config to `ToolDefinition` in the IR schema.

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts:472-520` — add `confirmation` to `ToolDefinition`
- Test: `packages/compiler/src/__tests__/tool-confirmation-schema.test.ts`

### Step 1: Write the failing test

Create `packages/compiler/src/__tests__/tool-confirmation-schema.test.ts`:

```typescript
/**
 * Tool Confirmation Schema Tests
 *
 * Verifies the IR schema supports confirmation configuration on tool definitions.
 */
import { describe, test, expect } from 'vitest';
import type { ToolDefinition } from '../platform/ir/schema.js';

describe('ToolDefinition confirmation schema', () => {
  test('accepts tool with no confirmation config (backward compatible)', () => {
    const tool: ToolDefinition = {
      name: 'lookup_order',
      description: 'Look up an order',
      parameters: [],
      returns: { type: 'object' },
      hints: {
        cacheable: true,
        latency: 'fast',
        parallelizable: true,
        side_effects: false,
        requires_auth: false,
      },
    };
    expect(tool.confirmation).toBeUndefined();
  });

  test('accepts tool with confirmation: always and immutable params', () => {
    const tool: ToolDefinition = {
      name: 'process_refund',
      description: 'Process a refund',
      parameters: [
        { name: 'order_id', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true },
        { name: 'reason', type: 'string', required: false },
      ],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: true,
        requires_auth: true,
      },
      confirmation: {
        require: 'always',
        immutable_params: ['order_id', 'amount'],
      },
    };
    expect(tool.confirmation?.require).toBe('always');
    expect(tool.confirmation?.immutable_params).toEqual(['order_id', 'amount']);
  });

  test('accepts tool with confirmation: when_side_effects', () => {
    const tool: ToolDefinition = {
      name: 'update_profile',
      description: 'Update user profile',
      parameters: [{ name: 'name', type: 'string', required: true }],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: true,
        side_effects: true,
        requires_auth: true,
      },
      confirmation: {
        require: 'when_side_effects',
      },
    };
    expect(tool.confirmation?.require).toBe('when_side_effects');
    expect(tool.confirmation?.immutable_params).toBeUndefined();
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/tool-confirmation-schema.test.ts
```

Expected: FAIL — TypeScript error: `confirmation` does not exist on `ToolDefinition`.

### Step 3: Add confirmation to ToolDefinition

In `packages/compiler/src/platform/ir/schema.ts`, add to the `ToolDefinition` interface (after `context_access`):

```typescript
  /** Tool confirmation configuration — requires user approval before execution */
  confirmation?: {
    /** When to require confirmation */
    require: 'always' | 'never' | 'when_side_effects';
    /** Parameters locked after user confirms — prevents tampering between confirmation and execution */
    immutable_params?: string[];
  };
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/tool-confirmation-schema.test.ts
```

Expected: PASS — all 3 tests green.

### Step 5: Commit

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/tool-confirmation-schema.test.ts
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/__tests__/tool-confirmation-schema.test.ts
git commit -m "[ABLP-2] feat(compiler): add confirmation config to ToolDefinition IR schema

Adds optional confirmation property to ToolDefinition with require mode
(always/never/when_side_effects) and immutable_params list for parameter
locking between confirmation and execution."
```

---

## Task 3: Tool Confirmation Immutability — Snapshot Logic (P0, part 2/3)

Create the snapshot/compare/format helpers as a new module.

**Files:**

- Create: `apps/runtime/src/services/execution/tool-confirmation.ts`
- Test: `apps/runtime/src/__tests__/tool-confirmation.test.ts`

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/tool-confirmation.test.ts`:

```typescript
/**
 * Tool Confirmation Immutability Tests
 *
 * Tests snapshot creation, immutability validation, hash comparison,
 * TTL expiration, and confirmation message formatting.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSnapshot,
  validateImmutability,
  formatConfirmationMessage,
  isSnapshotExpired,
  type ToolConfirmationSnapshot,
} from '../services/execution/tool-confirmation.js';

describe('Tool Confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // SNAPSHOT CREATION
  // ===========================================================================

  describe('createSnapshot', () => {
    test('creates snapshot with all immutable param values hashed', () => {
      const snapshot = createSnapshot(
        {
          id: 'tc-1',
          name: 'process_refund',
          input: { order_id: 'ORD-123', amount: 49.99, reason: 'defective' },
        },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );

      expect(snapshot.toolName).toBe('process_refund');
      expect(snapshot.toolCallId).toBe('tc-1');
      expect(snapshot.params).toEqual({ order_id: 'ORD-123', amount: 49.99, reason: 'defective' });
      expect(snapshot.immutableParams).toEqual(['order_id', 'amount']);
      expect(snapshot.snapshotHash).toBeTruthy();
      expect(snapshot.createdAt).toBe(Date.now());
      expect(snapshot.expiresAt).toBeGreaterThan(Date.now());
    });

    test('creates snapshot with empty immutable_params when not specified', () => {
      const snapshot = createSnapshot(
        { id: 'tc-2', name: 'update_profile', input: { name: 'Alice' } },
        { require: 'always' },
      );

      expect(snapshot.immutableParams).toEqual([]);
    });

    test('snapshot hash is deterministic for same values', () => {
      const snap1 = createSnapshot(
        { id: 'tc-1', name: 'refund', input: { order_id: 'A', amount: 10 } },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      const snap2 = createSnapshot(
        { id: 'tc-2', name: 'refund', input: { order_id: 'A', amount: 10 } },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      expect(snap1.snapshotHash).toBe(snap2.snapshotHash);
    });

    test('snapshot hash changes when immutable param value changes', () => {
      const snap1 = createSnapshot(
        { id: 'tc-1', name: 'refund', input: { order_id: 'A', amount: 10 } },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      const snap2 = createSnapshot(
        { id: 'tc-2', name: 'refund', input: { order_id: 'A', amount: 99 } },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );
      expect(snap1.snapshotHash).not.toBe(snap2.snapshotHash);
    });
  });

  // ===========================================================================
  // IMMUTABILITY VALIDATION
  // ===========================================================================

  describe('validateImmutability', () => {
    test('passes when immutable params are unchanged', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'refund',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99, reason: 'defective' },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };

      const result = validateImmutability(snapshot, {
        order_id: 'ORD-123',
        amount: 49.99,
        reason: 'changed reason',
      });
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    test('fails when immutable param value changed', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'refund',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99 },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };

      const result = validateImmutability(snapshot, { order_id: 'ORD-123', amount: 999.99 });
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('amount');
    });

    test('fails when immutable param is removed', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'refund',
        toolCallId: 'tc-1',
        params: { order_id: 'ORD-123', amount: 49.99 },
        immutableParams: ['order_id', 'amount'],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };

      const result = validateImmutability(snapshot, { order_id: 'ORD-123' });
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('amount');
    });

    test('passes with empty immutableParams (no constraints)', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'update',
        toolCallId: 'tc-1',
        params: { name: 'Alice' },
        immutableParams: [],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };

      const result = validateImmutability(snapshot, { name: 'Bob' });
      expect(result.valid).toBe(true);
    });

    test('uses deep equality for nested objects', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'create_order',
        toolCallId: 'tc-1',
        params: { items: [{ sku: 'A', qty: 2 }], total: 100 },
        immutableParams: ['items'],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };

      const result = validateImmutability(snapshot, { items: [{ sku: 'A', qty: 2 }], total: 200 });
      expect(result.valid).toBe(true);
    });
  });

  // ===========================================================================
  // EXPIRATION
  // ===========================================================================

  describe('isSnapshotExpired', () => {
    test('returns false when snapshot is fresh', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'refund',
        toolCallId: 'tc-1',
        params: {},
        immutableParams: [],
        snapshotHash: 'hash',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      expect(isSnapshotExpired(snapshot)).toBe(false);
    });

    test('returns true when snapshot has expired', () => {
      const snapshot: ToolConfirmationSnapshot = {
        toolName: 'refund',
        toolCallId: 'tc-1',
        params: {},
        immutableParams: [],
        snapshotHash: 'hash',
        createdAt: Date.now() - 600_000,
        expiresAt: Date.now() - 300_000,
      };
      expect(isSnapshotExpired(snapshot)).toBe(true);
    });
  });

  // ===========================================================================
  // CONFIRMATION MESSAGE
  // ===========================================================================

  describe('formatConfirmationMessage', () => {
    test('formats tool name and params into confirmation prompt', () => {
      const msg = formatConfirmationMessage(
        { id: 'tc-1', name: 'process_refund', input: { order_id: 'ORD-123', amount: 49.99 } },
        { require: 'always', immutable_params: ['order_id', 'amount'] },
      );

      expect(msg).toContain('process_refund');
      expect(msg).toContain('order_id');
      expect(msg).toContain('ORD-123');
      expect(msg).toContain('49.99');
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd apps/runtime && pnpm test -- --run src/__tests__/tool-confirmation.test.ts
```

Expected: FAIL — module `../services/execution/tool-confirmation.js` does not exist.

### Step 3: Implement tool-confirmation.ts

Create `apps/runtime/src/services/execution/tool-confirmation.ts`:

```typescript
/**
 * Tool Confirmation Immutability
 *
 * Provides snapshot creation, immutability validation, and expiration checking
 * for tool call confirmations. Prevents parameter tampering between user
 * confirmation and tool execution.
 *
 * Security model:
 * - Snapshot stored server-side in session state (client cannot access)
 * - SHA-256 hash of immutable param values for tamper detection
 * - TTL-based expiration (default 5 minutes)
 * - Deep equality comparison for nested objects
 */

import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@abl/compiler';

/** Default TTL for confirmation snapshots (5 minutes) */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface ToolConfirmationSnapshot {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  immutableParams: string[];
  snapshotHash: string;
  createdAt: number;
  expiresAt: number;
}

interface ToolCallLike {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ConfirmationConfig {
  require: 'always' | 'never' | 'when_side_effects';
  immutable_params?: string[];
}

/**
 * Create a confirmation snapshot from a tool call and its confirmation config.
 */
export function createSnapshot(
  toolCall: ToolCallLike,
  config: ConfirmationConfig,
): ToolConfirmationSnapshot {
  const immutableParams = config.immutable_params ?? [];
  const now = Date.now();

  return {
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    params: { ...toolCall.input },
    immutableParams,
    snapshotHash: hashImmutableValues(toolCall.input, immutableParams),
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
  };
}

/**
 * Validate that immutable parameters haven't changed since the snapshot was taken.
 */
export function validateImmutability(
  snapshot: ToolConfirmationSnapshot,
  currentParams: Record<string, unknown>,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const param of snapshot.immutableParams) {
    const original = snapshot.params[param];
    const current = currentParams[param];

    if (!deepEqual(original, current)) {
      violations.push(param);
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Check if a confirmation snapshot has expired.
 */
export function isSnapshotExpired(snapshot: ToolConfirmationSnapshot): boolean {
  return Date.now() > snapshot.expiresAt;
}

/**
 * Format a human-readable confirmation message for the user.
 */
export function formatConfirmationMessage(
  toolCall: ToolCallLike,
  config: ConfirmationConfig,
): string {
  const paramLines = Object.entries(toolCall.input)
    .map(([key, value]) => {
      const locked = config.immutable_params?.includes(key) ? ' (locked)' : '';
      return `  - ${key}: ${JSON.stringify(value)}${locked}`;
    })
    .join('\n');

  return `Confirm execution of **${toolCall.name}**?\n\nParameters:\n${paramLines}\n\nReply "yes" to proceed or "no" to cancel.`;
}

/**
 * Determine if a tool call requires user confirmation based on its definition.
 */
export function shouldRequireConfirmation(toolDef: ToolDefinition): boolean {
  if (!toolDef.confirmation) return false;

  switch (toolDef.confirmation.require) {
    case 'always':
      return true;
    case 'when_side_effects':
      return toolDef.hints.side_effects === true;
    case 'never':
      return false;
    default:
      return false;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function hashImmutableValues(params: Record<string, unknown>, immutableParams: string[]): string {
  if (immutableParams.length === 0) return 'empty';

  const values: Record<string, unknown> = {};
  for (const key of immutableParams.sort()) {
    values[key] = params[key];
  }

  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, i) => key === bKeys[i] && deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/tool-confirmation.test.ts
```

Expected: PASS — all tests green.

### Step 5: Commit

```bash
npx prettier --write apps/runtime/src/services/execution/tool-confirmation.ts apps/runtime/src/__tests__/tool-confirmation.test.ts
git add apps/runtime/src/services/execution/tool-confirmation.ts apps/runtime/src/__tests__/tool-confirmation.test.ts
git commit -m "[ABLP-2] feat(runtime): add tool confirmation snapshot and immutability validation

New module for tool-call-level confirmation with parameter locking.
Provides snapshot creation with SHA-256 hash, deep-equal immutability
validation, TTL expiration, and confirmation message formatting."
```

---

## Task 4: Tool Confirmation Immutability — Runtime Gate (P0, part 3/3)

Wire the confirmation gate into `reasoning-executor.ts`.

**Files:**

- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` — add confirmation gate in `executeToolCall`
- Test: `apps/runtime/src/__tests__/tool-confirmation-gate.test.ts`

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/tool-confirmation-gate.test.ts`:

```typescript
/**
 * Tool Confirmation Gate Tests
 *
 * Tests shouldRequireConfirmation logic for different tool configurations.
 */
import { describe, test, expect } from 'vitest';
import { shouldRequireConfirmation } from '../services/execution/tool-confirmation.js';
import type { ToolDefinition } from '@abl/compiler';

describe('Tool Confirmation Gate', () => {
  describe('shouldRequireConfirmation', () => {
    test('returns true for confirmation: always', () => {
      const toolDef = {
        confirmation: { require: 'always' as const },
        hints: {
          side_effects: false,
          cacheable: true,
          latency: 'fast' as const,
          parallelizable: true,
          requires_auth: false,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(true);
    });

    test('returns true for when_side_effects with side_effects: true', () => {
      const toolDef = {
        confirmation: { require: 'when_side_effects' as const },
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(true);
    });

    test('returns false for when_side_effects with side_effects: false', () => {
      const toolDef = {
        confirmation: { require: 'when_side_effects' as const },
        hints: {
          side_effects: false,
          cacheable: true,
          latency: 'fast' as const,
          parallelizable: true,
          requires_auth: false,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });

    test('returns false for confirmation: never', () => {
      const toolDef = {
        confirmation: { require: 'never' as const },
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });

    test('returns false when no confirmation config', () => {
      const toolDef = {
        hints: {
          side_effects: true,
          cacheable: false,
          latency: 'medium' as const,
          parallelizable: false,
          requires_auth: true,
        },
      } as ToolDefinition;
      expect(shouldRequireConfirmation(toolDef)).toBe(false);
    });
  });
});
```

### Step 2: Run test to verify it passes (shouldRequireConfirmation already implemented in Task 3)

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/tool-confirmation-gate.test.ts
```

Expected: PASS — `shouldRequireConfirmation` was already added in Task 3.

### Step 3: Wire confirmation gate into reasoning-executor

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add import at the top:

```typescript
import {
  shouldRequireConfirmation,
  createSnapshot,
  validateImmutability,
  isSnapshotExpired,
  formatConfirmationMessage,
} from './tool-confirmation.js';
```

Then in `executeToolCall()`, after the guardrail section ends and before `session.toolExecutor.execute()`, add the confirmation gate:

```typescript
// Confirmation gate — require user approval for configured tools
if (toolDef?.confirmation && shouldRequireConfirmation(toolDef)) {
  const pendingConfirmation = session.data.values._pending_tool_confirmation as
    | import('./tool-confirmation.js').ToolConfirmationSnapshot
    | undefined;

  if (!pendingConfirmation || pendingConfirmation.toolCallId !== toolCall.id) {
    // First time — create snapshot and pause for confirmation
    const snapshot = createSnapshot(toolCall, toolDef.confirmation);
    session.data.values._pending_tool_confirmation = snapshot;

    onTraceEvent?.({
      type: 'tool_confirmation_requested',
      data: {
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        immutableParams: snapshot.immutableParams,
        agent: session.agentName,
      },
    });

    const confirmMsg = formatConfirmationMessage(toolCall, toolDef.confirmation);
    return {
      toolResult: { confirmation_required: true, message: confirmMsg },
      action: { type: 'await_confirmation', toolName: toolCall.name },
      breakLoop: true,
    };
  }

  // Re-execution after user confirmed — validate immutability
  if (isSnapshotExpired(pendingConfirmation)) {
    delete session.data.values._pending_tool_confirmation;
    onTraceEvent?.({
      type: 'tool_confirmation_rejected',
      data: { toolName: toolCall.name, toolCallId: toolCall.id, reason: 'expired' },
    });
    return { toolResult: { error: 'Confirmation expired. Please try again.' } };
  }

  const immutabilityCheck = validateImmutability(
    pendingConfirmation,
    toolCall.input as Record<string, unknown>,
  );

  if (!immutabilityCheck.valid) {
    delete session.data.values._pending_tool_confirmation;
    onTraceEvent?.({
      type: 'tool_confirmation_immutability_violation',
      data: {
        toolName: toolCall.name,
        violations: immutabilityCheck.violations,
        agent: session.agentName,
      },
    });
    return {
      toolResult: {
        error: `Parameter tampering detected. Locked parameters changed: ${immutabilityCheck.violations.join(', ')}`,
      },
    };
  }

  // Passed — clean up and proceed to execution
  delete session.data.values._pending_tool_confirmation;
  onTraceEvent?.({
    type: 'tool_confirmation_approved',
    data: { toolName: toolCall.name, toolCallId: toolCall.id, agent: session.agentName },
  });
}
```

### Step 4: Build and run tests

```bash
pnpm build && cd apps/runtime && pnpm test -- --run src/__tests__/tool-confirmation.test.ts src/__tests__/tool-confirmation-gate.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
npx prettier --write apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/tool-confirmation-gate.test.ts
git add apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/tool-confirmation-gate.test.ts
git commit -m "[ABLP-2] feat(runtime): wire tool confirmation gate into reasoning executor

Adds confirmation flow before tool execution. Tools with confirmation:
always or when_side_effects pause for user approval. Immutable params
are snapshot-checked with SHA-256 hash to prevent parameter tampering
between confirmation and execution. Expired snapshots auto-reject."
```

---

## Task 5: PII Guard Field-Type Awareness — Selective Redaction API (P1, part 1/2)

Add `detectPIISelective()` to `pii-detector.ts` that accepts exempt types.

**Files:**

- Modify: `packages/compiler/src/platform/security/pii-detector.ts` — add `detectPIISelective`
- Modify: `packages/compiler/src/__tests__/security/pii-detector.test.ts` — add selective redaction tests

### Step 1: Write the failing tests

Append to `packages/compiler/src/__tests__/security/pii-detector.test.ts`, inside the outer `describe('PII Detector', ...)` block, add a new nested describe. Also update the import at the top:

```typescript
import {
  detectPII,
  redactPII,
  containsPII,
  detectPIISelective,
} from '../../platform/security/pii-detector.js';
```

Then add the new describe block:

```typescript
// ===========================================================================
// SELECTIVE REDACTION
// ===========================================================================

describe('Selective Redaction', () => {
  test('redacts all PII when no exempt types', () => {
    const result = detectPIISelective('Call me at 555-123-4567 or email user@example.com');
    expect(result.redacted).toContain('[REDACTED_PHONE]');
    expect(result.redacted).toContain('[REDACTED_EMAIL]');
    expect(result.exemptedTypes).toEqual([]);
    expect(result.redactedTypes).toContain('phone');
    expect(result.redactedTypes).toContain('email');
  });

  test('exempts phone when gathering phone field', () => {
    const result = detectPIISelective(
      'My phone is 555-123-4567 and SSN is 123-45-6789',
      new Set(['phone']),
    );
    expect(result.redacted).toContain('555-123-4567');
    expect(result.redacted).toContain('[REDACTED_SSN]');
    expect(result.exemptedTypes).toContain('phone');
    expect(result.redactedTypes).toContain('ssn');
    expect(result.redactedTypes).not.toContain('phone');
  });

  test('exempts email when gathering email field', () => {
    const result = detectPIISelective(
      'My email is user@example.com and card is 4111 1111 1111 1111',
      new Set(['email']),
    );
    expect(result.redacted).toContain('user@example.com');
    expect(result.redacted).toContain('[REDACTED_CARD]');
    expect(result.exemptedTypes).toContain('email');
  });

  test('exempts multiple types simultaneously', () => {
    const result = detectPIISelective(
      'Phone 555-123-4567, email user@example.com, SSN 123-45-6789',
      new Set(['phone', 'email']),
    );
    expect(result.redacted).toContain('555-123-4567');
    expect(result.redacted).toContain('user@example.com');
    expect(result.redacted).toContain('[REDACTED_SSN]');
  });

  test('detects ALL types even when exempted (for audit)', () => {
    const result = detectPIISelective('My phone is 555-123-4567', new Set(['phone']));
    expect(result.hasPII).toBe(true);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].type).toBe('phone');
  });

  test('returns empty exemptedTypes when no PII matches exempt set', () => {
    const result = detectPIISelective('My email is user@example.com', new Set(['phone']));
    expect(result.redacted).toContain('[REDACTED_EMAIL]');
    expect(result.exemptedTypes).toEqual([]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/security/pii-detector.test.ts
```

Expected: FAIL — `detectPIISelective` is not exported.

### Step 3: Implement detectPIISelective

Add to `packages/compiler/src/platform/security/pii-detector.ts`, after the `containsPII` function (before the HELPERS section):

```typescript
/**
 * Selective PII result with audit fields for exempted vs redacted types.
 */
export interface SelectivePIIResult extends PIIDetectionResult {
  exemptedTypes: PIIType[];
  redactedTypes: PIIType[];
}

/**
 * Detect and selectively redact PII, allowing exemptions for specific types.
 * Always detects ALL types for audit trail (OWASP LLM02 compliance).
 *
 * @param text - Input text to scan
 * @param exemptTypes - PII types to detect but NOT redact
 */
export function detectPIISelective(text: string, exemptTypes?: Set<PIIType>): SelectivePIIResult {
  const allDetections: PIIDetection[] = [];

  for (const pattern of PII_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[0];
      if (pattern.validate && !pattern.validate(value)) continue;

      allDetections.push({
        type: pattern.type,
        start: match.index,
        end: match.index + value.length,
        value,
      });
    }
  }

  allDetections.sort((a, b) => a.start - b.start);
  const filtered = removeOverlaps(allDetections);

  const exempt = exemptTypes ?? new Set<PIIType>();
  const toRedact = filtered.filter((d) => !exempt.has(d.type));
  const exempted = filtered.filter((d) => exempt.has(d.type));

  let redacted = text;
  for (let i = toRedact.length - 1; i >= 0; i--) {
    const det = toRedact[i];
    const label = PII_PATTERNS.find((p) => p.type === det.type)?.redactLabel || '[REDACTED]';
    redacted = redacted.substring(0, det.start) + label + redacted.substring(det.end);
  }

  return {
    hasPII: filtered.length > 0,
    detections: filtered,
    redacted,
    exemptedTypes: [...new Set(exempted.map((d) => d.type))],
    redactedTypes: [...new Set(toRedact.map((d) => d.type))],
  };
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/security/pii-detector.test.ts
```

Expected: PASS — all existing + new tests green.

### Step 5: Commit

```bash
npx prettier --write packages/compiler/src/platform/security/pii-detector.ts packages/compiler/src/__tests__/security/pii-detector.test.ts
git add packages/compiler/src/platform/security/pii-detector.ts packages/compiler/src/__tests__/security/pii-detector.test.ts
git commit -m "[ABLP-2] feat(compiler): add selective PII redaction with type exemptions

Adds detectPIISelective() that accepts exempt PII types to skip during
redaction while still detecting all types for audit compliance (OWASP
LLM02). Enables context-aware PII handling where gathered fields are
not redacted during active collection."
```

---

## Task 6: PII Guard Field-Type Awareness — IR Schema + Guard Hook (P1, part 2/2)

Add `sensitive` fields to GatherField and wire exemption logic into `pii-guard.ts`.

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts` — add `sensitive`, `sensitive_display`, `mask_config`, `transient` to GatherField
- Modify: `packages/compiler/src/platform/nlu/types.ts` — add `sensitive` to EntityDefinition
- Modify: `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` — context-aware exemption
- Modify: `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts` — add context-aware tests

### Step 1: Write the failing tests

Append to `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts`, inside the outer `describe('createPIIGuardHook', ...)` block:

```typescript
// =========================================================================
// CONTEXT-AWARE EXEMPTIONS
// =========================================================================

describe('context-aware exemptions', () => {
  test('does not redact phone when missingFields includes a phone-type field', async () => {
    const hook = createPIIGuardHook(makeConfig());
    const ctx = makeCtx({
      userMessage: 'My phone is 555-123-4567',
      missingFields: ['phone_number'],
      declaredEntities: [{ name: 'phone_number', type: 'pattern', sensitive: true }],
    });
    const result = await hook(ctx, 'entity_extraction');
    expect(result.userMessage).toContain('555-123-4567');
  });

  test('redacts SSN even when gathering phone', async () => {
    const hook = createPIIGuardHook(makeConfig());
    const ctx = makeCtx({
      userMessage: 'Phone 555-123-4567, SSN 123-45-6789',
      missingFields: ['phone_number'],
      declaredEntities: [{ name: 'phone_number', type: 'pattern', sensitive: true }],
    });
    const result = await hook(ctx, 'entity_extraction');
    expect(result.userMessage).toContain('555-123-4567');
    expect(result.userMessage).toContain('[REDACTED_SSN]');
  });

  test('does not redact email when missingFields includes email-type field', async () => {
    const hook = createPIIGuardHook(makeConfig());
    const ctx = makeCtx({
      userMessage: 'My email is user@example.com',
      missingFields: ['contact_email'],
      declaredEntities: [{ name: 'contact_email', type: 'pattern', sensitive: true }],
    });
    const result = await hook(ctx, 'entity_extraction');
    expect(result.userMessage).toContain('user@example.com');
  });

  test('still redacts everything when no missingFields', async () => {
    const hook = createPIIGuardHook(makeConfig());
    const ctx = makeCtx({
      userMessage: 'My phone is 555-123-4567',
    });
    const result = await hook(ctx, 'entity_extraction');
    expect(result.userMessage).toContain('[REDACTED_PHONE]');
  });

  test('still redacts when missingFields is empty', async () => {
    const hook = createPIIGuardHook(makeConfig());
    const ctx = makeCtx({
      userMessage: 'My phone is 555-123-4567',
      missingFields: [],
    });
    const result = await hook(ctx, 'entity_extraction');
    expect(result.userMessage).toContain('[REDACTED_PHONE]');
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/enterprise/pii-guard.test.ts
```

Expected: FAIL — `sensitive` does not exist on `EntityDefinition`, and the hook still blindly redacts.

### Step 3: Add sensitive fields to IR schema

In `packages/compiler/src/platform/ir/schema.ts`, add to `GatherField` interface (after `prompt_mode`):

```typescript
  /** Whether this field carries PII and should be treated as sensitive */
  sensitive?: boolean;
  /** Display mode for sensitive field values in non-gathering contexts */
  sensitive_display?: 'redact' | 'mask' | 'replace';
  /** Masking configuration (for sensitive_display: 'mask') */
  mask_config?: { show_first: number; show_last: number; char: string };
  /** Whether PII auto-cleans after gather completes (for CVV, OTP — XO migration) */
  transient?: boolean;
  /** Custom regex pattern for value extraction (XO migration) */
  extraction_pattern?: string;
  /** Capture group index for extraction_pattern (default: 0 = full match) */
  extraction_group?: number;
```

### Step 4: Add sensitive to EntityDefinition

In `packages/compiler/src/platform/nlu/types.ts`, add to `EntityDefinition` interface (after `validation`):

```typescript
  /** Whether this entity carries PII — mirrors GatherField.sensitive for NLU awareness */
  sensitive?: boolean;
```

### Step 5: Replace pii-guard.ts with context-aware implementation

Replace the content of `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` with:

```typescript
/**
 * PII Guard
 *
 * Pipeline hook that redacts PII from user messages before LLM processing.
 * Context-aware: exempts PII types that match fields currently being gathered,
 * so entity extraction isn't blocked by redaction.
 *
 * XO migration note: This replaces XO's Sensitive:<streamId>:<userId> Redis key
 * pattern with NLUContext.missingFields, which already tracks active gather fields.
 */

import { createLogger } from '../../index.js';
import type { NLUContext, NLUTask, EntityDefinition } from '../types.js';
import type { NLUConfig } from '../config.js';
import { detectPIISelective, type PIIType } from '../../security/pii-detector.js';

const log = createLogger('pii-guard');

/** Map field/entity names to PII types they represent */
const FIELD_NAME_TO_PII_TYPE: Record<string, PIIType> = {
  phone: 'phone',
  phone_number: 'phone',
  telephone: 'phone',
  mobile: 'phone',
  cell: 'phone',
  contact_phone: 'phone',
  email: 'email',
  email_address: 'email',
  contact_email: 'email',
  ssn: 'ssn',
  social_security: 'ssn',
  social_security_number: 'ssn',
  credit_card: 'credit_card',
  card_number: 'credit_card',
  cc_number: 'credit_card',
  ip: 'ip_address',
  ip_address: 'ip_address',
};

/** Map entity types to PII types */
const ENTITY_TYPE_TO_PII_TYPE: Record<string, PIIType> = {
  phone: 'phone',
  email: 'email',
  ssn: 'ssn',
  credit_card: 'credit_card',
};

/**
 * Resolve which PII types should be exempted based on active gather context.
 * Only exempts types for fields that are currently being gathered (in missingFields).
 */
export function resolveGatherExemptions(
  missingFields: string[] | undefined,
  declaredEntities: EntityDefinition[] | undefined,
): Set<PIIType> {
  const exempt = new Set<PIIType>();
  if (!missingFields?.length) return exempt;

  const entityMap = new Map<string, EntityDefinition>();
  if (declaredEntities) {
    for (const entity of declaredEntities) {
      entityMap.set(entity.name, entity);
    }
  }

  for (const fieldName of missingFields) {
    const normalized = fieldName.toLowerCase();

    // Check field name mapping
    const fromName = FIELD_NAME_TO_PII_TYPE[normalized];
    if (fromName) {
      exempt.add(fromName);
      continue;
    }

    // Check entity definition type mapping
    const entity = entityMap.get(fieldName);
    if (entity) {
      const fromEntityType = ENTITY_TYPE_TO_PII_TYPE[entity.type];
      if (fromEntityType) {
        exempt.add(fromEntityType);
      }
    }
  }

  return exempt;
}

/**
 * Create a beforeExecute hook that redacts PII from user messages.
 * Context-aware: exempts PII types matching active gather fields.
 */
export function createPIIGuardHook(
  config: NLUConfig,
): (ctx: NLUContext, task: NLUTask) => Promise<NLUContext> {
  if (!config.piiRedaction.enabled || !config.piiRedaction.redactInput) {
    return async (ctx: NLUContext) => ctx;
  }

  return async (ctx: NLUContext): Promise<NLUContext> => {
    // Resolve exemptions from active gather context
    const exemptTypes = resolveGatherExemptions(ctx.missingFields, ctx.declaredEntities);

    const result = detectPIISelective(ctx.userMessage, exemptTypes);

    // Always log detections for audit (OWASP LLM02 compliance)
    if (result.hasPII) {
      log.info('pii-detected', {
        types: result.detections.map((d) => d.type),
        exempted: result.exemptedTypes,
        redacted: result.redactedTypes,
      });
    }

    if (result.redacted === ctx.userMessage) {
      return ctx;
    }

    return {
      ...ctx,
      userMessage: result.redacted,
    };
  };
}
```

### Step 6: Build and run tests

```bash
cd packages/compiler && pnpm build && pnpm test -- --run src/__tests__/enterprise/pii-guard.test.ts src/__tests__/security/pii-detector.test.ts
```

Expected: PASS — all existing + new context-aware tests green.

### Step 7: Run full compiler test suite

```bash
cd packages/compiler && pnpm test -- --run
```

Expected: All pass. No regressions from schema changes (additive optional fields).

### Step 8: Commit

```bash
npx prettier --write packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/nlu/types.ts packages/compiler/src/platform/nlu/enterprise/pii-guard.ts packages/compiler/src/__tests__/enterprise/pii-guard.test.ts
git add packages/compiler/src/platform/ir/schema.ts packages/compiler/src/platform/nlu/types.ts packages/compiler/src/platform/nlu/enterprise/pii-guard.ts packages/compiler/src/__tests__/enterprise/pii-guard.test.ts
git commit -m "[ABLP-2] feat(compiler): context-aware PII guard with gather field exemptions

PII guard now reads NLUContext.missingFields and declaredEntities to
exempt PII types matching active gather fields from redaction. SSN
is still redacted while gathering phone. All detections logged for
audit compliance (OWASP LLM02).

IR schema adds sensitive, sensitive_display, mask_config, transient
to GatherField for XO migration compatibility. EntityDefinition gains
sensitive flag."
```

---

## Task 7: Custom Regex Extractors for GATHER (P1)

Add `extraction_pattern` support to the gather extraction flow.

**Files:**

- Modify: `packages/compiler/src/platform/constructs/executors/gather-executor.ts` — pattern extraction strategy
- Test: `packages/compiler/src/__tests__/gather-extraction-pattern.test.ts`

Note: The `extraction_pattern` and `extraction_group` fields were already added to `GatherField` in Task 6 Step 3.

### Step 1: Write the failing test

Create `packages/compiler/src/__tests__/gather-extraction-pattern.test.ts`:

```typescript
/**
 * Gather Extraction Pattern Tests
 *
 * Tests custom regex extraction from user messages using field-level
 * extraction_pattern. This enables XO 10/11 migration where entities
 * use regex-based extraction.
 */
import { describe, test, expect } from 'vitest';
import {
  extractByPattern,
  validateExtractionPattern,
} from '../platform/constructs/executors/gather-executor.js';

describe('Gather Extraction Pattern', () => {
  // ===========================================================================
  // PATTERN EXTRACTION
  // ===========================================================================

  describe('extractByPattern', () => {
    test('extracts value matching full pattern (group 0)', () => {
      const result = extractByPattern('My policy is POL-123456-AB', 'POL-\\d{6}-[A-Z]{2}');
      expect(result).toBe('POL-123456-AB');
    });

    test('extracts specific capture group', () => {
      const result = extractByPattern('Employee ID: EMP-12345', 'EMP-(\\d{4,8})', 1);
      expect(result).toBe('12345');
    });

    test('returns null when no match', () => {
      const result = extractByPattern('I have no policy number', 'POL-\\d{6}-[A-Z]{2}');
      expect(result).toBeNull();
    });

    test('returns first match when multiple exist', () => {
      const result = extractByPattern(
        'Choose POL-111111-AA or POL-222222-BB',
        'POL-\\d{6}-[A-Z]{2}',
      );
      expect(result).toBe('POL-111111-AA');
    });

    test('returns null for invalid regex', () => {
      const result = extractByPattern('some text', '[invalid(regex');
      expect(result).toBeNull();
    });

    test('handles group index out of range', () => {
      const result = extractByPattern('EMP-12345', 'EMP-(\\d+)', 5);
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // PATTERN VALIDATION (compile-time)
  // ===========================================================================

  describe('validateExtractionPattern', () => {
    test('accepts valid regex', () => {
      const result = validateExtractionPattern('POL-\\d{6}-[A-Z]{2}');
      expect(result.valid).toBe(true);
    });

    test('rejects invalid regex', () => {
      const result = validateExtractionPattern('[invalid(');
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('rejects pattern exceeding max length', () => {
      const result = validateExtractionPattern('a'.repeat(501));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    test('accepts pattern at max length', () => {
      const result = validateExtractionPattern('a'.repeat(500));
      expect(result.valid).toBe(true);
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/gather-extraction-pattern.test.ts
```

Expected: FAIL — `extractByPattern` and `validateExtractionPattern` not exported.

### Step 3: Implement extraction functions

Add to `packages/compiler/src/platform/constructs/executors/gather-executor.ts`. Add the import at the top:

```typescript
import { createLogger } from '../../index.js';

const gatherLog = createLogger('gather-executor');
```

Then add before the `GatherExecutor` class:

```typescript
// =============================================================================
// PATTERN EXTRACTION (XO migration: custom regex extractors)
// =============================================================================

const MAX_PATTERN_LENGTH = 500;

/**
 * Extract a value from text using a custom regex pattern.
 *
 * @param text - User message to extract from
 * @param pattern - Regex pattern string
 * @param group - Capture group index (default: 0 = full match)
 * @returns Extracted value or null if no match
 */
export function extractByPattern(text: string, pattern: string, group: number = 0): string | null {
  try {
    const regex = new RegExp(pattern);
    const match = regex.exec(text);

    if (!match) return null;

    if (group >= match.length) {
      gatherLog.warn('Extraction pattern group index out of range', {
        pattern,
        group,
        availableGroups: match.length - 1,
      });
      return null;
    }

    return match[group] ?? null;
  } catch {
    gatherLog.warn('Invalid extraction pattern', { pattern });
    return null;
  }
}

/**
 * Validate an extraction pattern at compile time.
 */
export function validateExtractionPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}` };
  }

  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/gather-extraction-pattern.test.ts
```

Expected: PASS — all tests green.

### Step 5: Wire pattern extraction into GatherExecutor.evaluate

In the `GatherExecutor` class in `gather-executor.ts`, modify the `evaluate` method signature to accept an optional `userMessage` parameter, and add pattern-based extraction at the top of the method:

```typescript
  evaluate(
    gather: GatherExecutorConfig,
    collectedData: Record<string, unknown>,
    extracted: Record<string, unknown>,
    completeWhen?: string,
    userMessage?: string,
  ): GatherStepResult {
    // Pattern extraction: try extraction_pattern before LLM/ML extraction
    if (userMessage) {
      for (const field of gather.fields) {
        if (extracted[field.name] !== undefined) continue;
        if (collectedData[field.name] !== undefined) continue;

        const gatherField = field as GatherExecutorField & {
          extraction_pattern?: string;
          extraction_group?: number;
        };

        if (gatherField.extraction_pattern) {
          const value = extractByPattern(
            userMessage,
            gatherField.extraction_pattern,
            gatherField.extraction_group,
          );
          if (value !== null) {
            extracted[field.name] = value;
            gatherLog.debug('Extracted via pattern', {
              field: field.name,
              pattern: gatherField.extraction_pattern,
            });
          }
        }
      }
    }

    // ... rest of existing evaluate logic (validateExtracted, checkCompleteness, etc.)
```

### Step 6: Build and run full test suite

```bash
cd packages/compiler && pnpm build && pnpm test -- --run
```

Expected: All pass. The `evaluate` method change is backward-compatible (new optional param).

### Step 7: Commit

```bash
npx prettier --write packages/compiler/src/platform/constructs/executors/gather-executor.ts packages/compiler/src/__tests__/gather-extraction-pattern.test.ts
git add packages/compiler/src/platform/constructs/executors/gather-executor.ts packages/compiler/src/__tests__/gather-extraction-pattern.test.ts
git commit -m "[ABLP-2] feat(compiler): add custom regex extraction for gather fields

Adds extractByPattern() for field-level regex extraction, enabling XO
10/11 migration where entities use sensitive_pattern.regex arrays.
Pattern extraction runs first-priority before LLM/ML extraction.
Includes compile-time validation (max 500 chars, regex syntax check)."
```

---

## Summary

| Task      | Item                         | Files Changed                                       | Tests Added  |
| --------- | ---------------------------- | --------------------------------------------------- | ------------ |
| 1         | Post-guardrail re-validation | `tool-binding-executor.ts`, `reasoning-executor.ts` | 5            |
| 2         | IR schema — confirmation     | `schema.ts`                                         | 3            |
| 3         | Confirmation snapshot logic  | `tool-confirmation.ts` (new)                        | 12           |
| 4         | Confirmation runtime gate    | `reasoning-executor.ts`, `tool-confirmation.ts`     | 5            |
| 5         | Selective PII redaction API  | `pii-detector.ts`                                   | 6            |
| 6         | Context-aware PII guard      | `schema.ts`, `types.ts`, `pii-guard.ts`             | 5            |
| 7         | Custom regex extractors      | `gather-executor.ts`                                | 9            |
| **Total** |                              | **8 files**                                         | **45 tests** |

All tasks are independent and can be implemented in any order, though the recommended sequence is Tasks 1-7 as listed above.
