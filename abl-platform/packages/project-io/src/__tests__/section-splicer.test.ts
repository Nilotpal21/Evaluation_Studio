import { describe, it, expect, vi } from 'vitest';
import { identifySections, spliceSection, spliceSections } from '../diff/section-splicer.js';

const SAMPLE_ABL = `AGENT: TestAgent
VERSION: "1.0"
DESCRIPTION: "A test agent"

GOAL: "Help users with testing"

PERSONA: |
  Friendly test assistant.
  Always helpful.

TOOLS:
  search(query: string) -> {results: object[]}
    description: "Search for items"

CONSTRAINTS:
  always:
    - REQUIRE user.authenticated == true
      ON_FAIL: "Please authenticate first"

COMPLETE:
  - WHEN: task_done == true
    RESPOND: "Done!"`;

describe('identifySections', () => {
  it('should identify all top-level sections', () => {
    const sections = identifySections(SAMPLE_ABL);
    const names = sections.map((s) => s.name);

    expect(names).toEqual([
      'AGENT',
      'VERSION',
      'DESCRIPTION',
      'GOAL',
      'PERSONA',
      'TOOLS',
      'CONSTRAINTS',
      'COMPLETE',
    ]);
  });

  it('should set correct start and end lines', () => {
    const sections = identifySections(SAMPLE_ABL);
    const agent = sections.find((s) => s.name === 'AGENT')!;
    expect(agent.startLine).toBe(0);

    const version = sections.find((s) => s.name === 'VERSION')!;
    expect(version.startLine).toBe(1);

    const persona = sections.find((s) => s.name === 'PERSONA')!;
    const tools = sections.find((s) => s.name === 'TOOLS')!;
    // PERSONA section ends right before TOOLS
    expect(persona.endLine).toBe(tools.startLine - 1);
  });

  it('should handle last section ending at EOF', () => {
    const sections = identifySections(SAMPLE_ABL);
    const complete = sections.find((s) => s.name === 'COMPLETE')!;
    const lines = SAMPLE_ABL.split('\n');
    expect(complete.endLine).toBe(lines.length - 1);
  });

  it('should handle empty content', () => {
    expect(identifySections('')).toEqual([]);
  });

  it('should treat ACTION_HANDLERS as a top-level section boundary', () => {
    const content = `AGENT: ActionAgent

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose"
  THEN: COMPLETE

ACTION_HANDLERS:
  approve:
    DO:
      - RESPOND: "Approved"

DELEGATE:
  - AGENT: EscalationAgent
    WHEN: true
    PURPOSE: "Escalate"`;

    const sections = identifySections(content);
    const names = sections.map((section) => section.name);

    expect(names).toEqual(['AGENT', 'FLOW', 'ACTION_HANDLERS', 'DELEGATE']);

    const flow = sections.find((section) => section.name === 'FLOW')!;
    const actionHandlers = sections.find((section) => section.name === 'ACTION_HANDLERS')!;
    expect(flow.endLine).toBe(actionHandlers.startLine - 1);
  });
});

describe('spliceSection', () => {
  it('should replace a section and leave all others byte-identical', () => {
    const newGoal = 'GOAL: "Updated goal for testing"';
    const result = spliceSection(SAMPLE_ABL, 'GOAL', newGoal);

    // Verify new goal is present
    expect(result).toContain('GOAL: "Updated goal for testing"');

    // Verify other sections are byte-identical
    const originalLines = SAMPLE_ABL.split('\n');
    const resultLines = result.split('\n');

    const goalSections = identifySections(SAMPLE_ABL);
    const goalSection = goalSections.find((s) => s.name === 'GOAL')!;

    // Lines before GOAL section
    for (let i = 0; i < goalSection.startLine; i++) {
      expect(resultLines[i]).toBe(originalLines[i]);
    }
  });

  it('should remove a section when content is null', () => {
    const result = spliceSection(SAMPLE_ABL, 'CONSTRAINTS', null);
    expect(result).not.toContain('CONSTRAINTS:');
    expect(result).toContain('AGENT: TestAgent');
    expect(result).toContain('COMPLETE:');
  });

  it('should add a missing section at canonical position', () => {
    const newMemory = 'MEMORY:\n  session:\n    - current_task';
    const result = spliceSection(SAMPLE_ABL, 'MEMORY', newMemory);
    expect(result).toContain('MEMORY:');

    // MEMORY should appear after GATHER (or TOOLS if no GATHER) and before CONSTRAINTS
    const sections = identifySections(result);
    const memoryIdx = sections.findIndex((s) => s.name === 'MEMORY');
    const constraintsIdx = sections.findIndex((s) => s.name === 'CONSTRAINTS');
    expect(memoryIdx).toBeLessThan(constraintsIdx);
  });

  it('should add CONVERSATION before BEHAVIOR_PROFILE definitions', () => {
    const content = `${SAMPLE_ABL}\n\nBEHAVIOR_PROFILE: voice_mode\nPRIORITY: 10\nWHEN: true\n`;
    const result = spliceSection(
      content,
      'CONVERSATION',
      'CONVERSATION:\n  speaking:\n    style: "warm and concise"',
    );

    const conversationIdx = result.indexOf('CONVERSATION:');
    const profileIdx = result.indexOf('BEHAVIOR_PROFILE: voice_mode');
    expect(conversationIdx).toBeGreaterThan(-1);
    expect(profileIdx).toBeGreaterThan(-1);
    expect(conversationIdx).toBeLessThan(profileIdx);
  });

  it('should replace inline USE BEHAVIOR_PROFILE lines as a virtual BEHAVIOR section', () => {
    const content = `${SAMPLE_ABL}\n\nUSE BEHAVIOR_PROFILE: voice_mode\nUSE BEHAVIOR_PROFILE: whatsapp_adaptation\n`;
    const result = spliceSection(content, 'BEHAVIOR', 'USE BEHAVIOR_PROFILE: concierge_mode');

    expect(result).toContain('USE BEHAVIOR_PROFILE: concierge_mode');
    expect(result).not.toContain('USE BEHAVIOR_PROFILE: voice_mode');
    expect(result).not.toContain('USE BEHAVIOR_PROFILE: whatsapp_adaptation');
  });

  it('should return original content when removing non-existent section', () => {
    const result = spliceSection(SAMPLE_ABL, 'NONEXISTENT', null);
    expect(result).toBe(SAMPLE_ABL);
  });

  it('should preserve comments within sections', () => {
    const contentWithComments = `AGENT: TestAgent

# This is a comment about the goal
GOAL: "Original goal"

TOOLS:
  # Internal tool
  search(q: string) -> string
    description: "Search"`;

    const result = spliceSection(
      contentWithComments,
      'TOOLS',
      'TOOLS:\n  new_tool() -> string\n    description: "New"',
    );
    expect(result).toContain('# This is a comment about the goal');
  });

  it('should preserve ACTION_HANDLERS that follow FLOW when FLOW is replaced', () => {
    const content = `AGENT: ActionAgent

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose"
  THEN: COMPLETE

ACTION_HANDLERS:
  approve:
    DO:
      - RESPOND: "Approved"

DELEGATE:
  - AGENT: EscalationAgent
    WHEN: true
    PURPOSE: "Escalate"`;

    const result = spliceSection(
      content,
      'FLOW',
      `FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Updated flow"
  THEN: COMPLETE`,
    );

    expect(result).toContain('FLOW:');
    expect(result).toContain('RESPOND: "Updated flow"');
    expect(result).toContain('ACTION_HANDLERS:');
    expect(result).toContain('RESPOND: "Approved"');
    expect(result).toContain('DELEGATE:');
  });
});

describe('spliceSections', () => {
  it('should apply multiple edits', () => {
    const result = spliceSections(SAMPLE_ABL, [
      { section: 'GOAL', content: 'GOAL: "New goal"' },
      { section: 'DESCRIPTION', content: 'DESCRIPTION: "Updated description"' },
    ]);

    expect(result).toContain('GOAL: "New goal"');
    expect(result).toContain('DESCRIPTION: "Updated description"');
    // Unchanged sections still present
    expect(result).toContain('PERSONA: |');
    expect(result).toContain('TOOLS:');
  });

  it('should handle mixed add/remove/replace', () => {
    const result = spliceSections(SAMPLE_ABL, [
      { section: 'CONSTRAINTS', content: null }, // remove
      { section: 'MEMORY', content: 'MEMORY:\n  session:\n    - x' }, // add
      { section: 'GOAL', content: 'GOAL: "Changed"' }, // replace
    ]);

    expect(result).not.toContain('CONSTRAINTS:');
    expect(result).toContain('MEMORY:');
    expect(result).toContain('GOAL: "Changed"');
  });

  it('should treat FULL edits as whole-document replacements', () => {
    const replacement = `AGENT: ReplacementAgent
GOAL: "Use the replacement document"
FLOW:
  entry_point: done
  steps:
    - done`;

    const result = spliceSections(SAMPLE_ABL, [{ section: 'FULL', content: replacement }]);

    expect(result).toBe(replacement);
  });
});

// ─── Lowercase Header Tests ────────────────────────────────────────────────

describe('identifySections lowercase headers', () => {
  it('should handle lowercase section headers', () => {
    const content = 'agent: TestAgent\ngoal: "Help users"\n';
    const sections = identifySections(content);
    expect(sections.length).toBe(2);
    // Verify the section names preserve original casing from the regex capture
    const names = sections.map((s) => s.name);
    expect(names).toContain('agent');
    expect(names).toContain('goal');
  });
});

// ─── CRLF Multi-Edit Tests ─────────────────────────────────────────────────

describe('spliceSections CRLF handling', () => {
  const CRLF_ABL =
    'AGENT: TestAgent\r\nVERSION: "1.0"\r\n\r\nGOAL: "Help"\r\n\r\nTOOLS:\r\n  search() -> string\r\n\r\nCONSTRAINTS:\r\n  always:\r\n    - REQUIRE true\r\n';

  it('should preserve CRLF line endings in multi-edit', () => {
    const result = spliceSections(CRLF_ABL, [
      { section: 'GOAL', content: 'GOAL: "New goal"' },
      { section: 'VERSION', content: 'VERSION: "2.0"' },
    ]);

    expect(result).toContain('\r\n');
    expect(result).toContain('GOAL: "New goal"');
    expect(result).toContain('VERSION: "2.0"');
  });

  it('should keep LF content as LF in multi-edit', () => {
    const lfContent = 'AGENT: TestAgent\nGOAL: "Help"\n\nTOOLS:\n  search() -> string\n';
    const result = spliceSections(lfContent, [{ section: 'GOAL', content: 'GOAL: "Updated"' }]);

    expect(result).not.toContain('\r\n');
    expect(result).toContain('GOAL: "Updated"');
  });

  it('should preserve untouched sections byte-for-byte after CRLF multi-edit', () => {
    const result = spliceSections(CRLF_ABL, [{ section: 'GOAL', content: 'GOAL: "Changed"' }]);

    // AGENT and TOOLS sections should be unchanged
    expect(result).toContain('AGENT: TestAgent');
    expect(result).toContain('search() -> string');
    expect(result).toContain('CONSTRAINTS:');
  });

  it('should return original unchanged when edits array is empty', () => {
    const result = spliceSections(SAMPLE_ABL, []);
    expect(result).toBe(SAMPLE_ABL);
  });
});

// ─── O(n) Optimization Tests ────────────────────────────────────────────────

describe('spliceSections multi-edit optimization', () => {
  it('should apply 6+ simultaneous edits correctly', () => {
    const result = spliceSections(SAMPLE_ABL, [
      { section: 'VERSION', content: 'VERSION: "2.0"' },
      { section: 'DESCRIPTION', content: 'DESCRIPTION: "Updated"' },
      { section: 'MEMORY', content: 'MEMORY:\n  session:\n    - status' },
      { section: 'GOAL', content: 'GOAL: "New goal"' },
      { section: 'PERSONA', content: 'PERSONA: |\n  New persona' },
      {
        section: 'COMPLETE',
        content: 'COMPLETE:\n  - WHEN: done == true\n    RESPOND: "Finished"',
      },
    ]);

    expect(result).toContain('VERSION: "2.0"');
    expect(result).toContain('DESCRIPTION: "Updated"');
    expect(result).toContain('MEMORY:');
    expect(result).toContain('GOAL: "New goal"');
    expect(result).toContain('New persona');
    expect(result).toContain('RESPOND: "Finished"');
    // Untouched
    expect(result).toContain('AGENT: TestAgent');
    expect(result).toContain('TOOLS:');
  });

  it('should handle mixed removals and additions in single call', () => {
    const result = spliceSections(SAMPLE_ABL, [
      { section: 'CONSTRAINTS', content: null }, // remove
      { section: 'COMPLETE', content: null }, // remove
      { section: 'MEMORY', content: 'MEMORY:\n  session:\n    - task' }, // add
      { section: 'GATHER', content: 'GATHER:\n  name:\n    type: string' }, // add
    ]);

    expect(result).not.toContain('CONSTRAINTS:');
    expect(result).not.toContain('COMPLETE:');
    expect(result).toContain('MEMORY:');
    expect(result).toContain('GATHER:');
  });

  it('should preserve section ordering after multi-edit', () => {
    const result = spliceSections(SAMPLE_ABL, [
      { section: 'GOAL', content: 'GOAL: "A"' },
      { section: 'CONSTRAINTS', content: 'CONSTRAINTS:\n  always:\n    - REQUIRE true' },
    ]);

    const sections = identifySections(result);
    const names = sections.map((s) => s.name);
    const goalIdx = names.indexOf('GOAL');
    const constraintsIdx = names.indexOf('CONSTRAINTS');
    const toolsIdx = names.indexOf('TOOLS');

    expect(goalIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(constraintsIdx);
  });
});

// ─── identifySections Edge Cases ────────────────────────────────────────────

describe('spliceSection with empty content', () => {
  it('should return original content when removing from empty file', () => {
    const result = spliceSection('', 'GOAL', null);
    expect(result).toBe('');
  });

  it('should add section to empty file', () => {
    const result = spliceSection('', 'GOAL', 'GOAL:\n  Be helpful\n');
    expect(result).toContain('GOAL:');
  });
});

describe('identifySections edge cases', () => {
  it('should return empty array for whitespace-only content', () => {
    expect(identifySections('   \n\n  \t  \n')).toEqual([]);
  });

  it('should skip duplicate sections and use first occurrence', () => {
    const content = 'AGENT: test\n\nGOAL:\n  First\n\nGOAL:\n  Second\n';

    const sections = identifySections(content);

    // Only one GOAL section should be returned (the first occurrence)
    const goalSections = sections.filter((s) => s.name === 'GOAL');
    expect(goalSections).toHaveLength(1);
    expect(goalSections[0].startLine).toBe(2);
  });

  it('should identify sections correctly in CRLF content', () => {
    const crlf = 'AGENT: test\r\nVERSION: "1.0"\r\n\r\nGOAL:\r\n  Help\r\n';
    const sections = identifySections(crlf);
    const names = sections.map((s) => s.name);

    expect(names).toContain('AGENT');
    expect(names).toContain('VERSION');
    expect(names).toContain('GOAL');

    // Verify line numbers are correct
    const goal = sections.find((s) => s.name === 'GOAL')!;
    expect(goal.startLine).toBe(3);
  });
});
