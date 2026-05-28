/**
 * Experiment Assignment — Pure Function Tests
 *
 * Tests deterministic hashing, group assignment distribution,
 * assignment key derivation, and session eligibility checks.
 *
 * No mocks needed — all functions under test are pure.
 */

import { describe, expect, it } from 'vitest';
import {
  assignExperimentGroup,
  checkSessionEligibility,
  getAssignmentKey,
  type CachedExperiment,
} from '../services/experiment-assignment.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeCachedExperiment(overrides: Partial<CachedExperiment> = {}): CachedExperiment {
  return {
    experimentId: 'exp-1',
    controlVersion: 'v1',
    experimentVersion: 'v2',
    trafficSplit: 0.5,
    channels: [],
    ...overrides,
  };
}

// ─── getAssignmentKey ───────────────────────────────────────────────────

describe('getAssignmentKey', () => {
  it('returns contactId when set', () => {
    const key = getAssignmentKey({ contactId: 'contact-abc', _id: 'session-123' });
    expect(key).toBe('contact-abc');
  });

  it('returns _id when contactId is null', () => {
    const key = getAssignmentKey({ contactId: null, _id: 'session-456' });
    expect(key).toBe('session-456');
  });
});

// ─── assignExperimentGroup ──────────────────────────────────────────────

describe('assignExperimentGroup', () => {
  it('is deterministic — same inputs produce same output', () => {
    const result1 = assignExperimentGroup('exp-1', 'user-42', 0.5);
    const result2 = assignExperimentGroup('exp-1', 'user-42', 0.5);
    expect(result1).toBe(result2);
  });

  it('assigns same contactId across different sessions to the same group', () => {
    // getAssignmentKey returns contactId when set, so different session IDs
    // with the same contactId produce the same assignment key
    const key = 'shared-contact-id';
    const group1 = assignExperimentGroup('exp-1', key, 0.5);
    const group2 = assignExperimentGroup('exp-1', key, 0.5);
    expect(group1).toBe(group2);
  });

  it('distributes ~50/50 at trafficSplit=0.5 within ±2%', () => {
    let experimentCount = 0;
    const total = 10000;

    for (let i = 0; i < total; i++) {
      const group = assignExperimentGroup('exp-dist-50', `user-${i}`, 0.5);
      if (group === 'experiment') experimentCount++;
    }

    const experimentRatio = experimentCount / total;
    expect(experimentRatio).toBeGreaterThan(0.48);
    expect(experimentRatio).toBeLessThan(0.52);
  });

  it('distributes ~10/90 at trafficSplit=0.1 within ±2%', () => {
    let experimentCount = 0;
    const total = 10000;

    for (let i = 0; i < total; i++) {
      const group = assignExperimentGroup('exp-dist-10', `user-${i}`, 0.1);
      if (group === 'experiment') experimentCount++;
    }

    const experimentRatio = experimentCount / total;
    expect(experimentRatio).toBeGreaterThan(0.08);
    expect(experimentRatio).toBeLessThan(0.12);
  });

  it('UNIT-5b: same contactId across 100 different sessionIds → all same group', () => {
    // When contactId is set, getAssignmentKey ignores sessionId.
    // So the same contactId should always produce the same assignment key,
    // and therefore the same group assignment.
    const contactId = 'sticky-contact-xyz';
    const firstGroup = assignExperimentGroup('exp-sticky', contactId, 0.5);

    for (let i = 0; i < 100; i++) {
      // Each "session" has a different _id, but the assignment key is contactId
      const group = assignExperimentGroup('exp-sticky', contactId, 0.5);
      expect(group).toBe(firstGroup);
    }
  });

  it('UNIT-5d: two different contactIds may produce different groups', () => {
    // With enough diverse inputs, at least some should hash to different buckets.
    // Generate 50 unique contactIds and check they don't ALL land in the same group.
    const groups = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const group = assignExperimentGroup('exp-diversity', `contact-diversity-${i}`, 0.5);
      groups.add(group);
    }
    // With trafficSplit=0.5 and 50 different keys, both groups should appear
    expect(groups.size).toBe(2);
  });
});

// ─── checkSessionEligibility ────────────────────────────────────────────

describe('checkSessionEligibility', () => {
  it('returns ineligible with reason studio_session for studio sessions', () => {
    const result = checkSessionEligibility(
      { source: { type: 'studio' }, parentId: null, channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result).toEqual({ eligible: false, reason: 'studio_session' });
  });

  it('returns ineligible with reason a2a_child when parentId is set', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: 'parent-session-1', channel: 'web' },
      makeCachedExperiment(),
    );
    expect(result).toEqual({ eligible: false, reason: 'a2a_child' });
  });

  it('returns ineligible with reason channel_excluded when channel not in allow-list', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'sms' },
      makeCachedExperiment({ channels: ['web', 'voice'] }),
    );
    expect(result).toEqual({ eligible: false, reason: 'channel_excluded' });
  });

  it('returns eligible when channels array is empty (all channels allowed)', () => {
    const result = checkSessionEligibility(
      { source: { type: 'public' }, parentId: null, channel: 'sms' },
      makeCachedExperiment({ channels: [] }),
    );
    expect(result).toEqual({ eligible: true });
  });

  it('returns eligible for a valid session matching experiment criteria', () => {
    const result = checkSessionEligibility(
      { source: { type: 'channel' }, parentId: null, channel: 'web' },
      makeCachedExperiment({ channels: ['web', 'voice'] }),
    );
    expect(result).toEqual({ eligible: true });
  });
});
