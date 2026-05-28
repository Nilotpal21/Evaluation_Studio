import { describe, expect, it } from 'vitest';
import { isGatherInterruptTrace, type GatherInterruptTrace } from '../index.js';

describe('GatherInterruptTrace', () => {
  it('accepts lexical gather interrupt traces with a finite candidate surface', () => {
    const trace = {
      detectionMode: 'lexical',
      lexicalMatchType: 'normalized',
      policyApplied: 'when_unavailable',
      candidateSurface: {
        kind: 'digression',
        size: 2,
        candidates: ['track_order', 'update_address'],
      },
    } satisfies GatherInterruptTrace;

    expect(isGatherInterruptTrace(trace)).toBe(true);
  });

  it('accepts pipeline gather interrupt traces with classifier confidence', () => {
    const trace = {
      detectionMode: 'pipeline',
      classifierConfidence: 0.91,
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 3,
        candidates: ['billing', 'returns', 'branch_locator'],
      },
    } satisfies GatherInterruptTrace;

    expect(isGatherInterruptTrace(trace)).toBe(true);
  });

  it('rejects malformed candidate surfaces and invalid confidence values', () => {
    expect(
      isGatherInterruptTrace({
        detectionMode: 'pipeline',
        classifierConfidence: 1.5,
        candidateSurface: {
          kind: 'sub_intent',
          size: 1,
          candidates: ['collect_destination', 'collect_budget'],
        },
      }),
    ).toBe(false);
  });
});
