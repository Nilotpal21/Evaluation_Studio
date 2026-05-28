/**
 * NLU Audit Hook Tests
 *
 * Tests the audit hook: disabled modes, event building,
 * fire-and-forget behavior, and metadata pass-through.
 */
import { describe, test, expect, vi } from 'vitest';
import { createAuditHook } from '../../platform/nlu/enterprise/nlu-audit.js';
import type { NLUConfig } from '../../platform/nlu/config.js';
import type { NLUAuditPort, NLUAuditEvent } from '../../platform/nlu/enterprise/interfaces.js';
import type { NLUContext } from '../../platform/nlu/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeConfig(overrides?: Partial<NLUConfig['audit']>): NLUConfig {
  return {
    fastModel: 'default',
    confidenceThreshold: 0.7,
    enableFallbacks: true,
    environment: 'production',
    cache: { enabled: false, ttlMs: 60_000, intentTtlMs: 60_000, entityTtlMs: 30_000 },
    piiRedaction: { enabled: false, redactInput: true, redactOutput: false },
    circuitBreaker: { enabled: false, failureThreshold: 5, resetTimeoutMs: 30_000 },
    audit: { enabled: true, logPredictions: true, ...overrides },
    rateLimiting: { enabled: false, maxCallsPerMinute: 1000 },
  };
}

function makeCtx(overrides?: Partial<NLUContext>): NLUContext {
  return {
    userMessage: 'I want to book a flight',
    conversationHistory: [],
    turnNumber: 1,
    conversationPhase: 'collecting',
    agentGoal: 'Book a flight',
    collectedData: {},
    ...overrides,
  };
}

function makeAuditPort(): NLUAuditPort & { calls: NLUAuditEvent[] } {
  const calls: NLUAuditEvent[] = [];
  return {
    calls,
    logPrediction: vi.fn(async (event: NLUAuditEvent) => {
      calls.push(event);
    }),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createAuditHook', () => {
  // =========================================================================
  // DISABLED
  // =========================================================================

  describe('disabled', () => {
    test('returns no-op when audit.enabled = false', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(
        makeConfig({ enabled: false, logPredictions: true }),
        port,
        'tenant-1',
      );

      await hook(makeCtx(), 'intent_detection', { intent: 'book' }, 50);
      expect(port.logPrediction).not.toHaveBeenCalled();
    });

    test('returns no-op when audit.logPredictions = false', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(
        makeConfig({ enabled: true, logPredictions: false }),
        port,
        'tenant-1',
      );

      await hook(makeCtx(), 'intent_detection', { intent: 'book' }, 50);
      expect(port.logPrediction).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // EVENT BUILDING
  // =========================================================================

  describe('event building', () => {
    test('calls auditPort.logPrediction with correct event structure', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      const result = { intent: 'book_flight', confidence: 0.92, source: 'fast' };
      await hook(makeCtx(), 'intent_detection', result, 150);

      // Wait for fire-and-forget
      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      const event = port.calls[0];
      expect(event.tenantId).toBe('tenant-1');
      expect(event.task).toBe('intent_detection');
      expect(event.prediction).toBe(result);
      expect(event.latencyMs).toBe(150);
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    test('extracts source from result as layer', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      await hook(makeCtx(), 'intent_detection', { source: 'balanced', confidence: 0.8 }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].layer).toBe('balanced');
    });

    test('extracts confidence from result', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      await hook(makeCtx(), 'intent_detection', { confidence: 0.87 }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].confidence).toBe(0.87);
    });

    test('uses unknown for layer when result has no source', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      await hook(makeCtx(), 'entity_extraction', { values: { city: 'NYC' } }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].layer).toBe('unknown');
    });

    test('uses 0 for confidence when result has no confidence', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      await hook(makeCtx(), 'entity_extraction', { values: {} }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].confidence).toBe(0);
    });
  });

  // =========================================================================
  // FIRE-AND-FORGET
  // =========================================================================

  describe('fire-and-forget', () => {
    test('audit port errors are silently caught', async () => {
      const port: NLUAuditPort = {
        logPrediction: vi.fn(() => Promise.reject(new Error('audit DB down'))),
      };
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      // Should not throw
      await hook(makeCtx(), 'intent_detection', { intent: 'book' }, 50);
    });

    test('hook resolves even when port rejects', async () => {
      const port: NLUAuditPort = {
        logPrediction: vi.fn(() => Promise.reject(new Error('fail'))),
      };
      const hook = createAuditHook(makeConfig(), port, 'tenant-1');

      const promise = hook(makeCtx(), 'intent_detection', {}, 50);
      // The hook itself returns void (fire-and-forget), should not throw
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // METADATA
  // =========================================================================

  describe('metadata', () => {
    test('passes tenantId through to event', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-xyz');

      await hook(makeCtx(), 'intent_detection', { confidence: 0.9 }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].tenantId).toBe('tenant-xyz');
    });

    test('passes configVersion through to event', async () => {
      const port = makeAuditPort();
      const hook = createAuditHook(makeConfig(), port, 'tenant-1', 'v1.2.3');

      await hook(makeCtx(), 'intent_detection', { confidence: 0.9 }, 50);

      await vi.waitFor(() => expect(port.calls).toHaveLength(1));
      expect(port.calls[0].configVersion).toBe('v1.2.3');
    });
  });
});
