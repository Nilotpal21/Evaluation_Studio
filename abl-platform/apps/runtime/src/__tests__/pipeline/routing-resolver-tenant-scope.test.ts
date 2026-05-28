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

describe('resolveRouting target scope validation', () => {
  it('falls through to the next rule when the matched target is out of scope', () => {
    const matches = resolveRouting(
      [makeIntent('billing')],
      [
        makeRule('CrossProjectAgent', 'intent.category == "billing"', 1),
        makeRule('BillingChild', 'intent.category == "billing"', 2),
      ],
      {},
      undefined,
      {
        classifierMode: 'gather_scoped',
        targetScope: {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          isTargetInScope: (target) => target === 'BillingChild',
        },
      },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.target).toBe('BillingChild');
  });

  it('fails closed when the tenant/project scope envelope is missing', () => {
    const matches = resolveRouting(
      [makeIntent('billing')],
      [makeRule('BillingChild', 'intent.category == "billing"')],
      {},
      undefined,
      {
        classifierMode: 'gather_scoped',
        targetScope: {
          tenantId: 'tenant-1',
          projectId: undefined,
          isTargetInScope: () => true,
        },
      },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.target).toBeNull();
  });

  it('fails closed when the resolved target is outside the scoped registry surface', () => {
    const matches = resolveRouting(
      [makeIntent('billing')],
      [makeRule('CrossProjectAgent', 'intent.category == "billing"')],
      {},
      undefined,
      {
        classifierMode: 'gather_scoped',
        targetScope: {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          isTargetInScope: () => false,
        },
      },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.target).toBeNull();
  });
});
