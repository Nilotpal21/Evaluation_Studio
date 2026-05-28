import { describe, expect, it } from 'vitest';
import { computeChangedSections } from '@/lib/arch-ai/compute-changed-sections';

const BEFORE = `AGENT: LeadIntake
GOAL: "Capture new leads"
PERSONA: |
  Be friendly.
TOOLS:
  lookup_lead:
    description: "Look up a lead"
    HTTP:
      url: "{{API}}/leads"
      method: GET
`;

const AFTER_GOAL_CHANGED = BEFORE.replace('"Capture new leads"', '"Capture and qualify new leads"');

const AFTER_TWO_SECTIONS_CHANGED = BEFORE.replace(
  '"Capture new leads"',
  '"Capture and qualify new leads"',
).replace('Be friendly.', 'Be friendly and professional.');

describe('computeChangedSections', () => {
  it('returns empty array when inputs are identical', () => {
    const result = computeChangedSections(BEFORE, BEFORE);
    expect(result).toEqual([]);
  });

  it('detects a single changed section', () => {
    const result = computeChangedSections(BEFORE, AFTER_GOAL_CHANGED);
    const sectionNames = result.map((s) => s.name);
    expect(sectionNames).toContain('GOAL');
    expect(sectionNames).not.toContain('TOOLS');
  });

  it('detects multiple changed sections', () => {
    const result = computeChangedSections(BEFORE, AFTER_TWO_SECTIONS_CHANGED);
    const sectionNames = result.map((s) => s.name);
    expect(sectionNames).toContain('GOAL');
    expect(sectionNames).toContain('PERSONA');
    expect(sectionNames).not.toContain('TOOLS');
  });

  it('returns jump targets with 1-indexed line numbers matching Monaco', () => {
    const result = computeChangedSections(BEFORE, AFTER_GOAL_CHANGED);
    const goal = result.find((s) => s.name === 'GOAL');
    expect(goal).toBeDefined();
    expect(typeof goal?.beforeStartLine).toBe('number');
    expect(typeof goal?.afterStartLine).toBe('number');
    expect(goal?.beforeStartLine).toBe(2);
    expect(goal?.afterStartLine).toBe(2);
  });

  it('sorts results by afterStartLine ascending', () => {
    const result = computeChangedSections(BEFORE, AFTER_TWO_SECTIONS_CHANGED);
    const lines = result.map((s) => s.afterStartLine);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toBeGreaterThanOrEqual(lines[i - 1]);
    }
  });
});
