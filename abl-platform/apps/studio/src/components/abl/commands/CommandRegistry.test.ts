// CommandRegistry.test.ts
import { describe, test, expect } from 'vitest';
import { COMMAND_REGISTRY, getCommandsForSection } from './CommandRegistry';

describe('CommandRegistry', () => {
  // --- Original tests ---

  test('has at least 15 commands', () => {
    expect(COMMAND_REGISTRY.length).toBeGreaterThanOrEqual(15);
  });

  test('tools section returns tool commands', () => {
    const cmds = getCommandsForSection('tools');
    expect(cmds.some((c) => c.id === 'tool')).toBe(true);
    expect(cmds.some((c) => c.id === 'http-tool')).toBe(true);
    expect(cmds.some((c) => c.id === 'mcp-tool')).toBe(true);
  });

  test('guardrails section returns guardrail commands', () => {
    const cmds = getCommandsForSection('guardrails');
    expect(cmds.some((c) => c.id === 'guardrail')).toBe(true);
    expect(cmds.some((c) => c.id === 'builtin-guard')).toBe(true);
  });

  test('flow section returns step commands', () => {
    const cmds = getCommandsForSection('flow');
    expect(cmds.some((c) => c.id === 'step')).toBe(true);
    expect(cmds.some((c) => c.id === 'reasoning-step')).toBe(true);
  });

  test('root section returns all commands', () => {
    const cmds = getCommandsForSection('root');
    expect(cmds.length).toBe(COMMAND_REGISTRY.length);
  });

  test('every command has required fields', () => {
    for (const cmd of COMMAND_REGISTRY) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.label).toMatch(/^\//);
      expect(cmd.description).toBeTruthy();
      expect(cmd.availableIn.length).toBeGreaterThan(0);
    }
  });

  test('no duplicate command IDs', () => {
    const ids = COMMAND_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // --- Section isolation: commands don't leak across sections ---

  test('tools section does NOT include guardrail/flow/memory commands', () => {
    const cmds = getCommandsForSection('tools');
    const ids = cmds.map((c) => c.id);
    expect(ids).not.toContain('guardrail');
    expect(ids).not.toContain('step');
    expect(ids).not.toContain('memory-var');
    expect(ids).not.toContain('field');
    expect(ids).not.toContain('handoff');
  });

  test('guardrails section does NOT include tool/flow commands', () => {
    const cmds = getCommandsForSection('guardrails');
    const ids = cmds.map((c) => c.id);
    expect(ids).not.toContain('tool');
    expect(ids).not.toContain('http-tool');
    expect(ids).not.toContain('step');
    expect(ids).not.toContain('field');
  });

  test('gather section returns only gather commands', () => {
    const cmds = getCommandsForSection('gather');
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.id === 'field')).toBe(true);
    expect(cmds.some((c) => c.id === 'string-field')).toBe(true);
    // No tool/guardrail commands
    const ids = cmds.map((c) => c.id);
    expect(ids).not.toContain('tool');
    expect(ids).not.toContain('guardrail');
  });

  test('memory section returns only memory commands', () => {
    const cmds = getCommandsForSection('memory');
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.id === 'memory-var')).toBe(true);
    expect(cmds.some((c) => c.id === 'persistent')).toBe(true);
    const ids = cmds.map((c) => c.id);
    expect(ids).not.toContain('tool');
    expect(ids).not.toContain('step');
  });

  test('constraints section returns only constraint commands', () => {
    const cmds = getCommandsForSection('constraints');
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.id === 'constraint')).toBe(true);
    expect(cmds.some((c) => c.id === 'require')).toBe(true);
    expect(cmds.some((c) => c.id === 'warn')).toBe(true);
  });

  test('handoff section returns handoff command', () => {
    const cmds = getCommandsForSection('handoff');
    expect(cmds.some((c) => c.id === 'handoff')).toBe(true);
    const ids = cmds.map((c) => c.id);
    expect(ids).not.toContain('tool');
    expect(ids).not.toContain('guardrail');
  });

  test('escalation section returns escalate command', () => {
    const cmds = getCommandsForSection('escalation');
    expect(cmds.some((c) => c.id === 'escalate')).toBe(true);
  });

  test('completion section returns complete command', () => {
    const cmds = getCommandsForSection('completion');
    expect(cmds.some((c) => c.id === 'complete')).toBe(true);
  });

  // --- /edit command ---

  test('/edit command exists in registry', () => {
    const edit = COMMAND_REGISTRY.find((c) => c.id === 'edit');
    expect(edit).toBeDefined();
    expect(edit!.label).toBe('/edit');
  });

  test('/edit command is available in identity, unknown, and root', () => {
    const edit = COMMAND_REGISTRY.find((c) => c.id === 'edit')!;
    expect(edit.availableIn).toContain('identity');
    expect(edit.availableIn).toContain('unknown');
    expect(edit.availableIn).toContain('root');
  });

  test('identity section contains /edit command', () => {
    const cmds = getCommandsForSection('identity');
    expect(cmds.some((c) => c.id === 'edit')).toBe(true);
  });

  test('unknown section returns /edit as fallback', () => {
    const cmds = getCommandsForSection('unknown');
    expect(cmds.some((c) => c.id === 'edit')).toBe(true);
  });

  // --- Each section returns non-empty ---

  test('every recognized section returns at least one command', () => {
    const sections = [
      'tools',
      'guardrails',
      'flow',
      'gather',
      'memory',
      'constraints',
      'handoff',
      'escalation',
      'completion',
      'identity',
    ] as const;
    for (const section of sections) {
      const cmds = getCommandsForSection(section);
      expect(cmds.length).toBeGreaterThan(0);
    }
  });
});
