import { describe, expect, it } from 'vitest';

import { classifyAgentMutationScope } from '@/lib/arch-ai/tools/in-project-tools';

const NO_TOPOLOGY_IMPACT = {
  topology: {
    addedEdges: [],
    removedEdges: [],
  },
};

describe('classifyAgentMutationScope', () => {
  it('keeps small section-only edits small', () => {
    expect(
      classifyAgentMutationScope({
        before: 'AGENT: LeadIntake\nGOAL: Qualify leads',
        after: 'AGENT: LeadIntake\nGOAL: Qualify leads warmly',
        impact: NO_TOPOLOGY_IMPACT,
      }),
    ).toBe('SMALL');
  });

  it('marks new agents and topology edge changes as large', () => {
    expect(
      classifyAgentMutationScope({
        before: '',
        after: 'AGENT: BillingAgent\nGOAL: Handle billing',
        isNew: true,
        impact: NO_TOPOLOGY_IMPACT,
      }),
    ).toBe('LARGE');

    expect(
      classifyAgentMutationScope({
        before: 'AGENT: LeadIntake\nGOAL: Qualify leads',
        after: 'AGENT: LeadIntake\nGOAL: Qualify leads\nHANDOFF:\n  - BillingAgent',
        impact: {
          topology: {
            addedEdges: [{ from: 'LeadIntake', to: 'BillingAgent', type: 'handoff' }],
            removedEdges: [],
          },
        },
      }),
    ).toBe('LARGE');
  });
});
