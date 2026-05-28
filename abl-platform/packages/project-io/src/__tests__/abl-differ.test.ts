import { describe, it, expect } from 'vitest';
import { diffABL } from '../diff/abl-differ.js';

const BEFORE = `AGENT: TestAgent
VERSION: "1.0"

GOAL: "Original goal"

TOOLS:
  search(q: string) -> string
    description: "Search"

COMPLETE:
  - WHEN: done == true
    RESPOND: "Done"`;

const AFTER_GOAL_CHANGED = `AGENT: TestAgent
VERSION: "1.0"

GOAL: "Updated goal"

TOOLS:
  search(q: string) -> string
    description: "Search"

COMPLETE:
  - WHEN: done == true
    RESPOND: "Done"`;

describe('diffABL', () => {
  it('should detect single section modification', () => {
    const result = diffABL(BEFORE, AFTER_GOAL_CHANGED);

    expect(result.hasChanges).toBe(true);
    expect(result.summary.modified).toEqual(['GOAL']);
    expect(result.summary.unchanged).toContain('AGENT');
    expect(result.summary.unchanged).toContain('VERSION');
    expect(result.summary.unchanged).toContain('TOOLS');
    expect(result.summary.unchanged).toContain('COMPLETE');
  });

  it('should detect added sections', () => {
    const after = BEFORE + '\n\nMEMORY:\n  session:\n    - test_var';
    const result = diffABL(BEFORE, after);

    expect(result.hasChanges).toBe(true);
    expect(result.summary.added).toEqual(['MEMORY']);
  });

  it('should detect removed sections', () => {
    const after = `AGENT: TestAgent
VERSION: "1.0"

GOAL: "Original goal"

COMPLETE:
  - WHEN: done == true
    RESPOND: "Done"`;

    const result = diffABL(BEFORE, after);
    expect(result.hasChanges).toBe(true);
    expect(result.summary.removed).toEqual(['TOOLS']);
  });

  it('should report no changes for identical content', () => {
    const result = diffABL(BEFORE, BEFORE);
    expect(result.hasChanges).toBe(false);
    expect(result.summary.modified).toHaveLength(0);
    expect(result.summary.added).toHaveLength(0);
    expect(result.summary.removed).toHaveLength(0);
  });

  it('should handle empty before (new file)', () => {
    const result = diffABL('', BEFORE);
    expect(result.hasChanges).toBe(true);
    expect(result.summary.added.length).toBeGreaterThan(0);
  });

  it('should handle empty after (deleted file)', () => {
    const result = diffABL(BEFORE, '');
    expect(result.hasChanges).toBe(true);
    expect(result.summary.removed.length).toBeGreaterThan(0);
  });
});
