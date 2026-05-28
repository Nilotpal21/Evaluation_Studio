/**
 * UT-8: PIIRecognizerRegistry.detectAllAsync — sync-only path.
 *
 * When no async recognizer is registered, detectAllAsync produces the
 * same result as detectAll.
 */

import { describe, test, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '../../platform/security/pii-recognizer-registry.js';

describe('PIIRecognizerRegistry.detectAllAsync — sync-only', () => {
  test('returns identical detections to detectAll when no async recognizers', async () => {
    const reg = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(reg);

    const text = 'email me at u@e.com or 555-12-3456';
    const sync = reg.detectAll(text);
    const asyncResult = await reg.detectAllAsync(text);

    expect(asyncResult.length).toBe(sync.length);
    expect(asyncResult.map((d) => d.type).sort()).toEqual(sync.map((d) => d.type).sort());
  });

  test('respects exemptTypes', async () => {
    const reg = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(reg);

    const text = 'u@e.com';
    const out = await reg.detectAllAsync(text, { exemptTypes: new Set(['email']) });
    expect(out).toHaveLength(0);
  });

  test('respects custom recognizer + threads recognizer name', async () => {
    const reg = new PIIRecognizerRegistry();
    reg.register(new RegexPIIRecognizer('custom-zip', ['zipcode'], /\b\d{5}\b/g, 'zipcode'), {
      permanent: true,
    });
    const out = await reg.detectAllAsync('SF 94107');
    expect(out).toHaveLength(1);
    expect(out[0].recognizer).toBe('custom-zip');
  });
});
