import { describe, expect, it } from 'vitest';

import { buildAbl } from '@/lib/arch-ai/abl-builder';

describe('abl-builder', () => {
  it('does not invent a natural-language COMPLETE block for supervisors', () => {
    const abl = buildAbl({
      name: 'RouterAgent',
      type: 'supervisor',
      handoffs: [
        {
          to: 'BillingAgent',
          when: '"billing intent"',
        },
      ],
    });

    expect(abl).toContain('HANDOFF:');
    expect(abl).not.toContain('user says goodbye or issue is resolved');
    expect(abl).not.toMatch(/^\s*COMPLETE\s*:/m);
  });

  it('skips generic constraint stubs that reference invented auth state', () => {
    const abl = buildAbl({
      name: 'SensitiveAgent',
      type: 'agent',
      suggestedConstructs: ['MEMORY', 'CONSTRAINTS'],
    });

    expect(abl).toContain('MEMORY:\n  session:');
    expect(abl).not.toContain('session_authenticated');
    expect(abl).not.toContain('\nCONSTRAINTS:');
  });

  it('keeps generated customer copy free of mechanical processing language', () => {
    const abl = buildAbl({
      name: 'SupportAgent',
      type: 'agent',
      executionMode: 'scripted',
    });

    expect(abl).toContain('RESPOND: "I am checking that now."');
    expect(abl).not.toContain('Processing your request');
  });
});
