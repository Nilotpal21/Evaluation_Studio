/**
 * INT-5: detectAllAsync with synthetic async recognizer.
 *
 * Asserts:
 *   (a) wall time bounded by latencyBudgetMs + slack on timeout
 *   (b) only sync detections returned when async times out
 *   (c) onDegraded fires once with reason 'async_budget_exceeded'
 *   (d) timer is cleared on success path (no unhandled state)
 */

import { describe, test, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  type PIIRecognizer,
  registerBuiltInRecognizers,
} from '../../platform/security/pii-recognizer-registry.js';
import { createSafePIIDetection } from '../../platform/security/pii-detector.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('detectAllAsync (INT-5)', () => {
  test('async timeout: returns only sync detections, fires onDegraded', async () => {
    const reg = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(reg);

    const slowRecognizer: PIIRecognizer = {
      name: 'slow-pretend-cloud',
      supportedTypes: ['cloud_pii'],
      tier: 'ml',
      detect: () => [],
      detectAsync: async (text: string) => {
        await sleep(300);
        return [
          createSafePIIDetection('cloud_pii', 0, text.length, { recognizer: 'slow-pretend-cloud' }),
        ];
      },
    };
    reg.register(slowRecognizer);

    const reasons: string[] = [];
    const t0 = Date.now();
    const out = await reg.detectAllAsync('email me at u@e.com', {
      latencyBudgetMs: 50,
      onDegraded: (reason) => reasons.push(reason),
    });
    const elapsed = Date.now() - t0;

    // (a) wall time bounded
    expect(elapsed).toBeLessThan(150);
    // (b) sync detections present, no cloud_pii
    expect(out.length).toBeGreaterThan(0);
    expect(out.find((d) => d.type === 'cloud_pii')).toBeUndefined();
    // (c) onDegraded fired once with the timeout reason
    expect(reasons).toEqual(['async_budget_exceeded']);
  });

  test('async success: cloud detections merged with sync', async () => {
    const reg = new PIIRecognizerRegistry();

    const fastRecognizer: PIIRecognizer = {
      name: 'fast-pretend-cloud',
      supportedTypes: ['cloud_pii'],
      tier: 'ml',
      detect: () => [],
      detectAsync: async () => [
        createSafePIIDetection('cloud_pii', 100, 110, { recognizer: 'fast-pretend-cloud' }),
      ],
    };
    reg.register(fastRecognizer);

    const out = await reg.detectAllAsync('x'.repeat(120), { latencyBudgetMs: 200 });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('cloud_pii');
  });

  test('async exception: returns sync only, fires onDegraded with recognizer_threw', async () => {
    const reg = new PIIRecognizerRegistry();

    const throwingRecognizer: PIIRecognizer = {
      name: 'angry-cloud',
      supportedTypes: ['cloud_pii'],
      tier: 'ml',
      detect: () => [],
      detectAsync: async () => {
        throw new Error('boom');
      },
    };
    reg.register(throwingRecognizer);

    const reasons: string[] = [];
    const out = await reg.detectAllAsync('hello', {
      latencyBudgetMs: 200,
      onDegraded: (reason) => reasons.push(reason),
    });
    expect(out).toHaveLength(0);
    expect(reasons).toEqual(['recognizer_threw']);
  });

  test('budget timer cleanup: success path leaves no orphan rejections', async () => {
    const reg = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(reg);

    const fastRecognizer: PIIRecognizer = {
      name: 'fast2',
      supportedTypes: ['cloud_pii'],
      tier: 'ml',
      detect: () => [],
      detectAsync: async () => [],
    };
    reg.register(fastRecognizer);

    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.once('unhandledRejection', handler);
    await reg.detectAllAsync('hello u@e.com', { latencyBudgetMs: 5_000 });
    await sleep(20);
    process.removeListener('unhandledRejection', handler);
    expect(unhandled).toBe(false);
  });
});
