/**
 * NLU Version Tracker Tests
 *
 * Tests version hash computation, change detection,
 * callback management, and initial state.
 */
import { describe, test, expect, vi } from 'vitest';
import { NLUVersionTracker } from '../../platform/nlu/enterprise/version-tracker.js';
import type { NLUIRConfig } from '../../platform/nlu/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function makeIRConfig(overrides?: Partial<NLUIRConfig>): NLUIRConfig {
  return {
    intents: [
      { name: 'book_flight', patterns: ['book a flight', 'fly to'] },
      { name: 'cancel', patterns: ['cancel', 'nevermind'] },
    ],
    categories: [{ name: 'travel', patterns: ['flight', 'hotel'] }],
    entities: [{ name: 'city', type: 'enum', values: ['NYC', 'LA', 'Chicago'] }],
    glossary: ['booking', 'reservation'],
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('NLUVersionTracker', () => {
  // =========================================================================
  // INITIAL STATE
  // =========================================================================

  describe('initial state', () => {
    test('no config → version is "none"', () => {
      const tracker = new NLUVersionTracker();
      expect(tracker.getVersion()).toBe('none');
    });

    test('with config → version is 16-char hex hash', () => {
      const tracker = new NLUVersionTracker(makeIRConfig());
      const version = tracker.getVersion();
      expect(version).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // =========================================================================
  // VERSION COMPUTATION
  // =========================================================================

  describe('version computation', () => {
    test('same config produces same version hash', () => {
      const config = makeIRConfig();
      const v1 = NLUVersionTracker.computeVersion(config);
      const v2 = NLUVersionTracker.computeVersion(config);
      expect(v1).toBe(v2);
    });

    test('different intents produce different versions', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({
        intents: [{ name: 'check_status', patterns: ['check', 'status'] }],
      });
      expect(NLUVersionTracker.computeVersion(config1)).not.toBe(
        NLUVersionTracker.computeVersion(config2),
      );
    });

    test('different entities produce different versions', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({
        entities: [{ name: 'date', type: 'date' }],
      });
      expect(NLUVersionTracker.computeVersion(config1)).not.toBe(
        NLUVersionTracker.computeVersion(config2),
      );
    });

    test('different categories produce different versions', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({
        categories: [{ name: 'support', patterns: ['help', 'issue'] }],
      });
      expect(NLUVersionTracker.computeVersion(config1)).not.toBe(
        NLUVersionTracker.computeVersion(config2),
      );
    });

    test('different models produce different versions', () => {
      const config1 = makeIRConfig({ models: { fast: 'gpt-4o-mini' } });
      const config2 = makeIRConfig({ models: { fast: 'claude-3-haiku' } });
      expect(NLUVersionTracker.computeVersion(config1)).not.toBe(
        NLUVersionTracker.computeVersion(config2),
      );
    });

    test('empty/undefined arrays are handled', () => {
      const config = makeIRConfig({
        intents: [],
        entities: [],
        categories: [],
      });
      const version = NLUVersionTracker.computeVersion(config);
      expect(version).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // =========================================================================
  // CHANGE DETECTION
  // =========================================================================

  describe('change detection', () => {
    test('checkForChanges returns false for same config', () => {
      const config = makeIRConfig();
      const tracker = new NLUVersionTracker(config);
      expect(tracker.checkForChanges(config)).toBe(false);
    });

    test('returns true for changed config, updates currentVersion', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({
        intents: [{ name: 'new_intent', patterns: ['new'] }],
      });

      const tracker = new NLUVersionTracker(config1);
      const oldVersion = tracker.getVersion();

      expect(tracker.checkForChanges(config2)).toBe(true);
      expect(tracker.getVersion()).not.toBe(oldVersion);
    });

    test('fires registered callbacks with (old, new) versions', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({
        intents: [{ name: 'new_intent', patterns: ['new'] }],
      });

      const tracker = new NLUVersionTracker(config1);
      const oldVersion = tracker.getVersion();
      const callback = vi.fn();
      tracker.onVersionChange(callback);

      tracker.checkForChanges(config2);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(oldVersion, tracker.getVersion());
    });
  });

  // =========================================================================
  // CALLBACKS
  // =========================================================================

  describe('callbacks', () => {
    test('multiple callbacks all fire in order', () => {
      const tracker = new NLUVersionTracker(makeIRConfig());
      const order: number[] = [];
      tracker.onVersionChange(() => order.push(1));
      tracker.onVersionChange(() => order.push(2));
      tracker.onVersionChange(() => order.push(3));

      tracker.checkForChanges(makeIRConfig({ intents: [{ name: 'x', patterns: ['x'] }] }));

      expect(order).toEqual([1, 2, 3]);
    });

    test('callback errors do not break tracker (silently caught)', () => {
      const tracker = new NLUVersionTracker(makeIRConfig());
      const goodCallback = vi.fn();

      tracker.onVersionChange(() => {
        throw new Error('callback boom');
      });
      tracker.onVersionChange(goodCallback);

      const changed = tracker.checkForChanges(
        makeIRConfig({ intents: [{ name: 'y', patterns: ['y'] }] }),
      );

      expect(changed).toBe(true);
      expect(goodCallback).toHaveBeenCalledOnce();
    });

    test('callbacks receive correct old and new versions', () => {
      const config1 = makeIRConfig();
      const config2 = makeIRConfig({ intents: [{ name: 'z', patterns: ['z'] }] });

      const tracker = new NLUVersionTracker(config1);
      const expectedOld = tracker.getVersion();
      const expectedNew = NLUVersionTracker.computeVersion(config2);

      let receivedOld = '';
      let receivedNew = '';
      tracker.onVersionChange((o, n) => {
        receivedOld = o;
        receivedNew = n;
      });

      tracker.checkForChanges(config2);

      expect(receivedOld).toBe(expectedOld);
      expect(receivedNew).toBe(expectedNew);
    });
  });
});
