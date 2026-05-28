/**
 * Identity Tier Gate E2E Test
 *
 * Exercises the full tool execution pipeline via ToolBindingExecutor
 * with the identity tier gate middleware wired in. Proves that:
 *
 * - Tools with identity_tier_required block callers below the required tier
 * - Callers at or above the required tier execute successfully
 * - Tools without tier requirements pass through regardless of caller tier
 * - The executor propagates sessionContext.callerContext into middleware metadata
 *
 * No vi.mock() — all wiring is via dependency injection.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolBindingExecutor } from '../platform/constructs/executors/tool-binding-executor.js';
import { createIdentityTierGateMiddleware } from '../platform/constructs/executors/identity-tier-gate-middleware.js';
import type { ToolDefinition } from '../platform/ir/schema.js';
import type { SecretsProvider } from '../platform/constructs/executors/secrets-provider.js';
import type { ToolExecutor } from '../platform/constructs/types.js';
import type {
  ToolCallerContext,
  ToolSessionContext,
} from '../platform/constructs/executors/tool-binding-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op secrets provider for testing */
const noopSecrets: SecretsProvider = {
  getSecret: async () => undefined,
};

/** Create a minimal ToolDefinition for a contract-only tool (no binding = fallback) */
function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'transfer_funds',
    description: 'Transfer funds between accounts',
    parameters: [],
    returns: { type: 'object' },
    hints: { cacheable: false, latency: 'medium', parallelizable: false },
    ...overrides,
  };
}

/** Create a fallback executor backed by a vi.fn() */
function makeFallbackExecutor(result: unknown = { success: true }): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
    executeParallel: vi.fn().mockResolvedValue([]),
  };
}

/** Build a ToolSessionContext with a given identity tier */
function makeSessionContext(
  identityTier: number,
  extra?: Partial<ToolCallerContext>,
): ToolSessionContext {
  return {
    sessionId: 'sess-e2e-test',
    tenantId: 'tenant-e2e',
    userId: 'user-e2e',
    callerContext: {
      identityTier,
      channel: 'web',
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe('Identity Tier Gate E2E via ToolBindingExecutor', () => {
  // E2E-8a: Anonymous caller (tier 0) blocked from tier-2 tool
  it('E2E-8a: anonymous caller (tier 0) is blocked from tier-2 tool with IDENTITY_TIER_INSUFFICIENT', async () => {
    const fallback = makeFallbackExecutor();
    const tier2Tool = makeTool({ name: 'transfer_funds', identity_tier_required: 2 });

    const executor = new ToolBindingExecutor({
      tools: [tier2Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(0),
    });

    const result = await executor.execute('transfer_funds', { amount: 100 }, 5000);

    // The middleware short-circuits — fallback should NOT be called
    expect(fallback.execute).not.toHaveBeenCalled();

    // Result is the structured error JSON from middleware
    const parsed = JSON.parse(result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.required_tier).toBe(2);
    expect(parsed.error.current_tier).toBe(0);
    expect(parsed.error.message).toContain('Identity tier 2 required');
  });

  // E2E-8b: Verified caller (tier 2) executes tier-2 tool successfully
  it('E2E-8b: verified caller (tier 2) executes tier-2 tool successfully', async () => {
    const expectedResult = { transactionId: 'txn-123', status: 'completed' };
    const fallback = makeFallbackExecutor(expectedResult);
    const tier2Tool = makeTool({ name: 'transfer_funds', identity_tier_required: 2 });

    const executor = new ToolBindingExecutor({
      tools: [tier2Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(2, { verificationMethod: 'sms_otp' }),
    });

    const result = await executor.execute('transfer_funds', { amount: 100 }, 5000);

    expect(fallback.execute).toHaveBeenCalledWith('transfer_funds', { amount: 100 }, 5000);
    expect(result).toEqual(expectedResult);
  });

  // E2E-8c: Recognized caller (tier 1) blocked from tier-2 tool
  it('E2E-8c: recognized caller (tier 1) is blocked from tier-2 tool', async () => {
    const fallback = makeFallbackExecutor();
    const tier2Tool = makeTool({ name: 'transfer_funds', identity_tier_required: 2 });

    const executor = new ToolBindingExecutor({
      tools: [tier2Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(1),
    });

    const result = await executor.execute('transfer_funds', { amount: 500 }, 5000);

    expect(fallback.execute).not.toHaveBeenCalled();

    const parsed = JSON.parse(result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.required_tier).toBe(2);
    expect(parsed.error.current_tier).toBe(1);
  });

  // E2E-8d: Recognized caller (tier 1) executes tier-1 tool successfully
  it('E2E-8d: recognized caller (tier 1) executes tier-1 tool successfully', async () => {
    const expectedResult = { balance: 1500.0 };
    const fallback = makeFallbackExecutor(expectedResult);
    const tier1Tool = makeTool({ name: 'check_balance', identity_tier_required: 1 });

    const executor = new ToolBindingExecutor({
      tools: [tier1Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(1),
    });

    const result = await executor.execute('check_balance', {}, 5000);

    expect(fallback.execute).toHaveBeenCalledWith('check_balance', {}, 5000);
    expect(result).toEqual(expectedResult);
  });

  // E2E-8e: Anonymous caller executes tool with no tier requirement
  it('E2E-8e: anonymous caller executes tool with no tier requirement (no-op, passes through)', async () => {
    const expectedResult = { greeting: 'Hello!' };
    const fallback = makeFallbackExecutor(expectedResult);
    // No identity_tier_required field — middleware is no-op
    const publicTool = makeTool({ name: 'get_greeting' });

    const executor = new ToolBindingExecutor({
      tools: [publicTool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(0),
    });

    const result = await executor.execute('get_greeting', {}, 5000);

    expect(fallback.execute).toHaveBeenCalledWith('get_greeting', {}, 5000);
    expect(result).toEqual(expectedResult);
  });

  // E2E-8f: Verified caller (tier 2) executes tier-0 tool (tier exceeds requirement)
  it('E2E-8f: verified caller (tier 2) executes tier-0 tool (tier exceeds requirement)', async () => {
    const expectedResult = { faq: 'How do I reset my password?' };
    const fallback = makeFallbackExecutor(expectedResult);
    const tier0Tool = makeTool({ name: 'get_faq', identity_tier_required: 0 });

    const executor = new ToolBindingExecutor({
      tools: [tier0Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback,
      middleware: [createIdentityTierGateMiddleware()],
      sessionContext: makeSessionContext(2),
    });

    const result = await executor.execute('get_faq', {}, 5000);

    expect(fallback.execute).toHaveBeenCalledWith('get_faq', {}, 5000);
    expect(result).toEqual(expectedResult);
  });

  // E2E-8g: Full lifecycle — tier 0 blocked, then tier 2 succeeds (simulating verification promotion)
  it('E2E-8g: full lifecycle — anonymous blocked, then verified succeeds after identity promotion', async () => {
    const tier2Tool = makeTool({ name: 'update_account', identity_tier_required: 2 });
    const tierGateMiddleware = createIdentityTierGateMiddleware();

    // Phase 1: Anonymous caller (tier 0) — should be blocked
    const fallback1 = makeFallbackExecutor();
    const executor1 = new ToolBindingExecutor({
      tools: [tier2Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback1,
      middleware: [tierGateMiddleware],
      sessionContext: makeSessionContext(0),
    });

    const blockedResult = await executor1.execute(
      'update_account',
      { email: 'new@example.com' },
      5000,
    );

    expect(fallback1.execute).not.toHaveBeenCalled();
    const parsed = JSON.parse(blockedResult as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.required_tier).toBe(2);
    expect(parsed.error.current_tier).toBe(0);

    // Phase 2: Same tool, but now with a verified caller (tier 2)
    // Simulates the user having completed identity verification
    const expectedResult = { accountUpdated: true };
    const fallback2 = makeFallbackExecutor(expectedResult);
    const executor2 = new ToolBindingExecutor({
      tools: [tier2Tool],
      secrets: noopSecrets,
      fallbackExecutor: fallback2,
      middleware: [tierGateMiddleware],
      sessionContext: makeSessionContext(2, { verificationMethod: 'sms_otp' }),
    });

    const successResult = await executor2.execute(
      'update_account',
      { email: 'new@example.com' },
      5000,
    );

    expect(fallback2.execute).toHaveBeenCalledWith(
      'update_account',
      { email: 'new@example.com' },
      5000,
    );
    expect(successResult).toEqual(expectedResult);
  });
});
