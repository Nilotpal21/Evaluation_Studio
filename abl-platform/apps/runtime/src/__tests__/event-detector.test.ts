import { describe, test, expect } from 'vitest';
import {
  resolveToolAfterEvents,
  resolveAgentEvents,
  detectEntityEvents,
  detectStepEvents,
  LIFECYCLE_PATTERNS,
  LEGACY_EVENT_ALIASES,
} from '../services/execution/event-detector.js';

describe('event-detector lifecycle events', () => {
  describe('resolveToolAfterEvents', () => {
    test('search_hotels returns specific + wildcard tool events', () => {
      const events = resolveToolAfterEvents('search_hotels');
      expect(events).toEqual(['tool:search_hotels:after', 'tool:*:after']);
    });

    test('buscar_vuelos returns specific + wildcard tool events (non-English)', () => {
      const events = resolveToolAfterEvents('buscar_vuelos');
      expect(events).toEqual(['tool:buscar_vuelos:after', 'tool:*:after']);
    });
  });

  describe('resolveAgentEvents', () => {
    test('Billing_Agent before returns specific + wildcard agent events', () => {
      const events = resolveAgentEvents('Billing_Agent', 'before');
      expect(events).toEqual(['agent:Billing_Agent:before', 'agent:*:before']);
    });

    test('Visa_Agent after returns specific + wildcard agent events', () => {
      const events = resolveAgentEvents('Visa_Agent', 'after');
      expect(events).toEqual(['agent:Visa_Agent:after', 'agent:*:after']);
    });
  });

  describe('LIFECYCLE_PATTERNS', () => {
    const matchesAny = (event: string): boolean =>
      LIFECYCLE_PATTERNS.some((pattern) => pattern.test(event));

    test('matches session:start', () => {
      expect(matchesAny('session:start')).toBe(true);
    });

    test('matches session:end', () => {
      expect(matchesAny('session:end')).toBe(true);
    });

    test('matches agent:Billing_Agent:before', () => {
      expect(matchesAny('agent:Billing_Agent:before')).toBe(true);
    });

    test('matches agent:*:after', () => {
      expect(matchesAny('agent:*:after')).toBe(true);
    });

    test('matches tool:search_hotels:after', () => {
      expect(matchesAny('tool:search_hotels:after')).toBe(true);
    });

    test('matches tool:*:after', () => {
      expect(matchesAny('tool:*:after')).toBe(true);
    });

    test('matches entity:destination:extracted', () => {
      expect(matchesAny('entity:destination:extracted')).toBe(true);
    });

    test('matches step:enter:confirm', () => {
      expect(matchesAny('step:enter:confirm')).toBe(true);
    });

    test('matches step:exit:confirm', () => {
      expect(matchesAny('step:exit:confirm')).toBe(true);
    });

    test('rejects booking_completed (old-style event name)', () => {
      expect(matchesAny('booking_completed')).toBe(false);
    });

    test('rejects tool:search:before (no tool:before in new taxonomy)', () => {
      expect(matchesAny('tool:search:before')).toBe(false);
    });
  });

  describe('LEGACY_EVENT_ALIASES', () => {
    test('session_start maps to session:start', () => {
      expect(LEGACY_EVENT_ALIASES['session_start']).toBe('session:start');
    });

    test('session_end maps to session:end', () => {
      expect(LEGACY_EVENT_ALIASES['session_end']).toBe('session:end');
    });

    test('agent_enter maps to agent:*:after', () => {
      expect(LEGACY_EVENT_ALIASES['agent_enter']).toBe('agent:*:after');
    });

    test('agent_exit maps to agent:*:after', () => {
      expect(LEGACY_EVENT_ALIASES['agent_exit']).toBe('agent:*:after');
    });

    test('delegate_complete maps to agent:*:after', () => {
      expect(LEGACY_EVENT_ALIASES['delegate_complete']).toBe('agent:*:after');
    });
  });

  describe('detectEntityEvents (kept from original)', () => {
    test('maps field names to entity:field:extracted events', () => {
      const events = detectEntityEvents(['destination', 'checkin_date']);
      expect(events).toEqual(['entity:destination:extracted', 'entity:checkin_date:extracted']);
    });

    test('returns empty array for empty input', () => {
      expect(detectEntityEvents([])).toEqual([]);
    });
  });

  describe('detectStepEvents (kept from original)', () => {
    test('maps step name to step:enter event', () => {
      const events = detectStepEvents('confirm');
      expect(events).toEqual(['step:enter:confirm']);
    });
  });
});
