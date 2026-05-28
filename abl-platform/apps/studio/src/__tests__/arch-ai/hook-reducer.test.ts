/**
 * Unit tests for the v4 hook-reducer pure function.
 *
 * No vi.mock — the reducer is a pure function.
 * Synthetic TurnEvent envelopes are constructed inline.
 */

import { describe, it, expect } from 'vitest';
import { reduceArchUIState, INITIAL_ARCH_UI_STATE } from '../../lib/arch-ai/ui/hook-reducer';
import type { ArchUIState } from '../../lib/arch-ai/ui/hook-reducer';
import type { TurnEvent } from '@agent-platform/arch-ai/types';

// ─── Envelope factory helpers ─────────────────────────────────────────────────

const BASE_ENVELOPE = {
  eventId: 'evt-1',
  schemaVersion: 2 as const,
  sessionId: 'session-1',
  turnId: 'turn-1',
  timestamp: 1_700_000_000_000,
};

function mkTurnStarted(seq: number, specialist?: string): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'turn_started',
    specialist,
    userMessageId: 'msg-user-1',
  };
}

function mkTextDelta(seq: number, delta: string): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'text_delta',
    delta,
  };
}

function mkStatus(seq: number, label: string): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'status',
    label,
  };
}

function mkInteractiveTool(seq: number, kind: 'tool' | 'gate' = 'tool'): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'interactive_tool',
    tool: 'ask_user',
    toolCallId: 'tc-1',
    kind,
    payload: { question: 'How many agents?' },
  };
}

function mkTurnCommitted(seq: number, phase = 'INTERVIEW'): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'turn_committed',
    phase,
  };
}

function mkTurnEnded(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'turn_ended',
    reason: 'natural',
  };
}

function mkError(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'error',
    error: {
      code: 'MODEL_TIMEOUT',
      message: 'LLM timed out',
      retryable: true,
    },
  };
}

function mkArtifactUpdatedSpec(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'artifact_updated',
    update: {
      artifact: 'spec',
      version: 3,
      patches: [{ path: '/name', value: 'My Agent', op: 'set' as const }],
    },
  };
}

function mkArtifactUpdatedTopology(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'artifact_updated',
    update: {
      artifact: 'topology',
      payload: { nodes: ['a', 'b'], edges: [] },
    },
  };
}

function mkArtifactUpdatedBuild(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'artifact_updated',
    update: {
      artifact: 'build',
      scope: 'overall',
      stats: { total: 3, compiled: 1, warnings: 0, errors: 0 },
      phase: 'generating' as const,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reduceArchUIState — text_delta', () => {
  it('creates an in-flight assistant message on turn_started', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTurnStarted(0));
    expect(s1.chatState).toBe('streaming');
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].role).toBe('assistant');
    expect(s1.messages[0].text).toBe('');
    expect(s1.messages[0].isStreaming).toBe(true);
    expect(s1._streamingMsgId).toBeDefined();
    expect(s1._streamingMsgId).toBe(s1.messages[0].id);
  });

  it('appends delta to the in-flight assistant message', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkTextDelta(1, 'Hello'));
    const s2 = reduceArchUIState(s1, mkTextDelta(2, ' world'));
    expect(s2.messages[0].text).toBe('Hello world');
    expect(s2.chatState).toBe('streaming');
  });

  it('creates a new assistant message if text_delta arrives without prior turn_started', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTextDelta(0, 'Hi'));
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].text).toBe('Hi');
    expect(s1.messages[0].isStreaming).toBe(true);
    expect(s1.chatState).toBe('streaming');
  });
});

describe('reduceArchUIState — interactive_tool / widget_pending', () => {
  it('sets widget_pending + stores pendingInteraction on interactive_tool', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkInteractiveTool(1, 'tool'));
    expect(s1.chatState).toBe('widget_pending');
    expect(s1.pendingInteraction).not.toBeNull();
    expect(s1.pendingInteraction?.kind).toBe('widget');
    expect(s1.pendingInteraction?.id).toBe('tc-1');
    expect(s1.pendingInteraction?.toolName).toBe('ask_user');
  });

  it('sets kind gate for kind:gate interactive_tool', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkInteractiveTool(0, 'gate'));
    expect(s1.pendingInteraction?.kind).toBe('gate');
  });

  it('adds a toolCall message to the transcript', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkInteractiveTool(0, 'tool'));
    const toolMsg = s1.messages.find((m) => m.toolCall != null);
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCall?.toolCallId).toBe('tc-1');
    expect(toolMsg?.toolCall?.toolName).toBe('ask_user');
  });
});

describe('reduceArchUIState — turn_ended', () => {
  it('resets chatState to idle and clears streaming flag', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkTextDelta(1, 'Hi'));
    const s2 = reduceArchUIState(s1, mkTurnEnded(2));
    expect(s2.chatState).toBe('idle');
    expect(s2._streamingMsgId).toBeNull();
    expect(s2.messages[0].isStreaming).toBe(false);
    expect(s2.statusLabel).toBeNull();
  });

  it('clears pendingInteraction on turn_ended', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkInteractiveTool(0, 'tool'));
    expect(s0.pendingInteraction).not.toBeNull();
    const s1 = reduceArchUIState(s0, mkTurnEnded(1));
    expect(s1.pendingInteraction).toBeNull();
    expect(s1.chatState).toBe('idle');
  });
});

describe('reduceArchUIState — error (turn_failed)', () => {
  it('resets chatState and marks streaming message as done', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkTextDelta(1, 'Partial...'));
    const s2 = reduceArchUIState(s1, mkError(2));
    expect(s2.chatState).toBe('idle');
    expect(s2._streamingMsgId).toBeNull();
    expect(s2.messages[0].isStreaming).toBe(false);
  });
});

describe('reduceArchUIState — idempotency', () => {
  it('returns the SAME object reference for duplicate seq', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTurnStarted(0));
    // Apply the same event again — should be a no-op with the same reference.
    const s2 = reduceArchUIState(s1, mkTurnStarted(0));
    expect(s2).toBe(s1); // strict object reference equality
  });

  it('returns same reference when seq < lastAppliedSeq', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTurnStarted(5));
    // Apply an event with older seq.
    const s2 = reduceArchUIState(s1, mkTextDelta(3, 'stale'));
    expect(s2).toBe(s1);
  });

  it('advances lastAppliedSeq for new events', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTurnStarted(0));
    expect(s1.lastAppliedSeq).toBe(0);
    const s2 = reduceArchUIState(s1, mkTextDelta(1, 'x'));
    expect(s2.lastAppliedSeq).toBe(1);
    const s3 = reduceArchUIState(s2, mkTurnEnded(2));
    expect(s3.lastAppliedSeq).toBe(2);
  });

  it('applying the same event sequence twice produces identical output state', () => {
    function applyAll(events: TurnEvent[]): ArchUIState {
      return events.reduce(reduceArchUIState, INITIAL_ARCH_UI_STATE);
    }
    const events: TurnEvent[] = [
      mkTurnStarted(0),
      mkTextDelta(1, 'Hello'),
      mkTextDelta(2, ' world'),
      mkTurnEnded(3),
    ];
    // First pass
    const pass1 = applyAll(events);
    // Replay same events on the resulting state (reconnect scenario)
    const pass2 = events.reduce(reduceArchUIState, pass1);
    // All events were already seen — state must be unchanged.
    expect(pass2).toBe(pass1);
  });
});

describe('reduceArchUIState — artifact_updated channels', () => {
  it('updates specDocument on spec channel', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkArtifactUpdatedSpec(0));
    expect(s1.specDocument).not.toBeNull();
    expect(s1.specDocument?.version).toBe(3);
    expect(s1.specDocument?.patches).toHaveLength(1);
    expect(s1.specDocument?.patches[0].path).toBe('/name');
  });

  it('updates topology on topology channel', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkArtifactUpdatedTopology(0));
    expect(s1.topology).toEqual({ nodes: ['a', 'b'], edges: [] });
  });

  it('advances seq but leaves other state unchanged on build channel (M1 no-op)', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkArtifactUpdatedBuild(0));
    // No extra state changes for build in M1.
    expect(s1.lastAppliedSeq).toBe(0);
    expect(s1.messages).toHaveLength(0);
    expect(s1.specDocument).toBeNull();
    expect(s1.topology).toBeNull();
  });
});

describe('reduceArchUIState — turn_committed', () => {
  it('updates phase from turn_committed', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkTurnCommitted(0, 'BLUEPRINT'));
    expect(s1.phase).toBe('BLUEPRINT');
    expect(s1.lastAppliedSeq).toBe(0);
  });
});

describe('reduceArchUIState — status', () => {
  it('stores the status label', () => {
    const s0 = INITIAL_ARCH_UI_STATE;
    const s1 = reduceArchUIState(s0, mkStatus(0, 'Running diagnostics…'));
    expect(s1.statusLabel).toBe('Running diagnostics…');
  });

  it('status label is cleared on turn_ended', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkStatus(0, 'Working…'));
    const s1 = reduceArchUIState(s0, mkTurnEnded(1));
    expect(s1.statusLabel).toBeNull();
  });
});
