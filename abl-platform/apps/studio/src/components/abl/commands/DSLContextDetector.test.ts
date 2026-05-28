// DSLContextDetector.test.ts
import { describe, test, expect } from 'vitest';
import { detectDSLContext, type DSLSection } from './DSLContextDetector';

const FULL_DSL = `AGENT: Account_Support
VERSION: "1.0"
DESCRIPTION: "Helps with accounts"
GOAL: "Help with Apple ID"

PERSONA: |
  Security-conscious specialist.

LIMITATIONS:
  - "Cannot bypass verification"

EXECUTION:
  model: "claude-sonnet-4-20250514"
  temperature: 0.3

TOOLS:
  verify_identity(id: string) -> object
    description: "Verify identity"

GUARDRAILS:
  pii_check:
    kind: input

ESCALATE:
  triggers:
    - WHEN: attempts >= 3

COMPLETE:
  - WHEN: resolved == true`;

describe('DSLContextDetector', () => {
  // --- Original tests ---

  test('detects TOOLS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n  fetch(id: string) -> object\n    description: "test"\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('tools');
  });

  test('detects GUARDRAILS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nGUARDRAILS:\n  guard1:\n    kind: input\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('guardrails');
  });

  test('detects FLOW section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nFLOW:\n  steps: [welcome]\n\n  welcome:\n    REASONING: false\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 9, column: 3 });
    expect(ctx.section).toBe('flow');
  });

  test('detects root level', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\n`;
    const ctx = detectDSLContext(dsl, { line: 3, column: 1 });
    expect(ctx.section).toBe('root');
  });

  test('detects GATHER section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nGATHER:\n  name:\n    type: string\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('gather');
  });

  test('detects MEMORY section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nMEMORY:\n  SESSION:\n    - x: string\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('memory');
  });

  test('detects CONSTRAINTS section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nCONSTRAINTS:\n  pre:\n    - REQUIRE: x > 0\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('constraints');
  });

  test('detects HANDOFF section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nHANDOFF:\n  - TO: Other\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 6, column: 3 });
    expect(ctx.section).toBe('handoff');
  });

  test('detects TEMPLATES section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTEMPLATES:\n  greet:\n    content: "hi"\n\n  `;
    const ctx = detectDSLContext(dsl, { line: 7, column: 3 });
    expect(ctx.section).toBe('templates');
  });

  test('falls back to line-based detection on malformed YAML', () => {
    const dsl = `AGENT: Test\nGOAL "broken\n\nTOOLS:\n  \n`;
    const ctx = detectDSLContext(dsl, { line: 5, column: 3 });
    expect(ctx.section).toBe('tools');
  });

  test('returns indentLevel from current line', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n    `;
    const ctx = detectDSLContext(dsl, { line: 5, column: 5 });
    expect(ctx.indentLevel).toBe(4);
  });

  test('returns available commands for section', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n  `;
    const ctx = detectDSLContext(dsl, { line: 5, column: 3 });
    expect(ctx.availableCommands.length).toBeGreaterThan(0);
    expect(ctx.availableCommands.some((c) => c.id === 'tool')).toBe(true);
  });

  // --- Identity section keywords ---

  test('PERSONA: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 6, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('GOAL: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 4, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('LIMITATIONS: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 9, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('AGENT: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 1, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('VERSION: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 2, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('DESCRIPTION: detects identity section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 3, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  // --- Other new sections ---

  test('EXECUTION: detects execution section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 12, column: 1 });
    expect(ctx.section).toBe('execution');
  });

  test('ESCALATE: detects escalation section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 24, column: 1 });
    expect(ctx.section).toBe('escalation');
  });

  test('COMPLETE: detects completion section', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 28, column: 1 });
    expect(ctx.section).toBe('completion');
  });

  // --- Nested / indented contexts ---

  test('cursor inside PERSONA block (indented) detects identity', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 7, column: 3 });
    expect(ctx.section).toBe('identity');
  });

  test('cursor inside LIMITATIONS list (indented) detects identity', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 10, column: 5 });
    expect(ctx.section).toBe('identity');
  });

  test('cursor inside EXECUTION properties detects execution', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 13, column: 3 });
    expect(ctx.section).toBe('execution');
  });

  // --- Lowercase variants ---

  test('lowercase persona: detects identity', () => {
    const dsl = `agent: Test\npersona: |\n  Friendly assistant\n`;
    const ctx = detectDSLContext(dsl, { line: 2, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('lowercase execution: detects execution', () => {
    const dsl = `agent: Test\nexecution:\n  model: "gpt-4"\n`;
    const ctx = detectDSLContext(dsl, { line: 2, column: 1 });
    expect(ctx.section).toBe('execution');
  });

  // --- Edge cases ---

  test('empty DSL detects root', () => {
    const ctx = detectDSLContext('', { line: 1, column: 1 });
    expect(ctx.section).toBe('root');
  });

  test('blank line between GOAL and PERSONA scans back to identity', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 5, column: 1 });
    expect(ctx.section).toBe('identity');
  });

  test('blank line between identity fields and the next section detects root', () => {
    const dsl = `AGENT: Test\nGOAL: "test"\n\nTOOLS:\n  fetch(id: string) -> object\n`;
    const ctx = detectDSLContext(dsl, { line: 3, column: 1 });
    expect(ctx.section).toBe('root');
  });

  test('blank line between TOOLS entries still detects tools', () => {
    const ctx = detectDSLContext(FULL_DSL, { line: 18, column: 1 });
    expect(ctx.section).toBe('tools');
  });
});
