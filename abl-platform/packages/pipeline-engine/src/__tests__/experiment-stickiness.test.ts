/**
 * Experiment Stickiness — Pure Function Tests
 *
 * Focused tests for assignment key derivation and group stickiness
 * guarantees. Verifies that the same user always lands in the same
 * experiment group regardless of session variation.
 *
 * No mocks needed — all functions under test are pure.
 */

import { describe, expect, it } from 'vitest';
import { assignExperimentGroup, getAssignmentKey } from '../services/experiment-assignment.js';

// ─── getAssignmentKey stickiness ───────────────────────────────────────

describe('getAssignmentKey stickiness', () => {
  it('UNIT-5a: same contactId, different sessionIds → same assignment key', () => {
    const contactId = 'contact-sticky-1';
    const key1 = getAssignmentKey({ contactId, _id: 'session-aaa' });
    const key2 = getAssignmentKey({ contactId, _id: 'session-bbb' });
    const key3 = getAssignmentKey({ contactId, _id: 'session-ccc' });

    expect(key1).toBe(contactId);
    expect(key2).toBe(contactId);
    expect(key3).toBe(contactId);
  });

  it('UNIT-5c: null contactId → uses sessionId as assignment key', () => {
    const key = getAssignmentKey({ contactId: null, _id: 'session-only-xyz' });
    expect(key).toBe('session-only-xyz');
  });

  it('undefined contactId → falls back to sessionId', () => {
    // contactId may be undefined (not just null) in some session shapes
    const key = getAssignmentKey({ contactId: undefined as unknown as null, _id: 'session-undef' });
    expect(key).toBe('session-undef');
  });
});

// ─── assignExperimentGroup stickiness ──────────────────────────────────

describe('assignExperimentGroup stickiness', () => {
  it('UNIT-5a: same contactId across different sessions → same group', () => {
    const contactId = 'contact-sticky-2';
    const experimentId = 'exp-stickiness-test';
    const trafficSplit = 0.5;

    // Derive assignment key from contactId (ignoring session _id)
    const key = getAssignmentKey({ contactId, _id: 'session-1' });
    const expectedGroup = assignExperimentGroup(experimentId, key, trafficSplit);

    // 10 different sessions — all should get the same group
    for (let i = 0; i < 10; i++) {
      const sessionKey = getAssignmentKey({ contactId, _id: `session-${i}` });
      const group = assignExperimentGroup(experimentId, sessionKey, trafficSplit);
      expect(group).toBe(expectedGroup);
    }
  });

  it('UNIT-5b: same contactId across 100 different sessionIds → all same group', () => {
    const contactId = 'contact-100-sessions';
    const experimentId = 'exp-100-sessions';
    const trafficSplit = 0.5;

    const groups = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const key = getAssignmentKey({ contactId, _id: `random-session-${i}-${Math.random()}` });
      const group = assignExperimentGroup(experimentId, key, trafficSplit);
      groups.add(group);
    }

    // All 100 sessions should produce the exact same group
    expect(groups.size).toBe(1);
  });

  it('UNIT-5c: null contactId sessions with same sessionId → same group', () => {
    const sessionId = 'anonymous-session-fixed';
    const experimentId = 'exp-anon';
    const trafficSplit = 0.5;

    const key = getAssignmentKey({ contactId: null, _id: sessionId });
    const group1 = assignExperimentGroup(experimentId, key, trafficSplit);
    const group2 = assignExperimentGroup(experimentId, key, trafficSplit);

    expect(group1).toBe(group2);
  });

  it('UNIT-5c: null contactId sessions with different sessionIds → may differ', () => {
    // Anonymous sessions use sessionId as key, so different sessions may get different groups
    const experimentId = 'exp-anon-diverse';
    const groups = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const key = getAssignmentKey({ contactId: null, _id: `anon-session-${i}` });
      const group = assignExperimentGroup(experimentId, key, 0.5);
      groups.add(group);
    }

    // With 50 different session IDs at 50/50 split, both groups should appear
    expect(groups.size).toBe(2);
  });

  it('UNIT-5d: two different contactIds that might hash differently → may produce different groups', () => {
    // Verify that distinct users can end up in different groups.
    const experimentId = 'exp-different-users';
    const groups = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const key = getAssignmentKey({ contactId: `user-distinct-${i}`, _id: `s-${i}` });
      const group = assignExperimentGroup(experimentId, key, 0.5);
      groups.add(group);
    }

    // With 50 different users at 50/50 split, both groups should appear
    expect(groups.size).toBe(2);
  });

  it('group assignment is stable across experiment reruns', () => {
    // The exact same inputs always produce the exact same output
    const experimentId = 'exp-stable';
    const key = 'stable-contact';
    const trafficSplit = 0.3;

    const results: string[] = [];
    for (let run = 0; run < 50; run++) {
      results.push(assignExperimentGroup(experimentId, key, trafficSplit));
    }

    // All runs produce the same result
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });
});
