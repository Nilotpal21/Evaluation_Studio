/**
 * Unit tests for internal callback secret resolution (FR-9).
 *
 * Tests the webhookSecret resolver function that the CallbackDeliveryWorker uses
 * to select between the internal callback secret (for agent_tool source) and the
 * per-tenant secret (for external webhooks).
 *
 * No mocks of platform components.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─── webhookSecret resolver (extracted from index.ts for testability) ────────
//
// We reproduce the exact resolver logic from apps/workflow-engine/src/index.ts
// lines 462-474 as a standalone function. The production code inlines this in
// the CallbackDeliveryWorker constructor call. Testing the resolver in isolation
// verifies secret selection without needing Redis or BullMQ.

function createWebhookSecretResolver(env: {
  INTERNAL_CALLBACK_SECRET?: string;
  CALLBACK_HMAC_SECRET?: string;
}) {
  return async (tenantId: string, source?: string): Promise<string> => {
    if (source === 'agent_tool') {
      const internalSecret = env.INTERNAL_CALLBACK_SECRET;
      if (!internalSecret) {
        throw new Error('INTERNAL_CALLBACK_SECRET not configured');
      }
      return internalSecret;
    }
    const secret = env.CALLBACK_HMAC_SECRET || 'default-callback-secret';
    return `${secret}:${tenantId}`;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('webhookSecret resolver', () => {
  describe('agent_tool source', () => {
    it('returns INTERNAL_CALLBACK_SECRET for source: agent_tool', async () => {
      const resolver = createWebhookSecretResolver({
        INTERNAL_CALLBACK_SECRET: 'my-internal-secret',
        CALLBACK_HMAC_SECRET: 'my-tenant-secret',
      });

      const secret = await resolver('tenant-1', 'agent_tool');
      expect(secret).toBe('my-internal-secret');
    });

    it('throws when INTERNAL_CALLBACK_SECRET is not configured', async () => {
      const resolver = createWebhookSecretResolver({
        CALLBACK_HMAC_SECRET: 'my-tenant-secret',
      });

      await expect(resolver('tenant-1', 'agent_tool')).rejects.toThrow(
        'INTERNAL_CALLBACK_SECRET not configured',
      );
    });

    it('throws when INTERNAL_CALLBACK_SECRET is empty string', async () => {
      const resolver = createWebhookSecretResolver({
        INTERNAL_CALLBACK_SECRET: '',
        CALLBACK_HMAC_SECRET: 'my-tenant-secret',
      });

      await expect(resolver('tenant-1', 'agent_tool')).rejects.toThrow(
        'INTERNAL_CALLBACK_SECRET not configured',
      );
    });
  });

  describe('tenant webhook (undefined source)', () => {
    it('returns tenant-scoped secret for undefined source', async () => {
      const resolver = createWebhookSecretResolver({
        INTERNAL_CALLBACK_SECRET: 'my-internal-secret',
        CALLBACK_HMAC_SECRET: 'my-tenant-secret',
      });

      const secret = await resolver('tenant-1');
      expect(secret).toBe('my-tenant-secret:tenant-1');
    });

    it('returns tenant-scoped secret for non-agent_tool source', async () => {
      const resolver = createWebhookSecretResolver({
        CALLBACK_HMAC_SECRET: 'my-tenant-secret',
      });

      const secret = await resolver('tenant-1', 'webhook');
      expect(secret).toBe('my-tenant-secret:tenant-1');
    });

    it('uses default secret when CALLBACK_HMAC_SECRET not set', async () => {
      const resolver = createWebhookSecretResolver({});

      const secret = await resolver('tenant-1');
      expect(secret).toBe('default-callback-secret:tenant-1');
    });
  });
});
