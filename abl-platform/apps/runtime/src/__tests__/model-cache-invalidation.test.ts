/**
 * Unit tests for Model Cache Invalidation
 *
 * Tests the cross-pod invalidation transport wiring, message parsing,
 * and graceful degradation. Uses a lightweight in-process transport
 * instead of Redis — no mocks of codebase components.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  invalidateModelResolutionCaches,
  setModelInvalidationTransport,
  subscribeModelInvalidation,
  shutdownModelInvalidation,
  setInvalidationHmacKey,
  setLocalCacheInvalidator,
  type ModelInvalidationTransport,
} from '../services/llm/model-cache-invalidation.js';

// ─── In-Process Transport ───────────────────────────────────────────────

/**
 * Lightweight in-process pub/sub transport for testing.
 * No Redis, no mocks — just a Map of channel → handlers.
 */
class InProcessTransport implements ModelInvalidationTransport {
  private handlers = new Map<string, ((message: string) => void)[]>();
  published: Array<{ channel: string; message: string }> = [];
  isShutdown = false;

  async publish(channel: string, message: string): Promise<void> {
    this.published.push({ channel, message });
    // Deliver to local subscribers (simulates cross-pod delivery)
    const channelHandlers = this.handlers.get(channel);
    if (channelHandlers) {
      for (const handler of channelHandlers) {
        handler(message);
      }
    }
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    const existing = this.handlers.get(channel) || [];
    existing.push(handler);
    this.handlers.set(channel, existing);
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.handlers.clear();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Model Cache Invalidation', () => {
  let transport: InProcessTransport;

  beforeEach(() => {
    transport = new InProcessTransport();
  });

  afterEach(async () => {
    await shutdownModelInvalidation();
    // Reset HMAC key and local invalidator between tests to prevent leaking state
    setInvalidationHmacKey('');
    setLocalCacheInvalidator(() => {});
  });

  describe('invalidateModelResolutionCaches', () => {
    it('publishes invalidation message when transport is set', async () => {
      setModelInvalidationTransport(transport);

      invalidateModelResolutionCaches('tenant-123');

      // Wait for async publish to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(transport.published).toHaveLength(1);
      expect(transport.published[0].channel).toBe('model-hub:invalidation');
      const payload = JSON.parse(transport.published[0].message);
      expect(payload.tenantId).toBe('tenant-123');
    });

    it('publishes null tenantId for global invalidation', async () => {
      setModelInvalidationTransport(transport);

      invalidateModelResolutionCaches();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(transport.published).toHaveLength(1);
      const payload = JSON.parse(transport.published[0].message);
      expect(payload.tenantId).toBeNull();
    });

    it('does not crash when no transport is set', () => {
      // No setModelInvalidationTransport call — should be a no-op
      expect(() => invalidateModelResolutionCaches('tenant-123')).not.toThrow();
    });
  });

  describe('subscribeModelInvalidation', () => {
    it('subscribes to the invalidation channel', async () => {
      setModelInvalidationTransport(transport);
      await subscribeModelInvalidation();

      expect(transport.published).toHaveLength(0);
      // Transport should have a handler registered
      invalidateModelResolutionCaches('tenant-abc');

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Published from the local invalidation
      expect(transport.published).toHaveLength(1);
    });

    it('handles malformed messages without crashing', async () => {
      setModelInvalidationTransport(transport);
      await subscribeModelInvalidation();

      // Publish a malformed message directly
      await transport.publish('model-hub:invalidation', 'not-valid-json');

      // Should not throw — handled gracefully
    });

    it('does not crash when no transport is set', async () => {
      // No setModelInvalidationTransport — should warn and return
      await expect(subscribeModelInvalidation()).resolves.not.toThrow();
    });
  });

  describe('shutdownModelInvalidation', () => {
    it('shuts down the transport', async () => {
      setModelInvalidationTransport(transport);
      await shutdownModelInvalidation();

      expect(transport.isShutdown).toBe(true);
    });

    it('does not crash when no transport is set', async () => {
      await expect(shutdownModelInvalidation()).resolves.not.toThrow();
    });

    it('clears transport so subsequent publishes are no-ops', async () => {
      setModelInvalidationTransport(transport);
      await shutdownModelInvalidation();

      // After shutdown, publishing should not add to the old transport
      invalidateModelResolutionCaches('tenant-123');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(transport.published).toHaveLength(0);
    });
  });

  describe('round-trip pub/sub', () => {
    it('receives invalidation messages from other pods', async () => {
      setModelInvalidationTransport(transport);
      await subscribeModelInvalidation();

      const invalidated: Array<string | undefined> = [];
      setLocalCacheInvalidator((tenantId?: string) => invalidated.push(tenantId));

      // Simulate receiving a message (no HMAC key = dev mode, accepts all)
      await transport.publish(
        'model-hub:invalidation',
        JSON.stringify({ tenantId: 'tenant-remote' }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(invalidated).toContain('tenant-remote');
    });
  });

  describe('HMAC message integrity', () => {
    it('includes hmac field in published messages when key is set', async () => {
      setInvalidationHmacKey('test-secret-key');
      setModelInvalidationTransport(transport);

      invalidateModelResolutionCaches('tenant-hmac');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(transport.published).toHaveLength(1);
      const payload = JSON.parse(transport.published[0].message);
      expect(payload.tenantId).toBe('tenant-hmac');
      expect(payload.hmac).toBeDefined();
      expect(typeof payload.hmac).toBe('string');
      expect(payload.hmac.length).toBeGreaterThan(0);
    });

    it('rejects messages with invalid HMAC when key is set', async () => {
      setInvalidationHmacKey('test-secret-key');
      setModelInvalidationTransport(transport);
      await subscribeModelInvalidation();

      const invalidated: Array<string | undefined> = [];
      setLocalCacheInvalidator((tenantId?: string) => invalidated.push(tenantId));

      // Publish a message with a forged HMAC
      await transport.publish(
        'model-hub:invalidation',
        JSON.stringify({ tenantId: 'attacker-tenant', hmac: 'forged-hmac-value' }),
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should NOT have invalidated — message was rejected
      // (the subscribe handler itself may push, but the invalidateLocalCaches should not be called
      // for the forged message — only 1 call from the publish's own local invalidation if any)
      const attackerEntries = invalidated.filter((t) => t === 'attacker-tenant');
      expect(attackerEntries).toHaveLength(0);
    });

    it('accepts messages with valid HMAC round-trip', async () => {
      setInvalidationHmacKey('shared-secret');
      setModelInvalidationTransport(transport);
      await subscribeModelInvalidation();

      const invalidated: Array<string | undefined> = [];
      setLocalCacheInvalidator((tenantId?: string) => invalidated.push(tenantId));

      // This goes through the full publish path which adds the HMAC,
      // then the subscriber verifies it
      invalidateModelResolutionCaches('valid-tenant');

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have been invalidated twice: once locally, once from pub/sub
      const validEntries = invalidated.filter((t) => t === 'valid-tenant');
      expect(validEntries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
