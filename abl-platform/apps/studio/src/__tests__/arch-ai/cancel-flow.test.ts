/**
 * v4 cancel flow — reducer handling unit tests.
 *
 * Covers the client-side state reset that occurs when a cancel is detected.
 * The cancel flow end-to-end:
 *   1. Client calls stop() → POST /api/arch-ai/sessions/:id/cancel
 *   2. Route sets cancelRequested:true via SessionService.setCancelRequested()
 *   3. TurnEngine polls cancelRequestedRead between tool iterations
 *   4. Engine emits turn_ended(reason:'canceled') → reducer resets state
 *
 * This file covers step 4: the reducer correctly resets chatState and clears
 * in-flight state when a cancel-related event arrives.
 *
 * No vi.mock — reduceArchUIState is a pure function; zero side effects.
 */

import { describe, it, expect } from 'vitest';
import { reduceArchUIState, INITIAL_ARCH_UI_STATE } from '../../lib/arch-ai/ui/hook-reducer';
import type { TurnEvent } from '@agent-platform/arch-ai/types';

// ─── Envelope factory helpers ─────────────────────────────────────────────────

const BASE_ENVELOPE = {
  eventId: 'evt-cancel-1',
  schemaVersion: 2 as const,
  sessionId: 'session-cancel-1',
  turnId: 'turn-cancel-1',
  timestamp: 1_700_000_001_000,
};

function mkTurnStarted(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'turn_started',
    specialist: 'interviewer',
    userMessageId: 'msg-u-1',
  };
}

function mkTextDelta(seq: number, delta: string): TurnEvent {
  return { ...BASE_ENVELOPE, seq, type: 'text_delta', delta };
}

function mkInteractiveTool(seq: number): TurnEvent {
  return {
    ...BASE_ENVELOPE,
    seq,
    type: 'interactive_tool',
    tool: 'ask_user',
    toolCallId: 'call-cancel-1',
    kind: 'tool' as const,
    payload: { question: '?' },
  };
}

function mkTurnEndedCanceled(seq: number): TurnEvent {
  return { ...BASE_ENVELOPE, seq, type: 'turn_ended', reason: 'canceled' as never };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('v4 cancel flow — turn_canceled synthetic event', () => {
  it('resets chatState and clears in-flight state on turn_canceled', () => {
    // Simulate a mid-turn state: streaming with a partial assistant message
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkTextDelta(1, 'Partial response...'));
    expect(s1.chatState).toBe('streaming');
    expect(s1._streamingMsgId).not.toBeNull();
    expect(s1.messages[0].isStreaming).toBe(true);

    // Inject a turn_canceled event (forward-compatibility kind, not yet in TurnEvent union)
    const cancelEvent = { ...BASE_ENVELOPE, seq: 5, type: 'turn_canceled' } as unknown as TurnEvent;
    const next = reduceArchUIState(s1, cancelEvent);

    expect(next.chatState).toBe('idle');
    expect(next.pendingInteraction).toBeNull();
    expect(next._streamingMsgId).toBeNull();
    expect(next.statusLabel).toBeNull();
    // The in-flight message should be marked as no longer streaming
    expect(next.messages[0].isStreaming).toBe(false);
    expect(next.lastAppliedSeq).toBe(5);
  });

  it('clears pendingInteraction on turn_canceled when widget is pending', () => {
    // Start from a widget_pending state: interactive tool arrived
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkInteractiveTool(0));
    expect(s0.chatState).toBe('widget_pending');
    expect(s0.pendingInteraction).not.toBeNull();
    expect(s0.pendingInteraction?.id).toBe('call-cancel-1');

    const cancelEvent = { ...BASE_ENVELOPE, seq: 5, type: 'turn_canceled' } as unknown as TurnEvent;
    const next = reduceArchUIState(s0, cancelEvent);

    expect(next.chatState).toBe('idle');
    expect(next.pendingInteraction).toBeNull();
  });
});

describe('v4 cancel flow — turn_ended(reason:canceled) from wire protocol', () => {
  it('resets chatState and clears in-flight state on turn_ended with canceled reason', () => {
    // The TurnEngine emits turn_ended(reason:'canceled') on detection of the
    // cancelRequested flag. This is the actual wire event the reducer processes.
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkTurnStarted(0));
    const s1 = reduceArchUIState(s0, mkTextDelta(1, 'Partial response...'));
    expect(s1.chatState).toBe('streaming');

    // turn_ended(reason:'canceled') is handled by the turn_ended case
    const next = reduceArchUIState(s1, mkTurnEndedCanceled(2));

    expect(next.chatState).toBe('idle');
    expect(next.pendingInteraction).toBeNull();
    expect(next._streamingMsgId).toBeNull();
    expect(next.statusLabel).toBeNull();
    expect(next.messages[0].isStreaming).toBe(false);
  });

  it('clears pendingInteraction on turn_ended(reason:canceled) with widget pending', () => {
    const s0 = reduceArchUIState(INITIAL_ARCH_UI_STATE, mkInteractiveTool(0));
    expect(s0.pendingInteraction).not.toBeNull();

    const next = reduceArchUIState(s0, mkTurnEndedCanceled(1));

    expect(next.chatState).toBe('idle');
    expect(next.pendingInteraction).toBeNull();
  });
});

// Intentionally NO hook.ts integration test here — that requires a full Next.js + React
// harness, which is covered by the M1.24 E2E Playwright suite.
