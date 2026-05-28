/**
 * Experiment Eligibility — Pure Function Tests
 *
 * Tests `checkSessionEligibility` from experiment-assignment.ts
 * covering all ineligibility reasons and edge cases.
 *
 * No mocks needed — all functions under test are pure.
 */

import { describe, expect, it } from 'vitest';
import {
  checkSessionEligibility,
  type CachedExperiment,
} from '../services/experiment-assignment.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeCachedExperiment(overrides: Partial<CachedExperiment> = {}): CachedExperiment {
  return {
    experimentId: 'exp-elig-1',
    controlVersion: 'v1',
    experimentVersion: 'v2',
    trafficSplit: 0.5,
    channels: [],
    ...overrides,
  };
}

// ─── checkSessionEligibility ────────────────────────────────────────────

describe('checkSessionEligibility', () => {
  it('UNIT-2: studio session → ineligible (studio_session)', () => {
    const result = checkSessionEligibility(
      { source: { type: 'studio' }, parentId: null, channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('studio_session');
    }
  });

  it('UNIT-3: voice channel with experiment.channels=["web"] → ineligible (channel_excluded)', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'voice' },
      makeCachedExperiment({ channels: ['web'] }),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('channel_excluded');
    }
  });

  it('UNIT-3b: empty channels array → eligible for any channel', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'voice' },
      makeCachedExperiment({ channels: [] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('UNIT-3b: empty channels array → eligible for sms channel', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'sms' },
      makeCachedExperiment({ channels: [] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('UNIT-4: A2A child (parentId set) → ineligible (a2a_child)', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: 'parent-123', channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('a2a_child');
    }
  });

  it('eligible session — no parentId, not studio, channel matches', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'web' },
      makeCachedExperiment({ channels: ['web', 'voice'] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('eligible session — channel source with matching channel', () => {
    const result = checkSessionEligibility(
      { source: { type: 'channel' }, parentId: null, channel: 'voice' },
      makeCachedExperiment({ channels: ['web', 'voice'] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  // ─── Priority ordering tests ──────────────────────────────────────────

  it('studio check takes priority over parentId check', () => {
    // Both studio AND has parentId — studio should win
    const result = checkSessionEligibility(
      { source: { type: 'studio' }, parentId: 'parent-456', channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('studio_session');
    }
  });

  it('parentId check takes priority over channel check', () => {
    // Has parentId AND channel excluded — parentId should win
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: 'parent-789', channel: 'sms' },
      makeCachedExperiment({ channels: ['web'] }),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('a2a_child');
    }
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it('null source → eligible (not studio)', () => {
    const result = checkSessionEligibility(
      { source: null as any, parentId: null, channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('channel matches first entry in allow-list → eligible', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'web' },
      makeCachedExperiment({ channels: ['web', 'voice', 'sms'] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('channel matches last entry in allow-list → eligible', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'sms' },
      makeCachedExperiment({ channels: ['web', 'voice', 'sms'] }),
    );
    expect(result).toEqual({ eligible: true });
  });
});
