import { describe, it, expect } from 'vitest';
import { getDiagnostics } from '../diagnostics';

describe('getDiagnostics', () => {
  it('returns no diagnostics for valid YAML ABL', () => {
    const yaml = `agent: booking\ngoal: Help users`;
    const diags = getDiagnostics(yaml);
    expect(diags).toHaveLength(0);
  });

  it('returns error diagnostics for invalid YAML syntax', () => {
    const yaml = `agent: booking\nmode: [invalid yaml`;
    const diags = getDiagnostics(yaml);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].source).toBe('syntax');
  });

  it('returns diagnostics with valid severity for minimal agent', () => {
    const yaml = `agent: test\ngoal: Help`;
    const diags = getDiagnostics(yaml);
    for (const d of diags) {
      expect(['error', 'warning', 'info', 'hint']).toContain(d.severity);
      expect(typeof d.message).toBe('string');
      expect(typeof d.line).toBe('number');
    }
  });

  it('includes compile diagnostics when compileFn is provided', () => {
    const yaml = `agent: test\ngoal: Help`;
    const mockCompileFn = () => [
      {
        severity: 'error' as const,
        message: 'Missing goal',
        line: 1,
        column: 1,
        source: 'compile',
      },
    ];
    const diags = getDiagnostics(yaml, { compileFn: mockCompileFn });
    expect(diags.some((d) => d.source === 'compile')).toBe(true);
  });

  it('parses legacy format without throwing', () => {
    const legacy = `AGENT: booking\nGOAL:\n  Help users
GOAL: "Handle agent tasks"`;
    const diags = getDiagnostics(legacy);
    // Legacy format should parse — any diagnostics should have valid structure
    for (const d of diags) {
      expect(['error', 'warning', 'info', 'hint']).toContain(d.severity);
      expect(typeof d.message).toBe('string');
    }
  });
});
