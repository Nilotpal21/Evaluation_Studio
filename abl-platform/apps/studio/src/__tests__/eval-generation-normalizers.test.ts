import { describe, expect, it } from 'vitest';
import {
  normalizeGeneratedPersona,
  normalizeGeneratedScenario,
} from '@/lib/eval-generation-normalizers';

describe('eval generation normalizers', () => {
  it('omits blank adversarialType for non-adversarial generated personas', () => {
    const persona = normalizeGeneratedPersona({
      name: 'Casual Customer',
      isAdversarial: false,
      adversarialType: '',
    });

    expect(persona.isAdversarial).toBe(false);
    expect(persona).not.toHaveProperty('adversarialType');
  });

  it('defaults adversarial generated personas to edge_case when the type is blank', () => {
    const persona = normalizeGeneratedPersona({
      name: 'Boundary Tester',
      isAdversarial: true,
      adversarialType: '',
    });

    expect(persona.isAdversarial).toBe(true);
    expect(persona.adversarialType).toBe('edge_case');
  });

  it('fills required scenario fields missing from AI output', () => {
    const scenario = normalizeGeneratedScenario(
      {
        name: 'Billing Follow Up',
        description: 'Resolve a billing question.',
        category: '',
        expectedMilestones: ['User explains issue', 'Agent resolves issue'],
      },
      ['BillingAgent'],
    );

    expect(scenario.category).toBe('happy_path');
    expect(scenario.entryAgent).toBe('BillingAgent');
    expect(scenario.initialMessage).toBe('I need help: Resolve a billing question.');
    expect(scenario.expectedOutcome).toBe('User explains issue; Agent resolves issue');
  });

  it('filters invalid generated agent references', () => {
    const scenario = normalizeGeneratedScenario(
      {
        entryAgent: 'UnknownAgent',
        agentPath: ['KnownAgent', 'UnknownAgent'],
      },
      ['KnownAgent'],
    );

    expect(scenario.entryAgent).toBe('KnownAgent');
    expect(scenario.agentPath).toEqual(['KnownAgent']);
  });
});
