/**
 * INT-13: recognizer-throw containment.
 *
 * A recognizer that throws on a particular input must not propagate;
 * other recognizers' detections are returned, the registry logs the
 * error, and (when used through detectAllAsync) onDegraded fires.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  PIIRecognizerRegistry,
  type PIIRecognizer,
  registerPacks,
} from '../../platform/security/index.js';

describe('INT-13: recognizer-throw containment', () => {
  test('detectAll: exception in one recognizer does not break others', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);

    const throwing: PIIRecognizer = {
      name: 'angry-rec',
      supportedTypes: ['nope'],
      tier: 'custom',
      detect: () => {
        throw new Error('boom');
      },
    };
    reg.register(throwing);

    const out = reg.detectAll('email me at u@e.com');
    // Other recognizers still produce detections (email)
    expect(out.find((d) => d.type === 'email')).toBeDefined();
    // Throwing recognizer does not propagate
    expect(out.find((d) => d.type === 'nope')).toBeUndefined();
  });

  test('detectAllAsync: async exception fires onDegraded with recognizer_threw', async () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);

    const throwingAsync: PIIRecognizer = {
      name: 'angry-cloud',
      supportedTypes: ['cloud_pii'],
      tier: 'ml',
      detect: () => [],
      detectAsync: async () => {
        throw new Error('boom');
      },
    };
    reg.register(throwingAsync);

    const onDegraded = vi.fn();
    const out = await reg.detectAllAsync('u@e.com', { latencyBudgetMs: 200, onDegraded });
    expect(out.find((d) => d.type === 'email')).toBeDefined();
    expect(onDegraded).toHaveBeenCalledWith('recognizer_threw', 'angry-cloud');
  });
});
