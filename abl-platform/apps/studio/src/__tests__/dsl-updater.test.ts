import { describe, it, expect } from 'vitest';
import {
  addHandoff,
  updateHandoffField,
  updateDelegateField,
  parseRelationships,
} from '../lib/agent-canvas/dsl-updater';

const HANDOFF_DSL = `AGENT: booking_agent
GOAL: "Help with bookings"
MODE: reasoning

HANDOFF:
  - TO: billing_agent
    WHEN: intent.category == "billing"
    SUMMARY: "Handing off to billing"
    RETURN: true
  - TO: support_agent
    WHEN: input contains "support"
    RETURN: false
`;

const DELEGATE_DSL = `SUPERVISOR: router
GOAL: "Route requests"
MODE: reasoning

DELEGATE:
  - AGENT: booking_agent
    WHEN: intent.category == "booking"
    PURPOSE: "Handle bookings"
  - AGENT: billing_agent
    WHEN: intent.category == "billing"
    PURPOSE: "Handle billing"
`;

describe('updateHandoffField', () => {
  it('returns null for empty DSL', () => {
    expect(updateHandoffField('', 0, 'when', 'test')).toBeNull();
  });

  it('returns null for out-of-range index', () => {
    expect(updateHandoffField(HANDOFF_DSL, 5, 'when', 'test')).toBeNull();
  });

  it('updates WHEN field on first handoff', () => {
    const result = updateHandoffField(HANDOFF_DSL, 0, 'when', 'intent.category == "refund"');
    expect(result).not.toBeNull();
    expect(result).toContain('WHEN: intent.category == "refund"');
    // Second handoff unchanged
    expect(result).toContain('TO: support_agent');
  });

  it('updates WHEN field on second handoff', () => {
    const result = updateHandoffField(HANDOFF_DSL, 1, 'when', 'input contains "refund"');
    expect(result).not.toBeNull();
    expect(result).toContain('WHEN: input contains "refund"');
    // First handoff unchanged
    expect(result).toContain('WHEN: intent.category == "billing"');
  });

  it('updates SUMMARY field', () => {
    const result = updateHandoffField(HANDOFF_DSL, 0, 'summary', 'New summary text');
    expect(result).not.toBeNull();
    expect(result).toContain('SUMMARY: "New summary text"');
  });

  it('updates RETURN field with boolean', () => {
    const result = updateHandoffField(HANDOFF_DSL, 0, 'return', false);
    expect(result).not.toBeNull();
    expect(result).toContain('RETURN: false');
  });

  it('inserts missing field into block', () => {
    const result = updateHandoffField(HANDOFF_DSL, 1, 'summary', 'Added summary');
    expect(result).not.toBeNull();
    expect(result).toContain('SUMMARY: "Added summary"');
  });

  it('updates TO field (identity key)', () => {
    const result = updateHandoffField(HANDOFF_DSL, 0, 'to', 'new_target_agent');
    expect(result).not.toBeNull();
    expect(result).toContain('TO: "new_target_agent"');
  });

  it('escapes quotes in string values', () => {
    const result = updateHandoffField(HANDOFF_DSL, 0, 'when', 'input contains "hello"');
    expect(result).not.toBeNull();
    expect(result).toContain('WHEN: input contains "hello"');
  });
});

describe('updateDelegateField', () => {
  it('returns null for empty DSL', () => {
    expect(updateDelegateField('', 0, 'when', 'test')).toBeNull();
  });

  it('returns null for out-of-range index', () => {
    expect(updateDelegateField(DELEGATE_DSL, 5, 'when', 'test')).toBeNull();
  });

  it('updates WHEN field on first delegate', () => {
    const result = updateDelegateField(
      DELEGATE_DSL,
      0,
      'when',
      'intent.category == "flight_change"',
    );
    expect(result).not.toBeNull();
    expect(result).toContain('WHEN: intent.category == "flight_change"');
    // Second delegate unchanged
    expect(result).toContain('AGENT: billing_agent');
  });

  it('updates PURPOSE field', () => {
    const result = updateDelegateField(DELEGATE_DSL, 0, 'purpose', 'Updated purpose');
    expect(result).not.toBeNull();
    expect(result).toContain('PURPOSE: "Updated purpose"');
  });

  it('updates AGENT field', () => {
    const result = updateDelegateField(DELEGATE_DSL, 1, 'agent', 'new_agent_name');
    expect(result).not.toBeNull();
    expect(result).toContain('AGENT: "new_agent_name"');
  });

  it('updates second delegate without affecting first', () => {
    const result = updateDelegateField(DELEGATE_DSL, 1, 'when', 'input contains "invoice"');
    expect(result).not.toBeNull();
    expect(result).toContain('WHEN: input contains "invoice"');
    expect(result).toContain('WHEN: intent.category == "booking"');
  });
});

describe('parseRelationships', () => {
  it('parses handoffs from DSL', () => {
    const rels = parseRelationships(HANDOFF_DSL);
    expect(rels).not.toBeNull();
    expect(rels!.handoffs).toHaveLength(2);
    expect(rels!.handoffs[0].to).toBe('billing_agent');
    expect(rels!.handoffs[1].to).toBe('support_agent');
  });

  it('parses delegates from DSL', () => {
    const rels = parseRelationships(DELEGATE_DSL);
    expect(rels).not.toBeNull();
    expect(rels!.delegates).toHaveLength(2);
    expect(rels!.delegates[0].agent).toBe('booking_agent');
  });

  it('returns null for empty DSL', () => {
    expect(parseRelationships('')).toBeNull();
  });
});

describe('addHandoff', () => {
  it('serializes explicit full history inside CONTEXT', () => {
    const result = addHandoff(HANDOFF_DSL, 'vip_agent', {
      when: 'customer_tier == "platinum"',
      history: 'full',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('TO: vip_agent');
    expect(result).toContain('history: full');
  });

  it('serializes auto history when selected without requiring summary or pass', () => {
    const result = addHandoff(HANDOFF_DSL, 'triage_agent', {
      when: 'needs_triage == true',
      history: 'auto',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('TO: triage_agent');
    expect(result).toContain('CONTEXT:');
    expect(result).toContain('history: auto');
  });

  it('serializes typed last_n history blocks', () => {
    const result = addHandoff(HANDOFF_DSL, 'specialist_agent', {
      when: 'requires_history_window == true',
      history: { mode: 'last_n', count: 6 },
    });

    expect(result).not.toBeNull();
    expect(result).toContain('history:');
    expect(result).toContain('mode: last_n');
    expect(result).toContain('count: 6');
  });
});
