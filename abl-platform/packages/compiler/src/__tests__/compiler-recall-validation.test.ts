import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { validateRecallEvents } from '../platform/ir/recall-validation.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';

describe('validateRecallEvents', () => {
  const declaredTools = [{ name: 'search_hotels' }, { name: 'book_room' }];
  const knownAgents = ['Billing_Agent', 'Support_Agent'];

  it('accepts valid session lifecycle events', () => {
    const recall = [{ event: 'session:start' }, { event: 'session:end' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid named agent events', () => {
    const recall = [
      { event: 'agent:Billing_Agent:before' },
      { event: 'agent:Support_Agent:after' },
    ];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid wildcard agent events', () => {
    const recall = [{ event: 'agent:*:before' }, { event: 'agent:*:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid named tool events', () => {
    const recall = [{ event: 'tool:search_hotels:after' }, { event: 'tool:book_room:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts valid wildcard tool events', () => {
    const recall = [{ event: 'tool:*:after' }];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('accepts entity and step events', () => {
    const recall = [
      { event: 'entity:email:extracted' },
      { event: 'step:enter:greeting' },
      { event: 'step:exit:checkout' },
    ];
    expect(validateRecallEvents(recall, declaredTools, knownAgents)).toEqual([]);
  });

  it('rejects legacy aliases with explicit validation errors', () => {
    const recall = [
      { event: 'session_start' },
      { event: 'session_end' },
      { event: 'agent_enter' },
      { event: 'agent_exit' },
      { event: 'delegate_complete' },
    ];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(5);
    expect(diagnostics.every((d) => d.severity === 'error')).toBe(true);
    expect(diagnostics.every((d) => d.code === VALIDATION_CODES.LEGACY_RECALL_EVENT_ALIAS)).toBe(
      true,
    );
  });

  it('rejects blocked tool before events with explicit validation errors', () => {
    const recall = [{ event: 'tool:search_hotels:before' }, { event: 'tool:*:before' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.severity === 'error')).toBe(true);
    expect(
      diagnostics.every((d) => d.code === VALIDATION_CODES.BLOCKED_RECALL_TOOL_BEFORE_EVENT),
    ).toBe(true);
    expect(diagnostics[0].message).toContain('Pre-tool RECALL can mutate context');
    expect(diagnostics[0].message).toContain('tool:<name>:after');
  });

  it('warns on unknown tool reference', () => {
    const recall = [{ event: 'tool:nonexistent_tool:after' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('unknown tool');
    expect(diagnostics[0].message).toContain('nonexistent_tool');
    expect(diagnostics[0].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_TOOL);
  });

  it('warns on unknown agent reference', () => {
    const recall = [{ event: 'agent:Unknown_Agent:before' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('unknown agent');
    expect(diagnostics[0].message).toContain('Unknown_Agent');
    expect(diagnostics[0].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_AGENT);
  });

  it('suppresses unknown agent references in single-agent scope', () => {
    const recall = [{ event: 'agent:Unknown_Agent:before' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents, 'TestAgent', {
      singleAgentScope: true,
    });
    expect(diagnostics).toEqual([]);
  });

  it('warns on completely unrecognized event', () => {
    const recall = [{ event: 'booking_completed' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('does not match any known event pattern');
    expect(diagnostics[0].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_EVENT);
  });

  it('collects multiple diagnostics for multiple invalid events', () => {
    const recall = [
      { event: 'tool:nonexistent:after' },
      { event: 'agent:Missing_Agent:after' },
      { event: 'custom_event' },
    ];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_TOOL);
    expect(diagnostics[1].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_AGENT);
    expect(diagnostics[2].code).toBe(VALIDATION_CODES.UNKNOWN_RECALL_EVENT);
  });

  it('includes agent name in diagnostics when provided', () => {
    const recall = [{ event: 'bad_event' }];
    const diagnostics = validateRecallEvents(recall, declaredTools, knownAgents, 'TestAgent');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].agent).toBe('TestAgent');
  });

  it('returns empty diagnostics for empty recall array', () => {
    expect(validateRecallEvents([], declaredTools, knownAgents)).toEqual([]);
  });

  it('filters system tools from tool list in diagnostic message', () => {
    const tools = [{ name: '__handoff__' }, { name: 'my_tool' }];
    const recall = [{ event: 'tool:unknown:after' }];
    const diagnostics = validateRecallEvents(recall, tools, []);
    expect(diagnostics[0].message).toContain('my_tool');
    expect(diagnostics[0].message).not.toContain('__handoff__');
  });
});

describe('compileABLtoIR RECALL event validation', () => {
  it('surfaces blocked tool before events as compilation errors', () => {
    const parsed = parseAgentBasedABL(`
AGENT: RecallBeforeAgent
GOAL: "Exercise blocked tool-before recall diagnostics"
PERSONA: "Test agent"

MEMORY:
  persistent:
    - user.preferences
  recall:
    - ON: tool:*:before
      ACTION: inject_context
      PATHS: [user.preferences]
`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.document).toBeTruthy();

    const output = compileABLtoIR([parsed.document!]);

    expect(output.compilation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'RecallBeforeAgent',
          code: VALIDATION_CODES.BLOCKED_RECALL_TOOL_BEFORE_EVENT,
          type: 'validation',
          severity: 'error',
        }),
      ]),
    );
  });
});
