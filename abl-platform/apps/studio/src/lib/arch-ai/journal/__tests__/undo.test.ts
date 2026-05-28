import { describe, expect, it } from 'vitest';

import {
  DEFAULT_UNDO_WINDOW_MS,
  canUndo,
  computeUndoPayload,
  conflictsWithSubsequent,
  type JournalMutationEntry,
} from '../undo';

const NOW_MS = Date.parse('2026-05-10T18:00:00.000Z');

function makeEntry(overrides: Partial<JournalMutationEntry> = {}): JournalMutationEntry {
  return {
    id: 'entry-1',
    timestamp: new Date(NOW_MS - 60_000).toISOString(),
    agentName: 'FlowStep',
    from: 'AGENT: FlowStep\nGOAL: old',
    to: 'AGENT: FlowStep\nGOAL: new',
    ...overrides,
  };
}

describe('journal undo helpers', () => {
  it('allows recent mutations inside the undo window', () => {
    expect(canUndo(makeEntry(), DEFAULT_UNDO_WINDOW_MS, NOW_MS)).toBe(true);
  });

  it('rejects mutations outside the undo window', () => {
    const entry = makeEntry({
      timestamp: new Date(NOW_MS - DEFAULT_UNDO_WINDOW_MS - 1).toISOString(),
    });

    expect(canUndo(entry, DEFAULT_UNDO_WINDOW_MS, NOW_MS)).toBe(false);
  });

  it('rejects future or malformed timestamps', () => {
    expect(
      canUndo(
        makeEntry({
          timestamp: new Date(NOW_MS + 1).toISOString(),
        }),
        DEFAULT_UNDO_WINDOW_MS,
        NOW_MS,
      ),
    ).toBe(false);
    expect(canUndo(makeEntry({ timestamp: 'not-a-date' }), DEFAULT_UNDO_WINDOW_MS, NOW_MS)).toBe(
      false,
    );
  });

  it('computes the inverse mutation payload from the original DSL', () => {
    expect(computeUndoPayload(makeEntry())).toEqual({
      agentName: 'FlowStep',
      code: 'AGENT: FlowStep\nGOAL: old',
    });
  });

  it('detects later mutations to the same agent as conflicts', () => {
    const target = makeEntry({
      id: 'entry-1',
      timestamp: '2026-05-10T17:00:00.000Z',
    });
    const journal = [
      target,
      makeEntry({
        id: 'entry-2',
        timestamp: '2026-05-10T17:01:00.000Z',
        agentName: 'FlowStep',
      }),
    ];

    expect(conflictsWithSubsequent(target, journal)).toBe(true);
  });

  it('allows undo when later mutations touch other agents only', () => {
    const target = makeEntry({
      id: 'entry-1',
      timestamp: '2026-05-10T17:00:00.000Z',
      agentName: 'FlowStep',
    });
    const journal = [
      target,
      makeEntry({
        id: 'entry-2',
        timestamp: '2026-05-10T17:01:00.000Z',
        agentName: 'DifferentAgent',
      }),
    ];

    expect(conflictsWithSubsequent(target, journal)).toBe(false);
  });

  it('fails closed when the target timestamp is malformed', () => {
    expect(conflictsWithSubsequent(makeEntry({ timestamp: 'not-a-date' }), [])).toBe(true);
  });
});
