import { describe, it, expect } from 'vitest';
import { getDocumentSymbols } from '../symbols';

describe('getDocumentSymbols', () => {
  it('returns agent symbol with sections for YAML', () => {
    const yaml = `agent: booking_agent\nmode: reasoning\ngoal: Help users\ntools:\n  - search_hotels\n  - book_room`;
    const symbols = getDocumentSymbols(yaml);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('booking_agent');
    expect(symbols[0].kind).toBe('agent');

    const toolsSection = symbols[0].children.find((c) => c.name === 'Tools');
    expect(toolsSection).toBeDefined();
    expect(toolsSection!.children).toHaveLength(2);
    expect(toolsSection!.children[0].name).toBe('search_hotels');
    expect(toolsSection!.children[0].kind).toBe('tool');
  });

  it('returns flow steps as children of Flow section', () => {
    const yaml = `agent: test\nmode: scripted\nflow:\n  steps:\n    greeting:\n      respond: Hello\n    search:\n      call: search_hotels\n    confirm:\n      respond: Done`;
    const symbols = getDocumentSymbols(yaml);
    const flowSection = symbols[0].children.find((c) => c.name === 'Flow');
    expect(flowSection).toBeDefined();
    expect(flowSection!.children).toHaveLength(3);
    expect(flowSection!.children[0].name).toBe('greeting');
    expect(flowSection!.children[0].kind).toBe('step');
  });

  it('returns constraints as children', () => {
    const yaml = `agent: test\nmode: reasoning\nconstraints:\n  - rule: "Be polite"\n    action: warn`;
    const symbols = getDocumentSymbols(yaml);
    const constraintsSection = symbols[0].children.find((c) => c.name === 'Constraints');
    expect(constraintsSection).toBeDefined();
    expect(constraintsSection!.children.length).toBeGreaterThan(0);
  });

  it('returns handoffs as children', () => {
    const yaml = `agent: test\nmode: reasoning\nhandoff:\n  - to: support_agent\n    condition: "needs_support"`;
    const symbols = getDocumentSymbols(yaml);
    const handoffSection = symbols[0].children.find((c) => c.name === 'Handoffs');
    expect(handoffSection).toBeDefined();
    expect(handoffSection!.children[0].name).toContain('support_agent');
  });

  it('returns empty array for unparseable input', () => {
    const symbols = getDocumentSymbols('');
    expect(symbols).toEqual([]);
  });
});
