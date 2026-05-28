/**
 * Identity Tier Gate Middleware Tests
 *
 * Validates that the middleware correctly gates tool execution
 * based on the caller's identity verification tier vs the tool's
 * required tier.
 */

import { describe, it, expect, vi } from 'vitest';
import { createIdentityTierGateMiddleware } from '../platform/constructs/executors/identity-tier-gate-middleware.js';
import type {
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '../platform/constructs/executors/tool-middleware.js';
import type { ToolDefinition } from '../platform/ir/schema.js';

/** Build a minimal ToolCallContext for testing */
function buildContext(overrides: {
  identityTierRequired?: number;
  callerIdentityTier?: number;
  toolName?: string;
}): ToolCallContext {
  const tool: Partial<ToolDefinition> = {
    name: overrides.toolName ?? 'test_tool',
    identity_tier_required: overrides.identityTierRequired as 0 | 1 | 2 | undefined,
  };

  return {
    toolName: overrides.toolName ?? 'test_tool',
    params: {},
    timeoutMs: 5000,
    tool: tool as ToolDefinition,
    metadata: {
      callerContext: {
        identityTier: overrides.callerIdentityTier,
      },
    },
  };
}

/** A simple next() that resolves with a success marker */
const successNext: ToolMiddlewareNext = async () => ({
  result: 'tool-executed-successfully',
  metadata: { passed: true },
});

describe('createIdentityTierGateMiddleware', () => {
  it('blocks tier-0 caller when tool requires tier 2', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 2, callerIdentityTier: 0 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    // next() should NOT have been called
    expect(next).not.toHaveBeenCalled();

    // Result should contain the structured error
    const parsed = JSON.parse(result.result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.required_tier).toBe(2);
    expect(parsed.error.current_tier).toBe(0);
    expect(parsed.error.message).toBe('Identity tier 2 required, current tier is 0');
  });

  it('allows tier-2 caller when tool requires tier 2', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 2, callerIdentityTier: 2 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });

  it('allows tier-2 caller when tool requires tier 1 (exceeds requirement)', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 1, callerIdentityTier: 2 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });

  it('passes through when no identity_tier_required is set on tool', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ callerIdentityTier: 0 });
    // Explicitly remove identity_tier_required
    delete (ctx.tool as Record<string, unknown>)['identity_tier_required'];
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });

  it('passes through when tool is undefined on context', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx: ToolCallContext = {
      toolName: 'unknown_tool',
      params: {},
      timeoutMs: 5000,
      // No tool definition at all
    };
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });

  it('treats undefined callerContext identityTier as tier 0', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 1 });
    // callerContext exists but identityTier is undefined
    (ctx.metadata as Record<string, unknown>).callerContext = {};
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    // Tier 0 < tier 1, so should block
    expect(next).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.current_tier).toBe(0);
    expect(parsed.error.required_tier).toBe(1);
  });

  it('treats missing metadata as tier 0', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx: ToolCallContext = {
      toolName: 'restricted_tool',
      params: {},
      timeoutMs: 5000,
      tool: { identity_tier_required: 1 } as ToolDefinition,
      // No metadata at all
    };
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.current_tier).toBe(0);
  });

  it('passes through for invalid identity_tier_required value (defensive)', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 99, callerIdentityTier: 0 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    // Invalid value should not block — pass through with warning
    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });

  it('blocks tier-1 caller when tool requires tier 2', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 2, callerIdentityTier: 1 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.result as string);
    expect(parsed.error.code).toBe('IDENTITY_TIER_INSUFFICIENT');
    expect(parsed.error.required_tier).toBe(2);
    expect(parsed.error.current_tier).toBe(1);
  });

  it('allows tier-0 caller when tool requires tier 0', async () => {
    const middleware = createIdentityTierGateMiddleware();
    const ctx = buildContext({ identityTierRequired: 0, callerIdentityTier: 0 });
    const next = vi.fn(successNext);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledWith(ctx);
    expect(result.result).toBe('tool-executed-successfully');
  });
});
