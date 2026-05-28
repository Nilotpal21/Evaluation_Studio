/**
 * INT-12: PIIRecognizerRegistry capacity + permanent-flag invariant.
 *
 * After Phase 1a/1b, MAX_RECOGNIZERS = 100 and every pack recognizer
 * registers with `permanent: true`. This test pins:
 *   (a) the bumped capacity (100, not the legacy 50)
 *   (b) pack recognizers survive eviction even when 60 custom patterns
 *       are added (~45 permanent + 60 custom = 105 attempts → 5 evictions
 *       must come from the custom set, never the packs).
 */

import { describe, test, expect } from 'vitest';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerPacks,
} from '../../platform/security/index.js';

describe('INT-12: registry capacity + permanent flag', () => {
  test('MAX_RECOGNIZERS is 100 (not the legacy 50)', () => {
    const reg = new PIIRecognizerRegistry();
    for (let i = 0; i < 100; i++) {
      reg.register(new RegexPIIRecognizer(`temp-${i}`, ['custom'], /xxxxxxxx/g, 'custom'));
    }
    expect(reg.getRecognizerCount()).toBe(100);

    // 101st registration triggers exactly one eviction
    reg.register(new RegexPIIRecognizer('temp-100', ['custom'], /yyyyyyyy/g, 'custom'));
    expect(reg.getRecognizerCount()).toBe(100);
    // The first non-permanent (temp-0) was evicted
    expect(reg.get('temp-0')).toBeUndefined();
    expect(reg.get('temp-100')).toBeDefined();
  });

  test('packs registered with permanent: true survive heavy custom-pattern load', () => {
    const reg = new PIIRecognizerRegistry();
    // Register all 8 packs (~45 permanent recognizers across them)
    registerPacks(
      ['core', 'us', 'eu', 'apac', 'financial', 'medical', 'network', 'international-phone'],
      reg,
    );
    const packCount = reg.getRecognizerCount();
    expect(packCount).toBeGreaterThan(30);
    expect(packCount).toBeLessThanOrEqual(100);

    // Add custom patterns up to (and beyond) the capacity
    const customCount = 100 - packCount + 10; // intentionally overflow by 10
    for (let i = 0; i < customCount; i++) {
      reg.register(
        new RegexPIIRecognizer(`custom-${i}`, ['custom'], new RegExp(`xx${i}xx`, 'g'), 'custom'),
      );
    }

    // Cap holds and packs were not evicted
    expect(reg.getRecognizerCount()).toBe(100);
    expect(reg.get('core-email')).toBeDefined();
    expect(reg.get('eu-iban')).toBeDefined();
    expect(reg.get('in-aadhaar')).toBeDefined();
    expect(reg.get('intl-phone')).toBeDefined();
  });

  test('unregister of permanent recognizer is rejected', () => {
    const reg = new PIIRecognizerRegistry();
    registerPacks(['core'], reg);
    expect(reg.unregister('core-email')).toBe(false);
    expect(reg.get('core-email')).toBeDefined();
  });
});
