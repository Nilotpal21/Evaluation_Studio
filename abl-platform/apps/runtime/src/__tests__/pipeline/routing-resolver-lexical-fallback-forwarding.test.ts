import { describe, expect, it } from 'vitest';
import { resolveRouting } from '../../services/pipeline/routing-resolver.js';
import type { ClassifiedIntent } from '../../services/pipeline/types.js';
import type { RoutingRule } from '@abl/compiler/platform/ir/schema.js';

function makeIntent(category: string | null, confidence = 0.9, summary = 'test'): ClassifiedIntent {
  return { category, confidence, summary };
}

function makeRule(to: string, when: string, priority = 1): RoutingRule {
  return { to, when, description: `Route to ${to}`, priority };
}

const gatherInterrupt = {
  candidateSurface: {
    kind: 'parent_supervisor_route' as const,
    size: 1,
    candidates: ['branch_locator'],
  },
  policyApplied: 'always' as const,
};

describe('resolveRouting gather metadata forwarding', () => {
  it('forwards lexical fallback policy and candidate surface on matched routes', () => {
    const matches = resolveRouting(
      [makeIntent('branch_locator')],
      [makeRule('BranchLocatorChild', 'intent.category == "branch_locator"')],
      {},
      undefined,
      {
        classifierMode: 'gather_scoped',
        gatherInterrupt,
      },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      target: 'BranchLocatorChild',
      gatherInterrupt,
    });
  });

  it('keeps gather metadata available when no route matches', () => {
    const matches = resolveRouting(
      [makeIntent('branch_locator')],
      [makeRule('BillingChild', 'intent.category == "billing"')],
      {},
      undefined,
      {
        classifierMode: 'gather_scoped',
        gatherInterrupt,
      },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.target).toBeNull();
    expect(matches[0]?.gatherInterrupt).toEqual(gatherInterrupt);
  });
});
