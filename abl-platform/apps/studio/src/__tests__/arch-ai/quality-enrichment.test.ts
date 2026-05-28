import { describe, expect, it } from 'vitest';

import { enrichAgent, sanitizeAblSections } from '@/lib/arch-ai/quality-enrichment';

describe('quality-enrichment', () => {
  it('sanitizes legacy section aliases into parser-supported sections', () => {
    const sanitized = sanitizeAblSections(`ERROR_HANDLERS:
  - TOOL: DEFAULT
    RESPOND: "Retry later"

INTENT_HANDLING:
  route: true
`);

    expect(sanitized).toContain('ON_ERROR:');
    expect(sanitized).toContain('NLU:');
    expect(sanitized).not.toContain('ERROR_HANDLERS:');
    expect(sanitized).not.toContain('INTENT_HANDLING:');
  });

  it('injects only safe canonical sections and warns instead of inventing constraints or completion', () => {
    const result = enrichAgent(
      `AGENT: SensitiveAgent
GOAL: "Help with billing issues"
PERSONA: |
  You assist carefully and clearly.
`,
      {
        name: 'SensitiveAgent',
        role: 'specialist',
        executionMode: 'reasoning',
        isEntry: false,
        tools: ['lookup_invoice'],
        gatherFields: ['invoice_id'],
      },
      { categories: ['financial'], evidence: ['Handles billing data'] },
      ['PCI'],
    );

    expect(result.injectedSections).toEqual(['GUARDRAILS', 'MEMORY', 'ON_ERROR']);
    expect(result.enrichedAbl).toContain('GUARDRAILS:\n  content_safety:');
    expect(result.enrichedAbl).toContain('MEMORY:\n  session:');
    expect(result.enrichedAbl).toContain('ON_ERROR:\n  - TOOL: DEFAULT');
    expect(result.enrichedAbl).not.toContain('user_authenticated');
    expect(result.enrichedAbl).not.toContain('issue resolved');
    expect(result.enrichedAbl).not.toContain('\nCONSTRAINTS:');
    expect(result.enrichedAbl).not.toContain('\nCOMPLETE:');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Skipped automatic CONSTRAINTS injection'),
        expect.stringContaining('Skipped automatic COMPLETE injection'),
      ]),
    );
  });
});
