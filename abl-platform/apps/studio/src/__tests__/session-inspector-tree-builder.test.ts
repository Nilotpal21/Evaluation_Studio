import { describe, it, expect } from 'vitest';
import { buildSessionTree } from '../components/admin/session-inspector/tree-builder';
import type { SessionTreeEvent } from '../lib/arch-inspector-reader';

function makeEvent(overrides: Partial<SessionTreeEvent>): SessionTreeEvent {
  return {
    eventId: overrides.eventId ?? 'evt_' + Math.random().toString(36).slice(2, 8),
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    category: overrides.category ?? 'system_event',
    severity: overrides.severity ?? 'info',
    summary: overrides.summary ?? 'test event',
    detail: overrides.detail ?? {},
    turnId: overrides.turnId ?? '',
    parentEventId: overrides.parentEventId ?? '',
    phaseLabel: overrides.phaseLabel ?? '',
    retryOf: overrides.retryOf ?? '',
    retryIndex: overrides.retryIndex ?? 0,
    nestingDepth: overrides.nestingDepth ?? 255,
    spanKind: overrides.spanKind ?? '',
    ...overrides,
  };
}

describe('buildSessionTree', () => {
  it('places legacy events (nestingDepth=255) in legacyEvents', () => {
    const events = [
      makeEvent({ eventId: 'e1', summary: 'legacy 1' }),
      makeEvent({ eventId: 'e2', summary: 'legacy 2' }),
    ];

    const tree = buildSessionTree(events);
    expect(tree.phases).toHaveLength(0);
    expect(tree.legacyEvents).toHaveLength(2);
  });

  it('builds a phase → turn → llm_call → tool_call hierarchy', () => {
    const events = [
      makeEvent({
        eventId: 'phase1',
        spanKind: 'phase',
        nestingDepth: 0,
        phaseLabel: 'INTERVIEW',
        summary: 'Phase: INTERVIEW',
      }),
      makeEvent({
        eventId: 'turn1',
        spanKind: 'turn',
        nestingDepth: 1,
        turnId: 'turn1',
        phaseLabel: 'INTERVIEW',
        summary: 'Turn started',
      }),
      makeEvent({
        eventId: 'llm1',
        spanKind: 'llm_call',
        nestingDepth: 2,
        turnId: 'turn1',
        phaseLabel: 'INTERVIEW',
        summary: 'LLM call completed (gpt-4)',
      }),
      makeEvent({
        eventId: 'tool1',
        spanKind: 'tool_call',
        nestingDepth: 3,
        turnId: 'turn1',
        parentEventId: 'llm1',
        phaseLabel: 'INTERVIEW',
        summary: 'ask_user called',
      }),
    ];

    const tree = buildSessionTree(events);
    expect(tree.legacyEvents).toHaveLength(0);
    expect(tree.phases).toHaveLength(1);

    const phase = tree.phases[0];
    expect(phase.event.eventId).toBe('phase1');
    expect(phase.children).toHaveLength(1);

    const turn = phase.children[0];
    expect(turn.event.eventId).toBe('turn1');
    expect(turn.children).toHaveLength(1);

    const llm = turn.children[0];
    expect(llm.event.eventId).toBe('llm1');
    expect(llm.children).toHaveLength(1);

    const tool = llm.children[0];
    expect(tool.event.eventId).toBe('tool1');
    expect(tool.children).toHaveLength(0);
  });

  it('handles multiple turns within a phase', () => {
    const events = [
      makeEvent({
        eventId: 'phase1',
        spanKind: 'phase',
        nestingDepth: 0,
        phaseLabel: 'BUILD',
        summary: 'Phase: BUILD',
      }),
      makeEvent({
        eventId: 'turn1',
        spanKind: 'turn',
        nestingDepth: 1,
        turnId: 'turn1',
        phaseLabel: 'BUILD',
        summary: 'Turn 1',
      }),
      makeEvent({
        eventId: 'turn2',
        spanKind: 'turn',
        nestingDepth: 1,
        turnId: 'turn2',
        phaseLabel: 'BUILD',
        summary: 'Turn 2',
      }),
    ];

    const tree = buildSessionTree(events);
    expect(tree.phases).toHaveLength(1);
    expect(tree.phases[0].children).toHaveLength(2);
  });

  it('handles tool_call without parent LLM — falls back to turn', () => {
    const events = [
      makeEvent({
        eventId: 'turn1',
        spanKind: 'turn',
        nestingDepth: 1,
        turnId: 'turn1',
        phaseLabel: 'INTERVIEW',
        summary: 'Turn started',
      }),
      makeEvent({
        eventId: 'tool1',
        spanKind: 'tool_call',
        nestingDepth: 3,
        turnId: 'turn1',
        parentEventId: 'nonexistent_llm',
        phaseLabel: 'INTERVIEW',
        summary: 'tool without parent llm',
      }),
    ];

    const tree = buildSessionTree(events);
    const turn = tree.phases[0];
    expect(turn.event.eventId).toBe('turn1');
    expect(turn.children).toHaveLength(1);
    expect(turn.children[0].event.eventId).toBe('tool1');
  });

  it('handles mixed legacy and instrumented events', () => {
    const events = [
      makeEvent({
        eventId: 'phase1',
        spanKind: 'phase',
        nestingDepth: 0,
        phaseLabel: 'INTERVIEW',
      }),
      makeEvent({ eventId: 'legacy1', nestingDepth: 255, spanKind: '' }),
      makeEvent({
        eventId: 'turn1',
        spanKind: 'turn',
        nestingDepth: 1,
        turnId: 'turn1',
        phaseLabel: 'INTERVIEW',
      }),
      makeEvent({ eventId: 'legacy2', nestingDepth: 255, spanKind: '' }),
    ];

    const tree = buildSessionTree(events);
    expect(tree.phases).toHaveLength(1);
    expect(tree.phases[0].children).toHaveLength(1);
    expect(tree.legacyEvents).toHaveLength(2);
  });
});
