/**
 * Identity Tier Gate Middleware
 *
 * Blocks tool execution when the caller's identity verification tier
 * is below the tool's declared minimum. Returns a structured error
 * without calling the next middleware in the chain.
 */

import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from './tool-middleware.js';
import { createLogger } from '../../logger.js';

const log = createLogger('identity-tier-gate');

/** Valid identity tier values */
const VALID_TIERS = new Set([0, 1, 2]);

/**
 * Create middleware that gates tool execution on identity verification tier.
 *
 * Reads `ctx.tool?.identity_tier_required` for the minimum tier and
 * `ctx.metadata?.callerContext?.identityTier` for the caller's current tier.
 *
 * - If no tier requirement is set on the tool, passes through (no-op).
 * - If caller tier >= required tier, passes through.
 * - If caller tier < required tier, returns an IDENTITY_TIER_INSUFFICIENT error.
 * - If identity_tier_required is not a valid value (0, 1, 2), logs a warning and passes through.
 */
export function createIdentityTierGateMiddleware(): ToolMiddleware {
  return async (ctx: ToolCallContext, next: ToolMiddlewareNext): Promise<ToolCallResult> => {
    const requiredTier = ctx.tool?.identity_tier_required;

    // No tier requirement — pass through
    if (requiredTier === undefined || requiredTier === null) {
      return next(ctx);
    }

    // Defensive: invalid tier value — log warning and pass through
    if (!VALID_TIERS.has(requiredTier)) {
      log.warn('Invalid identity_tier_required value on tool — passing through', {
        toolName: ctx.toolName,
        identity_tier_required: requiredTier,
      });
      return next(ctx);
    }

    // Read caller's current identity tier (default to 0 = anonymous)
    const callerContext = ctx.metadata?.callerContext as { identityTier?: number } | undefined;
    const currentTier = callerContext?.identityTier ?? 0;

    // Gate: insufficient tier
    if (currentTier < requiredTier) {
      log.info('Tool execution blocked — insufficient identity tier', {
        toolName: ctx.toolName,
        requiredTier,
        currentTier,
      });
      return {
        result: JSON.stringify({
          error: {
            code: 'IDENTITY_TIER_INSUFFICIENT',
            message: `Identity tier ${requiredTier} required, current tier is ${currentTier}`,
            required_tier: requiredTier,
            current_tier: currentTier,
          },
        }),
        metadata: {},
      };
    }

    // Caller meets or exceeds required tier — proceed
    return next(ctx);
  };
}
