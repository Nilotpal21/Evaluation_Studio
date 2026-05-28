/**
 * Tests for emitSuggestionsAsCards (Task 5.3 of ABLP-162).
 *
 * Pure-function tests — no mocks, no I/O. Verifies the helper emits
 * one artifact_updated event per suggestion with widget variant
 * 'integration_suggestion_card'.
 */
import { describe, it, expect } from 'vitest';

import { emitSuggestionsAsCards } from '../process-in-project';
import type { IntegrationSuggestion } from '../integration-suggestions';

describe('emitSuggestionsAsCards', () => {
  it('emits one artifact_updated widget event per suggestion', () => {
    const suggestions: IntegrationSuggestion[] = [
      {
        title: 'Connect slack for notifier?',
        rationale: 'notifier declares an unbound tool send_message.',
        providerOptions: [{ name: 'slack', providerKey: 'slack' }],
        targetAgentNames: ['notifier'],
      },
      {
        title: 'Connect smtp for notifier?',
        rationale: 'notifier declares an unbound tool send_email.',
        providerOptions: [{ name: 'smtp', providerKey: 'smtp' }],
        targetAgentNames: ['notifier'],
      },
    ];

    const events: unknown[] = [];
    emitSuggestionsAsCards({
      sessionId: 'sess_test',
      suggestions,
      emitTurnEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    for (const event of events) {
      const e = event as {
        type: string;
        update: {
          artifact: string;
          variant: string;
          payload: { title: string; providerOptions: unknown };
        };
        sessionId: string;
        turnId: string;
        seq: number;
      };
      expect(e.type).toBe('artifact_updated');
      expect(e.update.artifact).toBe('widget');
      expect(e.update.variant).toBe('integration_suggestion_card');
      expect(e.sessionId).toBe('sess_test');
      expect(e.turnId).toMatch(/^turn_/);
    }
    // Sequential seq, both within the same synthetic turnId.
    const e0 = events[0] as { turnId: string; seq: number };
    const e1 = events[1] as { turnId: string; seq: number };
    expect(e0.turnId).toBe(e1.turnId);
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    const payload0 = (events[0] as { update: { payload: { title: string } } }).update.payload;
    expect(payload0.title).toBe('Connect slack for notifier?');
  });

  it('emits nothing when suggestions list is empty', () => {
    const events: unknown[] = [];
    emitSuggestionsAsCards({
      sessionId: 'sess_test',
      suggestions: [],
      emitTurnEvent: (e) => events.push(e),
    });
    expect(events).toEqual([]);
  });
});
