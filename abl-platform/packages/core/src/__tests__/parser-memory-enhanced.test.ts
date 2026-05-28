/**
 * Parser Tests: Enhanced Memory Parsing
 *
 * Tests that the parser correctly handles enhanced MEMORY fields including:
 * - PersistentMemory TYPE and UNIT
 * - SessionMemory RESET
 * - RECALL with ACTION (load_memory, inject_context)
 *
 * Regression coverage for the enhanced parser surface.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import type { RecallAction } from '../types/agent-based.js';

describe('Parser: Enhanced Memory Parsing', () => {
  test('should parse PersistentMemory with TYPE and UNIT', () => {
    const dsl = `
AGENT: BudgetAgent
GOAL: "Track user budgets"

MEMORY:
  PERSISTENT:
    - PATH: user.budget
      TYPE: number
      UNIT: USD
    - PATH: user.preferred_currency
      TYPE: string
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory).toBeDefined();
    expect(doc.memory.persistent).toHaveLength(2);

    const budgetPath = doc.memory.persistent[0];
    expect(budgetPath.path).toBe('user.budget');
    expect(budgetPath.type).toBe('number');
    expect(budgetPath.unit).toBe('USD');

    const currencyPath = doc.memory.persistent[1];
    expect(currencyPath.path).toBe('user.preferred_currency');
    expect(currencyPath.type).toBe('string');
    expect(currencyPath.unit).toBeUndefined();
  });

  test('should parse PersistentMemory sensitivity metadata', () => {
    const dsl = `
AGENT: SensitiveMemoryAgent
GOAL: "Protect stored identifiers"

MEMORY:
  PERSISTENT:
    - PATH: user.loyalty_number
      SENSITIVE: true
      SENSITIVE_DISPLAY: mask
      MASK_CONFIG:
        show_first: 2
        show_last: 2
        char: "#"
    - PATH: user.profile_note
      SENSITIVE: yes
      SENSITIVE_DISPLAY: redact
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(2);

    const loyaltyNumber = doc.memory.persistent[0];
    expect(loyaltyNumber.path).toBe('user.loyalty_number');
    expect(loyaltyNumber.sensitive).toBe(true);
    expect(loyaltyNumber.sensitiveDisplay).toBe('mask');
    expect(loyaltyNumber.maskConfig).toEqual({
      showFirst: 2,
      showLast: 2,
      char: '#',
    });

    const profileNote = doc.memory.persistent[1];
    expect(profileNote.path).toBe('user.profile_note');
    expect(profileNote.sensitive).toBe(true);
    expect(profileNote.sensitiveDisplay).toBe('redact');
    expect(profileNote.maskConfig).toBeUndefined();
  });

  test('should keep later memory subsections after masked persistent entries', () => {
    const dsl = `
AGENT: SensitiveMemoryAgent
GOAL: "Protect stored identifiers"

MEMORY:
  PERSISTENT:
    - PATH: user.loyalty_number
      SENSITIVE: true
      SENSITIVE_DISPLAY: mask
      MASK_CONFIG:
        show_first: 2
        show_last: 2
        char: "#"
  RECALL:
    - ON: session:start
      ACTION: load_memory
      DOMAIN: customer
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory.persistent).toHaveLength(1);
    expect(doc.memory.persistent[0].path).toBe('user.loyalty_number');
    expect(doc.memory.recall).toHaveLength(1);

    const recall = doc.memory.recall[0];
    expect(recall.event).toBe('session:start');
    expect(recall.action).toEqual({
      type: 'load_memory',
      domain: 'customer',
    } satisfies RecallAction);
  });

  test('should parse SessionMemory with RESET', () => {
    const dsl = `
AGENT: SessionAgent
GOAL: "Manage session state"

MEMORY:
  SESSION:
    - NAME: step_counter
      INITIAL: 0
      RESET: per_step
    - NAME: user_greeting
      RESET: never
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory).toBeDefined();
    expect(doc.memory.session).toHaveLength(2);

    const counter = doc.memory.session[0];
    expect(counter.name).toBe('step_counter');
    expect(counter.initial_value).toBe(0);
    expect(counter.reset).toBe('per_step');

    const greeting = doc.memory.session[1];
    expect(greeting.name).toBe('user_greeting');
    expect(greeting.reset).toBe('never');
  });

  test('should parse RECALL with load_memory ACTION', () => {
    const dsl = `
AGENT: TravelAgent
GOAL: "Help with travel"

MEMORY:
  RECALL:
    - ON: session:start
      ACTION: load_memory
      DOMAIN: travel
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory).toBeDefined();
    expect(doc.memory.recall).toHaveLength(1);

    const recall = doc.memory.recall[0];
    expect(recall.event).toBe('session:start');
    expect(recall.action).toBeDefined();

    const action = recall.action as RecallAction;
    expect(action.type).toBe('load_memory');
    expect((action as { type: 'load_memory'; domain?: string }).domain).toBe('travel');
  });

  test('should parse RECALL with inject_context ACTION and PATHS', () => {
    const dsl = `
AGENT: PreferenceAgent
GOAL: "Personalize experience"

MEMORY:
  RECALL:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user/preferences, user/history]
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory).toBeDefined();
    expect(doc.memory.recall).toHaveLength(1);

    const recall = doc.memory.recall[0];
    expect(recall.event).toBe('session:start');
    expect(recall.action).toBeDefined();

    const action = recall.action as RecallAction;
    expect(action.type).toBe('inject_context');
    expect((action as { type: 'inject_context'; paths: string[] }).paths).toEqual([
      'user/preferences',
      'user/history',
    ]);
  });

  test('basic MEMORY with canonical RECALL still works', () => {
    const dsl = `
AGENT: BasicMemoryAgent
GOAL: "Remember things"

MEMORY:
  SESSION:
    - search_results
    - NAME: attempt_count
      INITIAL: 0
  PERSISTENT:
    - user.preferred_chains
    - user.loyalty_number
  REMEMBER:
    - WHEN booking_confirmed
      STORE: hotel_chain -> user.preferred_chains
      TTL: "90d"
  RECALL:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user.preferred_chains, user.loyalty_number]
    - ON: tool:search_hotels:after
      ACTION: load_memory
      DOMAIN: travel
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const doc = result.document!;
    expect(doc.memory).toBeDefined();

    // Session memory
    expect(doc.memory.session).toHaveLength(2);
    expect(doc.memory.session[0].name).toBe('search_results');
    expect(doc.memory.session[1].name).toBe('attempt_count');
    expect(doc.memory.session[1].initial_value).toBe(0);

    // Persistent memory
    expect(doc.memory.persistent).toHaveLength(2);
    expect(doc.memory.persistent[0].path).toBe('user.preferred_chains');
    expect(doc.memory.persistent[1].path).toBe('user.loyalty_number');

    // Remember triggers
    expect(doc.memory.remember).toHaveLength(1);
    expect(doc.memory.remember[0].when).toBe('booking_confirmed');
    expect(doc.memory.remember[0].store.value).toBe('hotel_chain');
    expect(doc.memory.remember[0].store.target).toBe('user.preferred_chains');
    expect(doc.memory.remember[0].ttl).toBe('90d');

    // Recall instructions — canonical ON: lifecycle events remain parseable
    expect(doc.memory.recall).toHaveLength(2);
    expect(doc.memory.recall[0].event).toBe('session:start');
    expect(doc.memory.recall[0].action).toEqual({
      type: 'inject_context',
      paths: ['user.preferred_chains', 'user.loyalty_number'],
    });
    expect(doc.memory.recall[1].event).toBe('tool:search_hotels:after');
    expect(doc.memory.recall[1].action).toEqual({
      type: 'load_memory',
      domain: 'travel',
    });
  });

  test('rejects retired RECALL legacy aliases', () => {
    const aliases = [
      'ON_START',
      'ON_END',
      'ON_SEARCH',
      'ON_BOOKING',
      'ON_CANCEL',
      'ON_PAYMENT',
      'ON_UPDATE',
      'session_start',
      'session_end',
      'agent_enter',
      'agent_exit',
      'delegate_complete',
    ];

    for (const alias of aliases) {
      const dsl = `
AGENT: TestAgent
GOAL: "Test"

MEMORY:
  RECALL:
    - ON: ${alias}
      ACTION: load_memory
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(`Legacy RECALL event "${alias}"`),
          }),
        ]),
      );
    }
  });

  test('RECALL custom canonical event names pass through unchanged', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test"

MEMORY:
  RECALL:
    - ON: custom:event
      ACTION: load_memory
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    const doc = result.document!;
    expect(doc.memory.recall[0].event).toBe('custom:event');
    expect(doc.memory.recall[0].action).toEqual({
      type: 'load_memory',
    });
  });

  test('rejects retired legacy RECALL shorthand forms', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test"

MEMORY:
  RECALL:
    - ON_START: "Load preferences"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Legacy RECALL event "ON_START"'),
        }),
      ]),
    );
    expect(result.document!.memory.recall).toHaveLength(0);
  });
});
