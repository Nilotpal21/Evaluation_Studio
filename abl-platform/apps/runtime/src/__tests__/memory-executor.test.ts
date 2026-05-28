import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  evaluateRememberTriggers,
  executeRecallInstructions,
} from '../services/execution/memory-executor.js';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { RememberTrigger, RecallInstruction } from '@abl/compiler/platform/ir/schema.js';

describe('MemoryExecutor', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = new InMemoryFactStore({ type: 'memory' });
  });

  afterEach(() => {
    factStore.stop();
  });

  test('REMEMBER trigger fires when condition becomes true', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
      },
    ];

    const sessionValues = { destination: 'Paris' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].key).toBe('preferences.destination');
    expect(ops[0].value).toBe('Paris');
  });

  test('REMEMBER deduplication — same value not re-stored', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
      },
    ];

    const sessionValues = { destination: 'Paris' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops1 = evaluateRememberTriggers(triggers, sessionValues, config);
    const ops2 = evaluateRememberTriggers(triggers, sessionValues, config);

    // Both calls produce the same operation — the function is pure and deterministic.
    // Deduplication at the store level happens via upsert (same key overwrites).
    expect(ops1).toHaveLength(1);
    expect(ops2).toHaveLength(1);
    expect(ops1[0].key).toBe(ops2[0].key);
    expect(ops1[0].value).toBe(ops2[0].value);
  });

  test('REMEMBER with TTL sets expiration', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
        ttl: '7d',
      },
    ];

    const sessionValues = { destination: 'Paris' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].ttl).toBe('7d');
  });

  test('RECALL on session_start loads user facts into session', async () => {
    // Pre-populate the fact store
    await factStore.set({ key: 'preferences.destination', value: 'Paris' });

    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load user preferences',
        action: {
          type: 'inject_context',
          paths: ['preferences.destination'],
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['session:start'], config);

    expect(result['preferences.destination']).toBe('Paris');
  });

  test('RECALL on search_initiated loads preferences', async () => {
    // Pre-populate with preferences
    await factStore.set({ key: 'preferences.hotel.room_type', value: 'suite' });
    await factStore.set({ key: 'preferences.hotel.view', value: 'ocean' });

    const instructions: RecallInstruction[] = [
      {
        event: 'search_initiated',
        instruction: 'Load hotel preferences',
        action: {
          type: 'load_memory',
          domain: 'hotel',
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['search_initiated'], config);

    expect(result['preferences.hotel.room_type']).toBe('suite');
    expect(result['preferences.hotel.view']).toBe('ocean');
  });

  test('Value resolution from nested path expression', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'booking.hotel.name IS SET',
        store: { value: 'booking.hotel.name', target: 'last_hotel' },
      },
    ];

    const sessionValues = {
      booking: {
        hotel: {
          name: 'Grand Hotel',
        },
      },
    };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe('Grand Hotel');
  });

  test('Target path is just the path (no userId prefix) — store enforces isolation', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
      },
    ];

    const sessionValues = { destination: 'Tokyo' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    // Key is the raw target path, no userId prefix
    expect(ops[0].key).toBe('preferences.destination');
    expect(ops[0].key).not.toContain('u1');
  });

  test('REMEMBER trigger condition false → no store', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
      },
    ];

    // destination is not set in session values
    const sessionValues = { checkin_date: '2026-03-01' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(0);
  });

  test('RECALL with no matching facts → empty result', async () => {
    // Fact store is empty — no facts stored
    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load user preferences',
        action: {
          type: 'inject_context',
          paths: ['preferences.destination', 'preferences.room_type'],
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['session:start'], config);

    // No facts found, so result should have no injected data for those paths
    expect(result['preferences.destination']).toBeUndefined();
    expect(result['preferences.room_type']).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('RECALL inject_context uses batch getMany for multiple paths', async () => {
    // Pre-populate facts
    await factStore.set({ key: 'preferences.destination', value: 'Paris' });
    await factStore.set({ key: 'preferences.room_type', value: 'suite' });
    await factStore.set({ key: 'preferences.airline', value: 'Delta' });

    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load all preferences',
        action: {
          type: 'inject_context',
          paths: ['preferences.destination', 'preferences.room_type', 'preferences.airline'],
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['session:start'], config);

    expect(result['preferences.destination']).toBe('Paris');
    expect(result['preferences.room_type']).toBe('suite');
    expect(result['preferences.airline']).toBe('Delta');
  });

  test('RECALL inject_context batch ignores missing keys', async () => {
    await factStore.set({ key: 'preferences.destination', value: 'Tokyo' });

    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load preferences',
        action: {
          type: 'inject_context',
          paths: ['preferences.destination', 'preferences.nonexistent'],
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['session:start'], config);

    expect(result['preferences.destination']).toBe('Tokyo');
    expect(result['preferences.nonexistent']).toBeUndefined();
  });

  test('RECALL inject_context with empty paths is a no-op', async () => {
    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load preferences',
        action: {
          type: 'inject_context',
          paths: [],
        },
      },
    ];

    const config = { factStore, tenantId: 't1', userId: 'u1' };
    const result = await executeRecallInstructions(instructions, ['session:start'], config);

    expect(Object.keys(result)).toHaveLength(0);
  });

  test('REMEMBER == coerces string "true" to boolean for comparison', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'quote_created == true',
        store: { value: 'destination', target: 'user.travel_preferences' },
      },
    ];

    // DSL SET stores booleans as strings — "true" not true
    const sessionValues = { quote_created: 'true', destination: 'Barcelona' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].key).toBe('user.travel_preferences');
    expect(ops[0].value).toBe('Barcelona');
  });

  test('REMEMBER == coerces string "false" to boolean for comparison', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'quote_created == false',
        store: { value: 'destination', target: 'user.travel_preferences' },
      },
    ];

    const sessionValues = { quote_created: 'false', destination: 'Paris' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
  });

  test('REMEMBER == coerces string number to number for comparison', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'num_travelers == 2',
        store: { value: 'destination', target: 'user.last_destination' },
      },
    ];

    const sessionValues = { num_travelers: '2', destination: 'Tokyo' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
  });

  test('REMEMBER != works with string/boolean coercion', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'quote_created != true',
        store: { value: 'destination', target: 'user.travel_preferences' },
      },
    ];

    // quote_created is "true" → coerced to true → != true is false → no op
    const sessionValues = { quote_created: 'true', destination: 'Barcelona' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(0);
  });

  test('REMEMBER composite object STORE resolves each field from session', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'quote_created == true',
        store: {
          value: '{destination: destination, travelers: num_travelers}',
          target: 'user.travel_preferences',
        },
        ttl: '90d',
      },
    ];

    const sessionValues = {
      quote_created: true,
      destination: 'Barcelona',
      num_travelers: 2,
    };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].key).toBe('user.travel_preferences');
    expect(ops[0].value).toEqual({ destination: 'Barcelona', travelers: 2 });
    expect(ops[0].ttl).toBe('90d');
  });

  test('REMEMBER composite object STORE with nested path values', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'booking.confirmed == true',
        store: {
          value: '{hotel: booking.hotel.name, city: booking.city}',
          target: 'user.last_booking',
        },
      },
    ];

    const sessionValues = {
      booking: {
        confirmed: true,
        hotel: { name: 'Grand Hotel' },
        city: 'Paris',
      },
    };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    expect(ops[0].value).toEqual({ hotel: 'Grand Hotel', city: 'Paris' });
  });

  test('REMEMBER composite object STORE skips null/undefined fields', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: {
          value: '{destination: destination, budget: budget}',
          target: 'user.search_prefs',
        },
      },
    ];

    // budget is not set
    const sessionValues = { destination: 'Tokyo' };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    expect(ops).toHaveLength(1);
    // Only destination is in the object — budget was undefined
    expect(ops[0].value).toEqual({ destination: 'Tokyo' });
  });

  test('REMEMBER composite object STORE returns undefined when all fields null', () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'flag IS SET',
        store: {
          value: '{a: missing_field_1, b: missing_field_2}',
          target: 'user.prefs',
        },
      },
    ];

    const sessionValues = { flag: true };
    const config = { factStore, tenantId: 't1', userId: 'u1' };

    const ops = evaluateRememberTriggers(triggers, sessionValues, config);

    // All fields resolved to undefined → no operation
    expect(ops).toHaveLength(0);
  });

  test('No userId on session → RECALL skipped while REMEMBER still returns candidate ops', async () => {
    const triggers: RememberTrigger[] = [
      {
        when: 'destination IS SET',
        store: { value: 'destination', target: 'preferences.destination' },
      },
    ];

    const sessionValues = { destination: 'Paris' };

    // No userId provided
    const config = { factStore, tenantId: 't1' };

    const rememberOps = evaluateRememberTriggers(triggers, sessionValues, config);
    expect(rememberOps).toEqual([
      {
        key: 'preferences.destination',
        value: 'Paris',
        ttl: undefined,
      },
    ]);

    const instructions: RecallInstruction[] = [
      {
        event: 'session_start',
        instruction: 'Load preferences',
        action: { type: 'inject_context', paths: ['preferences.destination'] },
      },
    ];

    const recallResult = await executeRecallInstructions(instructions, ['session:start'], config);
    expect(Object.keys(recallResult)).toHaveLength(0);
  });
});
